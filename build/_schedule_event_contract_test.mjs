/**
 * `schedule:event` 这条推送的契约 —— node build/_schedule_event_contract_test.mjs
 *
 * 被测的是**两边之间那份没人写下来的约定**。此前主进程在三处裸 `emit({...})` 手搓
 * 对象，面板那边是一个 `if (p.type === 'start') { ... } else { ... }` ——
 * **除了 `start` 之外的一切都被当成「跑完了」**。而主进程还会发第三种：`drop`
 * （任务还在排队时就不见了）。于是删掉一个排队中的任务，面板弹的是
 * 「「X」办好了（0s）」：一次都没跑、也不会有结论的任务被说成完成了。
 *
 * 同一段 else 里读的 `p.silent` 更直接：**三类事件谁都不带这个字段**，
 * `if (!p.silent)` 从来没有为假过 —— 一个写着守卫样子、实际什么都没挡的东西。
 *
 * 所以这里钉四层，缺一层都会留下「看起来有人在管」的假象：
 *   1) **形状层**：构造器的输出 ⇄ 字段表（现算，不手抄）；
 *   2) **判据层**：`checkEvent()` 自己会红（未知类型 / 缺字段 / 类型不符 / 多出字段）；
 *   3) **接线层**：主进程只许从构造器出口发事件（剥注释后读源码）；
 *   4) **端到端**：真调度器跑出来的事件，逐条喂给面板那个真分派函数 ——
 *      包括那条 `drop`，它**不许**被说成「办好了」。
 *
 * 两边的一致性靠**两向**：主进程的类型表 ⇄ 面板分派里的 `case` 集合，任一方向多出
 * 一个都要红（多出来的那个就是「没人处理的事件」）。
 */
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { stripComments, residueErrors } from './_strip_comments.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0; const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else fails.push(name + (extra ? ` → ${extra}` : '')); };
const eq = (a, b, name) => ok(
  JSON.stringify(a) === JSON.stringify(b), name,
  `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`
);
const section = (s) => console.log('\n' + s);

const contract = require('../src/main/schedule-event.js');
const { TYPES, FIELDS, evStart, evDone, evDrop, checkEvent } = contract;

const readSrc = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf-8');

/**
 * 面板源码 —— **剥掉注释**再用来做判定 / 抽取。
 *
 * 剥注释不是洁癖：本仓的接线锁都是读源码判定的，而注释里正大光明地写着旧判据与旧缺陷
 * （本轮我就在 `scheduleEventPlan()` 的说明里写了 `p.silent` 那三个字）。不剥就会把
 * 注释当实现 —— 第 9 / 19 / 25 轮各栽过一次，这次是第四次差点栽（自检里那条「不许再读
 * p.silent」先红了）。字符串字面量由 `stripComments` 保护。
 */
const parsePanel = () => stripComments(readSrc('src/renderer/js/panel.js'));

// ── 0. 地基：剥注释器自证 ──
//
// 本文件（以及 `_capture_plan_test.mjs` / `_updater_plan_test.mjs`）里所有「读源码」的
// 判定都靠 `stripComments`。它此前**在 panel.js 上几乎什么都没剥**（42 条唯一块注释
// 留着 33 条，体量只减 1.5%），却照样返回字符串、不抛错 —— 于是那些锁其实是对着
// 「带注释的源码」做的判定。本轮既然是靠它判定，就先把它自己验一遍。

