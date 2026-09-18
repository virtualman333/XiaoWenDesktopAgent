/**
 * 「截完之后做什么」的判据 —— 纯函数，**不 require electron**，因此纯 Node 能直接加载并单测。
 *
 * 为什么单独成一个文件
 * --------------------
 * 设置页那个下拉（`src/renderer/panel.html` 的 `#capAfter`）对小问许了四条诺：
 *
 *   ask        存盘 + 复制 + 带到对话框（推荐）
 *   save       只存盘
 *   clipboard  只复制到剪贴板
 *   none       存盘，不复制
 *
 * 而实现此前是「无条件 `persist()` 落盘 + `if (after !== 'none') 写剪贴板`」，
 * 于是三个方向全反：
 *   · 选「只复制到剪贴板」→ **照样落盘**（截图常含敏感内容，用户明确说了别进磁盘）
 *   · 选「只存盘」        → **照样占剪贴板**（把用户正在复制的东西顶掉，一粘贴出的是截图）
 *   · 选「存盘，不复制」  → 这条才是唯一与标签一致的
 *
 * 而且这个判据在全屏 / 区域两条路径里各写了一遍（`capture.js` 两处），
 * 两处一起错 —— 正是本仓反复出现的「同一件事写两遍」。
 *
 * 现在把它挪到这里：`capture.js` 两个入口都调 `capturePlan()`，
 * `build/_capture_plan_test.mjs` 拿 `panel.html` 的选项与这里**两向对账** ——
 * 改标签不改语义、或加了新选项没登记，`npm run test:capture` 立刻红。
 *
 * 未知取值（配置被手改坏、或旧版本留下的值）退化成默认的 `ask`，
 * 并把原始值挂在 `unknown` 上 —— 不静默当成某个合法模式。
 */
'use strict';

/** 语义表：唯一一份。键必须与设置页下拉的 `value` 一一对应 */
const CAPTURE_AFTER = {
  ask: { save: true, copy: true, attach: true },
  save: { save: true, copy: false, attach: false },
  clipboard: { save: false, copy: true, attach: false },
  none: { save: true, copy: false, attach: false },
};

const DEFAULT_AFTER = 'ask';

/**
 * `after` → `{ key, save, copy, attach }`
 *   save   是否落盘（`persist()`）
 *   copy   是否写入剪贴板（`clipboard.writeImage()`）
 *   attach 是否把图带进对话框（`notify('capture', payload)`）
 */
function capturePlan(after) {
  const raw = after === null || after === undefined || after === '' ? DEFAULT_AFTER : String(after);
  const hit = Object.prototype.hasOwnProperty.call(CAPTURE_AFTER, raw) ? CAPTURE_AFTER[raw] : null;
  if (hit) return { key: raw, save: hit.save, copy: hit.copy, attach: hit.attach };
  const d = CAPTURE_AFTER[DEFAULT_AFTER];
  return { key: DEFAULT_AFTER, save: d.save, copy: d.copy, attach: d.attach, unknown: raw };
}

module.exports = { CAPTURE_AFTER, DEFAULT_AFTER, capturePlan };
