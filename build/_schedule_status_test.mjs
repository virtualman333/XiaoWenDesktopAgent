/**
 * 调度状态（排队 / 并发 / 未来触发 / 运行历史）的判据测试 —— node build/_schedule_status_test.mjs
 *
 * 被测对象是 `src/main/jarvis/schedule.js` 的 `status()`。它返回六样东西，
 * 而此前**没有任何东西在扛它们**：`status()` 只在 `jarvis:schedules` 这个 IPC 里
 * 被拼进一个大对象，渲染层一次都没读过（`src/renderer/js/panel.js` 只调
 * `scheduleList()`），于是：
 *
 *   · 「排队几个 / 并发上限几个」界面上没有 —— 主人看到「跑一次」点了没反应，
 *     其实任务只是排在队里；
 *   · 「接下来 5 次分别几点跑」也没有 —— 只能干等；
 *   · 「最近 20 条运行记录」也没有 —— 面板只拿 `lastResult` 显示最后一条。
 *
 * 还有一处真缺陷：面板自己维护的 `schRunning` 是**本地乐观标记**，只在收到
 * start/done 事件时更新。面板一重载它就是空的，正在跑的任务被显示成空闲，
 * 「跑一次」按钮也重新可点 —— 而主进程的 `running` 一直是对的。
 *
 * 所以这里钉两层：
 *   1) 真跑 —— 用假 store + 可控的假 agent 顶掉 I/O 与模型，**调度逻辑本身是真的**：
 *      真加任务、真并发限流、真排队、真 pump、真落运行历史；
 *   2) 渲染层确实读了它 —— 这一层是源码级判据（本仓没法在这里起 Electron），
 *      只保证「接了且用到了 DOM」，不保证画出来好不好看。
 */
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0; const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else fails.push(name + (extra ? ` → ${extra}` : '')); };
const eq = (a, b, name) => ok(
  JSON.stringify(a) === JSON.stringify(b), name,
  `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`
);
const section = (s) => console.log('\n' + s);

/* 取数组里的第 i 项。**越界不许抛异常** —— 注入缺陷后集合会变空，
   写 `arr[i].foo` 会让整条测试进程崩掉，输出里只剩一段堆栈：
   红是红了，但看不出红的是哪条判据，负向验证会把它记成 MISS。
   （第 4 轮的教训：断言应报告问题，而不是自己炸掉。） */
const at = (arr, i) => (arr && arr[i]) || {};

/** 造一个「真的模块对象」塞进 require.cache —— 用它顶掉 store / agent 的 I/O 与模型 */
function fakeModule(id, exports) {
  const m = new Module(id);
  m.filename = id;
  m.loaded = true;
  m.exports = exports;
  return m;
}

// ---- 假 store：内存里的文件系统 ----
const disk = new Map();
const storePath = require.resolve('../src/main/jarvis/store.js');
require.cache[storePath] = fakeModule(storePath, {
  readJson: (f, dflt) => (disk.has(f) ? JSON.parse(JSON.stringify(disk.get(f))) : JSON.parse(JSON.stringify(dflt))),
  writeJson: (f, val) => { disk.set(f, JSON.parse(JSON.stringify(val))); return true; }
});

// ---- 假 agent：可控的闸门，能卡住「正在跑」这个中间态 ----
let gate = null;
let agentCalls = 0;
let agentResult = { ok: true, text: '结论：今天晴。' };
const agentPath = require.resolve('../src/main/jarvis/agent.js');
require.cache[agentPath] = fakeModule(agentPath, {
  runAgent: async () => {
    agentCalls += 1;
    if (gate) await gate;
    return typeof agentResult === 'function' ? agentResult() : agentResult;
  }
});

const schedule = require('../src/main/jarvis/schedule.js');

let CFG = { apiKey: 'k', model: 'm', schedConcurrency: 2 };
const delivered = [];
const events = [];              // 主进程发给渲染层的事件（start / done / drop）
schedule.bind({
  getConfig: () => CFG,
  log: () => {},
  deliver: (p) => delivered.push(p),
  event: (p) => events.push(p)
});

