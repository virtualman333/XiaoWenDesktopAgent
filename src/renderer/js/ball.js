/**
 * 悬浮球交互逻辑
 * - 单击：打开对话面板
 * - 双击：触发语音问答
 * - 拖动：移动窗口（手动实现，因为 transparent + 无边框下 -webkit-app-region 会吞掉点击）
 * - 右键：弹出菜单
 * - 常驻：语音唤醒监听（开启后说「小问」即可免按键唤醒）
 */

import {
  startWake, stopWake, isWakeRunning, isWakeSupported,
  suspendWake, setPanelPaused, updateWakeConfig
} from './wake.js';

const ball = document.getElementById('ball');
const toastEl = document.getElementById('toast');

let isDragging = false;
let dragMoved = false;
let lastScreenX = 0;
let lastScreenY = 0;
let downTime = 0;
let clickTimer = null;
let toastTimer = null;

let wakeCfg = { wakeEnabled: false, wakeWords: [], wakeSensitivity: 60, wakeSound: true };
let wakeBooted = false;

// ---------- 拖动 ----------
ball.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  isDragging = true;
  dragMoved = false;
  downTime = Date.now();
  lastScreenX = e.screenX;
  lastScreenY = e.screenY;
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const dx = e.screenX - lastScreenX;
  const dy = e.screenY - lastScreenY;
  if (Math.abs(dx) > 0 || Math.abs(dy) > 0) {
    if (Math.abs(e.screenX - lastScreenX) > 1 || Math.abs(e.screenY - lastScreenY) > 1) {
      dragMoved = true;
    }
    lastScreenX = e.screenX;
    lastScreenY = e.screenY;
    window.xw.ballDragMove({ dx, dy });
  }
});

window.addEventListener('mouseup', async (e) => {
  if (!isDragging) return;
  isDragging = false;

  if (dragMoved) {
    // 松手后吸附到屏幕边缘
    await window.xw.ballSnap();
    return;
  }

  // 未移动 = 点击
  if (e.button === 0) {
    if (clickTimer) {
      // 双击 → 语音问答
      clearTimeout(clickTimer);
      clickTimer = null;
      setStatus('listening');
      showToast('正在聆听…');
      window.xw.openPanelVoice();
    } else {
      // 可能是单击，等 260ms 看是否双击
      clickTimer = setTimeout(() => {
        clickTimer = null;
        window.xw.openPanel();
      }, 260);
    }
  }
});

// 右键菜单
ball.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.xw.ballShowMenu();
});

// 状态样式切换
function setStatus(status) {
  ball.classList.remove('listening', 'thinking', 'speaking');
  if (status) ball.classList.add(status);
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

// ================= 语音唤醒 =================

function setWakeIndicator(on, active) {
  ball.classList.toggle('wake-on', !!on);
  ball.classList.toggle('wake-active', !!active);
}

async function bootWake(cfg) {
  wakeCfg = {
    wakeEnabled: !!cfg.wakeEnabled,
    wakeWords: Array.isArray(cfg.wakeWords) ? cfg.wakeWords : [],
    wakeSensitivity: cfg.wakeSensitivity != null ? cfg.wakeSensitivity : 60,
    wakeSound: cfg.wakeSound !== false
  };

  if (!wakeCfg.wakeEnabled) {
    if (isWakeRunning()) stopWake();
    setWakeIndicator(false, false);
    return;
  }

  if (!isWakeSupported()) {
    showToast('当前环境不支持唤醒');
    setWakeIndicator(false, false);
    return;
  }

  if (isWakeRunning()) {
    updateWakeConfig({
      wakeWords: wakeCfg.wakeWords.length ? wakeCfg.wakeWords : undefined,
      sensitivity: wakeCfg.wakeSensitivity,
      sound: wakeCfg.wakeSound
    });
    return;
  }

  const ok = await startWake({
    wakeWords: wakeCfg.wakeWords,
    sensitivity: wakeCfg.wakeSensitivity,
    sound: wakeCfg.wakeSound,
    onState: (s) => {
      setWakeIndicator(true, s === 'recognizing' || s === 'waiting');
    },
    onWake: ({ word }) => {
      showToast(`唤醒成功：${word}`);
      // 宠物竖起耳朵「我在听」（失败静默，宠物可能没开）
      try { window.xw.petAct && window.xw.petAct('listen'); } catch (e) { /* ignore */ }
      // 打开面板并自动开始录音；期间暂停唤醒，避免把 AI 的回答当成唤醒词
      suspendWake(true, 25000);
      setStatus('listening');
      window.xw.openPanelVoice();
    },
    onError: (msg) => {
      // 频繁报错时用 toast 会刷屏，只在首次提示一次
      if (!wakeBooted) showToast(String(msg).slice(0, 40));
    }
  });

  wakeBooted = true;
  setWakeIndicator(ok, false);
  if (ok) showToast(`已开启语音唤醒，叫「${wakeCfg.wakeWords[0] || '小问'}」试试`);
}

// ---------- 主进程事件 ----------
window.xw.onToast((msg) => showToast(msg));

window.xw.onVoiceStart(() => {
  setStatus('listening');
  showToast('正在聆听…');
  // 面板正在录音，暂停唤醒，避免自己听见自己
  suspendWake(true, 25000);
});

// 面板打开/关闭由主进程同步：面板开着就一直让出麦克风，
// 直到面板真正关闭才恢复（不用定时器兜底，否则会把「面板还开着」覆盖掉）
if (window.xw.onWakeSync) {
  window.xw.onWakeSync(({ paused }) => setPanelPaused(!!paused));
}

// 配置更新（主进程广播）
window.xw.onConfigUpdate((cfg) => {
  if (!cfg) return;
  if (typeof cfg.ballOpacity === 'number') {
    ball.style.opacity = cfg.ballOpacity;
  }
  bootWake(cfg);
});

// ---------- 启动 ----------
(async () => {
  try {
    const cfg = await window.xw.getConfig();
    if (typeof cfg.ballOpacity === 'number') ball.style.opacity = cfg.ballOpacity;
    await bootWake(cfg);
  } catch (e) {
    console.warn('[ball] 读取配置失败:', e);
  }
})();
