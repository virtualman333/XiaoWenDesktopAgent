const { app, BrowserWindow, ipcMain, globalShortcut, screen, Tray, Menu, nativeImage, shell, dialog, Notification, powerMonitor, clipboard } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Jarvis 扩展能力（工具 / MCP / Skills / 记忆 / 人格 / 开机自启 / 语音合成）
const jarvis = require('./jarvis');
const autostart = require('./jarvis/autostart');
const jstore = require('./jarvis/store');
const promptLib = require('./jarvis/prompt');
// 桌面宠物（QQ 企鹅式互动宠物）
const pet = require('./pet');
// 截图（全屏 / 框选）与自动更新
const capture = require('./capture');
const updater = require('./updater');
// 自动更新的默认值与判据（纯函数、可单测）—— 默认值只此一份，别再往下面那张表里抄一遍
const updaterPlan = require('./updater-plan');
const meeting = require('./meeting');
// 桌面入口规则：悬浮球 ⇄ 宠物 谁上场（纯函数，可单测）
const entry = require('./entry');
// 剪贴板感知：认出「值得问」的复制内容，主动开口（纯函数 + 轮询器，可单测）
const clipSense = require('./clip-sense');
// 配置改了要跟着重载什么 —— 判据与顺序只此一份（纯函数，可单测）
const configReload = require('./config-reload');
// config.json 的读 / 写 / 坏了怎么办 —— 判据只此一份（纯 Node，可单测）
const { createConfigStore } = require('./config-store');
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
  // 人设**不在这里**：它住在 jarvis/store.js 的 persona.json（设置页「人格与记忆」写的那份），
  // 由 jarvis/prompt.js 的 personaSection() 唯一拼装。这个键只是「补充指令」，
  // 会追加在人设之后。默认留空 —— 这里若再写一句人设，就又是「同一件事写两遍」。
  systemPrompt: '',
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
  // ---- 剪贴板感知（复制报错 / 代码 / 链接时主动问一句）----
  // 默认关闭，同上：常驻读剪贴板是隐私敏感行为，交给用户自己决定。
  // 开启后也只会「提示」，不会自动把内容发出去；疑似凭证一律不提示。
  clipSenseEnabled: false,
  // 剪贴板感知的识别规则（改了立即生效，不必重启）。
  // disableKinds 只能关内置类型（error/json/url/code/longtext）；
  // customKinds 用来补自己的世界：公司日志前缀、内部域名、自家框架的栈帧格式。
  // 详见 src/main/clip-sense.js 顶部「可配置规则」一节。
  clipSenseRules: { disableKinds: [], ignorePatterns: [], customKinds: [] },
  wakeWords: ['小问', '小文', '小闻', '小吻'], // 同音字默认一起收录，ASR 常把「问」写成「文/闻」
  wakeSensitivity: 60,            // 0~100，越高越灵敏（也越容易被环境噪声触发）
  wakeSound: true,                // 命中时播放一声提示音
  contextTurns: 10, // 携带的历史轮数
  ballOpacity: 0.92,
  hotkey: 'Alt+Space',
  // ---- 桌面入口：悬浮球 / 宠物，同一时刻只出现一个 ----
  // 'auto'（默认）：宠物开着就让悬浮球退场（宠物完全代替它）；
  // true：两个都显示（把悬浮球当快捷入口留着）；false：永远不显示悬浮球。
  // 注意：宠物关掉时悬浮球一定会回来 —— 桌面上总得留一个能点的入口。
  ballEnabled: 'auto',
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
  // 默认值的**唯一来源**是 src/main/updater-plan.js 的 DEFAULTS（设置页与 updater.js
  // 都从那里对齐）。此前这 7 个键在 main.js / 设置页 / updater.js 三处各写了一遍默认值，
  // 而 config.example.json 里还漏了 autoUpdateSilentInstall 与 autoUpdateInstallWhenIdle
  // —— 照着示例配置抄的用户根本不知道有这两个设置。
  ...updaterPlan.DEFAULTS,
  // ---- 子代理编排（常任务自动分配）----
  orchEnabled: true,             // 开启后复杂任务自动拆分给子代理
  orchMaxTasks: 6,               // 一次最多拆几个子任务
  orchMaxWorkers: 2,             // 同时跑几个子代理
  orchRetry: 1,                  // 单个子任务失败最多重试几次
  orchAutoDelegate: true,        // 判断为「常任务」时自动走编排，不再逐步请示
  orchReview: true,              // 跑完由主代理复核一遍结果（设置页有这个开关）
  // ---- 定时任务 ----
  schedEnabled: true,            // 到点自动执行并播报
  schedConcurrency: 2,           // 同时最多跑几个（1–4，超出排队）；读它的只有 schedule.js 的 maxConcurrency()
  // ---- 会议自动记录（检测会议 / 通话并自动记纪要）----
  // 检测靠三个客观信号：谁占着麦克风/摄像头（Windows 注册表）、进程列表、窗口标题。
  // 详细判定逻辑见 src/main/jarvis/meeting-detect.js。
  meetingEnabled: true,          // 总开关：自动检测会议/视频/语音通话
  meetingAutoRecord: true,       // 检测到就自动开始记录（关闭后只提醒、不录）
  meetingAskFirst: false,        // 更保守：检测到先问一句，点了才开始记
  meetingHint: true,             // 只采到一次信号（可能只是发个语音）时轻提示一下
  meetingPollSec: 5,             // 采样间隔（秒）
  meetingEnterSamples: 2,        // 连续采到几次才算「真的开始开会了」
  meetingExitSec: 90,            // 连续多少秒采不到才算「会议结束」
  meetingSilenceMin: 5,          // 连续多少分钟没人说话就自动收尾（防「客户端没关」）
  meetingMinMinutes: 1,          // 短于这个时长且没识别到内容就不留纪要
  meetingMaxMinutes: 120,        // 单次记录上限（分钟），到点自动收尾
  meetingSegmentMin: 5,          // 识别会话轮换间隔（分钟），防止长连接掉线
  meetingCaptureMic: true,       // 同时采集麦克风（自己的发言）；戴耳机时效果更好
  meetingWatchCam: true,         // 摄像头被占用也算信号（纯视频会议也能识别）
  meetingUnknownApps: false,     // 非白名单应用占用麦克风时也算信号（默认不信，避免误报）
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

