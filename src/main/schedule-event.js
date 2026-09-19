/**
 * `schedule:event` 这条推送的契约 —— 事件类型、每种类型**精确**带哪些字段、唯一的构造出口。
 *
 * 为什么值得单独成文件
 * --------------------
 * 主进程此前在三个地方裸 `emit({...})`，面板那边是一个
 * `if (p.type === 'start') { ... } else { ... }` —— **除了 `start`，一律当成「跑完了」**。
 * 于是 `pump()` 发的那条 `drop`（任务还在排队时就不见了）落进 else 分支，弹出一句
 * 「「X」办好了（0s）」：一个一次都没跑、也不会有结论的任务，被播报成完成了。
 * 而 `pump()` 那段注释写的恰恰是「删掉的任务……更不该主动播报」。
 *
 * 与此同时，面板在 else 分支里读的字段，三类事件里根本没人发：
 *   · `p.ok` / `p.text` / `p.ms` —— `drop` 一个都不带；
 *   · `p.silent` —— **三类事件谁都不带**，那个 `if (!p.silent)` 从来没有为假过，
 *     它唯一的作用是让读代码的人以为「静默的任务不会弹提示」，而事实是每一条都弹。
 *
 * 根因不是「写错了一个 if」，是**这条推送没有契约**：发的人各自手搓对象、收的人靠猜。
 * 所以这里把类型与字段表钉成唯一来源，主进程只留这三个构造器出口；面板侧的分派
 * （`panel.js` 的 `scheduleEventPlan()`）由 `build/_schedule_event_contract_test.mjs`
 * 与这张表**两向对账**：这里加一个类型而面板没加分支、或者面板的分支比这里多，都会红。
 */
'use strict';

/** 协议里存在的全部事件类型（这里是唯一来源，面板的分支要与它两向相等）。 */
const TYPES = ['start', 'done', 'drop'];

/**
 * 每种事件**精确**的字段表：字段名 → 值的 `typeof`。
 *
 * 「精确」是刻意的 —— **多出一个字段也算违约**。多出来的那个字段，就是有人以为对面
 * 会读它（`silent` 就是这么来的）；没人读，它只是个写着好玩的名字，而下一个读代码的
 * 人会当真。
 */
const FIELDS = {
  start: { id: 'string', title: 'string', manual: 'boolean' },
  done: { id: 'string', title: 'string', ok: 'boolean', text: 'string', ms: 'number' },
  drop: { id: 'string', title: 'string', why: 'string' },
};

const str = (v) => (v == null ? '' : String(v));

/**
 * 「任务开始跑了」—— 面板据此把那一行变成运行中，并（非手动时）提示一句「到点了」。
 *
 * 注意它**不带结果字段**（`ok` / `text` / `ms`）：这是设计的另一半 ——
 * 让「开始」与「结束」在字段层面就分得开，`drop` 这种两者都不是的事件才有位置站。
 */
function evStart(task, opts = {}) {
  return {
    type: 'start',
    id: str(task && task.id),
    title: str(task && task.title),
    manual: !!(opts && opts.manual),
  };
}

/** 「跑完了」——成功与失败都走这条，`ok` 是唯一的分岔 */
function evDone(task, r = {}) {
  return {
    type: 'done',
    id: str(task && task.id),
    title: str(task && task.title),
    ok: r.ok === true,                        // 非 true 一律按失败算：只有真成功才是 true
    text: str(r.text),
    ms: Number.isFinite(Number(r.ms)) ? Number(r.ms) : 0,
  };
}

/**
 * 「还没轮到它，它就不在了」—— **它不是完成**。
 *
 * 携带 `why` 说清是哪条路摘掉的（目前只有 `gone`：排队期间任务被删/被改了），
 * 面板据此**不许**说「办好了」。
 */
function evDrop(task, why) {
  return {
    type: 'drop',
    id: str(task && task.id),
    title: str(task && task.title),
    why: str(why),
  };
}

/**
 * 校验一条事件是否满足契约，返回 `{ ok, errors }`。
 *
 * 主进程运行时**不**调它（构造器已经保证了形状）—— 它在这里是**判据**：
 * 测试拿它验三个构造器的输出、也拿它验「手搓一条事件会怎样」。把判据和构造器放在
 * 同一个文件里，是为了让「字段表」与「谁在按它发」永远看得见彼此。
 */
function checkEvent(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return { ok: false, errors: ['事件必须是一个对象'] };
  }
  if (!Object.prototype.hasOwnProperty.call(FIELDS, p.type)) {
    return {
      ok: false,
      errors: [`未知的事件类型 ${JSON.stringify(p.type)}（协议里只有 ${TYPES.join(' / ')}）`],
    };
  }
  const spec = FIELDS[p.type];
  const errors = [];
  for (const [k, t] of Object.entries(spec)) {
    if (!Object.prototype.hasOwnProperty.call(p, k)) {
      errors.push(`${p.type} 少了必填字段 ${k}`);
      continue;
    }
    if (typeof p[k] !== t) errors.push(`${p.type}.${k} 应该是 ${t}，实际是 ${typeof p[k]}`);
  }
  for (const k of Object.keys(p)) {
    if (k === 'type') continue;
    if (!Object.prototype.hasOwnProperty.call(spec, k)) {
      errors.push(`${p.type} 多出字段 ${k} —— 没有事件带它，读它只会读到 undefined`);
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { TYPES, FIELDS, evStart, evDone, evDrop, checkEvent };
