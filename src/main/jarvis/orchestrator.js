/**
 * 子代理编排 —— 小问当主管，子代理干活。
 *
 * 主人交代一件事之后：
 *   1) 小问判断这是不是「常任务」（多步、批量、要跑一会儿）
 *      —— 是：拆成若干子任务，派给子代理，先把计划告诉主人
 *      —— 否：自己顺手答了，不折腾
 *   2) 子代理只干自己那一摊，拿不准就用 ask_supervisor 请示；
 *      小问优先决策（不反手去问主人），直接给决定，子代理照做
 *   3) 每个子任务回来小问都要过一眼：合格就过，不合格就改派/重试
 *   4) 全部收工后小问汇总成一段话向主人汇报
 */
const agent = require('./agent');

const now = () => Date.now();
let seq = 0;
const nextId = (p) => `${p || 'id'}_${(++seq).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

// ---------------- 基础请求 ----------------
function normalizeBaseUrl(base) {
  return String(base || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** 一次「想清楚就行」的短调用：不流式、不外显，给主管和子代理内部用 */
async function quickChat({ cfg, system, user, temperature = 0.2, timeoutMs = 60000, signal }) {
  const baseUrl = normalizeBaseUrl(cfg.apiBaseUrl);
  if (!baseUrl || !cfg.apiKey || !cfg.model) throw new Error('尚未配置模型接口');

  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { /* ignore */ } }, timeoutMs);
  if (signal && typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', () => { try { ctrl.abort(); } catch (e) { /* ignore */ } });
  }

  try {
    const res = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature,
        stream: false
      }),
      signal: ctrl.signal
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}：${raw.slice(0, 200)}`);
    const j = JSON.parse(raw);
    const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return String(content || '').trim();
  } finally {
    clearTimeout(timer);
  }
}

/** 从模型输出里抠出 JSON（允许被 ```json 包着、前面带废话） */
function parseJson(text) {
  const s = String(text || '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (e) {
    // 末尾多了逗号之类，再抢救一次
    try {
      const fixed = body.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(fixed);
    } catch (e2) {
      return null;
    }
  }
}

// ---------------- 子代理专用工具 ----------------
const ASK_TOOL = {
  type: 'function',
  function: {
    name: 'ask_supervisor',
    description: '拿不准的时候向主管「小问」请示。小问会直接给你一个决定，你按决定继续执行，不要反问。适合：几种做法挑一个、遇到和任务目标冲突的情况、需要主人偏好但你看不到。不要用它汇报进度。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '一句话说清卡在哪' },
        options: { type: 'array', items: { type: 'string' }, description: '你想到的几个可选做法（可省）' }
      },
      required: ['question']
    }
  }
};

// 主对话里小问也可以主动派活
const DELEGATE_TOOL = {
  type: 'function',
  function: {
    name: 'delegate_task',
    description: '把一件可以独立完成的子任务派给子代理去做，自己继续推进别的事。适合耗时长、步骤多、但你不需要盯过程的事。子代理干完会把结果摘要交回来。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '任务标题，十个字以内' },
        instruction: { type: 'string', description: '给子代理的完整指令：目标、产出、约束，要能独立看懂' },
        context: { type: 'string', description: '必要的背景信息（可省）' }
      },
      required: ['title', 'instruction']
    }
  }
};

// ---------------- 规则预判 ----------------
const TRIGGER_WORDS = [
  '帮我整理', '帮我检查', '帮我分析', '帮我总结', '批量', '全部', '每一个', '逐个',
  '每天', '每周', '定时', '定期', '常任务', '监控', '巡检', '报告', '汇总',
  '生成', '写一份', '调研', '对比', '梳理', '排查', '自动化', '一条龙'
];

/** 便宜的规则预判：明显是单步问答就别浪费一次规划调用 */
function looksLikeBigJob(goal) {
  const g = String(goal || '').trim();
  if (g.length >= 24) return true;
  return TRIGGER_WORDS.some((w) => g.includes(w));
}

