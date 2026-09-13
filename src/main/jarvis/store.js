/**
 * 小问 · Jarvis 统一存储层
 *
 * 所有 Jarvis 相关的数据都落在 userData/jarvis/ 下，与旧的 config.json 分开，
 * 避免把主配置弄脏：
 *   persona.json     人格设定（我是谁、主人是谁）
 *   memory.json      长期记忆条目
 *   sessions.json    短期记忆（多轮会话）
 *   mcp.json         MCP 服务器配置
 *   tools.json       内置工具开关与权限
 *   skills/          用户自定义技能
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

let DATA_DIR = null;

function dataDir() {
  if (!DATA_DIR) {
    DATA_DIR = path.join(app.getPath('userData'), 'jarvis');
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (e) {
      console.error('[jarvis:store] mkdir failed', e);
    }
  }
  return DATA_DIR;
}

function filePath(name) {
  return path.join(dataDir(), name);
}

function readJson(name, fallback) {
  try {
    const p = filePath(name);
    if (!fs.existsSync(p)) return JSON.parse(JSON.stringify(fallback));
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return JSON.parse(JSON.stringify(fallback));
    return parsed;
  } catch (e) {
    console.error('[jarvis:store] read failed:', name, e && e.message);
    return JSON.parse(JSON.stringify(fallback));
  }
}

function writeJson(name, data) {
  try {
    fs.writeFileSync(filePath(name), JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[jarvis:store] write failed:', name, e && e.message);
    return false;
  }
}

// ---------------- 人格 ----------------
const DEFAULT_PERSONA = {
  assistantName: '小问',
  assistantRole: '贾维斯式的桌面 AI 智能助理',
  assistantTraits: '冷静、高效、可靠，略带幽默；说话简洁不啰嗦，不拍马屁，不废话。',
  userName: '主人',
  userAlias: '',
  userProfile: '',
  styleRules: [
    '用中文回答，默认口语化、像在跟主人当面说话',
    '除非主人要求，否则控制在 200 字以内',
    '涉及操作电脑的动作，先说你要做什么，再执行，不要闷头干',
    '不确定就直说不确定，不要编造'
  ].join('\n'),
  customPrompt: ''
};

function getPersona() {
  return { ...DEFAULT_PERSONA, ...readJson('persona.json', {}) };
}

function setPersona(patch) {
  const next = { ...getPersona(), ...(patch || {}) };
  writeJson('persona.json', next);
  return next;
}

/** 拼装进 system prompt 的人格段 */
function personaPrompt() {
  const p = getPersona();
  const lines = [];
  lines.push(`你是「${p.assistantName}」，${p.assistantRole}。`);
  if (p.assistantTraits) lines.push(`你的性格：${p.assistantTraits}`);
  lines.push(`你的主人是「${p.userName}」${p.userAlias ? `（也可以叫他 ${p.userAlias}）` : ''}，你的一切能力都是为主人服务的。`);
  if (p.userProfile) lines.push(`关于主人的已知信息：\n${p.userProfile}`);
  if (p.styleRules) lines.push(`说话风格要求：\n${p.styleRules}`);
  if (p.customPrompt) lines.push(`主人的额外要求：\n${p.customPrompt}`);
  return lines.filter(Boolean).join('\n');
}

// ---------------- 长期记忆 ----------------
const MAX_MEMORY = 500;

function getMemories() {
  const data = readJson('memory.json', { items: [] });
  return Array.isArray(data.items) ? data.items : [];
}

function saveMemories(items) {
  return writeJson('memory.json', { items, updatedAt: Date.now() });
}

function addMemory({ content, category, tags, source }) {
  const text = String(content || '').trim();
  if (!text) return null;
  const items = getMemories();
  // 去重：内容完全一样就不重复写
  const dup = items.find((m) => m.content === text);
  if (dup) {
    dup.hits = (dup.hits || 0) + 1;
    dup.updatedAt = Date.now();
    saveMemories(items);
    return dup;
  }
  const item = {
    id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    content: text,
    category: category || 'fact',
    tags: Array.isArray(tags) ? tags : (tags ? String(tags).split(/[,，\s]+/).filter(Boolean) : []),
    source: source || 'user',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hits: 0
  };
  items.push(item);
  if (items.length > MAX_MEMORY) items.splice(0, items.length - MAX_MEMORY);
  saveMemories(items);
  return item;
}

function removeMemory(id) {
  const items = getMemories().filter((m) => m.id !== id);
  saveMemories(items);
  return items.length;
}

function clearMemories() {
  saveMemories([]);
  return true;
}

/**
 * 记忆检索（无向量库，用「关键词命中 + 新鲜度 + 热度」打分）。
 * 中文按二字组切分，英文数字按词切分。
 */
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const en = s.match(/[a-z0-9_]{2,}/g) || [];
  const cnRaw = s.replace(/[a-z0-9_\s]/g, '');
  const cn = [];
  for (let i = 0; i < cnRaw.length - 1; i++) cn.push(cnRaw.slice(i, i + 2));
  return { en, cn, raw: s };
}

