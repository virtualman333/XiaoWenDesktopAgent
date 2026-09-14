import { streamChat, streamAgent, testConnection, abortChat } from './api.js';
import { renderMarkdown, toPlainText } from './markdown.js';
import * as speech from './speech.js';
import { DEFAULT_WAKE_WORDS } from './wake.js';
import { maybeShowSetup, openSetup } from './setup.js';

// ============ 全局状态 ============
let cfg = {};
let persona = null;
let session = null;         // 当前会话对象 { id, title, messages }
let messages = [];          // 当前会话消息（不含 system）
let streaming = false;
let abortCtrl = null;
let currentAiNode = null;   // 正在流式输出的气泡节点
let lastUserText = '';
let currentAudio = null;    // 正在播放的 TTS 音频（dashscope / openai 方案）

const $ = (id) => document.getElementById(id);

/**
 * 角色名归一化。
 * 界面内部一直用 'ai' 表示助手，但 OpenAI 兼容接口只接受
 * system / assistant / user / tool / function，直接发 'ai' 会 400。
 */
function normalizeRole(role) {
  if (role === 'ai') return 'assistant';
  return role;
}

const els = {
  messages: $('messages'),
  welcome: $('welcome'),
  input: $('input'),
  btnSend: $('btnSend'),
  btnVoice: $('btnVoice'),
  btnNew: $('btnNew'),
  btnAgent: $('btnAgent'),
  btnSessions: $('btnSessions'),
  btnSettings: $('btnSettings'),
  btnMin: $('btnMin'),
  btnClose: $('btnClose'),
  modelTag: $('modelTag'),
  appName: $('appName'),
  statusTip: $('statusTip'),
  ttsToggle: $('ttsToggle'),
  voiceOverlay: $('voiceOverlay'),
  voiceText: $('voiceText'),
  voiceCancel: $('voiceCancel'),
  drawer: $('sessionDrawer'),
  drawerMask: $('drawerMask'),
  sessionList: $('sessionList'),
  // 截图附件 + 子代理任务看板
  btnShot: $('btnShot'),
  attachBar: $('attachBar'),
  orchBoard: $('orchBoard'),
  orchList: $('orchList'),
  orchProgress: $('orchProgress'),
  orchClose: $('orchClose')
};

// 待发送的截图：[{ path, dataUrl }]
let pendingShots = [];
// 子代理任务看板：id -> { title, status, summary, asks }
const orchTasks = new Map();

// 页面用途：设置窗口会带 #settings 打开。
function detectPage() {
  const h = (location.hash || '').toLowerCase();
  const u = decodeURIComponent(location.href || '').toLowerCase();
  if (h.includes('settings') || u.includes('#settings') || u.includes('%23settings')) return 'settings';
  return 'chat';
}
const PAGE = detectPage();

function showView(which) {
  const appEl = document.getElementById('app');
  const setEl = document.getElementById('settings');
  if (!appEl || !setEl) return;
  if (which === 'settings') {
    appEl.style.display = 'none';
    setEl.style.display = 'flex';
  } else {
    appEl.style.display = 'flex';
    setEl.style.display = 'none';
  }
}

// ============ 初始化 ============
async function init() {
  try { cfg = await window.xw.getConfig(); } catch (e) { cfg = {}; }
  try { persona = await window.xw.personaGet(); } catch (e) { persona = null; }

  if (PAGE === 'settings') {
    showView('settings');
    initSettings();
    return;
  }
  showView('chat');
  await initChat();

  // 新机器首次启动：还没配过模型 Key，先走一遍配置引导
  maybeShowSetup(cfg);
}

window.addEventListener('hashchange', () => {
  const p = detectPage();
  showView(p);
  if (p === 'settings') initSettings();
});

try {
  window.xw.onPageMode((mode) => {
    if (mode === 'settings') { showView('settings'); initSettings(); }
    else showView('chat');
  });
} catch (e) { /* ignore */ }

// ================== 对话页 ==================
async function initChat() {
  els.modelTag.textContent = cfg.model || '未配置模型';
  els.ttsToggle.checked = cfg.ttsAutoSpeak === true;
  els.btnAgent && els.btnAgent.classList.toggle('on', cfg.agentEnabled !== false);
  if (persona && persona.assistantName) {
    els.appName.textContent = persona.assistantName;
    const t = $('welcomeTitle');
    if (t) t.textContent = `你好，我是${persona.assistantName}`;
    const d = $('welcomeDesc');
    if (d && persona.userName) d.textContent = `${persona.userName}，随时吩咐。点击悬浮球或按 Alt+Space 语音提问。`;
  }

  await loadSession();
  bindEvents();

  window.xw.onConfigUpdate((c) => {
    cfg = c;
    els.modelTag.textContent = c.model || '未配置模型';
    els.btnAgent && els.btnAgent.classList.toggle('on', c.agentEnabled !== false);
  });
  window.xw.onVoiceStart(() => startVoice());
  window.xw.onHistoryCleared(() => {
    messages = [];
    clearMessageNodes();
    els.welcome.style.display = '';
  });

  bindAsrEvents();
  bindConfirmEvents();
  bindOrch();
  bindUpdater();
  bindProactive();
  renderSessionList();

  // 截图结果（快捷键 / 工具调用）自动带到输入框
  try { window.xw.onCapture && window.xw.onCapture((p) => attachShot(p)); } catch (e) { /* ignore */ }
}

/** 载入（或迁移）当前会话 */
async function loadSession() {
  try {
    let data = await window.xw.sessionList();
    if (!data.sessions || !data.sessions.length) {
      // 首次运行：把旧版 config.history 迁移成会话
      const history = (await window.xw.getHistory()) || [];
      if (history.length) {
        const s = await window.xw.sessionCreate('导入的历史');
        for (const m of history.slice(-40)) {
          await window.xw.sessionAppend(s.id, { role: normalizeRole(m.role), content: m.content });
        }
        data = await window.xw.sessionList();
      } else {
        await window.xw.sessionCreate('新对话');
        data = await window.xw.sessionList();
      }
    }
    session = await window.xw.sessionActive();
  } catch (e) {
    console.error('[session] 加载失败', e);
    session = null;
  }

  messages = [];
  clearMessageNodes();
  if (session && session.messages && session.messages.length) {
    els.welcome.style.display = 'none';
    session.messages.slice(-40).forEach((m) => {
      const role = normalizeRole(m.role);
      addMessageBubble(role, m.content, { animate: false });
      messages.push({ role, content: m.content });
    });
    scrollToBottom();
  } else {
    els.welcome.style.display = '';
  }
}