// ---------------- 编排主体 ----------------
class Orchestrator {
  constructor({ cfg, sender, sessionId, opts = {} }) {
    this.cfg = cfg || {};
    this.sender = sender;
    this.sessionId = sessionId;
    this.opts = opts;
    this.tasks = [];
    this.log = [];
    this.controller = new AbortController();
    this.aborted = false;
    this.header = '';
    this.maxWorkers = Math.max(1, Math.min(4, Number(cfg.orchMaxWorkers) || 2));
    this.maxTasks = Math.max(1, Math.min(10, Number(cfg.orchMaxTasks) || 6));
    this.retry = Math.max(0, Math.min(3, Number(cfg.orchRetry) === undefined ? 1 : Number(cfg.orchRetry)));
  }

  emit(channel, payload) {
    try {
      if (this.sender && !this.sender.isDestroyed()) this.sender.send(channel, payload);
    } catch (e) { /* ignore */ }
  }

  /** 往对话流里写一句（主人能看到小问在干什么） */
  say(text) {
    this.log.push(String(text));
    try {
      if (this.sender && !this.sender.isDestroyed()) this.sender.send('chat:delta', String(text));
    } catch (e) { /* ignore */ }
  }

  petAct(action, extra) {
    try {
      if (this.cfg.petAgentLink === false) return;
      const pet = require('../pet');
      pet.petAct(action, extra);
    } catch (e) { /* ignore */ }
  }

  abort() {
    this.aborted = true;
    try { this.controller.abort(); } catch (e) { /* ignore */ }
  }

  // ---------- 1. 小问拆解任务 ----------
  async plan(goal) {
    const sys = [
      '你是「小问」，一个桌面 AI 助手的主管。主人刚提了一个需求，你要决定自己干还是拆给子代理干。',
      '判断标准：',
      '- 一两步就能答完（问答、翻译、解释、查个东西）→ needSplit 填 false，tasks 为空',
      `- 需要多步执行、批量处理、调用多个工具、或者要跑一会儿 → needSplit 填 true，拆成 2~${this.maxTasks} 个子任务`,
      '拆任务的要求：',
      '1. 每个子任务要能独立完成，不要互相依赖，可以并行',
      '2. instruction 必须自包含：子代理看不到主人的原话，把目标、产出格式、约束条件都写清楚',
      '3. 不要拆得太碎，一个子任务应该是「一件事」',
      '4. title 十个字以内',
      '只输出 JSON，不要解释：',
      '{"needSplit": false, "reason": "一句话", "tasks": [{"title": "", "instruction": ""}]}'
    ].join('\n');

    const d = new Date();
    const user = [
      `当前时间：${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`,
      `主人的需求：\n${goal}`
    ].join('\n');

    let raw = '';
    try {
      raw = await quickChat({ cfg: this.cfg, system: sys, user, temperature: 0.1, signal: this.controller.signal });
    } catch (e) {
      return { needSplit: false, reason: '规划调用失败，按单步处理：' + ((e && e.message) || e) };
    }

    const j = parseJson(raw);
    if (!j) return { needSplit: false, reason: '没解析出任务清单，按单步处理' };
    if (!j.needSplit) return { needSplit: false, reason: String(j.reason || '一步就能做完') };

    const list = (Array.isArray(j.tasks) ? j.tasks : [])
      .map((t) => ({
        id: nextId('t'),
        title: String((t && t.title) || '未命名任务').slice(0, 40),
        instruction: String((t && t.instruction) || '').trim(),
        status: 'pending',
        attempt: 0,
        summary: '',
        asks: []
      }))
      .filter((t) => t.instruction)
      .slice(0, this.maxTasks);

    if (!list.length) return { needSplit: false, reason: '任务清单为空，按单步处理' };
    return { needSplit: true, reason: String(j.reason || ''), tasks: list };
  }

