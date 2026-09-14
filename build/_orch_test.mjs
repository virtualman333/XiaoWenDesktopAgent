/**
 * 子代理编排回归测试 —— node build/_orch_test.mjs
 *
 * 用最小桩件把 Electron / fetch 顶掉，验证：
 *   规则预判、JSON 脏解析、任务拆解、并发执行、失败重试、
 *   子代理请示 → 小问拍板、结果复核、汇总报告、中断。
 */
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ---------------- 桩：electron ----------------
const fakeElectron = {
  app: {
    getPath: () => '/tmp/xw-test',
    getVersion: () => '1.5.0',
    isPackaged: false,
    getAppPath: () => '/tmp/xw-test'
  },
  shell: { openPath: () => true, showItemInFolder: () => {}, openExternal: () => {} },
  clipboard: { readText: () => '', writeText: () => {}, writeImage: () => {} },
  Notification: function () { return { show: () => {} }; },
  screen: { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, id: 1 }), getAllDisplays: () => [] },
  nativeImage: { createFromPath: () => ({ toPNG: () => Buffer.alloc(0) }) },
  ipcMain: { handle: () => {}, on: () => {}, once: () => {}, removeAllListeners: () => {}, removeHandler: () => {} },
  BrowserWindow: function () { return { isDestroyed: () => true, webContents: { send: () => {} } }; },
  BrowserWindowCtor: null,
  globalShortcut: { register: () => true, unregister: () => {}, unregisterAll: () => {} },
  desktopCapturer: { getSources: async () => [] }
};
fakeElectron.BrowserWindow.getAllWindows = () => [];

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, arguments);
};

// ---------------- 桩：fetch ----------------
let fetchLog = [];
let fetchHandler = null;
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body || '{}');
  const sys = (body.messages || []).find((m) => m.role === 'system');
  const user = (body.messages || []).find((m) => m.role === 'user');
  fetchLog.push({ url, sys: (sys && sys.content) || '', user: (user && user.content) || '' });
  const out = fetchHandler ? fetchHandler({ sys: (sys && sys.content) || '', user: (user && user.content) || '' }) : '{}';
  // 现在所有对话请求都走流式（见 src/main/llm.js），桩件也按流式返回
  const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: out } }] }) + '\n\n'
    + 'data: [DONE]' + '\n\n';
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    text: async () => sse,
    body: new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); }
    })
  };
};

// ---------------- 加载被测模块 ----------------
const agent = require('../src/main/jarvis/agent.js');
const orch = require('../src/main/jarvis/orchestrator.js');

// ---------------- 断言 ----------------
let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

function makeSender() {
  const events = [];
  return {
    events,
    isDestroyed: () => false,
    send: (ch, p) => events.push({ ch, p })
  };
}

const CFG = {
  apiBaseUrl: 'https://example.com/v1',
  apiKey: 'sk-test',
  model: 'test-model',
  orchMaxTasks: 6,
  orchMaxWorkers: 2,
  orchRetry: 1,
  petAgentLink: false
};

// ---------------- 1. 规则预判 ----------------
section('1. 常任务规则预判');
ok(orch.looksLikeBigJob('现在几点了') === false, '短问答不该拆');
ok(orch.looksLikeBigJob('帮我把下载目录里所有 pdf 按月份整理到文件夹'), '== true');
ok(orch.looksLikeBigJob('帮我检查磁盘里大于 1G 的文件并列出前二十个'), '== true');
ok(orch.looksLikeBigJob('每天 9 点帮我汇总一次桌面新文件'), '== true');
ok(orch.looksLikeBigJob('翻译成英文：你好') === false, '翻译类不拆');

// ---------------- 2. JSON 脏解析 ----------------
section('2. 模型输出 JSON 解析');
ok(orch.parseJson('{"a":1}')?.a === 1, '纯 JSON');
ok(orch.parseJson('```json\n{"a":2}\n```')?.a === 2, '代码块包裹');
ok(orch.parseJson('好的，我的计划如下：\n{"a":3}\n以上')?.a === 3, '前后有废话');
ok(orch.parseJson('{"a":4,}')?.a === 4, '末尾多余逗号');
ok(orch.parseJson('完全不是 JSON') === null, '非 JSON 返回 null');
ok(orch.parseJson('') === null, '空串返回 null');

