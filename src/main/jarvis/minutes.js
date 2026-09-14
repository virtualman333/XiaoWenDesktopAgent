/**
 * 会议纪要 —— 转写清洗 + 纪要落盘 + 摘要解析（纯逻辑，不 import Electron，可直接单测）。
 *
 * 一次会议的数据模型：
 *   { id, app, appExe, title, startedAt, endedAt, durationMs,
 *     segments:[{at, text, source}], transcript, summary, stats, savedAt }
 *
 * 落盘位置（由 main.js 注入，默认 userData/minutes/）：
 *   index.json        列表索引（只放轻量字段，避免列个表就把几万字全读进来）
 *   <id>.json         完整记录（含转写与摘要）
 *   <id>.md           人看的 Markdown 纪要
 *
 * 关于转写清洗：在线实时识别在「一段话被切成好几片」时会把同一句反复吐出来，
 * 或者把静音识别成「嗯」「啊」。不过滤的话纪要被灌水，摘要也跟着变差，
 * 所以这里做两件事：丢掉噪声片段、丢掉与上文近似重复的片段。
 */

const fs = require('fs');
const path = require('path');

let getDir = null;
function bind(opts = {}) {
  if (typeof opts.getDir === 'function') getDir = opts.getDir;
}

function dir() {
  const d = getDir ? getDir() : path.join(process.cwd(), 'minutes');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ignore */ }
  return d;
}
function fileOf(name) { return path.join(dir(), name); }

function readJson(name, fallback) {
  try {
    const p = fileOf(name);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    return fallback;
  }
}
function writeJson(name, data) {
  try {
    const p = fileOf(name);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, p);
    return true;
  } catch (e) {
    return false;
  }
}

// ---------------- 文本清洗（纯逻辑） ----------------

const FILLERS = /^[嗯啊呃哦唉额呀哈唔嘛吧的了、，。？！,.?!~\s]+$/;

/** 真实内容里最常见的一类幻觉：一长串同一个字（"嗯嗯嗯嗯"） */
function isRepeatChars(s) {
  const t = String(s || '').replace(/\s/g, '');
  if (t.length < 4) return false;
  const first = t[0];
  for (let i = 1; i < t.length; i++) if (t[i] !== first) return false;
  return true;
}

function cleanText(text) {
  return String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .replace(/^[\s，。、,.]+/, '')
    .replace(/[\s，、,]+$/, '')
    .trim();
}

/** 值不值得进纪要 */
function isNoise(text) {
  const t = cleanText(text);
  if (t.length < 2) return true;
  if (FILLERS.test(t)) return true;
  if (isRepeatChars(t)) return true;
  return false;
}

/** 二元组 Dice 相似度（0~1），用来判「ASR 把同一句吐了两遍」 */
function diceCoefficient(a, b) {
  const A = String(a || '').replace(/\s/g, '');
  const B = String(b || '').replace(/\s/g, '');
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.length < 2 || B.length < 2) return A === B ? 1 : 0;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const ma = grams(A);
  const mb = grams(B);
  let inter = 0;
  let total = 0;
  for (const [g, n] of ma) {
    total += n;
    const m = mb.get(g);
    if (m) inter += Math.min(n, m);
  }
  for (const [, n] of mb) total += n;
  return total ? (2 * inter) / total : 0;
}

/**
 * 是不是「上一句的重复」。
 * 实时识别在长句上会给出不断增长的前缀（「大家好」→「大家好我是小王」），
 * 这种要用「前缀扩展」判；完全重说一遍则用相似度判。
 */
function isNearDuplicate(prev, cur) {
  const a = cleanText(prev);
  const b = cleanText(cur);
  if (!a || !b) return false;
  if (a === b) return true;
  if (b.startsWith(a) && b.length - a.length <= 6) return true;
  if (a.startsWith(b) && a.length - b.length <= 4) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen >= 6 && diceCoefficient(a, b) >= 0.86) return true;
  return false;
}

/**
 * 清洗整段转写。
 * @param {Array<{at:number,text:string,source?:string}>} raw
 * @param {{dedupeWindow?:number}} [opts] dedupeWindow：往前看几句判重（默认 3）
 */