  // ---------- 2. 小问拍板（子代理请示时） ----------
  async decide(task, question, options) {
    const askId = nextId('ask');
    this.emit('orch:ask', { id: askId, taskId: task.id, taskTitle: task.title, question, options: options || [], status: 'asking' });
    this.petAct('think');

    const sys = [
      '你是「小问」，桌面 AI 助手的主管。有个子代理正在干活，遇到了拿不准的地方来请示你。',
      '要求：',
      '1. 直接拍板给一个明确决定，不要反问、不要罗列所有可能性',
      '2. 两句话以内，先说「怎么做」，必要时补一句「为什么」',
      '3. 涉及删除 / 覆盖 / 花钱 / 对外发送等高风险动作时，选最保守的那个方案',
      '4. 不要说「你可以…」，要说「就按…做」'
    ].join('\n');

    const user = [
      `子代理任务：${task.title}`,
      `任务指令：${String(task.instruction).slice(0, 400)}`,
      `它问：${question}`,
      (options && options.length) ? `它想到的选项：\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}` : ''
    ].filter(Boolean).join('\n');

    let answer = '';
    try {
      answer = await quickChat({
        cfg: this.cfg, system: sys, user, temperature: 0.2, timeoutMs: 45000, signal: this.controller.signal
      });
    } catch (e) {
      answer = '';
    }
    if (!answer) answer = '按你判断的最稳妥方式继续，遇到风险操作先停下别做。';

    task.asks.push({ question, answer });
    this.emit('orch:ask', { id: askId, taskId: task.id, taskTitle: task.title, question, answer, status: 'answered' });
    this.say(`\n\n> 子代理问：${question}\n> 小问决定：${answer}\n\n`);
    return answer;
  }

  // ---------- 3. 子代理执行 ----------
  async runWorker(task) {
    const workerId = task.id;
    let askCount = 0;

    const intercept = async (name, args) => {
      if (name !== 'ask_supervisor') return null;
      askCount++;
      if (askCount > 3) {
        return { content: '请示次数太多了，按你自己的判断选最稳妥的方式做完，不要再问。' };
      }
      const answer = await this.decide(task, String(args.question || '').slice(0, 500), Array.isArray(args.options) ? args.options.slice(0, 5) : []);
      return { content: `主管决定：${answer}` };
    };

    const systemExtra = [
      `你是子代理（代号 ${workerId}），主管是「小问」。主人交代的事已经被拆好，你只负责下面这一件：`,
      '要求：',
      '1. 只做这个任务，不要顺手扩张范围，不要替别的子代理操心',
      '2. 需要真实信息就用工具，不要编',
      '3. 拿不准就用 ask_supervisor 请示，小问会给明确决定，你照做就行',
      '4. 做完后用一小段话回报：做了什么、结果是什么、有什么遗留问题。不要写长报告，不要复述工具原始输出'
    ].join('\n');

    const messages = [{ role: 'user', content: task.instruction }];

    const res = await agent.runAgent({
      messages,
      cfg: this.cfg,
      sender: this.sender,
      signal: this.controller.signal,
      opts: {
        useTools: this.cfg.agentUseTools !== false,
        useMcp: this.cfg.agentUseMcp !== false,
        useSkills: this.cfg.agentUseSkills !== false,
        useMemory: false,
        sessionId: this.sessionId,
        systemExtra,
        extraTools: [ASK_TOOL],
        dropTools: ['delegate_task'],
        quiet: true,
        intercept,
        workerId,
        maxRounds: 10,
        hooks: {
          onStart: () => this.emit('orch:task', { id: task.id, title: task.title, status: 'running' }),
          onTool: (p) => {
            if (p && p.status === 'start') this.petAct('work', { tool: (p.names || []).join('、') });
          }
        }
      }
    });

    return res;
  }

