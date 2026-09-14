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

server.close();
console.log('');
console.log(`对话出口：通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