/** 让出若干轮微任务，等异步执行链推到下一步 */
const flush = async (n = 8) => { for (let i = 0; i < n; i += 1) await Promise.resolve(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一个「每 N 分钟」的任务，返回 id */
function addEvery(title, minutes) {
  const r = schedule.add({ title, prompt: `${title} 的提示词`, when: { type: 'interval', minutes } });
  return r.task.id;
}

// ── 1. 空状态：每个字段都要有明确的初值（别把「没有」显示成 undefined） ──

section('1. 空状态的六个字段');
{
  const s = schedule.status();
  eq(s.total, 0, 'total');
  eq(s.active, 0, 'active');
  eq(s.queued, 0, 'queued');
  eq(s.next, [], 'next');
  eq(s.log, [], 'log');
  eq(s.running, [], 'running');
  eq(s.enabled, true, 'enabled 默认是开的');
  ok(typeof s.concurrency === 'number' && s.concurrency >= 1, 'concurrency 是个正数');
}

// ── 2. 未来触发：按时间升序、最多 5 条 ──

section('2. 未来触发（next）：升序 + 最多 5 条');
{
  /* 故意打乱插入顺序：按 30/60/90… 的顺序加的话，`nextAt` 天然就是升序的，
     `status()` 里那句 `.sort()` 删掉也照样绿 —— 一条从没红过的断言不算锁。 */
  [['任务C', 90], ['任务F', 180], ['任务A', 30], ['任务E', 150], ['任务B', 60], ['任务D', 120]]
    .forEach(([t, m]) => addEvery(t, m));

  const s = schedule.status();
  eq(s.total, 6, 'total 跟着任务数走');
  eq(s.active, 6, 'active == 已启用的任务数');
  eq(s.next.length, 5, 'next 最多 5 条（多了界面上也看不过来）');
  eq(s.next.map((x) => x.title), ['任务A', '任务B', '任务C', '任务D', '任务E'],
    'next 必须按 nextAt 升序 —— 插入顺序是乱的，能对上才算真排过');
  ok(s.next.every((x) => x.title && typeof x.whenText === 'string'), 'next 每条都要带 title 与 whenText');
  const times = s.next.map((x) => x.nextAt);
  ok(times.every((t, i) => i === 0 || times[i - 1] < t), 'nextAt 严格递增（不许有并列）');
}

// ── 3. 并发上限：合法值夹在 1..4，非法值一律回落默认 2 ──

section('3. 并发上限的夹取与回落');
{
  const probe = (v) => { CFG = { ...CFG, schedConcurrency: v }; return schedule.status().concurrency; };
  eq(probe(1), 1, '1 → 1');
  eq(probe(2), 2, '2 → 2');
  eq(probe(4), 4, '4 → 4');
  eq(probe(99), 4, '99 → 4（上限，免得把机器打满）');
  // 「0 / 负数」按**非法值**处理、回落默认 2，而不是夹到 1 ——
  // 这两者语义不同：夹到 1 会静默把并发砍到只剩一条（主人会以为程序卡了）。
  eq(probe(0), 2, '0 → 2（0 是非法值，不是「串行」）');
  eq(probe(-3), 2, '-3 → 2');
  eq(probe(null), 2, 'null → 2');
  eq(probe('abc'), 2, '脏值 → 2');
  eq(probe(undefined), 2, '没配 → 2');
  // 小数不锁具体值（没人设计过这个场景），只锁那条不变量：落在 1..4 且不是 NaN，
  // 否则下面 pump 的 `active < maxConcurrency()` 会永远为假 —— 任务排进去就再也不出来。
  const frac = probe(2.7);
  ok(Number.isFinite(frac) && frac >= 1 && frac <= 4, '小数也是有限个 1..4 的值', `实际 ${frac}`);
  CFG = { ...CFG, schedConcurrency: 2 };
}

// ── 4. 排队与自动放行：并发=1 时第二个必须排队，第一个跑完要自己接上 ──

section('4. 排队 / 并发 / 自动放行');
{
  disk.clear();
  delivered.length = 0;
  CFG = { apiKey: 'k', model: 'm', schedConcurrency: 1 };
  const id1 = addEvery('先来的', 60);
  const id2 = addEvery('后来的', 90);

  let release;
  gate = new Promise((r) => { release = r; });

  schedule.kick(id1);
  schedule.kick(id2);
  await flush();

  let s = schedule.status();
  eq(s.running, [id1], '第一个在跑');
  eq(s.queued, 1, '第二个在排队 —— 这就是界面上此前看不到的那个数字');
  eq(s.runningInfo.length, 1, 'runningInfo 跟着 running 走');
  ok(typeof at(s.runningInfo, 0).elapsedMs === 'number' && at(s.runningInfo, 0).elapsedMs >= 0,
    'runningInfo 要带已用时长', `实际 ${at(s.runningInfo, 0).elapsedMs}`);
  eq(at(s.runningInfo, 0).id, id1, 'runningInfo 的 id 对得上');
  eq(s.log, [], '还没跑完，历史里不该有东西');
  eq(agentCalls, 1, '并发上限 1：第二个绝不能再起一个 agent');

  release();
  gate = null;
  await sleep(20);
  await flush();

  s = schedule.status();
  eq(s.queued, 0, '第一个跑完要自己把排队的接上（pump），队列归零');
  eq(s.running, [], '都跑完了');
  eq(s.log.length, 2, '两条都进了运行历史');
  eq(agentCalls, 2, '第二个最终真的跑了');
  eq(at(s.log, 0).title, '后来的', '历史第 0 条是最新完成的（倒序）');
  eq(at(s.log, 1).title, '先来的', '历史按完成时间倒序');
  eq(at(s.log, 0).queued, true, '排过队的任务要在历史里标注 —— 不然「为什么慢了」查不出来');
  // `[].every(...)` 恒真 —— 空集合会让正向断言变成不设防，所以长度一起判。
  ok(s.log.length > 0 && s.log.every((e) => typeof e.at === 'number' && !!e.text && e.ok === true),
    '历史条目要带时间 / 结论 / 成败（空集不算通过）');
}

// ── 5. 运行历史：落盘封顶 60、status 只给 20、倒序、失败也留 ──

section('5. 运行历史（落盘 60 / 展示 20 / 倒序 / 失败也留）');
{
  disk.clear();
  CFG = { apiKey: 'k', model: 'm', schedConcurrency: 4 };
  const id = addEvery('会失败的', 60);

  agentResult = { ok: false, error: '模型拒绝服务' };
  await schedule.runNow(id);
  let s = schedule.status();
  eq(s.log.length, 1, '失败也要进历史');
  eq(at(s.log, 0).ok, false, '失败要标成 ok:false —— 否则界面上和成功长一样');
  ok(String(at(s.log, 0).text).includes('模型拒绝服务'), '失败原因要留下来', at(s.log, 0).text);
  eq(s.running, [], '跑完了不许还挂在 running 上');
  eq(s.queued, 0, '不许留下幽灵排队');
  eq(at(s.log, 0).queued, false, '没排过队的任务不许标成「排过队」（反向：正向那半在下面第 4 节）');

  // 两个上限是两回事，别混为一谈：文件里留 60 条、status 只发 20 条。
  // 曾经我把「20」当成落盘上限记在测试名里 —— 那会让人以为文件也只留 20 条。
  agentResult = { ok: true, text: '成功' };
  for (let i = 0; i < 70; i += 1) await schedule.runNow(id);
  s = schedule.status();
  const onDisk = disk.get('schedules.json').log;
  eq(onDisk.length, 60, '落盘最多 60 条（MAX_LOG）');
  eq(s.log.length, 20, 'status 只发最近 20 条');
  eq(at(s.log, 0).at >= at(s.log, 19).at, true, '倒序：第 0 条不早于最后一条');
  eq(at(s.log, 19).at < at(s.log, 0).at, true, '第 19 条确实比第 0 条早（不是同一批对象重复填）');
  eq(at(s.log, 0).ok, true, '最新那条是成功的');
  eq(at(s.log, 0).title, '会失败的', '历史条目带得起标题（面板要显示它）');
}

// ── 6. 总开关：关掉只是不调度，状态照样要读得到 ──

section('6. 总开关');
{
  const was = CFG;
  CFG = { ...was, schedEnabled: false };
  const s = schedule.status();
  eq(s.enabled, false, 'schedEnabled:false → status().enabled 为 false');
  ok(s.total > 0 && s.log.length > 0, '关了也照样返回任务与历史（界面要能显示「已关闭」而不是空白）');
  CFG = was;
}

// ── 7. 渲染层确实读了它 ──
//
// 分两半，诚实标注各自的能力边界：
//   A. **行为层**：`schRunningFromStatus()` 是纯映射，把源码抽出来当场喂假数据真跑；
//   B. **接线层**：面板跑不了 Electron，只能读源码确认「调了、用到了、落到 DOM 上」。
//     这一半是弱判据 —— 只保证接了，不保证画出来好看。

section('7A. 行为：主进程说在跑 → 界面认为在跑（真跑那段映射）');
{
  const panel = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'panel.js'), 'utf-8');
  const src = panel.match(/function schRunningFromStatus\(st\) \{[\s\S]*?\n\}/);
  ok(!!src, 'panel.js 里要能抽到 schRunningFromStatus()（抽不到说明它被搬走或改名了）');
  if (src) {
    // eslint-disable-next-line no-eval
    const build = eval(`(${src[0]})`);
    const before = Date.now();
    const m = build({ running: ['a', 'b'], runningInfo: [{ id: 'a', elapsedMs: 5000 }] });
    ok(m instanceof Map, '返回的是个 Map');
    eq(m.size, 2, '两个在跑的任务都要进表');
    ok(Math.abs((before - m.get('a')) - 5000) < 2000,
      'a 的开始时刻 = 现在 − 已用 5000ms（这样秒数才会接着往上走）', `实际差值 ${before - m.get('a')}`);
    ok(m.get('b') <= before && before - m.get('b') < 2000,
      'b 没给 elapsedMs 时退化成「就是现在」，不能是 NaN / undefined', `实际 ${m.get('b')}`);
    eq(build(null).size, 0, 'null 不炸，返回空表（面板读不到主进程时不能把本地表清成垃圾）');
    eq(build({}).size, 0, '缺字段不炸');
    eq(build({ runningInfo: [{ id: 'x', elapsedMs: 0 }] }).size, 0,
      '只有 runningInfo 没有 running 时不算「在跑」（running 才是真值）');
  }
}

