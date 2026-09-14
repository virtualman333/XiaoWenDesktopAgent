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

let getConfigRaw = () => ({});
let cfgOverride = {};   // 设置页「先试后存」用：临时覆盖，试完清空
function getConfig() {
  return { ...(getConfigRaw() || {}), ...cfgOverride };
}
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
/**
 * 曾经只反注册写死的两个默认值（Alt+Shift+A / Alt+Shift+S），
 * 主人改成别的键之后，旧键**依然注册着**，于是会出现「一个截图功能两个快捷键」
 * 甚至「新键没生效、旧键还在」的怪现象。现在把注册过的键都记下来，先全撤再重注册。
 */
let registeredAccels = [];
let hotkeyState = { enabled: true, items: [], at: 0 };

function unregisterCaptureShortcuts() {
  for (const a of registeredAccels) {
    try { globalShortcut.unregister(a); } catch (e) { /* ignore */ }
  }
  registeredAccels = [];
}

/** 注册一个全局快捷键，如实回报结果（不吞异常，也不假装成功） */
function registerOne(accel, handler, label) {
  const item = { label, accel, ok: false, error: '' };
  if (!accel) {
    item.error = '未设置快捷键';
    return item;
  }
  try {
    if (globalShortcut.isRegistered(accel)) {
      // 已经被本程序注册过 —— 撤掉再来，避免自己和自己冲突
      try { globalShortcut.unregister(accel); } catch (e) { /* ignore */ }
    }
    const ok = globalShortcut.register(accel, handler);
    if (ok) {
      item.ok = true;
      registeredAccels.push(accel);
    } else {
      item.error = `「${accel}」可能已被其它程序占用，注册失败`;
    }
  } catch (e) {
    item.error = `「${accel}」不是合法的快捷键（${(e && e.message) || e}）`;
  }
  return item;
}

function normalizeAccelerator(hk, fallback) {
  const s = String(hk == null ? '' : hk).trim();
  return s || fallback;
}

/**
 * 重新注册截图快捷键。
 * @returns {{enabled:boolean, items:Array<{label,accel,ok,error}>}}
 */
function registerShortcuts() {
  unregisterCaptureShortcuts();
  const cfg = getConfig() || {};
  const enabled = cfg.captureEnabled !== false;
  const items = [];

  if (enabled) {
    const region = normalizeAccelerator(cfg.captureRegionHotkey, 'Alt+Shift+A');
    const full = normalizeAccelerator(cfg.captureFullHotkey, 'Alt+Shift+S');

    items.push(registerOne(region, () => { captureRegion().catch(() => {}); }, '框选截图'));
    items.push(registerOne(full, () => {
      captureFull().catch((e) => console.error('[capture]', e && e.message));
    }, '整屏截图'));
  }

  hotkeyState = { enabled, items, at: Date.now() };
  return hotkeyState;
}

/** 最后一次注册结果（设置页展示 / 冲突提示用）—— 深拷贝，外部改不动内部状态 */
function hotkeyStatus() {
  return {
    enabled: !!hotkeyState.enabled,
    at: hotkeyState.at,
    items: (hotkeyState.items || []).map((i) => ({ ...i }))
  };
}

/**
 * 试一下某个快捷键能不能用（设置页「录制」完立刻反馈）。
 * 测完就把试注册的键撤掉，不留副作用。
 */
function probeHotkey(accel) {
  const a = String(accel || '').trim();
  if (!a) return { ok: false, error: '快捷键为空' };
  const mine = registeredAccels.includes(a);
  if (mine) return { ok: true, self: true };
  try {
    if (globalShortcut.isRegistered(a)) {
      return { ok: false, error: `「${a}」已被其它程序占用` };
    }
    const ok = globalShortcut.register(a, () => {});
    if (!ok) return { ok: false, error: `「${a}」无法注册（可能被占用）` };
    globalShortcut.unregister(a);
    return { ok: true };
  } catch (e) {
    // 注册过程抛错也可能留下半注册状态，稳妥起见撤一次
    try { globalShortcut.unregister(a); } catch (e2) { /* ignore */ }
    return { ok: false, error: `「${a}」不是合法的快捷键` };
  }
}

/**
 * 「先试后存」：临时套一层配置再注册一遍，测完立刻丢掉，
 * 这样主人在设置页录完键能马上知道能不能用，而不用担心把坏键写进配置。
 */
function applyOverride(patch = {}) {
  if (patch.region !== undefined) cfgOverride.captureRegionHotkey = String(patch.region || '');
  if (patch.full !== undefined) cfgOverride.captureFullHotkey = String(patch.full || '');
  if (patch.enabled !== undefined) cfgOverride.captureEnabled = patch.enabled !== false;
  const st = registerShortcuts();
  cfgOverride = {};
  return st;
}

// ---------------- IPC ----------------
function register() {
  ipcMain.handle('capture:full', (_e, opts) => captureFull(opts || {}).catch((e) => ({ ok: false, error: (e && e.message) || String(e) })));
  ipcMain.handle('capture:region', (_e, opts) => captureRegion(opts || {}));
  ipcMain.handle('capture:dir', () => saveDir());
  ipcMain.handle('capture:hotkeys', () => hotkeyStatus());
  ipcMain.handle('capture:probe-hotkey', (_e, accel) => probeHotkey(accel));
  ipcMain.handle('capture:set-hotkeys', (_e, patch = {}) => {
    // 只负责「应用并回报结果」，落盘交给主进程的 config:set
    return applyOverride(patch);
  });
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

function bindConfig(fn) { getConfigRaw = fn; }
function bindNotify(fn) { notify = fn; }

module.exports = {
  register,
  bindConfig,
  bindNotify,
  registerShortcuts,
  applyOverride,
  unregisterCaptureShortcuts,
  hotkeyStatus,
  probeHotkey,
  captureFull,
  captureRegion,
  displayIdByIndex,
  saveDir,
  isSelecting: () => !!selectorWin
};
