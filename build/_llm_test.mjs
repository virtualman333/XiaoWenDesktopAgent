/**
 * 对话请求出口 —— 回归测试
 *
 * 为什么单独跑这个：程序里所有对话请求必须走流式。
 * 有些 OpenAI 兼容网关明确不支持非流式，直接回
 *   HTTP 400 · 11101 Non-stream chat request is currently not supported
 * 一旦哪个调用点写回 stream: false，用户就会在「测试连接」或编排规划时莫名其妙失败。
 * 这里既扫源码防回归，也起一个本地假服务端跑通流式收集的几条路径。
 *
 * 跑法：npm run test:llm
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { stripComments, residueErrors } from './_strip_comments.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const require = createRequire(import.meta.url);
const llm = require(path.join(ROOT, 'src', 'main', 'llm.js'));

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(
    (ok ? '  PASS  ' : '  FAIL  ') + name +
    (ok ? '' : `   (得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)})`)
  );
}

// ---------------- 1. 源码扫描：不许出现非流式请求 ----------------
console.log('\n源码扫描（禁止 stream: false）：');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

const offenders = [];
for (const f of walk(path.join(ROOT, 'src'))) {
  const txt = fs.readFileSync(f, 'utf8');
  if (/stream\s*:\s*false/.test(txt)) offenders.push(path.relative(ROOT, f));
}
check('src 下没有 stream: false', offenders, []);

const llmSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'llm.js'), 'utf8');
check('对话出口默认 stream: true', /stream:\s*true/.test(llmSrc), true);

// ---------------- 2. 起假服务端，跑真实请求 ----------------
const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body); } catch (e) { /* ignore */ }
    seen.push(j);
    const model = j.model || '';

    if (model === 'sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
      res.write(': keep-alive\n\n');                       // 注释行要能跳过
      res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    if (model === 'json') {                                 // 服务商忽略 stream，直接整包 JSON
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '整包回复' } }] }));
      return;
    }
    if (model === 'naked') {                                // 网关不写 data: 前缀
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('{"choices":[{"delta":{"content":"裸JSON"}}]}\n');
      res.end();
      return;
    }
    if (model === 'err') {                                  // 复现用户报的那个 400
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        code: 11101,
        msg: 'Non-stream chat request is currently not supported'
      }));
      return;
    }
    if (model === 'slow') return;                           // 不响应，测超时
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: [DONE]\n\n');
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

console.log('\n流式收集：');

const deltas = [];
const r1 = await llm.collectChat({
  baseUrl: base, apiKey: 'k', model: 'sse',
  messages: [{ role: 'user', content: 'hi' }],
  onDelta: (d) => deltas.push(d)
});
check('SSE 拼接结果', r1.text, '你好');
check('SSE ok', r1.ok, true);
check('onDelta 收到两片', deltas, ['你', '好']);
check('请求体带 stream: true', seen[0].stream, true);

const r2 = await llm.collectChat({
  baseUrl: base, apiKey: 'k', model: 'json',
  messages: [{ role: 'user', content: 'hi' }]
});
check('整包 JSON 兼容', [r2.ok, r2.text], [true, '整包回复']);

const r3 = await llm.collectChat({
  baseUrl: base, apiKey: 'k', model: 'naked',
  messages: [{ role: 'user', content: 'hi' }]
});
check('裸 JSON 行兼容', [r3.ok, r3.text], [true, '裸JSON']);

console.log('\n错误处理：');

const r4 = await llm.collectChat({
  baseUrl: base, apiKey: 'k', model: 'err',
  messages: [{ role: 'user', content: 'hi' }]
});
check('失败时 ok=false', r4.ok, false);
check('错误里保留服务端 msg', /Non-stream/.test(r4.error || ''), true);
check('错误里带 HTTP 400', /400/.test(r4.error || ''), true);
check('状态码透出', r4.status, 400);

const r5 = await llm.collectChat({
  baseUrl: base, apiKey: 'k', model: 'slow', timeoutMs: 250,
  messages: [{ role: 'user', content: 'hi' }]
});
check('超时会返回失败而不是卡死', r5.ok, false);

const r6 = await llm.collectChat({ baseUrl: base, model: 'sse', messages: [] });
check('缺 Key 直接报错', [r6.ok, /API Key/.test(r6.error || '')], [false, true]);

console.log('\n地址规整：');
check('去尾部斜杠', llm.normalizeBaseUrl('https://a.com/v1/'), 'https://a.com');
check('去 /v1', llm.normalizeBaseUrl('https://a.com/v1'), 'https://a.com');
check('保留路径', llm.normalizeBaseUrl(' https://a.com/api '), 'https://a.com/api');
check('空值安全', llm.normalizeBaseUrl(undefined), '');

// ---------------- 3. ★ 人设的唯一来源 ----------------
// 这一段钉的是一条用户能一路走到黑的路径：
//   设置页「人格与记忆」写的是 persona.json（jarvis/store.personaPrompt()），
//   而普通对话路径此前读的是 cfg.systemPrompt —— 一个**设置页里没有入口**的键，
//   只在 config.json 里，用户改不到。默认人设因此在两处各写一遍。
//   一旦走普通对话（agentEnabled=false，或模型不支持函数调用被自动降级），
//   用户在人格页填的一切就全部作废，而且没有任何提示。
console.log('\n人设的唯一来源：');

