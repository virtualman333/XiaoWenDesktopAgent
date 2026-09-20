/**
 * 动态上下文 / 自动压缩回归测试 —— node build/_context_test.mjs
 *
 * context.js 是纯函数模块（不依赖 Electron），所以这里直接 require 就能测：
 *   词元估算、工具输出截断（头尾都要留）、按轮保留、
 *   超预算折叠成纪要、纪要块位置、压缩统计、滚动摘要的触发条件。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ctx = require('../src/main/jarvis/context.js');

let pass = 0; const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else fails.push(name + (extra ? ` → ${extra}` : '')); };
const eq = (a, b, name) => ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
// eq 是严格相等，只适合标量；对象 / 数组走这个
const same = (a, b, name) => ok(
  JSON.stringify(a) === JSON.stringify(b), name,
  `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`
);
const section = (s) => console.log('\n' + s);
// 抛异常也要留下**一条 FAIL**：判据是「有 FAIL 才算红」。崩溃只给退出码 1，
// 负向验证脚本读到的情况和「代码真错了」一模一样，分不出来。
const guard = (name, fn) => {
  try { fn(); } catch (e) { fails.push(`${name} 抛异常：${(e && e.message) || e}`); }
};

// ---------------- 1. 词元估算 ----------------
section('1. 词元估算');
{
  ok(ctx.estimateTokens('') === 0, '空串 = 0');
  const cn = ctx.estimateTokens('今天天气不错');            // 6 个汉字
  ok(cn >= 4 && cn <= 9, '中文按字算（≈1 字 1 token）', String(cn));
  const en = ctx.estimateTokens('hello world');             // 11 字符
  ok(en >= 2 && en <= 5, '英文按字符折半算', String(en));
  ok(ctx.estimateTokens('中文中文中文') > ctx.estimateTokens('abcdefghij'), '同样长度中文比英文费 token');

  eq(ctx.msgTokens({ role: 'user', content: '短' }) > 0, true, '单条消息有基础开销');
  eq(ctx.msgTokens(null), 0, 'null 消息算 0');
  eq(ctx.totalTokens([]), 0, '空列表 0');
  const tot = ctx.totalTokens([{ role: 'user', content: '甲' }, { role: 'assistant', content: '乙' }]);
  ok(tot > 0, '两条消息的总量 > 0', String(tot));
}

// ---------------- 2. 多模态内容 ----------------
section('2. 多模态内容');
{
  eq(ctx.contentToText('纯文本'), '纯文本', '字符串原样返回');
  const t = ctx.contentToText([
    { type: 'text', text: '看看这张图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
  ]);
  ok(/看看这张图/.test(t), '保留了文字部分');
  ok(/图片/.test(t), '图片替换成占位而不是把 base64 塞进去', t.slice(0, 30));
  ok(t.length < 60, 'base64 没有漏进上下文', String(t.length));
  eq(ctx.contentToText(null), '', 'null → 空串');
  eq(ctx.contentToText([{ type: 'text', text: 'a' }]), 'a', '数组里只有文字时合并');
}

// ---------------- 3. 工具输出截断 ----------------
section('3. 工具输出截断（头尾都要留）');
{
  const short = '只有一行';
  const s0 = ctx.clipToolOutput(short, 1200);
  eq(s0.text, short, '短输出不动');
  eq(s0.clipped, false, '短输出没被标记为截断');

  // 真实场景：上千行的构建日志，报错卡在正中间（不是开头也不是结尾）
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(`[build] step ${i} ok in ${i}ms`);
  lines.push('[build] ERROR: 找不到模块 ./missing.js —— 这就是要抓的那一行');
  for (let i = 300; i < 600; i++) lines.push(`[build] step ${i} ok in ${i}ms`);
  const long = lines.join('\n');

  const cut = ctx.clipToolOutput(long, 1200);
  ok(cut.clipped === true, '长输出标记为已截断');
  ok(cut.text.length < 2000, '被截短了', String(cut.text.length));
  ok(/step 0 ok/.test(cut.text), '保留开头');
  ok(/step 599 ok/.test(cut.text), '保留结尾');
  ok(/找不到模块 \.\/missing\.js/.test(cut.text), '卡在中间的报错被单独捞了出来', cut.text.slice(0, 120));
  ok(/关键行/.test(cut.text), '明确告诉模型这里补了关键行');

  // 整段就是一行超长文本（压缩过的 JSON）也要能抓到关键词
  const oneLine = 'A'.repeat(3000) + '"error":"ETIMEDOUT 连接被拒绝"' + 'Z'.repeat(3000);
  const cut2 = ctx.clipToolOutput(oneLine, 1200);
  ok(/ETIMEDOUT/.test(cut2.text), '单行超长文本里的报错也能定位到', cut2.text.slice(0, 120));

  const s1 = ctx.clipToolOutput('', 100);
  eq(s1.text, '', '空串安全');
  eq(s1.clipped, false, '空串不算截断');
  const big = ctx.clipToolOutput('X'.repeat(5000), 0);
  ok(typeof big.text === 'string', 'max=0 不炸');
}

// ---------------- 4. 轮次与纪要行 ----------------
section('4. 轮次切分与纪要');
{
  const msgs = [
    { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'q3' }
  ];
  eq(ctx.countTurns(msgs), 3, '三轮对话');
  eq(ctx.countTurns([]), 0, '空列表 0 轮');

  // tailByTurns 返回的是「保留下来的起点下标」
  const start1 = ctx.tailByTurns(msgs, 1);
  ok(start1 > 0 && start1 < msgs.length, '保留最后一轮 → 起点在中间', String(start1));
  ok(msgs.slice(start1).some((m) => m.content === 'q3'), '最后一条用户消息一定被保留');
  ok(!msgs.slice(start1).some((m) => m.content === 'q1'), '更早的那轮被切掉了');

  eq(ctx.tailByTurns(msgs, 10), 0, '保留轮数大于总轮数 → 从 0 开始（全都留）');
  eq(ctx.tailByTurns(msgs, 0), 0, 'keepTurns=0 时不切');
  eq(ctx.tailByTurns([], 3), 0, '空列表安全');

  ok(/主人/.test(ctx.digestLine({ role: 'user', content: '帮我看下天气' })), '用户消息记成「主人：…」');
  ok(/小问/.test(ctx.digestLine({ role: 'assistant', content: '今天晴' })), '助手消息记成「小问：…」');
  ok(ctx.oneLineSummary({ role: 'tool', name: 'read_file', ok: true, content: 'x' }).length > 0, '工具调用有一行摘要');
}

// ---------------- 5. 压缩主流程 ----------------
section('5. 自动压缩');
{
  // 造一段很长的历史：每轮 3000 字，20 轮
  const big = [];
  for (let i = 0; i < 20; i++) {
    big.push({ role: 'user', content: `第${i}个问题：` + '问'.repeat(3000) });
    big.push({ role: 'assistant', content: `第${i}个回答：` + '答'.repeat(3000) });
  }
  const before = ctx.totalTokens(big);

  const r = ctx.compress({ messages: big, budget: 20000, keepTurns: 4, toolOutputMax: 800 });
  eq(r.stats.compressed, true, '超预算 → 判定为已压缩');
  eq(r.stats.droppedMessages > 0, true, '有消息被丢掉', String(r.stats.droppedMessages));
  eq(r.stats.digestLines > 0, true, '丢掉的部分折叠成了纪要行', String(r.stats.digestLines));
  ok(r.stats.keptTurns >= 1 && r.stats.keptTurns <= 4, '保留的轮数不超过设置的 4 轮', String(r.stats.keptTurns));
  ok(r.stats.afterTokens <= r.stats.budget, '压缩后落在预算内', `${r.stats.afterTokens} / ${r.stats.budget}`);
  ok(r.stats.beforeTokens === before, '记录了压缩前用量');
  ok(r.stats.ratio < 1, 'ratio < 1 表示确实变小了', String(r.stats.ratio));

  // 纪要块必须是 system 身份、插在被保留的对话之前
  const digestIdx = r.messages.findIndex((m) => m.role === 'system' && /更早的对话纪要/.test(String(m.content)));
  ok(digestIdx >= 0, '插入了「更早的对话纪要」system 块');
  const firstKept = r.messages.findIndex((m) => m.role !== 'system');
  ok(digestIdx < firstKept, '纪要块排在保留下来的对话前面');
  ok(r.messages.length >= 2, '压缩后仍有内容可用');
  ok(r.messages.some((m) => m.role === 'user'), '保留的最近对话没丢');

  // 预算充足时不动刀
  const small = [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好呀' }];
  const r2 = ctx.compress({ messages: small, budget: 100000, keepTurns: 8 });
  eq(r2.stats.compressed, false, '预算充足 → 不压缩');
  eq(r2.messages.length, small.length, '原样返回');
  eq(r2.messages[0].content, '你好', '内容没被改写');

  // 已有的滚动摘要要接上，而不是重新开头
  const r3 = ctx.compress({
    messages: big, budget: 20000, keepTurns: 4,
    priorSummary: '之前聊过：主人在准备周报。'
  });
  ok(/之前聊过/.test(String(r3.messages[0].content)) || /之前聊过/.test(JSON.stringify(r3.messages)),
    '继承上一轮的滚动摘要');
  ok(String(r3.stats.digestText || '').length > 0, 'digestText 可以直接喂给摘要模型');

  // 工具输出在压缩时也要被截断，而不是原样带过去
  const withTool = [
    { role: 'user', content: '跑一下命令' },
    { role: 'tool', name: 'run_command', content: 'O'.repeat(9000), ok: true },
    { role: 'assistant', content: '跑完了' }
  ];
  const r4 = ctx.compress({ messages: withTool, budget: 100000, keepTurns: 8, toolOutputMax: 500 });
  eq(r4.stats.clippedTools, 1, '超长的工具输出被截断', String(r4.stats.clippedTools));
  const toolMsg = r4.messages.find((m) => m.role === 'tool');
  ok(toolMsg && String(toolMsg.content).length < 1000, '截断后确实变短了', String(toolMsg && String(toolMsg.content).length));

  // 极小的预算不能把上下文清空（要有兜底保护）
  const r5 = ctx.compress({ messages: big, budget: 1, keepTurns: 4 });
  ok(r5.messages.length >= 1, '预算荒唐地小时仍保留至少一条消息', String(r5.messages.length));

  // 空输入安全
  const r6 = ctx.compress({ messages: [], budget: 1000 });
  eq(r6.messages.length, 0, '空历史 → 空结果');
  eq(r6.stats.compressed, false, '空历史不算压缩');
}

// ---------------- 6. 滚动摘要触发条件 ----------------
section('6. 滚动摘要');
{
  const heavy = { compressed: true, droppedMessages: 12, digestLines: 9, beforeTokens: 90000, budget: 20000 };
  eq(ctx.shouldSummarize(heavy), true, '压得比较狠 → 该写摘要了');
  eq(ctx.shouldSummarize({ compressed: false }), false, '没压缩 → 不写摘要');
  eq(ctx.shouldSummarize(null), false, 'null 安全');

  const prompt = ctx.buildSummaryPrompt({
    priorSummary: '上次记到：在写周报。',
    digestText: '主人：帮我查天气\n小问：今天晴',
    maxChars: 800
  });
  ok(typeof prompt === 'string' && prompt.length > 0, '摘要提示词非空');
  ok(/在写周报/.test(prompt), '把上一次的摘要带进去做增量更新');
  ok(/天气/.test(prompt), '把这一段纪要带进去');
  ok(/800|字/.test(prompt), '告诉模型长度上限');
}

// ---------------- 7. 上下文计划（两条路径的唯一来源） ----------------
section('7. 上下文计划 planContext');
guard('planContext', () => {
  // 7.1 预算算式
  eq(ctx.budgetFor({}, 0), 128000 - 8000, '窗口缺省 128000、回复预留 8000');
  eq(ctx.budgetFor({ ctxWindow: 32000, ctxReplyReserve: 2000 }, 500), 32000 - 2000 - 500,
    '预算要扣掉系统提示词本身');
  eq(ctx.budgetFor({ ctxWindow: 10, ctxReplyReserve: 9999 }, 0), 1024, '算出来太小也留 1024 的地板');
  eq(ctx.budgetFor({ ctxWindow: 'abc', ctxReplyReserve: null }, 0), 128000 - 8000,
    '窗口写成非数字 → 回落缺省，不是 NaN');

  const sys = { role: 'system', content: '你是小问' };
  const short = [sys, { role: 'user', content: '在吗' }];

  // 7.2 关掉自动压缩：消息原样，但统计**不许缺字段**（面板的环靠它）
  const off = ctx.planContext({ messages: short, cfg: { ctxAutoCompress: false } });
  same(off.messages, short, '关掉压缩 → 消息原样（含 system、顺序不变）');
  eq(off.shouldSummarize, false, '关掉压缩 → 不写摘要');
  eq(off.stats.compressed, false, '关掉压缩 → compressed=false');
  ok(off.stats.budget > 0, '关掉压缩也要给出 budget', String(off.stats.budget));
  eq(typeof off.stats.afterTokens, 'number', '关掉压缩也要给 afterTokens（界面不该读到 undefined）');
  eq(typeof off.stats.ratio, 'number', '关掉压缩也要给 ratio');
  eq(off.stats.budget, ctx.budgetFor({ ctxAutoCompress: false }, ctx.totalTokens([sys])),
    '关掉压缩时 budget 仍是同一条算式算出来的');

  // 7.3 压缩：system 留在原位，压掉的是更早的轮次
  const long = [sys];
  for (let i = 0; i < 60; i++) {
    long.push({ role: 'user', content: `第 ${i} 句要说的话，稍微长一点好让它真的占额度` });
    long.push({ role: 'assistant', content: `收到 ${i}，这是一段回答` });
  }
  const cfg = { ctxWindow: 2000, ctxReplyReserve: 200, ctxKeepTurns: 2 };
  const on = ctx.planContext({ messages: long, cfg, priorSummary: '' });
  same(on.messages[0], sys, '压缩后 system 仍在第 0 位');
  ok(on.messages.length < long.length, '确实压掉了消息', `${long.length} → ${on.messages.length}`);
  eq(on.stats.compressed, true, '统计里 compressed 为真');
  eq(on.stats.budget, ctx.budgetFor(cfg, ctx.totalTokens([sys])), '压缩路径用同一条预算算式');

  // 7.4 ★ 本轮修的就是这一条：shouldSummarize 的结论不许在半路上被丢掉
  eq(on.shouldSummarize, true, '压得这么狠时必须得出「该写摘要」的结论');
  eq(on.shouldSummarize, ctx.shouldSummarize(on.stats),
    '交出去的 shouldSummarize 必须等于 shouldSummarize(stats) —— 普通对话路径此前把这一步漏掉了');

  // 7.5 纯函数：同输入同输出
  const again = ctx.planContext({ messages: long, cfg, priorSummary: '' });
  same(again.messages, on.messages, '同一输入两次调用，消息相同');
  same(again.stats, on.stats, '同一输入两次调用，统计相同');
});

// ---------------- 7b. 算式只有一个来源（结构锁） ----------------
section('7b. 算式只有一个来源');
guard('算式唯一性', () => {
  const read = (rel) => stripComments(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
  const context = read('../src/main/jarvis/context.js');
  const agent = read('../src/main/jarvis/agent.js');
  const main = read('../src/main/main.js');

  // 扫描面自证：先钉住「被扫的东西还在」，否则下面的 !test 全是恒真
  ok(/function budgetFor/.test(context), 'context.js 里找得到 budgetFor（扫描面没塌）');
  ok(/function planContext/.test(context), 'context.js 里找得到 planContext（扫描面没塌）');
  ok(/runAgent/.test(agent), 'agent.js 解析出来了（不是读到空串）');
  ok(main.includes('ipcMain.handle'), 'main.js 解析出来了（不是读到空串）');

  same(budgetFormulaSites({ context, agent, main }), ['context'],
    '窗口缺省这条算式只在 context.js 出现 —— 预算不许有第二份实现');
  ok(!/ctxAutoCompress === false/.test(agent), 'agent.js 不再自己判「要不要压缩」');
  ok(!/ctxAutoCompress === false/.test(main), 'main.js 不再自己判「要不要压缩」');
  ok(/ctx\.planContext\(/.test(agent), 'agent.js 走 planContext');
  ok(/ctxmod\.planContext\(/.test(main), 'main.js 走 planContext');
  // 下面这两条盯的是**调用**，不是「文件里出现过这个名字」—— 注释里写一遍不算数
  ok(/plan\.shouldSummarize\s*&&\s*sessionId/.test(main),
    'main.js 用 plan.shouldSummarize 决定要不要重写纪要');
  ok(/require\(['"]\.\/jarvis\/agent['"]\)\.summarizeLater\(/.test(main),
    'main.js 真的把重写纪要这件事交给了 summarizeLater');
  // chat:context 必须在压缩分支**之外**推：关掉自动压缩时面板的环也得跟着更新
  const sendAt = main.indexOf("send('chat:context'");
  const compAt = main.indexOf('if (plan.stats.compressed)');
  ok(sendAt > 0 && compAt > 0, 'main.js 里「推统计」与「记压缩日志」两处都在（扫描面没塌）');
  ok(sendAt < compAt, 'chat:context 不受 compressed 分支管 —— 关掉自动压缩时面板也要更新');
  // 判据自身的自证：真给它两份实现必须报两个文件；给一份无关源码必须什么都不报
  same(budgetFormulaSites({ a: context, b: context }), ['a', 'b'],
    '有两份实现时这条会报两个文件（判据不是恒真）');
  same(budgetFormulaSites({ a: 'const x = 1;' }), [],
    '没有算式时不报（判据不是恒真）');
});

/** 剥掉注释再比对 —— 本轮加的说明里就引用过这些字眼，不剥会把自己判红 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}

/**
 * 哪些文件的**代码**里出现了「窗口缺省 → 回复预留」这条算式。
 *
 * 盯的是 `|| 128000` 这个形态，不是光秃秃的 `128000`：`main.js` 的 DEFAULT_CONFIG
 * 里合法地写着 `ctxWindow: 128000`（那是配置的初值，不是算式），盯错就把配置项判红了。
 */
