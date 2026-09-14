const { app, BrowserWindow, ipcMain, globalShortcut, screen, Tray, Menu, nativeImage, shell, dialog, Notification, powerMonitor, clipboard } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Jarvis 扩展能力（工具 / MCP / Skills / 记忆 / 人格 / 开机自启 / 语音合成）
const jarvis = require('./jarvis');
const autostart = require('./jarvis/autostart');
const jstore = require('./jarvis/store');
// 桌面宠物（QQ 企鹅式互动宠物）
const pet = require('./pet');
// 截图（全屏 / 框选）与自动更新
const capture = require('./capture');
const updater = require('./updater');
// 统一对话出口（一律流式；连通性测试 / 编排规划也走这里）
const llm = require('./llm');

const isDev = process.env.NODE_ENV === 'development';
const DEV_URL = 'http://localhost:5199';

// ---------- 尽早决定 GPU 策略（必须在 app ready 之前） ----------
// 有些机器（虚拟机、远程桌面、驱动异常、部分集显）GPU 进程无法启动，
// 会导致程序启动即闪退。这里用「崩溃标记」做自动降级：
//   上次如果在初始化阶段异常退出过 → 本次直接禁用硬件加速。
// 注意：模块顶层 app.getPath 往往还不可用，直接拼 APPDATA 路径，
// 并与 Electron 实际使用的 userData 目录保持一致。
const APP_DIR_NAME = 'xiaowen-assistant';

const FLAG_DIR = (() => {
  try {
    const p = app.getPath('userData');
    if (p) return p;
  } catch {}
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(roaming, APP_DIR_NAME);
})();

function flagPath(name) {
  try {
    if (!fs.existsSync(FLAG_DIR)) fs.mkdirSync(FLAG_DIR, { recursive: true });
    const p = path.join(FLAG_DIR, name);
    console.log('[flag] ' + name + ' -> ' + p);
    return p;
  } catch (e) {
    console.error('[flag] ' + name + ' 失败: ' + e.message);
    return null;
  }
}

// ---------- 清理上次异常退出留下的残留状态 ----------
// Chromium 用 SingletonLock / SingletonCookie / SingletonSocket 做单实例互斥。
// 进程被强杀（任务管理器结束、崩溃、断电）时这些文件会残留，
// 下一次启动 Chromium 会认为「已有实例在跑」而直接退出 ——
// 现象和本次遇到的完全一致：双击后进程瞬间结束，exit code 0，无任何报错。
//
// 这里只在「上次确实是异常退出」的前提下清理，避免误伤真正在运行的实例。
function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function clearStaleSingletonLocks() {
  try {
    // Chromium 的单实例锁文件。Electron 在 Windows 上用的是 SingletonLock，
    // 部分版本/平台还会用 lockfile，两个都清。
    const LOCK_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];

    // 能解析出 PID 且该进程还活着 → 确有实例在跑，绝不能动。
    const readHolderPid = () => {
      for (const name of LOCK_FILES) {
        const f = path.join(FLAG_DIR, name);
        try {
          if (!fs.existsSync(f)) continue;
          const raw = fs.readFileSync(f, 'utf-8').trim();
          if (!raw) continue; // 空文件无可信信息
          for (const token of raw.split(/[\s,;:_-]+/)) {
            const n = parseInt(token, 10);
            if (Number.isFinite(n) && n > 100 && n < 4_000_000) return n;
          }
        } catch {}
      }
      return 0;
    };

    const holderPid = readHolderPid();
    if (holderPid && isProcessAlive(holderPid)) {
      console.log('[lock] 持有者进程 ' + holderPid + ' 仍在运行，保留锁');
      return { cleaned: false, aliveHolder: true, failed: false };
    }

    let cleaned = 0;
    let failed = 0;
    for (const name of LOCK_FILES) {
      const f = path.join(FLAG_DIR, name);
      try {
        if (fs.existsSync(f)) {
          fs.unlinkSync(f);
          cleaned += 1;
        }
      } catch (e) {
        failed += 1;
        console.error('[lock] 清除 ' + name + ' 失败: ' + e.message);
      }
    }
    if (cleaned) console.log('[lock] 清除了 ' + cleaned + ' 个残留的 Chromium 单实例锁');
    return { cleaned: cleaned > 0, aliveHolder: false, failed: failed > 0 };
  } catch {
    return { cleaned: false, aliveHolder: false, failed: true };
  }
}

// 判断「另一个实例是否真在运行」。
// Electron 的 requestSingleInstanceLock 只看锁文件，进程被强杀后会误判，
// 于是新进程 exit(0) 静默退出 —— 用户看到的就是「双击没反应」。
// 这里用「主进程互斥体」这个独立信号做二次确认，比锁文件可靠。
function probeRunningInstance() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) { settled = true; resolve(v); }
    };
    let child;
    try {
      child = spawn('tasklist', ['/FI', 'IMAGENAME eq 小问助手.exe', '/NH', '/FO', 'CSV'], {
        windowsHide: true
      });
    } catch {
      return done(true); // 探测方式不可用时，保守认为在运行
    }
    let out = '';
    if (child.stdout) child.stdout.on('data', (b) => { out += b.toString('utf-8'); });
    child.on('error', () => done(true));
    child.on('close', () => {
      const n = (out.match(/小问助手\.exe/gi) || []).length;
      done(n > 0);
    });
    setTimeout(() => {
      try { child.kill(); } catch {}
      done(true);
    }, 5000);
  });
}

// ---------------- 渲染模式决定 ----------------
// 默认策略：优先硬件加速；以下任一情况切到软件渲染：
//   1) 用户手动开启「禁用硬件加速」
//   2) 上次启动埋下的标记还在（说明上次没走完初始化就挂了）
//   3) 命令行/环境变量显式要求
//
// 之所以要这么绕，是因为 GPU 进程的崩溃发生在窗口创建阶段，
// 严重时不会有任何界面提示，用户看到的就是「双击没反应 / 闪退」。
const gpuOffFile = flagPath('.gpu-off');
const bootFlagFile = flagPath('.booting');
const crashFlagFile = flagPath('.crash-count');

// 用户手动关闭开关的标记
let gpuDisabledByConfig = false;
try {
  gpuDisabledByConfig = !!(gpuOffFile && fs.existsSync(gpuOffFile));
} catch {}

// 上次是否没走完初始化（标记还在 = 上次是崩溃退出的）
let lastBootCrashed = false;
try {
  lastBootCrashed = !!(bootFlagFile && fs.existsSync(bootFlagFile));
} catch {}

// 连续失败次数，决定降级档位
let crashCount = 0;
try {
  if (crashFlagFile && fs.existsSync(crashFlagFile)) {
    crashCount = parseInt(fs.readFileSync(crashFlagFile, 'utf-8'), 10) || 0;
  }
} catch {}

if (lastBootCrashed) {
  crashCount += 1;
  // 注意：某些受限环境下文件写入可能被拦截，失败也不影响本次降级
  try {
    if (crashFlagFile) fs.writeFileSync(crashFlagFile, String(crashCount), 'utf-8');
  } catch {}
}

const cliDisable = process.argv.includes('--disable-gpu');
const cliEnable = process.argv.includes('--enable-gpu');
const envDisable = process.env.XIAOWEN_DISABLE_GPU === '1';
const envEnable = process.env.XIAOWEN_DISABLE_GPU === '0';

// 决策顺序（先到先得）：
//   1) 用户手动开关（设置里的「禁用硬件加速」）
//   2) 上次启动没走完初始化
//   3) 命令行 / 环境变量显式指定
//   4) Windows 上默认走软件渲染
//
// 第 4 条是刻意的保守选择：这个应用是常驻小工具，界面元素很少，
// 软件渲染的性能开销可以忽略；但它能避免一部分显卡驱动/虚拟机/
// 远程桌面环境下「双击无反应」的问题。想要硬件加速的用户，
// 可以加 --enable-gpu 启动，或在设置里关掉开关（重启生效）。
const isWindows = process.platform === 'win32';
const defaultSoftware = isWindows;

const softwareMode = cliDisable || envDisable
  ? true
  : (cliEnable || envEnable)
    ? false
    : (gpuDisabledByConfig || lastBootCrashed || defaultSoftware);

if (softwareMode) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  console.log('[gpu] 软件渲染（原因：' +
    (gpuDisabledByConfig ? '用户手动禁用'
      : lastBootCrashed ? '上次启动异常退出'
      : (cliDisable || envDisable) ? '命令行/环境变量指定'
      : '默认使用软件渲染（更稳定）') + '）');
} else {
  console.log('[gpu] 硬件加速');
}

// Windows 上统一关闭 Chromium 的进程沙箱。
// 原因：部分环境（企业安全软件、虚拟机、远程桌面、受限账户）会拦住
// Chromium 的子进程沙箱，导致 GPU 进程启动失败、程序直接退出，
// 用户看到的就是「双击一闪而过」。关闭进程沙箱对这种本机小工具
// 没有实际安全损失（不加载任何远程页面），但能显著提高启动成功率。
if (isWindows) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-setuid-sandbox');
  console.log('[sandbox] 已关闭进程沙箱（提升启动兼容性）');
}

// 埋下本次的启动标记。正常走到 app ready 后会删掉；
// 若进程半路崩掉，标记会留下，下次启动自动升一级降级。
try {
  if (bootFlagFile) fs.writeFileSync(bootFlagFile, String(Date.now()), 'utf-8');
} catch {}