function searchMemories(query, limit = 8) {
  const q = tokenize(query);
  if (!q.cn.length && !q.en.length) {
    return getMemories()
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, limit);
  }
  const now = Date.now();
  const scored = getMemories().map((m) => {
    const t = tokenize(m.content + ' ' + (m.tags || []).join(' ') + ' ' + (m.category || ''));
    let score = 0;
    for (const w of q.en) if (t.en.includes(w) || t.raw.includes(w)) score += 3;
    const cnSet = new Set(t.cn);
    for (const w of q.cn) if (cnSet.has(w)) score += 2;
    if (t.raw.includes(q.raw) && q.raw.length > 3) score += 8;
    if (score <= 0) return { m, score: -1 };
    // 新鲜度衰减（半年以上几乎不加权）
    const ageDay = (now - (m.updatedAt || m.createdAt || now)) / 86400000;
    score += Math.max(0, 6 - ageDay / 30);
    score += Math.min(4, (m.hits || 0) * 0.5);
    return { m, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.m);
}

/** 给 system prompt 用的记忆摘要 */
function memoryPrompt(query, limit = 8) {
  const list = searchMemories(query, limit);
  if (!list.length) return '';
  return '你记得关于主人的这些事：\n' + list.map((m) => `- ${m.content}`).join('\n');
}

// ---------------- 短期记忆（会话） ----------------
const MAX_SESSIONS = 30;

function getSessions() {
  const data = readJson('sessions.json', { sessions: [], activeId: null });
  return {
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    activeId: data.activeId || null
  };
}

function saveSessions(data) {
  // 控制体积：每个会话只保留最近 200 条
  const trimmed = (data.sessions || []).map((s) => ({
    ...s,
    messages: (s.messages || []).slice(-200)
  }));
  return writeJson('sessions.json', { sessions: trimmed, activeId: data.activeId });
}

function createSession(title) {
  const data = getSessions();
  const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const s = { id, title: title || '新对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  data.sessions.push(s);
  if (data.sessions.length > MAX_SESSIONS) data.sessions.splice(0, data.sessions.length - MAX_SESSIONS);
  data.activeId = id;
  saveSessions(data);
  return s;
}

function getSession(id) {
  const data = getSessions();
  return data.sessions.find((s) => s.id === id) || null;
}

function getActiveSession() {
  const data = getSessions();
  let s = data.sessions.find((x) => x.id === data.activeId);
  if (!s) {
    s = data.sessions[data.sessions.length - 1] || null;
    if (!s) s = createSession('新对话');
  }
  return s;
}

function appendMessage(sessionId, msg) {
  const data = getSessions();
  let s = data.sessions.find((x) => x.id === sessionId);
  if (!s) return null;
  s.messages.push({ ...msg, ts: Date.now() });
  s.updatedAt = Date.now();
  // 首条用户消息自动当标题
  if (s.title === '新对话' && msg.role === 'user') {
    s.title = String(msg.content || '').slice(0, 24) || '新对话';
  }
  saveSessions(data);
  return s;
}

function setSessionMessages(sessionId, messages) {
  const data = getSessions();
  const s = data.sessions.find((x) => x.id === sessionId);
  if (!s) return null;
  s.messages = messages;
  s.updatedAt = Date.now();
  saveSessions(data);
  return s;
}

function renameSession(id, title) {
  const data = getSessions();
  const s = data.sessions.find((x) => x.id === id);
  if (!s) return null;
  s.title = title || s.title;
  saveSessions(data);
  return s;
}

function deleteSession(id) {
  const data = getSessions();
  data.sessions = data.sessions.filter((s) => s.id !== id);
  if (data.activeId === id) data.activeId = data.sessions.length ? data.sessions[data.sessions.length - 1].id : null;
  saveSessions(data);
  return data.sessions.length;
}

function setActiveSession(id) {
  const data = getSessions();
  if (!data.sessions.find((s) => s.id === id)) return null;
  data.activeId = id;
  saveSessions(data);
  return id;
}

// ---------------- MCP 配置 ----------------
function getMcpServers() {
  const data = readJson('mcp.json', { servers: [] });
  return Array.isArray(data.servers) ? data.servers : [];
}

function saveMcpServers(servers) {
  return writeJson('mcp.json', { servers, updatedAt: Date.now() });
}

// ---------------- 工具开关 ----------------
const DEFAULT_TOOL_SETTINGS = {
  enabled: true,
  // 需要二次确认的高危工具
  dangerTools: ['shell_exec', 'file_write', 'file_delete', 'process_kill', 'browser_act'],
  confirmMode: 'danger', // 'danger' 仅高危确认 | 'all' 全部确认 | 'none' 不确认
  allowPaths: [],        // 白名单根目录，为空表示仅允许 userData / home / 临时目录
  shellTimeoutMs: 30000,
  maxOutputChars: 6000
};

function getToolSettings() {
  return { ...DEFAULT_TOOL_SETTINGS, ...readJson('tools.json', {}) };
}

function setToolSettings(patch) {
  const next = { ...getToolSettings(), ...(patch || {}) };
  writeJson('tools.json', next);
  return next;
}

function skillsDir() {
  const p = path.join(dataDir(), 'skills');
  try {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  } catch (e) { /* ignore */ }
  return p;
}

module.exports = {
  dataDir,
  skillsDir,
  readJson,
  writeJson,
  // persona
  DEFAULT_PERSONA,
  getPersona,
  setPersona,
  personaPrompt,
  // memory
  getMemories,
  addMemory,
  removeMemory,
  clearMemories,
  searchMemories,
  memoryPrompt,
  // sessions
  getSessions,
  createSession,
  getSession,
  getActiveSession,
  appendMessage,
  setSessionMessages,
  renameSession,
  deleteSession,
  setActiveSession,
  // mcp / tools
  getMcpServers,
  saveMcpServers,
  getToolSettings,
  setToolSettings
};
