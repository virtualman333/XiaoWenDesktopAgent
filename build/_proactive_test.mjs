/**
 * 定时任务 + 主动关注回归测试 —— node build/_proactive_test.mjs
 *
 * 用最小桩件顶掉 Electron / fetch，验证：
 *   时间解析、下一次触发时间、静默时段、
 *   任务增删改查与真实执行（走一遍 Agent）、结果播报、
 *   地震/热搜的去重、基线不播报、关键词过滤、静默不打扰。
 */
import Module from 'node:module';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);

// ---------------- 桩：electron ----------------
const TMP = path.join(os.tmpdir(), 'xw-proactive-' + Date.now());
fs.mkdirSync(path.join(TMP, 'jarvis'), { recursive: true });

const fakeElectron = {
  app: {
    getPath: () => TMP,
    getVersion: () => '1.6.0',
    isPackaged: false,
    getAppPath: () => TMP
  },
  shell: { openPath: () => true, showItemInFolder: () => {}, openExternal: () => {} },
  clipboard: { readText: () => '', writeText: () => {}, writeImage: () => {} },
  Notification: function () { return { show: () => {} }; },
  screen: {
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1, id: 1 }),
    getAllDisplays: () => [],
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } })
  },
  nativeImage: { createFromPath: () => ({ toPNG: () => Buffer.alloc(0) }) },
  ipcMain: { handle: () => {}, on: () => {}, once: () => {}, removeAllListeners: () => {}, removeHandler: () => {} },
  BrowserWindow: function () { return { isDestroyed: () => true, webContents: { send: () => {} } }; },
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
let fetchRouter = () => ({});
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  // 对话请求（Agent 走流式）
  if (u.includes('/chat/completions')) {
    const body = JSON.parse((opts && opts.body) || '{}');
    const out = typeof chatReply === 'function' ? chatReply(body) : '好的，任务已完成。';
    const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: out } }] }) + '\n\n'
      + 'data: [DONE]' + '\n\n';
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/event-stream' },
      text: async () => sse,
      body: new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); }
      })
    };
  }
  // 信源请求
  const data = fetchRouter(u);
  if (data === null) return { ok: false, status: 500, json: async () => ({}) };
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => data, text: async () => JSON.stringify(data) };
};
let chatReply = () => '好的，任务已完成。';

// ---------------- 被测模块 ----------------
const T = require('../src/main/jarvis/schedule-time.js');
const store = require('../src/main/jarvis/store.js');
const schedule = require('../src/main/jarvis/schedule.js');
const watch = require('../src/main/jarvis/watch.js');