// ---------- 诊断：把异常退出原因写进日志 ----------
// 用户反馈「双击没反应」时，这个日志是唯一的线索来源。
// 注意：不能放进 userData —— Chromium 会扫描/改动该目录里的文件，
// 用户手写的文件可能被它清理掉。日志放在用户目录下独立位置。
const LOG_DIR = path.join(os.homedir(), '.xiaowen');
const LOG_FILE = path.join(LOG_DIR, 'launch.log');
function logLine(tag, msg) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [${tag}] ${msg}\n`, 'utf-8');
  } catch {}
}
try {
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 512 * 1024) fs.unlinkSync(LOG_FILE);
} catch {}

for (const sig of ['uncaughtException', 'unhandledRejection']) {
  process.on(sig, (err) => {
    const detail = (err && err.stack) ? err.stack : String(err);
    logLine('fatal', `${sig}: ${detail}`);
    console.error(`[fatal] ${sig}:`, detail);
  });
}
app.on('render-process-gone', (_e, _wc, details) => {
  logLine('render-gone', JSON.stringify(details));
  console.error('[render-gone]', JSON.stringify(details));
});
app.on('child-process-gone', (_e, details) => {
  logLine('child-gone', JSON.stringify(details));
  console.error('[child-gone]', JSON.stringify(details));
});
app.on('quit', (_e, code) => {
  logLine('quit', `exitCode=${code} softwareMode=${softwareMode} crashCount=${crashCount}`);
});

// 监听 GPU 进程异常：一旦发生就落盘降级标记，
// 这样即使本次没能挽救，下次启动也会自动切到软件渲染。
app.on('child-process-gone', (_e, details) => {
  if (details && details.type === 'GPU') {
    console.error('[gpu] GPU 进程异常退出: ' + details.reason);
    try {
      if (gpuOffFile) fs.writeFileSync(gpuOffFile, '1', 'utf-8');
    } catch {}
  }
});

// ---------- 简易配置存储（不依赖 electron-store，避免打包问题） ----------
const CONFIG_DIR = () => path.join(app.getPath('userData'));
const CONFIG_FILE = () => path.join(CONFIG_DIR(), 'config.json');

const DEFAULT_CONFIG = {
  apiBaseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  systemPrompt: '你是一个常驻桌面的 AI 助手，名字叫「小问」。回答要简洁、直接、口语化，适合语音朗读。除非用户明确要求详细，否则控制在 200 字以内。',
  ttsEnabled: true,
  ttsRate: 0,       // -10 ~ 10
  ttsVolume: 100,
  ttsVoice: '',
  // ---- 语音合成（TTS）----
  // provider: 'web'       Web Speech API / 系统内置语音（零配置、离线）
  //           'dashscope' 阿里云百炼 CosyVoice（高音质，需 Key，可与 ASR 共用）
  //           'openai'    OpenAI 兼容 /v1/audio/speech（自建或中转都行）
  ttsProvider: 'web',
  ttsAutoSpeak: false,        // 回答完成后自动朗读
  ttsApiKey: '',              // 百炼 TTS 专用 Key；留空则复用 asrApiKey
  ttsDashModel: 'cosyvoice-v2',
  ttsDashVoice: 'longxiaochun_v2',
  ttsDashFormat: 'mp3',
  ttsOpenaiBaseUrl: '',       // 留空则复用大模型接口地址
  ttsOpenaiModel: 'tts-1',
  ttsOpenaiVoice: 'alloy',
  ttsOpenaiKey: '',           // 留空则复用大模型 Key
  // ---- Agent（贾维斯模式）----
  agentEnabled: true,         // 开启后模型可调用工具
  agentUseTools: true,        // 内置工具（命令 / 文件 / 进程 / 截图 ...）
  agentUseMcp: true,          // MCP 服务器工具
  agentUseSkills: true,       // Skills
  agentUseMemory: true,       // 长期记忆注入
  // ---- 语音识别（ASR）----
  // provider: 'dashscope' 在线识别（阿里云百炼 paraformer-realtime）
  //           'system'    系统内置（Electron 的 Web Speech API，国内网络通常不可用）
  asrProvider: 'dashscope',
  asrApiKey: '',
  asrModel: 'paraformer-realtime-v2',
  asrLanguage: 'zh',
  asrSilenceMs: 2000, // 说话停止多久后自动结束识别
  // ---- 语音唤醒（说出唤醒词即可免按键唤起）----
  // 两级检测：本地 VAD 常驻监听（零成本）→ 听到人声才开一次 2~3 秒的短识别做关键词确认
  wakeEnabled: false,             // 默认关闭：常驻开麦，交给用户自己决定
  wakeWords: ['小问', '小文', '小闻', '小吻'], // 同音字默认一起收录，ASR 常把「问」写成「文/闻」
  wakeSensitivity: 60,            // 0~100，越高越灵敏（也越容易被环境噪声触发）
  wakeSound: true,                // 命中时播放一声提示音
  contextTurns: 10, // 携带的历史轮数
  ballOpacity: 0.92,
  hotkey: 'Alt+Space',
  // ---- 桌面宠物 ----
  petEnabled: true,      // 是否显示桌面宠物
  petAnimal: 'penguin',  // penguin / cat / panda / rabbit / shiba / frog
  petSize: 120,          // 80 ~ 240
  petOpacity: 1,
  petWalk: false,        // 自动散步
  petTop: true,          // 窗口置顶
  petInteraction: true,  // 心情衰减 / 随机台词
  petAgentLink: true,    // 宠物 × Agent 联动：小问干活时宠物同步演出
  // 宠物被会议共享 / 全屏播放器这类「后出现的置顶窗口」压住时，光靠 alwaysOnTop
  // 是抢不回来的（同组内按最后激活排序）。这几项负责周期性重夺最上层：
  petKeepTop: true,           // 周期性把宠物重新顶到置顶组最前
  petSummonHotkey: 'CommandOrControl+Alt+P', // 一键把宠物叫到鼠标所在屏幕
  // ---- 动态上下文 ----
  ctxWindow: 128000,        // 模型上下文窗口（token），用于算预算
  ctxReplyReserve: 8000,    // 给模型回复预留的 token
  ctxKeepTurns: 8,          // 最近多少轮原文保留，更早的走摘要
  ctxAutoCompress: true,    // 超预算时自动压缩（摘要 + 裁工具输出）
  ctxToolOutputMax: 1200,   // 单条工具输出最多保留多少字符
  // ---- 截图 ----
  captureEnabled: true,          // 开启截图快捷键
  captureRegionHotkey: 'Alt+Shift+A', // 框选截图
  captureFullHotkey: 'Alt+Shift+S',   // 整屏截图
  captureAfter: 'ask',           // ask=存盘+复制+打开面板附图 / save=只存盘 / clipboard=只复制 / none=只存盘不复制
  captureDir: '',                // 留空则用「图片/小问截图」
  // ---- 自动更新 ----
  autoUpdate: true,              // 启动时静默检查
  autoUpdateSilent: true,        // 有更新就后台下载，下完再问
  autoUpdatePrerelease: false,   // 是否接收预发布版本
  autoUpdateInstallOnQuit: true, // 退出时自动应用已下载的更新
  autoUpdateNotify: true,        // 下载完成后弹窗提醒
  autoUpdateSilentInstall: true, // 静默安装：不弹 NSIS 安装界面，装完自动拉起
  autoUpdateInstallWhenIdle: true, // 空闲时自动重启安装（不打断主人干活）
  // ---- 子代理编排（常任务自动分配）----
  orchEnabled: true,             // 开启后复杂任务自动拆分给子代理
  orchMaxTasks: 6,               // 一次最多拆几个子任务
  orchMaxWorkers: 2,             // 同时跑几个子代理
  orchRetry: 1,                  // 单个子任务失败最多重试几次
  orchAutoDelegate: true,        // 判断为「常任务」时自动走编排，不再逐步请示
  // ---- 定时任务 ----
  schedEnabled: true,            // 到点自动执行并播报
  // ---- 主动关注（地震 / 热点）----
  watchEnabled: true,            // 主动关注总开关
  watchQuake: true,              // 地震速报
  watchQuakeMinMag: 5,           // 只看这个震级以上
  watchQuakeRegion: 'cn',        // cn=中国及周边 / global=全球
  watchQuakeInterval: 5,         // 地震轮询间隔（分钟）
  watchHot: true,                // 热搜新上榜提醒
  watchHotInterval: 30,          // 热搜轮询间隔（分钟）
  watchHotTop: 5,                // 只盯前 N 名
  watchWeibo: false,             // 微博热搜（默认关，接口偶尔抽风）
  watchKeywords: '',             // 关键词，逗号分隔；留空=所有新上榜
  watchMute: '23:00-07:00',      // 静默时段，只记录不播报
  watchPet: true,                // 让宠物播报
  watchSpeak: false,             // 用语音念出来
  watchOpenPanel: false,         // 自动弹出对话面板
  history: [],
  maxHistory: 200,
  setupDone: false // 是否已完成首次配置引导（新机 clone 后为 false，会弹出引导）
};

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_DIR())) fs.mkdirSync(CONFIG_DIR(), { recursive: true });
    if (!fs.existsSync(CONFIG_FILE())) return { ...DEFAULT_CONFIG };
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf-8'));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch (e) {
    console.error('[config] load failed:', e);
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(cfg) {
  try {
    if (!fs.existsSync(CONFIG_DIR())) fs.mkdirSync(CONFIG_DIR(), { recursive: true });
    fs.writeFileSync(CONFIG_FILE(), JSON.stringify(cfg, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[config] save failed:', e);
    return false;
  }
}

let config = loadConfig();

// ---------- 窗口引用 ----------
let ballWin = null;
let panelWin = null;
let tray = null;
let settingsWin = null;

// 悬浮球尺寸（含阴影留白）
const BALL_W = 96;
const BALL_H = 96;
const PANEL_W = 460;
const PANEL_H = 640;

// ---------- 悬浮球窗口 ----------
function createBallWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const cfg = loadConfig();

  ballWin = new BrowserWindow({
    width: BALL_W,
    height: BALL_H,
    x: workArea.x + workArea.width - BALL_W - 12,
    y: workArea.y + workArea.height - BALL_H - 12,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    show: false,
    icon: getTrayIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  ballWin.setAlwaysOnTop(true, 'screen-saver');
  ballWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  loadRenderer(ballWin, 'ball.html');

  ballWin.once('ready-to-show', () => {
    ballWin.show();
    ballWin.webContents.send('config:update', sanitizeConfig(cfg));
  });

  ballWin.on('closed', () => {
    ballWin = null;
  });
}

// ---------- 对话面板窗口 ----------
// 面板打开时唤醒监听要让出麦克风：否则 AI 朗读 / 用户对话会被自己的麦克风
// 听见，造成反复误唤醒。面板关闭或隐藏后再恢复。
function syncWake(paused) {
  try {
    if (ballWin && !ballWin.isDestroyed()) {
      ballWin.webContents.send('wake:sync', { paused: !!paused });
    }
  } catch (e) { /* ignore */ }
}

function createPanelWindow() {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.show();
    panelWin.focus();
    return panelWin;
  }

  // 计算位置：靠右下角，在悬浮球左侧
  const { workArea } = screen.getPrimaryDisplay();
  let x = workArea.x + workArea.width - PANEL_W - 24;
  let y = workArea.y + workArea.height - PANEL_H - 24;
  if (y < workArea.y) y = workArea.y;

  panelWin = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_H,
    x: Math.max(workArea.x, x),
    y,
    frame: false,
    transparent: false,
    resizable: true,
    minWidth: 360,
    minHeight: 420,
    skipTaskbar: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#ffffff',
    icon: getTrayIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  panelWin.setAlwaysOnTop(true, 'floating');

  loadRenderer(panelWin, 'panel.html');

  panelWin.once('ready-to-show', () => {
    panelWin.show();
    panelWin.webContents.send('config:update', sanitizeConfig(loadConfig()));
  });

  panelWin.on('show', () => syncWake(true));
  panelWin.on('hide', () => syncWake(false));

  panelWin.on('closed', () => {
    panelWin = null;
    syncWake(false);
  });

  return panelWin;
}

// ---------- 设置窗口 ----------
function createSettingsWindow(tab) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    if (tab) {
      try { settingsWin.webContents.send('settings:tab', String(tab)); } catch (e) { /* ignore */ }
    }
    return settingsWin;
  }

  settingsWin = new BrowserWindow({
    width: 620,
    height: 700,
    frame: true,
    resizable: true,
    minimizable: true,
    maximizable: false,
    parent: panelWin && !panelWin.isDestroyed() ? panelWin : undefined,
    modal: false,
    show: false,
    title: '小问助手 · 设置',
    backgroundColor: '#f5f6f8',
    icon: getTrayIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWin.setMenuBarVisibility(false);
  loadRenderer(settingsWin, 'panel.html', '#settings' + (tab ? '/' + String(tab) : ''));

  settingsWin.once('ready-to-show', () => {
    settingsWin.show();
    // 双重保险：页面加载完后，明确告知渲染进程「这是设置页」
    settingsWin.webContents.send('page:mode', 'settings');
    settingsWin.webContents.send('config:update', sanitizeConfig(loadConfig()));
  });

  settingsWin.on('closed', () => {
    settingsWin = null;
  });

  return settingsWin;
}

function loadRenderer(win, file, hash = '') {
  if (isDev) {
    win.loadURL(`${DEV_URL}/${file}${hash}`);
    return;
  }

  const filePath = path.join(__dirname, '../../dist', file);

  if (hash) {
    // 打包后走 file:// 协议。loadFile 的 hash 选项在部分版本下不生效，
    // 所以这里直接手工拼 URL 并用 loadURL，兼容性最好。
    const url = 'file://' + filePath.replace(/\\/g, '/') + hash;
    win.loadURL(url);
  } else {
    win.loadFile(filePath);
  }
}

// ---------- 托盘图标 ----------
// 图标解析单独放在 tray-icon.js（那里有完整的踩坑记录，也方便单测 + 冒烟）：
// 图标必须放在 src/ 下随包发布，且每一档都要校验 isEmpty()，否则
// new Tray(空图) 不会报错，但托盘上什么都看不见 —— 静默失败。
const trayIcon = require('./tray-icon');

// 记录实际用的图标来源，方便自检与设置页展示
let trayIconInfo = { source: '(未加载)', empty: true, size: null, warned: false };

function getTrayIcon() {
  return trayIcon.resolveTrayIcon({ log: (m) => logLine('tray', m) }).image;
}

/** 托盘状态快照（自检 / 设置页 / 日志用） */
function trayDiag() {
  const alive = !!(tray && !tray.isDestroyed());
  let bounds = null;
  if (alive) {
    try { bounds = tray.getBounds(); } catch (e) { bounds = null; }
  }
  return {
    exists: alive,
    source: trayIconInfo.source,
    iconEmpty: trayIconInfo.empty,
    iconSize: trayIconInfo.size,
    // Windows 上 getBounds 对空图标也返回正常矩形，仅作参考
    bounds: bounds ? [bounds.width, bounds.height] : null
  };
}

/** 重建托盘（图标换了 / 托盘崩了 / 用户手动「重新载入托盘」） */
function recreateTray(reason) {
  try {
    if (tray && !tray.isDestroyed()) tray.destroy();
  } catch (e) { /* ignore */ }
  tray = null;
  logLine('tray', '重建托盘：' + (reason || '手动'));
  return createTray();
}

function createTray() {
  const res = trayIcon.resolveTrayIcon({ log: (m) => logLine('tray', m) });
  const empty = !res.image || res.image.isEmpty();
  trayIconInfo = {
    source: res.source,
    empty,
    size: empty ? null : res.image.getSize(),
    warned: false
  };
  if (empty) {
    logLine('tray', '⚠️ 托盘图标是空图！右下角会「看不见图标」。'
      + '请确认 src/assets/tray.ico 存在且随包发布（files 需包含 src/**）。'
      + '候选路径：' + trayIcon.TRAY_ICON_CANDIDATES.join(' | '));
  } else {
    logLine('tray', `托盘图标就绪 source=${res.source} size=${trayIconInfo.size.width}x${trayIconInfo.size.height}`);
  }

  tray = new Tray(trayIcon.iconForTray(res));
  tray.setToolTip('小问助手 · 按 Alt+Space 快捷问答');

  const menu = Menu.buildFromTemplate([
    {
      label: '打开对话面板',
      click: () => createPanelWindow()
    },
    {
      label: '语音问答 (Alt+Space)',
      click: () => triggerVoiceAsk()
    },
    { type: 'separator' },
    {
      label: '🐧 显示桌面宠物',
      type: 'checkbox',
      checked: loadConfig().petEnabled !== false,
      click: (item) => setPetEnabled(item.checked)
    },
    {
      label: '把宠物叫回主屏',
      click: () => { setPetEnabled(true); pet.rescue(); }
    },
    {
      label: '召唤宠物到鼠标处' + (petSummonHotkey ? ` (${petSummonHotkey.replace('CommandOrControl', 'Ctrl')})` : ''),
      click: () => { setPetEnabled(true); pet.summon(); }
    },
    {
      label: '重新载入宠物',
      click: () => pet.reloadPet()
    },
    {
      label: '强制重建宠物窗口',
      click: () => pet.hardRecover('托盘菜单')
    },
    { type: 'separator' },
    {
      label: '设置',
      click: () => createSettingsWindow()
    },
    {
      label: '清空对话历史',
      click: () => {
        config.history = [];
        saveConfig(config);
        if (panelWin && !panelWin.isDestroyed()) {
          panelWin.webContents.send('history:cleared');
        }
        ballWin && !ballWin.isDestroyed() && ballWin.webContents.send('toast', '对话历史已清空');
      }
    },
    { type: 'separator' },
    {
      label: '重新加载界面',
      click: () => {
        if (panelWin && !panelWin.isDestroyed()) panelWin.reload();
        if (ballWin && !ballWin.isDestroyed()) ballWin.reload();
      }
    },
    {
      label: '重新载入托盘图标',
      click: () => recreateTray('菜单')
    },
    {
      label: '退出小问助手',
      click: () => {
        app.isQuiting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(menu);
  tray.on('click', () => {
    createPanelWindow();
  });
  tray.on('double-click', () => {
    createPanelWindow();
  });
}

// ---------- 快捷键 ----------
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const hk = loadConfig().hotkey || 'Alt+Space';
  try {
    const ok = globalShortcut.register(hk, () => triggerVoiceAsk());
    if (!ok) {
      console.warn('[hotkey] 注册失败:', hk);
    }
  } catch (e) {
    console.error('[hotkey] error:', e);
  }

  // 备用：Ctrl+Shift+Space 打开面板
  try {
    globalShortcut.register('CommandOrControl+Shift+Space', () => createPanelWindow());
  } catch (_) {}

  // 「召唤宠物」：一键把宠物叫到鼠标所在的屏幕并顶到最前。
  // 宠物被别的置顶窗口压住、或跑到第二块屏幕上时，这是最快的找回方式。
  const sumHk = String(loadConfig().petSummonHotkey || 'CommandOrControl+Alt+P').trim();
  petSummonHotkey = sumHk;
  if (sumHk && loadConfig().petEnabled !== false) {
    const ok = registerPetSummon(sumHk);
    if (!ok) logLine('pet', `「召唤宠物」快捷键 ${sumHk} 注册失败（可能被其它程序占用）`);
  }

  // 截图快捷键（放在 unregisterAll 之后，否则会被清掉）
  try { capture.registerShortcuts(); } catch (e) { console.error('[capture] hotkey:', e && e.message); }
}

let petSummonHotkey = 'CommandOrControl+Alt+P';

function registerPetSummon(accel) {
  try {
    return globalShortcut.register(accel, () => {
      try { pet.summon(); } catch (e) { /* ignore */ }
    });
  } catch (e) {
    return false;
  }
}

/** 改「召唤宠物」快捷键（设置页用）；返回 {ok, error} */
function setPetSummonHotkey(accel) {
  const next = String(accel || '').trim() || 'CommandOrControl+Alt+P';
  if (petSummonHotkey) {
    try { globalShortcut.unregister(petSummonHotkey); } catch (e) { /* ignore */ }
  }
  petSummonHotkey = '';
  if (next && !registerPetSummon(next)) {
    // 注册失败就退回到默认键，别让主人彻底失联
    const fallback = 'CommandOrControl+Alt+P';
    const ok = fallback === next ? false : registerPetSummon(fallback);
    petSummonHotkey = ok ? fallback : '';
    return { ok: false, error: `快捷键 ${next} 可能被其它程序占用了`, fallback: petSummonHotkey };
  }
  petSummonHotkey = next;
  return { ok: true, hotkey: next };
}

/**
 * 主动播报出口：定时任务的结果、地震速报、热搜新上榜都从这里送到主人面前。
 *
 * 「唤起」是分级的，避免打扰：
 *   轻提示  → 托盘通知 + 宠物气泡（默认）
 *   唤起    → 再弹出对话面板，消息落在会话里
 *   朗读    → 面板用 TTS 念出来（watchSpeak）
 */
function onProactive(payload) {
  const p = { ...(payload || {}) };
  const text = String(p.text || '').trim();
  if (!text) return;
  const title = String(p.title || '小问提醒');
  const kind = String(p.kind || 'notice');
  const phase = String(p.phase || 'done');
  const content = `**${title}**\n\n${text}`;

  // 0) 「先反馈、再给结果」里的回执阶段。
  //    回执要轻：不弹面板、不进历史、不弹系统通知 —— 只让宠物动起来 + 托盘一条静默提示，
  //    免得主人被「收到」和「结果」两条横幅连着打扰。
  if (phase === 'ack' || phase === 'progress') {
    try {
      if (p.pet !== false) pet.petAct('work', { text: title });
    } catch (e) { /* ignore */ }
    try {
      if (tray && !tray.isDestroyed()) {
        tray.displayBalloon({ icon: getTrayIcon(), title, content: text.slice(0, 180), noSound: true });
      }
    } catch (e) { /* ignore */ }
    try {
      if (panelWin && !panelWin.isDestroyed() && !panelWin.webContents.isLoading()) {
        panelWin.webContents.send('proactive:msg', {
          kind, title, text, phase, speak: false, url: '', ts: Date.now()
        });
      }
    } catch (e) { /* ignore */ }
    logLine('proactive', `[${kind}/${phase}] ${title} :: ${text.slice(0, 80)}`);
    return;
  }

  // 1) 会话留痕：面板下次打开还能翻到（也进历史）
  try {
    const s = jstore.getActiveSession();
    if (s && s.id) jstore.appendMessage(s.id, { role: 'assistant', content });
    const cfg2 = loadConfig();
    cfg2.history = cfg2.history || [];
    cfg2.history.push({ role: 'assistant', content, ts: Date.now(), proactive: true });
    if (cfg2.history.length > (cfg2.maxHistory || 200)) {
      cfg2.history = cfg2.history.slice(-cfg2.maxHistory);
    }
    config = cfg2;
    saveConfig(cfg2);
  } catch (e) { /* ignore */ }

  // 2) 面板（要「唤起」就顺带显示出来）
  let win = (panelWin && !panelWin.isDestroyed()) ? panelWin : null;
  if (p.open !== false) {
    try { win = createPanelWindow(); win.show(); } catch (e) { /* ignore */ }
  }
  if (win && !win.isDestroyed()) {
    const send = () => {
      try {
        win.webContents.send('proactive:msg', {
          kind, title, text, speak: !!p.speak, url: p.url || '', ts: Date.now()
        });
      } catch (e) { /* ignore */ }
    };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
    else send();
  }

  // 3) 桌面宠物：先说再说（petAct 的固定台词会覆盖 petSay，所以顺序不能反）
  try {
    if (p.pet !== false) {
      pet.petAct(p.urgent ? 'work' : 'done', { text: title });
      pet.petSay(text.replace(/\n+/g, ' ').slice(0, 40));
    }
  } catch (e) { /* ignore */ }

  // 4) 系统通知（Windows 上就是右下角横幅）
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body: text.slice(0, 180), silent: false }).show();
    } else if (tray && !tray.isDestroyed()) {
      tray.displayBalloon({ icon: getTrayIcon(), title, content: text.slice(0, 180) });
    }
  } catch (e) { /* ignore */ }

  logLine('proactive', `[${kind}] ${title} :: ${text.replace(/\n+/g, ' ').slice(0, 100)}`);
}

/** 截图完成：把结果送到对话面板（顺手把面板打开） */
function onCaptureNotify(_kind, payload) {
  try {
    const p = { ...(payload || {}) };
    // 大图不直接走 IPC，让面板自己按路径读，避免一次性传几 MB 字符串
    if (p.dataUrl && p.dataUrl.length > 3 * 1024 * 1024) {
      delete p.dataUrl;
      p.tooLarge = true;
    }
    const win = createPanelWindow();
    const send = () => {
      try { if (win && !win.isDestroyed()) win.webContents.send('capture:done', p); } catch (e) { /* ignore */ }
    };
    if (win && !win.isDestroyed() && win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', send);
    } else {
      send();
    }
  } catch (e) {
    console.error('[capture] notify:', e && e.message);
  }
}

function triggerVoiceAsk() {
  const win = createPanelWindow();
  const send = () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('voice:start');
      win.show();
      win.focus();
    }
  };
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => setTimeout(send, 300));
  } else {
    setTimeout(send, 120);
  }
}

// ---------- 配置脱敏 ----------
// 通用脱敏：前 6 位 + *** + 后 4 位。短于 12 位的不做前后缀（避免暴露全部内容）。
function maskKey(k) {
  if (!k) return '';
  if (k.length < 12) return '******';
  return k.slice(0, 6) + '***' + k.slice(-4);
}

function sanitizeConfig(cfg) {
  return {
    ...cfg,
    // 大模型 Key
    apiKeyMasked: maskKey(cfg.apiKey),
    apiKey: cfg.apiKey ? '__KEEP__' : '',
    // 语音识别 Key（同样只在主进程保留真值）
    asrApiKeyMasked: maskKey(cfg.asrApiKey),
    asrApiKey: cfg.asrApiKey ? '__KEEP__' : '',
    // 语音合成 Key
    ttsApiKeyMasked: maskKey(cfg.ttsApiKey),
    ttsApiKey: cfg.ttsApiKey ? '__KEEP__' : '',
    ttsOpenaiKeyMasked: maskKey(cfg.ttsOpenaiKey),
    ttsOpenaiKey: cfg.ttsOpenaiKey ? '__KEEP__' : ''
  };
}

// 应用一个「可能被脱敏过」的 Key 补丁。
// 规则：'__KEEP__' / 空 / 含 *** 一律沿用旧值；其余视为新值。
// 返回落盘用的真实值。
function resolveKeyPatch(patchValue, currentValue) {
  if (patchValue === undefined) return currentValue;
  if (patchValue === '__KEEP__') return currentValue;
  if (typeof patchValue !== 'string') return currentValue;
  const k = patchValue.trim();
  if (!k || k.includes('***')) return currentValue;
  return k;
}

// ---------- 大模型请求代理 ----------
// 为什么放在主进程：
//   渲染进程拿不到真实 API Key（config:get 返回的是脱敏后的 '__KEEP__' 占位符），
//   这样 Key 不会暴露在页面上下文 / DevTools 里，更安全。
//   渲染进程只发「消息内容」，由主进程补上 Key、地址、模型并转发。
//
// 返回值统一为 { ok, text?, error? }，避免 IPC 抛异常时丢细节。

function normalizeBaseUrl(base) {
  let u = String(base || '').trim().replace(/\/+$/, '');
  // 用户可能直接粘了完整端点
  u = u.replace(/\/chat\/completions$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

// 把接口返回的错误体转成人能看懂的一句话
function extractErrorText(status, statusText, raw) {
  let detail = '';
  try {
    const j = JSON.parse(raw);
    detail = j?.error?.message || j?.message || j?.error || raw;
  } catch {
    detail = raw || '';
  }
  detail = String(detail).slice(0, 300);
  let hint = '';
  if (status === 401) {
    hint = '（API Key 无效或已过期，请到服务商后台重新生成后填入设置）';
  } else if (status === 402) {
    hint = '（账户余额不足）';
  } else if (status === 403) {
    hint = '（无权限访问该模型，或 Key 被限制）';
  } else if (status === 404) {
    hint = '（接口地址或模型名不对，检查 BaseURL 是否需要带 /v1）';
  } else if (status === 429) {
    hint = '（请求过于频繁或超出配额，稍后再试）';
  }
  return `HTTP ${status}${statusText ? ' ' + statusText : ''}${detail ? ' · ' + detail : ''}${hint}`;
}

// 流式对话：边收边通过 chat:delta 事件推给渲染进程
// 当前进行中的请求（用于「停止」按钮中断）
let activeChatAbort = null;

/**
 * 宠物 × Agent 联动的统一出口。
 * 只在设置里打开「宠物联动」时才演出；宠物窗口没开时 pet.petAct 内部会直接返回。
 */
function petAct(action, opts) {
  try {
    if (loadConfig().petAgentLink === false) return;
    pet.petAct(action, opts);
  } catch (e) { /* 宠物模块不可用也不能影响对话 */ }
}

/**
 * 显示 / 隐藏桌面宠物的**唯一**入口。
 *
 * 以前托盘、悬浮球右键、设置面板各用各的开关：有的只改配置，有的只调
 * pet.togglePet() 而不落盘，于是出现过「配置里是开着的、窗口却是隐藏的」，
 * 用户重启也恢复不了。现在统一走这里：改配置 + 落盘 + 广播，状态永远一致。
 */
function setPetEnabled(on) {
  const next = !!on;
  const c = loadConfig();
  if ((c.petEnabled !== false) === next) {
    // 状态没变也要保证窗口真的在（可能被别处 hide 掉了）
    if (next) pet.applyConfig(c);
    return next;
  }
  config = { ...c, petEnabled: next };
  saveConfig(config);
  pet.applyConfig(config);
  const safe = sanitizeConfig(config);
  [ballWin, panelWin, settingsWin].forEach((w) => {
    if (w && !w.isDestroyed()) w.webContents.send('config:update', safe);
  });
  return next;
}

ipcMain.handle('chat:abort', () => {
  // Agent 模式下的请求也要能中断
  try { jarvis.abortAgent(); } catch (e) { /* ignore */ }
  if (activeChatAbort) {
    try { activeChatAbort.abort(); } catch {}
    activeChatAbort = null;
    return true;
  }
  return false;
});

ipcMain.handle('chat:stream', async (event, { messages } = {}) => {
  const cfg = loadConfig();
  const baseUrl = normalizeBaseUrl(cfg.apiBaseUrl);
  const apiKey = cfg.apiKey;
  const model = cfg.model;

  if (!baseUrl || !model) return { ok: false, error: '请先在设置中填写接口地址与模型名' };
  if (!apiKey) return { ok: false, error: '请先在设置中配置 API Key' };

  const sender = event.sender;
  let full = '';

  // 上一个请求若还在跑，先中断
  if (activeChatAbort) {
    try { activeChatAbort.abort(); } catch {}
  }
  const controller = new AbortController();
  activeChatAbort = controller;

  // 宠物开始「思考」
  petAct('think');

  // 把 'ai' 这类界面内部用的角色名换成接口要求的 'assistant'。
  // 老版本的历史记录里存的是 'ai'，不转换会直接被服务端拒：
  //   HTTP 400 · ai is not one of ['system','assistant','user','tool','function']
  const ROLE_MAP = { ai: 'assistant' };
  const safeMessages = (Array.isArray(messages) ? messages : [])
    .map((m) => ({ ...m, role: ROLE_MAP[m.role] || m.role }))
    .filter((m) => m.role === 'system' || m.role === 'user' || m.role === 'assistant'
      || m.role === 'tool' || m.role === 'function');

  // ---- 动态上下文：普通问答也走同一套压缩，不然长会话一样会把窗口撑爆 ----
  let finalMessages = safeMessages;
  try {
    const ctxmod = require('./jarvis/context');
    const sysMsgs = safeMessages.filter((m) => m.role === 'system');
    const rest = safeMessages.filter((m) => m.role !== 'system');
    if (cfg.ctxAutoCompress === false) {
      finalMessages = safeMessages;
    } else {
      const budget = Math.max(1024,
        (Number(cfg.ctxWindow) || 128000)
          - (Number(cfg.ctxReplyReserve) || 8000)
          - ctxmod.totalTokens(sysMsgs));
      const sessionId = (() => {
        try { const s = jstore.getActiveSession(); return (s && s.id) || null; } catch (e) { return null; }
      })();
      const priorSummary = sessionId ? (jstore.getSessionSummary(sessionId) || '') : '';
      const cres = ctxmod.compress({
        messages: rest,
        budget,
        keepTurns: Number(cfg.ctxKeepTurns) || 8,
        toolOutputMax: Number(cfg.ctxToolOutputMax) || 1200,
        priorSummary
      });
      finalMessages = [...sysMsgs, ...cres.messages];
      try {
        sender && !sender.isDestroyed() && sender.send('chat:context', { ...cres.stats, budget, at: Date.now() });
      } catch (e) { /* ignore */ }
      if (cres.stats.compressed) {
        logLine('ctx', `上下文压缩：${cres.stats.beforeTokens} → ${cres.stats.afterTokens} token`
          + `（预算 ${budget}）：${(cres.stats.parts || []).join('；')}`);
      }
    }
  } catch (e) {
    logLine('ctx', '上下文压缩失败，按原样发送: ' + ((e && e.message) || e));
  }

  try {
    const res = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: finalMessages,
        stream: true,
        temperature: 0.7
      }),
      signal: controller.signal
    });

    if (!res.ok || !res.body) {
      const raw = await res.text().catch(() => '');
      petAct('error');
      return { ok: false, error: extractErrorText(res.status, res.statusText, raw) };
    }

    // Node 的 fetch 返回 Web ReadableStream，做 SSE 逐行解析
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content
            || json?.choices?.[0]?.message?.content
            || '';
          if (delta) {
            full += delta;
            if (!sender.isDestroyed()) sender.send('chat:delta', delta);
          }
        } catch {
          // 忽略无法解析的分片
        }
      }
    }
    petAct('done');
    return { ok: true, text: full };
  } catch (e) {
    if (e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || e)))) {
      petAct('idle');
      return { ok: false, aborted: true, error: '已停止' };
    }
    petAct('error');
    const m = String(e && e.message || e);
    const hint = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)
      ? '（域名解析失败，检查接口地址是否写错、或本机网络/DNS 是否正常）'
      : /ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket hang up/i.test(m)
        ? '（连接不上服务器，检查网络、代理，或该地址是否需要代理才能访问）'
        : /certificate|SSL|TLS/i.test(m)
          ? '（证书校验失败，可能是代理软件拦截了 HTTPS）'
          : '';
    return { ok: false, error: m + hint };
  } finally {
    if (activeChatAbort === controller) activeChatAbort = null;
  }
});

// 测试连接：同样在主进程发出，Key 不落到页面里
ipcMain.handle('chat:test', async (_e, { baseUrl: rawBase, model: rawModel, apiKey: rawKey } = {}) => {
  const cfg = loadConfig();
  const baseUrl = normalizeBaseUrl(rawBase || cfg.apiBaseUrl);
  const model = (rawModel || cfg.model || '').trim();
  // 允许界面传入「正在输入但还没保存」的 Key；占位符则回退到已保存的
  const key = (!rawKey || rawKey === '__KEEP__') ? cfg.apiKey : String(rawKey).trim();

  if (!baseUrl || !model) return { ok: false, error: '请先填写接口地址与模型名' };
  if (!key) return { ok: false, error: '请先填写 API Key' };
  if (key.includes('***')) return { ok: false, error: 'API Key 里包含 *** —— 请重新粘贴完整的 Key（可能是复制了打码后的文本）' };

  // 一律走流式：不少 OpenAI 兼容网关不支持非流式请求，
  // 直接回 HTTP 400 · Non-stream chat request is currently not supported
  const r = await llm.collectChat({
    baseUrl,
    apiKey: key,
    model,
    messages: [{ role: 'user', content: '你好' }],
    timeoutMs: 30000
  });
  if (!r.ok) return { ok: false, error: r.error || '连接失败，请检查接口地址与 Key' };
  return { ok: true, text: r.text || '' };
});

// ---------- IPC ----------
ipcMain.handle('config:get', () => sanitizeConfig(loadConfig()));

ipcMain.handle('config:set', (_e, patch) => {
  const cur = loadConfig();
  const next = { ...cur, ...patch };
  // 处理 __KEEP__ 占位与打码文本兜底防御：
  // 打码值一旦落盘，后续请求必然鉴权失败，而且从界面上完全看不出问题。
  if ('apiKey' in patch) next.apiKey = resolveKeyPatch(patch.apiKey, cur.apiKey);
  if ('asrApiKey' in patch) next.asrApiKey = resolveKeyPatch(patch.asrApiKey, cur.asrApiKey);
  if ('ttsApiKey' in patch) next.ttsApiKey = resolveKeyPatch(patch.ttsApiKey, cur.ttsApiKey);
  if ('ttsOpenaiKey' in patch) next.ttsOpenaiKey = resolveKeyPatch(patch.ttsOpenaiKey, cur.ttsOpenaiKey);
  config = next;
  saveConfig(config);

  // 热更新快捷键 / 悬浮球透明度
  if (patch.hotkey && patch.hotkey !== cur.hotkey) registerHotkeys();
  if (patch.petSummonHotkey && patch.petSummonHotkey !== cur.petSummonHotkey) {
    setPetSummonHotkey(patch.petSummonHotkey);
  }
  if (patch.captureRegionHotkey && patch.captureRegionHotkey !== cur.captureRegionHotkey) {
    try { capture.registerShortcuts(); } catch (e) { /* ignore */ }
  }
  if (patch.captureFullHotkey && patch.captureFullHotkey !== cur.captureFullHotkey) {
    try { capture.registerShortcuts(); } catch (e) { /* ignore */ }
  }
  if (patch.captureEnabled !== undefined && patch.captureEnabled !== cur.captureEnabled) {
    try { capture.registerShortcuts(); } catch (e) { /* ignore */ }
  }
  if (typeof patch.ballOpacity === 'number') {
    ballWin && !ballWin.isDestroyed() && ballWin.setOpacity(patch.ballOpacity);
  }

  // 桌面宠物联动：开关 / 动物 / 大小 / 透明度 / 置顶 / 散步
  try {
    if ('petEnabled' in patch || 'petTop' in patch || 'petKeepTop' in patch) pet.applyConfig(config);
    const pw = pet.window;
    if (pw && !pw.isDestroyed()) {
      if ('petSize' in patch) pet.resize();
      if (typeof patch.petOpacity === 'number') {
        pw.setOpacity(Math.min(Math.max(patch.petOpacity, 0.25), 1));
      }
    }
  } catch (e) { /* ignore */ }

  // 广播配置
  [ballWin, panelWin, settingsWin].forEach((w) => {
    if (w && !w.isDestroyed()) w.webContents.send('config:update', sanitizeConfig(config));
  });
  try {
    const pw = pet.window;
    if (pw && !pw.isDestroyed()) pw.webContents.send('config:update', sanitizeConfig(config));
  } catch (e) { /* ignore */ }

  return sanitizeConfig(config);
});

// 对话历史
ipcMain.handle('history:get', () => loadConfig().history || []);

ipcMain.handle('history:add', (_e, msg) => {
  const cfg = loadConfig();
  cfg.history = cfg.history || [];
  cfg.history.push({ ...msg, ts: Date.now() });
  if (cfg.history.length > (cfg.maxHistory || 200)) {
    cfg.history = cfg.history.slice(-cfg.maxHistory);
  }
  config = cfg;
  saveConfig(cfg);
  return true;
});

ipcMain.handle('history:clear', () => {
  const cfg = loadConfig();
  cfg.history = [];
  config = cfg;
  saveConfig(cfg);
  return true;
});

// 托盘
ipcMain.handle('tray:diag', () => trayDiag());
ipcMain.handle('tray:reload', () => {
  recreateTray('设置页');
  return trayDiag();
});

// 宠物：召唤 / 体检 / 改召唤快捷键 / 重夺最上层
ipcMain.handle('pet:health', () => {
  const d = pet.diag();
  const hints = [];
  if (d.exists !== true) hints.push('窗口不存在（点「重建窗口」）');
  else if (d.visible !== true) hints.push('窗口存在但被隐藏（点「叫回主屏」）');
  if (d.exists && d.onScreen === false) hints.push('窗口在所有屏幕之外（点「叫回主屏」）');
  if (d.exists && d.alwaysOnTop === false) hints.push('当前没有置顶，会被其它窗口盖住（打开「始终最上层」）');
  if (d.exists && d.visible === true && d.onScreen !== false && d.alwaysOnTop === true) {
    hints.push('窗口本身正常。如果屏幕上依然看不到，多半是被会议共享 / 全屏播放器这类置顶窗口压住了，点「重新顶到最上层」即可。');
  }
  return {
    ...d,
    keepTop: loadConfig().petKeepTop !== false,
    summonHotkey: petSummonHotkey || loadConfig().petSummonHotkey || '',
    hints
  };
});
ipcMain.handle('pet:summon-out', () => { setPetEnabled(true); return pet.summon(); });
ipcMain.handle('pet:top-out', () => pet.resyncTop('设置页'));
ipcMain.handle('pet:hard-recover-out', () => pet.hardRecover('设置页'));
ipcMain.handle('pet:summon-hotkey-get', () => petSummonHotkey || loadConfig().petSummonHotkey || '');
ipcMain.handle('pet:summon-hotkey-set', (_e, accel) => {
  const r = setPetSummonHotkey(accel);
  if (r.ok) {
    config = { ...loadConfig(), petSummonHotkey: r.hotkey };
    saveConfig(config);
  }
  return r;
});

// 窗口控制
ipcMain.handle('win:panel-open', () => createPanelWindow());ipcMain.handle('win:panel-open-voice', () => triggerVoiceAsk());
ipcMain.handle('win:panel-hide', () => {
  panelWin && !panelWin.isDestroyed() && panelWin.hide();
});
ipcMain.handle('win:panel-close', () => {
  panelWin && !panelWin.isDestroyed() && panelWin.close();
});
ipcMain.handle('win:settings-open', (_e, tab) => createSettingsWindow(tab));
// 命令面板用：读一眼剪贴板（「把剪贴板记进记忆」）
ipcMain.handle('clip:read', () => {
  try { return { ok: true, text: clipboard.readText() || '' }; } catch (e) { return { ok: false, text: '', error: (e && e.message) || String(e) }; }
});
ipcMain.handle('win:settings-close', () => {
  settingsWin && !settingsWin.isDestroyed() && settingsWin.close();
});

// 悬浮球拖动
ipcMain.handle('ball:drag-move', (_e, { dx, dy }) => {
  if (!ballWin || ballWin.isDestroyed()) return;
  const [x, y] = ballWin.getPosition();
  ballWin.setPosition(x + dx, y + dy);
});

ipcMain.handle('ball:get-position', () => {
  if (!ballWin || ballWin.isDestroyed()) return [0, 0];
  return ballWin.getPosition();
});

// 智能吸附：松手时贴到屏幕边缘
ipcMain.handle('ball:snap', () => {
  if (!ballWin || ballWin.isDestroyed()) return;
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const [x, y] = ballWin.getPosition();
  const [w, h] = ballWin.getSize();
  const cx = x + w / 2;

  let nx = x;
  let ny = y;
  const EDGE = 12;
  const SNAP_THRESHOLD = 60;

  // 左右吸附
  if (Math.abs(x - workArea.x) < SNAP_THRESHOLD) nx = workArea.x + EDGE;
  else if (Math.abs(x + w - (workArea.x + workArea.width)) < SNAP_THRESHOLD) {
    nx = workArea.x + workArea.width - w - EDGE;
  }

  // 上下吸附
  if (Math.abs(y - workArea.y) < SNAP_THRESHOLD) ny = workArea.y + EDGE;
  else if (Math.abs(y + h - (workArea.y + workArea.height)) < SNAP_THRESHOLD) {
    ny = workArea.y + workArea.height - h - EDGE;
  }

  // 边界限制
  nx = Math.min(Math.max(nx, workArea.x), workArea.x + workArea.width - w);
  ny = Math.min(Math.max(ny, workArea.y), workArea.y + workArea.height - h);

  ballWin.setPosition(Math.round(nx), Math.round(ny));
  return true;
});

ipcMain.handle('ball:set-opacity', (_e, val) => {
  if (ballWin && !ballWin.isDestroyed()) ballWin.setOpacity(val);
  return true;
});

ipcMain.handle('ball:show-menu', () => {
  if (!ballWin || ballWin.isDestroyed()) return;
  const petOn = loadConfig().petEnabled !== false;
  const menu = Menu.buildFromTemplate([
    { label: '打开对话面板', click: () => createPanelWindow() },
    { label: '语音问答', click: () => triggerVoiceAsk() },
    { type: 'separator' },
    { label: '设置', click: () => createSettingsWindow() },
    { label: '🐧 显示桌面宠物', type: 'checkbox', checked: petOn, click: () => setPetEnabled(!petOn) },
    { label: '把宠物叫回主屏', click: () => { setPetEnabled(true); pet.rescue(); } },
    { label: '召唤宠物到鼠标处', click: () => { setPetEnabled(true); pet.summon(); } },
    { label: '隐藏悬浮球', click: () => ballWin.hide() },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuiting = true; app.quit(); } }
  ]);
  menu.popup({ window: ballWin });
});

// 外部链接
ipcMain.handle('open:external', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

// 打开日志目录
ipcMain.handle('open:userdata', () => shell.openPath(app.getPath('userData')));

// GPU / 渲染模式
ipcMain.handle('gpu:status', () => ({
  hardwareAcceleration: !softwareMode,
  gpuFeatureStatus: (() => {
    try {
      return app.getGPUFeatureStatus();
    } catch {
      return null;
    }
  })(),
  reason: softwareMode
    ? (lastBootCrashed ? '检测到上次启动异常，已自动降级为软件渲染'
       : gpuDisabledByConfig ? '已手动禁用硬件加速'
       : '命令行/环境变量指定')
    : '正常（硬件加速）'
}));

// 手动切换「禁用硬件加速」——写入标记后需重启生效
ipcMain.handle('gpu:set-disabled', (_e, disabled) => {
  try {
    if (disabled) {
      if (gpuOffFile) fs.writeFileSync(gpuOffFile, '1', 'utf-8');
    } else {
      if (gpuOffFile && fs.existsSync(gpuOffFile)) fs.unlinkSync(gpuOffFile);
    }
    return true;
  } catch (e) {
    console.error('[gpu] write flag failed:', e);
    return false;
  }
});

ipcMain.handle('gpu:restart', () => {
  app.relaunch();
  app.isQuiting = true;
  app.exit(0);
});

// ---------- 语音识别代理（阿里云百炼 paraformer-realtime） ----------
// 为什么放在主进程：
//   1) 与 chat:* 一致 —— 真实 API Key 只留在主进程，渲染进程拿不到；
//   2) 音频帧需要 WebSocket 长连接，主进程持有更稳（窗口刷新不会断流）。
//
// 协议要点（实测通过）：
//   - 连接 wss://dashscope.aliyuncs.com/api-ws/v1/inference/?api_key=<KEY>
//   - 连上后立即发 run-task（JSON 文本帧）
//   - 收到 task-started 后才能发音频；音频为 16kHz 单声道 PCM，直接发二进制帧
//   - 发完音频发 finish-task，服务端回 task-finished
//   - 识别结果走 result-generated 事件，文本在 payload.output.sentence.text
const DASHSCOPE_ASR_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';

// WebSocket 实现来源（重要）：
//   Electron 32 内置的是 Node 20，而全局 WebSocket 要到 Node 22 才默认可用，
//   所以主进程里 typeof WebSocket === 'undefined' —— 必须依赖 ws 包。
//   这里做一次懒加载，优先 ws；万一打包漏了依赖，再退回全局实现（不报错，
//   只是给出可读的提示，而不是让语音功能静默失效）。
let WebSocketCtor = null;
let webSocketSource = '';
(function resolveWebSocket() {
  try {
    const ws = require('ws');
    const Ctor = ws.WebSocket || ws;
    if (typeof Ctor === 'function') {
      WebSocketCtor = Ctor;
      webSocketSource = 'ws';
      return;
    }
  } catch (e) {
    logLine('asr', 'require(ws) 失败: ' + (e && e.code || e && e.message));
  }
  if (typeof globalThis.WebSocket === 'function') {
    WebSocketCtor = globalThis.WebSocket;
    webSocketSource = 'global';
  }
})();

// 统一构造 WebSocket。ws 与浏览器实现的构造签名兼容，
// 但 ws 支持在 options 里传 headers，这里保留扩展位。
function createWebSocket(url) {
  if (!WebSocketCtor) {
    throw new Error('没有可用的 WebSocket 实现（ws 模块缺失），请重新安装依赖后打包');
  }
  return new WebSocketCtor(url);
}

// 当前会话（一次语音问答对应一个）
let asrSession = null;

function asrSend(sender, channel, payload) {
  try {
    if (sender && !sender.isDestroyed()) sender.send(channel, payload);
  } catch {}
}

function asrCleanup(reason) {
  if (!asrSession) return;
  const s = asrSession;
  asrSession = null;
  s.closed = true;
  try {
    if (s.timer) clearInterval(s.timer);
  } catch {}
  try {
    if (s.ws && s.ws.readyState === 1) {
      // 尽量礼貌收尾；失败也无所谓，下面直接 close
      s.ws.send(JSON.stringify({
        header: { action: 'finish-task', task_id: s.taskId, streaming: 'duplex' },
        payload: { input: {} }
      }));
    }
  } catch {}
  try {
    s.ws && s.ws.close();
  } catch {}
  logLine('asr', `会话结束 reason=${reason} 收到${s.frames}帧 bytes=${s.bytes}`);
}

ipcMain.handle('asr:start', async (event, opts = {}) => {
  const cfg = loadConfig();
  const key = (opts && opts.apiKey) ? String(opts.apiKey).trim() : cfg.asrApiKey;
  const model = (opts && opts.model) || cfg.asrModel || 'paraformer-realtime-v2';
  const sampleRate = Number(opts.sampleRate) || 16000;
  const lang = (opts && opts.language) || cfg.asrLanguage || 'zh';

  if (!key) return { ok: false, error: '尚未配置语音识别 API Key，请在设置 → 语音中填写' };
  if (key.includes('***')) return { ok: false, error: '语音识别 Key 里包含 *** —— 请重新粘贴完整的 Key' };
  if (!WebSocketCtor) return { ok: false, error: '当前运行环境缺少 WebSocket 支持，无法使用语音识别' };

  // 上一个会话未清干净时先收掉
  asrCleanup('restart');

  const sender = event.sender;
  const taskId = (() => {
    try { return require('crypto').randomUUID(); } catch {}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  })();

  return await new Promise((resolve) => {
    let settled = false;
    const settle = (v) => {
      if (!settled) { settled = true; resolve(v); }
    };

    let ws;
    try {
      ws = createWebSocket(`${DASHSCOPE_ASR_URL}/?api_key=${encodeURIComponent(key)}`);
    } catch (e) {
      return settle({ ok: false, error: '无法建立语音识别连接：' + (e && e.message) });
    }

    ws.binaryType = 'arraybuffer';

    const session = {
      ws, taskId, sender, model, sampleRate, lang,
      started: false, closed: false, frames: 0, bytes: 0,
      timer: null
    };
    asrSession = session;

    // 握手超时保护
    const handshakeTimer = setTimeout(() => {
      if (!session.started && !session.closed) {
        logLine('asr', '握手超时');
        asrSend(sender, 'asr:error', '连接语音识别服务超时，请检查网络');
        try { ws.close(); } catch {}
        asrCleanup('handshake-timeout');
        settle({ ok: false, error: '连接超时' });
      }
    }, 10000);

    ws.onopen = () => {
      logLine('asr', 'WebSocket 已连接，发送 run-task');
      try {
        ws.send(JSON.stringify({
          header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
          payload: {
            task_group: 'audio',
            task: 'asr',
            function: 'recognition',
            model,
            parameters: {
              format: 'pcm',
              sample_rate: sampleRate,
              language_hints: [lang],
              // 打开心跳：用户停顿期间保持连接不被服务端超时断开
              heartbeat: true,
              // VAD 切句，交互场景延迟更低
              semantic_punctuation_enabled: false,
              punctuation_prediction_enabled: true
            },
            input: {}
          }
        }));
      } catch (e) {
        asrSend(sender, 'asr:error', '发送启动指令失败：' + (e && e.message));
        asrCleanup('send-run-task-failed');
        settle({ ok: false, error: '发送启动指令失败' });
      }
    };

    // 统一取文本帧内容的兼容层：
    //   ws 包的回调签名是 (data, isBinary)，data 直接就是内容；
    //   浏览器/全局实现的回调签名是 (event)，内容在 event.data。
    // 两种都处理，避免依赖来源变化时静默失效。
    const readTextFrame = (payload) => {
      if (typeof payload === 'string') return payload;
      if (payload && typeof payload.data === 'string') return payload.data;
      if (Buffer.isBuffer(payload)) {
        try { return payload.toString('utf-8'); } catch { return ''; }
      }
      return '';
    };

    ws.onmessage = (ev) => {
      const raw = readTextFrame(ev);
      if (!raw) return; // 二进制的下行帧本项目用不到

      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const e = msg && msg.header && msg.header.event;

      if (e === 'task-started') {
        session.started = true;
        clearTimeout(handshakeTimer);
        logLine('asr', 'task-started，可以发送音频');
        asrSend(sender, 'asr:started', { taskId });
        settle({ ok: true, taskId });
        return;
      }

      if (e === 'result-generated') {
        const out = msg.payload && msg.payload.output;
        const sen = out && out.sentence;
        if (!sen) return;
        // 心跳包没有实际文本，直接丢弃
        if (out.heartbeat) return;
        asrSend(sender, 'asr:result', {
          text: sen.text || '',
          isFinal: !!sen.sentence_end,
          beginTime: sen.begin_time,
          endTime: sen.end_time
        });
        return;
      }

      if (e === 'task-finished') {
        logLine('asr', 'task-finished');
        asrSend(sender, 'asr:end', { reason: 'finished' });
        asrCleanup('task-finished');
        return;
      }

      if (e === 'task-failed') {
        const code = (msg.header && msg.header.error_code) || '';
        const detail = (msg.header && msg.header.error_message) || '';
        logLine('asr', `task-failed code=${code} msg=${detail}`);
        let hint = detail || code || '识别失败';
        if (/NO_VALID_AUDIO/i.test(code)) hint = '没有采集到有效音频，请确认麦克风是否被占用或静音';
        else if (/InvalidApiKey|Unauthorized|401/i.test(code + detail)) hint = '语音识别 API Key 无效，请在设置中重新填写';
        else if (/Throttling|429/i.test(code + detail)) hint = '语音识别请求过于频繁，稍后再试';
        asrSend(sender, 'asr:error', hint);
        asrCleanup('task-failed');
        settle({ ok: false, error: hint });
        return;
      }
    };

    ws.onerror = () => {
      logLine('asr', 'WebSocket 出错');
      clearTimeout(handshakeTimer);
      if (!session.started) {
        asrSend(sender, 'asr:error', '无法连接语音识别服务，请检查网络或代理设置');
        settle({ ok: false, error: '连接失败' });
      } else {
        asrSend(sender, 'asr:error', '语音识别连接中断');
      }
      asrCleanup('ws-error');
    };

    ws.onclose = (ev) => {
      clearTimeout(handshakeTimer);
      if (!session.started) {
        asrSend(sender, 'asr:error', `语音识别服务未响应（代码 ${ev && ev.code}）`);
        settle({ ok: false, error: '连接被关闭' });
      } else {
        asrSend(sender, 'asr:end', { reason: 'closed' });
      }
      asrCleanup('ws-close');
    };
  });
});

// 音频帧：渲染进程传来 Int16Array，直接二进制转发
ipcMain.handle('asr:audio', (_e, chunk) => {
  const s = asrSession;
  if (!s || s.closed || !s.started) return false;
  try {
    if (s.ws.readyState !== 1) return false;
    // 统一转成 Buffer 再发。
    // ws 对 ArrayBuffer 也支持，但 Buffer 是最稳的路径（且避免 Node 版本差异）。
    let view;
    if (chunk instanceof ArrayBuffer) view = new Uint8Array(chunk);
    else if (ArrayBuffer.isView(chunk)) view = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    else if (chunk && chunk.buffer instanceof ArrayBuffer) view = new Uint8Array(chunk.buffer);
    else return false;

    // 注意：ws 在收到非 Buffer 的二进制时会以 binary 帧发出，但显式转 Buffer
    // 可以确保「永远走二进制帧」，不会因为类型判断失误变成文本帧。
    const buf = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    s.ws.send(buf, { binary: true });
    s.frames += 1;
    s.bytes += buf.byteLength;
    return true;
  } catch (e) {
    logLine('asr', '发送音频帧失败: ' + (e && e.message));
    return false;
  }
});

// 结束识别：通知服务端把最后一段音频也吐出来
ipcMain.handle('asr:stop', () => {
  if (!asrSession) return false;
  const s = asrSession;
  logLine('asr', '用户结束识别，发送 finish-task');
  try {
    if (s.ws.readyState === 1) {
      s.ws.send(JSON.stringify({
        header: { action: 'finish-task', task_id: s.taskId, streaming: 'duplex' },
        payload: { input: {} }
      }));
      // 等 task-finished 回来收尾；若迟迟不回则强制关掉
      setTimeout(() => { if (asrSession === s) asrCleanup('stop-timeout'); }, 6000);
      return true;
    }
  } catch {}
  asrCleanup('stop-failed');
  return false;
});

// 直接取消（不发 finish-task，立即断）
ipcMain.handle('asr:cancel', () => {
  asrCleanup('cancel');
  return true;
});

// 测试语音识别 Key：只做「握手 + run-task → task-started」这一小步，
// 不发送任何音频，验证完立即取消。廉价且能准确区分「Key 错」和「网络错」。
ipcMain.handle('asr:test', async (_e, opts = {}) => {
  const cfg = loadConfig();
  const key = (opts && opts.apiKey && opts.apiKey !== '__KEEP__') ? String(opts.apiKey).trim() : cfg.asrApiKey;
  const model = (opts && opts.model) || cfg.asrModel || 'paraformer-realtime-v2';

  if (!key) return { ok: false, error: '请先填写语音识别 API Key' };
  if (key.includes('***')) return { ok: false, error: 'Key 里包含 *** —— 请重新粘贴完整的 Key' };
  if (!WebSocketCtor) return { ok: false, error: '当前运行环境缺少 WebSocket 支持（ws 模块未安装）' };

  return await new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    const taskId = (() => {
      try { return require('crypto').randomUUID(); } catch {}
      return 'test-' + Date.now();
    })();

    let ws;
    try {
      ws = createWebSocket(`${DASHSCOPE_ASR_URL}/?api_key=${encodeURIComponent(key)}`);
    } catch (e) {
      return settle({ ok: false, error: '无法建立连接：' + (e && e.message) });
    }
    ws.binaryType = 'arraybuffer';

    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      settle({ ok: false, error: '连接超时（10 秒无响应），请检查网络或代理' });
    }, 10000);

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({
          header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
          payload: {
            task_group: 'audio', task: 'asr', function: 'recognition', model,
            parameters: { format: 'pcm', sample_rate: 16000, language_hints: [cfg.asrLanguage || 'zh'], heartbeat: true },
            input: {}
          }
        }));
      } catch (e) {
        clearTimeout(timer);
        settle({ ok: false, error: '发送指令失败：' + (e && e.message) });
      }
    };

    ws.onmessage = (ev) => {
      const raw = typeof ev === 'string' ? ev
        : (ev && typeof ev.data === 'string') ? ev.data
        : Buffer.isBuffer(ev) ? ev.toString('utf-8') : '';
      if (!raw) return;
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      const e = msg && msg.header && msg.header.event;
      if (e === 'task-started') {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        settle({ ok: true, text: `连接成功 ✓ 模型 ${model}` });
      } else if (e === 'task-failed') {
        clearTimeout(timer);
        const code = (msg.header && msg.header.error_code) || '';
        const detail = (msg.header && msg.header.error_message) || '';
        let hint = detail || code;
        if (/InvalidApiKey|Unauthorized|401/i.test(code + detail)) hint = 'API Key 无效';
        else if (/Model.*not.*(exist|found)|InvalidParameter/i.test(code + detail)) hint = `模型名无效：${model}`;
        else if (/Throttling|429/i.test(code + detail)) hint = '请求过于频繁';
        try { ws.close(); } catch {}
        settle({ ok: false, error: `HTTP 服务端拒绝 · ${hint}` });
      }
    };

    ws.onerror = () => {
      clearTimeout(timer);
      settle({ ok: false, error: '无法连接 dashscope.aliyuncs.com，请检查网络或代理' });
    };
    ws.onclose = () => {
      clearTimeout(timer);
      settle({ ok: false, error: '连接被服务端关闭（可能是 Key 无效或网络受限）' });
    };
  });
});

// 语音识别（Windows 端）：渲染进程用 Web Speech API，
// 这里提供备用：调 PowerShell 做系统级识别（可选扩展点）
ipcMain.handle('speech:is-available', () => {
  return process.platform === 'win32';
});

// ---------- 应用生命周期 ----------
async function startApp() {
  // 先清残留的 Chromium 单实例锁（上次被强杀会留下，导致本次误判为「已有实例」）
  const lockInfo = clearStaleSingletonLocks();

  const gotTheLock = app.requestSingleInstanceLock();
  if (gotTheLock) {
    bootstrapApp();
    return;
  }

  // 没拿到锁。可能是真有实例在跑，也可能是锁文件残留。
  // 用独立信号（主进程是否存在）做二次确认，避免「双击无反应」。
  logLine('lock', '首次取锁失败，开始二次确认（holder=' + JSON.stringify(lockInfo) + '）');
  const running = await probeRunningInstance();
  if (running) {
    logLine('lock', '确认已有实例在运行，本次正常退出');
    app.quit();
    return;
  }

  logLine('lock', '未发现运行中的实例 —— 判定为残留锁，清理后重试');
  clearStaleSingletonLocks();
  const retryLock = app.requestSingleInstanceLock();
  if (retryLock) {
    logLine('lock', '重试取锁成功');
    bootstrapApp();
  } else {
    logLine('lock', '重试仍失败，为避免多开冲突，本次退出（已在日志中记录）');
    app.quit();
  }
}

startApp();

function bootstrapApp() {
  // 用户再次双击图标时走到这里。曾经出现「已有实例但窗口不可见」的情况，
  // 所以这里不只是开面板，还要确保悬浮球一定可见。
  app.on('second-instance', () => {
    logLine('second-instance', '收到第二次启动请求，确保界面可见');
    if (!ballWin || ballWin.isDestroyed()) {
      createBallWindow();
    } else if (!ballWin.isVisible()) {
      ballWin.show();
    }
    createPanelWindow();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('ai.unihub.xiaowen');

    // 走到这里说明初始化成功 —— 清除「启动中」标记与失败计数，
    // 下次启动就不会误判为崩溃。
    try {
      if (bootFlagFile && fs.existsSync(bootFlagFile)) fs.unlinkSync(bootFlagFile);
      if (crashFlagFile && fs.existsSync(crashFlagFile)) fs.unlinkSync(crashFlagFile);
    } catch {}
    logLine('ready', '初始化成功');

    createBallWindow();
    // 托盘单独包一层：托盘建不出来也不该拖垮后面的宠物 / Jarvis 初始化
    try {
      createTray();
    } catch (e) {
      logLine('tray', '托盘创建失败: ' + ((e && e.stack) || e));
    }
    // 截图配置要先绑定：registerHotkeys 里注册截图快捷键时会读它
    try {
      capture.bindConfig(() => loadConfig());
      capture.bindNotify(onCaptureNotify);
    } catch (e) { logLine('capture', '初始化失败: ' + (e && e.message)); }
    registerHotkeys();

    // ---- 新机首次启动：还没配过大模型 Key，直接把面板弹出来做引导 ----
    // 以前 clone 下来不配 Key 打开就是一片空白，用户根本不知道要干什么。
    if (!loadConfig().apiKey && !loadConfig().setupDone) {
      logLine('setup', '检测到首次运行（未配置模型 Key），自动打开面板引导');
      setTimeout(() => {
        try { createPanelWindow(); } catch (e) { logLine('setup', '打开面板失败: ' + (e && e.message)); }
      }, 800);
    }

    // ---- 桌面宠物 ----
    try {
      pet.init({
        loadRenderer,
        getConfig: () => loadConfig(),
        getSanitizedConfig: () => sanitizeConfig(loadConfig()),
        log: (m) => logLine('pet', m)
      });
      logLine('pet', '桌面宠物已加载');
    } catch (e) {
      logLine('pet', '桌面宠物加载失败: ' + (e && e.stack || e));
    }

    // ---- Jarvis 能力（工具 / MCP / Skills / 记忆 / 人格 / 开机自启 / TTS）----
    try {
      // 定时任务 / 主动关注的日志也写进启动日志
      global.__XW_LOG__ = (m) => logLine('jarvis', m);
      jarvis.bindConfig(() => loadConfig());
      // 定时任务结果 / 地震 / 热搜的主动播报出口
      jarvis.bindProactive(onProactive);
      jarvis.registerAll();
      // 开机自启以本地标记为准，避免系统项被清理后失效
      autostart.syncOnBoot();
      jarvis.boot().catch((e) => logLine('jarvis', 'boot 失败: ' + (e && e.message)));
      logLine('jarvis', '模块已加载');
    } catch (e) {
      logLine('jarvis', '模块加载失败: ' + (e && e.stack || e));
    }

    // ---- 截图 ----
    try {
      capture.bindConfig(() => loadConfig());
      capture.bindNotify(onCaptureNotify);
      capture.register();
      logLine('capture', '截图模块已加载');
    } catch (e) {
      logLine('capture', '截图模块加载失败: ' + (e && e.message));
    }

    // ---- 自动更新 ----
    try {
      updater.bindConfig(() => loadConfig());
      updater.bindLog((m) => logLine('updater', m));
      // 更新下好之后不再弹对话框打断主人，只给一个轻提示
      updater.bindNotify((msg) => {
        try { pet.petSay(String(msg).slice(0, 40)); } catch (e) { /* ignore */ }
        try {
          if (Notification.isSupported()) {
            new Notification({ title: '小问助手 · 更新就绪', body: String(msg).slice(0, 180) }).show();
          } else if (tray && !tray.isDestroyed()) {
            tray.displayBalloon({ icon: getTrayIcon(), title: '小问助手 · 更新就绪', content: String(msg).slice(0, 180) });
          }
        } catch (e) { /* ignore */ }
        logLine('updater', String(msg));
      });
      updater.register();
      // 晚一点再查：先把窗口和宠物都拉起来，别让更新检查拖慢启动
      setTimeout(() => updater.checkOnBoot(), 8000);
      logLine('updater', updater.isAvailable() ? '更新模块已加载' : '未安装 electron-updater，跳过');
    } catch (e) {
      logLine('updater', '更新模块加载失败: ' + (e && e.message));
    }

    // 看门狗：确认悬浮球 / 宠物窗口真的建出来了，并且一直老实待在屏幕上。
    // 曾经出现过「主进程活着但窗口不可见」的情况 —— 用户双击新实例时
    // 会拿到单实例锁并静默退出，表现为「怎么点都打不开」。这里做一次自检。
    // 宠物窗口单独盯：透明窗口偶发 ready-to-show 不触发，现象就是「宠物没显示」；
    // 它还可能运行中自己长高、被顶到屏幕外，所以启动查一次之后每 60s 再复查。
    let lastPetSnap = '';
    let petTicks = 0;
    const petWatchdog = () => {
      petTicks++;
      const ballOk = ballWin && !ballWin.isDestroyed();
      const visible = ballOk ? ballWin.isVisible() : false;
      if (!ballOk || !visible) {
        logLine('watchdog', `悬浮球异常 ballOk=${ballOk} visible=${visible}，尝试重建`);
        if (!ballOk) {
          createBallWindow();
          logLine('watchdog', '已重建悬浮球窗口');
        } else {
          ballWin.show();
          logLine('watchdog', '已强制显示悬浮球窗口');
        }
      }

      // ---- 宠物 ----
      try {
        const r = pet.selfCheck();
        // 前几轮一律记（用户反馈「宠物没显示」时，这几行就是证据），
        // 之后只在「动手修了」或「尺寸/可见性变了」时记，免得刷屏
        const snap = r.diag ? `${r.diag.size.join('x')} vis=${r.diag.visible}` : 'none';
        if (r.fixed) {
          logLine('watchdog', `宠物自检：${r.fixed} | ${JSON.stringify(r.diag || {})}`);
        } else if (!r.ok || snap !== lastPetSnap || petTicks <= 5) {
          logLine('watchdog', `宠物状态 ${JSON.stringify(r.diag || {})}`);
        }
        lastPetSnap = snap;
      } catch (e) {
        logLine('watchdog', '宠物自检失败: ' + ((e && e.message) || e));
      }

      // ---- 托盘 ----
      // 托盘图标为空 = 右下角什么都看不见（new Tray 不会报错，纯静默失败）。
      // 这种情况一般是图标资源丢了（例如打包时没带上），重建没用，所以只报警 + 打日志，
      // 让设置页和启动日志都能看出来；顺带把配置的候选路径记下来方便排查。
      try {
        const td = trayDiag();
        if (!td.exists) {
          logLine('watchdog', '托盘不存在，重建');
          recreateTray('看门狗：托盘丢失');
        } else if (td.iconEmpty && !trayIconInfo.warned) {
          trayIconInfo.warned = true;
          logLine('watchdog', '⚠️ 托盘图标为空，右下角会看不到图标。'
            + `线索：source=${td.source}；候选=${trayIcon.TRAY_ICON_CANDIDATES.join(' | ')}`);
        } else if (petTicks <= 5) {
          logLine('watchdog', '托盘状态 ' + JSON.stringify(td));
        }
      } catch (e) {
        logLine('watchdog', '托盘自检失败: ' + ((e && e.message) || e));
      }
    };
    setTimeout(petWatchdog, 6000);
    setInterval(petWatchdog, 60000);

    screen.on('display-metrics-changed', () => {
      // 分辨率变化时把球拉回可见区域
      if (ballWin && !ballWin.isDestroyed()) {
        const { workArea } = screen.getPrimaryDisplay();
        const [x, y] = ballWin.getPosition();
        const nx = Math.min(x, workArea.x + workArea.width - BALL_W);
        const ny = Math.min(y, workArea.y + workArea.height - BALL_H);
        ballWin.setPosition(Math.max(workArea.x, nx), Math.max(workArea.y, ny));
      }
      try { pet.reposition(); } catch (e) { /* ignore */ }
      // 分辨率/缩放变了，置顶组也会被系统重排，顺手重夺一次
      try { pet.resyncTop('display-metrics-changed'); } catch (e) { /* ignore */ }
    });

    // 显示器增删（插拔外接屏 / 投屏）：把宠物挪回可见区域，
    // 否则窗口很容易留在已经不存在的那块屏上 —— 现象正是「宠物没显示」。
    const onDisplaysChanged = (why) => {
      try {
        if (!pet.diag().onScreen) {
          logLine('pet', `显示器变化（${why}）后宠物不在任何屏幕上，拉回主屏`);
          pet.rescue();
        } else {
          pet.resyncTop(why);
        }
      } catch (e) { /* ignore */ }
    };
    screen.on('display-added', () => onDisplaysChanged('display-added'));
    screen.on('display-removed', () => onDisplaysChanged('display-removed'));

    // 休眠唤醒 / 会话解锁：透明 + 软件渲染的窗口在此时有概率「表面坏死」——
    // API 说可见、尺寸位置都对，屏幕上却什么都没有。重建窗口是唯一可靠的解法。
    try {
      powerMonitor.on('resume', () => {
        logLine('pet', '系统从休眠唤醒，重建宠物窗口');
        try { pet.hardRecover('resume'); } catch (e) { /* ignore */ }
      });
      powerMonitor.on('unlock-screen', () => {
        try {
          const d = pet.diag();
          if (!d.exists || d.visible !== true) {
            logLine('pet', '会话解锁后宠物不可见，重建窗口');
            pet.hardRecover('unlock-screen');
          } else {
            pet.resyncTop('unlock-screen');
          }
        } catch (e) { /* ignore */ }
      });
    } catch (e) { /* powerMonitor 在个别环境下不可用 */ }
  });

  app.on('window-all-closed', () => {
    // 常驻托盘，不退出
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    try { updater.stopIdleWatch(); } catch (e) { /* ignore */ }
    // 收掉可能还在跑的语音识别会话，避免 WebSocket 悬挂
    asrCleanup('app-quit');
    try { jarvis.cleanup(); } catch (e) { /* ignore */ }
    // 正常退出也要清标记
    try {
      if (bootFlagFile && fs.existsSync(bootFlagFile)) fs.unlinkSync(bootFlagFile);
    } catch {}
  });
}
