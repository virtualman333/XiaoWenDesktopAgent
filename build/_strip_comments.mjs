/**
 * `stripComments` —— 测试里「读源码做判定」时唯一的那份剥注释实现
 *
 * 为什么抽出来：`_capture_plan_test.mjs` 当时只要一个消费者，注释里写的是
 * 「出现第二个消费者时再抽成共用模块，现在不提前抽」。第 25 轮 `_updater_plan_test.mjs`
 * 成了第二个消费者 —— 于是按那条规则抽到这里。
 *
 * 为什么非要有它：本仓的「接线锁」都是读源码判定的，而注释里正大光明地写着旧判据 /
 * 旧缺陷（`capture.js` 注释里写着 `after !== 'none'`；`updater.js` 注释里写着
 * `if (silentInstall) { notify(...) }`）。不剥注释就会把**注释当实现**、
 * 把正确的代码判红 —— 本仓第 9 / 19 / 25 轮各踩过一次。
 *
 * 字符串字面量会被保护：`'https://…'` 里的 `//` 不会把后面全吃掉。
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      if (c === '\\') { out += c + (n === undefined ? '' : n); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i += 1; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2; continue;
    }
    out += c; i += 1;
  }
  return out;
}