// ---------------- 断言 ----------------
let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + extra : ''}`); }
}
function eq(a, b, name) { ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }
function section(t) { console.log(`\n${t}`); }

const NOON = new Date(2026, 8, 14, 12, 0, 0, 0).getTime(); // 2026-09-14 周一 12:00

const STATE_FILE = path.join(TMP, 'jarvis', 'watch.json');
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); } catch (e) { return {}; }
}
function writeState(patch) { store.writeJson('watch.json', { ...readState(), ...patch }); }

// ================= 1. 时间解析 =================
section('1. 时间写法解析');
eq(T.parseTime('08:30').h, 8, 'HH:MM 解析小时');
eq(T.parseTime('8：30').mi, 30, '中文冒号也能认');
eq(T.parseTime('25:00'), null, '非法小时返回 null');
eq(T.parseTime('08:70'), null, '非法分钟返回 null');

eq(T.normalizeWhen('08:30').type, 'daily', '「08:30」= 每天');
eq(T.normalizeWhen('每30分钟').minutes, 30, '「每30分钟」= 间隔');
eq(T.normalizeWhen('2h').minutes, 120, '「2h」= 120 分钟');
eq(T.normalizeWhen({ type: 'weekly', time: '09:00', days: [7] }).days[0], 0, '周日 7 归一成 0');
eq(T.normalizeWhen({ day: 1, time: '09:00' }).type, 'monthly', '带 day 就是每月');
eq(T.normalizeWhen('胡说八道'), null, '认不出来返回 null');
ok(T.normalizeWhen('2026-09-15 09:00').type === 'once', '日期时间 = 一次性');

section('2. 排期描述');
eq(T.describeWhen({ type: 'daily', time: '08:30' }), '每天 08:30', '每天');
eq(T.describeWhen({ type: 'weekly', time: '09:00', days: [1, 3] }), '每 周一、周三 09:00', '每周');
eq(T.describeWhen({ type: 'monthly', time: '09:00', day: 1 }), '每月 1 号 09:00', '每月');
eq(T.describeWhen({ type: 'interval', minutes: 30 }), '每 30 分钟', '每 30 分钟');
eq(T.describeWhen({ type: 'interval', minutes: 120 }), '每 2 小时', '整小时换算');

// ================= 3. 下一次触发 =================
section('3. 下一次触发时间');
{
  // 12:00 时，每天的 08:30 应该落到明天
  const next = T.computeNext({ type: 'daily', time: '08:30' }, NOON);
  const d = new Date(next);
  eq(d.getDate(), 15, '每天 08:30 已过 → 明天');
  eq(d.getHours(), 8, '小时正确');

  const next2 = T.computeNext({ type: 'daily', time: '18:00' }, NOON);
  eq(new Date(next2).getDate(), 14, '每天 18:00 未到 → 今天');

  // 周一 12:00，每周一三五 09:00 → 周三
  const w = T.computeNext({ type: 'weekly', time: '09:00', days: [1, 3, 5] }, NOON);
  eq(new Date(w).getDay(), 3, '每周一三五 → 下一次周三');

  // 每月 31 号：2 月不存在要跳过
  const m = T.computeNext({ type: 'monthly', time: '09:00', day: 31 }, new Date(2027, 0, 5, 12).getTime());
  ok(m > 0, '每月 31 号能算出下一次', String(m));
  const md = new Date(m);
  eq(md.getDate(), 31, '日期是 31 号');
  eq(md.getMonth(), 0, '落在 1 月（2 月没有 31 号，跳过了）');

  // 间隔：上次 12:00，每 30 分钟，现在 12:00 → 12:30
  const iv = T.computeNext({ type: 'interval', minutes: 30 }, NOON, NOON);
  eq(Math.round((iv - NOON) / 60000), 30, '间隔任务按上次时间往后推');

  // 间隔：电脑关了 3 小时，不应该补 6 次
  const iv2 = T.computeNext({ type: 'interval', minutes: 30 }, NOON, NOON - 3 * 3600000);
  ok(iv2 > NOON && iv2 <= NOON + 30 * 60000, '错过的间隔只补到下一个未到点', new Date(iv2).toISOString());

  // 一次性：已过期返回 0
  eq(T.computeNext({ type: 'once', at: NOON - 1000 }, NOON), 0, '过期的一次性任务返回 0');
  eq(T.computeNext({ type: 'once', at: NOON + 60000 }, NOON), NOON + 60000, '未到的一次性任务原样返回');
}

section('4. 静默时段');
ok(T.inQuietHours('23:00-07:00', new Date(2026, 8, 14, 2, 0).getTime()) === true, '凌晨 2 点算静默');
ok(T.inQuietHours('23:00-07:00', new Date(2026, 8, 14, 12, 0).getTime()) === false, '中午不算静默');
ok(T.inQuietHours('23:00-07:00', new Date(2026, 8, 14, 23, 30).getTime()) === true, '23:30 算静默');
ok(T.inQuietHours('09:00-18:00', new Date(2026, 8, 14, 12, 0).getTime()) === true, '同一天内的区间');
ok(T.inQuietHours('', NOON) === false, '空区间 = 不静默');
ok(T.inQuietHours('乱七八糟', NOON) === false, '非法区间 = 不静默');

// ================= 5. 定时任务引擎 =================
section('5. 定时任务增删改查');
{
  const CFG = { apiKey: 'sk-test', model: 'test-model', apiBaseUrl: 'https://example.com/v1', schedEnabled: true };
  const delivered = [];
  schedule.bind({
    getConfig: () => CFG,
    log: () => {},
    deliver: (p) => delivered.push(p)
  });

  const a = schedule.add({ title: '每日早报', prompt: '播今天的天气', when: { type: 'daily', time: '08:30' } });
  ok(a.ok === true, '新建任务成功');
  ok(!!a.task.nextAt, '自动算出下次执行时间');
  eq(schedule.list().length, 1, '列表里有 1 个');

  const b = schedule.add({ prompt: '提醒喝水', when: '每60分钟' });
  ok(b.ok === true, '用「人话」也能建任务');
  eq(b.task.whenText, '每 1 小时', '间隔描述正确');
  eq(b.task.source, 'user', '默认来源是用户');

  const bad = schedule.add({ prompt: 'x', when: '瞎写' });
  eq(bad.ok, false, '时间认不出来 → 拒绝创建');
  eq(schedule.add({ prompt: '', when: '08:00' }).ok, false, '空任务内容 → 拒绝创建');

  const up = schedule.update(a.task.id, { prompt: '播天气 + 新闻' });
  eq(up.ok, true, '修改成功');
  eq(schedule.get(a.task.id).prompt, '播天气 + 新闻', '内容已更新');

  const off = schedule.update(a.task.id, { enabled: false });
  eq(off.task.nextAt, 0, '暂停后不再有下次时间');

  // 模板
  ok(schedule.presetList().length >= 4, '预置模板存在');
  const pre = schedule.addPreset('water');
  ok(pre.ok === true, '一键加模板成功', pre.error || '');
  eq(schedule.addPreset('water').ok, false, '同名模板不重复添加');

  // 工具入口
  const tl = await schedule.handleTool({ action: 'list' });
  ok(/每日早报/.test(tl.content), '工具 list 能列出任务');
  const tc = await schedule.handleTool({ action: 'create', title: '自排', prompt: '收盘复盘', when: { type: 'weekly', time: '15:10', days: [1, 2, 3, 4, 5] } });
  ok(/已创建/.test(tc.content), '工具 create 能建任务');
  ok(schedule.list().some((t) => t.source === 'ai'), 'AI 建的任务被标记为「小问自排」');

  eq(schedule.remove(a.task.id).ok, true, '删除成功');
  eq(schedule.remove('不存在').ok, false, '删除不存在的任务返回 false');
}

section('6. 定时任务真的跑一遍');
{
  const CFG = { apiKey: 'sk-test', model: 'test-model', apiBaseUrl: 'https://example.com/v1', schedEnabled: true };
  const delivered = [];
  schedule.bind({ getConfig: () => CFG, log: () => {}, deliver: (p) => delivered.push(p) });
  chatReply = () => '今天晴，26 度，适合出门。';

  const t = schedule.add({ title: '天气播报', prompt: '播一下今天天气', when: { type: 'interval', minutes: 60 } });
  const r = await schedule.runNow(t.task.id);
  ok(r.ok === true, '执行成功', r.error || '');
  ok(/26 度/.test(r.text), '拿到模型输出', r.text);
  ok(delivered.length === 1, '结果被主动播报了一次', String(delivered.length));
  eq(delivered[0].kind, 'schedule', '播报类型是 schedule');
  ok(/天气播报/.test(delivered[0].title), '播报带上任务名');
  eq(delivered[0].open, true, '标记了「唤起」→ 会弹出面板');

  const after = schedule.get(t.task.id);
  eq(after.runCount, 1, '执行次数 +1');
  eq(after.lastOk, true, '记录了成功');
  ok(!!after.nextAt, '跑完自动排下一次');

  // 一次性任务跑完自动退休
  const once = schedule.add({ title: '一次性的', prompt: '提醒我', when: { type: 'once', at: Date.now() + 5000 } });
  await schedule.runNow(once.task.id);
  eq(schedule.get(once.task.id).enabled, false, '一次性任务执行后自动停用');

  // 没配模型时不应该炸
  const noKey = { apiKey: '', model: '', schedEnabled: true };
  schedule.bind({ getConfig: () => noKey, log: () => {}, deliver: () => {} });
  const t2 = schedule.add({ title: '没模型', prompt: 'x', when: '09:00' });
  const r2 = await schedule.runTask(schedule.get(t2.task.id));
  eq(r2.ok, false, '没配模型时优雅失败');
}

// ================= 6b. 先反馈、再给结果（两阶段） =================
section('6b. 异步调度 · 先反馈再给结果');
{
  const CFG = { apiKey: 'sk-test', model: 'test-model', apiBaseUrl: 'https://example.com/v1', schedEnabled: true, schedConcurrency: 2 };
  const delivered = [];
  const events = [];
  schedule.bind({
    getConfig: () => CFG, log: () => {},
    deliver: (p) => delivered.push(p),
    event: (e) => events.push(e)
  });
  chatReply = () => '今天晴，26 度，记得带伞。';

  // 1) 自动任务跑得比回执阈值快 → 只播结果，绝不能只播「我去办」而没有结论
  const fast = schedule.add({ title: '快到不用回执', prompt: '播天气', when: { type: 'interval', minutes: 60 } });
  const rf = await schedule.runTask(schedule.get(fast.task.id));   // 不带 manual = 定时触发
  eq(rf.ok, true, '定时任务执行成功');
  eq(delivered.length, 1, '跑得快 → 只播一条（不重复打扰）', JSON.stringify(delivered.map((d) => d.phase)));
  eq(delivered[0].phase, 'done', '播的是结论而不是回执');
  ok(/26 度/.test(delivered[0].text), '结论内容正确', delivered[0].text);
  ok(events.some((e) => e.type === 'start'), '事件总线立刻广播了 start（面板秒变运行中）');
  eq(events.find((e) => e.type === 'start').manual, false, 'start 事件标了不是手动');

  // 2) 手动踢一脚：不阻塞调用方，先返回再慢慢跑
  delivered.length = 0;
  events.length = 0;
  const kicked = schedule.kick(fast.task.id);
  eq(kicked.kicked, true, 'kick 立刻返回，不等结果');
  eq(events.some((e) => e.type === 'start' && e.manual === true), true, '手动 kick 也广播了 start');
  // 等它自己跑完
  await new Promise((r) => setTimeout(r, 400));
  eq(delivered.length >= 1, true, 'kick 之后结果照样会回来', String(delivered.length));
  eq(delivered[delivered.length - 1].phase, 'done', '回来的还是结论');

  // 3) 重复踢同一个任务不应该并发跑两份
  const dup = schedule.runTask(schedule.get(fast.task.id));
  const dup2 = await schedule.runTask(schedule.get(fast.task.id));
  await dup;
  ok(dup2.running === true || dup2.ok === false, '同一个任务并发只跑一份', JSON.stringify(dup2));

  // 4) 排队：并发打满时返回排队而不是丢任务
  const slowReplies = [];
  chatReply = () => '慢慢想…';
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(schedule.add({ title: '并发' + i, prompt: 'p' + i, when: { type: 'interval', minutes: 30 } }).task.id);
  const rs = ids.map((id) => schedule.runTask(schedule.get(id)));
  const settled = await Promise.all(rs);
  ok(settled.every((r) => r.ok === true), '并发提交都接受', JSON.stringify(settled.map((r) => r.queued || false)));
  ok(schedule.status().concurrency >= 1, '状态里能读到并发上限', String(schedule.status().concurrency));
}

// ================= 7. 主动关注纯逻辑 =================
section('7. 主动关注 · 纯逻辑');
{
  eq(watch.diffTop(['A', 'B'], ['A', 'C', 'B']).join(','), 'C', '新增的排到前面');
  eq(watch.diffTop(['A', 'B'], ['A', 'B']).length, 0, '没有新增返回空');
  eq(watch.diffTop(null, ['A']).length, 1, '没有历史时全部算新增');

  ok(watch.matchKeywords('四川成都地震', '地震,暴雨') === true, '关键词命中');
  ok(watch.matchKeywords('某明星结婚', '地震') === false, '关键词不命中');
  ok(watch.matchKeywords('随便什么', '') === true, '没配关键词 = 全通过');

  ok(watch.inChinaBox(31.2, 103.8) === true, '成都坐标在国内框里');
  ok(watch.inChinaBox(35.7, 139.7) === false, '东京不在国内框里');

  const line = watch.quakeLine({
    id: 'x',
    properties: { mag: 5.4, place: '四川甘孜州', time: new Date(2026, 8, 14, 10, 31).getTime() },
    geometry: { coordinates: [101.2, 30.1, 12] }
  });
  ok(/M5\.4/.test(line), '震级格式化', line);
  ok(/四川甘孜州/.test(line), '带地名');
  ok(/10:31/.test(line), '带发生时间');
  ok(/深度 12km/.test(line), '带深度');
}

// ================= 8. 主动关注端到端 =================
section('8. 主动关注 · 轮询与播报');
{
  const CFG = {
    apiKey: 'sk-test', model: 'test-model',
    watchEnabled: true, watchQuake: true, watchQuakeMinMag: 5, watchQuakeRegion: 'cn',
    watchQuakeInterval: 1, watchHot: true, watchHotInterval: 30, watchHotTop: 5,
    watchWeibo: false, watchKeywords: '', watchMute: '', watchPet: true, watchSpeak: false
  };
  const delivered = [];
  watch.bind({ getConfig: () => CFG, log: () => {}, deliver: (p) => delivered.push(p) });

  let quakeSeqs = [[
    { id: 'q1', properties: { mag: 6.1, place: '四川甘孜州', time: Date.now() - 60000 }, geometry: { coordinates: [101, 30, 10] } },
    { id: 'q2', properties: { mag: 4.0, place: '四川雅安', time: Date.now() - 60000 }, geometry: { coordinates: [103, 30, 8] } },
    { id: 'q3', properties: { mag: 7.2, place: '东京湾', time: Date.now() - 60000 }, geometry: { coordinates: [139, 35, 30] } }
  ]];
  fetchRouter = (u) => {
    if (u.includes('earthquake.usgs.gov')) return { features: quakeSeqs[0] };
    if (u.includes('top.baidu.com')) return { data: { cards: [{ content: [{ word: 'A', hotScore: 1 }, { word: 'B' }, { word: 'C' }] }] } };
    return {};
  };

  // 第一次：只建立基线，不播报（震级过滤 + 区域过滤也在这一轮验证）
  writeState({ seen: {}, lastPoll: {}, snap: {}, inited: {} });
  await watch.tick();
  eq(delivered.length, 0, '首轮只建基线，不打扰');

  // 第二次：加一条新的 6.5 级国内地震 → 应该播报（4.0 级低于阈值、东京不在范围内，都要被过滤）
  quakeSeqs[0] = quakeSeqs[0].concat([
    { id: 'q4', properties: { mag: 6.5, place: '四川阿坝', time: Date.now() - 30000 }, geometry: { coordinates: [102, 31, 15] } },
    { id: 'q5', properties: { mag: 6.9, place: '南太平洋', time: Date.now() - 30000 }, geometry: { coordinates: [-120, -20, 40] } },
    { id: 'q6', properties: { mag: 4.2, place: '四川绵阳', time: Date.now() - 30000 }, geometry: { coordinates: [104, 31, 5] } }
  ]);
  writeState({ lastPoll: {} }); // 只把轮询计时清零，基线保留
  await watch.tick();
  eq(delivered.length, 1, '第二轮播报 1 条地震');
  ok(/M6\.5/.test(delivered[0].text), '播报的是新地震', delivered[0].text);
  ok(!/东京湾/.test(delivered[0].text), '范围外的地震被过滤');
  ok(!/M4\.2/.test(delivered[0].text), '低于阈值的被过滤');
  eq(delivered[0].kind, 'quake', '类型是 quake');

  // 第三次：同一条不应该重复播
  writeState({ lastPoll: {} });
  await watch.tick();
  eq(delivered.length, 1, '同一条地震不会重复播报');

  // 热搜：首轮基线 → 次轮新上榜 → 播报
  delivered.length = 0;
  writeState({ seen: {}, lastPoll: {}, snap: {}, inited: {} });
  fetchRouter = () => ({ data: { cards: [{ content: [{ word: 'A' }, { word: 'B' }, { word: 'C' }] }] } });
  await watch.tick();
  eq(delivered.length, 0, '热搜首轮只建基线');

  fetchRouter = () => ({ data: { cards: [{ content: [{ word: 'A' }, { word: 'D' }, { word: 'C' }] }] } });
  writeState({ seen: {}, lastPoll: {}, snap: { hot: ['A', 'B', 'C'] } });
  await watch.tick();
  eq(delivered.length, 1, '热搜新上榜播报 1 条');
  ok(/D/.test(delivered[0].text), '播报的是新上榜的 D', delivered[0].text);

  // 关键词过滤：只关心「地震」
  delivered.length = 0;
  CFG.watchKeywords = '地震';
  writeState({ seen: {}, lastPoll: {}, snap: { hot: ['A', 'B'] } });
  fetchRouter = () => ({ data: { cards: [{ content: [{ word: 'A' }, { word: '明星八卦' }] }] } });
  await watch.tick();
  eq(delivered.length, 0, '关键词不匹配 → 不打扰');

  writeState({ seen: {}, lastPoll: {}, snap: { hot: ['A', 'B'] } });
  fetchRouter = () => ({ data: { cards: [{ content: [{ word: 'A' }, { word: '某地地震' }] }] } });
  await watch.tick();
  eq(delivered.length, 1, '关键词匹配 → 播报');

  // 静默时段
  delivered.length = 0;
  CFG.watchKeywords = '';
  CFG.watchMute = '00:00-23:59';
  writeState({ seen: {}, lastPoll: {}, snap: { hot: ['A'] } });
  fetchRouter = () => ({ data: { cards: [{ content: [{ word: 'A' }, { word: '夜间新闻' }] }] } });
  await watch.tick();
  eq(delivered.length, 0, '静默时段只记录不播报');

  // 手动检查要无视静默：先制造一条新的上榜
  fetchRouter = () => ({ data: { cards: [{ content: [{ word: 'A' }, { word: '夜间新闻' }, { word: '手动测试' }] }] } });
  writeState({ lastPoll: {}, snap: { hot: ['A', '夜间新闻'] } });
  const r = await watch.checkNow('hot');
  eq(r.ok, true, '立即检查可用');
  eq(delivered.length, 1, '手动检查无视静默时段');
  ok(/手动测试/.test(delivered[0].text), '手动检查推的是新上榜那条', delivered[0].text);

  // 信源挂掉不能抛
  fetchRouter = () => null;
  const bad = await watch.checkNow('quake');
  eq(bad.ok, false, '信源失败返回 ok:false 而不是抛异常');
}

console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
process.exit(fail ? 1 : 0);