const configStore = createConfigStore(CONFIG_DIR, DEFAULT_CONFIG);

/**
 * 读配置。
 *
 * 除了「把默认值和文件里的值合起来」，它还负责一件以前没人管的事：
 * 文件读不出来时**先把原始内容备份一份**，再回落默认值 —— 判据与备份都在
 * `config-store.js` 里（纯 Node，可单测）。这条路径以前是「catch 一下、
 * 无声无息用默认值」，而用户手改的就是这个文件（README 教的就是手改），
 * 于是一次手抖会变成「设置全没了」，而且随手一存就把残骸也覆盖掉。
 */
function loadConfig() {
  const r = configStore.load();
  if (r.state === 'invalid' || r.state === 'not-object') {
    console.warn('[config] 读不出来（%s），已备份为 %s', r.error, r.backupPath || '(备份失败)');
    // loadConfig 会被反复调用，同一份坏文件的备份路径只会有一个 —— 按它去重，
    // 免得通知队列被同一个事件堆满。
    if (!pendingConfigNotice.includes(r.backupPath)) pendingConfigNotice.push(r.backupPath);
  } else if (r.state === 'unreadable') {
    console.warn('[config] 读不动：%s —— 本次不写盘，避免覆盖', r.error);
  } else if (r.unknownKeys.length) {
    console.warn('[config] 不认识的配置项（多半拼错了，不会生效）：%s', r.unknownKeys.join(', '));
  }
  return r.config;
}

function saveConfig(cfg) {
  const r = configStore.save(cfg);
  if (!r.ok) console.error('[config] save failed:', r.error || r.reason);
  return r.ok;
}

