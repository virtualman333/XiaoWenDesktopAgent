/**
 * 自动更新 —— 基于 electron-updater，从 GitHub Releases 拉取新版本。
 *
 * 设计：
 *   1) 未安装 electron-updater 或开发模式（未打包）时全部降级为空操作，不影响运行；
 *   2) 状态机 idle → checking → available → downloading → downloaded / error；
 *   3) 所有状态通过 updater:event 广播给每个窗口，界面自己决定怎么展示；
 *   4) 下载完成后不强制重启，等主人点「立即安装」或下次启动时生效。
 *
 * 「该怎么决策」全在 `updater-plan.js`（纯函数、零 electron 依赖）：
 * 默认值、四个开关的语义、报错翻译、空闲安装的判据、下完之后走哪条路 —— 都在那边，
 * 因为这个文件第一行就 `require('electron')`，纯 Node 加载不了它，**任何断言都写不进来**。
 * 本文件只负责「接线」：把 electron-updater 的事件接到那些判据上。
 */
const { app, ipcMain, BrowserWindow, dialog, powerMonitor } = require('electron');
const {
  IDLE_POLL_MS,
  afterDownloaded,
  autoUpdaterOptions,
  friendlyError,
  installSilently,
  shouldIdleInstall
} = require('./updater-plan');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (e) {
  autoUpdater = null;
}
const available = !!autoUpdater;

let getConfig = () => ({});
let bootChecked = false;
let pendingVersion = '';    // 已下好、等着装的版本
let idleTimer = null;       // 空闲安装巡检
let installKicked = false;  // 防止重复触发安装
let notify = () => {};      // 由 main.js 注入：轻提示（托盘气泡 / 宠物），不打断主人
function bindNotify(fn) { if (typeof fn === 'function') notify = fn; }
let logLine = () => {};     // 由 main.js 注入：写自己的日志标签，别蹭 jarvis 的
function bindLog(fn) { if (typeof fn === 'function') logLine = fn; }
function log(m) {
  try { logLine('[更新] ' + m); } catch (e) { /* ignore */ }
}

const state = {
  state: 'idle',        // idle | checking | available | downloading | downloaded | error | disabled | unpackaged
  message: '',
  percent: 0,
  version: '',
  currentVersion: '',
  releaseNotes: '',
  releaseDate: '',
  at: 0
};

function broadcast(payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.webContents.send('updater:event', payload); } catch (e) { /* ignore */ }
  }
}

function setState(patch) {
  Object.assign(state, patch, { at: Date.now() });
  broadcast({ ...state });
  return { ...state };
}

function getState() {
  return { ...state, currentVersion: app.getVersion() };
}

/** 把 electron-updater 的英文报错翻成人话 —— 判据在 updater-plan.js，这里只做转发 */

