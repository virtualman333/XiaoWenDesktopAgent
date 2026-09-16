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

// ---------------- 预置问法 ----------------
// 内容被带进输入框时若是裸文本，主人还得自己打一句「帮我看看这段报错」——
// 而「复制这段」本身就表达了意图。这里锁住：问法按类型给、内容一字不改。
section('问法 · 按类型预置，且内容原样保留');
{
  const ERR = 'TypeError: Cannot read properties of undefined (reading "id")\n    at render (panel.js:42:11)\n    at tick (index.js:9:3)';
  const CODE = 'const a = 1;\nfunction f() {\n  return a + 1;\n}\nexport default f;';
  const JSON_TXT = '{\n  "a": 1,\n  "b": [2, 3]\n}';
  const URLS = 'https://github.com/virtualman333/vui';
  const LONG = 'x'.repeat(260);

  const cases = [
    ['error', ERR],
    ['code', CODE],
    ['json', JSON_TXT],
    ['url', URLS],
    ['longtext', LONG]
  ];

  for (const [kind, src] of cases) {
    const r = clip.buildClipQuestion(kind, src);
    ok(!!r.question, `${kind}：能生成问法`);
    ok(r.question.includes(src), `${kind}：内容原样保留（不截断、不转义）`);
    eq(r.question, r.question.trim(), `${kind}：问法首尾无多余空白`);
    ok(r.question.length > src.length, `${kind}：问法在内容之外还带了意图说明`);
    ok(r.hint && r.hint !== clip.NEUTRAL_HINT, `${kind}：提示语按类型给出`);
    eq(clip.buildClipQuestion(kind, src).question, r.question, `${kind}：纯函数，两次调用一致`);
  }

  // 链接不加围栏：加了反而没法直接点
  const urlQ = clip.buildClipQuestion('url', URLS);
  ok(!urlQ.question.includes('```'), 'url：不加代码围栏');

  // 有结构的内容要包起来，模型才能分清「哪段是给我的材料」
  for (const kind of ['error', 'code', 'json', 'longtext']) {
    ok(clip.buildClipQuestion(kind, 'y'.repeat(60)).question.includes('```'), `${kind}：用代码围栏包住内容`);
  }
}

section('问法 · 围栏不与内容里的反引号打架');
{
  // 粘来的代码自己带 ``` 时，等长围栏会被提前闭合，后面的内容跑到代码块外面去
  const inner = '说明：\n```js\nconst a = 1;\n```\n就这些';
  const r = clip.buildClipQuestion('code', inner);
  ok(r.question.includes(inner), '含 ``` 的内容原样保留');

  const bars = r.question.match(/`{3,}/g) || [];
  const outer = bars.filter((b) => !inner.includes(b));
  ok(outer.length >= 2, '外层围栏成对出现', `反引号串：${JSON.stringify(bars)}`);
  const innerMax = Math.max(...(inner.match(/`+/g) || []).map((s) => s.length));
  // 取不到就不比长度：断言要报出问题，不该自己抛异常
  ok(outer.length > 0 && outer[0].length > innerMax, '外层围栏比内容里最长的一段反引号更长',
    outer.length ? `外 ${outer[0].length} vs 内 ${innerMax}` : '取不到外层围栏');

  // 内容里没有任何反引号时，用最短的合规围栏
  ok(clip.buildClipQuestion('code', 'z'.repeat(60)).question.includes('\n```\n'), '无反引号时用三连反引号');
}

section('问法 · 退化输入');
{
  for (const [name, v] of [['空串', ''], ['null', null], ['undefined', undefined], ['纯空白', '   \n ']]) {
    const r = clip.buildClipQuestion('error', v);
    eq(r.question, '', `无内容时问法为空：${name}`);
    eq(r.hint, '', `无内容时提示为空：${name}`);
  }

  // 认不出的类型：原样文本 + 中性提示，不硬套一个问法
  const unknown = clip.buildClipQuestion('ignore', 'w'.repeat(60));
  eq(unknown.question, 'w'.repeat(60), '未知类型：内容原样');
  eq(unknown.hint, clip.NEUTRAL_HINT, '未知类型：中性提示');
  ok(!!clip.buildClipQuestion(undefined, 'q'.repeat(60)).question, '缺 kind 也不炸');

  // 尾部空白（复制时常带）不该进到问句里
  const padded = clip.buildClipQuestion('code', 'v'.repeat(60) + '\n\n  ');
  ok(padded.question.endsWith('v'.repeat(20) + '\n```'), '尾部空白已裁掉，围栏紧贴内容');
}

// ---------------- 汇总 ----------------
console.log('\n' + '='.repeat(46));
if (fails.length) {
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`剪贴板感知：通过 ${pass} / ${pass}`);