// ---------- 会话抽屉 ----------
async function renderSessionList() {
  if (!els.sessionList) return;
  try {
    const data = await window.xw.sessionList();
    els.sessionList.innerHTML = '';
    [...data.sessions].reverse().forEach((s) => {
      const item = document.createElement('div');
      item.className = 'sess-item' + (s.id === (session && session.id) ? ' active' : '');
      const title = document.createElement('div');
      title.className = 'sess-title';
      title.textContent = s.title || '新对话';
      const meta = document.createElement('div');
      meta.className = 'sess-meta';
      const d = new Date(s.updatedAt || Date.now());
      meta.textContent = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} · ${s.count || 0} 条`;

      const del = document.createElement('button');
      del.className = 'sess-del';
      del.textContent = '×';
      del.title = '删除会话';
      del.onclick = async (e) => {
        e.stopPropagation();
        await window.xw.sessionDelete(s.id);
        if (session && session.id === s.id) await loadSession();
        renderSessionList();
      };

      item.appendChild(title);
      item.appendChild(meta);
      item.appendChild(del);
      item.onclick = async () => {
        await window.xw.sessionSetActive(s.id);
        await loadSession();
        renderSessionList();
        toggleDrawer(false);
      };
      els.sessionList.appendChild(item);
    });
  } catch (e) { /* ignore */ }
}

function toggleDrawer(show) {
  const on = show === undefined ? !els.drawer.classList.contains('show') : show;
  els.drawer.classList.toggle('show', on);
  els.drawerMask.classList.toggle('show', on);
}

// ---------- 事件绑定 ----------
function bindEvents() {
  els.btnSend.addEventListener('click', () => send());
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  els.input.addEventListener('input', autoResize);

  document.querySelectorAll('.quick').forEach((b) => {
    b.addEventListener('click', () => { els.input.value = b.dataset.q; autoResize(); send(); });
  });

  els.btnVoice.addEventListener('click', startVoice);
  els.btnNew.addEventListener('click', newChat);
  els.btnSettings.addEventListener('click', () => window.xw.openSettings());
  els.btnMin.addEventListener('click', () => window.xw.hidePanel());
  els.btnClose.addEventListener('click', () => window.xw.closePanel());
  els.voiceCancel.addEventListener('click', cancelVoice);
  els.btnSessions.addEventListener('click', () => toggleDrawer());
  if (els.btnShot) {
    els.btnShot.addEventListener('click', async () => {
      const r = await window.xw.captureRegion();
      if (r && r.ok) setToast('已截图，问点什么吧');
    });
  }
  if (els.orchClose) {
    els.orchClose.addEventListener('click', () => { orchTasks.clear(); orchRender(); });
  }
  els.drawerMask.addEventListener('click', () => toggleDrawer(false));
  $('btnNewSession').addEventListener('click', async () => {
    await window.xw.sessionCreate('新对话');
    await loadSession();
    renderSessionList();
    toggleDrawer(false);
  });

  els.btnAgent.addEventListener('click', async () => {
    const next = !(cfg.agentEnabled !== false);
    cfg = await window.xw.setConfig({ agentEnabled: next });
    els.btnAgent.classList.toggle('on', next);
    setStatus(next ? 'Agent 模式已开启：小问可以调用工具操作电脑' : 'Agent 模式已关闭：退化为普通聊天');
  });

  els.ttsToggle.addEventListener('change', async () => {
    cfg = await window.xw.setConfig({ ttsAutoSpeak: els.ttsToggle.checked });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (els.voiceOverlay.classList.contains('show')) cancelVoice();
      else if (els.drawer.classList.contains('show')) toggleDrawer(false);
      else if (streaming) stopStreaming();
    }
  });
}

function autoResize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 130) + 'px';
}
function scrollToBottom() {
  requestAnimationFrame(() => { els.messages.scrollTop = els.messages.scrollHeight; });
}
function clearMessageNodes() {
  [...els.messages.querySelectorAll('.msg, .tool-card')].forEach((n) => n.remove());
}
function setStatus(t) { els.statusTip.textContent = t; }

// ---------- 发送 ----------
async function send(textOverride) {
  if (streaming) return;
  const text = (textOverride ?? els.input.value).trim();
  if (!text) return;

  if (!cfg.apiKeyMasked) {
    setStatus('请先在设置中配置 API Key');
    window.xw.openSettings();
    return;
  }

  els.welcome.style.display = 'none';
  els.input.value = '';
  autoResize();
  updateSendBtn(true);

  // 截图附件：随这条消息一起发出去（多模态模型才看得懂，纯文本模型会自动忽略）
  const shots = pendingShots.slice();
  pendingShots = [];
  renderAttach();

  lastUserText = text;
  const userNode = addMessageBubble('user', text);
  if (userNode && shots.length) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-shots';
    shots.forEach((s) => {
      if (!s.dataUrl) return;
      const im = document.createElement('img');
      im.className = 'msg-shot';
      im.src = s.dataUrl;
      im.alt = '截图';
      wrap.appendChild(im);
    });
    if (wrap.children.length) userNode.appendChild(wrap);
  }
  messages.push({ role: 'user', content: text });
  persist({ role: 'user', content: text + (shots.length ? `\n[附 ${shots.length} 张截图]` : '') });

  const maxTurns = cfg.contextTurns ?? 10;
  const recent = maxTurns > 0 ? messages.slice(-maxTurns * 2) : messages.slice(-1);
  const payload = recent
    .filter((m) => m.content)
    .map((m) => ({ role: normalizeRole(m.role), content: m.content }));

  // 最后一条用户消息换成「文本 + 图片」的多模态格式
  const imgs = shots.filter((s) => s.dataUrl).map((s) => ({ type: 'image_url', image_url: { url: s.dataUrl } }));
  if (imgs.length && payload.length) {
    payload[payload.length - 1] = { role: 'user', content: [{ type: 'text', text }, ...imgs] };
  }

  currentAiNode = addMessageBubble('ai', '', { thinking: true });

  let full = '';
  abortCtrl = new AbortController();
  streaming = true;
  setStatus('思考中…');
  const useAgent = cfg.agentEnabled !== false;
  setStatus(useAgent ? 'Agent 工作中…' : '思考中…');

  try {
    if (useAgent) {
      full = await streamAgent({
        messages: payload,
        sessionId: session && session.id,
        onDelta: (_d, acc) => { full = acc; renderStreaming(currentAiNode, acc); scrollToBottom(); },
        onTool: (p) => renderToolCard(p)
      });
    } else {
      full = await streamChat({
        messages: [{ role: 'system', content: cfg.systemPrompt || '' }, ...payload],
        onDelta: (_d, acc) => { full = acc; renderStreaming(currentAiNode, acc); scrollToBottom(); }
      });
    }
  } catch (err) {
    streaming = false;
    updateSendBtn(false);

    // 模型不支持 Agent：自动降级为普通对话重试一次
    if (err && err.disabled) {
      setStatus('模型不支持函数调用，已切换普通对话');
      cfg = await window.xw.setConfig({ agentEnabled: false });
      els.btnAgent.classList.remove('on');
      streaming = true;
      updateSendBtn(true);
      try {
        full = await streamChat({
          messages: [{ role: 'system', content: cfg.systemPrompt || '' }, ...payload],
          onDelta: (_d, acc) => { full = acc; renderStreaming(currentAiNode, acc); scrollToBottom(); }
        });
      } catch (e2) { err = e2; full = ''; }
      streaming = false;
      updateSendBtn(false);
      if (!full && err) return handleStreamError(err, full);
    } else {
      return handleStreamError(err, full);
    }
  }

  streaming = false;
  updateSendBtn(false);

  if (full) {
    messages.push({ role: 'assistant', content: full });
    persist({ role: 'assistant', content: full });
    finalizeAiNode(currentAiNode, full);
    setStatus('就绪');
    if (els.ttsToggle.checked) speakText(full);
    // 让桌面宠物替小问播报一句（失败静默，宠物窗口可能没开）
    try { window.xw.petSay && window.xw.petSay(plainForPet(full)); } catch (e) { /* ignore */ }
  } else {
    currentAiNode && currentAiNode.remove();
    setStatus('未收到回复');
  }
  currentAiNode = null;
  scrollToBottom();
}

function handleStreamError(err, full) {
  if (err && (err.name === 'AbortError' || err.aborted)) {
    if (full) {
      renderStreaming(currentAiNode, full, true);
      finalizeAiNode(currentAiNode, full);
      messages.push({ role: 'assistant', content: full });
      persist({ role: 'assistant', content: full });
    } else {
      currentAiNode && currentAiNode.remove();
    }
    setStatus('已停止');
  } else {
    const msg = String((err && err.message) || err);
    renderStreaming(currentAiNode, full + `\n\n> ⚠️ 请求失败：${msg}`, true);
    setStatus('请求失败');
  }
  currentAiNode = null;
  updateSendBtn(false);
}

function persist(msg) {
  if (session && session.id) {
    try { window.xw.sessionAppend(session.id, msg); } catch (e) { /* ignore */ }
  }
  window.xw.addHistory(msg);
}

function updateSendBtn(busy) {
  els.btnSend.disabled = busy;
  if (busy) {
    els.btnSend.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
    els.btnSend.title = '停止生成';
    els.btnSend.onclick = stopStreaming;
  } else {
    els.btnSend.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
    els.btnSend.title = '发送';
    els.btnSend.onclick = () => send();
  }
}

function stopStreaming() {
  abortChat();
  if (abortCtrl) abortCtrl.abort();
  speech.stopSpeaking();
  stopAudio();
  streaming = false;
  updateSendBtn(false);
  setStatus('已停止');
}

// ---------- 工具调用卡片 ----------
const TOOL_LABEL = {
  shell_exec: '执行命令', file_read: '读取文件', file_write: '写入文件', file_list: '列出目录',
  file_delete: '删除文件', file_search: '搜索文件', app_open: '打开应用', process_list: '进程列表',
  process_kill: '结束进程', screenshot: '截屏', clipboard_read: '读剪贴板', clipboard_write: '写剪贴板',
  notify: '发送通知', memory_add: '记住信息', memory_search: '检索记忆', http_request: '网络请求',
  get_datetime: '获取时间', system_info: '系统信息', load_skill: '加载技能'
};

function renderToolCard(p) {
  if (!p) return;
  let node = document.getElementById('tool-' + p.id);
  if (p.status === 'start') {
    if (node) node.remove();
    node = document.createElement('div');
    node.id = 'tool-' + p.id;
    node.className = 'tool-card';
    const label = TOOL_LABEL[p.name] || (p.name.startsWith('mcp__') ? 'MCP ' + p.name.split('__')[2] : p.name);
    const brief = briefArgs(p.name, p.args);
    node.innerHTML = `<div class="tool-head"><span class="tool-dot running"></span>
      <span class="tool-name">${escapeHtml(label)}</span>
      ${p.danger ? '<span class="tool-tag danger">高危</span>' : ''}
      <span class="tool-status">执行中…</span></div>
      <div class="tool-args">${escapeHtml(brief)}</div>`;
    els.messages.appendChild(node);
    scrollToBottom();
    setStatus(`正在${label}…`);
    return;
  }
  if (!node) return;
  const head = node.querySelector('.tool-status');
  const dot = node.querySelector('.tool-dot');
  if (p.status === 'rejected') {
    dot.className = 'tool-dot';
    head.textContent = '主人已拒绝';
    node.classList.add('rejected');
  } else {
    dot.className = 'tool-dot done';
    head.textContent = p.ok ? '完成' : '失败';
    node.classList.add(p.ok ? 'done' : 'failed');
    const pre = document.createElement('pre');
    pre.className = 'tool-out';
    pre.textContent = String(p.output || '').slice(0, 700);
    node.appendChild(pre);
    // 截图结果可以直接点开
    const f = p.output && /([A-Za-z]:\\[^\s]+\.png)/.exec(p.output);
    if (f) {
      const b = document.createElement('button');
      b.className = 'tool-open';
      b.textContent = '打开截图';
      b.onclick = () => window.xw.toolsOpenFile(f[1]);
      node.appendChild(b);
    }
  }
  scrollToBottom();
}

function briefArgs(name, args) {
  if (!args) return '';
  if (name === 'shell_exec') return String(args.command || '');
  if (name === 'file_write') return `${args.path} (${String(args.content || '').length} 字符)`;
  return String(args.path || args.url || args.target || args.query || args.text || args.id || JSON.stringify(args)).slice(0, 200);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 高危操作确认 ----------
function bindConfirmEvents() {
  try {
    window.xw.onAgentConfirm(({ id, toolName, args }) => {
      const mask = $('confirmMask');
      const label = TOOL_LABEL[toolName] || toolName;
      $('confirmTitle').textContent = `允许执行「${label}」吗？`;
      $('confirmDesc').textContent = TOOL_LABEL[toolName]
        ? '这是一个可能影响你电脑的操作，确认后才会执行。'
        : '模型想要调用一个外部工具。';
      $('confirmArgs').textContent = briefArgs(toolName, args);
      mask.classList.add('show');
      const done = (approved) => {
        mask.classList.remove('show');
        $('confirmYes').onclick = null;
        $('confirmNo').onclick = null;
        window.xw.agentConfirmReply(id, approved);
      };
      $('confirmYes').onclick = () => done(true);
      $('confirmNo').onclick = () => done(false);
    });
  } catch (e) { /* ignore */ }
}

// ---------- 气泡渲染 ----------
function addMessageBubble(role, content, { animate = true, thinking = false } = {}) {
  const r = normalizeRole(role);
  const wrap = document.createElement('div');
  wrap.className = `msg ${r === 'user' ? 'user' : 'ai'}`;
  if (!animate) wrap.style.animation = 'none';

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = r === 'user' ? '我' : (persona && persona.assistantName ? persona.assistantName.slice(0, 1) : '问');

  const body = document.createElement('div');
  body.className = 'msg-body';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (thinking) bubble.innerHTML = `<span class="thinking-dots"><i></i><i></i><i></i></span>`;
  else if (r === 'assistant') bubble.innerHTML = renderMarkdown(content);
  else bubble.textContent = content;

  body.appendChild(bubble);
  if (r === 'assistant' && !thinking) body.appendChild(buildActions(content, bubble));

  wrap.appendChild(avatar);
  wrap.appendChild(body);
  els.messages.appendChild(wrap);
  if (animate) scrollToBottom();
  return wrap;
}

function renderStreaming(node, text, isError = false) {
  if (!node) return;
  const bubble = node.querySelector('.bubble');
  if (!bubble) return;
  bubble.innerHTML = isError ? renderMarkdown(text) : renderMarkdown(text) + '<span class="cursor"></span>';
}

function finalizeAiNode(node, text) {
  if (!node) return;
  const bubble = node.querySelector('.bubble');
  if (bubble) bubble.innerHTML = renderMarkdown(text);
  const body = node.querySelector('.msg-body');
  if (body && !body.querySelector('.msg-actions')) body.appendChild(buildActions(text, bubble));
}

function buildActions(text, bubble) {
  const bar = document.createElement('div');
  bar.className = 'msg-actions';

  const copyBtn = document.createElement('button');
  copyBtn.textContent = '复制';
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(text);
    copyBtn.textContent = '已复制';
    setTimeout(() => (copyBtn.textContent = '复制'), 1400);
  };

  const speakBtn = document.createElement('button');
  speakBtn.textContent = '朗读';
  const plain = toPlainText(text);
  speakBtn.onclick = () => {
    if (speech.isSpeaking() || currentAudio) {
      speech.stopSpeaking();
      stopAudio();
      speakBtn.classList.remove('on');
      speakBtn.textContent = '朗读';
    } else {
      speakText(plain);
      speakBtn.classList.add('on');
      speakBtn.textContent = '停止';
      const un = () => {
        speakBtn.classList.remove('on');
        speakBtn.textContent = '朗读';
        document.removeEventListener('speech-ended', un);
      };
      document.addEventListener('speech-ended', un);
    }
  };

  const retryBtn = document.createElement('button');
  retryBtn.textContent = '重答';
  retryBtn.onclick = () => {
    if (streaming) return;
    const wrap = bar.closest('.msg');
    const idx = messages.findIndex((m) => normalizeRole(m.role) === 'assistant' && m.content === text);
    if (idx >= 0) messages.splice(idx, 1);
    wrap && wrap.remove();
    const lastIdx = messages.map((m) => m.role).lastIndexOf('user');
    if (lastIdx >= 0) messages.splice(lastIdx, 1);
    if (lastUserText) send(lastUserText);
  };

  bar.appendChild(copyBtn);
  bar.appendChild(speakBtn);
  bar.appendChild(retryBtn);
  return bar;
}

// ---------- 语音输出 ----------
function stopAudio() {
  if (currentAudio) {
    try { currentAudio.pause(); currentAudio.currentTime = 0; } catch (e) { /* ignore */ }
    currentAudio = null;
  }
}

function playAudioFile(file) {
  return new Promise((resolve) => {
    let url = String(file).replace(/\\/g, '/');
    if (!/^file:\/\/\//i.test(url)) url = 'file:///' + url.replace(/^\/+/, '');
    const a = new Audio(url);
    a.volume = (cfg.ttsVolume ?? 100) / 100;
    a.playbackRate = 1 + (cfg.ttsRate || 0) / 20;
    a.onended = () => { currentAudio = null; document.dispatchEvent(new CustomEvent('speech-ended')); resolve(true); };
    a.onerror = () => { currentAudio = null; resolve(false); };
    a.play().then(() => { currentAudio = a; }).catch(() => resolve(false));
  });
}

/** 宠物气泡用的纯文本：去 markdown 符号、压成一行、截断 */
function plainForPet(md) {
  const t = toPlainText(md)
    .replace(/[`#>*_~]/g, '')
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > 48 ? t.slice(0, 48) + '…' : t;
}

async function speakText(text) {
  if (cfg.ttsEnabled === false) return;
  const plain = toPlainText(text);
  if (!plain) return;

  const provider = cfg.ttsProvider || 'web';
  // 长文本截断，避免合成过久
  const body = plain.length > 600 ? plain.slice(0, 600) + '……（内容较长已省略）' : plain;

  if (provider === 'dashscope' || provider === 'openai') {
    try {
      const r = await window.xw.ttsSynth({ provider, text: body });
      if (r && r.ok && r.file) {
        const played = await playAudioFile(r.file);
        if (played) return;
      } else {
        console.warn('[tts] 合成失败，回退系统语音：', r && r.error);
      }
    } catch (e) {
      console.warn('[tts] 合成异常，回退系统语音：', e && e.message);
    }
  }

  speech.speak(body, {
    rate: 1 + (cfg.ttsRate || 0) / 10,
    volume: (cfg.ttsVolume ?? 100) / 100,
    voiceName: cfg.ttsVoice || '',
    onEnd: () => document.dispatchEvent(new CustomEvent('speech-ended'))
  });
}

function newChat() {
  if (streaming) stopStreaming();
  speech.stopSpeaking();
  stopAudio();
  messages = [];
  lastUserText = '';
  clearMessageNodes();
  els.welcome.style.display = '';
  setStatus('就绪');
  window.xw.sessionCreate('新对话').then(async () => {
    await loadSession();
    renderSessionList();
  });
}

// ================== 语音问答 ==================
let voiceFinalText = '';
let voiceActive = false;

function startVoice() {
  if (voiceActive) return;
  const provider = cfg.asrProvider || 'dashscope';
  if (provider === 'dashscope' && !cfg.asrApiKeyMasked) {
    setStatus('请先在设置 → 语音中配置语音识别 API Key');
    window.xw.openSettings();
    return;
  }
  if (!speech.isRecognitionSupported()) {
    setStatus('当前环境不支持语音识别');
    return;
  }

  speech.stopSpeaking();
  stopAudio();
  voiceFinalText = '';
  voiceActive = true;
  els.voiceText.textContent = '正在聆听…';
  els.voiceText.classList.add('live');
  els.voiceOverlay.classList.add('show', 'recording');
  els.btnVoice.classList.add('active');

  const started = speech.startRecognition({
    provider,
    lang: cfg.asrLanguage || 'zh',
    silenceMs: cfg.asrSilenceMs || 2000,
    onResult: (text, isFinal) => {
      els.voiceText.textContent = text || '正在聆听…';
      els.voiceText.classList.toggle('live', !isFinal);
      voiceFinalText = text;
    },
    onLevel: (lv) => els.voiceOverlay.style.setProperty('--voice-level', String(lv)),
    onError: (msg) => {
      voiceActive = false;
      els.voiceText.textContent = msg;
      setStatus(msg);
      setTimeout(() => closeVoiceOverlay(), 2000);
    },
    onEnd: (finalText) => {
      voiceActive = false;
      const t = (finalText || voiceFinalText || '').trim();
      closeVoiceOverlay();
      if (t) send(t);
      else setStatus('未识别到内容');
    }
  });

  Promise.resolve(started).catch((e) => {
    voiceActive = false;
    setStatus('语音识别启动失败：' + (e && e.message));
    closeVoiceOverlay();
  });
}

function cancelVoice() {
  voiceActive = false;
  speech.abortRecognition();
  closeVoiceOverlay();
  setStatus('已取消');
}

function closeVoiceOverlay() {
  els.voiceOverlay.classList.remove('show', 'recording');
  els.voiceText.classList.remove('live');
  els.btnVoice.classList.remove('active');
  els.voiceOverlay.style.removeProperty('--voice-level');
}

function bindAsrEvents() {
  window.xw.onAsrResult((res) => { if (voiceActive) speech.pushAsrResult(res); });
  window.xw.onAsrEnd(() => {
    if (!voiceActive) { speech.handleAsrEnd(); return; }
    voiceActive = false;
    speech.handleAsrEnd();
  });
  window.xw.onAsrError((msg) => {
    voiceActive = false;
    speech.handleAsrError(msg);
    els.voiceText.textContent = msg;
    setStatus(msg);
    setTimeout(() => closeVoiceOverlay(), 2000);
  });
}

// ================== 设置页 ==================
let settingsInited = false;

function initSettings() {
  if (settingsInited) { fillAll(); return; }
  settingsInited = true;
  buildTabs();
  bindGeneral();
  const rerun = $('stRerunSetup');
  if (rerun) rerun.addEventListener('click', () => openSetup(cfg));
  bindModel();
  bindPersona();
  bindAgent();
  bindMcp();
  bindSkills();
  bindVoice();
  bindPet();
  bindTray();
  bindCapture();
  bindSchedule();
  bindWatch();
  bindAdvanced();
  fillAll();
}

function buildTabs() {
  document.querySelectorAll('.st-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.st-nav-item').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.st-section').forEach((s) => s.classList.remove('active'));
      btn.classList.add('active');
      const sec = document.querySelector(`.st-section[data-tab="${btn.dataset.tab}"]`);
      if (sec) sec.classList.add('active');
    });
  });
}