section('7B. 接线：面板真的调了 scheduleStatus，并且五个字段都落到了 DOM 上');
{
  const panel = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'panel.js'), 'utf-8');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'panel.html'), 'utf-8');
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf-8');

  ok(/scheduleStatus:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('schedule:status'\)/.test(preload),
    'preload 必须暴露 scheduleStatus（通道名也要对得上主进程的 handle）');
  ok(panel.includes('window.xw.scheduleStatus()'), 'panel.js 必须真的调用 scheduleStatus');
  ok(/id="schOverview"/.test(html), 'panel.html 里要有 #schOverview 容器');
  ok(panel.includes("$('schOverview')"), '渲染要落到 #schOverview 上');
  ok(/schRunningFromStatus\(\s*st\s*\)[\s\S]{0,120}?schRunning\.set\(/.test(panel),
    '重建出来的表必须真的灌进 schRunning（算了不用等于没算）');
  ok(/schRunning[\s\S]{0,80}?\.clear\(\)/.test(panel),
    '重建前要先清空本地表（否则上一个任务跑完的残留会一直挂着）');
  ok(/st\.queuedIds\b/.test(panel),
    '任务行要能标出「排队中」（只有 queued 个数的话，看不出是哪一个）');
  ok(panel.includes('排队中'), '「排队中」这三个字要真的出现在界面上');
  ok(/id="schConc"/.test(html),
    '设置页要有并发上限的控件 —— README 写着「schedConcurrency 可调 1–4」，'
    + '而此前全仓只有 schedule.js 读它，一处都改不了');
  ok(/setConfig\(\{[^}]*schedConcurrency:[^}]*\}\)/.test(panel),
    '并发上限要真的写进配置（只画个下拉不改配置，「可调」就是假的）');

  // 只断言「调了」不够 —— 五个字段每一个都要在渲染里被用到，否则等于接了个空。
  //
  // 用词边界正则，不要用 `includes('st.log')` 那种写法：它会连 `st.logData`
  // 一起认下来 —— 把字段名改错一个字母，锁照样绿。**一条从没红过的断言不算锁。**
  for (const key of ['queued', 'concurrency', 'running', 'next', 'log']) {
    ok(new RegExp(`st\\.${key}\\b`).test(panel), `渲染里用到了 status().${key}`);
  }
}

