/**
 * 截图框选层 —— 铺上整屏截图，主人拖框选一块区域，确认后交给主进程裁剪。
 *
 * 交互：拖拽画框 → 松开出操作条 → Enter/✓ 完成，Esc 取消，双击空白处截全屏。
 * 选好后还能拖动整体位置、拽四角手柄微调大小。
 */
(function () {
  const $ = (id) => document.getElementById(id);

  const bg = $('bg');
  const sel = $('sel');
  const tip = $('sizeTip');
  const hint = $('hint');
  const shades = {
    top: $('shadeTop'),
    bottom: $('shadeBottom'),
    left: $('shadeLeft'),
    right: $('shadeRight')
  };

  let rect = null;          // { x, y, w, h }（CSS 像素，相对本窗口）
  let dragMode = null;      // 'draw' | 'move' | 'nw' | 'ne' | 'sw' | 'se'
  let origin = null;        // 按下时的鼠标点
  let startRect = null;     // 按下时的选区快照
  let finished = false;

  function clampRect(r) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    let x = Math.max(0, Math.min(r.x, W));
    let y = Math.max(0, Math.min(r.y, H));
    let w = Math.max(1, Math.min(r.w, W - x));
    let h = Math.max(1, Math.min(r.h, H - y));
    return { x, y, w, h };
  }

  function render() {
    if (!rect) {
      sel.classList.add('hidden');
      for (const k in shades) shades[k].style.display = 'none';
      return;
    }
    sel.classList.remove('hidden');
    sel.style.left = rect.x + 'px';
    sel.style.top = rect.y + 'px';
    sel.style.width = rect.w + 'px';
    sel.style.height = rect.h + 'px';
    tip.textContent = `${Math.round(rect.w)} × ${Math.round(rect.h)}`;

    // 四块遮罩围出高亮区（框内不遮暗）
    const W = window.innerWidth;
    const H = window.innerHeight;
    setShade('top', 0, 0, W, rect.y);
    setShade('bottom', 0, rect.y + rect.h, W, H - rect.y - rect.h);
    setShade('left', 0, rect.y, rect.x, rect.h);
    setShade('right', rect.x + rect.w, rect.y, W - rect.x - rect.w, rect.h);
  }

  function setShade(key, x, y, w, h) {
    const el = shades[key];
    if (!el) return;
    if (w <= 0 || h <= 0) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.width = w + 'px';
    el.style.height = h + 'px';
  }

  function onDown(e) {
    if (finished) return;
    const handle = e.target && e.target.dataset ? e.target.dataset.h : null;
    origin = { x: e.clientX, y: e.clientY };
    if (handle) {
      dragMode = handle;
      startRect = { ...rect };
    } else if (rect && inside(e.clientX, e.clientY)) {
      dragMode = 'move';
      startRect = { ...rect };
    } else {
      dragMode = 'draw';
      rect = { x: e.clientX, y: e.clientY, w: 1, h: 1 };
      render();
      hint.classList.add('gone');
    }
    e.preventDefault();
  }

  function inside(x, y) {
    return rect && x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
  }

  function onMove(e) {
    if (!dragMode || finished) return;
    const dx = e.clientX - origin.x;
    const dy = e.clientY - origin.y;

    if (dragMode === 'draw') {
      rect = clampRect({
        x: Math.min(origin.x, e.clientX),
        y: Math.min(origin.y, e.clientY),
        w: Math.abs(dx),
        h: Math.abs(dy)
      });
    } else if (dragMode === 'move') {
      rect = clampRect({ x: startRect.x + dx, y: startRect.y + dy, w: startRect.w, h: startRect.h });
    } else {
      const r = { ...startRect };
      if (dragMode === 'se') { r.w = startRect.w + dx; r.h = startRect.h + dy; }
      if (dragMode === 'ne') { r.y = startRect.y + dy; r.h = startRect.h - dy; r.w = startRect.w + dx; }
      if (dragMode === 'sw') { r.x = startRect.x + dx; r.w = startRect.w - dx; r.h = startRect.h + dy; }
      if (dragMode === 'nw') { r.x = startRect.x + dx; r.y = startRect.y + dy; r.w = startRect.w - dx; r.h = startRect.h - dy; }
      if (r.w < 0) { r.x += r.w; r.w = -r.w; }
      if (r.h < 0) { r.y += r.h; r.h = -r.h; }
      rect = clampRect(r);
    }
    render();
  }

  function onUp() {
    if (!dragMode) return;
    dragMode = null;
    if (rect && (rect.w < 6 || rect.h < 6)) rect = null;
    render();
  }

  function finish(useFull) {
    if (finished) return;
    finished = true;
    const payload = useFull || !rect
      ? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight, full: true }
      : { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.w), height: Math.round(rect.h) };
    try { window.xw.captureDone(payload); } catch (e) { /* ignore */ }
  }

  function cancel() {
    if (finished) return;
    finished = true;
    try { window.xw.captureCancel(); } catch (e) { /* ignore */ }
  }

  function onKey(e) {
    if (e.key === 'Escape') { cancel(); return; }
    if (e.key === 'Enter') { if (rect) finish(false); return; }
  }

  async function boot() {
    let info = null;
    try { info = await window.xw.captureInit(); } catch (e) { /* ignore */ }
    if (info && info.dataUrl) {
      const img = new Image();
      img.onload = () => {
        bg.width = window.innerWidth;
        bg.height = window.innerHeight;
        const ctx = bg.getContext('2d');
        ctx.drawImage(img, 0, 0, bg.width, bg.height);
      };
      img.src = info.dataUrl;
    }

    window.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey);
    window.addEventListener('dblclick', () => finish(true));
    window.addEventListener('contextmenu', (e) => { e.preventDefault(); cancel(); });

    $('btnOk').addEventListener('click', (e) => { e.stopPropagation(); finish(false); });
    $('btnFull').addEventListener('click', (e) => { e.stopPropagation(); finish(true); });
    $('btnCancel').addEventListener('click', (e) => { e.stopPropagation(); cancel(); });
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
