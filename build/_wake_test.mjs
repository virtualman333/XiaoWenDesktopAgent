/**
 * 唤醒词匹配回归测试
 *
 * 为什么单独跑这个：唤醒命中/误报是全靠纯函数 matchWakeWord 决定的，
 * 而它又是最容易被改坏、且只能在真机上「靠嘴喊」才能验证的一环。
 * 这里把典型用例固化下来，改完匹配逻辑跑一遍就能知道有没有回归。
 *
 * 跑法：npm run test:wake
 *
 * 注：wake.js 是 ESM，但 package.json 没有 "type": "module"（主进程还是 CJS），
 * 所以这里先复制成 .mjs 再动态 import，跑完删掉。
 */

import { copyFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src', 'renderer', 'js', 'wake.js');
const tmp = path.join(here, '_wake_tmp.mjs');

copyFileSync(src, tmp);
let mod;
try {
  mod = await import(pathToFileURL(tmp).href);
} finally {
  try { rmSync(tmp); } catch {}
}

const { matchWakeWord, DEFAULT_WAKE_WORDS } = mod;
const words = DEFAULT_WAKE_WORDS;

// [识别文本, 是否应该命中]
// 说明：中文 ASR 常把「小问」写成小文/小闻/小吻/晓雯，这些必须能命中；
//       而「小问题」「小问号」这种日常表达必须拦住，否则会频繁误唤醒。
const cases = [
  ['小问', true],
  ['小文', true],
  ['小闻', true],
  ['小吻', true],
  ['你好小问', true],
  ['小问小问', true],
  ['小 问 在吗', true],
  ['小问，今天天气怎么样', true],
  ['晓雯帮我查一下', true],
  ['小问同学', true],
  ['小吻小吻', true],

  ['小问题不大', false],
  ['小问号是什么', false],
  ['帮我订个外卖', false],
  ['请问现在几点', false],
  ['温度多少', false],
  ['这本书不错', false],
  ['', false],
  ['   ', false]
];

let pass = 0;
let fail = 0;

for (const [text, expect] of cases) {
  const hit = !!matchWakeWord(text, words);
  const ok = hit === expect;
  if (ok) pass++;
  else fail++;
  const got = hit ? '命中' : '未命中';
  const want = expect ? '命中' : '未命中';
  console.log(
    (ok ? '  PASS  ' : '  FAIL  ') + '"' + text + '" -> ' + got +
    (ok ? '' : '   (期望 ' + want + ')')
  );
}

console.log('');
console.log('唤醒词匹配：通过 ' + pass + ' / ' + (pass + fail));
process.exit(fail ? 1 : 0);
