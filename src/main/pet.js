'use strict';
/**
 * 桌面宠物（QQ 企鹅式）
 *
 * 窗口要点：
 *  - frame:false / transparent / skipTaskbar / focusable:false —— 不抢焦点、不进任务栏
 *  - 默认 setIgnoreMouseEvents(true, { forward: true })：整窗鼠标穿透，
 *    但鼠标移动事件仍会转发给渲染进程，渲染层据此在「鼠标进入宠物身体」时
 *    切回 setIgnoreMouseEvents(false) 接管点击/拖拽，离开后再穿透。
 *  - 宠物状态存 userData/jarvis/pet.json（心情 / 饱食 / 等级 / 当前动物 ...）
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const PET_W = 240;
const PET_H_MIN = 80;
const PET_H_MAX = 400;

// 运行期自检参数
const DRIFT_TOLERANCE = 24;   // 宽/高偏离超过这么多像素才算「跑偏」
const FIX_COOLDOWN = 30000;   // 两次纠正之间的最小间隔，别和系统抢
const TRIM_COOLDOWN = 8000;   // 热路径纠偏的最小间隔
const TRIM_LOG_LIMIT = 8;     // 热路径日志最多记这么多条，避免刷屏

/**
 * 改窗口尺寸。
 *
 * 关键坑：`resizable: false` 的窗口，Electron 会把 min/max 尺寸钉死成「当前尺寸」。
 * 于是 setSize 只能变大、不能变小 —— 窗口一旦被撑大（历史版本里真的出现过
 * 高度变成 1500+ 的情况），就再也缩不回来，宠物被顶到屏幕外，看起来就是
 * 「宠物没显示」。所以改尺寸前先把约束清掉。
 */
function applySize(h) {
  if (!petWin || petWin.isDestroyed()) return false;
  try {
    petWin.setMinimumSize(0, 0);
    petWin.setMaximumSize(0, 0);
    petWin.setSize(PET_W, Math.round(h));
    return true;
  } catch (e) {
    log('调整宠物体型失败: ' + ((e && e.message) || e));
    return false;
  }
}

let petWin = null;
let api = null; // { loadRenderer, getConfig, log }

/**
 * 移动宠物窗口。
 *
 * 大坑：在这台机器（Windows + transparent + 软件渲染）上，对宠物窗口调
 * `setPosition()`，每调一次窗口高度就 +1px。散步时渲染层每秒调十几次，
 * 一分钟就能把窗口「长」到六七百像素高，宠物被挤到屏幕上方 ——
 * 用户看到的现象就是「桌面宠物没显示」。
 *
 * 所以位置一律走 `setBounds` 并**显式带上宽高**：尺寸是被绝对指定的，
 * 不会像 setPosition 那样在「当前尺寸」上累加。宽高固定传期望值，
 * 千万别把 `getSize()` 量到的值喂回去 —— 那同样会一次 +1px 地累加。
 */
function moveWindow(x, y) {
  if (!petWin || petWin.isDestroyed()) return false;
  const nx = Math.round(Number(x) || 0);
  const ny = Math.round(Number(y) || 0);
  try {
    const want = petHeight();
    const [cx, cy] = petWin.getPosition();
    const [cw, ch] = petWin.getSize();

    // 位置没动、尺寸也在容差内 → 什么都不用做。
    // 散步时这里每秒会被调十几次，省掉无谓的窗口操作。
    if (cx === nx && cy === ny && Math.abs(ch - want) <= 1 && Math.abs(cw - PET_W) <= 1) return true;

    // 注意：height 必须传「绝对期望值」，不能传当前尺寸。
    // 透明窗口在 Windows 上会有 1px 取整，把量到的尺寸再喂回去会逐次累加
    // （254 → 255 → 256 …），传常量则只在期望值附近 ±1 抖动，不会跑飞。
    petWin.setBounds({ x: nx, y: ny, width: PET_W, height: want });
    return true;
  } catch (e) {
    log('移动宠物失败: ' + ((e && e.message) || e));
    return false;
  }
}

// ---------- 状态文件 ----------
function petStateFile() {
  const dir = path.join(app.getPath('userData'), 'jarvis');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) { /* ignore */ }
  return path.join(dir, 'pet.json');
}