const pendingConfigNotice = [];

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
    // 重建时要按当前配置恢复透明度，不然用户调成半透明的一重启就变实心
    try {
      const op = Number(loadConfig().ballOpacity);
      ballWin.setOpacity(Number.isFinite(op) ? Math.min(Math.max(op, 0.2), 1) : 0.92);
    } catch (e) { /* ignore */ }
    ballWin.webContents.send('config:update', sanitizeConfig(loadConfig()));
    broadcastEntryHost();
  });

  ballWin.on('closed', () => {
    ballWin = null;
  });
}

// ---------- 桌面入口：悬浮球 ⇄ 宠物 ----------
//
// 这两个其实是「同一个入口的两种样子」：都能单击聊天、双击语音、右键菜单、
// 拖着走、常驻监听唤醒词。既然功能重叠，同时摆在桌面上就是互相抢地方，
// 所以规则定成「同一时刻只出现一个」：
//
//   宠物开着  → 悬浮球退场（宠物完全代替它）
//   宠物关掉  → 悬浮球回来（桌面上总得留一个能点的东西）
//
// 唤醒监听（那个常驻开麦的模块）跟着宿主走：球不在时由宠物窗口托管，
// 否则用户把球藏了、唤醒词也就哑了。

/** 简短提示：悬浮球和宠物两边都发（它们在同一时刻只有一个在场，发两边最省心） */
function toastBoth(msg) {
  const m = String(msg == null ? '' : msg);
  for (const w of [ballWin, pet.window]) {
    if (w && !w.isDestroyed()) {
      try { w.webContents.send('toast', m); } catch (e) { /* ignore */ }
    }
  }
}

/** 现在该不该显示悬浮球 */
function ballWanted(c = null) {
  return entry.ballWanted(c || loadConfig());
}

/** 唤醒监听的宿主：球在就归球（一直如此，最稳），否则归宠物 */
function entryHost() {
  return entry.entryHost(loadConfig(), !!(ballWin && !ballWin.isDestroyed()));
}

/** 把「谁是宿主」告诉宠物和悬浮球两边 */
function broadcastEntryHost() {
  const host = entryHost();
  const info = { host, ballShown: host === 'ball' };
  try {
    const pw = pet.window;
    if (pw && !pw.isDestroyed()) pw.webContents.send('entry:host', info);
  } catch (e) { /* ignore */ }
  if (ballWin && !ballWin.isDestroyed()) {
    try { ballWin.webContents.send('entry:host', info); } catch (e) { /* ignore */ }
  }
}

/**
 * 让悬浮球的实际存在与否跟配置对齐。
 * 不用 hide() 而是直接销毁：隐藏的窗口里跑语音唤醒会被 Chromium 限流、
 * 麦克风也一直占着，倒不如彻底收掉，需要时再建（一个 96×96 的小窗，代价很低）。
 *
 * 「球在场 / 不在场」只在**状态真的翻转**时记一条日志：syncEntry 会被配置保存、
 * 开关宠物、托盘菜单反复调用，每次都记会把启动日志刷爆。
 */
let lastEntryLog = '';
function syncEntry(reason = '') {
  const want = ballWanted();
  const alive = !!(ballWin && !ballWin.isDestroyed());

  if (want && !alive) {
    createBallWindow();
  } else if (!want && alive) {
    ballWin.destroy();
    ballWin = null;
  }

  const nowAlive = !!(ballWin && !ballWin.isDestroyed());
  const snap = nowAlive ? 'on' : 'off';
  if (snap !== lastEntryLog) {
    lastEntryLog = snap;
    logLine('entry', nowAlive
      ? `显示悬浮球（${reason}）`
      : `悬浮球退场，由宠物接管桌面入口（${reason}）`);
  }
  broadcastEntryHost();
  return { ballShown: nowAlive };
}

/** 悬浮球 / 宠物的当前分工，设置页与宠物菜单都用它 */
function entryStatus() {
  return entry.entryStatus(loadConfig(), !!(ballWin && !ballWin.isDestroyed()));
}

