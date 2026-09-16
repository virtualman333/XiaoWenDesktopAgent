/**
 * 会议自动检测 + 会议纪要回归测试 —— node build/_meeting_test.mjs
 *
 * 白盒优先，三层一起测：
 *   1. meeting-detect.js —— 注册表解析 / tasklist 解析 / 判定 / 迟滞状态机（纯函数）
 *   2. minutes.js        —— 转写清洗去重 / 摘要解析 / 落盘检索（纯函数 + 临时目录）
 *   3. meeting.js        —— 编排层：用桩顶掉 Electron 与子进程，走一遍
 *                           「检测到会议 → 自动开录 → 收转写 → 生成摘要 → 落盘 → 播报」
 *
 * 关键不在「跑通」，而在**把误报挡在门外**：
 *   小问自己用麦克风不算开会、应用常驻托盘不算开会、进程已退出的残留记录不算、
 *   只采到一次信号不算、非白名单应用默认不算。
 */
import Module from 'node:module';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);

let pass = 0; const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else fails.push(name + (extra ? ` → ${extra}` : '')); };
const eq = (a, b, name) => ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
const section = (s) => console.log('\n' + s);

const TMP = path.join(os.tmpdir(), 'xw-meeting-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });

// ================= 桩：electron / child_process =================
const ipcHandlers = new Map();
const ipcListeners = new Map();
const allWindows = [];

/** 录制窗口模拟器：收到 minutes:cmd 就按剧本回执 */
let recorderScript = null;   // { onStart, onStop }

const fakeElectron = {
  app: {
    getPath: (k) => (k === 'exe' ? 'C:\\Program Files\\小问助手\\小问助手.exe' : TMP),
    isPackaged: true,
    getVersion: () => '1.8.0'
  },
  ipcMain: {
    handle: (ch, fn) => ipcHandlers.set(ch, fn),
    on: (ch, fn) => ipcListeners.set(ch, fn),
    removeHandler: (ch) => ipcHandlers.delete(ch)
  },
  BrowserWindow: class FakeWindow {
    constructor() {
      this.webContents = {
        id: 1000 + allWindows.length,
        isLoading: () => false,
        send: (ch, payload) => {
          if (ch !== 'minutes:cmd') return;
          const cmd = payload && payload.cmd;
          const ack = (p) => { const l = ipcListeners.get('minutes:ack'); if (l) l({ sender: this }, p || { ok: true }); };
          if (cmd === 'start') {
            setTimeout(() => {
              if (recorderScript && recorderScript.onStart) recorderScript.onStart(ack);
              else ack({ ok: true });
            }, 0);
          } else if (cmd === 'stop') {
            setTimeout(() => {
              if (recorderScript && recorderScript.onStop) recorderScript.onStop(ack);
              else ack({ ok: true });
            }, 0);
          } else ack({ ok: true });
        },
        on: () => {},
        once: () => {}
      };
      allWindows.push(this);
    }
    isDestroyed() { return false; }
    on() {}
    destroy() {}
    loadFile() {}
    loadURL() {}
    static getAllWindows() { return allWindows; }
  },
  session: { fromPartition: () => ({ setDisplayMediaRequestHandler() {}, setPermissionRequestHandler() {} }) },
  desktopCapturer: { getSources: async () => [] },
  shell: { openPath: async () => '' }
};

let registerOutput = '';   // 注册表输出（由用例设置）—— 默认当作麦克风那一支
let webcamOutput = '';     // 摄像头那一支；没单独设就沿用 registerOutput
let tasklistOutput = '';   // tasklist 输出
let regQueries = [];       // 记录每次 reg query 查的是哪个设备，用来断言「探针真的跑了」

const fakeChildProcess = {
  execFile: (cmd, args, opts, cb) => {
    let out = '';
    if (cmd === 'reg') {
      // readConsent(device) 会调：reg query <CAPABILITY_ROOT>\<device> /s
      const key = String((args && args[1]) || '');
      const isCam = /\\webcam\b/i.test(key);
      regQueries.push(isCam ? 'webcam' : 'microphone');
      out = isCam ? (webcamOutput || registerOutput) : registerOutput;
    } else if (cmd === 'tasklist') out = tasklistOutput;
    setImmediate(() => cb(null, out, ''));
  }
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  if (request === 'child_process') return fakeChildProcess;
  return origLoad.apply(this, arguments);
};

const detect = require('../src/main/jarvis/meeting-detect.js');
const minutes = require('../src/main/jarvis/minutes.js');
const meeting = require('../src/main/meeting.js');
minutes.bind({ getDir: () => TMP });

// ================= 1. 注册表解析 =================
section('1. 注册表解析（谁在用麦克风）');
{
  // FILETIME：2024-01-01 00:00:00 UTC ≈ 0x01da2ce0bbc7c000
  ok(detect.filetimeToMs(0) === 0, '0 → 0（没记录）');
  const ms = detect.filetimeToMs(BigInt('0x01da2ce0bbc7c000'));
  ok(ms > 1700000000000 && ms < 1710000000000, 'FILETIME 能换算成合理的 Unix 毫秒', String(ms));

  const regText = [
    'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone',
    '    Value    REG_SZ    Allow',
    '',
    'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged',
    '    Value    REG_SZ    Allow',
    '',
    'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C#Program Files#Tencent#WeMeet#wemeetapp.exe',
    '    LastUsedTimeStart    REG_QWORD    0x1dc0e2f2a3b4c5d6',
    '    LastUsedTimeStop    REG_QWORD    0x0',
    '',
    'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C#Program Files#Zoom#bin#Zoom.exe',
    '    LastUsedTimeStart    REG_QWORD    0x1dc0d0000000000',
    '    LastUsedTimeStop    REG_QWORD    0x1dc0d0010000000',
    ''
  ].join('\n');

  const tree = detect.parseRegQuery(regText);
  ok(Object.keys(tree).length === 4, '四个键都解出来了', String(Object.keys(tree).length));
  const wemeetKey = Object.keys(tree).find((k) => k.includes('wemeetapp'));
  eq(tree[wemeetKey].LastUsedTimeStop.value, '0x0', '取到 Stop 值');

  eq(detect.decodeKeyName('C:#Program Files#Tencent#WeMeet#wemeetapp.exe'), 'C:\\Program Files\\Tencent\\WeMeet\\wemeetapp.exe', '# 还原成反斜杠（盘符的冒号保留）');
  eq(detect.exeFromKeyName('C:#x#wemeetapp.exe'), 'wemeetapp.exe', '从键名取 exe');
  eq(detect.exeFromKeyName('Microsoft.WindowsCamera_8wekyb3d8bbwe'), '', '应用商店包名没有 exe');

  const users = detect.activeUsers(regText);
  const wemeet = users.find((u) => u.exe === 'wemeetapp.exe');
  const zoom = users.find((u) => u.exe === 'zoom.exe');
  eq(wemeet.active, true, 'Stop=0 → 正在用麦克风');
  eq(wemeet.stopKnown, true, 'Stop 值存在');
  eq(zoom.active, false, 'Stop 有值 → 已经用完');
  eq(wemeet.packaged, false, 'NonPackaged 不能被误判成 Packaged');

  // 只有 Start、没有 Stop 的残缺记录：不能采信
  const partial = detect.activeUsers([
    'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C#x#ghost.exe',
    '    LastUsedTimeStart    REG_QWORD    0x1dc0e2f2a3b4c5d6',
    ''
  ].join('\n'));
  eq(partial[0].active, true, '缺 Stop 时按数值算是 active');
  eq(partial[0].stopKnown, false, '但标记为记录不完整（判定时不采信）');
}

// ================= 2. tasklist 解析 =================
section('2. 进程与窗口标题解析');
{
  const csv = [
    '"wemeetapp.exe","1234","Console","1","300,000 K","Running","DESKTOP\\me","0:12:05","腾讯会议 - 每周同步"',
    '"WeChat.exe","5678","Console","1","120,000 K","Running","DESKTOP\\me","0:00:03","N/A"',
    '"chrome.exe","9012","Console","1","500,000 K","Running","DESKTOP\\me","0:01:00","Meet - abc-defg-hij - Google Chrome"',
    'not a csv line',
    ''
  ].join('\n');
  const procs = detect.parseTasklist(csv);
  eq(procs.length, 3, '解析出 3 个进程', String(procs.length));
  eq(procs[0].exe, 'wemeetapp.exe', '进程名小写化');
  eq(procs[0].mem, '300,000 K', '带逗号的内存字段没被切坏');
  eq(procs[0].title, '腾讯会议 - 每周同步', '窗口标题拿到');
  eq(procs[1].title, '', 'N/A 标题归一成空串');
  ok(detect.isBrowser('chrome.exe'), 'chrome 认成浏览器');
  ok(!detect.isBrowser('wemeetapp.exe'), '会议客户端不是浏览器');
  eq(detect.labelOf('wemeetapp.exe'), '腾讯会议', 'exe 翻译成中文名');
  eq(detect.titleHit('Google Meet - xyz'), 'google meet', '标题命中英文关键词');
  eq(detect.titleHit('记事本'), '', '普通窗口标题不命中');

  // 中文版 Windows 的 tasklist 把「没有标题」写成「暂缺」，不是 N/A
  eq(detect.isNoTitle('暂缺'), true, '中文版 Windows 的「暂缺」当成空标题');
  eq(detect.isNoTitle('N/A'), true, 'N/A 当成空标题');
  eq(detect.isNoTitle('微信'), false, '正常标题不算空');

  // —— 编码：这是实机验证时才暴露的坑 ——
  // tasklist / reg query 按控制台 OEM 代码页（简体中文 = GBK）输出，
  // 按 UTF-8 硬解会把中文标题变成乱码，标题关键词就永远匹配不上。
  const gbkBytes = Buffer.from([0xd3, 0xef, 0xd2, 0xf4, 0xcd, 0xa8, 0xbb, 0xb0]); // 「语音通话」
  eq(gbkBytes.toString('utf8').includes('\uFFFD'), true, '（前提）GBK 字节按 UTF-8 解会出替换字符');
  eq(detect.decodeOemText(gbkBytes), '语音通话', 'GBK 输出能正确解码');
  eq(detect.decodeOemText(Buffer.from('会议中 - 腾讯会议', 'utf8')), '会议中 - 腾讯会议', '本来就是 UTF-8 的不动它');
  eq(detect.decodeOemText(Buffer.from('wemeetapp.exe', 'utf8')), 'wemeetapp.exe', '纯 ASCII 不受影响');
  const both = detect.decodeOemTextBoth(gbkBytes);
  eq(both.primary, '语音通话', '两种解码里主用的是正确那份');
  ok(both.alt === '' || both.alt !== both.primary, '备用解码要么为空要么与主用不同', JSON.stringify(both));

  const gbkCsv = Buffer.from('"chrome.exe","1","Console","1","1 K","Running","u","0:00","', 'utf8');
  const gbkLine = Buffer.concat([gbkCsv, gbkBytes, Buffer.from('"', 'utf8')]);
  const dec = detect.decodeOemTextBoth(gbkLine);
  const procsGbk = detect.parseTasklist(dec.primary, { altText: dec.alt });
  eq(procsGbk.length, 1, 'GBK 输出也能解析出进程');
  eq(procsGbk[0].title, '语音通话', '中文标题不乱码了');
  eq(detect.titleHit(procsGbk[0].title), '语音通话', '于是中文关键词能命中（修复前这里永远匹配不上）');
}

// ================= 3. 判定 =================
section('3. 判定：什么才算「在开会」');
{
  const u = (exe, active = true) => ({ exe, active, stopKnown: true, name: exe });
  const p = (exe, title = '') => ({ exe, name: exe, title, pid: 1 });

  // ① 白名单应用占用麦克风 = 开会
  let r = detect.classify({
    micUsers: [u('wemeetapp.exe')],
    procs: [p('wemeetapp.exe', '腾讯会议')],
    selfExe: '小问助手.exe'
  });
  eq(r.level, 'meeting', '腾讯会议占用麦克风 → 判定在开会');
  eq(r.app, '腾讯会议', '带上应用中文名');
  ok(/腾讯会议正在使用麦克风/.test(r.reasons[0]), '理由写清楚', r.reasons[0]);

  // ② 小问自己用麦克风不算（否则一开语音问答就以为在开会）
  r = detect.classify({
    micUsers: [u('小问助手.exe')],
    procs: [p('小问助手.exe')],
    selfExe: '小问助手.exe'
  });
  eq(r.level, 'none', '小问自己用麦不算开会');
  ok(r.reasons.some((x) => /小问自己/.test(x)), '理由里说明是小问自己', r.reasons.join('；'));

  // ③ 非白名单应用占麦：默认忽略，开了开关才算弱信号
  r = detect.classify({ micUsers: [u('audacity.exe')], procs: [p('audacity.exe')], selfExe: 'x.exe' });
  eq(r.level, 'none', '未知应用占麦默认忽略');
  r = detect.classify({ micUsers: [u('audacity.exe')], procs: [p('audacity.exe')], selfExe: 'x.exe', allowUnknown: true });
  eq(r.level, 'mic', '开了开关才算弱信号');
  eq(r.app, 'audacity', '弱信号也给出应用名');

  // ④ 进程已经退出，只留了注册表记录 —— 不能当真
  r = detect.classify({ micUsers: [u('wemeetapp.exe')], procs: [], selfExe: 'x.exe' });
  eq(r.level, 'none', '进程不在的残留记录不算');
  ok(r.reasons.some((x) => /进程已不在/.test(x)), '理由说明是残留', r.reasons.join('；'));

  // ⑤ 只开着客户端（常驻托盘）、没人用麦 —— 不算
  r = detect.classify({
    micUsers: [],
    procs: [p('wemeetapp.exe', '腾讯会议'), p('dingtalk.exe', '钉钉')],
    selfExe: 'x.exe'
  });
  eq(r.level, 'none', '应用常驻但没占用麦克风 → 不算开会');

  // ⑥ 浏览器里的 Google Meet：标题 + 麦克风都指向同一个 exe 才算
  r = detect.classify({
    micUsers: [u('chrome.exe')],
    procs: [p('chrome.exe', 'Meet - abc-defg-hij - Google Chrome')],
    selfExe: 'x.exe'
  });
  eq(r.level, 'meeting', '浏览器开 Meet 且占用麦克风 → 判定在开会');
  ok(/Google Chrome/i.test(r.app) || /chrome/i.test(r.app), '给出浏览器名', r.app);

  r = detect.classify({
    micUsers: [],
    procs: [p('chrome.exe', 'Meet - abc-defg-hij - Google Chrome')],
    selfExe: 'x.exe'
  });
  eq(r.level, 'none', '只是开着 Meet 页面但没用麦 → 不算');

  // ⑦ 纯视频会议（不开麦，用摄像头）
  r = detect.classify({ camUsers: [u('zoom.exe')], procs: [p('zoom.exe')], selfExe: 'x.exe' });
  eq(r.level, 'meeting', '摄像头被 Zoom 占用也能识别');

  // ⑧ OBS 直播占麦：识别出来但不当会议
  r = detect.classify({ micUsers: [u('obs64.exe')], procs: [p('obs64.exe')], selfExe: 'x.exe' });
  eq(r.level, 'mic', 'OBS 占麦 → 只算弱信号');
  eq(r.app, 'OBS', '认出是 OBS');

  // ⑨ 记录不完整的不采信
  r = detect.classify({
    micUsers: [{ exe: 'wemeetapp.exe', active: true, stopKnown: false }],
    procs: [p('wemeetapp.exe')],
    selfExe: 'x.exe'
  });
  eq(r.level, 'none', 'Stop 缺失的记录不采信');
}

// ================= 4. 迟滞状态机 =================
section('4. 迟滞：宁可晚一点开始，也别一开机就误报');
{
  const positive = { level: 'meeting', app: '腾讯会议', appExe: 'wemeetapp.exe', reasons: ['x'] };
  const negative = { level: 'none', app: '', appExe: '', reasons: [] };
  const t0 = 1700000000000;

  let w = new detect.MeetingWatcher({ enterSamples: 2, exitMs: 90000, hintEnabled: false });
  eq(w.feed(positive, t0).event, null, '第一次采样不触发（还没凑够）');
  const r2 = w.feed(positive, t0 + 5000);
  eq(r2.event, 'started', '连续第二次 → 判定开始');
  eq(r2.changed, true, '状态发生变化');
  eq(w.state, 'active', '进入 active');

  eq(w.feed(positive, t0 + 10000).event, null, '已经在录了，不再重复触发');

  const n1 = w.feed(negative, t0 + 60000);
  eq(n1.event, null, '刚采不到还不算结束（可能是静音了）');
  eq(w.state, 'active', '仍然保持 active');
  const n2 = w.feed(negative, t0 + 60000 + 89000);
  eq(n2.event, null, '没到 90 秒不算结束');
  const n3 = w.feed(negative, t0 + 60000 + 95000);
  eq(n3.event, 'ended', '超过 exitMs → 判定结束');
  eq(w.state, 'idle', '回到 idle');
  ok(n3.durationMs >= 150000, '时长从「开始」那一刻算起', String(n3.durationMs));

  // 中途又有人说话 → 静默计时清零
  w = new detect.MeetingWatcher({ enterSamples: 2, exitMs: 60000, hintEnabled: false });
  w.feed(positive, t0); w.feed(positive, t0 + 1000);
  w.feed(negative, t0 + 5000);
  w.feed(positive, t0 + 30000);
  eq(w.feed(negative, t0 + 70000).event, null, '中间说过话 → 静默重新计时');
  eq(w.feed(negative, t0 + 129000).event, null, '（从 t0+70000 起算还没满 60 秒）');
  eq(w.feed(negative, t0 + 131000).event, 'ended', '从最后一次负信号起算满 60 秒才结束');

  // 只采到一次 → 发 hint，且 hint 有冷却
  w = new detect.MeetingWatcher({ enterSamples: 3, exitMs: 1000, hintEnabled: true, hintCooldownMs: 60000 });
  eq(w.feed(positive, t0).event, 'hint', '第一次就轻轻提示一下');
  eq(w.feed(positive, t0 + 1000).event, null, '冷却期内不重复提示');
  w.feed(negative, t0 + 2000);
  eq(w.feed(positive, t0 + 3000).event, null, '冷却期还没过 → 不提示（但仍在计数）');
  eq(w.feed(positive, t0 + 4000).event, null, '两次还不够（要 3 次）');
  eq(w.feed(positive, t0 + 5000).event, 'started', '凑够 3 次正式触发（冷却只影响提示，不影响判定）');

  // reset
  w = new detect.MeetingWatcher({ enterSamples: 2, hintEnabled: false });
  w.feed(positive, t0); w.feed(positive, t0 + 1000);
  eq(w.state, 'active', '先进入 active');
  w.reset();
  eq(w.state, 'idle', 'reset 回到 idle');
  eq(w.feed(positive, t0 + 2000).event, null, 'reset 后重新计数（不再立刻触发）');
}

// ================= 5. 转写清洗 =================
section('5. 转写清洗：别把「嗯嗯嗯」写成纪要');
{
  eq(minutes.cleanText('  大家好，  \n 我是小王 '), '大家好， 我是小王', '折叠空白');
  eq(minutes.isNoise('嗯'), true, '单个语气词丢掉');
  eq(minutes.isNoise('嗯嗯嗯嗯嗯'), true, '一串同一个字丢掉');
  eq(minutes.isNoise('。，、'), true, '只有标点丢掉');
  eq(minutes.isNoise('好的'), false, '正常短句留下');
  eq(minutes.isRepeatChars('哈哈哈'), false, '三个字还不算超长重复');
  eq(minutes.isRepeatChars('哈哈哈哈'), true, '四个字起算重复');
  eq(minutes.isNoise(''), true, '空串丢掉');

  ok(minutes.diceCoefficient('今天天气不错', '今天天气不错') === 1, '完全相同 = 1');
  ok(minutes.diceCoefficient('今天天气不错', '完全不一样的内容') < 0.3, '差别大 = 低');
  eq(minutes.isNearDuplicate('大家好', '大家好，我是小王'), true, '前缀扩展 = 重复');
  eq(minutes.isNearDuplicate('大家好', '大家好'), true, '一模一样 = 重复');
  eq(minutes.isNearDuplicate('我们今天讨论排期', '我们今天讨论排期'), true, '整句重说 = 重复');
  eq(minutes.isNearDuplicate('预算大概两百万', '服务器需要扩容'), false, '不同内容不判重');

  const merged = minutes.mergeSegments([
    { at: 1000, text: '大家好' },
    { at: 1500, text: '嗯' },
    { at: 2000, text: '大家好，我是小王' },
    { at: 3000, text: '今天主要过一下排期' },
    { at: 4000, text: '今天主要过一下排期' },
    { at: 5000, text: '嗯嗯嗯嗯嗯' },
    { at: 6000, text: '第一项是登录改版' }
  ]);
  eq(merged.segments.length, 3, '重复与噪声被去掉', JSON.stringify(merged.segments.map((s) => s.text)));
  eq(merged.dup, 2, '统计到 2 段重复');
  eq(merged.dropped, 2, '统计到 2 段噪声');
  ok(merged.segments[0].text.includes('我是小王'), '前缀扩展保留信息更全的那条', merged.segments[0].text);

  const tr = minutes.buildTranscript([
    { at: new Date(2026, 8, 14, 14, 35).getTime(), text: '甲' },
    { at: new Date(2026, 8, 14, 14, 36).getTime(), text: '乙' }
  ]);
  ok(/\[14:35~14:36\]/.test(tr), '转写带时间戳区间', tr);
  eq(minutes.fmtDuration(3700000), '1 小时 1 分', '时长人话化');
  eq(minutes.fmtDuration(45000), '45 秒', '短时长');
}

// ================= 6. 摘要解析 =================
section('6. 摘要解析：markdown 与 JSON 都要能捞回来');
{
  const md = [
    '## 主题',
    '讨论下个版本的排期与资源分配。',
    '',
    '## 要点',
    '- 登录改版优先做',
    '- 预算需要在周五前确认',
    '',
    '## 结论',
    '- 先做登录改版',
    '',
    '## 待办',
    '- [ ] 小王整理排期表 —— 小王',
    '- [ ] 确认预算 —— 未指定',
    '',
    '## 风险与疑问',
    '- 人手可能不够'
  ].join('\n');
  const s = minutes.parseSummary(md);
  eq(s.topic, '讨论下个版本的排期与资源分配。', '主题解析出来');
  eq(s.points.length, 2, '要点 2 条');
  eq(s.decisions.length, 1, '结论 1 条');
  eq(s.todos.length, 2, '待办 2 条');
  ok(/排期表/.test(s.todos[0]) && !/\[ \]/.test(s.todos[0]), '待办里的 checkbox 去掉', s.todos[0]);
  eq(s.risks.length, 1, '风险 1 条');

  const none = minutes.parseSummary('## 主题\n随便聊了聊\n\n## 要点\n- 无\n\n## 结论\n无\n\n## 待办\n无\n\n## 风险与疑问\n无');
  eq(none.points.length, 0, '「无」不算条目');
  eq(none.todos.length, 0, '「无」待办为空');

  const js = minutes.parseSummary('```json\n{"topic":"接口联调","points":["a","b"],"todos":["c"]}\n```');
  eq(js.topic, '接口联调', 'JSON 分支：主题');
  eq(js.points.length, 2, 'JSON 分支：要点');

  const messy = minutes.parseSummary('模型今天心情不好，直接给了一段散文，没有任何小标题。但内容还是要留下。');
  eq(messy.points.length, 1, '完全不成形时至少把内容留在要点里', JSON.stringify(messy.points));
  eq(minutes.parseSummary('').topic, '', '空输入安全');
  eq(minutes.parseSummary(null).points.length, 0, 'null 安全');

  const prompt = minutes.summaryPrompt({ app: '腾讯会议', startedAt: Date.now(), durationMs: 600000 }, '甲：先做登录');
  eq(prompt.length, 2, '提示词是 system+user 两条');
  ok(/## 待办/.test(prompt[0].content), '要求模型输出待办小节');
  ok(/先做登录/.test(prompt[1].content), '转写内容进了 user 消息');
  ok(/只依据转写内容/.test(prompt[0].content), '明确禁止编造');
}

// ================= 7. 落盘 / 检索 =================
section('7. 纪要落盘与检索');
{
  const rec = {
    id: '20260914-143500-wemeet',
    app: '腾讯会议',
    appExe: 'wemeetapp.exe',
    title: '腾讯会议 · 09-14 14:35',
    startedAt: new Date(2026, 8, 14, 14, 35).getTime(),
    endedAt: new Date(2026, 8, 14, 15, 12).getTime(),
    durationMs: 37 * 60000,
    segments: [{ at: Date.now(), text: '先做登录改版', source: 'loopback' }],
    transcript: '[14:35] 先做登录改版',
    summary: minutes.parseSummary('## 主题\n排期\n\n## 待办\n- [ ] 整理排期表 —— 小王'),
    stats: { segCount: 1, chars: 6, source: '系统声音 + 麦克风' },
    savedAt: Date.now()
  };
  const saved = minutes.save(rec);
  eq(saved.ok, true, '保存成功');
  ok(fs.existsSync(saved.path), '完整记录落盘');
  ok(fs.existsSync(saved.mdPath), 'markdown 纪要落盘');

  const md = fs.readFileSync(saved.mdPath, 'utf-8');
  ok(/^# 会议纪要 · 腾讯会议/m.test(md), 'markdown 有标题');
  ok(/- \[ \] 整理排期表/.test(md), '待办渲染成 checkbox');
  ok(/37 分/.test(md), '时长写进纪要');
  ok(/## 转写全文/.test(md), '带转写全文');

  const list = minutes.list();
  eq(list.length, 1, '索引里有 1 条');
  eq(list[0].id, rec.id, '索引 id 正确');
  eq(list[0].todoCount, 1, '索引里带待办数');
  eq(list[0].topic, '排期', '索引里带主题');

  eq(minutes.get(rec.id).transcript, '[14:35] 先做登录改版', '能按 id 取回完整记录');
  eq(minutes.get('不存在'), null, '取不存在的返回 null');

  eq(minutes.search('登录').length, 1, '搜主题/正文命中');
  eq(minutes.search('腾讯会议').length, 1, '搜应用名命中');
  eq(minutes.search('完全不相关的东西').length, 0, '搜不到就是空');
  eq(minutes.search('').length, 1, '空关键词返回最近几条');

  const st = minutes.stats();
  eq(st.count, 1, '统计条数');
  ok(st.todayCount >= 0 && st.lastTopic === '排期', '统计里有最近主题');

  eq(minutes.remove(rec.id), true, '删除成功');
  eq(minutes.list().length, 0, '索引里也没了');
  eq(fs.existsSync(saved.mdPath), false, 'md 文件被删掉');
}

// ================= 8. 编排层：走一遍完整流程 =================
section('8. 编排层：检测 → 自动开录 → 转写 → 摘要 → 落盘 → 播报');
{
  const delivered = [];
  const mlog = [];
  let recordingStarted = 0;
  let recordingStopped = 0;
  let cfg = {
    meetingEnabled: true,
    meetingAutoRecord: true,
    meetingAskFirst: false,
    meetingEnterSamples: 2,
    meetingExitSec: 90,
    meetingMinMinutes: 1,
    meetingMaxMinutes: 120,
    meetingSilenceMin: 5,
    meetingSegmentMin: 5,
    meetingCaptureMic: true,
    asrApiKey: 'sk-test-key'
  };
  let asrBusy = false;

  meeting.bind({
    getConfig: () => cfg,
    log: (m) => mlog.push(m),
    deliver: (p) => delivered.push(p),
    summarize: async () => [
      '## 主题', '确认下个版本排期。',
      '', '## 要点', '- 登录改版优先',
      '', '## 待办', '- [ ] 整理排期表 —— 小王',
      '', '## 风险与疑问', '- 无'
    ].join('\n'),
    isAsrBusy: () => asrBusy
  });

  // 录制窗口剧本：start 时回执 + 上报若干转写；stop 时回执
  recorderScript = {
    onStart: (ack) => {
      recordingStarted++;
      ack({ ok: true, sources: ['系统声音', '麦克风'] });
      const chunk = ipcListeners.get('minutes:chunk');
      for (const t of ['大家好，我是小王', '嗯', '大家好，我是小王', '今天主要过一下排期', '第一项是登录改版']) {
        chunk({}, { text: t, at: Date.now(), source: 'loopback' });
      }
      const voice = ipcListeners.get('minutes:voice');
      voice({}, { level: 0.5 });
    },
    onStop: (ack) => { recordingStopped++; ack({ ok: true, chars: 20, segments: 3 }); }
  };

  registerOutput = [
    'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C#Program Files#Tencent#WeMeet#wemeetapp.exe',
    '    LastUsedTimeStart    REG_QWORD    0x1dc0e2f2a3b4c5d6',
    '    LastUsedTimeStop    REG_QWORD    0x0'
  ].join('\n');
  tasklistOutput = '"wemeetapp.exe","1234","Console","1","300,000 K","Running","DESKTOP\\me","0:12:05","腾讯会议 - 每周同步"';

  meeting.start();

  // —— 第 1 次采样：还不够 ——
  await meeting.tick();
  eq(meeting.status().recording, false, '第一次采样不开始记录');
  eq(delivered.length, 0, '也不打扰（默认不问）');

  // —— 第 2 次采样：确认在开会 → 自动开录 ——
  await meeting.tick();
  await new Promise((r) => setTimeout(r, 30));   // 等录制窗口的异步回执
  const st1 = meeting.status();
  eq(st1.recording, true, '第二次采样后开始记录');
  eq(recordingStarted, 1, '录制窗口收到 start 指令并回执');
  eq(delivered.length, 1, '开录时先告知一声（不能偷偷录）');
  ok(/开始记录/.test(delivered[0].title), '播报标题说明在记录', delivered[0].title);
  // 5 段上报里「嗯」被主进程直接丢掉 → 落 4 段（去重留到收尾时做）
  eq(st1.session.chars, 33, '转写片段累积到会话里', String(st1.session.chars));
  eq(st1.session.segments, 4, '噪声片段当场丢弃，其余都收下', String(st1.session.segments));

  // 采集窗口是「自己人」：它发起的识别请求不该被当成抢占
  const rcId = allWindows[0].webContents.id;
  eq(meeting.isRecorderSender({ id: rcId }), true, '认得出采集窗口自己发的请求');
  eq(meeting.isRecorderSender({ id: 99999 }), false, '面板/别处的请求不算采集窗口');

  // —— 收尾 ——
  const res = await meeting.stopRecording('manual', { flushMs: 0 });
  eq(recordingStopped, 1, '录制窗口收到 stop 指令');
  eq(res.ok, true, '结束成功');
  ok(res.id, '拿到纪要 id', res.id);
  eq(delivered.length, 2, '生成后播报一条');
  ok(/会议纪要已生成/.test(delivered[1].title), '播报标题是纪要已生成', delivered[1].title);
  ok(/1 项待办/.test(delivered[1].text), '播报里带待办数', delivered[1].text);

  const rec = minutes.get(res.id);
  eq(rec.segments.length, 3, '落盘时去掉了「嗯」和重复段', String(rec.segments.length));
  eq(rec.app, '腾讯会议', '记下是哪个应用');
  eq(rec.summary.todos.length, 1, '摘要里的待办落进纪要');
  eq(rec.stats.endReason, 'manual', '记下结束原因');
  eq(meeting.status().recording, false, '状态回到未记录');

  // —— 没有语音识别 Key 时不能开录，要明确告诉主人 ——
  delivered.length = 0;
  cfg = { ...cfg, asrApiKey: '' };
  const r2 = await meeting.startRecording('manual');
  eq(r2.ok, false, '没配 Key 时不开始记录');
  ok(/语音识别 Key/.test(delivered[0].text), '播报里点明缺 Key', delivered[0].text);

  // —— 语音通道被别人占用时也要让路 ——
  delivered.length = 0;
  cfg = { ...cfg, asrApiKey: 'sk-test-key' };
  asrBusy = true;
  const r3 = await meeting.startRecording('manual');
  eq(r3.ok, false, '识别通道被占用时不抢');
  eq(delivered.length, 0, '这种情况不打扰（只写日志）');
  asrBusy = false;

  // —— 内容太少不留纪要 ——
  recorderScript = {
    onStart: (ack) => {
      ack({ ok: true });
      ipcListeners.get('minutes:chunk')({}, { text: '在吗', at: Date.now(), source: 'loopback' });
    },
    onStop: (ack) => ack({ ok: true })
  };
  delivered.length = 0;
  await meeting.startRecording('manual');
  const r4 = await meeting.stopRecording('manual', { flushMs: 0 });
  eq(r4.discarded, true, '只识别到一句话 → 丢弃不留纪要');
  eq(minutes.get(r4.id || '') === null, true, '丢弃的不会落盘');
  eq(delivered.length, 0, '丢弃不播报');

  // —— 退出路径：同步落盘 ——
  recorderScript = {
    onStart: (ack) => {
      ack({ ok: true });
      const chunk = ipcListeners.get('minutes:chunk');
      for (const t of ['甲：今天先过排期', '乙：好，我先说登录', '丙：预算周五前确认']) {
        chunk({}, { text: t, at: Date.now(), source: 'loopback' });
      }
    },
    onStop: (ack) => ack({ ok: true })
  };
  await meeting.startRecording('manual');
  const before = minutes.list().length;
  eq(meeting.flushSync(), true, '退出时能把转写同步落盘');
  eq(minutes.list().length, before + 1, '索引里多了一条');
  eq(meeting.status().recording, false, '落盘后会话清空');

  // —— 手动「立即检测」返回可读的诊断信息 ——
  const det = await ipcHandlers.get('meeting:detect-now')({});
  eq(det.ok, true, 'detect-now 可用');
  eq(det.level, 'meeting', '报告当前判定等级');
  ok(Array.isArray(det.micUsers) && det.micUsers.length === 1, '顺带把「谁在用麦」列出来，方便排障');
  ok(det.reasons.length > 0, '给出人话理由');

  meeting.stop();
}

// ================= 9. 配置开关 =================
section('9. 开关与参数');
{
  let cfg = { meetingEnabled: false, asrApiKey: 'sk' };
  let delivered = [];
  meeting.bind({ getConfig: () => cfg, log: () => {}, deliver: (p) => delivered.push(p), summarize: async () => '', isAsrBusy: () => false });

  registerOutput = [
    'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C#x#wemeetapp.exe',
    '    LastUsedTimeStart    REG_QWORD    0x1dc0e2f2a3b4c5d6',
    '    LastUsedTimeStop    REG_QWORD    0x0'
  ].join('\n');
  tasklistOutput = '"wemeetapp.exe","1","Console","1","1 K","Running","u","0:00","腾讯会议"';

  await meeting.tick();
  await meeting.tick();
  eq(meeting.status().recording, false, '总开关关掉后不检测、不记录');
  eq(delivered.length, 0, '也不播报');

  cfg = { ...cfg, meetingEnabled: true, meetingAutoRecord: false };
  await meeting.tick();
  await meeting.tick();
  await new Promise((r) => setTimeout(r, 20));
  eq(meeting.status().recording, false, '关了自动记录就只提醒不录');
  eq(delivered.length, 1, '但会提醒一句');
  ok(/自动记录已关闭/.test(delivered[0].text), '提醒里说明原因', delivered[0].text);

  // 先问一句模式
  cfg = { ...cfg, meetingAutoRecord: true, meetingAskFirst: true };
  meeting.stop();
  meeting.start();
  delivered = [];
  await meeting.tick();
  await meeting.tick();
  await new Promise((r) => setTimeout(r, 20));
  eq(meeting.status().recording, false, '「先问我」模式不自动录');
  ok(/要.*记|点「开始记录」/.test(delivered[0].text), '而是问一句', delivered[0].text);

  meeting.stop();
}

// ================= 10. 探针归属：哪个开关管哪一路信号 =================
section('10. 探针归属：麦克风信号不能被摄像头开关带走');
{
  // 取一段函数的源码文本（按大括号配平），用来做形态锁
  const functionBody = (src, sig) => {
    const i = src.indexOf(sig);
    if (i < 0) return '';
    let depth = 0;
    let started = false;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') { depth++; started = true; } else if (src[j] === '}') {
        depth--;
        if (started && depth === 0) return src.slice(i, j + 1);
      }
    }
    return src.slice(i);
  };
  const strip = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const ROOT = path.dirname(require.resolve('../package.json'));
  const meetingSrc = strip(fs.readFileSync(path.join(ROOT, 'src', 'main', 'meeting.js'), 'utf-8'));

  // —— 纯函数：这一轮到底该看哪几路信号 ——
  eq(meeting.watchedDevices({}).join(','), 'microphone,webcam', '默认两路都看');
  eq(meeting.watchedDevices({ meetingWatchCam: true }).join(','), 'microphone,webcam', '开着摄像头开关就两路都看');
  eq(meeting.watchedDevices({ meetingWatchCam: false }).join(','), 'microphone', '★ 关掉摄像头开关只该少一路：麦克风信号必须还在');

  // —— 端到端：关掉摄像头开关后，占麦的会议应用仍要判成「在开会」 ——
  {
    const cfg = { meetingEnabled: true, meetingAutoRecord: false, meetingWatchCam: false };
    const delivered = [];
    meeting.bind({ getConfig: () => cfg, log: () => {}, deliver: (p) => delivered.push(p), summarize: async () => '', isAsrBusy: () => false });

    registerOutput = [
      'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C#x#wemeetapp.exe',
      '    LastUsedTimeStart    REG_QWORD    0x1dc0e2f2a3b4c5d6',
      '    LastUsedTimeStop    REG_QWORD    0x0'
    ].join('\n');
    webcamOutput = '';
    tasklistOutput = '"wemeetapp.exe","1234","Console","1","300,000 K","Running","DESKTOP\\me","0:12:05","腾讯会议 - 每周同步"';
    regQueries = [];

    const s = await meeting.sampleOnce();
    ok(s.micUsers.length > 0, '★ 摄像头开关关掉后，注册表里的麦克风占用照样读得到', JSON.stringify(s.micUsers));
    eq(s.camUsers.length, 0, '摄像头那一路确实没采');
    eq(s.result.level, 'meeting', '★ 因此仍能判成「在开会」');
    ok(s.devices.includes('microphone'), '采样结果里带着本轮探了哪几路（给设置页显示）');
    ok(regQueries.includes('microphone'), '真的去读了麦克风的注册表');
    ok(!regQueries.includes('webcam'), '真的没去读摄像头的注册表');
  }

  // —— 反向对照：开着摄像头开关时，纯视频会议也要算数 ——
  {
    const cfg = { meetingEnabled: true, meetingAutoRecord: false, meetingWatchCam: true };
    meeting.bind({ getConfig: () => cfg, log: () => {}, deliver: () => {}, summarize: async () => '', isAsrBusy: () => false });

    registerOutput = '';   // 没人占麦
    webcamOutput = [
      'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam\\NonPackaged\\C#x#wemeetapp.exe',
      '    LastUsedTimeStart    REG_QWORD    0x1dc0e2f2a3b4c5d6',
      '    LastUsedTimeStop    REG_QWORD    0x0'
    ].join('\n');
    tasklistOutput = '"wemeetapp.exe","1234","Console","1","300,000 K","Running","DESKTOP\\me","0:12:05","腾讯会议 - 每周同步"';
    regQueries = [];

    const s = await meeting.sampleOnce();
    eq(s.micUsers.length, 0, '对照：麦克风这边确实没人用');
    ok(s.camUsers.length > 0, '对照：摄像头占用被采到了');
    eq(s.result.level, 'meeting', '对照：纯视频会议也判成在开会');
    ok(regQueries.includes('webcam'), '对照：查了摄像头的注册表');
  }

  // —— 形态锁：探针归属只允许判断一次，且判在 watchedDevices 里 ——
  const sampleBody = functionBody(meetingSrc, 'async function sampleOnce');
  ok(sampleBody.length > 0, '拿到了 sampleOnce 的源码');
  ok(!/meetingWatchCam/.test(sampleBody),
    'sampleOnce 里不再出现 meetingWatchCam（归属判断只该在 watchedDevices 里做一次，否则两路信号又会串开关）');
  eq((meetingSrc.match(/readConsent\('microphone'\)/g) || []).length, 1, '读麦克风注册表只有一处');
  eq((meetingSrc.match(/readConsent\('webcam'\)/g) || []).length, 1, '读摄像头注册表只有一处');
  ok(/function watchedDevices/.test(meetingSrc), 'watchedDevices 存在');
  ok(/devices:\s*sample\.devices/.test(meetingSrc), 'meeting:detect-now 把本轮探测的信号回给界面');

  registerOutput = '';
  webcamOutput = '';
  tasklistOutput = '';
  meeting.stop();
}

// ================= 11. 界面入口：已实现的能力不能没人调 =================
section('11. 界面接线：搜纪要走主进程那份实现，界面不另写一套');
{
  const ROOT = path.dirname(require.resolve('../package.json'));
  const mk = (i, title, transcript) => minutes.save({
    id: `20260917-1200-${String(100 + i)}`,
    app: '腾讯会议',
    title,
    startedAt: Date.now() - i * 60000,
    endedAt: Date.now() - i * 60000 + 60000,
    durationMs: 60000,
    segments: [{ at: Date.now(), text: transcript, source: 'loopback' }],
    transcript,
    summary: minutes.parseSummary(`## 主题\n${title}`),
    stats: { segCount: 1, chars: transcript.length, source: '系统声音' },
    savedAt: Date.now()
  });

  for (let i = 0; i < 8; i++) mk(i, i < 6 ? `每周同步 ${i}` : `临时沟通 ${i}`, i === 7 ? '聊到了服务器扩容' : '过一下排期');

  const handler = ipcHandlers.get('meeting:search');
  ok(typeof handler === 'function', '★ 主进程注册了 meeting:search（界面接线的前提）');

  // 默认 limit：AI 那条工具路只要 5 条，界面这条要能一次看更多
  const byDefault = await handler({}, '同步');
  eq(byDefault.length, 6, '★ 默认上限（20）足够界面一次看全匹配项 —— 只有 5 条会让人以为「只有 5 份」');
  eq((await handler({}, '同步', 3)).length, 3, 'limit 能透传到检索实现');
  eq((await handler({}, '同步', 999)).length, 6, 'limit 超过总匹配数时给全部');
  eq((await handler({}, '完全不相关的东西')).length, 0, '搜不到就是空');
  ok((await handler({}, '')).length > 0, '空关键词给最近的几条（不是空列表）');
  eq((await handler({}, '扩容')).length, 1, '关键词能命中转写正文（不只标题）');
  for (let i = 0; i < 8; i++) minutes.remove(`20260917-1200-${String(100 + i)}`);

  // —— 结构锁：会议 API 实现了就必须有界面入口 ——
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf-8');
  const rendererFiles = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|html)$/.test(e.name)) rendererFiles.push(p);
    }
  };
  walk(path.join(ROOT, 'src', 'renderer'));
  const renderer = rendererFiles.map((f) => fs.readFileSync(f, 'utf-8')).join('\n').replace(/\s+/g, '');

  const meetingApis = (preload.match(/^\s{2}(meeting[A-Z]\w*)\s*:\s*\(/gm) || []).map((s) => s.trim().split(':')[0]);
  ok(meetingApis.length >= 8, '从 preload 里解析出的会议 API 太少 —— 解析失灵时下面会在空集上假绿', meetingApis.join(','));
  // 已知未接线（有意保留，要给界面用就把它从这份名单里删掉）：
  //   meetingGet          取一份纪要的完整记录（含转写），界面目前只用索引行
  //   meetingSnapshotText 取当前正在记录的这一段的转写
  const ALLOWED_DEAD = ['meetingGet', 'meetingSnapshotText'];
  const dead = meetingApis.filter((n) => !ALLOWED_DEAD.includes(n) && !renderer.includes(n));
  eq(dead.join(','), '', '★ 会议 API 实现了却没有任何界面调用方 —— meetingSearch / meetingFolder 都这样躺过（写了没人用）');

  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'panel.html'), 'utf-8');
  const panel = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'panel.js'), 'utf-8');
  ok(html.includes('id="mtSearch"'), '纪要面板有搜索输入框');

  // 只断言「文件里出现过这个名字」是假锁：另一处赋值就能满足它。
  // 这里把列表渲染函数的**函数体**抠出来，在函数体这一层断言 ——
  // 「关键词从状态里读」「检索走主进程那份实现」都必须发生在这个函数里。
  const fnBody = (src, name) => {
    const i = src.indexOf(name);
    if (i < 0) return '';
    const s = src.indexOf('{', i);
    let depth = 0;
    for (let j = s; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(s, j + 1); }
    }
    return '';
  };
  const body = fnBody(panel, 'async function renderMeetingList');
  ok(body.length > 200, '抠到了列表渲染函数体（抠不到时下面会在空串上假绿）');
  ok(body.includes('window.xw.meetingSearch('), '★ 列表渲染调的是主进程的检索实现 —— 界面里不许再写一套关键词匹配');
  ok(body.includes('mtKeyword'), '★ 关键词从状态里读：列表每 5 秒刷新一次，刷新时不能把正在搜的关键词清掉');
  ok(panel.includes('mtSearchHint'), '搜索时的条数与空结果提示都走列表入口');
}

// ================= 汇总 =================
console.log('\n' + '='.repeat(46));
if (fails.length) {
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  if (typeof mlog !== 'undefined' && mlog.length) mlog.slice(-12).forEach((l) => console.log('    · ' + l));
  process.exit(1);
}
console.log(`会议检测与纪要：通过 ${pass} / ${pass}`);
