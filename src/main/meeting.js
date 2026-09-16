/**
 * 会议自动检测 + 自动记录纪要 —— 主进程编排层。
 *
 * 职责分工：
 *   检测（纯逻辑 / 可单测） → jarvis/meeting-detect.js
 *   纪要（纯逻辑 / 可单测） → jarvis/minutes.js
 *   本文件                  → 采探针（reg query / tasklist）、开录制窗口、收转写、生成摘要、播报
 *
 * 数据流：
 *   每 N 秒采样一次
 *     ├ 麦克风/摄像头占用（注册表） + 进程与窗口标题（tasklist）
 *     ├ classify() 判等级 → MeetingWatcher 迟滞 → 'started' / 'ended'
 *     └ started（且开了自动记录）→ 打开隐藏录制窗口
 *           getDisplayMedia(系统声音 loopback) [+ 麦克风] → 16k PCM → 复用 asr:* 通道
 *           → 识别结果按片段回传给本模块 → 攒成转写
 *         ended / 静默超时 / 用户点停 → 收尾 → 让大模型写摘要 → 落盘 → 播报
 *
 * 为什么采集的是「系统声音」：会议里别人说话是从扬声器出来的，
 * 用 Windows 的 loopback（Electron 里就是 getDisplayMedia 的 audio:'loopback'）
 * 才能把对方的声音录进来，且不需要装虚拟声卡。
 */

const { app, ipcMain, BrowserWindow, desktopCapturer, shell } = require('electron');
// Electron 的 session 模块要改个名 —— 本文件里 `session` 已经被「当前录制会话」占用了
const electronSession = require('electron').session || null;
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const detect = require('./jarvis/meeting-detect');
const minutes = require('./jarvis/minutes');

const CAPABILITY_ROOT = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore';

// ---------------- 依赖注入 ----------------
let api = {
  getConfig: () => ({}),
  log: () => {},
  deliver: () => {},        // 走 main.js 的 onProactive（宠物 + 通知 + 面板）
  summarize: null,          // (messages) => Promise<string>，由 main.js 注入（复用 llm.collectChat）
  isAsrBusy: () => false    // 语音识别通道是否被别人占用（小问正在语音问答）
};
function bind(opts = {}) {
  if (opts.getConfig) api.getConfig = opts.getConfig;
  if (opts.log) api.log = opts.log;
  if (opts.deliver) api.deliver = opts.deliver;
  if (opts.summarize) api.summarize = opts.summarize;
  if (opts.isAsrBusy) api.isAsrBusy = opts.isAsrBusy;
}
function cfg() { return api.getConfig() || {}; }
function log(m) { try { api.log('[会议] ' + m); } catch (e) { /* ignore */ } }

// ---------------- 探针：外部命令 ----------------
/**
 * 跑一条命令并返回**原始 Buffer**。永远不 reject —— 探针失败就当这一轮什么都没采到，
 * 绝不能让一次 `reg query` 报错把整个检测器打死。
 *
 * 为什么要拿 Buffer 而不是直接给 encoding: 'utf8'：
 * 这些工具按控制台 OEM 代码页（简体中文 = GBK）输出，按 UTF-8 硬解会把中文窗口标题
 * 变成乱码，标题关键词就永远匹配不上（而且日志里看不出问题）。解码交给
 * detect.decodeOemText*。这是实机验证时才发现的一个隐藏坑。
 */
function run(cmd, args, timeout = 6000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
        if (err && !stdout) { log(`${cmd} 执行失败: ` + ((err && err.message) || err)); finish(Buffer.alloc(0)); return; }
        finish(Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout || ''), 'utf8'));
      });
    } catch (e) {
      log(`${cmd} 启动异常: ` + ((e && e.message) || e));
      finish(Buffer.alloc(0));
    }
  });
}

async function readConsent(device) {
  if (process.platform !== 'win32') return '';
  return detect.decodeOemText(await run('reg', ['query', `${CAPABILITY_ROOT}\\${device}`, '/s']));
}

async function listProcesses() {
  if (process.platform !== 'win32') return [];
  const buf = await run('tasklist', ['/v', '/fo', 'csv', '/nh']);
  const { primary, alt } = detect.decodeOemTextBoth(buf);
  return detect.parseTasklist(primary, { altText: alt });
}

