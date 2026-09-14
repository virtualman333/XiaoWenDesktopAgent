/**
 * 截图 —— 全屏 / 区域框选，保存、复制、或直接丢给小问问答。
 *
 * 流程：
 *   快捷键 / 工具调用 → desktopCapturer 抓屏（原始像素）
 *     → 区域模式：开一个全屏透明窗口铺上截图，主人拖框选
 *     → 按 scaleFactor 裁剪 → 存 PNG → （可选）写入剪贴板 / 打开面板附图
 */
const {
  app, ipcMain, desktopCapturer, screen, BrowserWindow,
  clipboard, nativeImage, globalShortcut, shell
} = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

let getConfig = () => ({});
let notify = () => {};   // 由 main.js 注入：把截图结果推给面板
let selectorWin = null;

// ---------------- 存储目录 ----------------
function saveDir() {
  const cfg = getConfig() || {};
  if (cfg.captureDir) return String(cfg.captureDir);
  try {
    const pic = app.getPath('pictures');
    return path.join(pic, '小问截图');
  } catch (e) {
    return path.join(app.getPath('userData'), 'screenshots');
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------------- 抓屏 ----------------
async function grabDisplay(displayId) {
  const displays = screen.getAllDisplays();
  const cursor = screen.getCursorScreenPoint();
  let target = null;
  if (typeof displayId === 'number') {
    target = displays.find((d) => d.id === displayId) || null;
  }
  if (!target) {
    target = displays.find((d) =>
      cursor.x >= d.bounds.x && cursor.x < d.bounds.x + d.bounds.width &&
      cursor.y >= d.bounds.y && cursor.y < d.bounds.y + d.bounds.height) || screen.getPrimaryDisplay();
  }

  const sf = target.scaleFactor || 1;
  const w = Math.max(1, Math.round(target.bounds.width * sf));
  const h = Math.max(1, Math.round(target.bounds.height * sf));

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: w, height: h }
  });
  if (!sources || !sources.length) throw new Error('没有获取到屏幕画面（可能被系统权限拦截）');

  // display_id 一般是字符串数字；匹配不上就退回第一个
  let src = sources.find((s) => String(s.display_id) === String(target.id));
  if (!src) src = sources[0];

  return { image: src.thumbnail, display: target, scale: sf };
}

async function persist(image) {
  const dir = saveDir();
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `截图_${stamp()}.png`);
  await fsp.writeFile(file, image.toPNG());
  return file;
}

function toDataUrl(image) {
  return image.toDataURL();
}

/** 全屏截图：直接出图 */
async function captureFull({ displayId, silent = false } = {}) {
  const { image, display, scale } = await grabDisplay(displayId);
  const file = await persist(image);
  const size = image.getSize();
  const cfg = getConfig() || {};
  const after = cfg.captureAfter || 'ask';

  if (after !== 'none') clipboard.writeImage(image);

  const payload = {
    ok: true,
    path: file,
    width: Math.round(size.width / scale),
    height: Math.round(size.height / scale),
    display: display.id,
    scale
  };

  if (!silent && after === 'ask') {
    payload.dataUrl = toDataUrl(image);
    notify('capture', payload);
  }
  return payload;
}