function mergeSegments(raw, opts = {}) {
  const list = Array.isArray(raw) ? raw : [];
  const win = Math.max(1, Number(opts.dedupeWindow) || 3);
  const segments = [];
  let dropped = 0;
  let dup = 0;
  for (const item of list) {
    const text = cleanText(item && item.text);
    if (isNoise(text)) { dropped++; continue; }
    const from = Math.max(0, segments.length - win);
    let dupHit = -1;
    for (let i = from; i < segments.length; i++) {
      if (isNearDuplicate(segments[i].text, text)) { dupHit = i; break; }
    }
    if (dupHit >= 0) {
      dup++;
      // 保留信息更全的那一条（长的通常是识别完的成品）
      if (text.length > segments[dupHit].text.length) {
        segments[dupHit] = { ...segments[dupHit], text };
      }
      continue;
    }
    segments.push({
      at: Number(item && item.at) || 0,
      text,
      source: (item && item.source) === 'mic' ? 'mic' : 'loopback'
    });
  }
  return { segments, dropped, dup };
}

function pad2(n) { return String(n).padStart(2, '0'); }

function hhmm(ts) {
  const d = new Date(Number(ts) || 0);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 转写成带时间戳的正文；每 block 行合成一段，方便阅读 */
function buildTranscript(segments, opts = {}) {
  const list = Array.isArray(segments) ? segments : [];
  const perBlock = Math.max(1, Number(opts.perBlock) || 6);
  const lines = [];
  for (let i = 0; i < list.length; i += perBlock) {
    const chunk = list.slice(i, i + perBlock);
    const head = hhmm(chunk[0].at);
    const tail = hhmm(chunk[chunk.length - 1].at);
    const span = head === tail ? `[${head}]` : `[${head}~${tail}]`;
    lines.push(`${span} ${chunk.map((s) => s.text).join('')}`);
  }
  return lines.join('\n\n');
}

function plainTranscript(segments) {
  return (Array.isArray(segments) ? segments : []).map((s) => s.text).join('\n');
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

// ---------------- 摘要 ----------------

/**
 * 让模型输出的格式：固定的 markdown 小标题。
 * 用 markdown 而不是 JSON —— 长转写里模型容易把 JSON 写崩，
 * markdown 崩了还能靠正则捞回来，读起来也直接能看。
 */
function summaryPrompt(meta = {}, transcript = '') {
  const head = [
    `应用：${meta.app || '未知'}`,
    `开始：${meta.startedAt ? new Date(meta.startedAt).toLocaleString('zh-CN') : '未知'}`,
    `时长：${fmtDuration(meta.durationMs)}`
  ].join('\n');
  const system = [
    '你是会议纪要助手。下面是一段会议/通话的实时转写（可能有识别错误、重复、口语废话）。',
    '请严格按以下 Markdown 结构输出，不要写额外的开场白：',
    '',
    '## 主题',
    '一句话说清这次会议在谈什么。',
    '',
    '## 要点',
    '- 关键信息、讨论内容，按重要性排序，5~10 条',
    '',
    '## 结论',
    '- 已经确定下来的决定（没有就写「无」）',
    '',
    '## 待办',
    '- [ ] 事项 —— 负责人（没提到就写「未指定」），只写明确承诺要做的事',
    '',
    '## 风险与疑问',
    '- 悬而未决的问题（没有就写「无」）',
    '',
    '规则：只依据转写内容，不要编造人名和数据；转写里听不出来的就写「未提及」；用简体中文。'
  ].join('\n');
  const user = `【会议信息】\n${head}\n\n【转写全文】\n${transcript}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

const SUMMARY_SECTIONS = ['主题', '要点', '结论', '待办', '风险与疑问'];

function bulletLines(block) {
  return String(block || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*+]\s*(\[[ xX]\]\s*)?/, '').trim())
    .filter((l) => l && !/^(无|没有|暂无|none|n\/a)$/i.test(l));
}

/**
 * 解析模型给的摘要。两路兜底：markdown 小标题 / JSON。
 * 都失败就原样塞进 raw，至少别丢内容。
 */
function parseSummary(raw) {
  const text = String(raw == null ? '' : raw).trim();
  const empty = { topic: '', points: [], decisions: [], todos: [], risks: [], raw: text };
  if (!text) return empty;

  // 1) 先试 JSON（有的模型就爱包成 JSON）
  const jsonTry = (() => {
    const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    const body = m ? m[1] : text;
    if (!/^\s*[{[]/.test(body)) return null;
    try { return JSON.parse(body); } catch (e) { return null; }
  })();
  if (jsonTry && typeof jsonTry === 'object' && !Array.isArray(jsonTry)) {
    const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : (v ? [String(v).trim()] : []));
    return {
      topic: String(jsonTry.topic || jsonTry['主题'] || '').trim(),
      points: arr(jsonTry.points || jsonTry['要点']),
      decisions: arr(jsonTry.decisions || jsonTry['结论']),
      todos: arr(jsonTry.todos || jsonTry['待办']),
      risks: arr(jsonTry.risks || jsonTry['风险与疑问'] || jsonTry.risks_questions),
      raw: text
    };
  }

  // 2) markdown 小标题
  const blocks = {};
  const re = /^#{2,4}\s*(.+?)\s*$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(text))) marks.push({ name: m[1].trim(), start: re.lastIndex, at: m.index });
  if (marks.length) {
    for (let i = 0; i < marks.length; i++) {
      const end = i + 1 < marks.length ? marks[i + 1].at : text.length;
      blocks[marks[i].name] = text.slice(marks[i].start, end).trim();
    }
  }
  const pick = (names) => {
    for (const n of names) {
      for (const key of Object.keys(blocks)) {
        if (key.includes(n)) return blocks[key];
      }
    }
    return '';
  };
  const out = {
    topic: pick(['主题', '概要', '总结']).replace(/^[-*\s]+/, '').split(/\n/)[0].trim(),
    points: bulletLines(pick(['要点', '关键'])),
    decisions: bulletLines(pick(['结论', '决定'])),
    todos: bulletLines(pick(['待办', '行动', 'todo'])),
    risks: bulletLines(pick(['风险', '疑问', '问题'])),
    raw: text
  };
  // 一个标题都没解析出来 —— 直接把整段当要点，别丢内容
  if (!out.topic && !out.points.length && !out.decisions.length && !out.todos.length) {
    return { ...empty, points: bulletLines(text) };
  }
  return out;
}

// ---------------- 渲染 ----------------

function renderMarkdown(rec = {}) {
  const summary = rec.summary || {};
  const lines = [];
  lines.push(`# 会议纪要 · ${rec.app || '未知应用'}`);
  lines.push('');
  lines.push(`- **时间**：${rec.startedAt ? new Date(rec.startedAt).toLocaleString('zh-CN') : '未知'} → ${rec.endedAt ? new Date(rec.endedAt).toLocaleTimeString('zh-CN') : '未知'}`);
  lines.push(`- **时长**：${fmtDuration(rec.durationMs)}`);
  if (rec.stats && rec.stats.source) lines.push(`- **采集**：${rec.stats.source}`);
  if (rec.stats && rec.stats.segCount) lines.push(`- **转写**：约 ${rec.stats.chars || 0} 字 / ${rec.stats.segCount} 段`);
  lines.push('');
  if (summary.topic) {
    lines.push('## 主题');
    lines.push('');
    lines.push(summary.topic);
    lines.push('');
  }
  const section = (title, arr) => {
    if (!Array.isArray(arr) || !arr.length) return;
    lines.push(`## ${title}`);
    lines.push('');
    for (const it of arr) lines.push(`- ${it}`);
    lines.push('');
  };
  section('要点', summary.points);
  section('结论', summary.decisions);
  if (Array.isArray(summary.todos) && summary.todos.length) {
    lines.push('## 待办');
    lines.push('');
    for (const it of summary.todos) lines.push(`- [ ] ${it}`);
    lines.push('');
  }
  section('风险与疑问', summary.risks);
  if (!summary.topic && !(summary.points || []).length) {
    lines.push('## 原始摘要');
    lines.push('');
    lines.push(summary.raw || '（没有生成摘要）');
    lines.push('');
  }
  if (rec.transcript) {
    lines.push('---');
    lines.push('');
    lines.push('## 转写全文');
    lines.push('');
    lines.push(rec.transcript);
    lines.push('');
  }
  lines.push(`> 由小问助手自动记录于 ${new Date(rec.savedAt || Date.now()).toLocaleString('zh-CN')}`);
  return lines.join('\n');
}

// ---------------- 落盘 ----------------

function newId(appKey, startedAt) {
  const d = new Date(Number(startedAt) || Date.now());
  const slug = String(appKey || 'meeting').replace(/[^\w\u4e00-\u9fa5-]+/g, '').slice(0, 12) || 'meeting';
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}-${slug}`;
}

function indexPath() { return 'index.json'; }

function list() {
  const d = readJson(indexPath(), { items: [] });
  const items = Array.isArray(d.items) ? d.items : [];
  return items.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

function get(id) {
  const rec = readJson(`${id}.json`, null);
  if (!rec) return null;
  return rec;
}

/** 更新索引里的那一行（存在就替换，不存在就插到最前） */
function upsertIndex(row) {
  const d = readJson(indexPath(), { items: [] });
  const items = Array.isArray(d.items) ? d.items : [];
  const i = items.findIndex((x) => x.id === row.id);
  if (i >= 0) items[i] = { ...items[i], ...row };
  else items.unshift(row);
  // 索引最多留 200 条，多余的（连同文件）在 remove 里清
  d.items = items.slice(0, 200);
  writeJson(indexPath(), d);
  return d.items;
}

function summaryRow(rec) {
  const s = rec.summary || {};
  return {
    id: rec.id,
    app: rec.app || '',
    title: rec.title || '',
    startedAt: rec.startedAt || 0,
    endedAt: rec.endedAt || 0,
    durationMs: rec.durationMs || 0,
    chars: (rec.stats && rec.stats.chars) || 0,
    segCount: (rec.stats && rec.stats.segCount) || 0,
    topic: s.topic || '',
    todoCount: (s.todos || []).length,
    savedAt: rec.savedAt || Date.now()
  };
}

function save(rec) {
  if (!rec || !rec.id) return { ok: false, error: '缺少 id' };
  const full = { ...rec, savedAt: rec.savedAt || Date.now() };
  const okJson = writeJson(`${full.id}.json`, full);
  let okMd = false;
  try {
    fs.writeFileSync(fileOf(`${full.id}.md`), renderMarkdown(full), 'utf-8');
    okMd = true;
  } catch (e) { /* ignore */ }
  upsertIndex(summaryRow(full));
  return { ok: okJson, md: okMd, path: fileOf(`${full.id}.json`), mdPath: fileOf(`${full.id}.md`) };
}

function remove(id) {
  let ok = true;
  for (const name of [`${id}.json`, `${id}.md`]) {
    try {
      const p = fileOf(name);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) { ok = false; }
  }
  const d = readJson(indexPath(), { items: [] });
  d.items = (Array.isArray(d.items) ? d.items : []).filter((x) => x.id !== id);
  writeJson(indexPath(), d);
  return ok;
}

function stats() {
  const items = list();
  const now = new Date();
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const today = items.filter((x) => (x.startedAt || 0) >= today0);
  return {
    count: items.length,
    todayCount: today.length,
    todayMs: today.reduce((a, b) => a + (b.durationMs || 0), 0),
    todayChars: today.reduce((a, b) => a + (b.chars || 0), 0),
    lastAt: items[0] ? items[0].startedAt : 0,
    lastTopic: items[0] ? items[0].topic : ''
  };
}

/** 按关键词找纪要（小问的 search_minutes 工具用） */
function search(keyword, limit = 5) {
  const kw = String(keyword || '').trim().toLowerCase();
  const items = list();
  if (!kw) return items.slice(0, Math.max(1, limit));
  const hitRows = items.filter((x) => `${x.app} ${x.title} ${x.topic}`.toLowerCase().includes(kw));
  const out = [...hitRows];
  if (out.length < limit) {
    for (const row of items) {
      if (out.length >= limit) break;
      if (out.some((x) => x.id === row.id)) continue;
      const rec = get(row.id);
      if (rec && String(rec.transcript || '').toLowerCase().includes(kw)) out.push(row);
    }
  }
  return out.slice(0, Math.max(1, limit));
}

module.exports = {
  bind,
  dir,
  // 纯逻辑
  cleanText,
  isNoise,
  isRepeatChars,
  diceCoefficient,
  isNearDuplicate,
  mergeSegments,
  buildTranscript,
  plainTranscript,
  fmtDuration,
  hhmm,
  summaryPrompt,
  parseSummary,
  renderMarkdown,
  newId,
  summaryRow,
  SUMMARY_SECTIONS,
  // 存取
  list,
  get,
  save,
  remove,
  stats,
  search
};