// ── 8. 队列去重 ──

section('8. 队列去重：README 承诺「同一任务重复触发只跑一份」');
{
  disk.clear();
  delivered.length = 0;
  CFG = { apiKey: 'k', model: 'm', schedConcurrency: 1 };
  const a = addEvery('占着不放', 60);
  const b = addEvery('被连点两次的', 90);

  let release;
  gate = new Promise((r) => { release = r; });
  schedule.kick(a);
  await flush();
  eq(schedule.status().running, [a], 'a 占住了唯一的并发位');

  // 走的正是面板「跑一次」按钮那条路：kick → runTask
  const t = schedule.get(b);
  const r1 = await schedule.runTask(t, { manual: true });
  const r2 = await schedule.runTask(t, { manual: true });
  eq(r1.queued, true, '第一次点 → 排队');
  eq(r2.deduped, true, '第二次点 → 认出「已经在队里」，不再排第二份');
  eq(schedule.status().queued, 1, '队列里只能有一条');

  const before = agentCalls;
  release();
  gate = null;
  await sleep(20);
  await flush();

  eq(agentCalls - before, 1, '前一个跑完后，b 只跑一次（连点两下不该跑两遍）');
  eq(schedule.status().queued, 0, '队列清空');
  eq(schedule.status().log.filter((e) => e.title === '被连点两次的').length, 1, '运行历史里只有一条');
  eq(delivered.filter((d) => String(d.title || '').includes('被连点两次的')).length, 1, '结论只播报一次');
}