const promptLib = require(path.join(ROOT, 'src', 'main', 'jarvis', 'prompt.js'));

// 假 store：形状照 persona.json（设置页「人格与记忆」写的就是它）
const fakeStore = {
  personaPrompt: () => [
    '你是「小雅」，主人的私人助理。',
    '你的性格：爱开玩笑',
    '你的主人是「永贵」，你的一切能力都是为主人服务的。',
    '说话风格要求：\n用粤语回答'
  ].join('\n')
};

const sec = promptLib.personaSection(fakeStore, { systemPrompt: '' });
check('人设段带着用户填的名字', /小雅/.test(sec), true);
check('人设段带着用户填的称呼', /永贵/.test(sec), true);
check('人设段带着说话风格', /粤语/.test(sec), true);

const secExtra = promptLib.personaSection(fakeStore, { systemPrompt: '回答里不要出现 Markdown 符号' });
check('cfg.systemPrompt 作为追加项拼在人设之后',
  secExtra.startsWith(sec) && secExtra.includes('不要出现 Markdown 符号'), true);

// ★ 旧默认值：saveConfig 落盘的是**全量**配置，所以每一个已存在的 config.json 里
//   都躺着那句旧人设。升级后若照原样当追加项拼上去，人设里会平白多出一句
//   「名字叫「小问」」，跟 persona 给出的名字打架。
check('旧默认值常量在（迁移的前提）',
  typeof promptLib.LEGACY_SYSTEM_PROMPT === 'string' && promptLib.LEGACY_SYSTEM_PROMPT.includes('小问'), true);
const secLegacy = promptLib.personaSection(fakeStore, { systemPrompt: promptLib.LEGACY_SYSTEM_PROMPT });
check('★ 旧默认值不再拼进去', secLegacy === sec, true);
check('★ 丢掉旧默认值之后人设本体依然完整（解析面不许塌）', /小雅/.test(secLegacy), true);

// 坏 store 不许把整轮对话带走。
// ★ 这里必须自己接住异常：让它在断言里炸成 ERROR 的话，一条「崩溃」会被读成
//   「没红」—— 负向注入实测过，去掉 prompt.js 的 try/catch 后退出码是 1，但
//   一条 FAIL 都不出现。工具必须把异常折算成一条 FAIL，否则它是在假绿。
let throwCase = '';
try {
  throwCase = promptLib.personaSection(
    { personaPrompt: () => { throw new Error('persona.json 坏了'); } },
    { systemPrompt: '兜底指令' }
  );
} catch (e) {
  throwCase = `抛异常逃逸了：${e && e.message}`;
}
check('personaPrompt 抛异常时仍能拼出追加项', throwCase, '兜底指令');
check('store 为空 → 空串（调用方据此不放 system）', promptLib.personaSection(null, { systemPrompt: '' }), '');

const split = promptLib.splitSystemMessages([
  { role: 'system', content: '渲染层手拼的第二份人设' },
  { role: 'user', content: 'hi' }
]);
check('splitSystemMessages 摘出 system（要能数出来）', split.systems.length, 1);
check('splitSystemMessages 保留其余角色的顺序', split.rest.map((m) => m.role), ['user']);
check('非数组输入不炸',
  [promptLib.splitSystemMessages(undefined).systems.length, promptLib.splitSystemMessages(undefined).rest.length], [0, 0]);

// ---- 结构锁：两条路径必须真的接上这个唯一来源 ----
// 读源码判定，所以先剥注释 —— 本仓注释里正大光明地写着旧判据
// （prompt.js 的头注释里就写着 cfg.systemPrompt / role: 'system' 这些字样）。
const strip = (p) => stripComments(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const agentCode = strip('src/main/jarvis/agent.js');
check('★ agent 路径走 personaSection()', /promptLib\.personaSection\(store,\s*cfg\)/.test(agentCode), true);

const mainCode = strip('src/main/main.js');
check('★ 普通对话路径走 personaSection()（与 agent 同一份人设）',
  /promptLib\.personaSection\(jstore,\s*cfg\)/.test(mainCode), true);
check('★ 普通对话路径丢弃渲染层传来的 system',
  /promptLib\.splitSystemMessages\(messages\)/.test(mainCode), true);
check("★ DEFAULT_CONFIG.systemPrompt 不再是第二份人设（必须是空串）",
  /systemPrompt:\s*''/.test(mainCode), true);

const panelCode = strip('src/renderer/js/panel.js');
check('★ 渲染层不再读 cfg.systemPrompt', /cfg\.systemPrompt/.test(panelCode), false);
check("★ 渲染层不再自己拼 system 消息", /role:\s*['"]system['"]/.test(panelCode), false);

// 剥注释器自己也要出声 —— 否则上面四条会对着注释报绿
check('剥注释器在 panel.js 上没残留（判定面自证）',
  residueErrors(fs.readFileSync(path.join(ROOT, 'src/renderer/js/panel.js'), 'utf8'), panelCode), []);

server.close();
console.log('');
console.log(`对话出口：通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