section('0. 地基：剥注释器自证');
{
  const cases = [
    ['字符串里的 // 不算注释', "const u = 'https://x'; // 真注释\nconst v = 1;",
      (o) => o.includes('https://x') && o.includes('const v = 1;') && !o.includes('真注释')],
    ['字符串里的 /* 不算注释', "const u = '/*x*/'; // 真注释\nconst v = 1;",
      (o) => o.includes('/*x*/') && !o.includes('真注释')],
    ['正则里的引号不许把扫描带偏', 'const e = s.replace(/[&<>"\']/g, \'x\'); /* 注释 */ const m = 2;',
      (o) => o.includes('/[&<>"\']/g') && !o.includes('注释') && o.includes('const m = 2;')],
    ['正则字符类里的 / 不算结束', 'const r = /[/]/g; /* 注释 */ const y = 2;',
      (o) => o.includes('/[/]/g') && !o.includes('注释') && o.includes('const y = 2;')],
    ['模板里的 ${} 嵌套（本仓面板里到处都是）', 'const t = `a${ `b${c}d` }e`; /* 注释 */ const z = 1;',
      (o) => !o.includes('注释') && o.includes('const z = 1;')],
    /* 嵌套模板真正的失效形态**不是**「注释多留一条」，而是**代码被吃掉**：
       丢掉 ${} 处理之后，内外两个反引号会错配，而错配的空档里扫描器以为自己在写代码
       —— 内层模板正文里的 `//` 就成了行注释，把它后面直到行尾的代码整段删掉。
       上面那条合成用例太温和（错配后能自己撞回来），这条才真的会红。 */
    ['模板里的 ${} 嵌套：内层正文里的 // 不许被当成注释',
      'const t = `a${ `//x` }c`; /* 注释 */ const z = 1;',
      (o) => o.includes('const z = 1;') && !o.includes('注释')],
    ['模板里 ${} 内的引号与花括号', 'const t = `a${ obj ? `{"k":1}` : "" }b`; /* 注释 */ const w = 1;',
      (o) => !o.includes('注释') && o.includes('const w = 1;')],
    ['除号不许被当成正则开头', 'const q = a / b; /* 注释 */ const w = 2;',
      (o) => o.includes('a / b') && !o.includes('注释') && o.includes('const w = 2;')],
    ['转义引号', "const s = 'it\\'s'; /* 注释 */ const r2 = 1;",
      (o) => o.includes("const r2 = 1;") && !o.includes('注释')],
    ['行注释吃掉整行直到换行', 'const a = 1; // x */ const b = 2;\nconst c = 3;',
      (o) => !o.includes('const b = 2;') && o.includes('const c = 3;')],
  ];
  for (const [name, raw, check] of cases) {
    const out = stripComments(raw);
    ok(check(out), `剥注释：${name}`, JSON.stringify(out));
    const res = residueErrors(raw, out);
    ok(res.length === 0, `剥注释后没有残留：${name}`, res[0]);
  }

  // 总闸自己要会红 —— 否则第 8 节那条「没有残留」是恒真的
  const dirty = 'const a = 1;\n// 还留着\n';
  ok(residueErrors(dirty, dirty).length > 0, '总闸判失败：结果里还留着行注释');
  ok(residueErrors('a /* x */ b', 'a /* x */ b').length > 0, '总闸判失败：结果里还留着块注释');
  ok(residueErrors('const a = 1;', 'const a = 1;').length > 0, '总闸判失败：体量 100%（根本没剥）');
  ok(residueErrors('const a = 1;', 'x').length > 0, '总闸判失败：体量 7%（可能把代码当注释吃了）');

  // 本文件真正要用的那两份源码
  for (const rel of ['src/main/jarvis/schedule.js', 'src/renderer/js/panel.js',
    'src/main/schedule-event.js']) {
    const src = readSrc(rel);
    const res = residueErrors(src, stripComments(src));
    ok(res.length === 0, `剥注释器在 ${rel} 上没有残留`, res[0]);
  }
}

// ── 1. 契约表自证（表坏了，后面每一条都会在空集上通过） ──