function fillAll() {
  fillGeneral();
  fillModel();
  fillPersona();
  fillAgent();
  fillMcp();
  fillSkills();
  fillVoice();
  fillCapture();
  fillSchedule();
  fillWatch();
  refreshTrayDiag();
  refreshGpuStatus();
}

// ---------- 常规 ----------
function bindGeneral() {
  $('stAutoStart').addEventListener('change', async () => {
    const r = await window.xw.autostartSet($('stAutoStart').checked);
    if (r && r.ok === false) setToast('设置开机自启失败：' + (r.reason || ''));
  });

  const hotkey = $('stHotkey');
  hotkey.addEventListener('keydown', (e) => {
    e.preventDefault();
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Super');
    if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
      parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
    }
    if (parts.length >= 2) hotkey.value = parts.join('+');
  });

  $('stOpacity').addEventListener('input', () => {
    $('stOpacityVal').textContent = $('stOpacity').value + '%';
    window.xw.ballSetOpacity(Number($('stOpacity').value) / 100);
  });
}

async function fillGeneral() {
  try {
    const st = await window.xw.autostartGet();
    $('stAutoStart').checked = !!st.enabled;
  } catch (e) { /* ignore */ }
  $('stOpacity').value = Math.round((cfg.ballOpacity ?? 0.92) * 100);
  $('stOpacityVal').textContent = Math.round((cfg.ballOpacity ?? 0.92) * 100) + '%';
  $('stHotkey').value = cfg.hotkey || 'Alt+Space';
}

// ---------- AI 模型 ----------
function bindModel() {
  $('stProvider').addEventListener('change', () => {
    const v = $('stProvider').value;
    if (v === 'custom') return;
    const [url, model] = v.split('|');
    $('stBaseUrl').value = url;
    $('stModel').value = model;
  });
  $('stKeyToggle').addEventListener('click', () => {
    const el = $('stApiKey');
    const isPwd = el.type === 'password';
    el.type = isPwd ? 'text' : 'password';
    $('stKeyToggle').textContent = isPwd ? '隐藏' : '显示';
  });
  $('stApiKey').addEventListener('input', () => { $('stApiKey').dataset.keep = '0'; });
  $('stContext').addEventListener('input', () => ($('stContextVal').textContent = $('stContext').value));

  $('stTest').addEventListener('click', async () => {
    const baseUrl = $('stBaseUrl').value.trim();
    const model = $('stModel').value.trim();
    const keyInput = $('stApiKey').value.trim();
    const apiKey = $('stApiKey').dataset.keep === '1' ? '__KEEP__' : (keyInput || '__KEEP__');
    if (!baseUrl || !model) return showTest('请先填写接口地址与模型名', 'err');
    showTest('正在测试连接…', 'loading');
    try {
      const reply = await testConnection({ baseUrl, model, apiKey });
      showTest(`连接成功 ✓ 模型回复：${reply || '(空)'}`, 'ok');
    } catch (e) {
      showTest(`连接失败：${e.message}`, 'err');
    }
  });
}