// ---------- 对话面板窗口 ----------
// 面板打开时唤醒监听要让出麦克风：否则 AI 朗读 / 用户对话会被自己的麦克风
// 听见，造成反复误唤醒。面板关闭或隐藏后再恢复。
// 悬浮球不一定是唤醒宿主（宠物开着时就是宠物在听），所以两边都要通知。
function syncWake(paused) {
  const msg = { paused: !!paused };
  try {
    if (ballWin && !ballWin.isDestroyed()) {
      ballWin.webContents.send('wake:sync', msg);
    }
  } catch (e) { /* ignore */ }
  try {
    const pw = pet.window;
    if (pw && !pw.isDestroyed()) pw.webContents.send('wake:sync', msg);
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
      // 悬浮球和宠物是「同一个入口的两种样子」，同一时刻只出一个。
      // 这里用单选把三档策略摊开，免得用户找不到球去哪了。
      label: '🎈 悬浮球',
      submenu: [
        {
          label: '自动（宠物在场时隐藏）',
          type: 'radio',
          checked: entryStatus().mode === 'auto',
          click: () => { config = { ...loadConfig(), ballEnabled: 'auto' }; saveConfig(config); syncEntry('托盘'); }
        },
        {
          label: '总是显示（和宠物并存）',
          type: 'radio',
          checked: loadConfig().ballEnabled === true,
          click: () => { config = { ...loadConfig(), ballEnabled: true }; saveConfig(config); syncEntry('托盘'); }
        },
        {
          label: '不显示（只用宠物）',
          type: 'radio',
          checked: loadConfig().ballEnabled === false,
          click: () => { config = { ...loadConfig(), ballEnabled: false }; saveConfig(config); syncEntry('托盘'); }
        },
        { type: 'separator' },
        {
          label: entryStatus().ballShown ? '把悬浮球藏起来（宠物接手）' : '现在显示悬浮球',
          click: () => {
            if (entryStatus().ballShown) {
              config = { ...loadConfig(), ballEnabled: false };
              saveConfig(config);
              // 关掉球的同时把宠物叫出来，否则桌面上就没入口了
              setPetEnabled(true);
            } else {
              config = { ...loadConfig(), ballEnabled: true };
              saveConfig(config);
              syncEntry('托盘');
            }
          }
        }
      ]
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
        toastBoth('对话历史已清空');
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

// ---------------- 剪贴板感知 ----------------
//
// 复制一段报错 / 代码 / 链接之后，主人多半接着就是想问小问；与其让他再按一次
// 快捷键、再粘一次，不如桌面入口自己先开口。走的是「轻提示」分级，不打断：
// 宠物动一下 + 托盘气泡，另加一条可点击的系统通知，点一下才把面板叫出来。
//
// 三条边界：
//   1. 默认关闭（clipSenseEnabled）—— 常驻读剪贴板属隐私敏感行为，同 wakeEnabled；
//   2. 疑似凭证一律不提示（在 clip-sense.js 里拦）—— 提示就等于把密钥印在横幅上；
//   3. 只提示、不代发。内容填进输入框，发不发仍由主人按 Enter 决定。

let clipWatcher = null;
// 当前生效的识别规则（compileRules 的产物）。只在这里编译一次，
// 提示路径与轮询路径共用同一份 —— 两处各编译一份必然漂移。
let clipRules = clipSense.compileRules(null);

function onClipSuggest(hit, text) {
  try { pet.petAct('work', { text: hit.title }); } catch (e) { /* ignore */ }
  try {
    if (tray && !tray.isDestroyed()) {
      tray.displayBalloon({ icon: getTrayIcon(), title: hit.title, content: hit.preview, noSound: true });
    }
  } catch (e) { /* ignore */ }

  // 系统通知可点击：点一下直接开面板，内容已经带进去了
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title: hit.title, body: hit.preview, silent: true });
      n.on('click', () => {
        try {
          const win = createPanelWindow();
          win.show();
          // 问法在主进程这一侧生成（clip-sense.buildClipQuestion 是唯一来源），
          // 渲染进程只管填 —— 模板不复制到面板里，否则两份写法必然漂移
          const ask = clipSense.buildClipQuestion(hit.kind, text, clipRules);
          const send = () => {
            try {
              win.webContents.send('clip:ask', { kind: hit.kind, text, question: ask.question, hint: ask.hint });
            } catch (e) { /* ignore */ }
          };
          if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
          else send();
        } catch (e) { logLine('clip', '打开面板失败: ' + ((e && e.message) || e)); }
      });
      n.show();
    }
  } catch (e) { /* ignore */ }

  logLine('clip', `[${hit.kind}] ${hit.preview.slice(0, 60)}`);
}