section('1. 契约表自证：类型与字段表不许为空、不许漂移');
{
  ok(Array.isArray(TYPES) && TYPES.length > 0, `TYPES 非空（${TYPES.length} 个）`,
    '类型表为空时「两向对账」会在空集上通过');
  eq(TYPES.slice().sort(), Object.keys(FIELDS).sort(), 'FIELDS 的键集合与 TYPES 相等（两向）');
  for (const t of TYPES) {
    const spec = FIELDS[t] || {};
    ok(Object.keys(spec).length > 0, `${t} 有字段表且非空`);
    ok(Object.values(spec).every((v) => typeof v === 'string' && v.length > 0),
      `${t} 每个字段都写了类型`);
    ok(Object.prototype.hasOwnProperty.call(spec, 'id'), `${t} 带 id（面板要靠它认哪一行）`);
  }
  // 三个类型必须各不相同 —— 否则「按 type 分派」这件事本身就是空的
  eq(new Set(TYPES).size, TYPES.length, 'TYPES 里没有重复');
  ok(TYPES.includes('start') && TYPES.includes('done') && TYPES.includes('drop'),
    'start / done / drop 三个都在（缺了哪个，面板那半就落回「一律当完成」）');
  // 开始与结束的字段必须分得开，`drop` 才有位置站
  ok(!Object.prototype.hasOwnProperty.call(FIELDS.start, 'ok'),
    'start 不带 ok —— 「开始」与「结束」在字段层面就要分得开');
  ok(!Object.prototype.hasOwnProperty.call(FIELDS.drop, 'ms'),
    'drop 不带 ms —— 它没有「用时」可言，带了个数就会被读成「跑过」');
}

// ── 2. 构造器真跑：输出 ⇄ 字段表（现算，不手抄） ──

section('2. 构造器真跑：输出与字段表逐项对得上');
{
  const task = { id: 't1', title: '每日早报', prompt: '看天气' };

  const cases = [
    ['start（定时触发）', evStart(task, { manual: false }), { manual: false }],
    ['start（手动点跑一次）', evStart(task, { manual: true }), { manual: true }],
    ['done（成功）', evDone(task, { ok: true, text: '今天晴', ms: 1234 }), { ok: true, ms: 1234 }],
    ['done（失败）', evDone(task, { ok: false, text: '模型拒绝服务', ms: 20 }), { ok: false, ms: 20 }],
    ['drop（排队期间被删）', evDrop(task, 'gone'), { why: 'gone' }],
  ];

  for (const [name, ev, expect] of cases) {
    const r = checkEvent(ev);
    ok(r.ok, `${name} 的输出满足契约`, (r.errors || []).join('；'));
    eq(ev.type, name.startsWith('start') ? 'start' : (name.startsWith('done') ? 'done' : 'drop'),
      `${name} 的 type 对得上`);
    eq(ev.id, 't1', `${name} 带上 id`);
    eq(ev.title, '每日早报', `${name} 带上 title`);
    // 字段表说什么，就要求什么 —— 不在这里手抄字段名
    eq(Object.keys(ev).filter((k) => k !== 'type').sort(), Object.keys(FIELDS[ev.type]).sort(),
      `${name} 的字段集合恰好等于字段表（不多不少）`);
    for (const [k, v] of Object.entries(expect)) eq(ev[k], v, `${name} 的 ${k}`);
  }

  // 归一化：真实调用点会传 undefined / 字符串数字，构造器不能把它们原样透出去
  const d1 = evDone(task, {});
  eq(d1.ok, false, 'done 没给 ok 时按**失败**算（只有真成功才是 true）');
  eq(d1.text, '', 'done 没给 text 时是空串，不是 undefined（undefined 过不了 IPC 阅读者的直觉）');
  eq(d1.ms, 0, 'done 没给 ms（或给了脏值）时是 0，不是 NaN');
  eq(evDone(task, { ok: true, text: 'x', ms: '1500' }).ms, 1500, 'ms 传字符串数字也能归一');
  eq(evStart({}, {}).id, '', 'task 是空的也不炸（ID 给空串）');
  eq(evStart({}, {}).manual, false, 'manual 默认 false');
  eq(evDrop({ id: 't2' }, undefined).why, '', 'drop 没给 why 时是空串');

  // 反向：构造器出来的东西**不许**混进任何没人发的字段
  for (const [name, ev] of cases.map((c) => [c[0], c[1]])) {
    ok(!Object.prototype.hasOwnProperty.call(ev, 'silent'),
      `${name} 不许带 silent —— 面板曾按它做守卫，而三类事件谁都不发这个字段`);
  }
}

// ── 3. checkEvent 自己会红 ──