/** 小问自己的 exe 名（检测时要排除：小问用麦做语音识别，不能算在开会） */
function selfExe() {
  try {
    const base = path.basename(app.getPath('exe') || '');
    if (/\.exe$/i.test(base)) return base.toLowerCase();
  } catch (e) { /* ignore */ }
  return process.platform === 'win32' ? 'electron.exe' : '';
}

/**
 * 本轮要读哪几个「设备占用」注册表。
 *
 * 麦克风信号是「在开会」的主判据，**永远都读** —— 设置页里的「同时采集麦克风」
 * (`meetingCaptureMic`) 管的是**录制**时带不带自己的声音，跟检测无关；
 * 检测侧没有任何开关可以关掉麦克风信号。
 * 摄像头信号是补充判据（纯视频会议也能识别），由 `meetingWatchCam` 控制。
 *
 * 单独抽成函数就是为了让「两个探针共用一个开关」这种笔误不可能再发生：
 * 归属判断只在这里做一次，`sampleOnce` 只按结果取数据、自己不再看配置。
 */
function watchedDevices(c = cfg()) {
  const devices = ['microphone'];
  if (c.meetingWatchCam !== false) devices.push('webcam');
  return devices;
}

async function sampleOnce() {
  const c = cfg();
  const devices = watchedDevices(c);
  const [micText, camText, procs] = await Promise.all([
    readConsent('microphone'),                                                 // 主判据：无开关
    devices.includes('webcam') ? readConsent('webcam') : Promise.resolve(''),  // 可选判据
    listProcesses()
  ]);
  const micUsers = detect.activeUsers(micText);
  const camUsers = detect.activeUsers(camText);
  const result = detect.classify({
    micUsers,
    camUsers,
    procs,
    selfExe: selfExe(),
    allowUnknown: c.meetingUnknownApps === true
  });
  return { result, procs, micUsers, camUsers, devices };
}

// ---------------- 状态 ----------------
let watcher = null;
let pollTimer = null;
let session = null;        // 当前录制会话
let recorderWin = null;
let lastDetect = null;     // 最近一次采样结果（给设置页看，排查用）
let pendingAck = null;     // 录制窗口的回执等待
let quotaWarned = false;

function enabled() { return cfg().meetingEnabled !== false; }

/**
 * 这个请求是不是采集窗口自己发的？
 *
 * 会议记录和「语音问答」共用主进程里同一条识别会话通道（全局只有一个 asrSession），
 * 谁后启动就会把前一个顶掉。所以 main.js 在 asr:start 里要能分辨「是采集窗口在开会话」
 * 还是「面板在语音提问」—— 后者在录音期间必须被挡掉，否则两边会互相抢、反复重连。
 */
function isRecorderSender(sender) {
  try {
    if (!recorderWin || recorderWin.isDestroyed()) return false;
    if (!sender) return false;
    return recorderWin.webContents.id === sender.id;
  } catch (e) {
    return false;
  }
}

function status() {
  const c = cfg();
  const last = session ? null : minutes.list()[0];
  return {
    enabled: enabled(),
    state: watcher ? watcher.state : 'idle',
    recording: !!session,
    autoRecord: c.meetingAutoRecord !== false,
    askFirst: c.meetingAskFirst === true,
    withMic: c.meetingCaptureMic !== false,
    silenceMin: num(c.meetingSilenceMin, 5, 1, 60),
    maxMinutes: num(c.meetingMaxMinutes, 120, 5, 480),
    pollSec: num(c.meetingPollSec, 5, 2, 60),
    session: session ? {
      id: session.id,
      app: session.app,
      startedAt: session.startedAt,
      durationMs: Date.now() - session.startedAt,
      segments: session.segments.length,
      chars: session.chars,
      lastVoiceAt: session.lastVoiceAt,
      source: session.source
    } : null,
    lastDetect: lastDetect ? { at: lastDetect.at, level: lastDetect.level, app: lastDetect.app, reasons: lastDetect.reasons } : null,
    lastMinutes: last || null,
    asrBusy: !!api.isAsrBusy(),
    stats: minutes.stats()
  };
}