  // ---------- 4. 小问验收 ----------
  async review(task, res) {
    if (this.aborted) return { pass: false, reason: '已中断' };
    if (!res || !res.ok) return { pass: false, reason: (res && res.error) || '子代理执行失败' };
    if (!String(res.text || '').trim()) return { pass: false, reason: '子代理没有给出任何结果' };
    if (this.cfg.orchReview === false) return { pass: true, reason: '（未开启复核）' };

    const sys = [
      '你是主管「小问」。子代理交回来一份结果，你判断它是否达成了任务目标。',
      '只输出 JSON：{"pass": true/false, "reason": "一句话"}',
      '判定标准：目标是否达成、结果是否可信（有没有明显胡编或空话）。失败重试仍有价值才 pass=false。'
    ].join('\n');
    const user = [
      `任务：${task.title}`,
      `指令：${String(task.instruction).slice(0, 400)}`,
      `子代理回报：${String(res.text || '').slice(0, 1500)}`
    ].join('\n');

    try {
      const raw = await quickChat({
        cfg: this.cfg, system: sys, user, temperature: 0, timeoutMs: 45000, signal: this.controller.signal
      });
      const j = parseJson(raw);
      if (j && typeof j.pass === 'boolean') return { pass: !!j.pass, reason: String(j.reason || '') };
    } catch (e) { /* 复核失败就当通过，不拖节奏 */ }
    return { pass: true, reason: '' };
  }

  // ---------- 5. 跑一轮任务 ----------
  async runTask(task) {
    task.status = 'running';
    task.startedAt = now();
    this.emit('orch:task', { id: task.id, title: task.title, status: 'running', attempt: task.attempt + 1 });

    let lastRes = null;
    for (let attempt = 0; attempt <= this.retry; attempt++) {
      if (this.aborted) break;
      task.attempt = attempt + 1;
      this.say(`\n- **${task.title}**（第 ${attempt + 1} 次）开工\n`);
      lastRes = await this.runWorker(task);
      const verdict = await this.review(task, lastRes);
      if (verdict.pass) {
        task.status = 'done';
        task.summary = String((lastRes && lastRes.text) || '').trim();
        task.finishedAt = now();
        this.emit('orch:task', {
          id: task.id, title: task.title, status: 'done',
          summary: task.summary.slice(0, 600), attempt: task.attempt
        });
        this.petAct('done');
        return task;
      }
      task.lastError = verdict.reason;
      this.say(`\n  - 没过（${verdict.reason}）${attempt < this.retry ? '，再派一次' : ''}\n`);
    }

    task.status = 'failed';
    task.summary = String((lastRes && (lastRes.error || lastRes.text)) || '').trim();
    task.finishedAt = now();
    this.emit('orch:task', { id: task.id, title: task.title, status: 'failed', summary: task.summary.slice(0, 600), attempt: task.attempt });
    this.petAct('error');
    return task;
  }

  // ---------- 6. 总流程 ----------
  async run(goal) {
    const plan = await this.plan(goal);
    if (!plan.needSplit) return { delegated: false, reason: plan.reason };

    this.tasks = plan.tasks;
    this.petAct('think');
    this.emit('orch:plan', { goal, tasks: this.tasks.map(publicTask) });

    // 先把「派了什么活」摆出来 —— 主人要能一眼看到小问把事情交给了谁
    this.header = `🗂 **这件事我拆成 ${this.tasks.length} 个任务，已经派给子代理了**`
      + (plan.reason ? `（${plan.reason}）` : '')
      + '，我在旁边盯着，它们拿不准会来问我。\n\n'
      + this.tasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n')
      + '\n';
    this.say('\n' + this.header + '\n');

    // 并发池：同时最多 orchMaxWorkers 个子代理在跑
    const queue = this.tasks.slice();
    const running = new Set();
    while ((queue.length || running.size) && !this.aborted) {
      while (queue.length && running.size < this.maxWorkers) {
        const t = queue.shift();
        const p = this.runTask(t)
          .then((done) => { running.delete(p); return done; })
          .catch(() => { running.delete(p); return t; });
        running.add(p);
      }
      if (running.size) await Promise.race(running);
    }
    // 兜底：把还没结束的都等完
    await Promise.all(Array.from(running)).catch(() => {});

    return this.summarize(goal);
  }