function budgetFormulaSites(codeByName) {
  return Object.keys(codeByName)
    .filter((n) => /\|\|\s*128000/.test(codeByName[n]))
    .sort();
}

// ---------------- 8. 上下文用量的「拉」这一侧（面板打开时的初值） ----------------
//
// 这条链原先只做了一半：`chat:context` 有生产端（agent 路径 / 普通对话路径）与 preload
// 桥，面板订阅它画「上下文」环 —— 但**只有推、没有拉**。于是用户打开面板（或重启应用）
// 看到的永远是空环，得等下一轮对话跑完才有数；而点那个按钮想看的就是「上一轮用了多少」。
// 主进程里那个 `getContextStats()`（注释写着「面板 / 诊断用」）当时全仓零读者。
//
// 第 30 轮补上拉取出口，并把两条生产路径收敛到**一个写入点**（原来普通对话那条是自己
// new 一个对象直接 send，不写回缓存 —— 推出去的和拉回来的可以不一样，而面板靠推送
// 根本看不出差别）。
section('8. 上下文用量的拉取出口');
guard('统计缓存与归一化', () => {
  const agent = require('../src/main/jarvis/agent.js');
  ok(typeof agent.noteContextStats === 'function', 'agent.js 导出了 noteContextStats（单一写入点）');
  ok(typeof agent.getContextStats === 'function', 'agent.js 导出了 getContextStats（拉取出口）');

  // 初始态：还没跑过任何一轮 → `at` 为 0。面板靠这个约定判断「有没有数可显示」，
  // 不钉住的话面板挂载时会把一个 0% 的环画出来（比空着更误导）。
  eq(agent.getContextStats().at, 0, '刚启动时 at 为 0（面板据此判断「还没有数」）');

  const noted = agent.noteContextStats({
    beforeTokens: 1000, afterTokens: 400, budget: 8000, compressed: true, droppedMessages: 3
  });
  ok(noted.at > 0, 'noteContextStats 的返回值带上了时间戳', JSON.stringify(noted));
  eq(noted.afterTokens, 400, '统计字段原样带过来');
  eq(noted.compressed, true, '压缩标记原样带过来');
  eq(agent.getContextStats().afterTokens, 400, '拉回来的就是刚才记下那一份');
  eq(agent.getContextStats().budget, 8000, '预算字段也一致');

  // 返回值是**副本**：调用方改它不该把缓存改掉（缓存被外侧改掉是最难查的一类）
  noted.afterTokens = 99999;
  eq(agent.getContextStats().afterTokens, 400, '返回值是副本，改它不影响缓存');

  // 再记一轮是**替换**而不是合并：上一轮的字段不许残留
  const again = agent.noteContextStats({ beforeTokens: 10, afterTokens: 8, budget: 100, compressed: false });
  eq(again.afterTokens, 8, '第二轮覆盖了第一轮');
  eq(again.droppedMessages, undefined, '上一轮的字段没有残留（是替换不是合并）');
});

