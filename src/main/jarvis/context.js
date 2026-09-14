'use strict';
/**
 * 动态上下文 + 自动压缩。
 *
 * 为什么需要：
 *   会话越长，请求里带的 messages 越多 —— 要么撞上模型的上下文上限直接报错，
 *   要么白花一堆 token 把早期闲聊也塞进去。而「最相关」的永远是最近几轮，
 *   更早的内容只需要保留**结论**，不需要保留每一次工具调用的原始输出。
 *
 * 分两层：
 *   1) 就地压缩（同步、必发生、不依赖模型）：
 *      - 长工具输出截成「头 + 尾」；
 *      - 早期的工具往返（assistant.tool_calls + 一串 tool 结果）合并成一行结果摘要；
 *      - 更早的对话压成时间线摘要（每条只留开头若干字）。
 *      这一层保证「无论多长，一定能塞进窗口」。
 *   2) 模型摘要（异步、锦上添花）：把被裁掉的部分交给模型重写成一段精炼摘要，
 *      存进会话里，下一轮直接用。失败也不影响主流程。
 *
 * 本文件不 import electron，纯函数，可直接单测。
 */

// ---------------- token 估算 ----------------
/**
 * 粗估 token 数。
 * 中文一个字 ≈ 1 token；英文/符号 ≈ 每 3.5 个字符 1 token。
 * 宁可高估也别低估：低估会把请求直接打爆。
 */
function estimateTokens(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // CJK 统一表意文字 / 假名 / 全角标点
    if (c > 0x2E7F) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 3.5);
}

/** 单条消息的 token 估算（含角色开销、工具调用、图片） */
function msgTokens(m) {
  if (!m) return 0;
  let t = 8; // 角色 / 分隔符的固定开销
  const c = m.content;
  if (Array.isArray(c)) {
    for (const part of c) {
      if (!part) continue;
      if (typeof part === 'string') t += estimateTokens(part);
      else if (part.type === 'image_url' || part.image_url) t += 900; // 图片按视觉 token 粗估
      else if (part.text) t += estimateTokens(part.text);
    }
  } else {
    t += estimateTokens(c);
  }
  if (Array.isArray(m.tool_calls)) t += estimateTokens(JSON.stringify(m.tool_calls));
  return t;
}

function totalTokens(list) {
  let t = 0;
  for (const m of (list || [])) t += msgTokens(m);
  return t;
}

// ---------------- 工具输出压缩 ----------------
/** 一眼就该看到的那些行：报错、失败、异常、超时…… */
const INTERESTING_RE = /(error|fail(ed|ure)?|exception|traceback|fatal|panic|denied|refused|timeout|timed out|not found|cannot|unable|报错|错误|失败|异常|无法|超时|拒绝|不存在|未找到)/i;

function pickInterestingLines(s, limit = 3) {
  const lines = String(s).split(/\r?\n/);
  const hit = [];
  for (const ln of lines) {
    const t = ln.trim();
    if (!t || t.length > 300) continue;
    if (INTERESTING_RE.test(t)) hit.push(t);
    if (hit.length >= limit) break;
  }
  return hit;
}

/**
 * 长工具输出截成「头 + 关键行 + 尾」。
 * 为什么保留尾巴：命令输出/日志的关键信息（失败原因、耗时）几乎都在末尾。
 * 为什么要额外捞关键行：上千行的构建/测试日志里，真正的那条报错常常卡在中间，
 * 只留头尾会刚好把它切掉 —— 那才是最要命的情况。
 */
function clipToolOutput(content, max = 1200) {
  const s = String(content == null ? '' : content);
  if (s.length <= max) return { text: s, clipped: false };
  const keepHead = Math.max(80, Math.round(max * 0.5));
  const keepTail = Math.max(80, max - keepHead - 80);
  const omitted = Math.max(0, s.length - keepHead - keepTail);

  const mid = s.slice(keepHead, s.length - keepTail);
  const strong = pickInterestingLines(mid).filter((l) => !s.slice(0, keepHead).includes(l) && !s.slice(-keepTail).includes(l));
  let midNote;
  if (strong.length) {
    midNote = `\n…（中间省略 ${omitted} 字；以下是其中的关键行）…\n${strong.map((l) => '! ' + l).join('\n')}\n`;
  } else {
    // 整段就是一行超长文本（压缩过的 JSON / 单行日志）时，按关键词定位一小段上下文
    const mm = INTERESTING_RE.exec(mid);
    if (mm) {
      const at = Math.max(0, mm.index - 60);
      midNote = `\n…（中间省略 ${omitted} 字；抓到这段疑似关键内容）…\n! ${mid.slice(at, at + 180)}\n`;
    } else {
      midNote = `\n…（省略 ${omitted} 字）…\n`;
    }
  }

  return {
    text: `${s.slice(0, keepHead)}${midNote}${s.slice(-keepTail)}`,
    clipped: true
  };
}