section('3. 判据的负向：不满足契约的输入必须被指出来');
{
  const bad = [
    [null, '事件是 null'],
    [undefined, '事件是 undefined'],
    [[], '事件是数组'],
    [{ type: 'queue', id: 'a', title: 'b' }, '未知类型（协议里没有 queue）'],
    [{ type: 'start', id: 'a' }, 'start 少了 title'],
    [{ type: 'start', id: 'a', title: 'b' }, 'start 少了 manual'],
    [{ type: 'start', id: 1, title: 'b', manual: false }, 'start 的 id 是数字不是字符串'],
    [{ type: 'done', id: 'a', title: 'b', ok: 'true', text: '', ms: 0 }, 'done 的 ok 是字符串'],
    [{ type: 'drop', id: 'a', title: 'b' }, 'drop 少了 why'],
    [{ type: 'done', id: 'a', title: 'b', ok: true, text: '', ms: 0, silent: true },
      'done 多出一个没人发的字段（silent）'],
    [{ type: 'start', id: 'a', title: 'b', manual: false, ms: 3 }, 'start 多带 done 的字段'],
  ];
  for (const [p, name] of bad) {
    const r = checkEvent(p);
    ok(r.ok === false, `checkEvent 判失败：${name}`);
    ok(Array.isArray(r.errors) && r.errors.length > 0, `checkEvent 给出了原因：${name}`);
  }
  // 原型链上的名字不许被当成合法类型（'constructor' 这种）
  ok(checkEvent({ type: 'constructor', id: 'a', title: 'b' }).ok === false,
    'checkEvent 不认原型链上的键（type: "constructor"）');
  // 正向对照：合法输入必须绿 —— 否则上面十条「全红」可能只是判据永远红
  ok(checkEvent(evDone({ id: 'a', title: 'b' }, { ok: true, text: '', ms: 1 })).ok === true,
    '正向对照：合法事件判通过');
}

// ── 4. 接线层：主进程只从构造器出口发事件 ──