// ---------------- 3. 拆解任务 ----------------
section('3. 小问拆解任务');
fetchHandler = () => JSON.stringify({
  needSplit: true,
  reason: '要跑好几步',
  tasks: [
    { title: '扫文件', instruction: '扫描下载目录，列出所有 pdf' },
    { title: '分类', instruction: '按月份归类' },
    { title: '写报告', instruction: '生成一份清单' },
    { title: '', instruction: '' }
  ]
});
{
  const sender = makeSender();
  const o = new orch.Orchestrator({ cfg: CFG, sender });
  const plan = await o.plan('帮我把下载目录的 pdf 按月份整理好');
  ok(plan.needSplit === true, '判定为需要拆分');
  ok(plan.tasks.length === 3, '空任务被过滤，剩 3 个', String(plan.tasks.length));
  ok(plan.tasks[0].title === '扫文件', '标题正确');
  ok(!!plan.tasks[0].id, '任务有 id');
  ok(plan.tasks.every((t) => t.status === 'pending'), '初始状态 pending');
}

fetchHandler = () => JSON.stringify({ needSplit: false, reason: '一句话就能答' });
{
  const o = new orch.Orchestrator({ cfg: CFG, sender: makeSender() });
  const plan = await o.plan('现在几点');
  ok(plan.needSplit === false, '单步问题不拆分');
  ok(plan.reason.includes('一句话'), '带上理由');
}

fetchHandler = () => '这不是 JSON';
{
  const o = new orch.Orchestrator({ cfg: CFG, sender: makeSender() });
  const plan = await o.plan('帮我整理下载目录');
  ok(plan.needSplit === false, '解析失败时安全回退为不拆分');
}

// ---------------- 4. 全流程：子代理干活 ----------------
section('4. 编排全流程（子代理执行 + 汇总）');
let workerCalls = 0;
agent.runAgent = async ({ opts }) => {
  workerCalls++;
  ok(!!opts.quiet, '子代理静默输出（不刷主人面板）', 'quiet');
  ok(Array.isArray(opts.extraTools) && opts.extraTools[0].function.name === 'ask_supervisor', '子代理拿到请示工具');
  ok(opts.dropTools.includes('delegate_task'), '子代理不再有派活工具（防套娃）');
  ok(/子代理/.test(opts.systemExtra || ''), '子代理有自己的角色指令');
  return { ok: true, text: `第 ${workerCalls} 个任务干完了` };
};
fetchHandler = ({ sys }) => {
  if (/主管「小问」.*汇报|向主人汇报/.test(sys)) return '三个任务都办好了，清单在下载目录。';
  return JSON.stringify({
    needSplit: true, reason: '多步',
    tasks: [{ title: '扫文件', instruction: 'A' }, { title: '归类', instruction: 'B' }, { title: '出报告', instruction: 'C' }]
  });
};
{
  const sender = makeSender();
  const o = new orch.Orchestrator({ cfg: CFG, sender });
  const r = await o.run('帮我整理下载目录');
  ok(r.delegated === true, '走的是编排路径');
  ok(workerCalls === 3, '3 个子任务都执行了', String(workerCalls));
  ok(r.tasks.filter((t) => t.status === 'done').length === 3, '全部标记完成');
  ok(/扫文件/.test(r.text) && /归类/.test(r.text), '报告里列出派了哪些活');
  ok(/三个任务都办好了/.test(r.text), '报告里有小问的汇总');
  ok(r.ok === true, '整体成功');

  const chs = sender.events.map((e) => e.ch);
  ok(chs.includes('orch:plan'), '广播了任务计划');
  ok(chs.filter((c) => c === 'orch:task').length >= 3, '广播了任务状态');
  ok(chs.includes('orch:done'), '广播了收工事件');
  const deltas = sender.events.filter((e) => e.ch === 'chat:delta').map((e) => e.p).join('');
  ok(/拆成 3 个任务/.test(deltas), '对话流里告诉主人派了活');
}