/** 把一条工具结果压成一行（给「早期回合」用） */
function oneLineSummary(m) {
  const raw = String(m && m.content != null ? m.content : '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const name = m && m.name ? String(m.name).replace(/^mcp__/, '') : '工具';
  const failed = /^执行失败|失败[:：]/.test(raw);
  const head = raw.slice(0, 60);
  return `${failed ? '✗' : '✓'} ${name}${head ? '：' + head : ''}${raw.length > 60 ? '…' : ''}`;
}

/** 把一条普通消息压成一行（早期对话用） */
function digestLine(m) {
  const raw = contentToText(m && m.content).replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const who = m.role === 'user' ? '主人' : '小问';
  const n = m.role === 'user' ? 40 : 70;
  return `${who}：${raw.slice(0, n)}${raw.length > n ? '…' : ''}`;
}

function contentToText(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((p) => {
      if (!p) return '';
      if (typeof p === 'string') return p;
      if (p.type === 'image_url' || p.image_url) return '[图片]';
      return p.text || '';
    }).filter(Boolean).join(' ');
  }
  return String(c);
}

/** 数一数 messages 里有几「轮」（user 消息的个数） */
function countTurns(list) {
  let n = 0;
  for (const m of (list || [])) if (m && m.role === 'user') n++;
  return n;
}

/**
 * 从后往前保留最后 keepTurns 轮（含其间的 assistant / tool 消息），
 * 返回 {keepStart, keep}.
 */
function tailByTurns(list, keepTurns) {
  const arr = Array.isArray(list) ? list : [];
  if (keepTurns <= 0) return 0;
  let seen = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] && arr[i].role === 'user') {
      seen++;
      if (seen >= keepTurns) return i;
    }
  }
  return 0;
}

/**
 * 核心：压缩上下文。
 *
 * @param {object} o
 * @param {Array}  o.messages   历史消息（不含 system）
 * @param {number} o.budget     可用 token 预算（已扣掉系统提示与回复预留）
 * @param {number} [o.keepTurns] 最近多少轮保留原文
 * @param {number} [o.toolOutputMax] 单条工具输出最多留多少字符
 * @param {string} [o.priorSummary] 之前积累的会话摘要
 * @returns {{messages:Array, stats:object}}
 */