function showTest(msg, type) {
  const el = $('stTestResult');
  el.textContent = msg;
  el.className = 'test-result show ' + type;
}

function fillModel() {
  $('stBaseUrl').value = cfg.apiBaseUrl || '';
  $('stModel').value = cfg.model || '';
  const hasKey = !!cfg.apiKeyMasked;
  $('stApiKey').value = '';
  $('stApiKey').placeholder = hasKey
    ? `已配置：${cfg.apiKeyMasked}（留空保持不变，重新填写则覆盖）`
    : 'sk-... 请粘贴服务商提供的 API Key';
  $('stApiKey').dataset.keep = hasKey ? '1' : '0';
  $('stContext').value = cfg.contextTurns ?? 10;
  $('stContextVal').textContent = cfg.contextTurns ?? 10;
  const match = [...$('stProvider').options].find((o) => o.value === `${cfg.apiBaseUrl}|${cfg.model}`);
  $('stProvider').value = match ? match.value : 'custom';
}

// ---------- 人格与记忆 ----------
function bindPersona() {
  const fields = { pzName: 'assistantName', pzRole: 'assistantRole', pzTraits: 'assistantTraits', pzStyle: 'styleRules', pzCustom: 'customPrompt', pzUser: 'userName', pzAlias: 'userAlias', pzProfile: 'userProfile' };
  Object.entries(fields).forEach(([id, key]) => {
    const el = $(id);
    el.addEventListener('change', async () => {
      persona = await window.xw.personaSet({ [key]: el.value });
      setToast('已保存');
    });
  });

  const addMem = async () => {
    const v = $('memInput').value.trim();
    if (!v) return;
    await window.xw.memoryAdd({ content: v, category: 'fact', source: 'user' });
    $('memInput').value = '';
    fillPersona();
  };
  $('memAddBtn').addEventListener('click', addMem);
  $('memInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addMem(); });
  $('memClear').addEventListener('click', async () => {
    if (!confirm('确定清空全部长期记忆？')) return;
    await window.xw.memoryClear();
    fillPersona();
  });
}

async function fillPersona() {
  persona = await window.xw.personaGet();
  const map = { pzName: 'assistantName', pzRole: 'assistantRole', pzTraits: 'assistantTraits', pzStyle: 'styleRules', pzCustom: 'customPrompt', pzUser: 'userName', pzAlias: 'userAlias', pzProfile: 'userProfile' };
  Object.entries(map).forEach(([id, key]) => { const el = $(id); if (el) el.value = persona[key] || ''; });

  const list = await window.xw.memoryList();
  $('memCount').textContent = list.length;
  const box = $('memList');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="empty">还没有记忆。让小问记住点什么吧。</div>';
    return;
  }
  [...list].reverse().forEach((m) => {
    const row = document.createElement('div');
    row.className = 'mem-item';
    const txt = document.createElement('div');
    txt.className = 'mem-text';
    txt.textContent = m.content;
    const tag = document.createElement('span');
    tag.className = 'mem-tag';
    tag.textContent = m.category || 'fact';
    const del = document.createElement('button');
    del.textContent = '删除';
    del.onclick = async () => { await window.xw.memoryRemove(m.id); fillPersona(); };
    row.appendChild(txt);
    row.appendChild(tag);
    row.appendChild(del);
    box.appendChild(row);
  });
}

// ---------- Agent ----------
function bindAgent() {
  const toggles = { agEnabled: 'agentEnabled', agUseTools: 'agentUseTools', agUseMcp: 'agentUseMcp', agUseSkills: 'agentUseSkills', agUseMemory: 'agentUseMemory' };
  Object.entries(toggles).forEach(([id, key]) => {
    $(id).addEventListener('change', async () => {
      cfg = await window.xw.setConfig({ [key]: $(id).checked });
      setToast('已保存');
    });
  });
  $('agConfirm').addEventListener('change', async () => {
    await window.xw.toolsSettingsSet({ confirmMode: $('agConfirm').value });
  });
  $('agTimeout').addEventListener('change', async () => {
    await window.xw.toolsSettingsSet({ shellTimeoutMs: Number($('agTimeout').value) * 1000 });
  });
  $('agPaths').addEventListener('change', async () => {
    const arr = $('agPaths').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    await window.xw.toolsSettingsSet({ allowPaths: arr });
  });

  // ---- 子代理编排 ----
  const orchToggles = {
    orchEnabled: 'orchEnabled',
    orchAutoDelegate: 'orchAutoDelegate',
    orchReview: 'orchReview'
  };
  Object.entries(orchToggles).forEach(([id, key]) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', async () => {
      cfg = await window.xw.setConfig({ [key]: el.checked });
      setToast('已保存');
    });
  });
  const orchNums = {
    orchMaxTasks: 'orchMaxTasks',
    orchMaxWorkers: 'orchMaxWorkers',
    orchRetry: 'orchRetry'
  };
  Object.entries(orchNums).forEach(([id, key]) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', async () => {
      const n = Number(el.value);
      cfg = await window.xw.setConfig({ [key]: isNaN(n) ? undefined : n });
      setToast('已保存');
    });
  });
}

async function fillAgent() {
  $('agEnabled').checked = cfg.agentEnabled !== false;
  $('agUseTools').checked = cfg.agentUseTools !== false;
  $('agUseMcp').checked = cfg.agentUseMcp !== false;
  $('agUseSkills').checked = cfg.agentUseSkills !== false;
  $('agUseMemory').checked = cfg.agentUseMemory !== false;

  const s = await window.xw.toolsSettingsGet();
  $('agConfirm').value = s.confirmMode || 'danger';
  $('agTimeout').value = Math.round((s.shellTimeoutMs || 30000) / 1000);
  $('agPaths').value = (s.allowPaths || []).join('\n');

  // 子代理编排
  const chk = (id, v) => { const el = $(id); if (el) el.checked = !!v; };
  const num = (id, v) => { const el = $(id); if (el) el.value = v; };
  chk('orchEnabled', cfg.orchEnabled !== false);
  chk('orchAutoDelegate', cfg.orchAutoDelegate !== false);
  chk('orchReview', cfg.orchReview !== false);
  num('orchMaxTasks', Number(cfg.orchMaxTasks) || 6);
  num('orchMaxWorkers', Number(cfg.orchMaxWorkers) || 2);
  num('orchRetry', Number(cfg.orchRetry) === undefined ? 1 : Number(cfg.orchRetry));

  const tools = await window.xw.toolsList();
  const box = $('toolList');
  box.innerHTML = '';
  tools.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'tool-row' + (t.danger ? ' danger' : '');
    row.innerHTML = `<div><b>${escapeHtml(t.name)}</b><div class="tool-desc">${escapeHtml(t.description || '')}</div></div>`;
    box.appendChild(row);
  });
}

// ---------- MCP ----------
function bindMcp() {
  $('mcpTransport').addEventListener('change', () => {
    const isStdio = $('mcpTransport').value === 'stdio';
    document.querySelectorAll('.mcp-stdio').forEach((e) => (e.style.display = isStdio ? '' : 'none'));
    document.querySelectorAll('.mcp-http').forEach((e) => (e.style.display = isStdio ? 'none' : ''));
  });

  $('mcpAddBtn').addEventListener('click', async () => {
    const transport = $('mcpTransport').value;
    const cfgItem = {
      name: $('mcpName').value.trim() || 'mcp-server',
      transport,
      command: $('mcpCommand').value.trim(),
      args: $('mcpArgs').value.trim() ? $('mcpArgs').value.trim().split(/\s+/) : [],
      url: $('mcpUrl').value.trim(),
      enabled: true
    };
    if (transport === 'stdio' && !cfgItem.command) return setToast('请填写启动命令');
    if (transport === 'http' && !cfgItem.url) return setToast('请填写服务地址');
    setToast('正在连接…');
    await window.xw.mcpAdd(cfgItem);
    $('mcpName').value = '';
    $('mcpCommand').value = '';
    $('mcpArgs').value = '';
    $('mcpUrl').value = '';
    fillMcp();
  });
}

async function fillMcp() {
  const [servers, status] = await Promise.all([window.xw.mcpList(), window.xw.mcpStatus()]);
  const box = $('mcpList');
  box.innerHTML = '';
  if (!servers.length) {
    box.innerHTML = '<div class="empty">还没有配置 MCP 服务器</div>';
  }
  servers.forEach((s) => {
    const live = status.find((x) => x.id === s.id);
    const row = document.createElement('div');
    row.className = 'mcp-item' + (live && live.connected ? ' online' : '');
    const info = document.createElement('div');
    info.innerHTML = `<b>${escapeHtml(s.name)}</b>
      <div class="mcp-meta">${s.transport === 'http' ? escapeHtml(s.url || '') : escapeHtml([s.command, ...(s.args || [])].join(' '))}</div>
      <div class="mcp-meta">${live && live.connected ? `已连接 · ${live.toolCount} 个工具` : (live && live.lastError ? escapeHtml(String(live.lastError).slice(0, 120)) : '未连接')}</div>`;
    const ops = document.createElement('div');
    ops.className = 'mcp-ops';
    const cbtn = document.createElement('button');
    cbtn.textContent = live && live.connected ? '断开' : '连接';
    cbtn.onclick = async () => {
      if (live && live.connected) await window.xw.mcpDisconnect(s.id);
      else {
        const r = await window.xw.mcpConnect(s.id);
        if (r && r.ok === false) setToast('连接失败：' + r.error);
      }
      fillMcp();
    };
    const dbtn = document.createElement('button');
    dbtn.textContent = '删除';
    dbtn.className = 'danger-text';
    dbtn.onclick = async () => { await window.xw.mcpRemove(s.id); fillMcp(); };
    ops.appendChild(cbtn);
    ops.appendChild(dbtn);
    row.appendChild(info);
    row.appendChild(ops);
    box.appendChild(row);
  });
  $('mcpStatus').textContent = `已连接 ${status.filter((s) => s.connected).length} / ${servers.length} 个服务器`;
}

// ---------- Skills ----------
function bindSkills() {
  $('skillOpenDir').addEventListener('click', () => window.xw.skillsOpenDir());
  $('skillSaveBtn').addEventListener('click', async () => {
    const id = $('skillId').value.trim();
    const name = $('skillName').value.trim();
    if (!id && !name) return setToast('请填写技能 id 或名称');
    await window.xw.skillsSave({
      id: id || name,
      name: name || id,
      description: $('skillDesc').value.trim(),
      content: $('skillBody').value
    });
    $('skillId').value = ''; $('skillName').value = ''; $('skillDesc').value = ''; $('skillBody').value = '';
    fillSkills();
    setToast('技能已保存');
  });
}