section('4. 主进程不许再手搓事件对象');
{
  const scheduleSrc = stripComments(readSrc('src/main/jarvis/schedule.js'));
  const bare = scheduleSrc.match(/emit\s*\(\s*\{/g) || [];
  eq(bare.length, 0, '找不到裸的 `emit({`（手搓事件对象）',
    `还有 ${bare.length} 处：${(scheduleSrc.match(/emit\s*\(\s*\{[\s\S]{0,60}/g) || []).join(' | ')}`);

  const calls = [...scheduleSrc.matchAll(/emit\(\s*([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
  eq(calls.slice().sort(), ['evDone', 'evDrop', 'evStart'],
    '三处 emit 分别走 evStart / evDone / evDrop（发事件的地方一个不少、也不多）');

  ok(/require\(['"]\.\.\/schedule-event['"]\)/.test(scheduleSrc),
    'schedule.js 确实从 schedule-event.js 取构造器');
  ok(/evDrop\(next\.task,\s*'gone'\)/.test(scheduleSrc),
    'pump 里那条「排队期间任务不见了」走 evDrop —— 它就是被当成「办好了」的那条');

  // `start` 的语义是「开跑了」。以前它在并发判断**之前**发，被排进队列的任务也会收到
  // 一条 `start` —— 面板按契约标成「运行中 Ns」，而它一个字节都没跑。
  ok(!/noAck/.test(scheduleSrc),
    'noAck 那个守卫已删 —— 全仓没有任何调用方设置它，`if (!opts.noAck)` 从来没有为假过');
  const startCalls = (scheduleSrc.match(/emitStart\(/g) || []).length;
  eq(startCalls, 2, 'emitStart 只剩「定义」与「真开跑处调用」两处（多一处就是又提前发了）');
  const runNow = scheduleSrc.match(/function runNow_\([\s\S]*?\n\}/);
  ok(!!runNow && /emitStart\(task,\s*opts\)/.test(runNow[0]),
    'emitStart 在 runNow_ 里（真开跑的地方），不在并发判断之前');
  ok(!/emitStart/.test((scheduleSrc.match(/function runTask\(task, opts = \{\}\) \{[\s\S]*?\n\}/) || [''])[0]),
    'runTask 里没有任何 emitStart —— 它还没定下来这个任务开不开跑（可能要排队）');
}

// ── 5. 面板分派被真跑（这是此前没有任何东西跑过的那一段） ──

section('5. 面板的事件分派：抽出来当场跑');
let planFn = null;
{
  const panel = parsePanel();
  const src = panel.match(/function scheduleEventPlan\(p\) \{[\s\S]*?\n\}/);
  ok(!!src, 'panel.js 里能抽到 scheduleEventPlan()（抽不到说明它被搬走 / 改名了）');
  if (src) {
    const text = src[0];
    // 解析面自证：抽到的必须是**整个**函数，不是被截断的半截
    for (const t of ['start', 'done', 'drop', 'default']) {
      ok(text.includes(`${t === 'default' ? 'default:' : `case '${t}'`}`) || text.includes(t),
        `抽到的分派里含 ${t} 分支`);
    }
    ok(text.trimEnd().endsWith('}'), '抽到的是完整函数（以 } 收尾）');
    // eslint-disable-next-line no-eval
    planFn = eval(`(${text})`);
    ok(typeof planFn === 'function', '抽出来的东西真的是个函数');
  }
}

if (planFn) {
  const task = { id: 't1', title: '每日早报' };

  const pStart = planFn(evStart(task, { manual: false }));
  eq(pStart.running, 'set', 'start → 标记运行中');
  ok(String(pStart.toast || '').includes('到点了'), 'start（定时）→ 提示「到点了」', String(pStart.toast));
  eq(planFn(evStart(task, { manual: true })).toast, null,
    'start（手动点跑一次）→ 不再提示「到点了」（他自己刚点的）');

  const pDoneOk = planFn(evDone(task, { ok: true, text: '今天晴', ms: 2500 }));
  eq(pDoneOk.running, 'clear', 'done → 摘掉运行中');
  ok(String(pDoneOk.toast).includes('办好了'), 'done（成功）→ 说「办好了」', String(pDoneOk.toast));
  ok(String(pDoneOk.toast).includes('3s'), 'done 的提示带上用时（2500ms → 3s）', String(pDoneOk.toast));

  const pDoneBad = planFn(evDone(task, { ok: false, text: '模型拒绝服务：额度用完', ms: 100 }));
  ok(String(pDoneBad.toast).includes('没办成'), 'done（失败）→ 说「没办成」', String(pDoneBad.toast));
  ok(String(pDoneBad.toast).includes('模型拒绝服务'), '失败提示带上原因（截断到 40 字）', String(pDoneBad.toast));

  // ★ 本轮的真缺陷：drop 落进「其它一律当完成」的分支，被说成「办好了」
  const pDrop = planFn(evDrop(task, 'gone'));
  eq(pDrop.running, 'clear', 'drop → 也要摘掉运行中（它确实不在跑了）');
  ok(!String(pDrop.toast).includes('办好了'),
    'drop **不许**说「办好了」—— 它一次都没跑、也没有结论', String(pDrop.toast));
  ok(!String(pDrop.toast).includes('没办成'),
    'drop 也不许说「没办成」—— 它不是失败，是没发生', String(pDrop.toast));
  ok(String(pDrop.toast).includes('摘掉'), 'drop 要说清它被摘掉了', String(pDrop.toast));
  ok(String(pDrop.toast).includes('每日早报'), 'drop 的提示里要有任务名（否则不知道说的是哪个）', String(pDrop.toast));

  // 脏输入不许炸，也不许瞎动作
  for (const junk of [null, undefined, {}, { type: 42 }, { type: 'queue' }, 'start']) {
    let r; let threw = null;
    try { r = planFn(junk); } catch (e) { threw = e; }
    ok(!threw, `分派遇到脏输入不抛异常：${JSON.stringify(junk)}`, threw && threw.message);
    if (r) eq([r.running, r.toast], ['none', null], `脏输入不产生任何动作：${JSON.stringify(junk)}`);
  }
}

// ── 6. 两向：主进程的类型表 ⇄ 面板的 case 集合 ──

section('6. 两向对账：发得出来的类型，面板都得有分支');
{
  const panel = parsePanel();
  const fnSrc = panel.match(/function scheduleEventPlan\(p\) \{[\s\S]*?\n\}/);
  ok(!!fnSrc, '能抽到分派函数（同第 5 节）');
  if (fnSrc) {
    const handled = [...new Set([...fnSrc[0].matchAll(/case '([^']+)':/g)].map((m) => m[1]))].sort();
    ok(handled.length > 0, `从面板现算出 ${handled.length} 个分支：${handled.join(' / ')}`,
      '算不出来说明分派从 switch 改成了别的写法 —— 这条检查必须跟着改，否则它在空集上通过');
    const emitTypes = TYPES.slice().sort();
    eq(handled.filter((t) => !emitTypes.includes(t)), [],
      '面板没有多出主进程发不出来的分支（多出来的就是猜的）');
    eq(emitTypes.filter((t) => !handled.includes(t)), [],
      '主进程每个事件类型面板都有分支（少了哪个就会掉进 default 静默丢弃）');
  }
}

// ── 7. 端到端：真调度器发的事件 ⇄ 真分派 ──
//
// 前面第 4 节读源码、第 5 节单独跑分派，都还是两半。这一段把两半接起来：
// 用假 store + 可控假 agent 真跑 `schedule.js`，把**它真的发出来的**每条事件
// 喂给**真正在用的**那个分派函数。两边各自正确、拼起来不对，只有这一段能抓到。

section('7. 端到端：真调度器真发的事件，逐条过契约与分派');
{
  const disk = new Map();
  const fake = (id, exports) => { const m = new Module(id); m.filename = id; m.loaded = true; m.exports = exports; return m; };
  const storePath = require.resolve('../src/main/jarvis/store.js');
  require.cache[storePath] = fake(storePath, {
    readJson: (f, dflt) => (disk.has(f) ? JSON.parse(JSON.stringify(disk.get(f))) : JSON.parse(JSON.stringify(dflt))),
    writeJson: (f, val) => { disk.set(f, JSON.parse(JSON.stringify(val))); return true; }
  });
  let gate = null;
  const agentPath = require.resolve('../src/main/jarvis/agent.js');
  require.cache[agentPath] = fake(agentPath, {
    runAgent: async () => { if (gate) await gate; return { ok: true, text: '结论：今天晴。' }; }
  });

  const schedule = require('../src/main/jarvis/schedule.js');
  const events = [];
  schedule.bind({
    getConfig: () => ({ apiKey: 'k', model: 'm', schedConcurrency: 1 }),
    log: () => {},
    deliver: () => {},
    event: (p) => events.push(p)
  });

  const flush = async (n = 8) => { for (let i = 0; i < n; i += 1) await Promise.resolve(); };
  const add = (title) => schedule.add({ title, prompt: `${title} 的提示词`, when: { type: 'interval', minutes: 60 } }).task.id;

  await (async () => {
    const a = add('占着并发位的');
    const b = add('排队时会被删掉的');

    let release;
    gate = new Promise((r) => { release = r; });
    schedule.kick(a);
    await flush();
    await schedule.runTask(schedule.get(b), { manual: true });
    eq(schedule.status().queued, 1, 'b 确实排在队里（否则下面那条 drop 不会出现）');

    // 绕过 remove()：直接改「文件」内容，模拟别处（另一个会话 / 手改）把它删了
    const raw = disk.get('schedules.json');
    raw.tasks = raw.tasks.filter((t) => t.id !== b);

    release();
    gate = null;
    await new Promise((r) => setTimeout(r, 30));
    await flush();

    eq(events.length, 3, '一共三条事件：a 的 start、a 的 done、b 的 drop',
      JSON.stringify(events.map((e) => e.type)));
    eq(events.map((e) => e.type), ['start', 'done', 'drop'], '三条的类型与顺序');

    for (const ev of events) {
      const r = checkEvent(ev);
      ok(r.ok, `调度器真发的 ${ev.type} 事件满足契约`, (r.errors || []).join('；'));
    }

    if (planFn) {
      const byType = Object.fromEntries(events.map((e) => [e.type, e]));
      eq(planFn(byType.start).running, 'set', '端到端：真 start 事件 → 标记运行中');
      ok(String(planFn(byType.done).toast).includes('办好了'), '端到端：真 done 事件 → 「办好了」');
      const dropToast = String(planFn(byType.drop).toast);
      ok(!dropToast.includes('办好了'),
        '端到端：真 drop 事件 **不许**被说成「办好了」（这就是本轮修掉的那句假话）', dropToast);
      ok(dropToast.includes('摘掉'), '端到端：真 drop 事件 → 说清被摘掉了', dropToast);
      ok(planFn(byType.drop).running === 'clear', '端到端：真 drop 事件 → 摘掉运行中标记');
    }

    // 被删掉的那条不许被跑，也不许有结论
    eq(schedule.status().log.length, 1, '只有 a 进了运行历史');
    ok(!events.some((e) => e.type === 'done' && e.title === '排队时会被删掉的'),
      '被删掉的任务不许有 done 事件 —— 它没有结论可以播报');

    // ── 7B. 排队的任务在**排队期间**不许拿到 start，轮到它跑起来时才拿到 ──
    events.length = 0;
    const d = add('先跑的');
    const e = add('排队后会被放行的');

    let release2;
    gate = new Promise((r) => { release2 = r; });
    schedule.kick(d);
    await flush();
    await schedule.runTask(schedule.get(e), { manual: true });
    eq(schedule.status().queued, 1, 'e 在队里');

    eq(events.map((x) => x.type), ['start'], '排队期间只发得出 d 的 start —— e 一条都没有');
    ok(!events.some((x) => x.id === e), '排队中的 e 不许在事件里出现（它还没开始跑）');

    release2();
    gate = null;
    await new Promise((r) => setTimeout(r, 50));
    await flush();

    eq(events.map((x) => `${x.type}:${x.id}`), [`start:${d}`, `done:${d}`, `start:${e}`, `done:${e}`],
      'e 轮到它跑起来的那一刻才拿到 start，并且真的跑完了');
    for (const ev of events) {
      const r = checkEvent(ev);
      ok(r.ok, `7B 的 ${ev.type} 事件也满足契约`, (r.errors || []).join('；'));
    }

    schedule.stop();
  })();
}

// ── 8. 移除守卫：两个「写着像守卫、其实什么都没挡」的东西 ──

section('8. 不许再出现那两个死东西');
{
  // 读源码判定前**先剥注释** —— 本仓第 9 / 19 / 25 轮各栽过一次：注释里正大光明地
  // 写着旧判据与旧缺陷（本轮就在 `scheduleEventPlan()` 的说明里写了 `p.silent` 这三个字），
  // 不剥就会把注释当实现、把正确的代码判红。
  const raw = readSrc('src/renderer/js/panel.js');
  const panel = stripComments(raw);
  // 剥注释器自证：它要是把整段代码吃掉了，下面两条会在空集上通过
  ok(panel.length > raw.length * 0.6,
    `剥完注释还剩 ${Math.round((panel.length / raw.length) * 100)}% 的体量（吃太多了）`);
  ok(panel.includes('window.xw.onScheduleEvent'), '剥完仍找得到事件接线（剥注释器没吃掉代码）');
  ok(panel.includes('function scheduleEventPlan(p)'), '剥完仍找得到分派函数');

  ok(!/\bp\.silent\b/.test(panel),
    'panel.js 里不许再读 p.silent —— 三类事件谁都不发它，那个守卫从来没有为假过');
  ok(!/\bschLastDone\b/.test(panel),
    'panel.js 里不许再有 schLastDone —— 它被写了但从没被读过（死状态）');
  const scheduleSrc = stripComments(readSrc('src/main/jarvis/schedule.js'));
  ok(!/silent/.test(scheduleSrc),
    'schedule.js 不许再提 silent —— 协议里没有这个概念，写了就会有人去读');
}

// ── 汇总 ──

console.log('');
if (fails.length) {
  console.log(`  ${fails.length} 项失败：\n`);
  for (const f of fails) console.log(`    - ${f}`);
  console.log('\nschedule:event 契约测试未通过。\n');
  process.exit(1);
}
console.log(`  ${pass} 项全部通过。\n`);
