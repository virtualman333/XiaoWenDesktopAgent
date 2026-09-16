/**
 * 剪贴板感知回归测试 —— node build/_clip_sense_test.mjs
 *
 * 这个模块的失效代价不对称，所以两类断言都要有：
 *   - 漏报：主人复制了报错却没提示，功能等于没有（功能性问题）；
 *   - 误报：把 API Key / 密码当成「要看看吗」提示出来，密钥就被印在
 *     系统通知横幅上了，收不回来（隐私问题）。
 * 后者比前者严重得多，所以凭证识别是逐个样例钉死的。
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const clip = require('../src/main/clip-sense.js');

let pass = 0; const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else fails.push(name + (extra ? ` → ${extra}` : '')); };
const eq = (a, b, name) => ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
const section = (s) => console.log('\n' + s);

// ---------------- 分类：不该提示的 ----------------
section('分类 · 不该提示的');
const SILENT = [
  ['空字符串', ''],
  ['null', null],
  ['undefined', undefined],
  ['纯空白', '   \n  \t '],
  ['太短', '好的'],
  ['短句', '今天天气不错'],
  ['纯数字', '1234567890123'],
  ['两行短文本（不足 3 行不算代码）', 'SELECT 1\nFROM dual']
];
for (const [name, input] of SILENT) {
  const r = clip.classifyClipboard(input);
  eq(r.worth, false, `不提示：${name}`);
}

// ---------------- 分类：凭证必须闭嘴 ----------------
section('分类 · 疑似凭证（绝不提示）');
const SECRETS = [
  ['api_key 赋值', 'api_key = "abcdef1234567890"'],
  ['API-KEY 短横线写法', 'API-KEY: abcdef1234567890'],
  ['password 赋值', 'password = hunter2hunter2'],
  ['access_token', 'access_token: ya29.abcdefghijklmn'],
  ['Authorization Bearer', 'Authorization: Bearer abcdefghijklmnop'],
  ['OpenAI 风格 sk-', 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345'],
  ['GitHub token', 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
  ['npm token', 'npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
  ['AWS key', 'AKIAIOSFODNN7EXAMPLE'],
  ['阿里云 key', 'LTAI5tAbCdEfGhIjKlMnOpQr'],
  ['私钥', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'],
  ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U']
];
for (const [name, input] of SECRETS) {
  const r = clip.classifyClipboard(input);
  eq(r.worth, false, `凭证不提示：${name}`);
  eq(r.kind, 'secret', `凭证判为 secret：${name}`);
  eq(r.preview, '', `凭证不给预览：${name}`);
}

// 凭证优先于类型判断：一段报错里夹着 token，也不能提示
const secretInError = 'Error: 401 Unauthorized\n  at request (client.js:42)\napi_key = "sk-proj-AbCdEfGhIjKlMnOpQrStUv"';
eq(clip.classifyClipboard(secretInError).kind, 'secret', '报错里夹凭证 → 仍按凭证处理');

// ---------------- 分类：该提示的 ----------------
section('分类 · 该提示的');
const SHOULD = [
  ['Node 异常', { kind: 'error' }, 'TypeError: Cannot read properties of undefined (reading \'map\')'],
  ['Node 栈帧', { kind: 'error' }, 'something broke\n    at Object.<anonymous> (/app/index.js:10:15)'],
  ['Python Traceback', { kind: 'error' }, 'Traceback (most recent call last):\n  File "a.py", line 1\nValueError: bad'],
  ['编译错误', { kind: 'error' }, 'error[E0308]: mismatched types\n --> src/main.rs:3:5'],
  ['URL', { kind: 'url' }, 'https://github.com/virtualman333/vui/releases/tag/v1.2.0'],
  ['JSON', { kind: 'json' }, '{\n  "name": "vui",\n  "version": "1.2.0"\n}'],
  ['JS 代码', { kind: 'code' }, 'const a = 1;\nfunction run() {\n  return a;\n}'],
  ['Python 代码', { kind: 'code' }, 'def calc(x):\n    total = 0\n    return total + x'],
  ['SQL', { kind: 'code' }, 'SELECT id, name\nFROM users\nWHERE age > 18'],
  ['长文本', { kind: 'longtext' }, '小问'.repeat(120)]
];
for (const [name, expect, input] of SHOULD) {
  const r = clip.classifyClipboard(input);
  eq(r.worth, true, `提示：${name}`);
  eq(r.kind, expect.kind, `类型正确：${name}`);
  ok(r.title.length > 0, `有提示文案：${name}`);
}

// ---------------- 预览 ----------------
section('预览片段');
{
  const long = 'TypeError: ' + 'x'.repeat(300);
  const r = clip.classifyClipboard(long);
  const plain = long.replace(/\s+/g, ' ').trim();
  eq(r.preview, plain.slice(0, clip.MAX_PREVIEW) + '…', '超长内容截断并加省略号');
  eq(r.preview.length, clip.MAX_PREVIEW + 1, '预览长度受控');

  const multiline = 'const a = 1;\nconst b = 2;\nconst c = 3;';
  ok(!clip.classifyClipboard(multiline).preview.includes('\n'), '预览里换行被压成空格');
}

// ---------------- 轮询器 ----------------
section('轮询器 · 去重与冷却');
{
  let clock = 1000;
  let clipText = '';
  const hits = [];
  const sense = clip.createClipSense({
    readClip: () => clipText,
    onSuggest: (hit, text) => hits.push({ kind: hit.kind, text }),
    now: () => clock,
    intervalMs: 500,
    cooldownMs: 20000
  });

  eq(sense.isRunning(), false, '未 start 时不运行');
  sense.start();
  eq(sense.isRunning(), true, 'start 后运行中');
  sense.start();
  eq(sense.isRunning(), true, '重复 start 幂等');

  clipText = 'TypeError: boom at line 1';
  sense.checkNow();
  eq(hits.length, 1, '首次命中回调一次');

  sense.checkNow();
  eq(hits.length, 1, '内容没变 → 不重复提示');

  clock += 30000;
  sense.checkNow();
  eq(hits.length, 1, '内容没变 → 冷却过了也不重复');

  clipText = 'Traceback (most recent call last):\n  File "x.py", line 2\nValueError: nope';
  sense.checkNow();
  eq(hits.length, 2, '换了内容且冷却已过 → 提示');

  clipText = 'https://example.com/a/very/long/path';
  sense.checkNow();
  eq(hits.length, 2, '冷却期内换内容也不提示');

  clock += 21000;
  sense.checkNow();
  eq(hits.length, 2, '冷却结束后不补提冷却期内已翻篇的旧内容（翻篇就是翻篇）');

  clipText = 'Traceback (most recent call last):\n  File "y.py", line 9\nKeyError: k';
  sense.checkNow();
  eq(hits.length, 3, '冷却结束后遇到新内容恢复提示');

  sense.stop();
  eq(sense.isRunning(), false, 'stop 后停止');
}

section('轮询器 · 忽略与容错');
{
  let clipText = '好的';
  const hits = [];
  const sense = clip.createClipSense({
    readClip: () => clipText,
    onSuggest: () => hits.push(1),
    now: () => 1e9,
    cooldownMs: 0
  });
  sense.checkNow();
  eq(hits.length, 0, '不值得问的内容不回调');
  clipText = '';
  sense.checkNow();
  eq(hits.length, 0, '空剪贴板不回调');

  // 读取抛错（剪贴板被别的程序占着）不能让轮询崩
  const broken = clip.createClipSense({
    readClip: () => { throw new Error('clipboard busy'); },
    onSuggest: () => hits.push(2),
    cooldownMs: 0
  });
  let threw = false;
  try { broken.checkNow(); broken.checkNow(); } catch (e) { threw = true; }
  eq(threw, false, '读取抛错时静默跳过，不向上抛');
  eq(hits.length, 0, '读取失败不误触发提示');

  // onSuggest 自己抛错也不该让轮询停摆
  const evil = clip.createClipSense({
    readClip: () => 'TypeError: x is not a function',
    onSuggest: () => { throw new Error('handler boom'); },
    cooldownMs: 0
  });
  let threw2 = false;
  try { evil.checkNow(); } catch (e) { threw2 = true; }
  eq(threw2, false, '回调抛错被吞掉，不影响下一轮');
}

section('轮询器 · forget');
{
  let clipText = 'TypeError: same content again';
  const hits = [];
  const sense = clip.createClipSense({
    readClip: () => clipText,
    onSuggest: () => hits.push(1),
    now: () => 1e9,
    cooldownMs: 0
  });
  sense.checkNow();
  eq(hits.length, 1, '首次提示');
  sense.checkNow();
  eq(hits.length, 1, '同内容不再提示');
  sense.forget();
  sense.checkNow();
  eq(hits.length, 2, 'forget 后同一内容可再次提示（主人手动问过一次的场景）');
}

// ---------------- 汇总 ----------------
console.log('\n' + '='.repeat(46));
if (fails.length) {
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`剪贴板感知：通过 ${pass} / ${pass}`);