function compress(o = {}) {
  const all = Array.isArray(o.messages) ? o.messages.filter(Boolean) : [];
  const budget = Math.max(512, Number(o.budget) || 6000);
  const keepTurns = Math.max(1, Number(o.keepTurns) || 8);
  const toolMax = Math.max(120, Number(o.toolOutputMax) || 1200);
  const priorSummary = String(o.priorSummary || '').trim();

  const before = totalTokens(all);
  const stats = {
    beforeTokens: before,
    budget,
    compressed: false,
    clippedTools: 0,
    droppedMessages: 0,
    digestLines: 0,
    keptTurns: 0,
    afterTokens: before,
    ratio: 1,
    parts: []
  };

  // 第一步：先把所有 tool 输出裁剪一遍（不影响语义结构，永远安全）
  let work = all.map((m) => {
    if (!m || m.role !== 'tool') return m;
    const r = clipToolOutput(m.content, toolMax);
    if (!r.clipped) return m;
    stats.clippedTools++;
    return { ...m, content: r.text };
  });
  if (stats.clippedTools) stats.parts.push(`裁剪 ${stats.clippedTools} 条工具输出`);

  let after = totalTokens(work);
  stats.afterTokens = after;

  if (after <= budget) {
    stats.ratio = before ? after / before : 1;
    return { messages: work, stats };
  }

  // 第二步：保留最近 keepTurns 轮原文，更早的压成时间线摘要
  const keepStart = tailByTurns(work, keepTurns);
  const old = work.slice(0, keepStart);
  const keep = work.slice(keepStart);
  stats.keptTurns = countTurns(keep);
  stats.droppedMessages = old.length;

  const digest = [];
  // 早期的工具往返合成一行
  for (let i = 0; i < old.length; i++) {
    const m = old[i];
    if (!m) continue;
    if (m.role === 'tool') { digest.push(oneLineSummary(m)); continue; }
    if (m.role === 'assistant') {
      // assistant 只带 tool_calls、没有正文的，跳过（它的结果已经在上面的 ✓ 行里了）
      const line = digestLine(m);
      if (line && !/^小问：$/.test(line)) digest.push(line);
      continue;
    }
    const line = digestLine(m);
    if (line) digest.push(line);
  }

  const digestText = digest.filter(Boolean).join('\n');
  stats.digestLines = digest.filter(Boolean).length;
  if (digestText) stats.parts.push(`早期 ${old.length} 条压成 ${stats.digestLines} 行纪要`);

  const summaryChunks = [];
  if (priorSummary) summaryChunks.push(priorSummary);
  if (digestText) summaryChunks.push(digestText);
  const summaryBlock = summaryChunks.join('\n');
  stats.digestText = digestText;

  let result = [];
  if (summaryBlock) {
    result.push({
      role: 'system',
      content: [
        '【更早的对话纪要】（按时间顺序，只保留要点；原始细节已省略，需要时可以直接动手查，不要凭记忆编造）',
        summaryBlock
      ].join('\n')
    });
  }
  result = result.concat(keep);

  // 第三步：还不够就继续砍最老的轮次，直到进预算
  let guard = 0;
  while (totalTokens(result) > budget && guard < 200) {
    guard++;
    // 找到第一条真正的 user 消息之后的位置，整轮丢掉
    let cut = -1;
    for (let i = 0; i < result.length; i++) {
      if (result[i].role === 'user') { cut = i; break; }
    }
    if (cut < 0) {
      // 连 user 消息都没有了，退化成硬切：保留最后 N 条
      if (result.length <= 2) break;
      result = result.slice(Math.ceil(result.length / 4));
      stats.droppedMessages++;
      continue;
    }
    // 丢掉 [cut, 下一个 user) 这一整轮
    let next = -1;
    for (let i = cut + 1; i < result.length; i++) {
      if (result[i].role === 'user') { next = i; break; }
    }
    if (next < 0) {
      if (result.length <= 2) break;
      result = result.slice(cut + 1);
      stats.droppedMessages++;
      continue;
    }
    const removed = next - cut;
    result = result.slice(0, cut).concat(result.slice(next));
    stats.droppedMessages += removed;
    stats.keptTurns = countTurns(result);
  }

  if (stats.droppedMessages || stats.clippedTools) stats.compressed = true;
  if (stats.parts.length < 3 && stats.droppedMessages) stats.parts.push(`再丢 ${stats.droppedMessages} 条最老消息`);

  stats.afterTokens = totalTokens(result);
  stats.ratio = before ? stats.afterTokens / before : 1;
  return { messages: result, stats };
}

/**
 * 是否值得让模型来「重写摘要」。
 * 只在真的比较长、且这一轮已经发生过机械压缩时才做，避免无谓的调用。
 */
function shouldSummarize(stats) {
  if (!stats) return false;
  return stats.compressed === true && stats.beforeTokens > 1500 && stats.digestLines > 0;
}

/** 给模型的重写摘要请求（外部负责真正发请求） */
function buildSummaryPrompt({ priorSummary, digestText, maxChars = 800 }) {
  return [
    '把下面这段对话纪要压缩成一段更精炼的中文摘要，保留：主人的偏好与要求、已经得出的结论、未完成的事项、以及关键的事实性信息（路径、数字、决定）。',
    `不要保留寒暄和过程描述，不要编造没出现过的内容。控制在 ${maxChars} 字以内，直接输出摘要正文。`,
    '',
    priorSummary ? `【已有摘要】\n${priorSummary}\n` : '',
    digestText ? `【新增纪要】\n${digestText}` : ''
  ].filter(Boolean).join('\n');
}

module.exports = {
  estimateTokens,
  msgTokens,
  totalTokens,
  clipToolOutput,
  pickInterestingLines,
  oneLineSummary,
  digestLine,
  contentToText,
  countTurns,
  tailByTurns,
  compress,
  shouldSummarize,
  buildSummaryPrompt
};
