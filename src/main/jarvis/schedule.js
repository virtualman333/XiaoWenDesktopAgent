/**
 * 定时任务 —— 到点自动把一件事跑完，然后把结果主动播报给主人。
 *
 * 和「闹钟」的区别：定时任务不是弹一句提醒，而是**真的让 Agent 去干活**
 * （查天气、看行情、整理热点），再把结论汇报出来。所以它同时解决两件事：
 *   1) 主人可以排任务；
 *   2) 小问自己也能排任务（schedule_task 工具），实现「自己给自己定计划」。
 *
 * 数据落在 userData/jarvis/schedules.json，与 config.json 分开。
 */
const store = require('./store');
const T = require('./schedule-time');

const FILE = 'schedules.json';
const MAX_LOG = 60;

let api = {
  getConfig: () => ({}),
  log: () => {},
  deliver: () => {},
  event: () => {}
};

let timer = null;

function bind(opts = {}) {
  if (opts.getConfig) api.getConfig = opts.getConfig;
  if (opts.log) api.log = opts.log;
  if (opts.deliver) api.deliver = opts.deliver;
  if (opts.event) api.event = opts.event;
}

function cfg() { return api.getConfig() || {}; }
function log(m) { try { api.log('[定时任务] ' + m); } catch (e) { /* ignore */ } }

function load() {
  const d = store.readJson(FILE, { tasks: [], log: [] });
  if (!Array.isArray(d.tasks)) d.tasks = [];
  if (!Array.isArray(d.log)) d.log = [];
  return d;
}

function save(d) {
  if (d.log && d.log.length > MAX_LOG) d.log = d.log.slice(-MAX_LOG);
  return store.writeJson(FILE, d);
}