function num(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

// ---------------- 录制窗口 ----------------
function loadPage(win, file) {
  if (!app.isPackaged) {
    win.loadURL(`http://localhost:5199/${file}`);
    return;
  }
  win.loadFile(path.join(__dirname, '../../dist', file));
}

/**
 * 隐藏的录制窗口。
 *
 * 必须是一个真实窗口（不能是 offscreen / 无窗口 context）：Chromium 的
 * getDisplayMedia 需要一个已附着到窗口的 WebContents 才能拿到 loopback 音频，
 * 而且隐藏窗口在后台被节流时 Web Audio 仍会正常跑（音频节点属于媒体线程）。
 * 所以 show:false 是安全的，但绝不 destroy。
 */
function createRecorderWindow() {
  if (recorderWin && !recorderWin.isDestroyed()) return recorderWin;
  const win = new BrowserWindow({
    show: false,
    width: 520,
    height: 200,
    skipTaskbar: true,
    title: '小问 · 会议记录',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      // 系统声音采集需要它自己所在的 session 允许媒体
      partition: 'persist:minutes'
    }
  });
  recorderWin = win;
  win.on('closed', () => {
    if (recorderWin === win) recorderWin = null;
  });

  // 采集来源：整屏 + 系统声音（loopback）。
  // 这里把「屏幕」当音源用 —— video 是 Chromium 要求的形式参数，我们只用音轨。
  try {
    const ses = electronSession && electronSession.fromPartition('persist:minutes');
    ses.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1, height: 1 }
        });
        if (!sources.length) { callback({}); return; }
        callback({ video: sources[0], audio: 'loopback' });
      } catch (e) {
        log('获取采集源失败: ' + ((e && e.message) || e));
        callback({});
      }
    }, { useSystemPicker: false });
    // 会议录制要开麦开摄像头权限（摄像头只是给 WebRTC 用，实际不开）
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  } catch (e) {
    log('采集源处理注册失败: ' + ((e && e.message) || e));
  }

  loadPage(win, 'minutes.html');
  return win;
}

/** 给录制窗口发指令并等回执 */
function askRecorder(cmd, payload = {}, timeout = 12000) {
  return new Promise((resolve) => {
    const win = createRecorderWindow();
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      if (pendingAck && pendingAck.finish === finish) pendingAck = null;
      resolve(v);
    };
    pendingAck = { finish };
    const timer = setTimeout(() => {
      log(`录制窗口未回执（${cmd}），超时`);
      finish({ ok: false, error: '录制窗口无响应' });
    }, timeout);
    if (timer.unref) timer.unref();
    const send = () => {
      try {
        win.webContents.send('minutes:cmd', { cmd, ...payload });
      } catch (e) {
        log('发送指令失败: ' + ((e && e.message) || e));
        clearTimeout(timer);
        finish({ ok: false, error: '无法与录制窗口通信' });
      }
    };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
    else send();
  });
}

ipcMain.on('minutes:ack', (_e, payload = {}) => {
  if (pendingAck) {
    const f = pendingAck.finish;
    pendingAck = null;
    f(payload || { ok: true });
  }
});

// 录制窗口回传的转写片段
ipcMain.on('minutes:chunk', (_e, payload = {}) => {
  if (!session) return;
  const text = minutes.cleanText(payload.text);
  if (!text || minutes.isNoise(text)) return;
  session.segments.push({
    at: Number(payload.at) || Date.now(),
    text,
    source: payload.source === 'mic' ? 'mic' : 'loopback'
  });
  session.chars += text.length;
  session.lastVoiceAt = Date.now();
  if (session.segments.length - session.savedSegments >= 20) snapshot();
  broadcast('meeting:live', {
    id: session.id,
    text,
    at: session.segments[session.segments.length - 1].at,
    chars: session.chars,
    segments: session.segments.length
  });
});

// 录制窗口的语音活动心跳（用来判「静默太久」）
ipcMain.on('minutes:voice', (_e, payload = {}) => {
  if (!session) return;
  if (Number(payload && payload.level) > 0) session.lastVoiceAt = Date.now();
});

/** 落一次快照：万一进程崩了，转写也还在 */
function snapshot() {
  if (!session) return;
  session.savedSegments = session.segments.length;
  const merged = minutes.mergeSegments(session.segments);
  const rec = buildRecord(session, merged, { partial: true });
  const r = minutes.save(rec);
  if (r.ok) session.file = r.path;
}

/**
 * 组装一条完整记录。
 * 注意：session 必须**显式传进来** —— stopRecording 里会先把全局 session 清掉再落盘，
 * 用全局变量会拿到 null（这个坑写第一版时踩过）。
 */
