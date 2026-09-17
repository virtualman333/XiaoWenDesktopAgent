/**
 * config:set 之后「改了哪些配置、要跟着重载什么」——**判据只此一份**。
 *
 * 为什么单独成模块：这段判断以前是 11 条手写 if 串在 main.js 的 config:set 里，
 * 判据写法五种（`patch.x &&` 真值 / `patch.x !== undefined` / `typeof` / `in` / 前缀）。
 * 其中四条用了真值判断，而这四条恰好全是**用户能把值清空**的快捷键字段。
 *
 * 于是有这样一个用户能看到的毛病：
 *   主人点「框选截图」旁边的清空 → 渲染层 `setConfig({ captureRegionHotkey: '' })`
 *   → `patch.captureRegionHotkey` 是空串，真值判断为假 → 热更新被跳过
 *   → 配置里已经空了、界面输入框也空了、还提示「已清空」，
 *     可系统里那把旧键还挂着，按下去照样截图 —— 一直到重启才回落默认键。
 *
 * 注意「空值 = 回落默认键」这条语义**本来就实现对了**：
 *   `registerHotkeys()`        → `loadConfig().hotkey || 'Alt+Space'`
 *   `setPetSummonHotkey()`     → `String(accel || '').trim() || 'CommandOrControl+Alt+P'`
 *   `capture.registerShortcuts()` → 空键位回落到默认框选 / 整屏键
 * 坏的是上游这道门：把 `''` 当成「没改」，于是永远走不到归一化那一层。
 *
 * 判据统一成一个词：**这个字段显式出现在 patch 里，且值和当前不同**。
 * 与 `entry.js` / `clip-sense.js` 一样是纯函数，可单测。
 */

/**
 * 字段 → 重载动作。按**首次出现的顺序**执行，同一个动作被多个字段触发时只跑一次。
 * 顺序不能随意调：宠物窗口要先落定，入口分工才敢算宿主。
 */
const RULES = [
  { field: 'hotkey', action: 'hotkeys' },
  { field: 'petSummonHotkey', action: 'pet-summon-hotkey' },
  { field: 'captureRegionHotkey', action: 'capture' },
  { field: 'captureFullHotkey', action: 'capture' },
  { field: 'captureEnabled', action: 'capture' },
  { field: 'ballOpacity', action: 'ball-opacity' },
  { prefix: 'meeting', action: 'meeting' },
  { field: 'clipSenseEnabled', action: 'clip-sense' },
  { field: 'clipSenseRules', action: 'clip-sense' },
  { field: 'petEnabled', action: 'pet' },
  { field: 'petTop', action: 'pet' },
  { field: 'petKeepTop', action: 'pet' },
  { field: 'petSize', action: 'pet-size' },
  { field: 'petOpacity', action: 'pet-opacity' },
  { field: 'ballEnabled', action: 'entry' }
];

/** 快捷键类字段的命名约定 —— 凡是长这样的配置项都必须进上面那张表 */
const HOTKEY_KEY_RE = /^(hotkey|[a-z][\w]*Hotkey)$/;

/**
 * 这个字段是不是「显式改成了别的值」。
 *
 * 判据就两条：patch **自己带**了这个键（不是继承来的），且新值和旧值不相等。
 * **不能用真值判断** —— 空串、false、0 都是合法的「改成空」，
 * 写成 `patch.x && ...` 会把它们当成「没改」，热更新静默失效。
 */
function changed(patch, cur, key) {
  const p = patch || {};
  return Object.prototype.hasOwnProperty.call(p, key) && p[key] !== (cur || {})[key];
}

/** 算这一次 config:set 需要跑哪些重载动作（去重、保序） */
function planReloads(patch, cur) {
  const p = patch || {};
  const keys = Object.keys(p);
  const out = [];
  for (const rule of RULES) {
    const hit = rule.field
      ? changed(p, cur, rule.field)
      : keys.some((k) => k.startsWith(rule.prefix));
    if (hit && !out.includes(rule.action)) out.push(rule.action);
  }
  return out;
}

/** 表里所有的字段名（不含前缀规则），给测试做交叉校验用 */
function tableFields() {
  return RULES.filter((r) => r.field).map((r) => r.field);
}

/** 表里所有以「快捷键」命名的字段 */
function hotkeyFields() {
  return tableFields().filter((f) => HOTKEY_KEY_RE.test(f));
}

module.exports = { changed, planReloads, tableFields, hotkeyFields, RULES, HOTKEY_KEY_RE };