async function fillSkills() {
  const list = await window.xw.skillsList();
  const box = $('skillList');
  box.innerHTML = '';
  if (!list.length) box.innerHTML = '<div class="empty">还没有技能</div>';
  list.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'skill-item';
    row.innerHTML = `<div><b>${escapeHtml(s.name)}</b> <span class="skill-id">${escapeHtml(s.id)}</span>
      <div class="skill-desc">${escapeHtml(s.description || '')}</div></div>`;
    const del = document.createElement('button');
    del.textContent = '删除';
    del.className = 'danger-text';
    del.onclick = async () => { await window.xw.skillsDelete(s.id); fillSkills(); };
    row.appendChild(del);
    box.appendChild(row);
  });
}

// ---------- 语音 ----------
let voiceCatalog = { dashscope: {}, openai: [] };

function bindVoice() {
  const toggle = () => {
    const on = $('stAsrProvider').value === 'dashscope';
    $('stAsrDashBlock').style.display = on ? '' : 'none';
  };
  $('stAsrProvider').addEventListener('change', toggle);
  $('stAsrKeyToggle').addEventListener('click', () => {
    const el = $('stAsrKey');
    const isPwd = el.type === 'password';
    el.type = isPwd ? 'text' : 'password';
    $('stAsrKeyToggle').textContent = isPwd ? '隐藏' : '显示';
  });
  $('stAsrKey').addEventListener('input', () => { $('stAsrKey').dataset.keep = '0'; });
  $('stAsrSilence').addEventListener('input', () => {
    $('stAsrSilenceVal').textContent = (Number($('stAsrSilence').value) / 1000).toFixed(1) + 's';
  });
  $('stAsrKeyLink').addEventListener('click', (e) => {
    e.preventDefault();
    window.xw.openExternal('https://bailian.console.aliyun.com/');
  });

  $('stAsrTest').addEventListener('click', async () => {
    const keyInput = $('stAsrKey').value.trim();
    const apiKey = $('stAsrKey').dataset.keep === '1' ? '__KEEP__' : (keyInput || '__KEEP__');
    if ($('stAsrProvider').value !== 'dashscope') {
      return showAsrTest('系统内置识别依赖云端服务，无法离线测试，请直接试用语音输入', 'err');
    }
    showAsrTest('正在测试…', 'loading');
    try {
      const res = await window.xw.asrTest({ apiKey, model: $('stAsrModel').value.trim() });
      if (res && res.ok) showAsrTest(res.text || '连接成功 ✓', 'ok');
      else showAsrTest('失败：' + ((res && res.error) || '未知错误'), 'err');
    } catch (e) {
      showAsrTest('失败：' + e.message, 'err');
    }
  });

  $('stTtsProvider').addEventListener('change', toggleTtsBlocks);
  $('stTtsDashModel').addEventListener('change', fillCosyVoices);
  $('stTtsKeyToggle').addEventListener('click', () => {
    const el = $('stTtsKey');
    const isPwd = el.type === 'password';
    el.type = isPwd ? 'text' : 'password';
    $('stTtsKeyToggle').textContent = isPwd ? '隐藏' : '显示';
  });
  $('stTtsKey').addEventListener('input', () => { $('stTtsKey').dataset.keep = '0'; });
  $('stTtsRate').addEventListener('input', () => {
    $('stRateVal').textContent = (1 + Number($('stTtsRate').value) / 10).toFixed(1) + 'x';
  });
  $('stTtsVolume').addEventListener('input', () => ($('stVolumeVal').textContent = $('stTtsVolume').value + '%'));

  $('stTestVoice').addEventListener('click', async () => {
    const provider = $('stTtsProvider').value;
    const text = '你好主人，我是小问，这是语音朗读效果。';
    if (provider === 'web') {
      speech.speak(text, {
        rate: 1 + Number($('stTtsRate').value) / 10,
        volume: Number($('stTtsVolume').value) / 100,
        voiceName: $('stVoice').value
      });
      return;
    }
    $('stTtsTestResult').textContent = '正在合成…';
    $('stTtsTestResult').className = 'test-result show loading';
    try {
      // 先用界面上未保存的值测，测完不影响已保存配置
      const r = await window.xw.ttsTest({
        provider,
        apiKey: $('stTtsKey').value.trim() || undefined,
        model: $('stTtsDashModel').value,
        voice: $('stTtsDashVoice').value,
        baseUrl: $('stTtsOpenaiUrl').value.trim() || undefined
      });
      if (r && r.ok && r.file) {
        await playAudioFile(r.file);
        $('stTtsTestResult').textContent = `合成成功 ✓ ${Math.round(r.bytes / 1024)} KB`;
        $('stTtsTestResult').className = 'test-result show ok';
      } else {
        $('stTtsTestResult').textContent = '失败：' + ((r && r.error) || '未知错误');
        $('stTtsTestResult').className = 'test-result show err';
      }
    } catch (e) {
      $('stTtsTestResult').textContent = '失败：' + e.message;
      $('stTtsTestResult').className = 'test-result show err';
    }
  });

  bindWake();
}

// ---------- 语音唤醒 ----------
// 唤醒监听跑在悬浮球窗口，界面改动必须立刻落盘并广播过去才生效，
// 所以这里每次改动都直接 setConfig，而不是等顶部「保存」。
function parseWakeWords() {
  const raw = ($('stWakeWords').value || '').trim();
  const list = raw.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_WAKE_WORDS;
}

async function pushWakePatch() {
  try {
    cfg = await window.xw.setConfig({
      wakeEnabled: $('stWakeEnabled').checked,
      wakeWords: parseWakeWords(),
      wakeSensitivity: Number($('stWakeSens').value) || 60,
      wakeSound: $('stWakeSound').checked
    });
  } catch (e) {
    /* ignore */
  }
  syncWakeBlock();
}

function syncWakeBlock() {
  const on = !!$('stWakeEnabled').checked;
  $('stWakeBlock').classList.toggle('off', !on);
  const res = $('stWakeResult');
  if (!res) return;
  if (on) {
    // 唤醒复用语音识别的通道，没配百炼 Key 就必然唤不醒，这里提前说清楚
    const hasKey = !!cfg.asrApiKeyMasked;
    res.textContent = hasKey
      ? '已开启 · 悬浮球会有一圈青色微光，表示正在聆听'
      : '⚠ 还没配置百炼 API Key，唤醒无法工作，请先在上面的识别设置里填好';
    res.className = 'test-result show ' + (hasKey ? 'ok' : 'err');
  } else {
    res.textContent = '';
    res.className = 'test-result';
  }
}

function bindWake() {
  $('stWakeEnabled').addEventListener('change', pushWakePatch);
  $('stWakeSound').addEventListener('change', pushWakePatch);
  // 关键词与灵敏度松开手再提交，避免拖动时刷屏写盘
  $('stWakeWords').addEventListener('change', pushWakePatch);
  $('stWakeSens').addEventListener('input', () => {
    $('stWakeSensVal').textContent = $('stWakeSens').value;
  });
  $('stWakeSens').addEventListener('change', pushWakePatch);
}

function toggleTtsBlocks() {
  const v = $('stTtsProvider').value;
  $('ttsWebBlock').style.display = v === 'web' ? '' : 'none';
  $('ttsDashBlock').style.display = v === 'dashscope' ? '' : 'none';
  $('ttsOpenaiBlock').style.display = v === 'openai' ? '' : 'none';
}

function fillCosyVoices() {
  const model = $('stTtsDashModel').value;
  const list = (voiceCatalog.dashscope && voiceCatalog.dashscope[model]) || [];
  const sel = $('stTtsDashVoice');
  sel.innerHTML = '';
  list.forEach((v) => {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.name;
    sel.appendChild(o);
  });
  if (cfg.ttsDashVoice) sel.value = cfg.ttsDashVoice;
}

function fillSystemVoices() {
  const list = speech.getVoices();
  const sel = $('stVoice');
  if (!list.length) return;
  sel.innerHTML = '<option value="">自动选择（推荐）</option>';
  list.forEach((v) => {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = `${v.name} · ${v.lang}${v.localService ? ' (本地)' : ''}`;
    sel.appendChild(o);
  });
  sel.value = cfg.ttsVoice || '';
}

async function fillVoice() {
  $('stAsrProvider').value = cfg.asrProvider || 'dashscope';
  $('stAsrDashBlock').style.display = cfg.asrProvider === 'system' ? 'none' : '';
  const hasAsrKey = !!cfg.asrApiKeyMasked;
  $('stAsrKey').value = '';
  $('stAsrKey').placeholder = hasAsrKey
    ? `已配置：${cfg.asrApiKeyMasked}（留空保持不变）`
    : 'sk-... 请粘贴百炼 API Key';
  $('stAsrKey').dataset.keep = hasAsrKey ? '1' : '0';
  $('stAsrModel').value = cfg.asrModel || 'paraformer-realtime-v2';
  const sil = cfg.asrSilenceMs ?? 2000;
  $('stAsrSilence').value = sil;
  $('stAsrSilenceVal').textContent = (sil / 1000).toFixed(1) + 's';

  // 语音唤醒
  const words = Array.isArray(cfg.wakeWords) && cfg.wakeWords.length
    ? cfg.wakeWords
    : DEFAULT_WAKE_WORDS;
  $('stWakeEnabled').checked = !!cfg.wakeEnabled;
  $('stWakeWords').value = words.join(', ');
  const sens = cfg.wakeSensitivity ?? 60;
  $('stWakeSens').value = sens;
  $('stWakeSensVal').textContent = String(sens);
  $('stWakeSound').checked = cfg.wakeSound !== false;
  syncWakeBlock();

  // TTS
  try { voiceCatalog = await window.xw.ttsVoices(); } catch (e) { voiceCatalog = { dashscope: {}, openai: [] }; }
  $('stTtsProvider').value = cfg.ttsProvider || 'web';
  $('stTtsEnabled').checked = cfg.ttsEnabled !== false;
  $('stTtsRate').value = cfg.ttsRate || 0;
  $('stRateVal').textContent = (1 + (cfg.ttsRate || 0) / 10).toFixed(1) + 'x';
  $('stTtsVolume').value = cfg.ttsVolume ?? 100;
  $('stVolumeVal').textContent = (cfg.ttsVolume ?? 100) + '%';

  $('stTtsDashModel').value = cfg.ttsDashModel || 'cosyvoice-v2';
  fillCosyVoices();
  $('stTtsDashFormat').value = cfg.ttsDashFormat || 'mp3';
  const hasTtsKey = !!cfg.ttsApiKeyMasked;
  $('stTtsKey').value = '';
  $('stTtsKey').placeholder = hasTtsKey ? `已配置：${cfg.ttsApiKeyMasked}（留空则复用识别 Key）` : '留空则复用上面的百炼 Key';
  $('stTtsKey').dataset.keep = hasTtsKey ? '1' : '0';

  $('stTtsOpenaiUrl').value = cfg.ttsOpenaiBaseUrl || '';
  $('stTtsOpenaiModel').value = cfg.ttsOpenaiModel || 'tts-1';
  const osel = $('stTtsOpenaiVoice');
  osel.innerHTML = '';
  (voiceCatalog.openai || []).forEach((v) => {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.name;
    osel.appendChild(o);
  });
  osel.value = cfg.ttsOpenaiVoice || 'alloy';

  toggleTtsBlocks();
  fillSystemVoices();
  setTimeout(fillSystemVoices, 700);
}

