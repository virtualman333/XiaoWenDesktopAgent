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

let petWin = null;
let api = null; // { loadRenderer, getConfig, log }

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
    petWin.show();
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

  petWin.once('ready-to-show', () => {
    petWin.show();
    try {
      petWin.webContents.send('config:update', (api.getSanitizedConfig || api.getConfig)());
    } catch (e) { /* ignore */ }
  });

  petWin.on('closed', () => { petWin = null; });

  log('宠物窗口已创建');
  return petWin;
}

function closePetWindow() {
  if (petWin && !petWin.isDestroyed()) {
    petWin.destroy();
    petWin = null;
  }
}

function showPet() {
  if (petWin && !petWin.isDestroyed()) {
    petWin.show();
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
    petWin.setPosition(x + (dx || 0), y + (dy || 0));
    return true;
  });

  ipcMain.handle('pet:move-to', (_e, x, y) => {
    if (!petWin || petWin.isDestroyed()) return false;
    petWin.setPosition(Math.round(Number(x) || 0), Math.round(Number(y) || 0));
    return true;
  });

  ipcMain.handle('pet:get-bounds', () => {
    if (!petWin || petWin.isDestroyed()) return null;
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

    petWin.setPosition(Math.round(nx), Math.round(ny));
    return true;
  });

  // 任意窗口（对话面板）请求宠物播报
  ipcMain.handle('pet:say-out', (_e, text) => {
    petSay(text);
    return true;
  });

  ipcMain.handle('pet:hide', () => hidePet());
  ipcMain.handle('pet:show', () => showPet());
  ipcMain.handle('pet:toggle', () => togglePet());
  ipcMain.handle('pet:visible', () => isVisible());

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
  const [x, y] = petWin.getPosition();
  petWin.setSize(PET_W, h);
  petWin.setPosition(x, Math.round(y - (h - oldH)));
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
  petWin.setPosition(Math.round(nx), Math.round(ny));
  return true;
}

// ---------- 配置联动 ----------
function applyConfig(c) {
  const enabled = c.petEnabled !== false;
  if (enabled) {
    if (!petWin || petWin.isDestroyed()) {
      createPetWindow();
    } else {
      petWin.setAlwaysOnTop(c.petTop !== false, 'floating');
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
  resize,
  reposition,
  petSay,
  isVisible,
  get window() { return petWin; }
};
