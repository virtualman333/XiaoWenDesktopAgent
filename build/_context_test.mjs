/**
 * 动态上下文 / 自动压缩回归测试 —— node build/_context_test.mjs
 *
 * context.js 是纯函数模块（不依赖 Electron），所以这里直接 require 就能测：
 *   词元估算、工具输出截断（头尾都要留）、按轮保留、
 *   超预算折叠成纪要、纪要块位置、压缩统计、滚动摘要的触发条件。
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ctx = require('../src/main/jarvis/context.js');

let pass = 0; const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else fails.push(name + (extra ? ` → ${extra}` : '')); };
const eq = (a, b, name) => ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
const section = (s) => console.log('\n' + s);

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

// ---------------- 汇总 ----------------
console.log('\n' + '='.repeat(46));
if (fails.length) {
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`动态上下文：通过 ${pass} / ${pass}`);