/** 区域截图：弹框选窗口，等主人选完 */
function captureRegion({ displayId } = {}) {
  return new Promise(async (resolve) => {
    let ctx;
    try {
      ctx = await grabDisplay(displayId);
    } catch (e) {
      return resolve({ ok: false, error: (e && e.message) || String(e) });
    }

    const d = ctx.display;
    const win = new BrowserWindow({
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      fullscreen: false,
      hasShadow: false,
      focusable: true,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    selectorWin = win;
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.once('ready-to-show', () => { try { win.show(); win.focus(); } catch (e) { /* ignore */ } });

    const cleanup = () => {
      if (selectorWin === win) selectorWin = null;
      try { if (!win.isDestroyed()) win.destroy(); } catch (e) { /* ignore */ }
    };

    const finish = async (rect) => {
      cleanup();
      if (!rect || rect.width < 4 || rect.height < 4) {
        return resolve({ ok: false, error: '已取消截图' });
      }
      try {
        const s = ctx.scale;
        const crop = ctx.image.crop({
          x: Math.round(rect.x * s),
          y: Math.round(rect.y * s),
          width: Math.round(rect.width * s),
          height: Math.round(rect.height * s)
        });
        const file = await persist(crop);
        const cfg = getConfig() || {};
        const after = cfg.captureAfter || 'ask';
        if (after !== 'none') clipboard.writeImage(crop);
        const out = {
          ok: true,
          path: file,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          display: d.id,
          scale: s
        };
        if (after === 'ask') {
          out.dataUrl = toDataUrl(crop);
          notify('capture', out);
        }
        return resolve(out);
      } catch (e) {
        return resolve({ ok: false, error: (e && e.message) || String(e) });
      }
    };

    ipcMain.removeAllListeners('capture:__done');
    ipcMain.removeAllListeners('capture:__init');
    ipcMain.once('capture:__done', (_e, rect) => finish(rect));
    ipcMain.handle('capture:__init', () => ({
      dataUrl: toDataUrl(ctx.image),
      scale: ctx.scale,
      width: d.bounds.width,
      height: d.bounds.height
    }));

    win.on('closed', () => {
      if (selectorWin === win) selectorWin = null;
      ipcMain.removeAllListeners('capture:__done');
      ipcMain.removeHandler('capture:__init');
      resolve({ ok: false, error: '已取消截图' });
    });

    loadRenderer(win, 'capture.html');
  });
}

function loadRenderer(win, file) {
  const dev = !app.isPackaged;
  if (dev) {
    win.loadURL(`http://localhost:5199/${file}`);
    return;
  }
  win.loadFile(path.join(__dirname, '../../dist', file));
}

// ---------------- 快捷键 ----------------
function normalizeAccelerator(hk) {
  const s = String(hk || '').trim();
  return s || 'Alt+Shift+A';
}

function registerShortcuts() {
  const cfg = getConfig() || {};
  try { globalShortcut.unregister('Alt+Shift+A'); } catch (e) { /* ignore */ }
  try { globalShortcut.unregister('Alt+Shift+S'); } catch (e) { /* ignore */ }
  if (cfg.captureEnabled === false) return;

  const region = normalizeAccelerator(cfg.captureRegionHotkey);
  const full = normalizeAccelerator(cfg.captureFullHotkey);
  try { globalShortcut.register(region, () => { captureRegion().catch(() => {}); }); } catch (e) { /* ignore */ }
  try {
    globalShortcut.register(full, () => {
      captureFull().catch((e) => console.error('[capture]', e && e.message));
    });
  } catch (e) { /* ignore */ }
}

// ---------------- IPC ----------------
function register() {
  ipcMain.handle('capture:full', (_e, opts) => captureFull(opts || {}).catch((e) => ({ ok: false, error: (e && e.message) || String(e) })));
  ipcMain.handle('capture:region', (_e, opts) => captureRegion(opts || {}));
  ipcMain.handle('capture:dir', () => saveDir());
  ipcMain.handle('capture:open-dir', () => {
    try { shell.openPath(saveDir()); } catch (e) { /* ignore */ }
    return true;
  });
  ipcMain.handle('capture:read', async (_e, p) => {
    try {
      if (!p || !fs.existsSync(p)) return { ok: false, error: '文件不存在' };
      const b = await fsp.readFile(p);
      const img = nativeImage.createFromBuffer(b);
      return { ok: true, dataUrl: img.toDataURL(), width: img.getSize().width, height: img.getSize().height };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });
}

/** 第 i 块屏幕（1 起）的 display id，给工具调用用 */
function displayIdByIndex(i) {
  const list = screen.getAllDisplays();
  const n = Number(i);
  if (!n) return undefined;
  const d = list[Math.max(0, Math.min(list.length - 1, n - 1))];
  return d ? d.id : undefined;
}

function bindConfig(fn) { getConfig = fn; }
function bindNotify(fn) { notify = fn; }

module.exports = {
  register,
  bindConfig,
  bindNotify,
  registerShortcuts,
  captureFull,
  captureRegion,
  displayIdByIndex,
  saveDir,
  isSelecting: () => !!selectorWin
};