// ---------------- 8b. 统计链的写入点与出口（结构锁） ----------------
// 「自己现造一个统计对象直接推出去」的形状。**判据与自证必须共用这一份** ——
// 各写一份内联字面量的话，改掉判据那一处自证照样绿，这条锁就没人管得住了
// （负向验证实测：只改内联那一处，9 条断言一个都不红）。
const HANDMADE_STATS_RE = /\{\s*\.\.\.plan\.stats,\s*at:/;
section('8b. 统计链的写入点与出口');
guard('统计链结构', () => {
  const read = (rel) => stripComments(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
  const agentSrc = read('../src/main/jarvis/agent.js');
  const mainSrc = read('../src/main/main.js');
  const preloadSrc = read('../src/main/preload.js');
  const panelSrc = read('../src/renderer/js/panel.js');

  // 扫描面自证：先钉住「被扫的东西还在」，否则下面的 !test 全是恒真
  ok(/function noteContextStats/.test(agentSrc), 'agent.js 里找得到 noteContextStats（扫描面没塌）');
  ok(mainSrc.includes('ipcMain.handle'), 'main.js 解析出来了（不是读到空串）');
  ok(preloadSrc.includes('ipcRenderer'), 'preload.js 解析出来了（不是读到空串）');
  ok(panelSrc.includes('renderContext'), 'panel.js 解析出来了（不是读到空串）');

  // ① 缓存只有一个写入点：形如「行首 lastContextStats = …」的赋值语句只能有一处
  const writerLines = (src) => src.split('\n').map((l) => l.trim())
    .filter((l) => /^lastContextStats\s*=/.test(l));
  eq(writerLines(agentSrc).length, 1,
    `统计缓存有 ${writerLines(agentSrc).length} 处写入（要 1 处）—— 「同一份事实两个出口」就是这么来的`);

  // ② 两条生产路径都必须走那个写入点
  ok(/noteContextStats\(plan\.stats\)/.test(agentSrc), 'agent.js 的 Agent 路径走 noteContextStats');
  ok(/noteContextStats\(plan\.stats\)/.test(mainSrc), 'main.js 的普通对话路径走 noteContextStats');
  ok(!HANDMADE_STATS_RE.test(mainSrc),
    'main.js 不再现造一个统计对象直接推 —— 那样「推出去的」和「拉回来的」可以不一样');

  // ③ 三个出口：主进程 IPC → preload 桥 → 面板挂载时真的拉一次
  ok(/ipcMain\.handle\(\s*['"]context:stats['"]/.test(mainSrc), 'main.js 注册了 context:stats');
  ok(/contextStats:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]context:stats['"]/.test(preloadSrc),
    'preload 暴露了 contextStats()（少了这一层，面板就够不着）');
  // 面板这一段只扫 bindCtx 的**函数体**，不扫整个文件：整个文件里 `st.at` 到处都是
  // （renderContext 里也有），拿它当判据的话「把拉取那半段删掉」根本看不见 ——
  // 负向验证实测过，第一版就是这么漏判的。
  const at = panelSrc.indexOf('function bindCtx');
  const bindBody = at < 0 ? '' : panelSrc.slice(at, panelSrc.indexOf('\n}', at));
  ok(bindBody.length > 0, 'panel.js 里找得到 bindCtx 的函数体（扫描面没塌）');
  ok(/contextStats/.test(bindBody), 'bindCtx 里调了 contextStats（挂载时拉一次初始值）');
  ok(/renderContext\s*\(/.test(bindBody), 'bindCtx 把拉回来的值真的交给了 renderContext（只拉不画等于没接）');
  ok(/st\.at/.test(bindBody), 'bindCtx 里判了 at —— 没跑过任何一轮时不画 0% 的环');

  // 判据自证：合成的「自己现造对象」必须被判出来，收敛写法必须放行
  eq(HANDMADE_STATS_RE.test("send('chat:context', { ...plan.stats, at: Date.now() })"), true,
    '判据抓不到「现造对象」的写法 —— 这条锁是空话');
  eq(HANDMADE_STATS_RE.test('const s = noteContextStats(plan.stats);'), false,
    '收敛写法被误判 —— 判据过宽');
  eq(writerLines('let lastContextStats = {};\nlastContextStats = x;\nlastContextStats = y;').length, 2,
    '写入点计数判据自证：两处写入必须数出 2（否则 count===1 是恒真的）');
});

// ---------------- 汇总 ----------------
console.log('\n' + '='.repeat(46));
if (fails.length) {
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`动态上下文：通过 ${pass} / ${pass}`);