/** 让轮询器的实际运行状态跟配置对齐（启动时、设置改动时都走这里） */
function syncClipSense(reason) {
  try {
    const cfg = loadConfig();
    const on = !!cfg.clipSenseEnabled;
    // 规则编译与开关分开处理：**即使当前是关着的**也先编译一遍，
    // 这样配置写错能立刻在日志里看到，而不是等到主人开开关时才发现「怎么没反应」。
    const rules = clipSense.compileRules(cfg.clipSenseRules);
    if (rules.warnings.length) {
      for (const w of rules.warnings) logLine('clip', `规则配置有问题：${w}`);
    }
    clipRules = rules;
    if (on) {
      if (!clipWatcher) {
        clipWatcher = clipSense.createClipSense({
          readClip: () => clipboard.readText() || '',
          onSuggest: onClipSuggest,
          rules
        });
      } else {
        // 换规则不重建轮询器：重建会丢掉冷却与「上次看过什么」的去重状态
        clipWatcher.setRules(rules);
      }
      if (!clipWatcher.isRunning()) {
        clipWatcher.start();
        logLine('clip', `剪贴板感知已开启（${reason}）`);
      }
    } else if (clipWatcher && clipWatcher.isRunning()) {
      clipWatcher.stop();
      logLine('clip', `剪贴板感知已关闭（${reason}）`);
    }
  } catch (e) {
    logLine('clip', '切换失败: ' + ((e && e.message) || e));
  }
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
    syncEntry('pet-enabled-unchanged');
    return next;
  }
  config = { ...c, petEnabled: next };
  saveConfig(config);
  pet.applyConfig(config);
  // 宠物一开一关，桌面入口就换人了：宠物开了球退场，宠物关了球回来
  syncEntry(next ? 'pet-on' : 'pet-off');
  const safe = sanitizeConfig(config);
  [ballWin, panelWin, settingsWin].forEach((w) => {
    if (w && !w.isDestroyed()) w.webContents.send('config:update', safe);
  });
  try {
    const pw = pet.window;
    if (pw && !pw.isDestroyed()) pw.webContents.send('config:update', safe);
  } catch (e) { /* ignore */ }
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
  // ★ 人设只有一份：jarvis/prompt.js 的 personaSection()（即设置页「人格与记忆」）。
  // 渲染层此前会自己拼一条 `{ role:'system', content: cfg.systemPrompt }` 传进来 ——
  // 而 cfg.systemPrompt 在设置页里**根本没有入口**，只存在于 config.json 里。
  // 那条必须丢掉，否则「用户在人格页填的一切」在普通对话路径上全部作废：
  // agentEnabled=false、或者模型不支持函数调用被自动降级（panel.js 的 err.disabled）时会走到这里。
  const { systems: droppedSystems, rest: incoming } = promptLib.splitSystemMessages(messages);
  if (droppedSystems.length) {
    logLine('persona', `chat:stream 丢弃了渲染层传来的 ${droppedSystems.length} 条 system 消息（人设唯一来源：personaPrompt）`);
  }
  const personaText = promptLib.personaSection(jstore, cfg);
  const safeRest = incoming
    .map((m) => ({ ...m, role: ROLE_MAP[m.role] || m.role }))
    .filter((m) => m.role === 'user' || m.role === 'assistant'
      || m.role === 'tool' || m.role === 'function');
  const safeMessages = personaText
    ? [{ role: 'system', content: personaText }, ...safeRest]
    : safeRest;

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

// 配置文件的「现状」：读没读出来、备份在哪、有没有拼错的键。
// 故意只回状态不回配置值 —— 密钥不可能从这里漏出去。
ipcMain.handle('config:health', () => configStore.health());