function newId() {
  return 'st-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---------------- 增删改查 ----------------

function list() {
  const d = load();
  return d.tasks.map((t) => ({
    ...t,
    whenText: T.describeWhen(t.when),
    etaText: t.enabled === false ? '已暂停' : T.describeEta(t.nextAt)
  }));
}

function rawList() { return load().tasks; }

/**
 * 新建任务。
 * @param {{title?:string, prompt:string, when:any, enabled?:boolean, wake?:boolean, source?:string}} input
 */
function add(input = {}) {
  const prompt = String(input.prompt || '').trim();
  if (!prompt) return { ok: false, error: '任务内容不能为空' };
  const when = T.normalizeWhen(input.when);
  if (!when) return { ok: false, error: '看不懂这个时间安排，请用「每天 08:30」「每 30 分钟」「2026-09-15 09:00」这类写法' };

  const d = load();
  const now = Date.now();
  const task = {
    id: input.id && !d.tasks.some((t) => t.id === input.id) ? input.id : newId(),
    title: String(input.title || prompt.slice(0, 16)).trim().slice(0, 40),
    prompt,
    when,
    enabled: input.enabled !== false,
    // 是否「唤起」主人：弹面板 + 宠物播报 + 朗读
    wake: input.wake !== false,
    source: input.source === 'ai' ? 'ai' : 'user',
    createdAt: now,
    lastRunAt: 0,
    runCount: 0,
    lastResult: '',
    nextAt: 0
  };
  task.nextAt = task.enabled ? T.computeNext(task.when, now) : 0;
  d.tasks.push(task);
  save(d);
  log(`新建「${task.title}」${T.describeWhen(task.when)}，下次 ${task.nextAt ? T.fmtDateTime(new Date(task.nextAt)) : '—'}`);
  return { ok: true, task: { ...task, whenText: T.describeWhen(task.when) } };
}

function update(id, patch = {}) {
  const d = load();
  const t = d.tasks.find((x) => x.id === id);
  if (!t) return { ok: false, error: '没有这个任务' };
  if (patch.title != null) t.title = String(patch.title).slice(0, 40);
  if (patch.prompt != null) t.prompt = String(patch.prompt);
  if (patch.when != null) {
    const w = T.normalizeWhen(patch.when);
    if (!w) return { ok: false, error: '看不懂这个时间安排' };
    t.when = w;
  }
  if (patch.wake != null) t.wake = !!patch.wake;
  if (patch.enabled != null) t.enabled = !!patch.enabled;
  t.nextAt = t.enabled ? T.computeNext(t.when, Date.now(), t.lastRunAt) : 0;
  save(d);
  return { ok: true, task: { ...t, whenText: T.describeWhen(t.when) } };
}

function remove(id) {
  const d = load();
  const before = d.tasks.length;
  d.tasks = d.tasks.filter((t) => t.id !== id);
  save(d);
  return { ok: d.tasks.length < before };
}

function get(id) {
  return load().tasks.find((t) => t.id === id) || null;
}

// ---------------- 执行 ----------------

/**
 * 执行模型：**先回执，再干活**。
 *
 * 以前是「await 跑完整轮 Agent → 再把结果播报出去」—— 主人的体感是
 * 「点了没反应，几十秒后突然蹦出一条」。而 Agent 跑一轮本来就慢（要调工具、
 * 甚至要联网），把它当成同步操作是设计错误。
 *
 * 现在拆成两段：
 *   1) 立刻回执：宠物进入「干活」状态 + 面板一条轻提示「收到，去办了」；
 *   2) 后台异步执行，跑完再把结论投递出去（kind=schedule，phase=done）。
 * 同时并发跑多个任务（限流），tick 也不再串行等待。
 */

let active = 0;
const queue = [];                 // 排队中的 {task, opts}
const runningSince = new Map();   // taskId -> 开始时间
const ackTimers = new Map();      // taskId -> 「还在办」回执的定时器
const ACK_MIN_MS = 6000;          // 超过这个时长还没跑完，才补一句「收到，这就去办」
const SLOW_HINT_MS = 45000;       // 超过这个时长再补一句「还在办」

function maxConcurrency() {
  const n = Number(cfg().schedConcurrency);
  return Math.max(1, Math.min(4, Number.isFinite(n) && n > 0 ? n : 2));
}

function emit(payload) {
  try { if (typeof api.event === 'function') api.event(payload); } catch (e) { /* ignore */ }
}

/**
 * 「已经开跑了」这个信号是立刻发的 —— 但它只走事件总线（面板秒变运行中），
 * 不走通知。真正的「收到，我去办」回执会晚 ACK_MIN_MS 再补：
 * 跑得快的任务一句结论就够了，免得「收到」和「结果」两条横幅连着弹。
 */
function emitStart(task, opts = {}) {
  emit({ type: 'start', id: task.id, title: task.title, manual: !!opts.manual });
}

/** 回执：让主人知道「还在办」，而不是干等 */
function deliverAck(task, opts = {}) {
  const brief = String(task.prompt || '').replace(/\s+/g, ' ').slice(0, 50);
  try {
    api.deliver({
      kind: 'schedule',
      phase: 'ack',
      title: `⏰ ${task.title}`,
      text: opts.manual ? `收到，这就去办。（${brief}…）` : `到点了，我去办「${task.title}」。`,
      open: false,          // 回执绝不弹面板，只做轻提示
      speak: false,
      pet: cfg().watchPet !== false
    });
  } catch (e) { /* ignore */ }
}

/** 延迟回执：跑满 ACK_MIN_MS 还没结束才发；跑完了就取消（结论一条到位） */
function armAck(task, opts) {
  clearAck(task.id);
  const timer = setTimeout(() => {
    ackTimers.delete(task.id);
    if (!runningSince.has(task.id)) return;   // 已经干完了：结果已经/即将投递，不再补回执
    deliverAck(task, { ...opts, manual: !!opts.manual });
  }, ACK_MIN_MS);
  if (timer.unref) timer.unref();
  ackTimers.set(task.id, timer);
}

function clearAck(taskId) {
  const t = ackTimers.get(taskId);
  if (t) { clearTimeout(t); ackTimers.delete(taskId); }
}

/** 干完活之后把结论投递出去 */
function finish(task, opts, { ok, text, startedAt, queued }) {
  const now = Date.now();
  const d = load();
  const t = d.tasks.find((x) => x.id === task.id);
  if (t) {
    t.lastRunAt = now;
    t.runCount = (t.runCount || 0) + 1;
    t.lastResult = String(text || '').slice(0, 800);
    t.lastOk = ok;
    t.lastMs = now - startedAt;
    if (t.when && t.when.type === 'once') {
      t.enabled = false;      // 一次性任务执行完就退休
      t.nextAt = 0;
    } else {
      t.nextAt = t.enabled ? T.computeNext(t.when, now, now) : 0;
    }
    // adhoc（临时任务）不在库里，找不到是正常的
  }
  d.log.push({
    id: task.id, title: task.title, at: now, ok,
    text: String(text || '').slice(0, 400),
    manual: !!opts.manual, queued: !!queued
  });
  save(d);

  const ms = now - startedAt;
  log(`「${task.title}」执行${ok ? '完成' : '失败'}，用时 ${Math.round(ms / 1000)}s`);

  // 结论一定要给到（回执只是「我在办」，不能替掉结果）
  if (text) {
    try {
      api.deliver({
        kind: 'schedule',
        phase: 'done',
        title: `⏰ ${task.title}`,
        text,
        open: opts.manual ? true : task.wake !== false,
        speak: task.wake !== false && cfg().watchSpeak === true,
        pet: cfg().watchPet !== false,
        ms
      });
    } catch (e) { /* 播报失败不影响任务本身 */ }
  }

  emit({ type: 'done', id: task.id, title: task.title, ok, text, ms });
  return { ok, text, ms };
}

/** 真正跑一轮 Agent（不含回执与落地） */
async function work(task, opts, startedAt) {
  const c = cfg();
  let text = '';
  let ok = false;
  let slowHint = null;

  try {
    const agent = require('./agent');   // 延迟 require：避免 agent → tools 形成加载环
    slowHint = setTimeout(() => {
      try {
        api.deliver({
          kind: 'schedule', phase: 'progress',
          title: `⏰ ${task.title}`,
          text: '这活儿比平时费点时间，我还在办，跑完就告诉你。',
          open: false, speak: false, pet: cfg().watchPet !== false
        });
      } catch (e) { /* ignore */ }
    }, SLOW_HINT_MS);

    const r = await agent.runAgent({
      messages: [{
        role: 'user',
        content: [
          `（这是你给自己排的定时任务「${task.title}」，现在到点了，独立执行。）`,
          task.prompt
        ].join('\n')
      }],
      cfg: c,
      sender: null, // 没有面板也要能跑
      opts: {
        quiet: true, // 不要把中间碎片刷到主人屏幕上
        useTools: c.agentUseTools !== false,
        useMcp: c.agentUseMcp !== false,
        useSkills: c.agentUseSkills !== false,
        useMemory: c.agentUseMemory !== false,
        maxRounds: 6,
        systemExtra: '这是定时任务触发的主动汇报。请直接给结论，口语化，200 字以内，不要寒暄、不要罗列原始数据。'
      }
    });
    if (r && r.ok) {
      ok = true;
      text = String(r.text || '').trim();
    } else {
      text = (r && r.error) || '执行失败';
    }
  } catch (e) {
    text = (e && e.message) || String(e);
  } finally {
    if (slowHint) clearTimeout(slowHint);
  }

  return finish(task, opts, { ok, text, startedAt });
}

/** 下一个排队任务（并发限流） */
function pump() {
  while (active < maxConcurrency() && queue.length) {
    const next = queue.shift();
    runNow_(next.task, next.opts, true);
  }
}

function runNow_(task, opts, queued) {
  active++;
  runningSince.set(task.id, Date.now());
  const startedAt = Date.now();
  armAck(task, opts);
  return work(task, opts, startedAt)
    .catch((e) => ({ ok: false, text: (e && e.message) || String(e) }))
    .finally(() => {
      clearAck(task.id);
      active--;
      runningSince.delete(task.id);
      pump();
    });
}

/**
 * 跑一个任务。**默认不 await 结果**，立刻回执后就返回；
 * 需要结果的地方（工具调用）传 opts.awaitResult。
 */
function runTask(task, opts = {}) {
  if (!task) return Promise.resolve({ ok: false, error: '任务不存在' });
  if (runningSince.has(task.id)) {
    return Promise.resolve({ ok: false, error: '这个任务正在执行中', running: true });
  }

  const c = cfg();
  if (!c.apiKey || !c.model) {
    log(`跳过「${task.title}」：还没配置大模型`);
    return Promise.resolve({ ok: false, error: '还没配置大模型接口' });
  }

  if (!opts.noAck) emitStart(task, opts);

  if (active >= maxConcurrency()) {
    queue.push({ task, opts });
    log(`「${task.title}」已排队（当前并发 ${active}/${maxConcurrency()}）`);
    return Promise.resolve({ ok: true, queued: true, text: '已排队，马上开跑' });
  }
  return runNow_(task, opts, false);
}

/** 只踢一脚，不等结果（设置页「跑一次」/ tick 用） */
function kick(id, opts = {}) {
  const t = get(id);
  if (!t) return { ok: false, error: '没有这个任务' };
  runTask(t, { ...opts, manual: true });
  return { ok: true, kicked: true };
}

/** 立即执行并等结果（Agent 工具调用走这里，它需要把结果回灌给模型） */
async function runNow(id) {
  const t = get(id);
  if (!t) return { ok: false, error: '没有这个任务' };
  return runTask(t, { manual: true, awaitResult: true });
}

/** 把某个任务的 prompt 直接当一次性任务跑一次（不落库） */
async function runOnce(title, prompt) {
  return runTask({ id: 'adhoc-' + Date.now().toString(36), title: title || '临时任务', prompt, wake: true }, { manual: true });
}

function runningIds() { return Array.from(runningSince.keys()); }
function runningInfo() {
  const now = Date.now();
  return Array.from(runningSince.entries()).map(([id, at]) => ({ id, since: at, elapsedMs: now - at }));
}

// ---------------- 调度循环 ----------------

const TICK_MS = 15000;

async function tick() {
  const c = cfg();
  if (c.schedEnabled === false) return;
  const now = Date.now();
  const d = load();
  let dirty = false;

  for (const t of d.tasks) {
    if (!t.enabled) continue;
    if (!t.nextAt) {
      t.nextAt = T.computeNext(t.when, now, t.lastRunAt);
      dirty = true;
      continue;
    }
    if (t.nextAt > now) continue;

    // 启动前错过的：不补跑（避免一次性涌出一堆），只顺延到下一个点。
    // 一次性任务宽限 6 小时，超过就作废，免得半夜爬起来播报昨天的事。
    if (now - t.nextAt > 2 * 60000) {
      if (t.when && t.when.type === 'once') {
        if (now - t.nextAt > 6 * 3600000) {
          t.enabled = false;
          t.nextAt = 0;
          log(`「${t.title}」已过期，自动停用`);
        } else {
          t.nextAt = now;
        }
      } else {
        t.nextAt = T.computeNext(t.when, now, t.lastRunAt);
        log(`「${t.title}」错过了一次（程序没开），已顺延到 ${t.nextAt ? T.fmtDateTime(new Date(t.nextAt)) : '—'}`);
      }
      dirty = true;
      continue;
    }

    t.nextAt = t.enabled ? T.computeNext(t.when, now, now) : 0;
    dirty = true;
    // 先落盘再执行，避免执行期间再次 tick 造成重复触发
    save(d);
    // 不 await：任务是异步的，先回执、再后台跑，tick 不该被单个任务卡住
    runTask(t).catch((e) => log('执行异常: ' + ((e && e.message) || e)));
  }

  if (dirty) save(d);
}

function start() {
  if (timer) return;
  // 先对齐一次 nextAt，再按 tick 走
  try {
    const d = load();
    const now = Date.now();
    let dirty = false;
    for (const t of d.tasks) {
      if (!t.enabled) continue;
      if (!t.nextAt || t.nextAt < now - 6 * 3600000) {
        t.nextAt = T.computeNext(t.when, now, t.lastRunAt);
        dirty = true;
      }
    }
    if (dirty) save(d);
  } catch (e) { /* ignore */ }

  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (timer.unref) timer.unref();
  const n = load().tasks.filter((t) => t.enabled).length;
  log(`调度已启动，共 ${n} 个启用中的任务`);
  // 启动 20 秒后先跑一次，处理「刚好错过」的情况
  setTimeout(() => { tick().catch(() => {}); }, 20000);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  ackTimers.forEach((t) => clearTimeout(t));
  ackTimers.clear();
}

function status() {
  const d = load();
  const enabled = d.tasks.filter((t) => t.enabled);
  return {
    enabled: cfg().schedEnabled !== false,
    total: d.tasks.length,
    active: enabled.length,
    next: enabled
      .map((t) => ({ id: t.id, title: t.title, nextAt: t.nextAt, whenText: T.describeWhen(t.when) }))
      .filter((t) => t.nextAt)
      .sort((a, b) => a.nextAt - b.nextAt)
      .slice(0, 5),
    running: runningIds(),
    runningInfo: runningInfo(),
    queued: queue.length,
    concurrency: maxConcurrency(),
    log: d.log.slice(-20).reverse()
  };
}

// ---------------- 常用模板 ----------------

const PRESETS = [
  {
    key: 'morning',
    title: '每日早报',
    when: { type: 'daily', time: '08:30' },
    prompt: '给我一份今天的早报：今天日期和星期、本地天气（按需搜索）、国内外 3 条重要新闻、以及一句给我的提醒。控制在 200 字以内。'
  },
  {
    key: 'sit',
    title: '久坐提醒',
    when: { type: 'interval', minutes: 60 },
    prompt: '提醒我起来活动一下：用一句轻松的话提醒我站起来走两分钟，顺便看一眼当前时间。'
  },
  {
    key: 'water',
    title: '喝水提醒',
    when: { type: 'daily', time: '15:00' },
    prompt: '提醒我喝水，一句俏皮话就行。'
  },
  {
    key: 'market',
    title: '收盘复盘',
    when: { type: 'weekly', time: '15:10', days: [1, 2, 3, 4, 5] },
    prompt: '今天 A 股收盘了，简单说一下大盘表现和值得关注的方向，100 字以内。'
  },
  {
    key: 'night',
    title: '睡前小结',
    when: { type: 'daily', time: '22:30' },
    prompt: '帮我做个小结：现在几点了，用一句话祝我晚安，并提醒我明天最重要的那件事（如果记忆里有的话）。'
  }
];

function presetList() {
  return PRESETS.map((p) => ({ key: p.key, title: p.title, whenText: T.describeWhen(p.when), prompt: p.prompt }));
}

function addPreset(key) {
  const p = PRESETS.find((x) => x.key === key);
  if (!p) return { ok: false, error: '没有这个模板' };
  const d = load();
  if (d.tasks.some((t) => t.title === p.title)) return { ok: false, error: '已经有同名任务了' };
  return add({ title: p.title, prompt: p.prompt, when: p.when, source: 'user' });
}

// ---------------- 给 Agent 用的工具 ----------------

const TOOL = {
  type: 'function',
  function: {
    name: 'schedule_task',
    description: [
      '给自己排一个定时任务：到点自动执行一段任务，并把结果主动播报给主人（弹面板 + 宠物播报）。',
      '适用场景：主人说「每天早上 8 点给我播天气」「30 分钟后提醒我」，或者你判断某件事需要定期跟进。',
      '时间用本机时区。when 支持：',
      '{"type":"daily","time":"08:30"} 每天 /',
      '{"type":"weekly","time":"09:00","days":[1,3,5]} 每周（0=周日）/',
      '{"type":"monthly","time":"09:00","day":1} 每月 /',
      '{"type":"interval","minutes":30} 每隔多久 /',
      '{"type":"once","at":"2026-09-15 09:00"} 只一次。'
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'update', 'delete', 'run', 'presets'],
          description: '要做什么：列出 / 新建 / 修改 / 删除 / 立刻执行一次 / 看预置模板'
        },
        id: { type: 'string', description: '任务 id（修改、删除、立刻执行时必填）' },
        title: { type: 'string', description: '任务名，比如「每日早报」' },
        prompt: { type: 'string', description: '到点要执行的具体任务，写清楚要什么结果' },
        when: { type: 'object', description: '时间安排，见上面的格式' },
        enabled: { type: 'boolean', description: '是否启用' },
        wake: { type: 'boolean', description: '是否唤起主人（弹面板 + 朗读），默认 true' }
      },
      required: ['action']
    }
  }
};

