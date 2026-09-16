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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const clip = require('../src/main/clip-sense.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0; const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else fails.push(name + (extra ? ` → ${extra}` : '')); };
const eq = (a, b, name) => ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
/** 安全取值：断言里不要出现 `x.y[0].z` —— 被测对象坏掉时它会先抛 TypeError，
 *  于是「报出问题」变成「脚本崩了」，反而看不出是哪条锁断了。 */
const pick = (obj, ...path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
/** 安全取 summary 字段：被测对象坏掉（ok:false、summary 缺失）时给兜底值，
 *  否则断言自己会抛 TypeError，把「哪条锁断了」盖成「脚本崩了」。 */
const at = (r, key, fallback) => {
  const v = r && r.summary ? r.summary[key] : undefined;
  return v === undefined ? fallback : v;
};
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

// ---------------- 可配置规则 ----------------
// 内置 5 类覆盖的是通用开发者场景；公司内部日志前缀、内部域名这些只能由主人自己配。
// 下面这一组锁三件事：配置真的生效、配置写错不会崩、以及**安全边界不可配置**。

const CORP_LOG = '[corp] 内部服务超时 trace_id=abc123 重试3次';
const INTRANET_URL = 'https://intranet.corp.example.com/wiki/page/1234';
const A_SECRET = 'api_key = "abcdef1234567890"';
const AN_ERROR = 'TypeError: boom\n  at x (a.js:1)';

section('可配置规则 · 自定义类型');
{
  const rules = clip.compileRules({
    customKinds: [
      {
        id: 'corp-log',
        label: '公司日志',
        pattern: '^\\[corp\\]',
        flags: 'm',
        title: '这段公司日志要我看看吗？',
        ask: '帮我分析这段公司日志。'
      }
    ]
  });
  eq(rules.warnings.length, 0, '合法配置不产生警告');

  const r = clip.classifyClipboard(CORP_LOG, rules);
  eq(r.worth, true, '自定义类型能命中');
  eq(r.kind, 'corp-log', 'kind 用配置里的 id');
  eq(r.title, '这段公司日志要我看看吗？', '标题用配置里的');

  // 自定义优先于内置：同一段文本内置也会判成 error
  const both = clip.classifyClipboard('[corp] 2026-09-16 ERROR 内部服务超时 trace_id=abc123', rules);
  eq(both.kind, 'corp-log', '自定义类型优先于内置的 error');

  // 不命中时退回内置判定
  eq(clip.classifyClipboard(AN_ERROR, rules).kind, 'error', '不命中自定义时仍走内置');

  // 不传规则时行为与加配置之前完全一致
  eq(clip.classifyClipboard(CORP_LOG).worth, false, '不传规则时自定义类型不生效');
  eq(clip.classifyClipboard(AN_ERROR).kind, 'error', '不传规则时内置判定不变');
}

section('可配置规则 · 关闭内置类型');
{
  eq(clip.classifyClipboard(INTRANET_URL).kind, 'url', '默认认链接');

  const off = clip.compileRules({ disableKinds: ['url'] });
  eq(clip.classifyClipboard(INTRANET_URL, off).worth, false, '关掉 url 后链接不再提示');
  eq(clip.classifyClipboard(AN_ERROR, off).kind, 'error', '只关 url，不影响 error');

  const bad = clip.compileRules({ disableKinds: ['url', 'nonexistent'] });
  eq(bad.warnings.length, 1, '未知类型产生一条警告');
  eq(bad.disableKinds.join(','), 'url', '合法的那个照常生效');
  eq(clip.classifyClipboard(INTRANET_URL, bad).worth, false, '混合配置下 url 仍被关掉');
}

section('可配置规则 · 凭证识别不可配置（安全边界）');
{
  // 这是本组最重要的断言：配置只能决定「认什么」，不能决定「什么绝对不能提示」。
  const r = clip.compileRules({ disableKinds: ['secret'] });
  ok(r.warnings.length > 0, 'disableKinds 里的 secret 被拒绝并给出警告');
  eq(r.disableKinds.length, 0, '没有任何内置类型被关掉');
  const hit = clip.classifyClipboard(A_SECRET, r);
  eq(hit.kind, 'secret', '凭证仍然被识别');
  eq(hit.worth, false, '凭证仍然不提示');
  eq(hit.preview, '', '凭证仍然不给预览');

  // 黑名单与自定义类型也不能让凭证变得可见
  const r2 = clip.compileRules({
    ignorePatterns: ['abcdef'],
    customKinds: [{ id: 'pretend', pattern: 'api_key' }]
  });
  eq(clip.classifyClipboard(A_SECRET, r2).kind, 'secret', '凭证判定先于 ignorePatterns 与 customKinds');

  // 自定义类型不能占用内置 id（secret / ignore / 5 类）
  for (const id of ['secret', 'ignore', 'error', 'url']) {
    const bad = clip.compileRules({ customKinds: [{ id, pattern: 'x' }] });
    ok(bad.warnings.length > 0 && bad.custom.length === 0, `customKinds 用内置 id「${id}」被拒绝`);
  }
}

section('可配置规则 · 永不提示黑名单');
{
  const both = {
    ignorePatterns: ['trace_id='],
    customKinds: [{ id: 'corp-log', label: '公司日志', pattern: '^\\[corp\\]' }]
  };
  // 先确认不配黑名单时自定义类型确实会命中
  const noIgnore = clip.compileRules({ customKinds: [{ id: 'corp-log', label: '公司日志', pattern: '^\\[corp\\]' }] });
  eq(clip.classifyClipboard(CORP_LOG, noIgnore).kind, 'corp-log', '确认自定义类型本可命中');

  eq(clip.classifyClipboard(CORP_LOG, clip.compileRules(both)).worth, false, '黑名单命中即静默（压过自定义类型）');
  eq(clip.classifyClipboard(AN_ERROR, clip.compileRules(both)).kind, 'error', '黑名单不影响其它内容');
}

section('可配置规则 · g/y 标志必须去掉');
{
  const rules = clip.compileRules({
    customKinds: [{ id: 'grule', label: 'G', pattern: 'corp', flags: 'gi' }]
  });
  eq(rules.custom.length, 1, '带 g 标志的规则仍可用');
  eq(rules.custom[0].re.flags.includes('g'), false, '编译结果不含 g（test 会交替命中）');
  // 带 g 的正则有 lastIndex 状态，连续 test() 会一次命中一次不命中 —— 三次都必须命中
  const kinds = [0, 1, 2].map(() => clip.classifyClipboard(CORP_LOG, rules).kind);
  eq(kinds.join(','), 'grule,grule,grule', '连续判定结果稳定');
}

section('可配置规则 · 写岔了也不能崩');
{
  const CASES = [
    ['正则编译不过', { customKinds: [{ id: 'bad', pattern: '[' }] }],
    ['正则为空', { customKinds: [{ id: 'bad', pattern: '   ' }] }],
    ['正则超长', { customKinds: [{ id: 'bad', pattern: 'x'.repeat(201) }] }],
    ['flags 非法', { customKinds: [{ id: 'bad', pattern: 'x', flags: 'q' }] }],
    ['缺 id', { customKinds: [{ pattern: 'x' }] }],
    // 这里的 pattern 要挑不会误命中探针文本的（首版用了 'x'，而 AN_ERROR 里有「at x」，
    // 于是规则正常命中、被误判成「规则写错时内置判定失常」——是用例本身的问题）
    ['重复 id', { customKinds: [{ id: 'a', pattern: 'zq1' }, { id: 'a', pattern: 'zq2' }] }],
    ['不是对象', { customKinds: [42] }],
    ['ignore 里混入数字', { ignorePatterns: [123] }],
    ['整个配置不是对象', 'not-an-object'],
    ['配置是数组', [1, 2]]
  ];
  for (const [name, raw] of CASES) {
    let rules = null;
    let threw = null;
    try {
      rules = clip.compileRules(raw);
    } catch (e) {
      threw = e;
    }
    ok(!threw, `compileRules 不抛异常：${name}`, threw && threw.message);
    ok(rules && Array.isArray(rules.warnings), `返回结构完整：${name}`);

    let r = null;
    let threw2 = null;
    try {
      r = clip.classifyClipboard(AN_ERROR, rules);
    } catch (e) {
      threw2 = e;
    }
    ok(!threw2 && r && r.kind === 'error', `规则写错时内置判定照常：${name}`, threw2 && threw2.message);
  }

  for (const [name, raw] of [['undefined', undefined], ['null', null], ['空对象', {}]]) {
    const r = clip.compileRules(raw);
    eq(r.warnings.length, 0, `缺省配置无警告：${name}`);
    eq(r.disableKinds.length, 0, `缺省配置无禁用：${name}`);
    eq(r.custom.length, 0, `缺省配置无自定义：${name}`);
  }

  const many = clip.compileRules({
    customKinds: Array.from({ length: 25 }, (_, i) => ({ id: 'k' + i, pattern: 'p' + i }))
  });
  eq(many.custom.length, 20, '自定义类型条数截到上限 20');
  ok(many.warnings.some((w) => w.includes('上限')), '超上限会给出警告');
}

section('可配置规则 · 自定义类型的问法');
{
  const rules = clip.compileRules({
    customKinds: [{ id: 'corp-log', label: '公司日志', pattern: '^\\[corp\\]', ask: '帮我分析这段公司日志。' }]
  });

  const one = clip.buildClipQuestion('corp-log', '[corp] 内部服务超时', rules);
  ok(one.question.startsWith('帮我分析这段公司日志。'), '用配置里的问法');
  ok(one.question.includes('[corp] 内部服务超时'), '内容带上了');
  ok(!one.question.includes('```'), '单行不加围栏');
  ok(one.hint.includes('公司日志'), '提示里带类型名');

  const multi = clip.buildClipQuestion('corp-log', '[corp] a\n[corp] b', rules);
  ok(multi.question.includes('```'), '多行加围栏');

  // 没配 ask 时用兜底问法（带 label），不能退回中性说法
  const r2 = clip.compileRules({ customKinds: [{ id: 'x1', label: '内部域名', pattern: 'a' }] });
  const q = clip.buildClipQuestion('x1', 'https://a.internal/x', r2);
  ok(q.question.includes('内部域名'), '兜底问法带类型名');
  eq(q.hint.includes(clip.NEUTRAL_HINT), false, '自定义类型不走中性兜底');

  // 内置类型仍然用自己的模板（没被自定义逻辑带偏）
  eq(clip.buildClipQuestion('error', AN_ERROR, rules).hint, clip.ASK_TEMPLATES.error.hint, '内置类型模板不变');
  eq(clip.buildClipQuestion('url', INTRANET_URL).question.includes('```'), false, '内置链接仍不加围栏');
}

section('可配置规则 · 热替换与容错');
{
  let text = INTRANET_URL;
  const seen = [];
  const w = clip.createClipSense({ readClip: () => text, onSuggest: (h) => seen.push(h.kind), cooldownMs: 0 });

  ok(w.checkNow() !== null, '默认规则下链接命中');
  eq(w.checkNow(), null, '同一段内容不重复提示');

  w.setRules(clip.compileRules({ disableKinds: ['url'] }));
  eq(w.checkNow(), null, '换规则后不会把刚看过的内容再弹一次');

  text = 'https://other.example.com/page/99';
  eq(w.checkNow(), null, '换规则后新链接不再命中');
  eq(seen.join(','), 'url', '全程只提示了一次');

  w.setRules(clip.compileRules({}));
  text = 'https://third.example.com/page/1';
  ok(w.checkNow() !== null, '换回默认规则后新链接恢复命中');
  eq(seen.join(','), 'url,url', '共提示两次');

  // 规则对象本身炸掉时，轮询器不能跟着停摆（主进程的定时器崩了就是整只宠物停摆）
  const boom = new Proxy(
    {},
    {
      get() {
        throw new Error('规则对象炸了');
      }
    }
  );
  const hits = [];
  const w2 = clip.createClipSense({ readClip: () => text, rules: boom, onSuggest: (h) => hits.push(h.kind), cooldownMs: 0 });
  let threw = null;
  let out = 'sentinel';
  try {
    out = w2.checkNow();
  } catch (e) {
    threw = e;
  }
  ok(!threw, '规则对象抛异常时不外泄', threw && threw.message);
  eq(out, null, '异常那一轮返回 null');
  eq(hits.length, 0, '异常那一轮没有误触发提示');

  w2.setRules(clip.compileRules({}));
  w2.forget();
  ok(w2.checkNow() !== null, '换回正常规则后轮询器照常工作');
  eq(hits.length, 1, '恢复正常后只提示一次');
}

// ---------------- 设置界面：规则文本校验 ----------------
// 界面上那段 JSON 由主进程校验（parseRulesText），规则知识只有一份。
// 这里钉两件事：① 语法/结构错误必须**拦住保存**；② 写错字段名这类
// 「校验通过但实际不生效」的情况必须给出**点名到字段**的警告 —— 旧实现是静默忽略的，
// 用户只会觉得「我明明填了」。
section('设置界面 · 规则文本校验');

{
  // 空文本 = 只用内置 5 类，不算错误
  const r = clip.parseRulesText('');
  ok(r.ok, '空文本视为「不用自定义规则」，不算错误');
  eq(r.warnings.length, 0, '空文本没有警告');
  eq(at(r, 'activeKinds', []).join(','), 'error,json,url,code,longtext', '空规则下 5 个内置类型都在提示');
  eq(at(r, 'ignoreCount', -1), 0, '空规则下忽略正则 0 条');
  eq(at(r, 'custom', []).length, 0, '空规则下自定义类型 0 个');

  const rws = clip.parseRulesText('   \n  ');
  ok(rws.ok, '纯空白同空文本');
}

{
  // 一份完整可用的规则：必须零警告（警告通道不能有噪音，否则真警告会被忽略）
  const text = JSON.stringify({
    disableKinds: ['url'],
    ignorePatterns: ['^\\[内部\\]'],
    customKinds: [
      { id: 'corp-log', label: '公司日志', pattern: '^\\[corp\\]', flags: 'im', ask: '帮我分析这段公司日志。' }
    ]
  });
  const r = clip.parseRulesText(text);
  ok(r.ok, '完整规则校验通过');
  eq(r.warnings.length, 0, '完整规则零警告');
  eq(at(r, 'disabledKinds', []).join(','), 'url', '摘要反映已关闭的内置类型');
  ok(!at(r, 'activeKinds', []).includes('url'), '摘要里 url 已不在「仍然提示」之列');
  eq(at(r, 'ignoreCount', -1), 1, '摘要里忽略正则 1 条');
  eq(at(r, 'custom', []).length, 1, '摘要里自定义类型 1 个');
  eq(pick(r, 'summary', 'custom', 0, 'label'), '公司日志', '摘要带出自定义类型的 label');
  eq(pick(r, 'value', 'disableKinds', 0), 'url', 'value 是原样解析出的对象（保存时字段不丢）');
}

{
  // 语法 / 结构错误：必须 ok=false（界面据此拒绝保存）
  const bad = [
    ['JSON 少个括号', '{"disableKinds": ["url"'],
    ['JSON 用了单引号', "{'disableKinds': ['url']}"],
    ['尾逗号', '{"disableKinds": ["url",]}'],
    ['是数组', '[1, 2, 3]'],
    ['是 null', 'null'],
    ['是数字', '123'],
    ['是字符串', '"disableKinds"']
  ];
  for (const [name, text] of bad) {
    const r = clip.parseRulesText(text);
    eq(r.ok, false, `拦下：${name}`);
    ok(!!r.error, `有错误说明：${name}`);
  }
  ok(/JSON/.test(clip.parseRulesText('{').error), 'JSON 语法错误给出「JSON」字样');
  ok(/对象/.test(clip.parseRulesText('[1]').error), '结构错误说明「必须是对象」');
}

{
  // ★ 未知字段：校验通过但要**点名**报警（旧实现静默忽略，规则一条都不生效却什么都不说）
  const r = clip.parseRulesText('{"ignorePattern": ["^\\\\[内部\\\\]"]}');
  ok(r.ok, '未知字段不算致命错误（配置仍可用）');
  eq(r.warnings.length, 1, '未知字段给出 1 条警告');
  ok(String(pick(r, 'warnings', 0) || '').includes('ignorePattern'), '警告点名到具体字段', pick(r, 'warnings', 0));
  eq(at(r, 'ignoreCount', -1), 0, '写错的字段确实没有生效（摘要如实显示 0 条）');
}

{
  // 数组形式的 clipSenseRules
  const r = clip.compileRules(['error']);
  eq(r.warnings.length, 1, '数组形式给 1 条警告');
  ok(/数组/.test(r.warnings[0]), '警告说明「应该是对象」', r.warnings[0]);
  eq(r.disableKinds.length, 0, '数组形式按空规则处理');
}

{
  // 凭证不可关：可以被保存，但必须明确告知这条被拒绝，且内置类型不受影响
  const r = clip.parseRulesText('{"disableKinds": ["secret"]}');
  ok(r.ok, 'disableKinds 写 secret 不算语法错误');
  eq(r.warnings.length, 1, 'secret 被拒绝时给 1 条警告');
  ok(/secret/.test(r.warnings[0]), '警告里点出 secret', r.warnings[0]);
  eq(at(r, 'disabledKinds', []).length, 0, '实际一个内置类型都没被关闭');
  ok(at(r, 'activeKinds', []).includes('error'), '内置类型照常提示');
}

{
  // 非法正则：与 compileRules 同一套警告（界面不自己判）
  const r = clip.parseRulesText('{"ignorePatterns": ["("]}');
  ok(r.ok, '非法正则不致命（该条被丢掉，其余规则仍生效）');
  eq(r.warnings.length, 1, '非法正则给 1 条警告');
  ok(/正则/.test(r.warnings[0]), '警告说明正则问题', r.warnings[0]);
  eq(at(r, 'ignoreCount', -1), 0, '非法正则没进生效列表');

  const r2 = clip.parseRulesText('{"ignorePatterns": ["^ok$", "("]}');
  eq(at(r2, 'ignoreCount', -1), 1, '一条坏正则不影响另一条好正则生效');
}

{
  // 自定义类型的 id 冲突 / 缺字段：都在摘要里如实反映
  const r = clip.parseRulesText(
    JSON.stringify({ customKinds: [{ id: 'error', pattern: 'x' }, { pattern: 'y' }, { id: 'ok-one', pattern: 'z' }] })
  );
  ok(r.ok, 'id 冲突不算致命');
  eq(at(r, 'custom', []).length, 1, '只有合法的那一条生效');
  eq(pick(r, 'summary', 'custom', 0, 'id'), 'ok-one', '生效的是合法条目');
  eq(r.warnings.length, 2, '另外两条各给一条警告');
}

// ---------------- 判定理由：不提示也要说得清为什么 ----------------
// 「不提示」原先只有一种表达，于是主人没有任何办法知道该改哪里：写了自定义规则却
// 不生效，可能只是前面有条忽略正则先命中了。现在原因与「命中的是什么」都要带上。
section('判定理由 · 不提示的五种原因要分得开');
{
  const CASES = [
    ['空内容', '', 'empty', 'length'],
    ['纯空白', '   \n\t ', 'empty', 'length'],
    ['太短', '好的', 'too-short', 'length'],
    ['疑似凭证', 'api_key = "abcdef1234567890"', 'secret', 'secret'],
    ['认不出', '今天天气不错要不要一起去吃饭啊', 'unrecognized', 'none']
  ];
  for (const [name, input, reason, stage] of CASES) {
    const r = clip.classifyClipboard(input);
    eq(r.worth, false, `不提示：${name}`);
    eq(r.reason, reason, `理由分得开：${name}`);
    eq(r.stage, stage, `判定阶段正确：${name}`);
  }
}

{
  // 命中「永不提示」正则：必须说清是哪一条把内容拦下的 —— 否则主人会去改错的规则
  const rules = clip.compileRules({ ignorePatterns: ['^\\[内部\\]'] });
  const r = clip.classifyClipboard('[内部] 这段内容不该提示，后面还有一长串说明文字', rules);
  eq(r.worth, false, '忽略正则命中 → 不提示');
  eq(r.reason, 'ignored', '理由是 ignored');
  eq(r.stage, 'ignore', '判定阶段是 ignore');
  ok(r.detail.includes('内部'), 'detail 指出是哪条正则', r.detail);
}

{
  // 命中被 disableKinds 关掉的内置类型：要说清是哪一类被自己关了
  const rules = clip.compileRules({ disableKinds: ['longtext'] });
  const r = clip.classifyClipboard('这是一段很长的内容。'.repeat(30), rules);
  eq(r.worth, false, '关掉长文本 → 不提示');
  eq(r.reason, 'disabled', '理由是 disabled（而不是「认不出」）');
  eq(r.stage, 'builtin', '判定阶段是内置类型');
  eq(r.detail, '长文本', 'detail 用显示名指出被关掉的是哪一类');
}

{
  // 关掉一类不能让另一类跟着失效：诊断信息不许溢出成行为
  const rules = clip.compileRules({ disableKinds: ['longtext'] });
  const t = 'TypeError: x is not a function\n' + 'y'.repeat(400);
  const r = clip.classifyClipboard(t, rules);
  eq(r.worth, true, '关掉长文本不影响报错命中');
  eq(r.kind, 'error', '仍判为报错');
  eq(r.reason, 'hit', '命中的是 hit，不该报成 disabled');
}

{
  // 自定义类型命中：detail 是主人自己写的 label
  const rules = clip.compileRules({
    customKinds: [{ id: 'corp-log', label: '公司日志', pattern: '^\\[corp\\]', title: '这段公司日志要我看看吗？' }]
  });
  const r = clip.classifyClipboard('[corp] 2026-09-16 16:20 订单服务超时，重试 3 次后失败', rules);
  eq(r.worth, true, '自定义类型命中 → 提示');
  eq(r.kind, 'corp-log', 'kind 是自定义 id');
  eq(r.stage, 'custom', '判定阶段是 custom');
  eq(r.detail, '公司日志', 'detail 用主人自己起的名字');
}

{
  // 内置类型命中：detail 直接用显示名，界面不必再翻译一次
  const r = clip.classifyClipboard('TypeError: Cannot read properties of undefined');
  eq(r.reason, 'hit', '命中理由');
  eq(r.stage, 'builtin', '命中阶段');
  eq(r.detail, '报错', 'detail 是显示名');
}

// ---------------- 试跑：设置界面「拿一段内容试试」按的就是它 ----------------
section('试跑 · 设置界面的「拿一段内容试试」');
{
  const r = clip.testRules('TypeError: Cannot read properties of undefined', '');
  ok(r.ok, '试跑成功');
  eq(pick(r, 'verdict', 'worth'), true, '试跑判定会提示');
  eq(pick(r, 'verdict', 'label'), '报错', 'verdict 带显示名（界面不自己翻译）');
  eq(pick(r, 'verdict', 'stage'), 'builtin', 'verdict 带判定阶段');
  ok(!!pick(r, 'verdict', 'reasonText'), 'verdict 带人话理由');
  ok(String(pick(r, 'verdict', 'question') || '').includes('TypeError'), 'verdict 带会填进输入框的问法');
}

{
  // 试跑的问法必须与真提示走同一个函数：另写一份演示文案等于给主人看假结论
  const t = 'TypeError: a is not a function';
  const r = clip.testRules(t, '');
  const direct = clip.buildClipQuestion('error', t, clip.compileRules({}));
  eq(pick(r, 'verdict', 'question'), direct.question, '试跑的问法与真提示同一个来源');
  eq(pick(r, 'verdict', 'title'), clip.classifyClipboard(t).title, '试跑的横幅文案与真提示一致');
}

{
  // 未保存的规则也要能试 —— 试跑看的就是界面里那份文本，不是落盘的那份
  const text = '[corp] 2026-09-16 16:20 订单服务超时，重试 3 次后失败';
  const off = clip.testRules(text, '');
  eq(pick(off, 'verdict', 'worth'), false, '不配规则时这段认不出来');
  const on = clip.testRules(text, JSON.stringify({
    customKinds: [{
      id: 'corp-log', label: '公司日志', pattern: '^\\[corp\\]',
      title: '这段公司日志要我看看吗？', ask: '帮我分析这段公司日志。'
    }]
  }));
  eq(pick(on, 'verdict', 'worth'), true, '配上自定义规则后就能认出');
  eq(pick(on, 'verdict', 'label'), '公司日志', 'verdict 用自定义的 label');
  eq(pick(on, 'verdict', 'stage'), 'custom', '判定阶段是 custom');
  ok(String(pick(on, 'verdict', 'question') || '').includes('帮我分析这段公司日志'), '自定义的 ask 参与生成问法');
}

{
  // 规则文本坏了 → 试跑短路，把 JSON 错误原样带出来（界面显示同一句话）
  const bad = clip.testRules('x'.repeat(50), '{ 坏 JSON');
  eq(bad.ok, false, '规则文本坏了 → 试跑短路');
  ok(/JSON/.test(String(bad.error)), '短路时把 JSON 错误带出来', String(bad.error));
}

{
  // 规则「能解析但有毛病」不该让试跑失败：警告照给，判定照做
  const r = clip.testRules('TypeError: a is not a function', '{"disableKinds": ["secret"]}');
  eq(r.ok, true, '写 secret 不影响试跑');
  eq(r.warnings.length, 1, '试跑把规则警告一起带出来');
  ok(!!(r.labels && r.labels.error), '试跑结果里带内置类型显示名（界面唯一来源）');
}

{
  // 试跑是只读的：连试几次结论必须一样，且不污染全局规则
  const a = clip.testRules('TypeError: a', '{"disableKinds": ["error"]}');
  const b = clip.testRules('TypeError: a', '{"disableKinds": ["error"]}');
  eq(pick(a, 'verdict', 'worth'), pick(b, 'verdict', 'worth'), '两次试跑结论一致');
  eq(pick(b, 'verdict', 'reason'), 'disabled', '被关掉的报错报成 disabled');
  eq(clip.classifyClipboard('TypeError: a').worth, true, '试跑没有污染不传规则时的默认行为');
}

// ---------------- 规则的导入 / 导出 ----------------
// 导出必须先过校验：一份自己都编译不过的规则导出出去，导入方只会看到
// 「JSON 语法错误」，而真正的原因（哪条正则写错了）留在了导出方 —— 最该被告知的
// 那个人反而什么都看不到。
section('导入导出 · 导出前先校验，且导出的是「当前输入框里那一份」');
{
  const good = clip.rulesExportText(JSON.stringify({ disableKinds: ['url'] }));
  eq(good.ok, true, '合法规则可导出');
  eq(good.empty, false, '有内容时不是空规则集');
  ok(/\n$/.test(String(good.text)), '导出文本以换行结尾（diff 里不出现 no newline 提示）');
  // 关键：导出的文本必须能被原样读回来，且摘要完全一致
  const back = clip.parseRulesText(good.text);
  eq(back.ok, true, '导出的文本能被重新解析');
  eq(
    JSON.stringify(clip.summarizeRules(clip.compileRules(back.value))),
    JSON.stringify(clip.summarizeRules(clip.compileRules(JSON.parse(good.text)))),
    '导出的文本解析回来语义不变'
  );

  const bad = clip.rulesExportText('{ 这不是 JSON }');
  eq(bad.ok, false, '语法错误时不导出');
  ok(!bad.text, '失败时不给出文本（免得调用方顺手写盘）');
  ok(/JSON/.test(String(bad.error)), '失败原因要说清是 JSON 的问题', bad.error);

  const arr = clip.rulesExportText('[1,2]');
  eq(arr.ok, false, '顶层是数组时不导出');

  const empty = clip.rulesExportText('');
  eq(empty.ok, true, '空规则也能导出（相当于「重置为默认」的模板）');
  eq(empty.empty, true, '空规则要标记 empty');
  eq(
    empty.warnings.filter((w) => /空规则集/.test(w)).length,
    1,
    '空规则必须有一句人话提醒，不能让人以为导出了一份配置'
  );

  // 写坏的条目能被导出的警告带出来（而不是静默丢掉）
  const withWarn = clip.rulesExportText('{"ignorePatterns": ["("], "unknownField": 1}');
  eq(withWarn.ok, true, '有写坏的条目仍可导出（规则本身是合法 JSON）');
  eq(withWarn.warnings.length, 2, '两条警告都要带出来（正则编译不了 + 未知字段）', JSON.stringify(withWarn.warnings));
}

section('导入导出 · 默认文件名');
{
  eq(clip.rulesExportName(new Date(2026, 8, 16)), 'clip-sense-rules-20260916.json', '月/日补零，用本地日期');
  eq(clip.rulesExportName(new Date(2026, 0, 5)), 'clip-sense-rules-20260105.json', '一月五日补零正确');
  // 传进来的不是 Date（或被调用方写坏）时退回今天，而不是拼出 NaN
  const t = clip.rulesExportName('nonsense');
  ok(/^clip-sense-rules-\d{8}\.json$/.test(t), '非法入参退回当天日期而不是 NaN', t);
  const bad = clip.rulesExportName(new Date('x'));
  ok(/^clip-sense-rules-\d{8}\.json$/.test(bad), 'Invalid Date 也退回当天', bad);
}

section('导入导出 · 文件大小上限存在且是一个有限数');
{
  ok(typeof clip.MAX_RULES_FILE_BYTES === 'number' && clip.MAX_RULES_FILE_BYTES > 0, '有上限');
  ok(clip.MAX_RULES_FILE_BYTES <= 1024 * 1024, '上限不超过 1MB（规则文件是手写的）', String(clip.MAX_RULES_FILE_BYTES));
}

// ---------------- 一致性：显示名与判定链都不许有第二份 ----------------
section('一致性 · 显示名与判定链都只有一份');
{
  // BUILTIN_LABELS 必须与 BUILTIN_KINDS 一一对应。将来新增一类时漏配显示名，
  // 界面会静默显示原始 id —— 这条断言就是那个「会报错的东西」。
  const missing = clip.BUILTIN_KINDS.filter((k) => !clip.BUILTIN_LABELS[k]);
  eq(missing.length, 0, '每个内置类型都有显示名', missing.join(','));
  const extra = Object.keys(clip.BUILTIN_LABELS).filter((k) => !clip.BUILTIN_KINDS.includes(k));
  eq(extra.length, 0, 'BUILTIN_LABELS 没有多余条目（多余就是第二份清单）', extra.join(','));
}
{
  // 每种「不提示」的理由都要有人话，否则界面只能把 reason 这种内部词印给用户
  const REASONS = ['hit', 'empty', 'too-short', 'secret', 'ignored', 'disabled', 'unrecognized'];
  const missing = REASONS.filter((r) => !clip.REASON_TEXT[r]);
  eq(missing.length, 0, '每种理由都有文案', missing.join(','));
}

{
  const strip = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')          // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');     // 行注释（避开 http://）
  const read = (p) => strip(fs.readFileSync(path.join(ROOT, p), 'utf-8'));

  // 渲染进程不得再维护一份内置类型显示名（第 6 轮就是这么删掉 CLIP_KIND_LABELS 的）
  const panel = read(path.join('src', 'renderer', 'js', 'panel.js'));
  ok(!/CLIP_KIND_LABELS/.test(panel), 'panel.js 不再自己维护内置类型显示名');
  ok(!/\[\s*'error'\s*,\s*'json'/.test(panel), 'panel.js 里没有第二份内置类型清单');
  ok(/clipRulesTest\s*\(/.test(panel), 'panel.js 的试跑走主进程（clipRulesTest）');
  ok(/clipboardRead\s*\(/.test(panel), '「用剪贴板里的内容」走主进程读剪贴板');

  // 主进程侧：判定链只允许 clip-sense.js 一份
  const main = read(path.join('src', 'main', 'main.js'));
  ok(/clip:test/.test(main), 'main.js 注册了 clip:test');
  ok(/clipSense\.testRules\s*\(/.test(main), 'clip:test 复用 clipSense.testRules，不自己实现判定链');

  const preload = read(path.join('src', 'main', 'preload.js'));
  ok(/clipRulesTest/.test(preload), 'preload 暴露了 clipRulesTest');
  ok(/invoke\(\s*'clip:test'/.test(preload), 'preload 指向 clip:test');

  // ---- 规则的导入 / 导出：四处接线缺一处就静默失效 ----
  // 这类「新增一条 IPC」的漏接是无声的：少写 preload 就报 undefined is not a function，
  // 少写 html 就是按钮点不到（更没有任何报错）。所以四处都钉住。
  const sense = read(path.join('src', 'main', 'clip-sense.js'));
  ok(/clip:rules-export/.test(main), 'main.js 注册了 clip:rules-export');
  ok(/clip:rules-import/.test(main), 'main.js 注册了 clip:rules-import');
  ok(/clipSense\.rulesExportText\s*\(/.test(main), '导出走 clipSense.rulesExportText，不在 IPC 里另写一份校验');
  ok(/showSaveDialog/.test(main) && /showOpenDialog/.test(main), '导入导出用系统文件对话框');
  ok(/MAX_RULES_FILE_BYTES/.test(main), '导入有大小上限（引的是 clip-sense.js 的常量，不是就地写死的数）');
  ok(/rulesExportName\s*\(/.test(main), '默认文件名来自 clipSense.rulesExportName');
  // preload 里是对象字面量（`clipRulesExport: (text) => ...`），名字与括号之间有冒号，
  // 所以这里不能照抄 panel.js 那条 `名字(` 的写法 —— 那样永远匹配不上。
  ok(/clipRulesExport\s*:\s*\(/.test(preload), 'preload 暴露了 clipRulesExport');
  ok(/clipRulesImport\s*:\s*\(/.test(preload), 'preload 暴露了 clipRulesImport');
  ok(/clipRulesExport\s*\(/.test(panel), 'panel.js 调了 clipRulesExport');
  ok(/clipRulesImport\s*\(/.test(panel), 'panel.js 调了 clipRulesImport');
  const html = read(path.join('src', 'renderer', 'panel.html'));
  ok(/id="clipRulesExport"/.test(html), 'panel.html 有导出按钮');
  ok(/id="clipRulesImport"/.test(html), 'panel.html 有导入按钮');
  ok(/\$\('clipRulesExport'\)/.test(panel) && /\$\('clipRulesImport'\)/.test(panel), '两个按钮都绑了事件');

  // 导入**不许自动生效**：换机器时最怕「导进来一份不对的规则直接生效」—— 那样连
  // 原来的规则都没了，而且没有任何提示。导入只填进输入框，写配置的路径始终只有
  // 用户自己点「保存规则」这一条。
  //
  // 切片边界取到下一个分节注释（`// ---- 拿一段内容试试 ----`），而不是固定字数：
  // 字数窗口会随排版漂移，而分节注释就是这一段的结束位置。
  const impAt = panel.indexOf("$('clipRulesImport')");
  const impEnd = panel.indexOf('// ---- 拿一段内容试试', impAt);
  const impBlock = impAt < 0 ? '' : panel.slice(impAt, impEnd < 0 ? impAt + 1600 : impEnd);
  ok(impAt > -1 && impBlock.length > 200, 'panel.js 里有导入按钮的处理块', String(impBlock.length));
  ok(
    !/setConfig/.test(impBlock) && !/saveClipRules\s*\(/.test(impBlock),
    '导入只填进输入框，不自动保存（写配置的路径只有「保存规则」一条）'
  );

  // 内置类型清单只允许有一份，且必须**派生**自显示名表。
  // 只断言「两张表一一对应」是不够的：照抄一份完全相同的数组也能通过，
  // 而漂移从下一次新增类型才开始。
  ok(!/const\s+BUILTIN_KINDS\s*=\s*\[/.test(sense), 'BUILTIN_KINDS 不是手写数组');
  ok(/const\s+BUILTIN_KINDS\s*=\s*Object\.keys\(\s*BUILTIN_LABELS\s*\)/.test(sense), 'BUILTIN_KINDS 由 BUILTIN_LABELS 派生');
}

// ---------------- 汇总 ----------------
console.log('\n' + '='.repeat(46));
if (fails.length) {
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`剪贴板感知：通过 ${pass} / ${pass}`);