// 规则文本校验（设置界面里那段 JSON）：不落盘、不碰文件，界面边打字边调。
// 规则知识只在 clip-sense.js 一份，界面不自己实现一遍。
ipcMain.handle('clip:rules-parse', (_e, text) => clipSense.parseRulesText(text));
// 命令面板的「拿一段内容试试」：把界面里那段（可能还没保存的）规则 + 一段内容
// 交给主进程试跑，返回「会不会提示 / 为什么 / 会填进去什么问法」。
// 判定链的知识只在 clip-sense.js 一份，界面不自己实现一遍。
ipcMain.handle('clip:test', (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  try {
    return clipSense.testRules(p.text, p.rulesText);
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), warnings: [] };
  }
});

/**
 * 剪贴板规则的导入 / 导出。
 *
 * 为什么要经过主进程：渲染进程没有 fs，也不该有。所以「选文件 + 读写」放这里，
 * 但**规则是否合法仍由 clip:rules-parse 判定** —— 这里只负责搬运文本，
 * 不重复实现一遍规则知识（否则导入的校验口径会和界面上的摘要是两套）。
 *
 * 导出前先校验一次：导出一份自己都编译不过的规则没有意义，原因留在导出方手里，
 * 导入方只会看到「JSON 语法错误」。
 */
ipcMain.handle('clip:rules-export', async (_e, text) => {
  let exported;
  try {
    exported = clipSense.rulesExportText(text);
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
  if (!exported.ok) return exported;
  try {
    const opts = {
      title: '导出剪贴板识别规则',
      defaultPath: path.join(app.getPath('documents'), clipSense.rulesExportName()),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    };
    const win = BrowserWindow.getFocusedWindow();
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(res.filePath, exported.text, 'utf-8');
    return { ok: true, filePath: res.filePath, empty: exported.empty, warnings: exported.warnings };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle('clip:rules-import', async () => {
  try {
    const opts = {
      title: '导入剪贴板识别规则',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    };
    const win = BrowserWindow.getFocusedWindow();
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true };
    const p = res.filePaths[0];
    const size = fs.statSync(p).size;
    if (size > clipSense.MAX_RULES_FILE_BYTES) {
      return { ok: false, error: `文件太大（${size} 字节）—— 规则文件是手写的，通常只有几 KB，可能选错了文件` };
    }
    // 只把文本拿回来，**不落盘、不改配置**：导入的内容要不要用，由用户在界面上
    // 看过摘要之后再点「保存规则」决定。写配置的路径始终只有 config:set 一条。
    return { ok: true, filePath: p, text: fs.readFileSync(p, 'utf-8') };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

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

  // 热更新：改了什么配置、要跟着重载什么 —— 判据与顺序都在 config-reload.js 那张表里，
  // 这里只负责派发。以前这里是 11 条手写 if，判据写法五种，其中四条用真值判断，
  // 于是「清空快捷键」被当成「没改」：配置里已经空了、界面还提示「已清空」，
  // 系统里那把旧键却还挂着，一直到重启才回落默认。
  for (const action of configReload.planReloads(patch, cur)) {
    // 每个动作各自兜住异常：一个重载坏掉不该把后面几个一起带走
    try {
      if (action === 'hotkeys') {
        registerHotkeys();                       // 空值 → 由 registerHotkeys 归一成默认键
      } else if (action === 'pet-summon-hotkey') {
        setPetSummonHotkey(patch.petSummonHotkey);   // 空值 → 由它自己归一成默认键
      } else if (action === 'capture') {
        capture.registerShortcuts();             // 空键位 → 回落默认框选 / 整屏键
      } else if (action === 'ball-opacity') {
        if (ballWin && !ballWin.isDestroyed()) ballWin.setOpacity(patch.ballOpacity);
      } else if (action === 'meeting') {
        meeting.reload();                        // 开关 / 间隔 / 灵敏度 / 静默时长都要重建采样参数
      } else if (action === 'clip-sense') {
        syncClipSense('设置变更');                // 开着才轮询，关掉立刻停；规则改了热替换
      } else if (action === 'pet') {
        pet.applyConfig(config);                 // 开关 / 动物 / 置顶 / 散步
      } else if (action === 'pet-size') {
        const pw = pet.window;
        if (pw && !pw.isDestroyed()) pet.resize();
      } else if (action === 'pet-opacity') {
        const pw = pet.window;
        if (pw && !pw.isDestroyed()) pw.setOpacity(Math.min(Math.max(patch.petOpacity, 0.25), 1));
      } else if (action === 'entry') {
        syncEntry('config:set');                 // 等宠物窗口状态落定再对齐，免得算错宿主
      }
    } catch (e) {
      console.warn('[config] 重载 %s 失败:', action, e && e.message);
    }
  }

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
    entry: entryStatus(),
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
    {
      // 宠物和球功能完全重叠，同时摆着只互相抢位置 —— 给一个一键换人的入口
      label: '🔄 用宠物代替悬浮球（隐藏它）',
      click: () => {
        setPetEnabled(true);
        config = { ...loadConfig(), ballEnabled: false };
        saveConfig(config);
        syncEntry('球右键菜单');
      }
    },
    { type: 'separator' },
    { label: '把宠物叫回主屏', click: () => { setPetEnabled(true); pet.rescue(); } },
    { label: '召唤宠物到鼠标处', click: () => { setPetEnabled(true); pet.summon(); } },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuiting = true; app.quit(); } }
  ]);
  menu.popup({ window: ballWin });
});