/** 工具调用入口：返回 { content: '给模型看的文本' } */
async function handleTool(args = {}) {
  const action = String(args.action || 'list').toLowerCase();

  if (action === 'list') {
    const items = list();
    if (!items.length) return { content: '现在没有任何定时任务。' };
    return {
      content: items.map((t) => `- ${t.title}｜${t.whenText}｜${t.enabled === false ? '已暂停' : t.etaText}｜id=${t.id}`).join('\n')
    };
  }

  if (action === 'presets') {
    return { content: '可用模板：\n' + presetList().map((p) => `- ${p.title}（${p.whenText}）key=${p.key}`).join('\n') };
  }

  if (action === 'create') {
    const r = add({ title: args.title, prompt: args.prompt, when: args.when, wake: args.wake, source: 'ai' });
    if (!r.ok) return { content: '创建失败：' + r.error };
    return {
      content: `已创建定时任务「${r.task.title}」，${r.task.whenText}，下次执行：${r.task.nextAt ? T.fmtDateTime(new Date(r.task.nextAt)) : '—'}`
    };
  }

  if (action === 'update') {
    const r = update(args.id, args);
    if (!r.ok) return { content: '修改失败：' + r.error };
    return { content: `已更新「${r.task.title}」，${r.task.whenText}` };
  }

  if (action === 'delete') {
    const t = get(args.id);
    const r = remove(args.id);
    return { content: r.ok ? `已删除「${(t && t.title) || args.id}」` : '没找到这个任务，先用 list 看一下 id' };
  }

  if (action === 'run') {
    const t = get(args.id);
    if (!t) return { content: '没找到这个任务，先用 list 看一下 id' };
    const r = await runNow(args.id);
    return { content: r.ok ? `已执行「${t.title}」：${r.text}` : `执行失败：${r.error || r.text}` };
  }

  return { content: '不认识的 action，可用：list / create / update / delete / run / presets' };
}

module.exports = {
  bind,
  start,
  stop,
  tick,
  list,
  rawList,
  add,
  update,
  remove,
  get,
  runNow,
  kick,
  runOnce,
  runTask,
  runningInfo,
  status,
  presetList,
  addPreset,
  TOOL,
  handleTool
};