function bindEvents() {
  if (!available) return;

  autoUpdater.on('checking-for-update', () => {
    setState({ state: 'checking', message: '正在检查更新…', percent: 0 });
  });

  autoUpdater.on('update-available', (info) => {
    setState({
      state: 'available',
      message: `发现新版本 ${info && info.version ? info.version : ''}`,
      version: (info && info.version) || '',
      releaseNotes: typeof (info && info.releaseNotes) === 'string' ? info.releaseNotes.slice(0, 2000) : '',
      releaseDate: (info && info.releaseDate) || '',
      percent: 0
    });
  });

  autoUpdater.on('update-not-available', () => {
    setState({ state: 'idle', message: '已经是最新版本了', percent: 0, version: '' });
  });

  autoUpdater.on('download-progress', (p) => {
    const percent = Math.max(0, Math.min(100, Math.round((p && p.percent) || 0)));
    setState({
      state: 'downloading',
      message: `正在下载更新 ${percent}%`,
      percent
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    pendingVersion = (info && info.version) || '';
    const cfg = getConfig() || {};
    // 「下完之后走哪条路」是一个判据，不是一段散在事件回调里的 if —— 见 updater-plan.js
    const plan = afterDownloaded(cfg, pendingVersion);
    setState({
      state: 'downloaded',
      message: plan.message,
      version: pendingVersion,
      percent: 100
    });

    // ⚠ `autoUpdateNotify` 此前只在这段的第一支之外被读，而 `autoUpdateSilentInstall`
    // 默认是 true —— 于是**默认路径下「下载完成后弹窗提醒」这个开关完全不生效**
    // （用户关了照样弹，设置页里还根本没有这个勾选框）。现在两条路都先问它。
    if (plan.silentInstall) {
      // 静默安装：不弹任何对话框（那是最打断人的东西），最多一条轻提示。
      // 安装时机交给「空闲自动安装」或主人主动点 / 退出时 —— 与要不要提醒无关。
      if (plan.lightNotify) {
        try {
          notify(`新版本 v${pendingVersion} 已下好，你手头没事的时候我会自动静默装好并重启。`);
        } catch (e) { /* ignore */ }
      }
      if (plan.startIdleWatch) startIdleWatch();
      return;
    }

    if (plan.askDialog) {
      // 非静默模式：老老实实问一句，主人点「立即」才走带界面的安装
      try {
        dialog.showMessageBox({
          type: 'info',
          title: '小问助手 · 更新就绪',
          message: `新版本 v${pendingVersion} 已下载完成`,
          detail: '现在重启安装？重启后会自动回到桌面。',
          buttons: ['立即重启安装', '稍后再说'],
          defaultId: 0,
          cancelId: 1
        }).then((r) => {
          if (r && r.response === 0) installNow(false);
        }).catch(() => { /* ignore */ });
      } catch (e) { /* ignore */ }
    }
  });

  autoUpdater.on('error', (err) => {
    setState({ state: 'error', message: friendlyError(err), percent: 0 });
  });
}

function configured() {
  if (!available) return false;
  if (!app.isPackaged) return false;
  return true;
}

/** 启动时静默检查一次（受设置开关控制） */
async function checkOnBoot() {
  if (bootChecked) return;
  bootChecked = true;
  const cfg = getConfig() || {};
  if (cfg.autoUpdate === false) {
    setState({ state: 'disabled', message: '自动更新已关闭' });
    return;
  }
  if (!configured()) {
    setState({
      state: 'unpackaged',
      message: available ? '开发模式下不检查更新' : '未安装更新组件（electron-updater）'
    });
    return;
  }
  try {
    applyOptions(cfg);
    await autoUpdater.checkForUpdatesAndNotify().catch(() => { /* 内部已发 error 事件 */ });
  } catch (e) {
    setState({ state: 'error', message: friendlyError(e) });
  }
}

function applyOptions(cfg) {
  // 选项怎么来的在 updater-plan.autoUpdaterOptions（判据可单测），这里只落下去
  Object.assign(autoUpdater, autoUpdaterOptions(cfg));
}

async function checkManual() {
  if (!available) {
    return setState({ state: 'error', message: '未安装更新组件（electron-updater），请重新打包安装。' });
  }
  if (!app.isPackaged) {
    return setState({ state: 'unpackaged', message: '开发模式下不检查更新（打包后的安装包才有更新通道）。' });
  }
  const cfg = getConfig() || {};
  applyOptions(cfg);
  setState({ state: 'checking', message: '正在检查更新…', percent: 0 });
  try {
    const r = await autoUpdater.checkForUpdates();
    if (r && r.updateInfo) {
      // 没有可用更新时 update-not-available 会先触发，这里只兜底
      if (state.state === 'checking') {
        setState({ state: 'idle', message: '已经是最新版本了', percent: 0 });
      }
    }
    return getState();
  } catch (e) {
    return setState({ state: 'error', message: friendlyError(e) });
  }
}

function downloadNow() {
  if (!configured()) return setState({ state: 'error', message: '当前环境不支持下载更新。' });
  setState({ state: 'downloading', message: '开始下载…', percent: 0 });
  autoUpdater.downloadUpdate().catch((e) => setState({ state: 'error', message: friendlyError(e) }));
  return getState();
}

function installNow(silent) {
  if (!configured()) return false;
  const cfg = getConfig() || {};
  // silent 默认跟着设置走：静默安装不弹 NSIS 向导，装完 forceRunAfter 自动拉起。
  // 「显式布尔优先、否则跟设置」这条判据在 updater-plan.installSilently（可单测）。
  const isSilent = installSilently(cfg, silent);
  if (installKicked) return true;
  installKicked = true;
  try {
    log(`开始安装更新（静默=${isSilent}）`);
    autoUpdater.quitAndInstall(isSilent, true);
    // 万一进程没退（更新包其实没就绪之类），20 秒后放开闸门，别把自动安装卡死
    setTimeout(() => { installKicked = false; }, 20000).unref();
    return true;
  } catch (e) {
    installKicked = false;
    setState({ state: 'error', message: friendlyError(e) });
    return false;
  }
}

/**
 * 空闲自动安装：主人在忙的时候（有键鼠输入）绝不重启，
 * 连续 IDLE_NEED 秒没有输入就静默装好并重启 —— 真正「无感」的升级。
 *
 * 判据本身在 `updater-plan.shouldIdleInstall`（可单测）；这里只是把它接到定时器上。
 * `IDLE_NEED_SECONDS` / `IDLE_POLL_MS` 也都来自那边，免得阈值两处各写一个。
 */
function startIdleWatch() {
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    let idle = 0;
    try { idle = powerMonitor.getSystemIdleTime(); } catch (e) { return; }
    if (!shouldIdleInstall({
      cfg: getConfig() || {},
      state: state.state,
      installKicked,
      idleSeconds: idle
    })) return;
    log(`已空闲 ${idle}s，静默安装 v${pendingVersion}`);
    installNow(true);
  }, IDLE_POLL_MS);
  if (idleTimer.unref) idleTimer.unref();
}

function stopIdleWatch() {
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
}

function register() {
  bindEvents();

  ipcMain.handle('updater:state', () => getState());
  ipcMain.handle('updater:check', () => checkManual());
  ipcMain.handle('updater:download', () => downloadNow());
  ipcMain.handle('updater:install', () => installNow(true));
  ipcMain.handle('updater:install-ui', () => installNow(false));
  ipcMain.handle('updater:open-releases', () => {
    try { require('electron').shell.openExternal('https://github.com/virtualman333/XiaoWenDesktopAgent/releases'); } catch (e) { /* ignore */ }
    return true;
  });
}

function bindConfig(fn) { getConfig = fn; }

module.exports = {
  register,
  bindConfig,
  bindNotify,
  bindLog,
  checkOnBoot,
  getState,
  installNow,
  stopIdleWatch,
  isAvailable: () => available
};