function buildRecord(sess, merged, opts = {}) {
  const endedAt = Date.now();
  const rec = {
    id: sess.id,
    app: sess.app,
    appExe: sess.appExe,
    title: `${sess.app} · ${new Date(sess.startedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
    startedAt: sess.startedAt,
    endedAt,
    durationMs: endedAt - sess.startedAt,
    segments: merged.segments,
    transcript: minutes.buildTranscript(merged.segments),
    summary: sess.summary || { topic: '', points: [], decisions: [], todos: [], risks: [], raw: '' },
    stats: {
      segCount: merged.segments.length,
      chars: sess.chars,
      dropped: merged.dropped,
      dup: merged.dup,
      source: sess.source,
      endReason: sess.endReason || (opts.partial ? 'recording' : 'stopped')
    },
    savedAt: Date.now()
  };
  return rec;
}

// ---------------- 开始 / 结束 ----------------
function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.webContents.send(channel, payload); } catch (e) { /* ignore */ }
  }
}

async function startRecording(reason = 'manual', meta = {}) {
  if (session) return { ok: true, already: true, id: session.id };
  if (!enabled()) return { ok: false, error: '会议纪要功能已关闭' };

  const c = cfg();
  const key = String(c.asrApiKey || '').trim();
  if (!key) {
    deliverNeedKey();
    return { ok: false, error: '没有配置语音识别 Key，无法记录纪要' };
  }
  if (api.isAsrBusy()) {
    log('语音识别通道正被占用（可能在语音问答），本次放弃录制');
    return { ok: false, error: '语音识别正被占用，稍后再试' };
  }

  const withMic = c.meetingCaptureMic !== false;

  // 先把会话建起来，再去让录制窗口开工。
  // 顺序很重要：录制窗口可能在回执的同一瞬间就把第一段转写推上来了
  // （实测在桩环境里必然如此），这时候 session 还不存在的话那段话就被丢了。
  session = {
    id: minutes.newId(meta.appExe || 'meeting', Date.now()),
    app: meta.app || (lastDetect && lastDetect.app) || '会议',
    appExe: meta.appExe || '',
    startedAt: Date.now(),
    lastVoiceAt: Date.now(),
    segments: [],
    savedSegments: 0,
    chars: 0,
    summary: null,
    endReason: reason,
    source: withMic ? '系统声音 + 麦克风' : '系统声音'
  };

  const res = await askRecorder('start', {
    withMic,
    segmentMinutes: num(c.meetingSegmentMin, 5, 1, 15)
  });
  if (!res || !res.ok) {
    const err = (res && res.error) || '录制启动失败';
    session = null;
    log('录制启动失败: ' + err);
    deliverError(err);
    return { ok: false, error: err };
  }

  quotaWarned = false;
  startSilenceGuard();
  log(`开始记录纪要 id=${session.id} app=${session.app} 采集=${session.source}`);
  broadcast('meeting:event', { type: 'started', ...status() });
  return { ok: true, id: session.id };
}

async function stopRecording(reason = 'manual', opts = {}) {
  if (!session) return { ok: false, error: '当前没有在记录' };
  const s = session;
  s.endReason = reason;
  stopSilenceGuard();

  // 让录制窗口把最后一段音频发完、收完识别结果
  try { await askRecorder('stop', {}, 15000); } catch (e) { /* ignore */ }
  // 给 ASR 一点时间把尾巴吐出来
  await new Promise((r) => setTimeout(r, opts.flushMs || 2000));

  session = null;
  const merged = minutes.mergeSegments(s.segments);
  const rec = buildRecord(s, merged);
  const tooShort = rec.durationMs < num(cfg().meetingMinMinutes, 1, 0, 30) * 60000;
  const noContent = merged.segments.length === 0;

  if (noContent || (tooShort && merged.segments.length < 3)) {
    log(`本次记录太短或没有识别到内容（${Math.round(rec.durationMs / 1000)}s / ${merged.segments.length} 段${
      merged.dropped || merged.dup ? `，过滤掉重复 ${merged.dup} 段、噪声 ${merged.dropped} 段` : ''}），不留纪要`);
    broadcast('meeting:event', { type: 'discarded', reason, durationMs: rec.durationMs, segCount: merged.segments.length, ...status() });
    return { ok: true, discarded: true, durationMs: rec.durationMs, reason };
  }

  // 摘要（失败不影响落盘，纪要原文照存）
  let summary = null;
  if (api.summarize && merged.segments.length) {
    try {
      const messages = minutes.summaryPrompt(rec, minutes.plainTranscript(merged.segments));
      const raw = await api.summarize(messages);
      summary = minutes.parseSummary(raw);
    } catch (e) {
      log('生成摘要失败: ' + ((e && e.message) || e));
    }
  }
  rec.summary = summary || { topic: '', points: [], decisions: [], todos: [], risks: [], raw: '' };

  const saved = minutes.save(rec);
  log(`纪要已保存 ${saved.path}（${merged.segments.length} 段 / ${rec.stats.chars} 字 / ${
    rec.summary.todos.length} 个待办）`);

  broadcast('meeting:event', { type: 'saved', id: rec.id, minutes: minutes.summaryRow(rec), ...status() });
  deliverSaved(rec, saved);
  return { ok: true, id: rec.id, path: saved.path, mdPath: saved.mdPath, row: minutes.summaryRow(rec) };
}

// ---------------- 静默 / 超时守护 ----------------
let guardTimer = null;
function startSilenceGuard() {
  stopSilenceGuard();
  guardTimer = setInterval(() => {
    if (!session) { stopSilenceGuard(); return; }
    const c = cfg();
    const dur = Date.now() - session.startedAt;
    const silentFor = Date.now() - session.lastVoiceAt;

    // 硬上限：防止忘了关，一路录下去
    const maxMs = num(c.meetingMaxMinutes, 120, 5, 480) * 60000;
    if (dur >= maxMs) {
      log(`已到最大记录时长（${Math.round(maxMs / 60000)} 分钟），自动收尾`);
      stopRecording('max-minutes');
      return;
    }
    if (dur > 60000) {
      const remain = maxMs - dur;
      if (!quotaWarned && remain <= 5 * 60000) {
        quotaWarned = true;
        api.deliver({
          kind: 'meeting',
          title: '⏳ 会议记录即将到点',
          text: `已经记了 ${Math.round(dur / 60000)} 分钟，还有 5 分钟就到上限，需要继续的话点「继续记录」。`,
          open: false, speak: false, pet: true
        });
      }
    }

    // 静默收尾：对方挂了会议、但客户端还开着，mic 占用会一直为真，
    // 只能靠「一直没人说话」来判断会议其实已经结束。
    const silenceMs = num(c.meetingSilenceMin, 5, 1, 60) * 60000;
    if (dur > 60000 && silentFor >= silenceMs) {
      log(`已经 ${Math.round(silentFor / 60000)} 分钟没有听到人声，自动收尾`);
      stopRecording('silence');
    }
  }, 20000);
  if (guardTimer.unref) guardTimer.unref();
}
function stopSilenceGuard() {
  if (guardTimer) clearInterval(guardTimer);
  guardTimer = null;
}

// ---------------- 播报 ----------------
function deliverNeedKey() {
  if (deliverNeedKey.done) return;
  deliverNeedKey.done = true;
  // 10 分钟内只提醒一次（unref：别因为一个提醒计时器拖住进程退出）
  const t = setTimeout(() => { deliverNeedKey.done = false; }, 10 * 60000);
  if (t.unref) t.unref();
  api.deliver({
    kind: 'meeting',
    title: '🎙 检测到会议，但还差一步',
    text: '检到你在开会，不过还没配置语音识别 Key，记不了纪要。到「设置 → 语音」填一下就能自动记录了。',
    open: true, speak: false, pet: true
  });
}

function deliverError(msg) {
  api.deliver({
    kind: 'meeting',
    title: '⚠️ 会议记录没能开始',
    text: String(msg || '未知原因'),
    open: false, speak: false, pet: true
  });
}

function deliverSaved(rec, saved) {
  const n = (rec.summary.todos || []).length;
  const topic = rec.summary.topic ? `\n${rec.summary.topic}` : '';
  const todoLine = n ? `\n📌 ${n} 项待办已记下` : '';
  api.deliver({
    kind: 'meeting',
    title: `📝 会议纪要已生成（${minutes.fmtDuration(rec.durationMs)}）`,
    text: `${rec.app}${topic}${todoLine}\n转写 ${rec.stats.chars} 字，已存到 ${path.basename(saved.mdPath || saved.path || '')}`,
    open: true, speak: false, pet: true,
    meetingId: rec.id
  });
}

// ---------------- 轮询主循环 ----------------
async function tick() {
  if (!enabled()) return;
  const c = cfg();
  let sample;
  try {
    sample = await sampleOnce();
  } catch (e) {
    log('采样失败: ' + ((e && e.message) || e));
    return;
  }
  const r = sample.result;
  lastDetect = { at: Date.now(), level: r.level, app: r.app, reasons: r.reasons };

  const out = watcher.feed(r, Date.now());

  // 事件广播给界面（设置页有实时状态，排查「为什么不触发」全靠它）
  if (out.event) {
    broadcast('meeting:event', { type: out.event, detect: lastDetect, ...status() });
  }

  if (out.event === 'hint') {
    // 只提示，不自动开录：一次信号可能只是刷个语音消息
    if (c.meetingHint !== false && c.meetingAskFirst !== false) {
      api.deliver({
        kind: 'meeting',
        title: '🎙 好像要开会？',
        text: `检测到 ${r.app || '某个应用'} 正在使用麦克风。要开始记录纪要吗？在面板里点「开始记录」就行。`,
        open: false, speak: false, pet: true
      });
    }
    return;
  }

  if (out.event === 'started') {
    log(`检测到会议（${r.app}）：${r.reasons[0] || ''}`);
    if (c.meetingAutoRecord === false || c.meetingAskFirst === true) {
      api.deliver({
        kind: 'meeting',
        title: `📞 检测到 ${r.app || '通话'}`,
        text: c.meetingAskFirst === true
          ? `看起来你在用 ${r.app || '会议应用'}，要我一边听一边记纪要吗？点「开始记录」即可。`
          : `检测到 ${r.app || '会议应用'} 在用麦克风。自动记录已关闭，需要的话点「开始记录」。`,
        open: false, speak: false, pet: true,
        actions: ['meeting-start']
      });
      return;
    }
    // 自动记录：先说一声再开始，绝不让它偷偷录
    api.deliver({
      kind: 'meeting',
      title: `🎙 开始记录 ${r.app || '会议'} 纪要`,
      text: '我会把系统声音转成文字，结束后给你一份纪要。不想记的话点「停止记录」。',
      open: false, speak: false, pet: true,
      actions: ['meeting-stop']
    });
    const res = await startRecording('auto', { app: r.app, appExe: r.appExe });
    if (res && res.ok === false) log('自动记录没起来: ' + res.error);
    return;
  }

  if (out.event === 'ended') {
    log('检测到会议结束信号');
    // 还在录的时候不因为「检测不到麦」就立刻收尾 —— 客户端可能只是静音了，
    // 交给静默守护（连续 N 分钟没人声）来收更准。
    if (!session) return;
    log('仍在记录中，等静默守护判断是否收尾');
  }
}

function start() {
  if (pollTimer) return;
  if (process.platform !== 'win32') {
    log('非 Windows 平台，会议检测不启用');
    return;
  }
  watcher = new detect.MeetingWatcher({
    enterSamples: num(cfg().meetingEnterSamples, 2, 1, 10),
    exitMs: num(cfg().meetingExitSec, 90, 10, 900) * 1000,
    hintEnabled: cfg().meetingHint !== false,
    hintCooldownMs: 10 * 60000
  });
  const sec = num(cfg().meetingPollSec, 5, 2, 60);
  pollTimer = setInterval(() => { tick().catch(() => {}); }, sec * 1000);
  if (pollTimer.unref) pollTimer.unref();
  // 启动 20 秒后再开始采样：别和开机时的一堆事儿抢资源
  const firstTimer = setTimeout(() => { tick().catch(() => {}); }, 20000);
  if (firstTimer.unref) firstTimer.unref();
  log(`会议自动检测已启动（每 ${sec} 秒采样一次）`);
}

function stop() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  stopSilenceGuard();
  if (watcher) watcher.reset();
}

/** 收到配置变更后重建参数（用户在设置页改了轮询间隔/灵敏度） */
function reload() {
  if (!enabled()) {
    stop();
    log('会议检测已关闭');
    return;
  }
  stop();
  start();
  log('会议检测参数已刷新');
}

/** 退出前收尾：正在录就先落盘，别把整场会议丢了 */
async function cleanup() {
  stop();
  if (session) {
    log('退出前收尾正在进行的会议记录');
    try { await stopRecording('quit', { flushMs: 800 }); } catch (e) { /* ignore */ }
  }
  if (recorderWin && !recorderWin.isDestroyed()) {
    try { recorderWin.destroy(); } catch (e) { /* ignore */ }
  }
  recorderWin = null;
}

/**
 * 同步落盘（退出专用）。
 *
 * `will-quit` 是同步事件，里面没法 await —— 优雅收尾（让服务端把最后一句吐出来、
 * 再让模型写摘要）根本来不及。但至少要把已经识别到的转写存下来，
 * 否则一整天会议的文字就随进程一起没了。摘要留空，正文照存。
 */
function flushSync() {
  if (!session) return false;
  try {
    const merged = minutes.mergeSegments(session.segments);
    if (merged.segments.length < 3) {
      log(`退出时只有 ${merged.segments.length} 段转写，不够成篇，丢弃`);
      session = null;
      return false;
    }
    session.endReason = session.endReason || 'quit';
    const rec = buildRecord(session, merged);
    rec.summary = {
      topic: '（程序退出时来不及生成摘要，下面是原始转写）',
      points: [], decisions: [], todos: [], risks: [], raw: ''
    };
    minutes.save(rec);
    log(`退出前已把当前转写落盘：${rec.id}（${merged.segments.length} 段 / ${rec.stats.chars} 字）`);
    session = null;
    return true;
  } catch (e) {
    log('退出落盘失败: ' + ((e && e.message) || e));
    return false;
  }
}

// ---------------- IPC ----------------
ipcMain.handle('meeting:status', () => status());
ipcMain.handle('meeting:detect-now', async () => {
  let sample;
  try { sample = await sampleOnce(); } catch (e) { return { ok: false, error: (e && e.message) || '采样失败' }; }
  const r = sample.result;
  lastDetect = { at: Date.now(), level: r.level, app: r.app, reasons: r.reasons };
  return {
    ok: true,
    level: r.level,
    app: r.app,
    reasons: r.reasons,
    micUsers: sample.micUsers.map((u) => ({ exe: u.exe, active: u.active, stopKnown: u.stopKnown, name: u.name })),
    camUsers: sample.camUsers.map((u) => ({ exe: u.exe, active: u.active })),
    devices: sample.devices,
    procs: sample.procs.filter((p) => detect.isKnown(p.exe)).map((p) => ({ exe: p.exe, title: p.title }))
  };
});
ipcMain.handle('meeting:start', async (_e, meta = {}) => startRecording('manual', meta || {}));
ipcMain.handle('meeting:stop', async () => stopRecording('manual'));
ipcMain.handle('meeting:list', () => minutes.list());
ipcMain.handle('meeting:get', (_e, id) => minutes.get(String(id || '')));
ipcMain.handle('meeting:remove', (_e, id) => {
  const ok = minutes.remove(String(id || ''));
  broadcast('meeting:event', { type: 'removed', id, ...status() });
  return { ok };
});
ipcMain.handle('meeting:search', (_e, keyword) => minutes.search(keyword));
ipcMain.handle('meeting:open', async (_e, id) => {
  const p = path.join(minutes.dir(), `${String(id || '')}.md`);
  try {
    if (fs.existsSync(p)) { await shell.openPath(p); return { ok: true, path: p }; }
    const j = path.join(minutes.dir(), `${String(id || '')}.json`);
    if (fs.existsSync(j)) { await shell.openPath(j); return { ok: true, path: j }; }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '打开失败' };
  }
  return { ok: false, error: '找不到这份纪要的文件' };
});
ipcMain.handle('meeting:folder', async () => {
  try {
    const p = minutes.dir();
    await shell.openPath(p);
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '打开失败' };
  }
});
ipcMain.handle('meeting:snapshot-text', () => {
  if (!session) return { ok: false, error: '当前没有在记录' };
  return { ok: true, text: minutes.buildTranscript(session.segments), chars: session.chars };
});

module.exports = {
  bind,
  start,
  stop,
  reload,
  cleanup,
  flushSync,
  status,
  tick,
  startRecording,
  stopRecording,
  // 给测试 / 设置页用
  sampleOnce,
  watchedDevices,
  selfExe,
  isRecorderSender,
  get lastDetect() { return lastDetect; },
  get session() { return session; }
};