function showAsrTest(msg, type) {
  const el = $('stAsrTestResult');
  el.textContent = msg;
  el.className = 'test-result show ' + type;
}

// ---------- 桌面宠物 ----------
const PET_META = [
  { id: 'penguin', name: '企鹅', emoji: '🐧' },
  { id: 'cat', name: '橘猫', emoji: '🐱' },
  { id: 'panda', name: '熊猫', emoji: '🐼' },
  { id: 'rabbit', name: '兔子', emoji: '🐰' },
  { id: 'shiba', name: '柴犬', emoji: '🐶' },
  { id: 'frog', name: '青蛙', emoji: '🐸' }
];

function bindPet() {
  const picker = $('stPetPicker');
  const renderPicker = (cur) => {
    picker.innerHTML = '';
    PET_META.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pet-chip' + (a.id === cur ? ' active' : '');
      b.innerHTML = `<span class="pet-chip-ico">${a.emoji}</span><span>${a.name}</span>`;
      b.onclick = async () => {
        await window.xw.setConfig({ petAnimal: a.id });
        renderPicker(a.id);
        setToast(`已切换到${a.name}`);
      };
      picker.appendChild(b);
    });
  };
  renderPicker(cfg.petAnimal || 'penguin');

  const on = $('stPetEnabled');
  on.checked = cfg.petEnabled !== false;
  on.addEventListener('change', async () => {
    cfg = await window.xw.setConfig({ petEnabled: on.checked });
    setToast(on.checked ? '宠物已出现' : '宠物已隐藏');
  });

  const size = $('stPetSize');
  const sizeVal = $('stPetSizeVal');
  size.value = Number(cfg.petSize) || 120;
  sizeVal.textContent = size.value + 'px';
  size.addEventListener('input', () => (sizeVal.textContent = size.value + 'px'));
  size.addEventListener('change', async () => {
    cfg = await window.xw.setConfig({ petSize: Number(size.value) });
  });

  const op = $('stPetOpacity');
  const opVal = $('stPetOpacityVal');
  op.value = Math.round((Number(cfg.petOpacity) || 1) * 100);
  opVal.textContent = op.value + '%';
  op.addEventListener('input', () => (opVal.textContent = op.value + '%'));
  op.addEventListener('change', async () => {
    cfg = await window.xw.setConfig({ petOpacity: Number(op.value) / 100 });
  });

  ['stPetTop', 'stPetWalk', 'stPetInteraction', 'stPetAgentLink'].forEach((id) => {
    const el = $(id);
    const key = id.replace('stPet', 'pet');
    el.checked = cfg[key] !== false;
    el.addEventListener('change', async () => {
      cfg = await window.xw.setConfig({ [key]: el.checked });
    });
  });

  // 统一的显示 / 隐藏：走 petEnabled 配置，保证「配置 = 实际状态」，重启也一致
  $('stPetToggle').addEventListener('click', async () => {
    const next = cfg.petEnabled === false;
    cfg = await window.xw.setConfig({ petEnabled: next });
    on.checked = next;
    setToast(next ? '宠物已出现' : '宠物已隐藏');
    refreshPetDiag();
  });

  $('stPetRescue').addEventListener('click', async () => {
    try {
      await window.xw.setConfig({ petEnabled: true });
      cfg = await window.xw.getConfig();
      on.checked = true;
      await window.xw.petRescue();
      setToast('宠物已叫回主屏右下角');
    } catch (e) {
      setToast('叫回失败：' + ((e && e.message) || e));
    }
    refreshPetDiag();
  });

  $('stPetFeed').addEventListener('click', async () => {
    try {
      const s = await window.xw.petStateGet();
      await window.xw.petStateSave({
        ...s,
        hunger: Math.min(100, (s.hunger ?? 70) + 20),
        mood: Math.min(100, (s.mood ?? 80) + 6)
      });
      window.xw.petSay && window.xw.petSay('谢谢主人！');
      setToast('喂了一口，饱食 +20');
    } catch (e) {
      setToast('喂食失败：' + e.message);
    }
  });

  $('stPetReset').addEventListener('click', async () => {
    if (!confirm('确定重置宠物的等级、心情和饱食度？')) return;
    await window.xw.petStateSave({
      animal: cfg.petAnimal || 'penguin',
      mood: 80, hunger: 70, level: 1, exp: 0,
      lastSeen: Date.now(), autoWalk: false, sleeping: false
    });
    setToast('成长数据已重置');
  });

  refreshPetDiag();
}

/** 把宠物窗口的真实状态显示出来，便于判断「到底是隐藏了还是被顶到屏幕外」 */
async function refreshPetDiag() {
  const el = $('stPetDiag');
  if (!el || !window.xw.petDiag) return;
  try {
    const d = await window.xw.petDiag();
    if (!d || !d.exists) {
      el.textContent = '宠物窗口状态：未创建' + (d && d.enabled === false ? '（设置里是关闭的）' : '');
      return;
    }
    el.textContent = `宠物窗口状态：${d.visible ? '可见' : '已隐藏'} · 位置 ${d.pos.join(', ')} · 尺寸 ${d.size.join('×')}`
      + (d.size[1] !== d.expectedHeight ? `（应为 ${d.expectedHeight}，可点「叫回主屏」修正）` : '');
  } catch (e) {
    el.textContent = '宠物窗口状态：读取失败 ' + ((e && e.message) || e);
  }
}

// ---------- 系统托盘 ----------
function bindTray() {
  const btn = $('stTrayReload');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '正在重新载入…';
    try {
      const d = await window.xw.trayReload();
      renderTrayDiag(d);
      if (d && d.exists && !d.iconEmpty) setStatus('托盘图标已重新载入');
      else setStatus('托盘已重建，但图标仍是空的，请看下方提示');
    } catch (e) {
      setStatus('重新载入托盘失败：' + ((e && e.message) || e));
    } finally {
      btn.disabled = false;
      btn.textContent = '重新载入托盘图标';
    }
  });
}

function renderTrayDiag(d) {
  const el = $('stTrayDiag');
  if (!el) return;
  if (!d) { el.textContent = '托盘状态：读取失败'; return; }
  if (!d.exists) { el.textContent = '托盘状态：未创建'; return; }
  const size = d.iconSize ? `${d.iconSize.width}×${d.iconSize.height}` : '—';
  el.textContent = d.iconEmpty
    ? '托盘状态：⚠️ 图标为空，右下角会看不见（请重新载入；若仍为空说明图标资源丢失）'
    : `托盘状态：正常 · 图标 ${size} · 来源 ${d.source}`;
}

async function refreshTrayDiag() {
  if (!window.xw.trayDiag) return;
  try { renderTrayDiag(await window.xw.trayDiag()); } catch (e) { /* ignore */ }
}

// ---------- 定时任务 ----------
let schCache = [];

function buildWeekdayPicker() {
  const box = $('schDays');
  if (!box || box.childElementCount) return;
  const names = ['日', '一', '二', '三', '四', '五', '六'];
  box.innerHTML = names.map((n, i) =>
    `<label class="wd"><input type="checkbox" value="${i}" /><span>${n}</span></label>`).join('');
}

function syncSchRows() {
  const f = $('schFreq').value;
  $('schTimeRow').style.display = (f === 'daily' || f === 'weekly' || f === 'monthly') ? '' : 'none';
  $('schDaysRow').style.display = f === 'weekly' ? '' : 'none';
  $('schDayRow').style.display = f === 'monthly' ? '' : 'none';
  $('schEveryRow').style.display = f === 'interval' ? '' : 'none';
  $('schDateRow').style.display = f === 'once' ? '' : 'none';
}

/** 表单 → when 对象（交给主进程 normalizeWhen 再兜一层） */
function schWhenFromForm() {
  const f = $('schFreq').value;
  const time = $('schTime').value || '08:30';
  if (f === 'daily') return { type: 'daily', time };
  if (f === 'weekly') {
    const days = Array.from(document.querySelectorAll('#schDays input:checked')).map((x) => Number(x.value));
    return { type: 'weekly', time, days: days.length ? days : [new Date().getDay()] };
  }
  if (f === 'monthly') return { type: 'monthly', time, day: Number($('schDay').value) || 1 };
  if (f === 'interval') return { type: 'interval', minutes: Number($('schEvery').value) || 30 };
  if (f === 'once') {
    const v = $('schDate').value;
    if (!v) return null;
    return { type: 'once', at: v.replace('T', ' ') };
  }
  return null;
}

function bindSchedule() {
  buildWeekdayPicker();
  $('schFreq').addEventListener('change', syncSchRows);
  syncSchRows();

  $('schEnabled').addEventListener('change', async () => {
    cfg = await window.xw.setConfig({ schedEnabled: $('schEnabled').checked });
    setToast($('schEnabled').checked ? '定时任务已开启' : '定时任务已暂停');
  });

  $('schAdd').addEventListener('click', async () => {
    const title = $('schTitle').value.trim();
    const prompt = $('schPrompt').value.trim();
    if (!prompt) { setToast('请先写「要做什么」'); return; }
    const when = schWhenFromForm();
    if (!when) { setToast('请选好执行时间'); return; }
    const r = await window.xw.scheduleAdd({ title, prompt, when, wake: $('schWake').checked });
    if (!r || r.ok === false) { setToast('添加失败：' + ((r && r.error) || '未知原因')); return; }
    $('schTitle').value = '';
    $('schPrompt').value = '';
    setToast(`已添加「${r.task.title}」，${r.task.whenText}`);
    fillSchedule();
  });

  $('schPreset').addEventListener('click', async () => {
    const presets = await window.xw.schedulePresets();
    if (!presets || !presets.length) return;
    const names = presets.map((p, i) => `${i + 1}. ${p.title}（${p.whenText}）`).join('\n');
    const pick = prompt('想加哪个模板？输入序号：\n' + names, '1');
    const idx = Number(pick) - 1;
    if (!(idx >= 0 && idx < presets.length)) return;
    const r = await window.xw.scheduleAddPreset(presets[idx].key);
    setToast(r && r.ok ? `已添加「${presets[idx].title}」` : ('添加失败：' + ((r && r.error) || '')));
    fillSchedule();
  });
}