// 桌面入口（宠物 ⇄ 悬浮球）的当前分工，宠物菜单和设置页都要读
ipcMain.handle('entry:state', () => entryStatus());

ipcMain.handle('entry:ball-set', (_e, v) => {
  const mode = v === true || v === false ? v : 'auto';
  config = { ...loadConfig(), ballEnabled: mode };
  saveConfig(config);
  // 「不显示悬浮球」必须保证宠物在场，不然桌面上就什么都不剩了
  if (mode !== true && loadConfig().petEnabled === false) setPetEnabled(true);
  syncEntry('entry:ball-set');
  return entryStatus();
});

// 宠物右键菜单里的「找回悬浮球」：把球拉回来，并把分工改成「两个都要」，
// 免得下次又把球收掉，用户以为按了没用
ipcMain.handle('entry:ball-show', () => {
  config = { ...loadConfig(), ballEnabled: true };
  saveConfig(config);
  syncEntry('entry:ball-show');
  return entryStatus();
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

// 宠物右键菜单里的「退出」：悬浮球不在场时它是唯一顺手的退出入口
ipcMain.handle('app:quit', () => {
  app.isQuiting = true;
  app.quit();
  return true;
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

  // 正在记录会议纪要时，这条识别通道归采集窗口独占。
  // 否则面板一语音提问就会把采集会话顶掉，采集窗口又会立刻重连再把对方顶掉 —— 来回打架。
  try {
    if (meeting.status().recording && !meeting.isRecorderSender(event.sender)) {
      return { ok: false, error: '正在记录会议纪要，语音识别暂时被占用；想语音提问请先结束会议记录' };
    }
  } catch (e) { /* ignore */ }

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
  // 所以这里不只是开面板，还要确保「桌面入口」（宠物或悬浮球，二选一）一定在。
  app.on('second-instance', () => {
    logLine('second-instance', '收到第二次启动请求，确保界面可见');
    // 宠物开着时入口是宠物，别硬把悬浮球拉出来
    if (ballWanted()) {
      if (!ballWin || ballWin.isDestroyed()) {
        createBallWindow();
      } else if (!ballWin.isVisible()) {
        ballWin.show();
      }
    } else {
      try { setPetEnabled(true); } catch (e) { /* ignore */ }
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

    // 桌面入口只出现一个：宠物开着就是宠物，否则是悬浮球
    syncEntry('boot');
    // 托盘单独包一层：托盘建不出来也不该拖垮后面的宠物 / Jarvis 初始化
    try {
      createTray();
    } catch (e) {
      logLine('tray', '托盘创建失败: ' + ((e && e.stack) || e));
    }
    // 启动时发现配置读不出来 → 现在就告诉用户，别让他以为「设置全没了」是自己的错觉。
    // 只提示一次（pendingConfigNotice 在 loadConfig 里按内容指纹去重后才会入队）。
    if (pendingConfigNotice.length) {
      const where = pendingConfigNotice[pendingConfigNotice.length - 1];
      pendingConfigNotice.length = 0;
      const body = where
        ? `config.json 读不出来，原始内容已备份成 ${path.basename(where)}，当前按默认配置运行。`
        : 'config.json 读不出来，而且备份也没写成功 —— 当前按默认配置运行，请不要急着保存设置。';
      try {
        if (Notification.isSupported()) {
          new Notification({ title: '小问助手 · 配置读不出来', body }).show();
        } else if (tray && !tray.isDestroyed()) {
          tray.displayBalloon({ icon: getTrayIcon(), title: '小问助手 · 配置读不出来', content: body });
        }
      } catch (e) { /* 通知失败不影响启动 */ }
      logLine('config', '配置读不出来：' + body);
    }
    // 截图配置要先绑定：registerHotkeys 里注册截图快捷键时会读它
    try {
      capture.bindConfig(() => loadConfig());
      capture.bindNotify(onCaptureNotify);
    } catch (e) { logLine('capture', '初始化失败: ' + (e && e.message)); }
    registerHotkeys();
    // 剪贴板感知（默认关，配置为开才真正起轮询）
    syncClipSense('启动');

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
        log: (m) => logLine('pet', m),
        // 宠物右键菜单里的「隐藏宠物 / 找回悬浮球」也走这套统一开关，
        // 保证「配置 = 实际状态」，重启后不会错乱
        setEnabled: (on) => setPetEnabled(on),
        entryStatus
      });
      logLine('pet', '桌面宠物已加载');
      // 宠物窗口起来了，重新告诉两边：现在谁是桌面入口、谁托管唤醒监听
      broadcastEntryHost();
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

    // ---- 会议自动检测 + 自动记录纪要 ----
    try {
      const minutesDir = path.join(app.getPath('userData'), 'minutes');
      require('./jarvis/minutes').bind({ getDir: () => minutesDir });
      meeting.bind({
        getConfig: () => loadConfig(),
        log: (m) => logLine('meeting', m),
        // 播报复用统一下发通道：宠物气泡 + 系统通知 + 面板卡片
        deliver: onProactive,
        // 摘要复用统一对话出口（默认流式，见 llm.js）
        summarize: async (messages) => {
          const c = loadConfig();
          const res = await llm.collectChat({
            baseUrl: c.apiBaseUrl,
            apiKey: c.apiKey,
            model: c.model,
            messages,
            temperature: 0.2,
            maxTokens: 1600,
            timeoutMs: 90000
          });
          if (!res || res.ok !== true) throw new Error((res && res.error) || '摘要生成失败');
          return res.text || '';
        },
        isAsrBusy: () => !!asrSession
      });
      meeting.start();
      logLine('meeting', '会议自动记录已加载（纪要目录 ' + minutesDir + '）');
    } catch (e) {
      logLine('meeting', '会议模块加载失败: ' + ((e && e.stack) || e));
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
      // 宠物开着时悬浮球是「故意不在的」，别把它又救回来 —— 否则桌面上会突然
      // 冒出两个入口，用户还以为见鬼了。
      if (!ballWanted()) {
        if (ballOk) {
          logLine('watchdog', '悬浮球不该在场（宠物已接管桌面入口），收掉');
          syncEntry('watchdog');
        }
      } else if (!ballOk || !visible) {
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
    // 会议记录：同步落盘（will-quit 里没法 await，只能做同步这一档）
    try { meeting.stop(); meeting.flushSync(); } catch (e) { /* ignore */ }
    try { jarvis.cleanup(); } catch (e) { /* ignore */ }
    // 正常退出也要清标记
    try {
      if (bootFlagFile && fs.existsSync(bootFlagFile)) fs.unlinkSync(bootFlagFile);
    } catch {}
  });
}
