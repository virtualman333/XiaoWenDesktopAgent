/**
 * 「截完之后做什么」回归测试 —— node build/_capture_plan_test.mjs
 *
 * 要保护的是设置页那个下拉（`panel.html` 的 `#capAfter`）对小问许的四条诺：
 *   ask 存盘 + 复制 + 带到对话框 / save 只存盘 / clipboard 只复制到剪贴板 / none 存盘，不复制
 *
 * 这四条此前**一条断言都没有**：判据写在 `capture.js` 里，而那个文件第一行就
 * `require('electron')` —— 纯 Node 加载不了它。于是这四条诺全凭「读代码看着没问题」，
 * 而实际实现是「无条件 `persist()` 落盘 + `after !== 'none'` 就写剪贴板」：
 *   · 选「只复制到剪贴板」→ 照样落盘（截图常含敏感内容，用户明确说了别进磁盘）
 *   · 选「只存盘」        → 照样占剪贴板（把正在复制的东西顶掉）
 *
 * 判据本轮抽到 `src/main/capture-plan.js`（纯函数、零 electron 依赖）之后，这个文件才跑得起来。
 *
 * 四组：
 *   1. 真值表 —— 四种模式各自的 save / copy / attach（期望值**手写**，不引用被测常量）
 *   2. 设置页标签 ⇄ 语义表的两向对账，外加「标签里写『只 X』就只能做 X」这条通用规则
 *   3. 未知取值与默认值 —— 退化成 ask 且带上 unknown 标记，不静默当成某个合法模式
 *   4. 接线锁 —— `capture.js` 两个入口都必须走唯一判据，旧判据不得复活
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_strip_comments.mjs';

const require = createRequire(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { CAPTURE_AFTER, DEFAULT_AFTER, capturePlan } = require('../src/main/capture-plan.js');

let pass = 0;
const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else fails.push(name + (extra ? ` → ${extra}` : '')); };
const eq = (a, b, name) => ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
const section = (s) => console.log('\n' + s);

/**
 * 剥注释的实现在 `./_strip_comments.mjs`。
 *
 * 这个测试里第一个「读源码做判定」的锁需要它：`capture.js` 的注释里正大光明地写着旧判据
 * `after !== 'none'`，不剥注释就会把注释当实现、判红正确的代码（本仓第 9 / 19 轮各踩过一次）。
 * 当时只有一个消费者，注释里写的是「出现第二个消费者时再抽成共用模块」——
 * 第 25 轮 `_updater_plan_test.mjs` 成了第二个消费者，于是它被抽走了。
 */
const readSrc = (rel) => fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8');

