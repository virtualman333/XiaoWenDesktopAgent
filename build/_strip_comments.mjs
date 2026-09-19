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
 * ★ 它自己曾经是「一个静默失效的地基」（本轮修掉两处）
 * ----------------------------------------------------
 * 它扛着全仓所有读源码的锁，却从没被验过 —— 而它在 `panel.js` 上**几乎什么都没做**：
 * 42 条唯一块注释有 33 条原样留着，体量只减了 1.5%，照样返回字符串、不抛错、不警告。
 * 两处根因：
 *
 *   1. **不认识正则字面量**：`String(s || '').replace(/[&<>"']/g, …)` 里的 `"` 被当成
 *      字符串开头，从此 quote 状态反相；
 *   2. **不认识模板字符串里的 `${}` 嵌套**：`\`a${ \`b\` }c\`` 这种写法（本仓面板里
 *      到处都是）会让内外两个反引号错配，之后一路乱到重新撞上。
 *
 * 坏处不是「多留了注释」，而是**所有靠它做的判定都悄悄变弱**：注释里的旧代码会被当成
 * 实现，「不许出现 X」这类断言会对着注释里那句历史说明报红或报绿 —— 一个剥不干净的
 * 剥注释器，会把每条读源码的锁都变成掷骰子。
 *
 * 所以现在有 ① 正经的扫描器（字符串 / 模板与 `${}` 嵌套 / 正则字面量（含字符类）/
 * 行注释 / 块注释）；② `residueErrors()` **总闸**，剥完还残留注释行、或体量几乎没变
 * 一律报错，由调用方断言。判据不能只是「函数返回了一个字符串」—— 正是这个缺口让它
 * 失效了整整三轮而无人知晓。
 */

/** 这些字符之后出现的 `/` 是正则开头，不是除号 */
const REGEX_AFTER_CHAR = '(,=:[!&|?{};+-*%~^<>';
/** 这些关键字之后出现的 `/` 也是正则开头 */
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'do', 'else', 'case', 'yield', 'await', 'throw'
]);

const BS = '\\';
const isWord = (ch) => /[A-Za-z0-9_$]/.test(ch);

/** 已产出的这段文本后面，一个 `/` 该被读成正则还是除号 */
function looksLikeRegexStart(out) {
  let i = out.length - 1;
  while (i >= 0 && /\s/.test(out[i])) i -= 1;
  if (i < 0) return true;                                  // 文件开头
  if (REGEX_AFTER_CHAR.includes(out[i])) return true;
  let j = i;
  while (j >= 0 && isWord(out[j])) j -= 1;
  return REGEX_AFTER_WORD.has(out.slice(j + 1, i + 1));
}

export function stripComments(src) {
  let out = '';
  let i = 0;
  // code / sq / dq / tpl / re / line / block
  let mode = 'code';
  /* 每个还开着的 `${` 里已经攒了几层花括号。
     模板文本与 `${}` 里的代码共用这一个栈：进 `${` 压一个 0，退到 0 就回到上一层模板
     —— 嵌套模板（`a${ `b${c}d` }e`）因此天然对得上。花括号深度只在「栈非空」时才算，
     这样模板外那些普通的花括号不会污染计数。 */
  const braces = [];
  let reClass = false;

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];

    if (mode === 'line') { if (c === '\n') mode = 'code'; i += 1; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { i += 2; mode = 'code'; continue; } i += 1; continue; }

    if (mode === 'sq' || mode === 'dq') {
      if (c === BS) { out += c + (n === undefined ? '' : n); i += 2; continue; }
      if (c === (mode === 'sq' ? "'" : '"')) mode = 'code';
      out += c; i += 1; continue;
    }

    if (mode === 'tpl') {
      if (c === BS) { out += c + (n === undefined ? '' : n); i += 2; continue; }
      if (c === '`') { mode = 'code'; out += c; i += 1; continue; }
      if (c === '$' && n === '{') { braces.push(0); out += '${'; i += 2; mode = 'code'; continue; }
      out += c; i += 1; continue;
    }

    if (mode === 're') {
      if (c === BS) { out += c + (n === undefined ? '' : n); i += 2; continue; }
      if (c === '\n') { mode = 'code'; continue; }          // 正则不许跨行：没闭合就认输
      if (c === '[') reClass = true;
      else if (c === ']') reClass = false;
      else if (c === '/' && !reClass) {
        out += c; i += 1; mode = 'code';
        while (i < src.length && /[a-z]/i.test(src[i])) { out += src[i]; i += 1; }   // 标志位
        continue;
      }
      out += c; i += 1; continue;
    }

    // ---- code ----
    if (c === '/' && n === '/') { i += 2; mode = 'line'; continue; }
    if (c === '/' && n === '*') { i += 2; mode = 'block'; continue; }
    if (c === '/' && looksLikeRegexStart(out)) { out += c; i += 1; mode = 're'; reClass = false; continue; }
    if (c === "'") { mode = 'sq'; out += c; i += 1; continue; }
    if (c === '"') { mode = 'dq'; out += c; i += 1; continue; }
    if (c === '`') { mode = 'tpl'; out += c; i += 1; continue; }
    if (braces.length) {
      if (c === '{') braces[braces.length - 1] += 1;
      else if (c === '}') {
        if (braces[braces.length - 1] === 0) { braces.pop(); mode = 'tpl'; out += c; i += 1; continue; }
        braces[braces.length - 1] -= 1;
      }
    }
    out += c; i += 1; continue;
  }
  return out;
}

/**
 * 总闸：剥完之后**不许残留注释**，体量也不许几乎没变。
 *
 * 返回错误数组（空数组 = 干净）；调用方应当断言它为空。只断言「函数返回了字符串」
 * 是不够的 —— 正是这个缺口让 `panel.js` 上 33 条注释原样留着还能一路全绿。
 *
 * 体量这道是**双向**的：高于 97% 说明几乎没剥（扫描中途丢了同步），低于 25% 说明可能
 * 把代码当注释 / 正则吃掉了。两头都按**实测**定的，不是拍的：本仓最大的 `panel.js` 剥完
 * 92%，最小的 `capture-plan.js` 剥完 43%（那个文件非空行里 69% 是注释 —— 纯计划模块
 * 本来就长这样），所以下界只能放到 25%：再往下就不是「注释多」能解释的了。
 */
export function residueErrors(src, stripped) {
  const bad = [];
  stripped.split('\n').forEach((l, i) => {
    const t = l.trim();
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*/') || /^\*\s/.test(t)) {
      bad.push(`第 ${i + 1} 行还留着注释：${t.slice(0, 60)}`);
    }
  });
  if (src.length) {
    const ratio = stripped.length / src.length;
    if (ratio > 0.97) {
      bad.push(`剥完还剩 ${Math.round(ratio * 100)}% 的体量 —— 扫描中途丢了同步（注释没被剥掉）`);
    } else if (ratio < 0.25) {
      bad.push(`剥完只剩 ${Math.round(ratio * 100)}% 的体量 —— 可能把代码当注释 / 正则吃掉了`);
    }
  }
  return bad;
}