async function fillSchedule() {
  const box = $('schList');
  if (!box) return;
  if ($('schEnabled')) $('schEnabled').checked = cfg.schedEnabled !== false;
  let list = [];
  try { list = await window.xw.scheduleList(); } catch (e) { list = []; }
  schCache = list;

  if (!list.length) {
    box.innerHTML = '<div class="hint">还没有任务。点上面「加一个常用模板」就能立刻有「每日早报 / 久坐提醒 / 收盘复盘」。</div>';
    return;
  }

  box.innerHTML = list.map((t) => `
    <div class="sched-item${t.enabled === false ? ' off' : ''}">
      <div class="sched-main">
        <div class="sched-title">${escapeHtml(t.title)}${t.source === 'ai' ? '<span class="tag-ai">小问自排</span>' : ''}</div>
        <div class="sched-meta">${escapeHtml(t.whenText)} · ${escapeHtml(t.etaText)}${t.runCount ? ` · 已执行 ${t.runCount} 次` : ''}</div>
        <div class="sched-prompt">${escapeHtml(String(t.prompt || '').slice(0, 90))}</div>
      </div>
      <div class="sched-ops">
        <button class="btn-mini" data-act="run" data-id="${t.id}">跑一次</button>
        <button class="btn-mini" data-act="toggle" data-id="${t.id}">${t.enabled === false ? '启用' : '暂停'}</button>
        <button class="btn-mini danger" data-act="del" data-id="${t.id}">删除</button>
      </div>
    </div>`).join('');

  box.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      const item = schCache.find((x) => x.id === id);
      if (act === 'run') {
        setToast('正在执行，结果会主动播报给你…');
        const r = await window.xw.scheduleRun(id);
        setToast(r && r.ok ? '执行完成' : `执行失败：${(r && (r.error || r.text)) || '未知原因'}`);
      } else if (act === 'toggle') {
        await window.xw.scheduleUpdate(id, { enabled: item ? item.enabled === false : true });
      } else if (act === 'del') {
        if (!confirm(`删除定时任务「${item ? item.title : id}」？`)) return;
        await window.xw.scheduleRemove(id);
      }
      fillSchedule();
    });
  });
}

// ---------- 主动关注 ----------
function bindWatch() {
  $('wMag').addEventListener('input', () => { $('wMagVal').textContent = Number($('wMag').value).toFixed(1); });
  $('wTop').addEventListener('input', () => { $('wTopVal').textContent = $('wTop').value; });

  const keys = [
    ['wEnabled', 'watchEnabled'], ['wQuake', 'watchQuake'], ['wHot', 'watchHot'],
    ['wWeibo', 'watchWeibo'], ['wPet', 'watchPet'], ['wSpeak', 'watchSpeak'],
    ['wOpen', 'watchOpenPanel']
  ];
  keys.forEach(([id, key]) => {
    $(id).addEventListener('change', async () => {
      cfg = await window.xw.setConfig({ [key]: $(id).checked });
      fillWatch();
    });
  });

  const numeric = [
    ['wMag', 'watchQuakeMinMag', (v) => Number(v)],
    ['wQuakeIv', 'watchQuakeInterval', (v) => Number(v) || 5],
    ['wHotIv', 'watchHotInterval', (v) => Number(v) || 30],
    ['wTop', 'watchHotTop', (v) => Number(v) || 5]
  ];
  numeric.forEach(([id, key, cast]) => {
    $(id).addEventListener('change', async () => { cfg = await window.xw.setConfig({ [key]: cast($(id).value) }); });
  });

  $('wRegion').addEventListener('change', async () => { cfg = await window.xw.setConfig({ watchQuakeRegion: $('wRegion').value }); });
  $('wKeywords').addEventListener('change', async () => { cfg = await window.xw.setConfig({ watchKeywords: $('wKeywords').value.trim() }); });
  $('wMute').addEventListener('change', async () => { cfg = await window.xw.setConfig({ watchMute: $('wMute').value.trim() }); });

  $('wCheckQuake').addEventListener('click', async () => {
    setToast('正在检查地震…');
    const r = await window.xw.watchCheck('quake');
    setToast(r && r.ok ? `检查完成${r.count ? `，新消息 ${r.count} 条` : '（没有新消息）'}` : '检查失败，看日志');
    fillWatch();
  });
  $('wCheckHot').addEventListener('click', async () => {
    setToast('正在检查热搜…');
    const r = await window.xw.watchCheck('hot');
    setToast(r && r.ok ? `检查完成${r.count ? `，新上榜 ${r.count} 条` : '（没有新上榜）'}` : '检查失败，看日志');
    fillWatch();
  });
}

function fillWatch() {
  const set = (id, v) => { const el = $(id); if (el) el.checked = v === true; };
  set('wEnabled', cfg.watchEnabled !== false);
  set('wQuake', cfg.watchQuake !== false);
  set('wHot', cfg.watchHot !== false);
  set('wWeibo', cfg.watchWeibo === true);
  set('wPet', cfg.watchPet !== false);
  set('wSpeak', cfg.watchSpeak === true);
  set('wOpen', cfg.watchOpenPanel === true);
  $('wMag').value = Number(cfg.watchQuakeMinMag) || 5;
  $('wMagVal').textContent = Number($('wMag').value).toFixed(1);
  $('wQuakeIv').value = Number(cfg.watchQuakeInterval) || 5;
  $('wHotIv').value = Number(cfg.watchHotInterval) || 30;
  $('wTop').value = Number(cfg.watchHotTop) || 5;
  $('wTopVal').textContent = $('wTop').value;
  $('wRegion').value = cfg.watchQuakeRegion === 'global' ? 'global' : 'cn';
  $('wKeywords').value = cfg.watchKeywords || '';
  $('wMute').value = cfg.watchMute == null ? '23:00-07:00' : cfg.watchMute;
  refreshWatchStatus();
}

async function refreshWatchStatus() {
  const el = $('wStatus');
  if (!el || !window.xw.watchStatus) return;
  try {
    const s = await window.xw.watchStatus();
    const fmt = (ts) => (ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '尚未检查');
    el.textContent = `状态：地震${s.quake.on ? '已开启' : '已关闭'}（上次检查 ${fmt(s.quake.lastPoll)}）`
      + ` · 热搜${s.hot.on ? '已开启' : '已关闭'}（上次检查 ${fmt(s.hot.lastPoll)}）`
      + (s.quiet ? ` · 当前处于静默时段（${s.quietRange}）` : '');
  } catch (e) {
    el.textContent = '状态：读取失败';
  }
}

// ---------- 主进程主动播报（定时任务 / 地震 / 热搜） ----------
function bindProactive() {
  try {
    window.xw.onProactive((p) => {
      if (!p || !p.text) return;
      try { addMessageBubble('assistant', `**${p.title || '小问提醒'}**\n\n${p.text}`, { animate: true }); } catch (e) { /* ignore */ }
      scrollToBottom();
      setStatus(p.title || '小问提醒');
      if (p.speak) { try { speakText(p.text); } catch (e) { /* ignore */ } }
      // 面板是后来才打开的：靠会话历史补齐，这里只保证当前显示不丢
    });
  } catch (e) { /* ignore */ }
}

// ---------- 高级 ----------
function bindAdvanced() {
  $('stGpuDisabled').addEventListener('change', async () => {
    await window.xw.gpuSetDisabled($('stGpuDisabled').checked);
    const tip = $('stGpuDisabled').checked
      ? '已设置：下次启动将禁用硬件加速。点下方「立即重启程序」生效。'
      : '已设置：下次启动恢复硬件加速。点下方「立即重启程序」生效。';
    $('stGpuStatus').textContent = tip;
    $('stGpuStatus').className = 'gpu-status warn';
  });
  $('stRestart').addEventListener('click', () => window.xw.gpuRestart());
  $('stOpenData').addEventListener('click', () => window.xw.openUserData());
  $('stClearHistory').addEventListener('click', async () => {
    if (!confirm('确定清空所有对话历史？')) return;
    await window.xw.clearHistory();
    for (const s of (await window.xw.sessionList()).sessions) await window.xw.sessionDelete(s.id);
    setToast('已清空');
  });
}

async function refreshGpuStatus() {
  try {
    const st = await window.xw.gpuStatus();
    const enabled = st.hardwareAcceleration;
    $('stGpuDisabled').checked = !enabled;
    let txt = enabled ? '当前：硬件加速已启用（推荐）' : `当前：已禁用硬件加速\n原因：${st.reason}`;
    if (st.gpuFeatureStatus && st.gpuFeatureStatus.gpu_compositing) {
      txt += `\nGPU 合成：${st.gpuFeatureStatus.gpu_compositing}`;
    }
    $('stGpuStatus').textContent = txt;
    $('stGpuStatus').className = 'gpu-status ' + (enabled ? 'ok' : 'warn');
  } catch (e) {
    $('stGpuStatus').textContent = '无法获取状态：' + e.message;
    $('stGpuStatus').className = 'gpu-status warn';
  }
}

// ================== 截图（附件 / 快捷键结果） ==================
function renderAttach() {
  if (!els.attachBar) return;
  els.attachBar.innerHTML = '';
  if (!pendingShots.length) { els.attachBar.style.display = 'none'; return; }
  els.attachBar.style.display = 'flex';
  pendingShots.forEach((shot, i) => {
    const d = document.createElement('div');
    d.className = 'attach-item';
    d.innerHTML = '<img alt="截图" /><button class="attach-del" title="移除">✕</button>';
    d.querySelector('img').src = shot.dataUrl || '';
    d.querySelector('.attach-del').onclick = () => { pendingShots.splice(i, 1); renderAttach(); };
    els.attachBar.appendChild(d);
  });
}

async function attachShot(payload) {
  if (!payload || payload.ok === false) return;
  let dataUrl = payload.dataUrl;
  // 大图主进程不直接传，按路径读回来
  if (!dataUrl && payload.path) {
    try {
      const r = await window.xw.captureRead(payload.path);
      if (r && r.ok) dataUrl = r.dataUrl;
    } catch (e) { /* ignore */ }
  }
  pendingShots.push({ path: payload.path || '', dataUrl: dataUrl || '' });
  renderAttach();
  if (!els.input.value.trim()) els.input.value = '看看这张图';
  els.input.focus();
  setStatus('截图已带上，想问什么直接说');
}

