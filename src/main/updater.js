/**
 * 自动更新 —— 基于 electron-updater，从 GitHub Releases 拉取新版本。
 *
 * 设计：
 *   1) 未安装 electron-updater 或开发模式（未打包）时全部降级为空操作，不影响运行；
 *   2) 状态机 idle → checking → available → downloading → downloaded / error；
 *   3) 所有状态通过 updater:event 广播给每个窗口，界面自己决定怎么展示；
 *   4) 下载完成后不强制重启，等主人点「立即安装」或下次启动时生效。
 */
const { app, ipcMain, BrowserWindow, dialog } = require('electron');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (e) {
  autoUpdater = null;
}
const available = !!autoUpdater;

let getConfig = () => ({});
let bootChecked = false;

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

/** 把 electron-updater 的英文报错翻成人话 */
function friendlyError(err) {
  const msg = String((err && err.message) || err || '未知错误');
  if (/ENOENT|no such file|app-update.yml|404/i.test(msg)) {
    return '发布源里还没有可用的更新包（需在 GitHub Releases 上传新版本）。';
  }
  if (/net::|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network/i.test(msg)) {
    return '连不上更新服务器，请检查网络后重试。';
  }
  if (/code\s*signature|signature/i.test(msg)) {
    return '更新包签名校验失败。';
  }
  return msg.slice(0, 300);
}

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
    setState({
      state: 'downloaded',
      message: `v${info && info.version ? info.version : ''} 已下载完成，重启后生效`,
      version: (info && info.version) || '',
      percent: 100
    });
    // 主人在忙就只弹气泡，不打断；点「立即安装」才重启
    const cfg = getConfig() || {};
    if (cfg.autoUpdateNotify !== false) {
      try {
        dialog.showMessageBox({
          type: 'info',
          title: '小问助手 · 更新就绪',
          message: `新版本 v${(info && info.version) || ''} 已下载完成`,
          detail: '现在重启安装？重启后会自动回到桌面。',
          buttons: ['立即重启安装', '稍后再说'],
          defaultId: 0,
          cancelId: 1
        }).then((r) => {
          if (r && r.response === 0) installNow();
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
  autoUpdater.autoDownload = cfg.autoUpdateSilent !== false; // 默认静默下载，下完再问
  autoUpdater.allowPrerelease = cfg.autoUpdatePrerelease === true;
  autoUpdater.autoInstallOnAppQuit = cfg.autoUpdateInstallOnQuit !== false;
  autoUpdater.disableDifferentialDownload = false;
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

function installNow() {
  if (!configured()) return false;
  try {
    // isSilent=false, forceRunAfter=true：装完立刻拉起新版本
    autoUpdater.quitAndInstall(false, true);
    return true;
  } catch (e) {
    setState({ state: 'error', message: friendlyError(e) });
    return false;
  }
}

function register() {
  bindEvents();

  ipcMain.handle('updater:state', () => getState());
  ipcMain.handle('updater:check', () => checkManual());
  ipcMain.handle('updater:download', () => downloadNow());
  ipcMain.handle('updater:install', () => installNow());
  ipcMain.handle('updater:open-releases', () => {
    try { require('electron').shell.openExternal('https://github.com/virtualman333/XiaoWenDesktopAgent/releases'); } catch (e) { /* ignore */ }
    return true;
  });
}

function bindConfig(fn) { getConfig = fn; }

module.exports = {
  register,
  bindConfig,
  checkOnBoot,
  getState,
  isAvailable: () => available
};