// ── 9. 排队期间被删除 / 暂停 ──

section('9. 排队期间被删除 / 暂停 → 立刻出队');
{
  disk.clear();
  delivered.length = 0;
  CFG = { apiKey: 'k', model: 'm', schedConcurrency: 1 };
  const a = addEvery('占着不放', 60);
  const b = addEvery('待会儿要被删的', 90);
  const c = addEvery('待会儿要被暂停的', 120);

  let release;
  gate = new Promise((r) => { release = r; });
  schedule.kick(a);
  await flush();
  await schedule.runTask(schedule.get(b), { manual: true });
  await schedule.runTask(schedule.get(c), { manual: true });

  eq(schedule.status().queued, 2, '两个都在队里');
  eq(schedule.status().queuedIds, [b, c], 'queuedIds 要说清是哪两个（界面靠它标「排队中」）');

  const rm = schedule.remove(b);
  eq(rm.unqueued, 1, '删掉的任务要从队列里撤走');
  eq(schedule.status().queued, 1, '队列立刻少一条');
  schedule.update(c, { enabled: false });
  eq(schedule.status().queued, 0, '暂停的任务也要出队');
  eq(schedule.status().queuedIds, [], 'queuedIds 跟着归零');

  const before = agentCalls;
  release();
  gate = null;
  await sleep(20);
  await flush();

  eq(agentCalls - before, 0, '被删 / 被暂停的任务一条都不许跑');
  eq(schedule.status().log.length, 1, '运行历史里只有 a 那一条');
  eq(delivered.length, 1, '只播报 a 的结论 —— 「删了它却还是来敲我」是最烦人的那种 bug');
}