// ================== 子代理任务看板 ==================
function orchRender() {
  if (!els.orchBoard || !els.orchList) return;
  const list = Array.from(orchTasks.values());
  if (!list.length) { els.orchBoard.style.display = 'none'; return; }
  els.orchBoard.style.display = 'block';

  const done = list.filter((t) => t.status === 'done').length;
  const failed = list.filter((t) => t.status === 'failed').length;
  els.orchProgress.textContent = `完成 ${done}/${list.length}${failed ? ` · 失败 ${failed}` : ''}`;

  els.orchList.innerHTML = '';
  list.forEach((t) => {
    const mark = t.status === 'done' ? '✅' : t.status === 'failed' ? '❌' : t.status === 'running' ? '⏳' : '⏸';
    const div = document.createElement('div');
    div.className = 'orch-item st-' + (t.status || 'pending');
    let html = `<span class="oi-mark">${mark}</span><span><span class="oi-title">${escapeHtml(t.title || '子任务')}</span>`;
    if (t.summary) html += `<span class="orch-sum">${escapeHtml(String(t.summary).slice(0, 140))}</span>`;
    (t.asks || []).forEach((a) => {
      html += `<span class="orch-ask">问：${escapeHtml(a.question || '')}<br>小问：${escapeHtml(a.answer || '')}</span>`;
    });
    html += '</span>';
    div.innerHTML = html;
    els.orchList.appendChild(div);
  });
}

function bindOrch() {
  try {
    window.xw.onOrchPlan && window.xw.onOrchPlan((p) => {
      orchTasks.clear();
      (p && p.tasks ? p.tasks : []).forEach((t) => {
        orchTasks.set(t.id, { id: t.id, title: t.title, status: t.status || 'pending', summary: '', asks: [] });
      });
      orchRender();
      setStatus(`已派 ${orchTasks.size} 个子任务给子代理`);
    });

    window.xw.onOrchTask && window.xw.onOrchTask((p) => {
      if (!p || !p.id) return;
      const cur = orchTasks.get(p.id) || { id: p.id, title: p.title, status: 'pending', summary: '', asks: [] };
      if (p.title) cur.title = p.title;
      if (p.status) cur.status = p.status;
      if (p.summary) cur.summary = p.summary;
      orchTasks.set(p.id, cur);
      orchRender();
    });

    window.xw.onOrchAsk && window.xw.onOrchAsk((p) => {
      if (!p || p.status !== 'answered') return;
      const cur = orchTasks.get(p.taskId);
      if (!cur) return;
      cur.asks = (cur.asks || []).concat([{ question: p.question, answer: p.answer }]).slice(-3);
      orchTasks.set(p.taskId, cur);
      orchRender();
    });

    window.xw.onOrchDone && window.xw.onOrchDone((p) => {
      if (p && Array.isArray(p.tasks)) {
        p.tasks.forEach((t) => orchTasks.set(t.id, Object.assign(orchTasks.get(t.id) || {}, t)));
      }
      orchRender();
      setStatus(p && p.ok ? '子代理全部收工' : '有任务没跑通');
    });
  } catch (e) { /* ignore */ }
}

// ================== 自动更新状态条 ==================
function bindUpdater() {
  try { window.xw.onUpdaterEvent && window.xw.onUpdaterEvent((s) => renderUpdater(s)); } catch (e) { /* ignore */ }
  try {
    window.xw.updaterState && window.xw.updaterState().then(renderUpdater).catch(() => {});
  } catch (e) { /* ignore */ }
}

function renderUpdater(s) {
  const line = $('upState');
  if (!s || !line) return;
  let txt = s.message || '';
  if (s.state === 'idle') txt = txt || '已经是最新版本';
  if (s.state === 'available' && s.version) txt = `发现新版本 v${s.version}`;
  if (s.state === 'unpackaged') txt = txt || '开发模式不检查更新';
  line.textContent = [s.currentVersion ? `当前 v${s.currentVersion}` : '', txt].filter(Boolean).join(' · ');
  const bar = $('upBar');
  if (bar) bar.style.width = (s.state === 'downloaded' ? 100 : (s.percent || 0)) + '%';
  const inst = $('upInstall');
  if (inst) inst.style.display = s.state === 'downloaded' ? '' : 'none';
  const dl = $('upDownload');
  if (dl) dl.style.display = s.state === 'available' ? '' : 'none';
}

// ================== 截图与更新设置 ==================
function bindCapture() {
  const toggles = {
    capEnabled: 'captureEnabled',
    upEnabled: 'autoUpdate',
    upSilent: 'autoUpdateSilent',
    upOnQuit: 'autoUpdateInstallOnQuit',
    upPre: 'autoUpdatePrerelease'
  };
  Object.entries(toggles).forEach(([id, key]) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', async () => {
      cfg = await window.xw.setConfig({ [key]: el.checked });
      setToast('已保存');
    });
  });

  const texts = { capRegionKey: 'captureRegionHotkey', capFullKey: 'captureFullHotkey', capDir: 'captureDir' };
  Object.entries(texts).forEach(([id, key]) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', async () => {
      cfg = await window.xw.setConfig({ [key]: el.value.trim() });
      setToast('已保存');
    });
  });

  const after = $('capAfter');
  if (after) {
    after.addEventListener('change', async () => {
      cfg = await window.xw.setConfig({ captureAfter: after.value });
      setToast('已保存');
    });
  }

  const now = $('capNow');
  if (now) now.addEventListener('click', async () => {
    const r = await window.xw.captureRegion();
    if (r && r.ok) setToast('已截图：' + (r.path || ''));
  });
  const dir = $('capOpenDir');
  if (dir) dir.addEventListener('click', () => window.xw.captureOpenDir());

  const check = $('upCheck');
  if (check) check.addEventListener('click', async () => {
    check.disabled = true;
    try { renderUpdater(await window.xw.updaterCheck()); } finally { check.disabled = false; }
  });
  const down = $('upDownload');
  if (down) down.addEventListener('click', async () => renderUpdater(await window.xw.updaterDownload()));
  const inst = $('upInstall');
  if (inst) inst.addEventListener('click', () => window.xw.updaterInstall());
  const rel = $('upReleases');
  if (rel) rel.addEventListener('click', () => window.xw.updaterOpenReleases());
}

function fillCapture() {
  const set = (id, v) => { const el = $(id); if (el) el.value = v; };
  const setChk = (id, v) => { const el = $(id); if (el) el.checked = !!v; };
  setChk('capEnabled', cfg.captureEnabled !== false);
  set('capRegionKey', cfg.captureRegionHotkey || 'Alt+Shift+A');
  set('capFullKey', cfg.captureFullHotkey || 'Alt+Shift+S');
  set('capAfter', cfg.captureAfter || 'ask');
  set('capDir', cfg.captureDir || '');
  setChk('upEnabled', cfg.autoUpdate !== false);
  setChk('upSilent', cfg.autoUpdateSilent !== false);
  setChk('upOnQuit', cfg.autoUpdateInstallOnQuit !== false);
  setChk('upPre', cfg.autoUpdatePrerelease === true);
  bindUpdater();
}

// ---------- 保存 ----------
function collectPatch() {
  const patch = {
    apiBaseUrl: $('stBaseUrl').value.trim(),
    model: $('stModel').value.trim(),
    contextTurns: Number($('stContext').value),
    ttsEnabled: $('stTtsEnabled').checked,
    ttsProvider: $('stTtsProvider').value,
    ttsRate: Number($('stTtsRate').value),
    ttsVolume: Number($('stTtsVolume').value),
    ttsVoice: $('stVoice').value,
    ttsDashModel: $('stTtsDashModel').value,
    ttsDashVoice: $('stTtsDashVoice').value,
    ttsDashFormat: $('stTtsDashFormat').value,
    ttsOpenaiBaseUrl: $('stTtsOpenaiUrl').value.trim(),
    ttsOpenaiModel: $('stTtsOpenaiModel').value.trim(),
    ttsOpenaiVoice: $('stTtsOpenaiVoice').value,
    ballOpacity: Number($('stOpacity').value) / 100,
    hotkey: $('stHotkey').value.trim() || 'Alt+Space',
    asrProvider: $('stAsrProvider').value,
    asrModel: $('stAsrModel').value.trim() || 'paraformer-realtime-v2',
    asrSilenceMs: Number($('stAsrSilence').value) || 2000,
    // ---- 语音唤醒 ----
    wakeEnabled: $('stWakeEnabled').checked,
    wakeWords: parseWakeWords(),
    wakeSensitivity: Number($('stWakeSens').value) || 60,
    wakeSound: $('stWakeSound').checked,
    // ---- 桌面宠物 ----
    petEnabled: $('stPetEnabled').checked,
    petSize: Number($('stPetSize').value) || 120,
    petOpacity: Number($('stPetOpacity').value) / 100,
    petTop: $('stPetTop').checked,
    petWalk: $('stPetWalk').checked,
    petInteraction: $('stPetInteraction').checked,
    petAgentLink: $('stPetAgentLink').checked,
    // ---- 定时任务 ----
    schedEnabled: $('schEnabled').checked,
    // ---- 主动关注 ----
    watchEnabled: $('wEnabled').checked,
    watchQuake: $('wQuake').checked,
    watchQuakeMinMag: Number($('wMag').value) || 5,
    watchQuakeRegion: $('wRegion').value,
    watchQuakeInterval: Number($('wQuakeIv').value) || 5,
    watchHot: $('wHot').checked,
    watchHotInterval: Number($('wHotIv').value) || 30,
    watchHotTop: Number($('wTop').value) || 5,
    watchWeibo: $('wWeibo').checked,
    watchKeywords: $('wKeywords').value.trim(),
    watchMute: $('wMute').value.trim(),
    watchPet: $('wPet').checked,
    watchSpeak: $('wSpeak').checked,
    watchOpenPanel: $('wOpen').checked
  };

  const keyInput = $('stApiKey').value.trim();
  patch.apiKey = !keyInput ? '__KEEP__' : keyInput;

  const asrInput = $('stAsrKey').value.trim();
  patch.asrApiKey = !asrInput ? '__KEEP__' : asrInput;

  const ttsInput = $('stTtsKey').value.trim();
  patch.ttsApiKey = !ttsInput ? '__KEEP__' : ttsInput;

  const oaiInput = $('stTtsOpenaiKey').value.trim();
  patch.ttsOpenaiKey = !oaiInput ? '__KEEP__' : oaiInput;

  return patch;
}

// 保存按钮（顶部）
document.addEventListener('DOMContentLoaded', () => {
  const saveBtn = $('stSave');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      cfg = await window.xw.setConfig(collectPatch());
      $('stApiKey').value = '';
      $('stAsrKey').value = '';
      $('stTtsKey').value = '';
      $('stTtsOpenaiKey').value = '';
      saveBtn.textContent = '已保存 ✓';
      setTimeout(() => (saveBtn.textContent = '保存'), 1500);
      fillModel();
      fillVoice();
    });
  }
});

// ---------- 轻提示 ----------
let toastTimer = null;
function setToast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

// ============ 启动 ============
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
