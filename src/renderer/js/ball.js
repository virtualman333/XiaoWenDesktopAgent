/**
 * 悬浮球交互逻辑
 * - 单击：打开对话面板
 * - 双击：触发语音问答
 * - 拖动：移动窗口（手动实现，因为 transparent + 无边框下 -webkit-app-region 会吞掉点击）
 * - 右键：弹出菜单
 */

const ball = document.getElementById('ball');
const toastEl = document.getElementById('toast');

let isDragging = false;
let dragMoved = false;
let lastScreenX = 0;
let lastScreenY = 0;
let downTime = 0;
let clickTimer = null;
let toastTimer = null;

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

// ---------- 主进程事件 ----------
window.xw.onToast((msg) => showToast(msg));

window.xw.onVoiceStart(() => {
  setStatus('listening');
  showToast('正在聆听…');
});

// 配置更新（主进程广播）
window.xw.onConfigUpdate((cfg) => {
  if (cfg && typeof cfg.ballOpacity === 'number') {
    ball.style.opacity = cfg.ballOpacity;
  }
});