/** 从设置页里解析某个 <select> 的选项（value + 标签原文） */
function parseSelect(html, id) {
  const m = new RegExp(`<select[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
  if (!m) return [];
  const out = [];
  for (const o of m[1].matchAll(/<option\s+value="([^"]+)"[^>]*>([^<]*)<\/option>/g)) {
    out.push({ value: o[1], label: o[2].trim() });
  }
  return out;
}

// ============================================================
// 1. 真值表（期望值手写 —— 不许引用 CAPTURE_AFTER 本身，那会变成恒真）
// ============================================================
section('1. 四种模式的真值表');

/** [模式, 落盘, 复制, 带进对话框, 设置页上的说法] */
const TABLE = [
  ['ask', true, true, true, '存盘 + 复制 + 带到对话框（推荐）'],
  ['save', true, false, false, '只存盘'],
  ['clipboard', false, true, false, '只复制到剪贴板'],
  ['none', true, false, false, '存盘，不复制'],
];
for (const [key, save, copy, attach, label] of TABLE) {
  const p = capturePlan(key);
  ok(p.save === save && p.copy === copy && p.attach === attach,
    `${key}（${label}）→ 落盘 ${save} / 复制 ${copy} / 带进对话框 ${attach}`,
    `实际 落盘 ${p.save} / 复制 ${p.copy} / 带进对话框 ${p.attach}`);
  eq(p.key, key, `${key} 原样回传，不被悄悄归一成别的模式`);
}

// 本轮修的两条，单独点名（它们此前是反的）
eq(capturePlan('clipboard').save, false, '「只复制到剪贴板」不许落盘（本轮修的缺陷）');
eq(capturePlan('save').copy, false, '「只存盘」不许占剪贴板（本轮修的缺陷）');
eq(capturePlan('none').copy, false, '「存盘，不复制」确实不复制');
eq(capturePlan('ask').copy, true, '「带到对话框」这一项本来就含复制');

// ============================================================
// 2. 设置页标签 ⇄ 语义表：两向对账 + 标签承诺的通用规则
// ============================================================
section('2. 设置页 ⇄ 语义表');

const opts = parseSelect(readSrc('src/renderer/panel.html'), 'capAfter');
ok(opts.length > 0, `解析出了设置页 #capAfter 的选项（${opts.length} 个）`,
  '解析面为空的话，下面每一条都会在空集上通过 —— 文案形态变了就得跟着改这个解析');

const tableKeys = Object.keys(CAPTURE_AFTER);
const htmlValues = opts.map((o) => o.value);
const notDeclared = htmlValues.filter((v) => !tableKeys.includes(v));
const notSelectable = tableKeys.filter((k) => !htmlValues.includes(k));
ok(notDeclared.length === 0, '设置页里的每个选项都在语义表里登记了（否则选它等于没判据）', notDeclared.join('，'));
ok(notSelectable.length === 0, '语义表里每个模式都在设置页里可选（否则它永远走不到）', notSelectable.join('，'));
eq(tableKeys.length, TABLE.length, '语义表的条目数与真值表对得上');

for (const o of opts) {
  const p = capturePlan(o.value);
  const doing = [p.save, p.copy, p.attach].filter(Boolean).length;
  // 「只 X」= 三件事里只做一件。改标签不改语义、或改了语义忘了改标签，这里都会红
  if (/^只/.test(o.label)) eq(doing, 1, `「${o.label}」说了「只」，那三件事里就只能做一件（实际做 ${doing} 件）`);
  if (o.label.includes('不复制')) eq(p.copy, false, `「${o.label}」说了不复制`);
  // 说了「带到对话框」就必须真的带
  if (o.label.includes('带到对话框')) eq(p.attach, true, `「${o.label}」说了带进对话框`);
  // 反过来：没提对话框的不许偷偷带
  if (!o.label.includes('对话框')) eq(p.attach, false, `「${o.label}」没提对话框，就不该把图带进去`);
}

// ============================================================
// 3. 默认值与未知取值
// ============================================================
section('3. 默认值与未知取值');

for (const v of [undefined, null, '']) {
  const p = capturePlan(v);
  eq(p.key, DEFAULT_AFTER, `空值（${String(v)}）退化成默认模式 ${DEFAULT_AFTER}`);
  eq(p.unknown, undefined, '空值不算「未知」，不该挂 unknown 标记');
}
eq(DEFAULT_AFTER, 'ask', '默认模式是设置页标着「推荐」的那一项');

for (const bad of ['ASK', 'Ask', 'copy', '保存', 'none2']) {
  const p = capturePlan(bad);
  eq(p.key, DEFAULT_AFTER, `未知取值 ${JSON.stringify(bad)} 退化成 ${DEFAULT_AFTER}`);
  eq(p.unknown, bad, `未知取值 ${JSON.stringify(bad)} 原始值被带出来（不许静默当成合法模式）`);
}
// 大小写不能靠巧合通过：'ASK' 必须走未知分支，而不是被 toLowerCase 悄悄认成 'ask'
eq(capturePlan('ASK').unknown, 'ASK', '大写 ASK 走的是未知分支，不是被悄悄归一');

// ============================================================
// 4. 接线锁：两个入口都必须走唯一判据，旧判据不得复活
// ============================================================
section('4. 接线锁（capture.js）');

const cap = stripComments(readSrc('src/main/capture.js'));
ok(/require\(\s*['"]\.\/capture-plan['"]\s*\)/.test(cap), 'capture.js 确实引入了唯一判据模块');
eq((cap.match(/capturePlan\s*\(/g) || []).length, 2, '全屏 / 区域两条路径各调用一次 capturePlan');
eq((cap.match(/plan\.save\s*\?/g) || []).length, 2, '两条路径的落盘都由 plan.save 决定');
ok(!/!==\s*'none'/.test(cap), '旧的 `after !== \'none\'` 判据不得复活（它正是「只存盘也占剪贴板」的来源）');
ok(!/after\s*===\s*'ask'/.test(cap), '旧的 `after === \'ask\'` 判据不得复活（它绕过了判据表）');
ok(!/captureAfter\s*\|\|\s*'ask'/.test(cap), "capture.js 里不许再自己写一份默认值（默认值只归 capture-plan.js）");

// 渲染层的提示必须按主进程回报的实际动作写，不许硬说存了个文件
const panel = stripComments(readSrc('src/renderer/js/panel.js'));
ok(/r\.copied/.test(panel), '「立即截图」的提示读了主进程回报的 copied');
ok(/已存到/.test(panel), '「立即截图」的提示读了主进程回报的 path');
ok(!/已截图：'\s*\+\s*\(r\.path\s*\|\|\s*''\)/.test(panel), '旧的「已截图 + path」写法不得复活（没落盘时会报一个空路径）');

// ---------------- 汇总 ----------------
console.log('\n' + '='.repeat(46));
const total = pass + fails.length + 1; // +1 = 下面这条自己
// 断言条数下限：解析面失灵或整块被删掉时，别让它「零断言全绿」
ok(total >= 30, `断言条数下限（${total} ≥ 30）`, '条数骤降说明有整组断言没跑起来');
if (fails.length) {
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`截图完成后的动作判据：通过 ${pass} / ${pass}`);