// ---------------- 5. 子代理请示 → 小问优先决策 ----------------
section('5. 子代理请示，小问拍板');
let intercepted = null;
fetchHandler = ({ sys }) => {
  if (/子代理.*请示|来请示你/.test(sys)) return '就按月份归类，别动原文件。';
  if (/向主人汇报/.test(sys)) return '搞定。';
  return JSON.stringify({ needSplit: true, tasks: [{ title: '归类', instruction: '把文件按月份归类' }] });
};
agent.runAgent = async ({ opts }) => {
  if (opts && opts.intercept) {
    intercepted = await opts.intercept('ask_supervisor', { question: '原文件是移动还是复制？', options: ['移动', '复制'] });
    const unknown = await opts.intercept('shell_exec', { command: 'dir' });
    ok(unknown === null, '非请示类工具交回正常执行');
  }
  return { ok: true, text: '归好类了' };
};
{
  const sender = makeSender();
  const o = new orch.Orchestrator({ cfg: CFG, sender });
  await o.run('把文件按月份归类');
  ok(!!intercepted && /主管决定/.test(intercepted.content), '请示被小问接住并给出决定');
  ok(/就按月份归类/.test(intercepted.content), '决定内容正确');
  const asks = sender.events.filter((e) => e.ch === 'orch:ask');
  ok(asks.length === 2, '广播了「提问中 + 已答复」两条', String(asks.length));
  ok(asks[0].p.status === 'asking' && asks[1].p.status === 'answered', '状态流转正确');
}

// ---------------- 6. 失败重试 + 监督复核 ----------------
section('6. 监督：复核不通过就重试');
let attempts = 0;
agent.runAgent = async () => {
  attempts++;
  return { ok: true, text: attempts < 2 ? '没找到文件' : '找到了，已整理' };
};
fetchHandler = ({ sys }) => {
  if (/是否达成了任务目标/.test(sys)) return JSON.stringify({ pass: attempts >= 2, reason: attempts >= 2 ? '达成了' : '什么都没找到' });
  if (/向主人汇报/.test(sys)) return '第二次成了。';
  return JSON.stringify({ needSplit: true, tasks: [{ title: '找文件', instruction: 'X' }] });
};
{
  const o = new orch.Orchestrator({ cfg: CFG, sender: makeSender() });
  const r = await o.run('去找那个文件');
  ok(attempts === 2, '失败后重试了一次', String(attempts));
  ok(r.tasks[0].status === 'done', '重试后成功');
  ok(r.tasks[0].attempt === 2, '记录尝试次数');
}

// 一直失败 → 标记 failed，不把主人卡死
section('7. 一直失败也要收尾汇报');
attempts = 0;
agent.runAgent = async () => { attempts++; return { ok: false, error: '工具报错' }; };
fetchHandler = ({ sys }) => {
  if (/是否达成了任务目标/.test(sys)) return JSON.stringify({ pass: false, reason: '工具报错' });
  if (/向主人汇报/.test(sys)) return '没办成，工具一直报错。';
  return JSON.stringify({ needSplit: true, tasks: [{ title: '坏任务', instruction: 'Y' }] });
};
{
  const o = new orch.Orchestrator({ cfg: { ...CFG, orchRetry: 1 }, sender: makeSender() });
  const r = await o.run('干个必定失败的事');
  ok(attempts === 2, '按重试上限跑了 2 次', String(attempts));
  ok(r.tasks[0].status === 'failed', '标记为失败');
  ok(r.ok === false, '整体判定失败');
  ok(/没办成/.test(r.text), '仍然给了主人汇报');
}

// ---------------- 8. 中断 ----------------
section('8. 中断');
agent.runAgent = async () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, text: 'x' }), 50));
fetchHandler = () => JSON.stringify({ needSplit: true, tasks: [{ title: '慢任务', instruction: 'Z' }] });
{
  const o = new orch.Orchestrator({ cfg: CFG, sender: makeSender() });
  const p = o.run('慢慢干');
  setTimeout(() => o.abort(), 10);
  const r = await p;
  ok(o.aborted === true, '中断标记生效');
  ok(Array.isArray(r.tasks), '中断后依然返回结果');
}

// ---------------- 9. 单任务派活（delegate_task） ----------------
section('9. 对话中单独派一个活');
agent.runAgent = async () => ({ ok: true, text: '已帮忙下载并归档' });
fetchHandler = () => '归档完成';
{
  const sender = makeSender();
  const r = await orch.delegateOnce({
    title: '下载归档', instruction: '把日志打包', context: '在 D 盘',
    cfg: CFG, sender
  });
  ok(r.ok === true, '派活成功');
  ok(/已帮忙下载并归档/.test(r.output), '带回子代理结果');
  ok(sender.events.some((e) => e.ch === 'orch:plan'), '看板能看到这个任务');
  ok(sender.events.some((e) => e.ch === 'orch:done'), '看板收到完成事件');
}

// ---------------- 汇总 ----------------
console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