// ── 10. pump 兜底：不能只靠调用方自觉 ──

section('10. pump 兜底：任务在队列里被外部弄没了，也不许跑');
{
  disk.clear();
  delivered.length = 0;
  events.length = 0;
  CFG = { apiKey: 'k', model: 'm', schedConcurrency: 1 };
  const a = addEvery('占着不放', 60);
  const b = addEvery('会被外部清掉的', 90);

  let release;
  gate = new Promise((r) => { release = r; });
  schedule.kick(a);
  await flush();
  await schedule.runTask(schedule.get(b), { manual: true });
  eq(schedule.status().queued, 1, 'b 在队里');

  // 绕过 remove()：直接改「文件」内容，模拟别的会话 / 编辑器把任务删了 ——
  // 这种删法不会经过 unqueue()，pump 自己必须重新查一遍。
  const raw = disk.get('schedules.json');
  raw.tasks = raw.tasks.filter((t) => t.id !== b);

  const before = agentCalls;
  release();
  gate = null;
  await sleep(20);
  await flush();

  eq(agentCalls - before, 0, '开跑前要重新确认任务还在不在');
  eq(schedule.status().queued, 0, '队列要清干净，不能留下永远不跑的幽灵');
  ok(events.some((e) => e.type === 'drop' && e.id === b),
    '要发一条 drop 事件（界面据此把那一行的「排队中」摘掉）');
  eq(delivered.length, 1, '只播报 a 的结论');
}

// ── 11. stop()：退出即作废 ──

section('11. stop()：退出时作废排队中的任务');
{
  disk.clear();
  CFG = { apiKey: 'k', model: 'm', schedConcurrency: 1 };
  const a = addEvery('还占着位', 60);
  const b = addEvery('排队等着退出的', 90);

  let release;
  gate = new Promise((r) => { release = r; });
  schedule.kick(a);
  await flush();
  await schedule.runTask(schedule.get(b), { manual: true });
  eq(schedule.status().queued, 1, '排队中就位');

  schedule.stop();
  eq(schedule.status().queued, 0,
    'stop() 之后队列必须空 —— 否则下次 start() 会被 pump 跑出来，'
    + '那是一个「隔了一次重启才冒出来」的旧结果');

  const before = agentCalls;
  release();
  gate = null;
  await sleep(20);
  await flush();
  eq(agentCalls - before, 0, '退出动作之后，排队的那条不会被跑');
}

// ── 12. 临时任务（不落库）排队后仍然要跑 ──

section('12. 临时任务（runOnce，不落库）排队后仍然会跑');
{
  disk.clear();
  delivered.length = 0;
  events.length = 0;
  CFG = { apiKey: 'k', model: 'm', schedConcurrency: 1 };
  const a = addEvery('占着不放', 60);

  let release;
  gate = new Promise((r) => { release = r; });
  schedule.kick(a);
  await flush();

  const p = schedule.runOnce('临时问一句', '现在几点');
  await flush();
  eq(schedule.status().queued, 1, '临时任务也走同一条并发闸（会排队）');
  await p;

  const before = agentCalls;
  release();
  gate = null;
  await sleep(20);
  await flush();

  eq(agentCalls - before, 1,
    '临时任务不在 schedules.json 里，pump 不能把它当成「已删除」丢掉（靠 transient 标出来）');
  ok(!events.some((e) => e.type === 'drop'),
    '更不许把临时任务当成「被删掉的」发 drop 事件');
}

// ── 汇总 ──

console.log('');
if (fails.length) {
  console.log(`  ${fails.length} 项失败：\n`);
  for (const f of fails) console.log(`    - ${f}`);
  console.log('\n调度状态判据测试未通过。\n');
  process.exit(1);
}
console.log(`  ${pass} 项全部通过。\n`);
