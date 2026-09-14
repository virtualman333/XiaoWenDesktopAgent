/**
 * 托盘图标解析 —— 单独成模块，方便直接单测 / 在真 Electron 里冒烟。
 *
 * 踩过的坑（安装版「右下角托盘图标不显示」）：
 *   1) 图标曾经只放在仓库的 build/ 下，而 electron-builder 的 files 只打包
 *      src/**、dist/**、package.json —— build/ 是 buildResources，不进 asar。
 *      于是安装版 path.join(__dirname,'../../build/icon.ico') 永远不存在，直接走兜底。
 *   2) 兜底的内联 base64 是一张**损坏的 PNG**（zlib 流截断、没有 IEND），
 *      nativeImage.createFromBuffer 解出来是 0x0 的空图。
 *   3) 而 new Tray(空图) **不会报错**，只是托盘上什么都看不见 —— 纯静默失败。
 *      实测：空图 isEmpty()=true、getSize()=0x0，但 tray.getBounds() 仍返回正常矩形，
 *      所以 getBounds 判断不出来，唯一可靠的判据是 image.isEmpty()。
 *
 * 结论：图标必须放在 src/ 下随包发布，且每一档都要校验 isEmpty()。
 */
const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');

// 图标候选，按优先级排列。前两个在 src/assets 下，会随包发布；
// 第三个是开发时仓库根的图标（打包后不存在，仅作开发兜底）。
const TRAY_ICON_CANDIDATES = [
  path.join(ASSETS_DIR, 'tray.ico'),
  path.join(ASSETS_DIR, 'tray.png'),
  path.join(__dirname, '..', '..', 'build', 'icon.ico')
];

// 最后兜底：内联 32x32 PNG（与 tray.ico 里 32x32 那一档同一张图）。
// ⚠️ 这段 base64 必须是**完整可解码**的 PNG —— 历史上它是一张截断的图，
// 直接导致托盘图标全黑（不可见）。改动前先跑 npm run test:tray。
const TRAY_FALLBACK_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABnUlEQVR42sXXay8DQRQG4PlfVFVVVVVVlYiIVm96cwkhCCEEIQTh/1W1etWLO19eu2Rlu8nqzOzGvJ+bPKdnzpxpCdFJ4PoD41fv8F++YeziFb7zF4yePcN7+oSRk0d4jlsYPmrCfdjA0EEdrv0HDO7V4NytYmCnAsd2Gf1bJdg3i+jbuAehzcTNJ8zGbesF9K7lYV29g1C8ZyUHy/IthOLdS1l0LWYhFLcsZGHNqDohArdlchCK29M5ONLSUPLi2vDgzlQehBXvFBbclZQKMIIrbdeGFncnCyC8bdeeuTq0uCchbUiWgdPDlbYrocW9cgGs+F8D1zYLFLhvvghCe9XU0Zv2ts9Q4P54CYTlnivRu2qseEAugGXJqKOHf88IJT4ZK4OwbrhOYcGnYhUQnvVqFj4drYLw7naegdPiMxGpAN6Hxeg3l/HZSA2E91VThxcPhR9AzHhSefGwXIBIPDpXBzGCK+HF46EGiFFcCQ+ekAvgbbs2PHgq2Pz5Xch75qbgcv5r4NR4Jthq/28gFFciFP89DpG4Ombjes4XV51aZAGCi5kAAAAASUVORK5CYII=';

/**
 * 依次尝试各候选路径，返回第一个**非空**的图标。
 * @param {{log?: (m: string) => void, candidates?: string[]}} [opts]
 *        candidates 仅用于测试：传一个不存在的路径就能强制走内联兜底，
 *        验证兜底图确实不是空图（历史上它就是空的，直接导致托盘不可见）。
 * @returns {{image: Electron.NativeImage, source: string, isIco: boolean, empty: boolean}}
 */
function resolveTrayIcon(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const candidates = Array.isArray(opts.candidates) ? opts.candidates : TRAY_ICON_CANDIDATES;

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const img = nativeImage.createFromPath(p);
      if (img && !img.isEmpty()) {
        return { image: img, source: p, isIco: /\.ico$/i.test(p), empty: false };
      }
      log(`托盘图标解出来是空图，跳过：${p}`);
    } catch (e) {
      log(`托盘图标读取失败 ${p}: ` + ((e && e.message) || e));
    }
  }

  // 内联兜底：32x32 PNG 按 scaleFactor=2 提交，逻辑尺寸正好 16x16
  try {
    const img = nativeImage.createFromBuffer(
      Buffer.from(TRAY_FALLBACK_PNG, 'base64'), { scaleFactor: 2 }
    );
    const empty = !img || img.isEmpty();
    if (empty) log('内联兜底图标解出来是空图 —— base64 可能已损坏');
    return { image: img || nativeImage.createEmpty(), source: 'inline-fallback', isIco: false, empty };
  } catch (e) {
    log('内联兜底图标失败: ' + ((e && e.message) || e));
    return { image: nativeImage.createEmpty(), source: 'failed', isIco: false, empty: true };
  }
}

/** 兼容老调用：只要图 */
function getTrayIcon(opts) {
  return resolveTrayIcon(opts).image;
}

/**
 * 生成给 Tray 用的图标。
 * .ico 直接交给 Windows，它会自己挑 16/24/32… 最合适的那一档，
 * 比强行 resize 成 16x16 更清楚；PNG / 内联兜底才缩到 16。
 */
function iconForTray(res) {
  if (!res || !res.image || res.image.isEmpty()) return nativeImage.createEmpty();
  if (res.isIco) return res.image;
  return res.image.resize({ width: 16, height: 16 });
}

module.exports = {
  ASSETS_DIR,
  TRAY_ICON_CANDIDATES,
  TRAY_FALLBACK_PNG,
  resolveTrayIcon,
  getTrayIcon,
  iconForTray
};
