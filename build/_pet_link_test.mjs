/**
 * 宠物 × Agent 联动 —— 回归测试
 *
 * 为什么单独跑这个：联动的「演什么」全靠 AGENT_ACT 这张表和 toolLabel 的翻译，
 * 它们决定宠物在思考/调工具/完成/失败时分别做什么、气泡里念什么。
 * 真机上要盯着宠物看半天才能发现「工具名念错了」「完成时不跳了」，
 * 这里把映射固化下来，改坏了一跑就知道。
 *
 * 跑法：npm run test:pet
 *
 * 注：pet.js 是 ESM，但 package.json 没有 "type": "module"（主进程还是 CJS），
 * 所以先复制成 .mjs 再动态 import；同时给它塞一个最小 DOM 桩，
 * 免得模块顶层就去 document.getElementById。
 */

import { copyFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src', 'renderer', 'js', 'pet.js');
const tmp = path.join(here, '_pet_tmp.mjs');

// 最小 DOM 桩：让 pet.js 停在「等 DOMContentLoaded」，不会真的 init
globalThis.document = {
  readyState: 'loading',
  addEventListener() {},
  getElementById() { return null; },
  createElement() { return { style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} }; }
};
globalThis.window = {};

copyFileSync(src, tmp);
let mod;
try {
  mod = await import(pathToFileURL(tmp).href);
} finally {
  try { rmSync(tmp, { force: true }); } catch (e) { /* ignore */ }
}

const { AGENT_ACT, toolLabel } = mod;

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log(
    (ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '' : `   (得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)})`)
  );
}

console.log('\n宠物联动状态映射：');

// 每个动作都必须定义，且「忙碌态」与「收尾动作」不能同时存在
const expect = {
  think: { busy: 'busy-think', tip: '思考中' },
  work: { busy: 'busy-work', tip: '干活中' },
  listen: { busy: 'busy-listen', tip: '聆听中' },
  done: { busy: '', tip: '' },
  error: { busy: '', tip: '' },
  idle: { busy: '', tip: '' }
};

for (const [act, want] of Object.entries(expect)) {
  const meta = AGENT_ACT[act];
  check(`动作 ${act} 已定义`, !!meta, true);
  if (meta) {
    check(`  ${act}.busy`, meta.busy, want.busy);
    check(`  ${act}.tip`, meta.tip, want.tip);
  }
}

// 收尾动作（完成/失败）不能留下持续演出，否则宠物会一直转圈
check('done 不带持续演出', AGENT_ACT.done.busy, '');
check('error 不带持续演出', AGENT_ACT.error.busy, '');
check('idle 不带持续演出', AGENT_ACT.idle.busy, '');
// 未知动作必须安全退化成 idle，而不是 undefined 崩掉
check('未知动作退化为 idle', (AGENT_ACT.foobar || AGENT_ACT.idle).busy, '');

console.log('\n工具名翻译：');

const toolCases = [
  ['read_file', '读文件'],
  ['write_file', '写文件'],
  ['run_command', '跑命令'],
  ['web_search', '搜网页'],
  ['get_time', '看时间'],
  ['mcp:desktop:take_screenshot', 'take_screenshot'], // 认不出的：去掉前缀原样念
  ['list_dir', '翻目录'],
  ['', ''],
  ['   ', ''],
  [undefined, '']
];

for (const [name, want] of toolCases) {
  check(`toolLabel(${JSON.stringify(name)})`, toolLabel(name), want);
}

console.log('');
console.log(`宠物联动：通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