  async summarize(goal) {
    const done = this.tasks.filter((t) => t.status === 'done');
    const failed = this.tasks.filter((t) => t.status === 'failed');
    const aborted = this.aborted;

    const sys = [
      '你是主管「小问」。子代理们已经干完活了，现在由你向主人汇报。',
      '要求：',
      '1. 用中文，口语化，像跟同事交代事情，别写公文',
      '2. 先说结论（办成了没有），再按任务说要点，每项一两句',
      '3. 失败的要说明卡在哪、你打算怎么办（或建议主人怎么办）',
      '4. 不要罗列工具原始输出，不要写「任务1」「任务2」这种编号标题，直接说事',
      '5. 控制在 300 字以内'
    ].join('\n');

    const body = this.tasks.map((t) => `【${t.title}】${t.status === 'done' ? '完成' : '失败'}\n${t.summary}`).join('\n\n');
    const user = `主人的需求：${goal}\n\n子代理回报：\n${body}`;

    let summary = '';
    try {
      summary = await quickChat({ cfg: this.cfg, system: sys, user, temperature: 0.4, timeoutMs: 90000 });
    } catch (e) {
      summary = '';
    }
    if (!summary) {
      summary = (aborted ? '（已中断）' : '') +
        `派了 ${this.tasks.length} 个任务，完成 ${done.length} 个${failed.length ? `，失败 ${failed.length} 个` : ''}。\n\n` +
        this.tasks.map((t) => `· ${t.title}：${t.status === 'done' ? '完成' : '失败'} —— ${String(t.summary || '').slice(0, 200)}`).join('\n');
    }

    this.emit('orch:done', {
      goal, ok: failed.length === 0 && !aborted, aborted,
      done: done.length, failed: failed.length,
      tasks: this.tasks.map(publicTask), summary
    });

    const detail = this.tasks.map((t) => {
      const mark = t.status === 'done' ? '✅' : (t.status === 'failed' ? '❌' : '⏸');
      const body = String(t.summary || '（没有回报）').trim().slice(0, 400);
      return `**${mark} ${t.title}**${t.attempt > 1 ? `（第 ${t.attempt} 次）` : ''}\n${body}`;
    }).join('\n\n');
    const report = `${this.header || ''}\n${detail}\n\n---\n\n${summary}\n`;

    this.say('\n---\n\n' + summary + '\n');
    this.petAct(failed.length ? 'error' : 'done');
    return {
      delegated: true,
      text: report,
      summary,
      tasks: this.tasks.map(publicTask),
      ok: failed.length === 0 && !aborted
    };
  }
}

function publicTask(t) {
  return {
    id: t.id, title: t.title, status: t.status, attempt: t.attempt,
    summary: String(t.summary || '').slice(0, 400),
    asks: (t.asks || []).slice(-3)
  };
}

// ---------------- 对外：主对话里主动派一个活 ----------------
async function delegateOnce({ title, instruction, context, cfg, sender, sessionId }) {
  const orch = new Orchestrator({ cfg, sender, sessionId, opts: {} });
  const task = {
    id: nextId('t'),
    title: String(title || '子任务').slice(0, 40),
    instruction: [context ? `背景：${context}` : '', String(instruction || '')].filter(Boolean).join('\n'),
    status: 'pending',
    attempt: 0,
    summary: '',
    asks: []
  };
  orch.tasks = [task];
  orch.emit('orch:plan', { goal: task.title, tasks: [publicTask(task)] });
  orch.say(`\n\n📮 派了个活给子代理：**${task.title}**\n`);
  const t = await orch.runTask(task);
  const out = t.status === 'done'
    ? `子代理已完成「${t.title}」：\n${t.summary}`
    : `子代理没能完成「${t.title}」：${t.summary || '未知原因'}`;
  orch.emit('orch:done', { goal: task.title, ok: t.status === 'done', done: t.status === 'done' ? 1 : 0, failed: t.status === 'done' ? 0 : 1, tasks: [publicTask(t)], summary: out });
  return { ok: t.status === 'done', output: out };
}

module.exports = {
  Orchestrator,
  delegateOnce,
  DELEGATE_TOOL,
  ASK_TOOL,
  looksLikeBigJob,
  parseJson
};