const DEFAULT_PET_STATE = {
  animal: 'penguin',
  mood: 80,
  hunger: 70,
  level: 1,
  exp: 0,
  lastSeen: 0,
  autoWalk: false,
  sleeping: false
};

function readState() {
  try {
    const p = petStateFile();
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return { ...DEFAULT_PET_STATE, ...(raw || {}) };
    }
  } catch (e) { /* ignore */ }
  return { ...DEFAULT_PET_STATE, lastSeen: Date.now() };
}

function writeState(s) {
  try {
    fs.writeFileSync(petStateFile(), JSON.stringify(s || {}, null, 2), 'utf-8');
    return true;
  } catch (e) {
    return false;
  }
}

function cfg() {
  return (api && api.getConfig) ? (api.getConfig() || {}) : {};
}

function log(msg) {
  if (api && api.log) api.log(msg);
}

function petHeight() {
  const size = Number(cfg().petSize) || 120;
  const s = Math.min(Math.max(size, 80), 240);
  return Math.round(s + 130);
}

// ---------- 窗口 ----------
function createPetWindow() {
  if (petWin && !petWin.isDestroyed()) {
    revealPet('already-exists');
    return petWin;
  }

  const { workArea } = screen.getPrimaryDisplay();
  const h = petHeight();

  petWin = new BrowserWindow({
    width: PET_W,
    height: h,
    x: workArea.x + 80,
    y: workArea.y + workArea.height - h - 6,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: false,
    show: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  petWin.setAlwaysOnTop(cfg().petTop !== false, 'floating');
  try {
    petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (e) { /* ignore */ }

  // 关键：默认穿透，但转发鼠标移动给页面，让页面决定何时接管
  petWin.setIgnoreMouseEvents(true, { forward: true });

  api.loadRenderer(petWin, 'pet.html');

  // 三条路各自尝试把窗口显示出来。
  // 只挂 ready-to-show 是不够的：透明 + 软件渲染（本应用在 Windows 上默认走
  // 软件渲染）时，这个事件有概率不触发，结果是「窗口建出来了、渲染层也活着，
  // 但 WS_VISIBLE 一直没置上」——用户看到的就是「宠物没显示」。
  petWin.once('ready-to-show', () => revealPet('ready-to-show'));
  petWin.webContents.once('did-finish-load', () => revealPet('did-finish-load'));
  setTimeout(() => revealPet('fallback-timer'), 1500);

  petWin.on('closed', () => { petWin = null; });

  log('宠物窗口已创建');
  return petWin;
}

/**
 * 确保宠物窗口真的「可见」。
 *
 * 幂等，可重复调用；顺便把被改坏的窗口高度纠正回来
 * （历史上有过窗口尺寸跑偏到几千像素、导致宠物被顶到屏幕外的情况）。
 */
function revealPet(reason = '') {
  if (!petWin || petWin.isDestroyed()) return false;
  try {
    const want = petHeight();
    const [w, h] = petWin.getSize();
    // 只在「明显跑偏」时才纠正：Windows 下 getSize() 会比请求值多几个像素，
    // 卡死相等会变成每次显示都白调一次 setSize。
    if (Math.abs(h - want) > 8 || Math.abs(w - PET_W) > 8) {
      log(`宠物体型修正 ${w}x${h} → ${PET_W}x${want}（${reason}）`);
      applySize(want);
    }
    petWin.setAlwaysOnTop(cfg().petTop !== false, 'floating');
  } catch (e) { /* ignore */ }

  try {
    if (!petWin.isVisible()) petWin.show();
  } catch (e) {
    log('宠物显示失败: ' + ((e && e.message) || e));
    return false;
  }

  // 万一原点跑到屏幕外（多屏切换 / 分辨率变化），拉回来
  try {
    const { workArea } = screen.getPrimaryDisplay();
    const [x, y] = petWin.getPosition();
    const [w, h] = petWin.getSize();
    const inside = x + w > workArea.x && x < workArea.x + workArea.width
      && y + h > workArea.y && y < workArea.y + workArea.height;
    if (!inside) {
      log(`宠物在屏幕外 (${x},${y})，拉回主屏（${reason}）`);
      rescue();
    }
  } catch (e) { /* ignore */ }

  try {
    petWin.webContents.send('config:update', (api.getSanitizedConfig || api.getConfig)());
  } catch (e) { /* ignore */ }

  if (reason) log(`宠物已显示（${reason}）`);
  return true;
}

/** 把宠物叫回主屏右下角并显示 —— 「找不到宠物」时的一键救援 */
function rescue() {
  fixIneffective = false;
  lastFixAt = 0;
  lastTrimAt = 0;
  if (!petWin || petWin.isDestroyed()) {
    createPetWindow();
    return true;
  }
  try {
    const { workArea } = screen.getPrimaryDisplay();
    const h = petHeight();
    applySize(h);
    moveWindow(
      Math.round(workArea.x + workArea.width - PET_W - 60),
      Math.round(workArea.y + workArea.height - h - 6)
    );
  } catch (e) { /* ignore */ }
  return revealPet('rescue');
}

/** 重新载入宠物页面（改过主题 / 界面白屏时用） */
function reloadPet() {
  if (!petWin || petWin.isDestroyed()) return createPetWindow();
  try { petWin.webContents.reload(); } catch (e) { /* ignore */ }
  setTimeout(() => revealPet('reload'), 900);
  return true;
}

/** 诊断快照：排查「宠物没显示」时用 */
function diag() {
  const c = cfg();
  if (!petWin || petWin.isDestroyed()) {
    return { exists: false, enabled: c.petEnabled !== false, expectedHeight: petHeight() };
  }
  const [w, h] = petWin.getSize();
  const [x, y] = petWin.getPosition();
  return {
    exists: true,
    enabled: c.petEnabled !== false,
    visible: petWin.isVisible(),
    size: [w, h],
    pos: [x, y],
    expectedHeight: petHeight(),
    opacity: petWin.getOpacity()
  };
}

let lastFixAt = 0;
let fixIneffective = false;   // 纠正过但 setSize 被系统忽略 —— 记一次就够，别死循环

/**
 * 运行期自检：宠物窗口是不是还老实待在屏幕上、尺寸还对。
 *
 * 为什么需要它：透明 + 软件渲染的窗口在某些机器上会「自己长高」，
 * 一旦高过屏幕，宠物就被顶到可见区域之外 —— 用户看到的现象就是
 * 「宠物没显示」。启动时查一次不够，得在运行期一直盯着。
 *
 * 只在真的有问题时才动手（默认 60s 一次，偏差 > 24px 且过了冷却），
 * 并且如果一次 setSize 没生效就直接放弃，避免和系统互相刷尺寸。
 */
function selfCheck() {
  if (!petWin || petWin.isDestroyed()) return { ok: true, fixed: '', exists: false };

  const d = diag();
  if (d.enabled === false) return { ok: true, fixed: '', diag: d };
  if (!d.visible) {
    revealPet('self-check');
    return { ok: true, fixed: '不可见 → 已唤出', diag: diag() };
  }
  if (fixIneffective) return { ok: true, fixed: '', diag: d };

  const drift = Math.max(Math.abs(d.size[0] - PET_W), Math.abs(d.size[1] - d.expectedHeight));
  if (drift <= DRIFT_TOLERANCE) return { ok: true, fixed: '', diag: d };
  if (Date.now() - lastFixAt < FIX_COOLDOWN) return { ok: true, fixed: '', diag: d };

  lastFixAt = Date.now();
  const before = d.size.join('x');
  applySize(d.expectedHeight);
  let after = before;
  try { after = petWin.getSize().join('x'); } catch (e) { /* ignore */ }

  if (after === before) {
    fixIneffective = true;
    return { ok: false, fixed: `尺寸纠正无效（setSize 被忽略，仍为 ${before}）`, diag: d };
  }
  return { ok: true, fixed: `尺寸纠正 ${before} → ${after}`, diag: diag() };
}

let lastTrimAt = 0;
let trimsLogged = 0;

/**
 * 热路径上的廉价纠偏。
 *
 * 散步时渲染层每秒会调几十次 bounds/move，所以这里只做一次 getSize + 一次比较，
 * 真的跑偏了才动手。透明窗口在部分机器上会持续「自己长大」，60s 一次的看门狗
 * 够保命，但宠物会先飘上去再被拽回来；挂到散步路径上能把偏差压到亚秒级，
 * 宠物看起来才是稳稳站在地上的。
 */
function trimSize(tag) {
  if (!petWin || petWin.isDestroyed() || fixIneffective) return false;
  if (Date.now() - lastTrimAt < TRIM_COOLDOWN) return false;

  let size;
  try { size = petWin.getSize(); } catch (e) { return false; }
  const want = petHeight();
  if (Math.max(Math.abs(size[0] - PET_W), Math.abs(size[1] - want)) <= DRIFT_TOLERANCE) return false;

  lastTrimAt = Date.now();
  const before = size.join('x');
  applySize(want);
  let after = before;
  try { after = petWin.getSize().join('x'); } catch (e) { /* ignore */ }

  if (after === before) {
    fixIneffective = true;
    log(`宠物尺寸纠偏无效（setSize 被忽略，仍为 ${before}）`);
    return false;
  }
  if (trimsLogged < TRIM_LOG_LIMIT) {
    trimsLogged++;
    log(`宠物尺寸纠偏（${tag}）${before} → ${after}`);
  }
  return true;
}

function closePetWindow() {
  if (petWin && !petWin.isDestroyed()) {
    petWin.destroy();
    petWin = null;
  }
}

function showPet() {
  if (petWin && !petWin.isDestroyed()) {
    revealPet('show');
    return true;
  }
  createPetWindow();
  return true;
}

function hidePet() {
  if (petWin && !petWin.isDestroyed()) petWin.hide();
  return true;
}

function togglePet() {
  if (petWin && !petWin.isDestroyed() && petWin.isVisible()) return hidePet();
  return showPet();
}

/**
 * 宠物 × Agent 联动：把小问的工作状态演出来。
 *
 * action 取值：
 *   think  —— 正在思考（模型还没吐字）
 *   work   —— 正在调用工具（opts.tool 可带工具名，宠物气泡会念出来）
 *   done   —— 顺利答完
 *   error  —— 失败 / 报错
 *   listen —— 正在听主人说话（唤醒词命中、录音中）
 *   idle   —— 收工，回到待机
 */
function petAct(action, opts = {}) {
  if (!action) return false;
  if (!petWin || petWin.isDestroyed()) return false;
  try {
    petWin.webContents.send('pet:act', {
      action: String(action),
      text: opts.text ? String(opts.text) : '',
      tool: opts.tool ? String(opts.tool) : '',
      ts: Date.now()
    });
    return true;
  } catch (e) {
    return false;
  }
}

/** 让宠物替小问播报一句话（AI 回答结束时调用） */
function petSay(text) {
  if (!text) return;
  if (!petWin || petWin.isDestroyed()) return;
  try {
    petWin.webContents.send('pet:say', String(text));
  } catch (e) { /* ignore */ }
}

function isVisible() {
  return !!(petWin && !petWin.isDestroyed() && petWin.isVisible());
}

// ---------- IPC ----------
function registerPetIpc() {
  ipcMain.handle('pet:state-get', () => readState());
  ipcMain.handle('pet:state-save', (_e, s) => writeState(s));

  // 渲染层就绪：切到「穿透 + 转发鼠标」
  ipcMain.handle('pet:ready', () => {
    if (petWin && !petWin.isDestroyed()) {
      petWin.setIgnoreMouseEvents(true, { forward: true });
    }
    return true;
  });

  // 渲染层请求接管 / 释放鼠标
  ipcMain.handle('pet:set-mouse', (_e, ignore) => {
    if (!petWin || petWin.isDestroyed()) return false;
    petWin.setIgnoreMouseEvents(!!ignore, { forward: true });
    return true;
  });

  ipcMain.handle('pet:drag-move', (_e, { dx, dy } = {}) => {
    if (!petWin || petWin.isDestroyed()) return false;
    const [x, y] = petWin.getPosition();
    return moveWindow(x + (dx || 0), y + (dy || 0));
  });

  ipcMain.handle('pet:move-to', (_e, x, y) => {
    if (!petWin || petWin.isDestroyed()) return false;
    trimSize('散步');
    return moveWindow(x, y);
  });

  ipcMain.handle('pet:get-bounds', () => {
    if (!petWin || petWin.isDestroyed()) return null;
    trimSize('取边界');
    const [x, y] = petWin.getPosition();
    const [w, h] = petWin.getSize();
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    return {
      x, y, w, h,
      workArea: { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height }
    };
  });

  // 松手贴底 + 边界限制（宠物永远站在「地面」上）
  ipcMain.handle('pet:snap', () => {
    if (!petWin || petWin.isDestroyed()) return false;
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const [x, y] = petWin.getPosition();
    const [w, h] = petWin.getSize();
    const EDGE = 6;
    const SNAP = 80;

    let nx = x;
    let ny = y;

    // 靠近底部 80px 内 → 贴地（这样宠物始终站在任务栏上方）
    if (Math.abs(y + h - (workArea.y + workArea.height)) < SNAP) {
      ny = workArea.y + workArea.height - h - EDGE;
    }
    if (Math.abs(x - workArea.x) < SNAP) nx = workArea.x + EDGE;
    else if (Math.abs(x + w - (workArea.x + workArea.width)) < SNAP) {
      nx = workArea.x + workArea.width - w - EDGE;
    }

    nx = Math.min(Math.max(nx, workArea.x), workArea.x + workArea.width - w);
    ny = Math.min(Math.max(ny, workArea.y), workArea.y + workArea.height - h);

    moveWindow(nx, ny);
    return true;
  });

  // 任意窗口（对话面板）请求宠物播报
  ipcMain.handle('pet:say-out', (_e, text) => {
    petSay(text);
    return true;
  });

  // 任意窗口请求宠物演出 Agent 状态
  ipcMain.handle('pet:act-out', (_e, p) => petAct(p && p.action, p || {}));

  ipcMain.handle('pet:hide', () => hidePet());
  ipcMain.handle('pet:show', () => showPet());
  ipcMain.handle('pet:toggle', () => togglePet());
  ipcMain.handle('pet:visible', () => isVisible());
  ipcMain.handle('pet:rescue', () => rescue());
  ipcMain.handle('pet:reload', () => reloadPet());
  ipcMain.handle('pet:diag', () => diag());

  ipcMain.handle('pet:set-opacity', (_e, val) => {
    if (!petWin || petWin.isDestroyed()) return false;
    const v = Number(val);
    petWin.setOpacity(isNaN(v) ? 1 : Math.min(Math.max(v, 0.25), 1));
    return true;
  });

  ipcMain.handle('pet:set-top', (_e, on) => {
    if (!petWin || petWin.isDestroyed()) return false;
    petWin.setAlwaysOnTop(!!on, 'floating');
    return true;
  });

  ipcMain.handle('pet:resize', () => resize());
}

/** 按新的 petSize 重算窗口高度（底部对齐） */
function resize() {
  if (!petWin || petWin.isDestroyed()) return false;
  const h = petHeight();
  const [, oldH] = petWin.getSize();
  if (h === oldH) return true;
  if (!applySize(h)) return false;
  const [x, y] = petWin.getPosition();
  moveWindow(x, Math.round(y - (h - oldH)));
  return true;
}

/** 分辨率变化后把宠物拉回可见区域并贴底 */
function reposition() {
  if (!petWin || petWin.isDestroyed()) return false;
  const { workArea } = screen.getPrimaryDisplay();
  const [x, y] = petWin.getPosition();
  const [w, h] = petWin.getSize();
  const nx = Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - w);
  const ny = Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - h);
  moveWindow(nx, ny);
  return true;
}

// ---------- 配置联动 ----------
function applyConfig(c) {
  // 配置变了就重新给一次机会：上次纠正失败可能只是时序问题
  fixIneffective = false;
  lastFixAt = 0;
  lastTrimAt = 0;
  const enabled = c.petEnabled !== false;
  if (enabled) {
    if (!petWin || petWin.isDestroyed()) {
      createPetWindow();
    } else {
      revealPet('config');
    }
  } else if (petWin && !petWin.isDestroyed()) {
    petWin.hide();
  }
}

function init(opts = {}) {
  api = {
    loadRenderer: opts.loadRenderer,
    getConfig: opts.getConfig,
    getSanitizedConfig: opts.getSanitizedConfig,
    log: opts.log || (() => {})
  };
  registerPetIpc();

  // 启动时按配置决定是否出现
  const c = cfg();
  if (c.petEnabled !== false) createPetWindow();
  return { createPetWindow };
}

module.exports = {
  init,
  applyConfig,
  createPetWindow,
  closePetWindow,
  showPet,
  hidePet,
  togglePet,
  revealPet,
  rescue,
  reloadPet,
  diag,
  selfCheck,
  moveWindow,
  trimSize,
  resize,
  reposition,
  petSay,
  petAct,
  isVisible,
  get window() { return petWin; }
};
