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
  bindMeetingEvents();
  refreshMeetingStatus();
  bindPalette();
  bindQuickSchedule();
  bindCtx();
  bindIntent();
  renderSessionList();

  // 截图结果（快捷键 / 工具调用）自动带到输入框
  try { window.xw.onCapture && window.xw.onCapture((p) => attachShot(p)); } catch (e) { /* ignore */ }
  // 剪贴板感知：主进程认出一段「值得问」的内容，把它带进输入框（只带，不代发）
  try { window.xw.onClipAsk && window.xw.onClipAsk((p) => attachClip(p)); } catch (e) { /* ignore */ }
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
/**
 * 就地重命名一个会话：把标题那一行换成输入框。
 *
 * 为什么要有这个入口：`sessionRename` 从建立起就在 preload 上、主进程也实现了，
 * 而界面上**一次都没调用过** —— 会话名只能是「新对话」或者首条消息前 24 字，
 * 用户想给一段对话起个自己认得出来的名字，只能删掉重建。
 *
 * 交互约定（桌面端习惯）：
 * - 点铅笔按钮进入编辑，点输入框不会顺带切到那个会话（stopPropagation）；
 * - Enter 提交、Esc 取消、失焦按提交处理（用户点了别处通常是想保存）；
 * - 提交后以**主进程返回的标题**为准重画列表 —— 上限与清洗规则只在 store 里定义一次。
 *
 * 长度上限（`titleMax`，由 `session:list` 随列表带下来，唯一来源是 store 的
 * `SESSION_TITLE_MAX`）：
 * 此前这里刻意不设上限、完全交给主进程截断，代价是超长标题在回车那一瞬间**突然变短**
 * （用户以为自己手抖了）。现在把那个数字透传给输入框：`maxLength` 让到顶就不再进字，
 * 第二行临时让给「12/60」的计数 —— 到顶静默不动，会让人以为键盘坏了。
 * 计数与上限都用**同一个口径**：`String.length` 数的是 UTF-16 码元，
 * 与 `maxLength` 的判定口径一致（用码点数会与输入框掐的位置对不上）。
 * 拿不到上限（老版本主进程 / 调用没带参数）时退回旧行为：不设 maxLength，也不显示计数。
 */
function startSessionRename(titleEl, metaEl, s, titleMax) {
  if (titleEl.querySelector('.sess-rename-input')) return; // 已经在编辑，别叠第二个输入框
  const limit = Number(titleMax) > 0 ? Math.floor(Number(titleMax)) : 0;
  const input = document.createElement('input');
  input.className = 'sess-rename-input';
  input.type = 'text';
  input.value = s.title || '';
  input.placeholder = '会话名称';
  if (limit) input.maxLength = limit;
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const v = String(input.value || '').trim();
    if (!commit || !v) { renderSessionList(); return; }        // 取消 / 空名：不改动
    try {
      const r = await window.xw.sessionRename(s.id, v);
      if (r && session && r.id === session.id) session.title = r.title;
    } catch (e) { /* 主进程没改成功时按原样重画，不谎报成功 */ }
    renderSessionList();
  };
  /* 第二行临时让给计数：它本来显示「9/17 12:30 · 4 条」，重命名结束时整块会被重画回来。
     计数只在拿到上限时显示（拿不到就别假装有个上限）。 */
  const showCount = () => {
    if (!limit || !metaEl) return;
    const n = String(input.value || '').length;
    metaEl.textContent = `${n}/${limit}`;
    metaEl.classList.toggle('sess-meta--limit', n >= limit);
  };
  input.oninput = showCount;
  input.onclick = (e) => e.stopPropagation();
  input.onmousedown = (e) => e.stopPropagation();
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
  titleEl.textContent = '';
  titleEl.appendChild(input);
  showCount();
  input.focus();
  input.select();
}

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

      const ren = document.createElement('button');
      ren.className = 'sess-ren';
      ren.textContent = '✎';
      ren.title = '重命名会话';
      ren.onclick = (e) => {
        e.stopPropagation();
        startSessionRename(title, meta, s, data.titleMax);
      };

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
      item.appendChild(ren);
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
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      // 只敲一个 / 就是「看所有能力」，不是发一条消息
      if ((els.input.value || '').trim() === '/') { els.input.value = ''; autoResize(); updateIntent(); openPalette(); return; }
      send();
    }
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
  // 工作台已经全是「卡」，旧的 .msg / .tool-card 一并清掉（兼容历史会话的残留节点）
  [...els.messages.querySelectorAll('.tcard, .msg, .tool-card')].forEach((n) => n.remove());
  currentCard = null;
  currentAiNode = null;
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
    const host = userNode.querySelector('.tcard-body') || userNode;
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
    if (wrap.children.length) host.appendChild(wrap);
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

// ---------- 任务卡渲染 ----------
/**
 * 不搞一问一答的气泡流。
 *
 * 这里每一屏都是「一张卡 = 一件事」：
 *   卡头   你想干什么（原文 + 状态徽标 + 时间）
 *   轨迹   小问为了这件事调了什么工具（默认折叠，跑的时候自动展开）
 *   正文   结论
 *   卡脚   下一步能干什么（复制 / 朗读 / 重答 / 定成定时任务 / 派给子代理 / 记进记忆）
 *
 * 主动播报（地震、热搜、定时任务）也是一张卡，只是换个图标和标签 ——
 * 于是整个界面从「聊天记录」变成「事情的时间线」。
 */
let currentCard = null;
let cardSeq = 0;

function cardTime(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function createTaskCard(askText, opts = {}) {
  const kind = opts.kind || 'task';
  const card = document.createElement('article');
  card.className = 'tcard' + (kind === 'proactive' ? ' proactive' : '') + (kind === 'system' ? ' systemish' : '');
  card.dataset.state = opts.state || 'thinking';
  card.dataset.startedAt = String(Date.now());
  cardSeq++;
  card.dataset.seq = String(cardSeq);

  const head = document.createElement('header');
  head.className = 'tcard-head';
  head.innerHTML = `
    <span class="tcard-icon">${kind === 'proactive' ? '🔔' : '◆'}</span>
    <span class="tcard-idx">#${cardSeq}</span>
    <span class="tcard-ask"></span>
    ${kind === 'proactive' ? '<span class="tcard-kind">主动播报</span>' : ''}
    <span class="tcard-state"><i></i><b>思考中</b></span>
    <span class="tcard-time">${cardTime()}</span>`;
  head.querySelector('.tcard-ask').textContent = askText || '（自主行动）';

  const body = document.createElement('div');
  body.className = 'tcard-body';
  body.innerHTML = `
    <div class="tcard-trace" hidden>
      <button class="tcard-trace-head" type="button">
        <span class="tt-arrow">▸</span>
        <span>执行轨迹</span>
        <b class="tt-count">0</b>
        <span class="tt-hint"></span>
      </button>
      <div class="tcard-trace-list"></div>
    </div>
    <div class="bubble"></div>`;

  const foot = document.createElement('footer');
  foot.className = 'tcard-foot';
  foot.hidden = true;

  card.appendChild(head);
  card.appendChild(body);
  card.appendChild(foot);

  // 轨迹默认折叠成一行；点一下展开/收起（跑的时候代码会自动展开）
  body.querySelector('.tcard-trace-head').addEventListener('click', () => {
    const t = body.querySelector('.tcard-trace');
    const collapsed = t.dataset.collapsed === '1';
    t.dataset.collapsed = collapsed ? '0' : '1';
    body.querySelector('.tt-arrow').textContent = collapsed ? '▾' : '▸';
  });
  return card;
}

/** 卡头状态徽标：thinking / work / done / error / stopped */
function setCardState(card, state, text) {
  const c = card || currentCard;
  if (!c) return;
  c.dataset.state = state;
  const b = c.querySelector('.tcard-state b');
  if (b) b.textContent = text || ({
    thinking: '思考中', work: '执行中', done: '已完成', error: '出错了', stopped: '已停止', queued: '排队中', running: '运行中'
  }[state] || state);
}

function cardOf(node) {
  if (!node) return null;
  return node.classList && node.classList.contains('tcard') ? node : node.closest('.tcard');
}

/** 轨迹区：有工具调用时才展开，跑完自动折叠（不抢正文的注意力） */
function traceList(card) {
  return (card || currentCard).querySelector('.tcard-trace-list');
}

function showTrace(card, show) {
  const t = (card || currentCard).querySelector('.tcard-trace');
  if (t) t.hidden = !show;
}

function bumpTrace(card, hint) {
  const c = card || currentCard;
  const t = c.querySelector('.tcard-trace');
  const n = c.querySelector('.tt-count');
  if (!t || !n) return;
  t.hidden = false;
  t.dataset.collapsed = '0';   // 正在干活：让主人看得见它在动
  const arrow = c.querySelector('.tt-arrow');
  if (arrow) arrow.textContent = '▾';
  n.textContent = String(traceList(c).childElementCount);
  if (hint != null) {
    const h = c.querySelector('.tt-hint');
    if (h) h.textContent = hint;
  }
}

/** 桌面宠物 → 任务卡（Agent 干活时的状态联动） */
function renderToolCard(p) {
  if (!p) return;
  const card = currentCard;
  if (!card) return;
  showTrace(card);
  setCardState(card, 'work');
  setStatus('正在干活…');

  const list = traceList(card);
  let node = list.querySelector('#tool-' + p.id);
  const label = TOOL_LABEL[p.name] || (p.name.startsWith('mcp__') ? 'MCP ' + p.name.split('__')[2] : p.name);
  const brief = briefArgs(p.name, p.args);

  if (p.status === 'start') {
    if (node) node.remove();
    node = document.createElement('div');
    node.id = 'tool-' + p.id;
    node.className = 'tool-card';
    node.innerHTML = `<div class="tool-head"><span class="tool-dot running"></span>
      <span class="tool-name">${escapeHtml(label)}</span>
      ${p.danger ? '<span class="tool-tag danger">高危</span>' : ''}
      <span class="tool-status">执行中…</span></div>
      <div class="tool-args">${escapeHtml(brief)}</div>`;
    list.appendChild(node);
    bumpTrace(card, label);
    scrollToBottom();
    setStatus(`正在${label}…`);
    return;
  }

  if (!node) {
    node = document.createElement('div');
    node.id = 'tool-' + p.id;
    node.className = 'tool-card';
    node.innerHTML = `<div class="tool-head"><span class="tool-dot done"></span>
      <span class="tool-name">${escapeHtml(label)}</span>
      <span class="tool-status">—</span></div>`;
    list.appendChild(node);
  }
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
      const btn = document.createElement('button');
      btn.className = 'tool-open';
      btn.textContent = '打开截图';
      btn.onclick = () => window.xw.toolsOpenFile(f[1]);
      node.appendChild(btn);
    }
  }
  bumpTrace(card);
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

// ---------- 卡片入口（保持老签名，内部改成卡片） ----------
function addMessageBubble(role, content, { animate = true, thinking = false, kind = 'task' } = {}) {
  const r = normalizeRole(role);

  if (r === 'user') {
    const card = createTaskCard(content, { kind });
    els.messages.appendChild(card);
    currentCard = card;
    if (animate) scrollToBottom();
    return card.querySelector('.tcard-ask');
  }

  // 助手侧：没卡就单独开一张（例如会话回放时第一条就是回答）
  let card = currentCard;
  if (!card || card.dataset.closed === '1') {
    card = createTaskCard(kind === 'proactive' ? (content || '主动播报') : '（自主行动）', { kind });
    if (kind !== 'proactive') card.classList.add('standalone');
    els.messages.appendChild(card);
    currentCard = card;
  }

  const bubble = card.querySelector('.bubble');
  if (thinking) bubble.innerHTML = `<span class="thinking-dots"><i></i><i></i><i></i></span>`;
  else if (r === 'assistant') bubble.innerHTML = renderMarkdown(content);
  else bubble.textContent = content;

  // 回放历史（animate=false）时，有内容的回答直接当「已完成」，
  // 否则旧消息会一直挂着「思考中」的状态徽标，看着像卡住了
  if (!animate && r === 'assistant' && String(content || '').trim() && !thinking) {
    setCardState(card, 'done');
    const foot = card.querySelector('.tcard-foot');
    if (foot) foot.hidden = true;   // 历史消息不给动作按钮，免得误点「重答」
    card.dataset.closed = '1';
  }

  if (animate) scrollToBottom();
  return card;
}

function renderStreaming(node, text, isError = false) {
  if (!node) return;
  const card = cardOf(node);
  const bubble = (card || node).querySelector('.bubble');
  if (!bubble) return;
  bubble.innerHTML = renderMarkdown(text) + (isError ? '' : '<span class="cursor"></span>');
  // 正在调工具时不要把状态徽标降级回「思考中」（工具还在跑）
  if (card && card.dataset.state !== 'work') setCardState(card, isError ? 'error' : 'thinking');
}

function finalizeAiNode(node, text, state = 'done') {
  if (!node) return;
  const card = cardOf(node);
  const bubble = (card || node).querySelector('.bubble');
  if (bubble) bubble.innerHTML = renderMarkdown(text);

  if (card) {
    setCardState(card, state);
    // 跑完自动折叠轨迹，把注意力交还给结论
    const t = card.querySelector('.tcard-trace');
    if (t && !t.hidden && traceList(card).childElementCount > 0) {
      t.dataset.collapsed = '1';
      const arrow = card.querySelector('.tt-arrow');
      if (arrow) arrow.textContent = '▸';
    }
    // 计时：卡头时间改成「起 → 止 + 用时」
    const started = Number(card.dataset.startedAt || 0);
    if (started) {
      const ms = Date.now() - started;
      const timeEl = card.querySelector('.tcard-time');
      if (timeEl) timeEl.textContent = `${cardTime(new Date(started))} · ${(ms / 1000).toFixed(1)}s`;
    }
    const foot = card.querySelector('.tcard-foot');
    if (foot) {
      foot.hidden = false;
      if (!foot.querySelector('.msg-actions')) foot.appendChild(buildActions(text, bubble, card));
    }
    card.dataset.closed = '1';
  }
  scrollToBottom();
}

/** 卡脚动作：常规动作 + 一键「把这件事变成长期动作」 */
function buildActions(text, bubble, card) {
  const bar = document.createElement('div');
  bar.className = 'msg-actions';

  const mk = (label, title, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (title) b.title = title;
    b.onclick = fn;
    bar.appendChild(b);
    return b;
  };

  const copyBtn = mk('复制', '复制这条结论', () => {
    navigator.clipboard.writeText(text);
    copyBtn.textContent = '已复制';
    setTimeout(() => (copyBtn.textContent = '复制'), 1400);
  });

  const speakBtn = mk('朗读', '用语音念出来', () => {
    if (speech.isSpeaking() || currentAudio) {
      speech.stopSpeaking();
      stopAudio();
      speakBtn.classList.remove('on');
      speakBtn.textContent = '朗读';
    } else {
      speakText(toPlainText(text));
      speakBtn.classList.add('on');
      speakBtn.textContent = '停止';
      const un = () => {
        speakBtn.classList.remove('on');
        speakBtn.textContent = '朗读';
        document.removeEventListener('speech-ended', un);
      };
      document.addEventListener('speech-ended', un);
    }
  });

  mk('重答', '丢掉这次回答重新问一遍', () => {
    if (streaming) return;
    const wrap = bar.closest('.tcard') || bar.closest('.msg');
    const idx = messages.findIndex((m) => normalizeRole(m.role) === 'assistant' && m.content === text);
    if (idx >= 0) messages.splice(idx, 1);
    wrap && wrap.remove();
    const lastIdx = messages.map((m) => m.role).lastIndexOf('user');
    if (lastIdx >= 0) messages.splice(lastIdx, 1);
    if (lastUserText) send(lastUserText);
  });

  // 把「这一次的结论」变成长期动作 —— 这是工作台和聊天页最大的区别
  mk('⏰ 定成定时任务', '按这件事建一个定时任务', () => {
    const ask = card ? (card.querySelector('.tcard-ask') || {}).textContent || '' : '';
    openQuickSchedule(ask || lastUserText, text);
  });

  mk('🧩 派给子代理', '把它交给子代理去做（可以并行）', async () => {
    if (streaming) return;
    const ask = card ? (card.querySelector('.tcard-ask') || {}).textContent || '' : '';
    send(`把这件事交给子代理去做：${ask || lastUserText}`);
  });

  mk('🧠 记进记忆', '让小问长期记住这条结论', async () => {
    const ask = card ? (card.querySelector('.tcard-ask') || {}).textContent || '' : '';
    try {
      await window.xw.memoryAdd({
        text: `${ask ? ask + ' → ' : ''}${String(text).slice(0, 200)}`,
        tags: ['工作台'], source: 'auto'
      });
      setToast('已记进长期记忆');
    } catch (e) {
      setToast('记录失败：' + ((e && e.message) || e));
    }
  });

  return bar;
}

// ---------- 意图预览：还没发出去，就先把「我打算怎么干」摊开 ----------
/**
 * 传统问答页的毛病：你打完字点发送，然后盯着一个三点动画发呆。
 * 工作台应该是「说完就看见计划」：输入框下面常驻一条意图条，
 * 边打字边告诉主人 —— 这件事小问会去查资料 / 动电脑 / 排定时任务。
 * 命中「长期要做」的，直接把「就这么办」按钮递到手边。
 */
const INTENT_RULES = [
  { re: /(每天|每周|每月|每隔|每小时|每\s*\d+\s*(分钟|小时)|提醒我|定个?闹钟|定时|排个|日程|周期|早报|日报|周报)/,
    ico: '⏰', text: '这是「长期要做」的事 —— 我可以直接排成定时任务，到点自己跑、自己播报。', act: 'schedule' },
  { re: /(截图|截屏|截个图|screenshot)/i,
    ico: '📷', text: '要动手截图：Alt+Shift+A 框选、Alt+Shift+F 全屏，结果会自动贴进输入框。' },
  { re: /(记住|记一下|记下来|帮我记|存进记忆|以后都)/,
    ico: '🧠', text: '这条我会顺手写进长期记忆，以后不用重复交代。' },
  { re: /(写|生成|整理|总结|复盘|报告|方案|文案|翻译|润色|起个名)/,
    ico: '✍️', text: '这是要「出一份东西」：我先给结论，再给能直接用的成稿。' },
  { re: /(查一下|查查|搜|看看|怎么样|多少钱|最新|新闻|行情|股价|天气|热搜)/,
    ico: '🔍', text: '需要外部信息：我去查完再回你，并且标明来源。' },
  { re: /(装|卸载|运行|执行|打开|关闭|清理|删除|拷贝|复制到|移动|批量)/,
    ico: '⚙️', text: '要动你的电脑：高危步骤我会先弹一句确认，再动手。' }
];

let intentAct = '';

function updateIntent() {
  const bar = $('intentBar');
  if (!bar) return;
  const v = (els.input.value || '').trim();
  if (!v) { bar.hidden = true; intentAct = ''; return; }

  let hit = null;
  for (const r of INTENT_RULES) { if (r.re.test(v)) { hit = r; break; } }
  if (!hit) {
    // 什么都不像的时候，也别沉默：至少告诉主人「我会当成一件事去办」
    $('intentIco').textContent = '◆';
    $('intentText').textContent = 'Enter 就交给小问办 —— 会在这儿留一张卡，不是聊天记录。';
    $('intentGo').hidden = true;
    intentAct = '';
    bar.hidden = false;
    return;
  }

  $('intentIco').textContent = hit.ico;
  $('intentText').textContent = hit.text;
  intentAct = hit.act || '';
  $('intentGo').hidden = hit.act !== 'schedule';
  bar.hidden = false;
}

function bindIntent() {
  const bar = $('intentBar');
  if (!bar || !els.input) return;
  els.input.addEventListener('input', updateIntent);
  const go = $('intentGo');
  go && (go.onclick = () => { openQuickSchedule(els.input.value.trim().slice(0, 40), els.input.value.trim()); });
}

// ---------- 上下文环：这一轮塞了多少字，压没压过 ----------
function renderContext(st) {
  const ring = $('ctxRing');
  const badge = $('ctxBadge');
  const btn = $('btnCtx');
  if (!ring || !st) return;
  const C = 94.2; // 2πr, r=15
  const used = Number(st.afterTokens || 0);
  const budget = Number(st.budget || 1) || 1;
  const ratio = Math.max(0, Math.min(1, used / budget));
  ring.setAttribute('stroke-dashoffset', String(C * (1 - ratio)));
  ring.setAttribute('stroke', ratio > 0.9 ? '#ef4444' : ratio > 0.7 ? '#f59e0b' : 'currentColor');
  if (btn) btn.classList.toggle('on', ratio > 0.6);
  if (badge) badge.hidden = !st.compressed;
  const pct = Math.round(ratio * 100);
  const parts = [`上下文 ${used} / ${budget} tokens（${pct}%）`];
  if (st.compressed) {
    parts.push('已自动压缩');
    if (st.clippedTools) parts.push(`截断工具输出 ${st.clippedTools} 条`);
    if (st.digestLines) parts.push(`折叠成纪要 ${st.digestLines} 行`);
    if (st.droppedMessages) parts.push(`丢弃最旧 ${st.droppedMessages} 条`);
    parts.push(`保留最近 ${st.keptTurns ?? '—'} 轮原文`);
    if (st.ratio != null) parts.push(`压缩比 ${(st.ratio * 100).toFixed(0)}%`);
  } else {
    parts.push('无需压缩');
  }
  if (btn) btn.title = parts.join(' · ');
}

function bindCtx() {
  try { window.xw.onContext && window.xw.onContext((st) => renderContext(st)); } catch (e) { /* ignore */ }
  const btn = $('btnCtx');
  btn && (btn.onclick = () => setStatus(btn.title || '上下文用量'));
}

// ---------- 命令面板（Ctrl+K）：能力入口，不是第二个输入框 ----------
let palItems = [];
let palSel = 0;

function paletteCommands() {
  return [
    { g: '常用', ico: '🆕', title: '新建一个工作台', sub: '清屏重来', run: () => newChat() },
    { g: '常用', ico: '⚙️', title: '打开设置', run: () => window.xw.openSettings('') },
    { g: '常用', ico: '📷', title: '框选截图后提问', sub: 'Alt+Shift+A', run: () => window.xw.captureRegion() },
    { g: '常用', ico: '🖼️', title: '全屏截图后提问', sub: 'Alt+Shift+F', run: () => window.xw.captureFull() },
    { g: '常用', ico: '🐧', title: '召唤桌面宠物到鼠标处', sub: 'Alt+Ctrl+P', run: () => { window.xw.petSummon(); setToast('宠物已召唤到鼠标处'); } },
    {
      g: '常用', ico: '🎈', title: '悬浮球 / 宠物 换个班',
      sub: '同一时刻只留一个入口',
      run: async () => {
        const st = await window.xw.entryState();
        if (st.ballShown) {
          await window.xw.entryBallSet(false);
          await window.xw.setConfig({ petEnabled: true });
          setToast('悬浮球收起来了，入口交给桌面宠物');
        } else {
          await window.xw.entryBallShow();
          setToast('悬浮球回来了（现在两个入口都在）');
        }
        refreshBallState();
      }
    },
    { g: '定时', ico: '⏰', title: '新建一个定时任务', run: () => openQuickSchedule('', '') },
    { g: '定时', ico: '📋', title: '看所有定时任务', sub: '设置 · 定时任务', run: () => window.xw.openSettings('schedule') },
    { g: '定时', ico: '▶️', title: '立刻把定时任务跑一遍', run: () => window.xw.openSettings('schedule') },
    { g: '关注', ico: '🔥', title: '现在就看一眼热搜', run: () => doWatchCheck('hot') },
    { g: '关注', ico: '🌏', title: '现在检查一次地震', run: () => doWatchCheck('quake') },
    { g: '关注', ico: '🔔', title: '设置主动关注', sub: '设置 · 主动关注', run: () => window.xw.openSettings('watch') },
    { g: '会议', ico: '🎙', title: '开始记录会议纪要', sub: '把系统声音 + 麦克风转成文字', run: () => startMeetingNow() },
    { g: '会议', ico: '⏹', title: '结束记录并生成纪要', run: () => stopMeetingNow() },
    { g: '会议', ico: '📝', title: '看最近的会议纪要', sub: '设置 · 会议纪要', run: () => window.xw.openSettings('meeting') },
    { g: '会议', ico: '🔍', title: '检测一下我现在是不是在开会', run: () => detectMeetingNow() },
    { g: '记忆', ico: '🧠', title: '把剪贴板内容记进记忆', run: () => rememberClipboard() },
    { g: '记忆', ico: '📚', title: '打开人格与记忆', run: () => window.xw.openSettings('persona') },
    { g: '技能', ico: '🧩', title: '看看有哪些技能', run: () => window.xw.openSettings('skills') },
    { g: '技能', ico: '🛠️', title: 'Agent 能力开关', run: () => window.xw.openSettings('agent') },
    { g: '上下文', ico: '🫧', title: '清空当前上下文', sub: '重新开始记', run: () => { messages = []; newChat(); } }
  ];
}

async function doWatchCheck(source) {
  setToast('这就去看一眼…');
  try {
    const r = await window.xw.watchCheck(source);
    setStatus(r && r.ok === false ? ('检查失败：' + (r.error || '')) : '已检查，有新消息会主动播报');
  } catch (e) {
    setStatus('检查失败：' + ((e && e.message) || e));
  }
}

// ---------- 会议纪要：命令面板里的三个快捷动作 ----------
async function startMeetingNow() {
  setToast('正在开始记录…');
  const r = await window.xw.meetingStart({});
  if (r && r.ok) {
    // 顺便在设置页把实时状态刷出来（用户可能是从命令面板点进来的）
    refreshMeetingStatus();
    setToast('已开始记录，正在把声音转成文字');
  } else {
    setToast(`没能开始：${(r && r.error) || '未知原因'}`);
  }
}

async function stopMeetingNow() {
  setToast('正在收尾并生成纪要…');
  const r = await window.xw.meetingStop();
  setToast(r && r.ok ? (r.discarded ? '这次内容太少，没有留纪要' : '会议纪要已生成') : `没能结束：${(r && r.error) || '未知原因'}`);
  refreshMeetingStatus();
}

async function detectMeetingNow() {
  setToast('正在采样…');
  const r = await window.xw.meetingDetectNow();
  if (!r || !r.ok) return setToast(`采样失败：${(r && r.error) || '未知原因'}`);
  const lv = { meeting: '判定在开会/通话', mic: '有程序在用麦克风', none: '没检测到通话' }[r.level] || r.level;
  setToast(`${lv}${r.app ? ` · ${r.app}` : ''}`);
  setStatus(r.reasons && r.reasons[0] ? r.reasons[0] : lv);
}

async function rememberClipboard() {
  try {
    const r = await window.xw.clipboardRead();
    const text = (r && r.text) || '';
    if (!String(text).trim()) return setToast('剪贴板是空的');
    await window.xw.memoryAdd({ text: String(text).slice(0, 2000), tags: ['剪贴板'], source: 'user' });
    setToast('已记进长期记忆');
  } catch (e) {
    setToast('记录失败：' + ((e && e.message) || e));
  }
}

function openPalette() {
  const mask = $('paletteMask');
  if (!mask) return;
  mask.classList.add('show');
  const inp = $('paletteInput');
  inp.value = '';
  palSel = 0;
  renderPalette('');
  setTimeout(() => inp.focus(), 10);
}

function closePalette() {
  const mask = $('paletteMask');
  if (mask) mask.classList.remove('show');
}

function renderPalette(q) {
  const list = $('paletteList');
  if (!list) return;
  const all = paletteCommands();
  const kw = String(q || '').trim().toLowerCase();
  palItems = kw ? all.filter((c) => (c.title + ' ' + (c.sub || '') + ' ' + c.g).toLowerCase().includes(kw)) : all;

  list.innerHTML = '';
  let lastGroup = '';
  palItems.forEach((c, i) => {
    if (c.g !== lastGroup) {
      lastGroup = c.g;
      const g = document.createElement('div');
      g.className = 'pal-group';
      g.textContent = c.g;
      list.appendChild(g);
    }
    const item = document.createElement('div');
    item.className = 'pal-item' + (i === palSel ? ' active' : '');
    item.innerHTML = `<span class="pal-ico">${c.ico}</span><span class="pal-title"></span>${c.sub ? `<span class="pal-sub">${escapeHtml(c.sub)}</span>` : ''}`;
    item.querySelector('.pal-title').textContent = c.title;
    item.onmouseenter = () => { palSel = i; markPalActive(); };
    item.onclick = () => runPalette(i);
    list.appendChild(item);
  });

  if (!palItems.length) {
    const empty = document.createElement('div');
    empty.className = 'pal-group';
    empty.textContent = '没找到对应命令 —— 直接 Enter 就把这句话交给小问办';
    list.appendChild(empty);
  }
}

function markPalActive() {
  const list = $('paletteList');
  if (!list) return;
  [...list.querySelectorAll('.pal-item')].forEach((n, i) => n.classList.toggle('active', i === palSel));
  const act = list.querySelector('.pal-item.active');
  act && act.scrollIntoView({ block: 'nearest' });
}

function runPalette(i) {
  const cmd = palItems[i];
  closePalette();
  if (!cmd) return;
  try { cmd.run(); } catch (e) { setStatus('命令执行失败：' + ((e && e.message) || e)); }
}

function bindPalette() {
  const mask = $('paletteMask');
  const inp = $('paletteInput');
  if (!mask || !inp) return;

  mask.addEventListener('click', (e) => { if (e.target === mask) closePalette(); });
  inp.addEventListener('input', () => { palSel = 0; renderPalette(inp.value); });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (palItems.length) { palSel = (palSel + 1) % palItems.length; markPalActive(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (palItems.length) { palSel = (palSel - 1 + palItems.length) % palItems.length; markPalActive(); } }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const typed = inp.value.trim();
      if (palItems.length && !(typed && !palItems[palSel])) return runPalette(palSel);
      // 没有匹配命令：就把输入的内容当成一句话发给小问
      closePalette();
      if (typed) send(typed);
    } else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });

  document.addEventListener('keydown', (e) => {
    const k = (e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'k') { e.preventDefault(); openPalette(); return; }
    if (e.key === 'Escape' && mask.classList.contains('show')) closePalette();
  });
}

// ---------- 快捷定时：把一张卡上的结论变成长期动作 ----------
function openQuickSchedule(title, prompt) {
  const mask = $('qsMask');
  if (!mask) return;
  $('qsTitle').value = String(title || '').slice(0, 40);
  $('qsWhen').value = '';
  $('qsPrompt').value = String(prompt || '');
  $('qsHint').textContent = '';
  mask.classList.add('show');
  setTimeout(() => $('qsWhen').focus(), 10);
}

function closeQuickSchedule() {
  const mask = $('qsMask');
  if (mask) mask.classList.remove('show');
}

function bindQuickSchedule() {
  const mask = $('qsMask');
  if (!mask) return;
  mask.addEventListener('click', (e) => { if (e.target === mask) closeQuickSchedule(); });
  document.querySelectorAll('.qs-chips button').forEach((b) => {
    b.addEventListener('click', () => { $('qsWhen').value = b.dataset.when; $('qsHint').textContent = ''; });
  });
  $('qsCancel').onclick = closeQuickSchedule;
  $('qsOk').onclick = async () => {
    const when = $('qsWhen').value.trim();
    const prompt = $('qsPrompt').value.trim();
    if (!prompt) { $('qsHint').textContent = '得先写清楚到点做什么'; return; }
    if (!when) { $('qsHint').textContent = '得写清楚多久做一次，比如「每天 08:30」'; return; }
    const r = await window.xw.scheduleAdd({ title: $('qsTitle').value.trim(), prompt, when, wake: true });
    if (!r || r.ok === false) { $('qsHint').textContent = (r && r.error) || '创建失败'; return; }
    closeQuickSchedule();
    setToast(`已排好：${(r.task && r.task.title) || '定时任务'}`);
    // 顺手在时间线上留一张卡，主人知道这事已经落地了
    const card = createTaskCard(`排了个定时任务：${(r.task && r.task.title) || prompt.slice(0, 20)}`, { kind: 'system' });
    card.dataset.state = 'done';
    const bubble = card.querySelector('.bubble');
    if (bubble) {
      bubble.textContent = `到点我会自己去做：${prompt}\n${(r.task && r.task.whenText) || when}`;
    }
    const foot = card.querySelector('.tcard-foot');
    const foot2 = card.querySelector('.tcard-state b');
    if (foot2) foot2.textContent = '已安排';
    if (foot) foot.hidden = true;
    els.messages.appendChild(card);
    card.dataset.closed = '1';
    scrollToBottom();
  };
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
  bindMeeting();
  bindMeetingEvents();
  bindClipSense();
  bindClipTest();
  bindAdvanced();
  fillAll();
}

function activateTab(tab) {
  if (!tab) return;
  const btn = document.querySelector(`.st-nav-item[data-tab="${tab}"]`);
  if (!btn) return;
  document.querySelectorAll('.st-nav-item').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.st-section').forEach((s) => s.classList.remove('active'));
  btn.classList.add('active');
  curSettingsTab = tab;
  const sec = document.querySelector(`.st-section[data-tab="${tab}"]`);
  if (sec) sec.classList.add('active');
  const wrap = document.querySelector('.st-wrap');
  if (wrap) wrap.scrollTop = 0;
}

function settingsTabFromHash() {
  const m = /#settings\/([a-z0-9-]+)/i.exec(decodeURIComponent(location.hash || location.href || ''));
  return m ? m[1] : '';
}

function buildTabs() {
  document.querySelectorAll('.st-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });
  // 命令面板里指定的标签页（#settings/pet 这种）直接跳过去
  const want = settingsTabFromHash();
  if (want) activateTab(want);
  try {
    window.xw.onSettingsTab && window.xw.onSettingsTab((t) => activateTab(t));
  } catch (e) { /* ignore */ }
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
  fillMeeting();
  fillClipSense();
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

  // 悬浮球 ⇄ 宠物 的分工（同一时刻只出一个）
  const mode = $('stBallMode');
  if (mode) {
    mode.addEventListener('change', async () => {
      const v = mode.value;
      try {
        cfg = await window.xw.setConfig({ ballEnabled: v === 'true' ? true : v === 'false' ? false : 'auto' });
        setToast(v === 'auto' ? '已设为自动：宠物在场时隐藏悬浮球'
          : v === 'true' ? '悬浮球会一直显示' : '悬浮球不再显示，入口交给宠物');
      } catch (e) { /* ignore */ }
      refreshBallState();
    });
  }
}

async function fillGeneral() {
  try {
    const st = await window.xw.autostartGet();
    $('stAutoStart').checked = !!st.enabled;
  } catch (e) { /* ignore */ }
  $('stOpacity').value = Math.round((cfg.ballOpacity ?? 0.92) * 100);
  $('stOpacityVal').textContent = Math.round((cfg.ballOpacity ?? 0.92) * 100) + '%';
  $('stHotkey').value = cfg.hotkey || 'Alt+Space';
  if ($('stBallMode')) {
    const mode = cfg.ballEnabled === true || cfg.ballEnabled === false ? cfg.ballEnabled : 'auto';
    $('stBallMode').value = String(mode);
  }
  refreshBallState();
}

/** 把「现在桌面上到底是谁」摊在设置页上，省得用户到处找球 */
async function refreshBallState() {
  const el = $('stBallState');
  if (!el) return;
  try {
    const st = await window.xw.entryState();
    if (!st) return;
    const who = st.ballShown ? '悬浮球' : '桌面宠物';
    const why = st.petOn ? '宠物开着，所以入口是它' : '宠物关着，所以悬浮球顶班';
    el.textContent = `当前桌面入口：${who}（${why}）` + (st.ballShown && st.petOn ? '；两个都开着，会比较挤' : '');
  } catch (e) {
    el.textContent = '当前状态：读取失败';
  }
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

  // 记忆检索预览：主进程的 `memory:search` 从建立起就有、也一直挂在 preload 上，
  // 但界面上**一次都没调用过** —— 用户只能看到全部记忆的流水，看不到「这句话会让小问想起哪几条」。
  // 这里用同一套检索（`store.searchMemories`，就是对话注入用的那个函数）把结果摊开，
  // 命中不了的记忆用户可以据此删掉，而不是让它们永远躺在列表里占着位置。
  let searchTimer = null;
  const runSearch = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { fillPersona(); }, 140);
  };
  $('memSearch').addEventListener('input', runSearch);
  $('memSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(searchTimer); fillPersona(); } });
  $('memSearchClear').addEventListener('click', () => {
    $('memSearch').value = '';
    fillPersona();
  });
}

/**
 * 渲染记忆列表 —— **列表与搜索结果共用这一份**。
 *
 * 分两份写是这类界面最容易出的漂移：一边加了标签、另一边没有；一边的删除按钮忘了刷新。
 * 所以渲染只有这一个入口，`meta` 只描述「这批是怎么来的」，不参与怎么画。
 */
function renderMemories(items, meta) {
  const box = $('memList');
  box.innerHTML = '';
  if (!items.length) {
    box.innerHTML = `<div class="empty">${meta.emptyText}</div>`;
    return;
  }
  items.forEach((m) => {
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

async function fillPersona() {
  persona = await window.xw.personaGet();
  const map = { pzName: 'assistantName', pzRole: 'assistantRole', pzTraits: 'assistantTraits', pzStyle: 'styleRules', pzCustom: 'customPrompt', pzUser: 'userName', pzAlias: 'userAlias', pzProfile: 'userProfile' };
  Object.entries(map).forEach(([id, key]) => { const el = $(id); if (el) el.value = persona[key] || ''; });

  const all = await window.xw.memoryList();
  $('memCount').textContent = all.length;

  const q = ($('memSearch') && $('memSearch').value || '').trim();
  const hint = $('memSearchHint');
  if (q) {
    const hits = await window.xw.memorySearch(q);
    hint.textContent = `按「${q}」检索：命中 ${hits.length} 条（与对话注入同一套检索、同一个条数）。调不出记忆时，先看这里有没有命中。`;
    renderMemories(hits, { emptyText: `没有记忆命中「${q}」。小问这次对话不会想起任何长期记忆。` });
    return;
  }
  hint.textContent = '';
  renderMemories([...all].reverse(), { emptyText: '还没有记忆。让小问记住点什么吧。' });
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
    setToast(on.checked
      ? '宠物已出现（悬浮球已自动隐藏，入口交给它）'
      : '宠物已隐藏，悬浮球回来接班');
    refreshBallState();
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

  ['stPetTop', 'stPetWalk', 'stPetInteraction', 'stPetAgentLink', 'stPetKeepTop'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    const key = id.replace('stPet', 'pet');
    el.checked = cfg[key] !== false;
    el.addEventListener('change', async () => {
      cfg = await window.xw.setConfig({ [key]: el.checked });
      if (id === 'stPetKeepTop' && el.checked) {
        await window.xw.petTop();
        setToast('已开启「始终最上层」，宠物会周期性重新顶到最前面');
      }
    });
  });

  // 召唤宠物快捷键（录制式，按下去就能用）
  if ($('stPetSummonKey')) {
    $('stPetSummonKey').value = cfg.petSummonHotkey || 'CommandOrControl+Alt+P';
  }
  setupHotkeyRecorder({
    inputId: 'stPetSummonKey', btnId: 'stPetSummonRec',
    label: '召唤宠物',
    onApply: async (v) => {
      const r = await window.xw.petSummonHotkeySet(v);
      const now = await window.xw.petSummonHotkeyGet();
      if ($('stPetSummonKey')) $('stPetSummonKey').value = now || '';
      cfg.petSummonHotkey = now;
      // 注册失败时主进程会退到默认键；实际生效的是哪个，以读回来的为准
      if (r && r.ok === false) {
        return { accel: now || '', error: `${r.error || '这个组合键用不了'}${now ? `（已回落 ${now}）` : ''}` };
      }
      return { accel: now || '' };
    }
  });

  // 统一的显示 / 隐藏：走 petEnabled 配置，保证「配置 = 实际状态」，重启也一致
  $('stPetToggle').addEventListener('click', async () => {
    const next = cfg.petEnabled === false;
    cfg = await window.xw.setConfig({ petEnabled: next });
    on.checked = next;
    setToast(next ? '宠物已出现（悬浮球已让位）' : '宠物已隐藏，悬浮球回来接班');
    refreshPetDiag();
    refreshBallState();
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
    refreshBallState();
  });

  $('stPetSummon').addEventListener('click', async () => {
    try {
      await window.xw.setConfig({ petEnabled: true });
      cfg = await window.xw.getConfig();
      on.checked = true;
      await window.xw.petSummon();
      setToast('宠物已召唤到鼠标所在屏幕的右下角');
    } catch (e) {
      setToast('召唤失败：' + ((e && e.message) || e));
    }
    refreshPetDiag();
    refreshBallState();
  });

  $('stPetTopNow').addEventListener('click', async () => {
    await window.xw.petTop();
    setToast('已重新顶到最上层');
    refreshPetDiag();
  });

  $('stPetRebuild').addEventListener('click', async () => {
    await window.xw.petHardRecover();
    setToast('宠物窗口已重建');
    setTimeout(() => { refreshPetDiag(); refreshBallState(); }, 900);
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
    } else {
      el.textContent = `宠物窗口状态：${d.visible ? '可见' : '已隐藏'} · 位置 ${d.pos.join(', ')} · 尺寸 ${d.size.join('×')}`
        + (d.size[1] !== d.expectedHeight ? `（应为 ${d.expectedHeight}，可点「叫回主屏」修正）` : '');
    }
  } catch (e) {
    el.textContent = '宠物窗口状态：读取失败 ' + ((e && e.message) || e);
  }
  refreshPetHealth();
}

/** 宠物体检：一句话说清「为什么看不见」，以及该点哪个按钮 */
async function refreshPetHealth() {
  const el = $('stPetHealth');
  if (!el || !window.xw.petHealth) return;
  try {
    const h = await window.xw.petHealth();
    const bits = [];
    bits.push(h.exists ? (h.visible ? '窗口可见' : '窗口被隐藏') : '窗口不存在');
    if (h.exists) {
      bits.push(h.onScreen ? '在屏幕内' : '在屏幕外');
      bits.push(h.alwaysOnTop ? '已置顶' : '未置顶');
      bits.push(h.keepTop ? '周期重夺开启' : '周期重夺关闭');
    }
    const head = `体检：${bits.join(' · ')}。`;
    const hint = (h.hints || []).join(' ');
    const ent = h.entry
      ? `桌面入口：${h.entry.ballShown ? '悬浮球' : '桌面宠物'}（${h.entry.petOn ? '宠物开着，球已让位' : '宠物关着，球顶班'}）。`
      : '';
    el.innerHTML = `${escapeHtml(head + ent)}${hint ? '<br>' + escapeHtml(hint) : ''}`;
  } catch (e) {
    el.textContent = '体检失败：' + ((e && e.message) || e);
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
const schRunning = new Map();   // taskId -> 开始时间（本地乐观标记）
let schTicker = null;
let schLastDone = null;
let curSettingsTab = 'general';

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

  // 任务在后台异步跑，界面靠事件跟上（开始 / 结束 / 排队）
  if (window.xw.onScheduleEvent) {
    window.xw.onScheduleEvent((p) => {
      if (!p) return;
      if (p.type === 'start') {
        schRunning.set(p.id, Date.now());
        if (!p.manual) setToast(`「${p.title}」到点了，正在办…`);
      } else {
        schRunning.delete(p.id);
        if (!p.silent) {
          setToast(p.ok === false
            ? `「${p.title}」没办成：${String(p.text || '').slice(0, 40)}`
            : `「${p.title}」办好了（${Math.round((p.ms || 0) / 1000)}s）`);
        }
        schLastDone = { id: p.id, at: Date.now() };
      }
      if (curSettingsTab === 'schedule') fillSchedule();
    });
  }

  // 运行中的任务要显示已用时长，每秒刷新一次
  if (!schTicker) {
    schTicker = setInterval(() => {
      if (curSettingsTab === 'schedule' && schRunning.size) fillSchedule();
    }, 1000);
  }
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

  box.innerHTML = list.map((t) => {
    const isRunning = schRunning.has(t.id);
    const elapsed = isRunning ? Math.round((Date.now() - schRunning.get(t.id)) / 1000) : 0;
    const last = t.lastResult
      ? `<div class="sched-prompt">上次${t.lastOk === false ? '失败' : ''}：${escapeHtml(String(t.lastResult).slice(0, 80))}</div>`
      : '';
    return `
    <div class="sched-item${t.enabled === false ? ' off' : ''}${isRunning ? ' running' : ''}">
      <div class="sched-main">
        <div class="sched-title">${escapeHtml(t.title)}${t.source === 'ai' ? '<span class="tag-ai">小问自排</span>' : ''}${isRunning ? `<span class="tag-run">运行中 ${elapsed}s</span>` : ''}</div>
        <div class="sched-meta">${escapeHtml(t.whenText)} · ${escapeHtml(t.etaText)}${t.runCount ? ` · 已执行 ${t.runCount} 次` : ''}</div>
        <div class="sched-prompt">${escapeHtml(String(t.prompt || '').slice(0, 90))}</div>
        ${last}
      </div>
      <div class="sched-ops">
        <button class="btn-mini" data-act="run" data-id="${t.id}"${isRunning ? ' disabled' : ''}>${isRunning ? '跑着呢' : '跑一次'}</button>
        <button class="btn-mini" data-act="toggle" data-id="${t.id}">${t.enabled === false ? '启用' : '暂停'}</button>
        <button class="btn-mini danger" data-act="del" data-id="${t.id}">删除</button>
      </div>
    </div>`;
  }).join('');

  box.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      const item = schCache.find((x) => x.id === id);
      if (act === 'run') {
        // 异步执行：踢一脚就走，结果会自己播报过来（不再阻塞界面）
        const r = await window.xw.scheduleRun(id);
        if (r && r.ok === false) {
          setToast(`没能开跑：${r.error || '未知原因'}`);
        } else {
          schRunning.set(id, Date.now());
          setToast(r && r.queued ? '前面还有任务在跑，已排队' : '已经开跑了，结果会主动告诉你');
        }
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

// ---------- 会议纪要（自动检测开会 / 通话，自动记录） ----------
let mtState = null;

function mtClamp(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.round(n), min), max);
}

function mtFmtDur(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
  if (s >= 60) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

function bindMeeting() {
  const switches = [
    ['mtEnabled', 'meetingEnabled'], ['mtAutoRecord', 'meetingAutoRecord'],
    ['mtAskFirst', 'meetingAskFirst'], ['mtHint', 'meetingHint'],
    ['mtMic', 'meetingCaptureMic'], ['mtCam', 'meetingWatchCam'],
    ['mtUnknown', 'meetingUnknownApps']
  ];
  switches.forEach(([id, key]) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', async () => {
      cfg = await window.xw.setConfig({ [key]: el.checked });
      fillMeeting();
    });
  });

  const nums = [
    ['mtPoll', 'meetingPollSec', 2, 60, 5],
    ['mtSegment', 'meetingSegmentMin', 1, 15, 5],
    ['mtMax', 'meetingMaxMinutes', 5, 480, 120],
    ['mtMin', 'meetingMinMinutes', 0, 30, 1],
    ['mtEnter', 'meetingEnterSamples', 1, 6, 2],
    ['mtExit', 'meetingExitSec', 10, 600, 90],
    ['mtSilence', 'meetingSilenceMin', 1, 30, 5]
  ];
  nums.forEach(([id, key, min, max, dflt]) => {
    const el = $(id);
    if (!el) return;
    if (el.type === 'range') {
      el.addEventListener('input', () => { const v = $(`${id}Val`); if (v) v.textContent = el.value; });
    }
    el.addEventListener('change', async () => {
      const v = mtClamp(el.value, min, max, dflt);
      el.value = v;
      const lab = $(`${id}Val`);
      if (lab) lab.textContent = v;
      cfg = await window.xw.setConfig({ [key]: v });
    });
  });

  $('mtDetectNow').addEventListener('click', async () => {
    const box = $('mtDetectResult');
    box.textContent = '正在采样…（读注册表 + 进程列表）';
    const r = await window.xw.meetingDetectNow();
    if (!r || !r.ok) { box.textContent = `采样失败：${(r && r.error) || '未知原因'}`; return; }
    const lv = { meeting: '判定在开会/通话', mic: '有程序在用麦克风（不是会议类）', none: '没有检测到通话' }[r.level] || r.level;
    const lines = [`结论：${lv}${r.app ? ` · ${r.app}` : ''}`, ...(r.reasons || [])];
    // 先说清「这一轮到底看了哪些信号」——否则「没检测到」时用户根本不知道
    // 是环境安静，还是某个信号压根没采（麦克风信号是主判据，永远都在采）
    const DEV = { microphone: '麦克风', webcam: '摄像头' };
    const devs = Array.isArray(r.devices) ? r.devices : ['microphone', 'webcam'];
    lines.push('本轮探测：' + devs.map((d) => DEV[d] || d).join(' + ')
      + (devs.includes('webcam') ? '' : '（摄像头信号按设置关闭）'));
    if (r.micUsers && r.micUsers.length) {
      lines.push('麦克风占用：' + r.micUsers.map((u) => `${u.exe || u.name}${u.stopKnown === false ? '(记录不全)' : ''}`).join('、'));
    } else {
      lines.push('麦克风占用：没有程序在用');
    }
    if (r.procs && r.procs.length) {
      lines.push('识别到的相关进程：' + r.procs.map((p) => `${p.exe}${p.title ? `「${p.title.slice(0, 24)}」` : ''}`).join('、'));
    }
    box.innerHTML = lines.join('<br>');
    refreshMeetingStatus();
  });

  $('mtStart').addEventListener('click', async () => {
    setToast('正在开始记录…');
    const r = await window.xw.meetingStart({});
    setToast(r && r.ok ? '已经开始记录会议纪要' : `没起来：${(r && r.error) || '未知原因'}`);
    refreshMeetingStatus();
  });
  $('mtStop').addEventListener('click', async () => {
    setToast('正在收尾并生成纪要…');
    const r = await window.xw.meetingStop();
    setToast(r && r.ok ? (r.discarded ? '内容太少，没有留纪要' : '纪要已生成') : `没停掉：${(r && r.error) || '未知原因'}`);
    refreshMeetingStatus();
  });
  $('mtFolder').addEventListener('click', () => window.xw.meetingFolder());
  // 看当前转写：录制中「记到哪了」此前只有输入框上方那条一行摘要（还是截断到 40 字的），
  // 想知道实际转写内容只能等结束生成纪要。主进程的 meeting:snapshot-text 一直是有的
  // （取这一段到目前为止的完整转写），界面上没有入口 —— 这里只接线。
  $('mtSnapshot').addEventListener('click', toggleMeetingSnapshot);
  // 搜纪要：主进程侧的 minutes.search() 一直是有的（先给 AI 的 search_minutes 工具用），
  // 界面上却一直没有入口 —— 攒到几十份之后，找「上周那场」只能一个个点开，
  // 或者干脆去文件夹里翻（列表只列最近 15 份，超出只提示「打开纪要文件夹」）。
  // 这里只接线，不重写检索：关键词怎么匹配由 minutes.search() 说了算。
  $('mtSearch').addEventListener('input', () => {
    mtKeyword = $('mtSearch').value;
    if (mtSearchTimer) clearTimeout(mtSearchTimer);
    // 打字时不要每敲一个字就查一次盘（每份纪要都要读 json 才能搜转写内容）
    mtSearchTimer = setTimeout(() => { mtSearchTimer = null; renderMeetingList(); }, 250);
  });
  $('mtSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      mtKeyword = $('mtSearch').value;
      if (mtSearchTimer) { clearTimeout(mtSearchTimer); mtSearchTimer = null; }
      renderMeetingList();
    }
  });
  $('mtSearchClear').addEventListener('click', () => {
    if (mtSearchTimer) { clearTimeout(mtSearchTimer); mtSearchTimer = null; }
    mtKeyword = '';
    $('mtSearch').value = '';
    renderMeetingList();
  });
  $('mtLiveStop').addEventListener('click', async () => {
    setToast('正在收尾并生成纪要…');
    await window.xw.meetingStop();
    refreshMeetingStatus();
  });
}

function fillMeeting() {
  const set = (id, v) => { const el = $(id); if (el) el.checked = v === true; };
  set('mtEnabled', cfg.meetingEnabled !== false);
  set('mtAutoRecord', cfg.meetingAutoRecord !== false);
  set('mtAskFirst', cfg.meetingAskFirst === true);
  set('mtHint', cfg.meetingHint !== false);
  set('mtMic', cfg.meetingCaptureMic !== false);
  set('mtCam', cfg.meetingWatchCam !== false);
  set('mtUnknown', cfg.meetingUnknownApps === true);

  const put = (id, key, dflt) => {
    const el = $(id);
    if (!el) return;
    const v = cfg[key] == null ? dflt : cfg[key];
    el.value = v;
    const lab = $(`${id}Val`);
    if (lab) lab.textContent = v;
  };
  put('mtPoll', 'meetingPollSec', 5);
  put('mtSegment', 'meetingSegmentMin', 5);
  put('mtMax', 'meetingMaxMinutes', 120);
  put('mtMin', 'meetingMinMinutes', 1);
  put('mtEnter', 'meetingEnterSamples', 2);
  put('mtExit', 'meetingExitSec', 90);
  put('mtSilence', 'meetingSilenceMin', 5);
  refreshMeetingStatus();
}

async function refreshMeetingStatus() {
  const el = $('mtStatus');
  if (!el || !window.xw.meetingStatus) return;
  try {
    const s = await window.xw.meetingStatus();
    mtState = s;
    const parts = [];
    parts.push(`功能${s.enabled ? '已开启' : '已关闭'}`);
    parts.push(s.recording ? `正在记录「${s.session.app}」（${mtFmtDur(s.session.durationMs)}，${s.session.chars} 字）` : '当前没有在记录');
    if (s.asrBusy && !s.recording) parts.push('语音识别正被语音问答占用');
    const d = s.lastDetect;
    if (d) {
      const lv = { meeting: '在开会', mic: '有应用用麦', none: '无' }[d.level] || d.level;
      parts.push(`最近一次采样：${lv}${d.app ? ` · ${d.app}` : ''}（${new Date(d.at).toLocaleTimeString('zh-CN', { hour12: false })}）`);
    } else {
      parts.push('还没采样过（启动 20 秒后开始）');
    }
    if (s.stats && s.stats.count) {
      parts.push(`已存 ${s.stats.count} 份纪要，今天 ${s.stats.todayCount} 场 / ${mtFmtDur(s.stats.todayMs)}`);
    }
    el.innerHTML = parts.join('<br>')
      + (d && d.reasons && d.reasons.length ? `<br><span style="opacity:.7">理由：${d.reasons[0]}</span>` : '');
    updateMtLive(s);
    renderMeetingList();
    // 预览框开着时跟着这次轮询一起刷新；关着的话这个函数自己会早退，不发请求。
    refreshMeetingSnapshot();
  } catch (e) {
    el.textContent = '状态：读取失败';
  }
}

/** 输入框上方的「正在记录」条 */
function updateMtLive(s) {
  const bar = $('mtLive');
  if (!bar) return;
  const on = !!(s && s.recording);
  bar.hidden = !on;
  if (!on) return;
  const t = $('mtLiveText');
  if (t) {
    const last = mtLastLine ? `：${mtLastLine}` : '';
    t.textContent = `正在记录「${s.session.app}」${mtFmtDur(s.session.durationMs)} · ${s.session.chars} 字${last}`;
  }
}

let mtLastLine = '';
let mtListCache = [];
/** 纪要列表当前的搜索关键词（空 = 按时间倒序列出最近若干份） */
let mtKeyword = '';
let mtSearchTimer = null;
/**
 * 当前展开全文的那份纪要 id（空 = 没展开）。
 *
 * 展开态存在这里、**不放在列表行里**：列表每 5 秒随状态刷新一起重建，
 * 写在行内的话刚点开就被冲掉；转写很长，重建成「回到顶部」还会让人丢阅读位置。
 */
let mtDetailId = '';
/** 录制中转写预览是否展开 */
let mtSnapshotOpen = false;

/** 拉取当前这一段的完整转写（meeting:snapshot-text）。只在预览框展开时拉。 */
async function refreshMeetingSnapshot() {
  const box = $('mtSnapshotBox');
  if (!box || box.hidden) return;
  if (!window.xw.meetingSnapshotText) return;
  let r = null;
  try {
    r = await window.xw.meetingSnapshotText();
  } catch (e) {
    r = null;
  }
  if (!r || !r.ok) {
    box.textContent = `读取失败：${(r && r.error) || '未知原因'}`;
    return;
  }
  const text = String(r.text || '').replace(/[ \t]+$/gm, '').trim();
  // 「还没内容」与「读不出来」要说成两句不同的话 —— 否则刚开录时会像出了故障。
  box.textContent = text
    ? `${text}\n\n（本段累计 ${r.chars || 0} 字，随记录实时增长）`
    : '这一段还没有可用内容（刚开录，或者目前只有噪音 / 静音）。';
}

/** 展开 / 收起「当前转写」预览 */
async function toggleMeetingSnapshot() {
  const box = $('mtSnapshotBox');
  if (!box) return;
  mtSnapshotOpen = !mtSnapshotOpen;
  box.hidden = !mtSnapshotOpen;
  if (!mtSnapshotOpen) {
    box.textContent = '';
    return;
  }
  await refreshMeetingSnapshot();
  box.scrollIntoView({ block: 'nearest' });
}

/**
 * 展开 / 收起一份纪要的全文（含转写）。
 *
 * `meetingGet` 一直在 preload 里挂着，界面只用索引行（标题 / 时长 / 字数 / 话题），
 * 想看要点与待办只能「打开」丢给系统默认程序，或者去文件夹里翻 .json ——
 * 而用户真正的问题「刚才那个会记了什么、我答应干什么」就卡在这一步。
 */
async function toggleMeetingDetail(id) {
  const box = $('mtDetail');
  if (!box || !id) return;
  if (mtDetailId === id) {
    mtDetailId = '';
    box.hidden = true;
    box.textContent = '';
    markMeetingDetailButtons();
    return;
  }
  if (!window.xw.meetingGet) return;
  let rec = null;
  try {
    rec = await window.xw.meetingGet(id);
  } catch (e) {
    rec = null;
  }
  mtDetailId = id;
  box.hidden = false;
  box.textContent = '';
  if (!rec) {
    // 索引行在、文件读不到（被外面删掉或移走了）：如实说，别显示一个空壳。
    box.textContent = '这份纪要的正文读不出来了 —— 文件可能已被移走或删除，索引里还留着这一行。';
    markMeetingDetailButtons();
    return;
  }

  const head = document.createElement('div');
  head.className = 'mt-detail-head';
  head.textContent = rec.title || rec.app || rec.id;
  box.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'mt-detail-meta';
  const s = rec.summary || {};
  meta.textContent = [
    rec.startedAt ? new Date(rec.startedAt).toLocaleString('zh-CN', { hour12: false }) : '',
    mtFmtDur(rec.durationMs || 0),
    `${(rec.stats && rec.stats.chars) || 0} 字`,
    (s.todos || []).length ? `${s.todos.length} 项待办` : ''
  ].filter(Boolean).join(' · ');
  box.appendChild(meta);

  // 摘要按「主题 / 要点 / 结论 / 待办 / 风险与疑问」逐段列；缺哪段就不显示哪段。
  if (s.topic) addMtDetailSection(box, '主题', [s.topic]);
  addMtDetailSection(box, '要点', s.points);
  addMtDetailSection(box, '结论', s.decisions);
  if (Array.isArray(s.todos) && s.todos.length) {
    addMtDetailSection(box, '待办', s.todos.map((t) => `☐ ${t}`));
  }
  addMtDetailSection(box, '风险与疑问', s.risks);
  if (!s.topic && !(s.points || []).length) {
    // 摘要没生成出来时给原文，不要让用户以为「这份纪要没内容」
    addMtDetailSection(box, '摘要', [s.raw || '（这次没有生成摘要）']);
  }

  const ta = document.createElement('div');
  ta.className = 'mt-detail-label';
  ta.textContent = '全文转写';
  box.appendChild(ta);
  const pre = document.createElement('pre');
  pre.className = 'mt-detail-text';
  pre.textContent = String(rec.transcript || '').trim() || '（这份纪要没有转写内容）';
  box.appendChild(pre);

  box.scrollIntoView({ block: 'nearest' });
  markMeetingDetailButtons();
}

/** 往详情里加一段小标题 + 条目 */
function addMtDetailSection(box, label, items) {
  const list = (Array.isArray(items) ? items : []).map((x) => String(x)).filter((x) => x.trim());
  if (!list.length) return;
  const t = document.createElement('div');
  t.className = 'mt-detail-label';
  t.textContent = label;
  box.appendChild(t);
  const ul = document.createElement('ul');
  ul.className = 'mt-detail-list';
  for (const it of list) {
    const li = document.createElement('li');
    li.textContent = it;
    ul.appendChild(li);
  }
  box.appendChild(ul);
}

/** 列表每次重建后，把「看」按钮的展开态补回来（状态在 mtDetailId 里，不在 DOM 里） */
function markMeetingDetailButtons() {
  const box = $('mtList');
  if (!box) return;
  for (const b of box.querySelectorAll('button[data-mt-detail]')) {
    const on = !!mtDetailId && b.getAttribute('data-mt-detail') === mtDetailId;
    b.textContent = on ? '收起' : '看';
    b.title = on ? '收起这份纪要的要点与转写' : '看要点、待办与全文转写';
  }
}

async function renderMeetingList() {
  const box = $('mtList');
  if (!box || !window.xw.meetingList) return;
  const kw = String(mtKeyword || '').trim();
  let rows = [];
  try {
    if (kw && window.xw.meetingSearch) {
      // limit 传 30：默认值是给 AI 工具留的 5 条，列表里只回 5 条会让人以为「只有 5 份」
      rows = await window.xw.meetingSearch(kw, 30);
    } else {
      rows = await window.xw.meetingList();
    }
  } catch (e) {
    rows = [];
  }
  mtListCache = rows || [];
  const hintEl = $('mtSearchHint');
  if (hintEl) {
    hintEl.textContent = kw
      ? `搜索「${kw}」：${mtListCache.length} 份${mtListCache.length >= 30 ? '（只显示前 30 份，缩小关键词试试）' : ''}`
      : '';
  }
  if (!rows.length) {
    box.innerHTML = kw
      ? `<div class="hint">没有匹配「${escapeHtml(kw)}」的纪要。关键词会匹配标题、应用名、话题与转写内容；点「全部」回到列表。</div>`
      : '<div class="hint">还没有记录过会议</div>';
    return;
  }
  box.textContent = '';
  for (const r of rows.slice(0, 15)) {
    const item = document.createElement('div');
    item.className = 'mt-item';

    const main = document.createElement('div');
    main.className = 'mt-item-main';
    const title = document.createElement('div');
    title.className = 'mt-item-title';
    title.textContent = r.title || r.app || r.id;
    const sub = document.createElement('div');
    sub.className = 'mt-item-sub';
    const when = r.startedAt ? new Date(r.startedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    sub.textContent = [when, mtFmtDur(r.durationMs), `${r.chars || 0} 字`, r.todoCount ? `${r.todoCount} 项待办` : ''].filter(Boolean).join(' · ');
    main.appendChild(title);
    main.appendChild(sub);
    if (r.topic) {
      const topic = document.createElement('div');
      topic.className = 'mt-item-topic';
      topic.textContent = r.topic;
      main.appendChild(topic);
    }

    const acts = document.createElement('div');
    acts.className = 'mt-item-acts';
    // 「看」= 在主进程里取这份纪要的完整记录（含要点 / 待办 / 全文转写），
    // 不离开本窗口就能回答「刚才那个会记了什么、我答应干什么」。
    const bView = document.createElement('button');
    bView.setAttribute('data-mt-detail', r.id);
    bView.textContent = '看';
    bView.onclick = () => toggleMeetingDetail(r.id);
    const bOpen = document.createElement('button');
    bOpen.textContent = '打开';
    bOpen.title = '用系统默认程序打开 Markdown 纪要';
    bOpen.onclick = () => window.xw.meetingOpen(r.id);
    const bDel = document.createElement('button');
    bDel.textContent = '删除';
    bDel.className = 'danger';
    bDel.onclick = async () => {
      if (!confirm(`删除这份纪要？\n${r.title || r.id}`)) return;
      if (mtDetailId === r.id) { mtDetailId = ''; const d = $('mtDetail'); if (d) { d.hidden = true; d.textContent = ''; } }
      await window.xw.meetingRemove(r.id);
      setToast('已删除');
      renderMeetingList();
      refreshMeetingStatus();
    };
    acts.appendChild(bView);
    acts.appendChild(bOpen);
    acts.appendChild(bDel);

    item.appendChild(main);
    item.appendChild(acts);
    box.appendChild(item);
  }
  if (rows.length > 15) {
    const more = document.createElement('div');
    more.className = 'hint';
    more.textContent = kw
      ? `还有 ${rows.length - 15} 份匹配，缩小关键词或复制到文件夹里看`
      : `还有 ${rows.length - 15} 份，用上面的搜索框按关键词找，或点「打开纪要文件夹」看全部`;
    box.appendChild(more);
  }
  // 列表重建后把展开态补回来（状态在 mtDetailId 里，DOM 是每 5 秒新建的）
  markMeetingDetailButtons();
}

/** 会议事件（检测到 / 开录 / 出纪要 / 丢弃）都会走到这里 */
function bindMeetingEvents() {
  try {
    window.xw.onMeetingEvent((p) => {
      if (!p) return;
      const t = p.type;
      if (t === 'started') {
        setToast(`开始记录「${(p.session && p.session.app) || '会议'}」纪要`);
        updateMtLive(p);
      } else if (t === 'saved') {
        setToast('会议纪要已生成');
        refreshMeetingStatus();
      } else if (t === 'discarded') {
        setToast('这次内容太少，没有留纪要');
        updateMtLive(p);
      } else if (t === 'removed') {
        renderMeetingList();
      } else {
        refreshMeetingStatus();
      }
    });
  } catch (e) { /* ignore */ }

  try {
    window.xw.onMeetingLive((p) => {
      if (!p) return;
      mtLastLine = String(p.text || '').slice(-40);
      const bar = $('mtLive');
      if (bar && !bar.hidden) {
        const t = $('mtLiveText');
        if (t && mtState && mtState.session) {
          t.textContent = `正在记录「${mtState.session.app}」· ${p.chars || 0} 字：${mtLastLine}`;
        }
      }
      // 设置页开着的话同步刷一下字数
      const el = $('mtStatus');
      if (el && mtState && mtState.recording) refreshMeetingStatus();
    });
  } catch (e) { /* ignore */ }
}

// ---------- 主进程主动播报（定时任务 / 地震 / 热搜 / 会议） ----------
// 正在进行的主动播报：title -> card（回执先落地，结果回来时再改写同一张卡）
const proactiveCards = new Map();

// 播报来源的中文标签：卡片标题已经写清了「是什么事」，这里只标「哪儿来的」
const KIND_LABEL = {
  hot: '热搜', quake: '地震', schedule: '定时任务', watch: '关注',
  notice: '提醒', capture: '截图', update: '升级', news: '资讯', weather: '天气',
  meeting: '会议'
};

function proactiveCard(title, kind, state) {
  const card = createTaskCard(title, { kind: 'proactive', state });
  const head = card.querySelector('.tcard-kind');
  if (head) {
    // 认不出来的来源就不标了，免得给主人看一串英文 id
    const label = KIND_LABEL[kind] || '';
    if (label) head.textContent = label;
    else head.remove();
  }
  els.messages.appendChild(card);
  card.dataset.closed = '1';
  return card;
}

/** 标题已经在卡头上了，正文只放内容，别再复述一遍 */
function fillProactiveBubble(card, title, text) {
  const bubble = card.querySelector('.bubble');
  if (bubble) bubble.innerHTML = renderMarkdown(text);
}

/**
 * 播报卡片上的「一键动作」。
 * 主进程只能说「这件事可以做什么」（actions 里全是 id），按钮长什么样、点了干什么
 * 由界面决定 —— 这样以后加动作不用改主进程，也不用给界面塞 HTML。
 */
const PROACTIVE_ACTIONS = {
  'meeting-start': {
    label: '🎙 开始记录',
    title: '现在就开始把声音转成文字',
    run: async () => {
      setToast('正在开始记录…');
      const r = await window.xw.meetingStart({});
      setToast(r && r.ok ? '已开始记录会议纪要' : `没起来：${(r && r.error) || '未知原因'}`);
      refreshMeetingStatus();
      return r && r.ok ? '已在记录' : '重试';
    }
  },
  'meeting-stop': {
    label: '⏹ 停止记录',
    title: '结束记录并生成纪要',
    run: async () => {
      setToast('正在收尾并生成纪要…');
      const r = await window.xw.meetingStop();
      setToast(r && r.ok ? (r.discarded ? '内容太少，没有留纪要' : '会议纪要已生成') : `没停掉：${(r && r.error) || '未知原因'}`);
      refreshMeetingStatus();
      return '已结束';
    }
  }
};

function appendProactiveActions(card, actions) {
  if (!Array.isArray(actions) || !actions.length) return;
  const foot = card.querySelector('.tcard-foot');
  if (!foot) return;
  foot.hidden = false;
  let bar = foot.querySelector('.msg-actions.proactive-acts');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'msg-actions proactive-acts';
    foot.appendChild(bar);
  }
  for (const id of actions) {
    const spec = PROACTIVE_ACTIONS[id];
    if (!spec || bar.querySelector(`[data-act="${id}"]`)) continue;
    const b = document.createElement('button');
    b.textContent = spec.label;
    b.title = spec.title || '';
    b.dataset.act = id;
    b.onclick = async () => {
      b.disabled = true;
      const old = b.textContent;
      b.textContent = '处理中…';
      try {
        const done = await spec.run();
        b.textContent = done || '已完成';
        setTimeout(() => { b.disabled = false; b.textContent = old; }, 6000);
      } catch (e) {
        b.textContent = '失败了';
        b.disabled = false;
      }
    };
    bar.appendChild(b);
  }
}

function bindProactive() {
  try {
    window.xw.onProactive((p) => {
      if (!p || !p.text) return;
      const title = String(p.title || '小问提醒');
      const phase = String(p.phase || 'done');

      // 回执 / 进度：同一件事只留一张卡，先把「我在干了」摊出来
      if (phase === 'ack' || phase === 'progress') {
        let card = proactiveCards.get(title);
        if (!card || !card.isConnected) {
          card = proactiveCard(title, p.kind, 'work');
          proactiveCards.set(title, card);
        }
        setCardState(card, 'work');
        fillProactiveBubble(card, title, p.text);
        setStatus(`${title} · 执行中…`);
        scrollToBottom();
        return;
      }

      // 结果：优先改写那张还在跑的回执卡，没有再新开一张
      let card = proactiveCards.get(title);
      if (card && card.isConnected) proactiveCards.delete(title);
      else card = proactiveCard(title, p.kind, 'done');

      setCardState(card, 'done');
      fillProactiveBubble(card, title, p.text);
      const foot = card.querySelector('.tcard-foot');
      if (foot && !foot.querySelector('.msg-actions')) {
        foot.hidden = false;
        foot.appendChild(buildActions(p.text, card.querySelector('.bubble'), card));
      }
      // 播报自带的操作（比如「检测到你在开会」这张卡上的开始 / 停止记录）
      appendProactiveActions(card, p.actions);
      scrollToBottom();
      setStatus(title);

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

/**
 * 剪贴板感知带进来的一段内容（报错 / 代码 / 链接）。
 * 填的是**主进程按内容类型写好的问句 + 内容**（question 字段，模板在
 * clip-sense.js 里，渲染进程不重复一份），主人可以改，但按回车就发 ——
 * 仍然不代发：发不发由他决定。
 * 输入框已有草稿时不覆盖：宁可让他再粘一次，也不能把他正在写的东西冲掉。
 */
function attachClip(payload) {
  const text = payload && typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) return;
  if (els.input.value.trim()) {
    setStatus('输入框里已有草稿，剪贴板那段没覆盖，可以 Ctrl+V 自己粘');
    return;
  }
  const q = payload && typeof payload.question === 'string' && payload.question.trim() ? payload.question : text;
  els.input.value = q;
  if (typeof autoResize === 'function') autoResize();
  els.input.focus();
  try { els.input.setSelectionRange(q.length, q.length); } catch (e) { /* ignore */ }
  setStatus((payload && payload.hint) || '剪贴板那段已带过来，想问什么直接说');
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

// ================== 快捷键录制 ==================
/**
 * 把 KeyboardEvent 翻译成 Electron 的 accelerator。
 * 返回 null 表示这个键不能单独作为快捷键（纯修饰键 / 不支持）。
 */
function hkAccelFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');

  const k = e.key;
  const NAV = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Enter: 'Return', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    Insert: 'Insert', PrintScreen: 'PrintScreen', ' ': 'Space',
    '+': 'Plus', '-': 'Minus', '=': 'Equal', ',': 'Comma', '.': 'Period',
    '/': 'Slash', ';': 'Semicolon', "'": 'Quote', '`': 'Backquote',
    '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash'
  };
  const PURE_MOD = ['Control', 'Alt', 'Shift', 'Meta', 'ContextMenu', 'CapsLock', 'OS'];

  let key = null;
  if (PURE_MOD.includes(k)) return null;
  if (/^F\d{1,2}$/.test(k)) key = k;
  else if (Object.prototype.hasOwnProperty.call(NAV, k)) key = NAV[k];
  else if (k.length === 1) key = k.toUpperCase();
  if (!key) return null;

  // 字母数字必须带修饰键，否则会把整个键盘抢走
  const isFn = /^F\d{1,2}$/.test(key);
  if (!mods.length && !isFn) return null;

  return mods.concat(key).join('+');
}

/**
 * 给一个只读输入框装上「录制」能力。
 * @param {{inputId:string,btnId:string,clearId?:string,label:string,onApply:(v:string)=>Promise<void>|void}} o
 */
function setupHotkeyRecorder(o) {
  const input = $(o.inputId);
  const btn = $(o.btnId);
  if (!input || !btn) return;
  const clearBtn = o.clearId ? $(o.clearId) : null;
  let recording = false;
  let saved = input.value;

  const stop = () => {
    recording = false;
    input.classList.remove('recording');
    input.blur();
    btn.textContent = '录制';
    if (!input.value) input.value = saved;
  };

  btn.addEventListener('click', () => {
    recording = true;
    saved = input.value;
    input.classList.add('recording');
    input.value = '';
    input.placeholder = '按下组合键…（Esc 取消，Delete 清空）';
    btn.textContent = '取消';
    input.focus();
  });

  input.addEventListener('blur', () => {
    if (recording) stop();
  });

  input.addEventListener('keydown', async (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') { stop(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      input.value = '';
      stop();
      setToast(hotkeyToast(o.label, await o.onApply(''), ''));
      return;
    }

    const accel = hkAccelFromEvent(e);
    if (!accel) {
      input.placeholder = '需要至少一个修饰键（Ctrl / Alt / Shift）…';
      return;
    }

    // 先问主进程这个键能不能注册，能才落盘
    let probe = { ok: true };
    try { probe = await window.xw.captureProbeHotkey(accel); } catch (err) { probe = { ok: true }; }
    if (probe && probe.ok === false) {
      input.value = '';
      input.placeholder = probe.error || '这个组合键用不了';
      input.classList.add('recording');
      return;
    }

    input.value = accel;
    stop();
    setToast(hotkeyToast(o.label, await o.onApply(accel), accel));
  });
}

/**
 * 快捷键落地之后该说什么 —— **以主进程回报的实际键位为准，不猜**。
 *
 * 空值不等于「清空」：三个注册函数都会把空值归一回默认键，所以清空之后
 * 实际生效的是默认键。以前这里直接说「已清空」，界面说的和系统里挂的
 * 不是一回事（更早还因为上游用了真值判断，连归一那一步都没走到）。
 * @param {string} label 这个键的名字，如「框选截图」
 * @param {{accel?:string,error?:string}|void} back onApply 的回报
 * @param {string} want 用户想录进去的键（'' 表示清空）
 */
function hotkeyToast(label, back, want) {
  const accel = (back && back.accel) || '';
  if (back && back.error) return `${label}快捷键没能生效：${back.error}`;
  if (!accel) return `${label}快捷键${want ? '已提交' : '已清空'}`;
  if (!want) return `${label}快捷键已清空，回落默认 ${accel}`;
  return `${label}快捷键已设为 ${accel}`;
}

/**
 * 从主进程回报的注册结果里取某个快捷键的实际落地情况 —— 猜不如问。
 * 「关着截图功能」和「注册失败」是两回事，都得能说出来。
 * @returns {{accel?:string,error?:string}}
 */
function hotkeyOutcome(st, label) {
  if (!st) return { error: '主进程没有回报注册结果' };
  if (st.enabled === false) return { error: '截图功能当前是关闭的' };
  const it = (st.items || []).find((i) => i.label === label);
  if (!it) return { error: '主进程没有回报这个键的注册结果' };
  return it.ok ? { accel: it.accel } : { error: it.error || '注册失败' };
}

/** 显示截图快捷键注册结果（占用 / 非法都会如实说） */
function renderHotkeyState(st) {
  const el = $('capHkState');
  if (!el) return;
  if (!st) { el.textContent = ''; return; }
  if (st.enabled === false) {
    el.innerHTML = '<span class="hk-state-bad">截图快捷键已关闭</span>';
    return;
  }
  const items = st.items || [];
  if (!items.length) { el.textContent = '快捷键状态：—'; return; }
  el.innerHTML = items.map((it) => (it.ok
    ? `<span class="hk-state-ok">✅ ${it.label} ${it.accel}</span>`
    : `<span class="hk-state-bad">❌ ${it.label}：${it.error}</span>`
  )).join('　');
}

// ================== 剪贴板感知 ==================
// 开关 + 规则编辑。规则文本与 config.json 里的 `clipSenseRules` 是同一份，但
// **校验走主进程**：哪些字段合法、哪些条目会被静默丢弃、凭证为什么不可关闭，
// 这些知识只有 `src/main/clip-sense.js` 一份，界面不重复实现一遍。
//
// 界面上要显示的是「**实际生效的结果**」而不是用户填的原文：compileRules 对写错的
// 条目一律只警告不抛，只回显原文的话，用户看不出「填了 5 条、只生效 1 条」。
//
// 内置类型的显示名由主进程下发（`clip-sense.js` 的 BUILTIN_LABELS 是唯一来源），
// 界面这里**只缓存不定义** —— 自己再抄一份的话，将来新增一类时界面会显示原始 id，
// 而且没有任何东西会报错提示你抄漏了。
let clipKindLabels = {};

function clipLabelOf(kind) {
  return clipKindLabels[kind] || kind;
}

const CLIP_RULES_SAMPLE = {
  disableKinds: ['url'],
  ignorePatterns: ['^\\[内部\\]'],
  customKinds: [
    {
      id: 'corp-log',
      label: '公司日志',
      pattern: '^\\[corp\\]',
      flags: 'im',
      title: '这段公司日志要我看看吗？',
      ask: '帮我分析这段公司日志。'
    }
  ]
};

let clipRulesTimer = null;

function clipRulesEl() {
  return $('clipRules');
}

function clipRulesText() {
  const el = clipRulesEl();
  return el ? String(el.value || '').trim() : '';
}

/** 把校验结果画到界面上，返回主进程的原始结果（保存前要判 ok） */
function renderClipRulesResult(r) {
  const box = $('clipRulesResult');
  if (!box) return r;
  box.textContent = '';
  const add = (cls, text) => {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    box.appendChild(d);
  };
  if (!r || !r.ok) {
    add('cb-err', '✗ ' + ((r && r.error) || '校验失败，规则未生效'));
    return r;
  }
  // 主进程随校验结果一起下发内置类型的显示名，缓存下来给摘要和试跑共用
  if (r.labels && Object.keys(r.labels).length) clipKindLabels = r.labels;
  const s = r.summary || {};
  const active = (s.activeKinds || []).map(clipLabelOf);
  const parts = ['仍然提示：' + (active.length ? active.join(' / ') : '（内置类型已全部关闭）')];
  if ((s.disabledKinds || []).length) parts.push('已关闭：' + s.disabledKinds.join(' / '));
  parts.push('忽略正则 ' + (s.ignoreCount || 0) + ' 条');
  const custom = s.custom || [];
  parts.push(
    '自定义类型 ' + custom.length + ' 个' + (custom.length ? '（' + custom.map((c) => c.label).join(' / ') + '）' : '')
  );
  const warns = r.warnings || [];
  // 「凭证始终识别」在任何配置下都成立，索性钉在摘要里 —— 用户在改「关闭哪些类型」时
  // 最容易产生的误解就是「那我能不能把密钥那条也关了」。
  add('cb-note', '✓ 生效结果 — ' + parts.join('　·　') + '　·　凭证始终识别（不可关闭）' + (warns.length ? '' : '（无警告）'));
  for (const w of warns) add('cb-warn', '⚠ ' + w);
  return r;
}

async function validateClipRules() {
  let r = null;
  try {
    r = await window.xw.clipRulesParse(clipRulesText());
  } catch (e) {
    r = { ok: false, error: String((e && e.message) || e) };
  }
  return renderClipRulesResult(r);
}

function scheduleClipValidate() {
  if (clipRulesTimer) clearTimeout(clipRulesTimer);
  clipRulesTimer = setTimeout(() => {
    clipRulesTimer = null;
    validateClipRules();
    // 试跑的结果取决于当前这份（可能还没保存的）规则，规则一改就得重算，
    // 否则界面上会留着上一次规则下的结论 —— 比不显示更容易误导人。
    scheduleClipTest();
  }, 250);
}

async function saveClipRules() {
  // 校验不过就不落盘：写进配置的必须是通过校验的那一份
  const r = await validateClipRules();
  if (!r || !r.ok) {
    setToast('规则有误，未保存');
    return;
  }
  try {
    cfg = await window.xw.setConfig({ clipSenseRules: r.value || {} });
    const el = clipRulesEl();
    if (el) delete el.dataset.dirty;
    setToast('规则已保存，立即生效');
  } catch (e) {
    setToast('保存失败：' + ((e && e.message) || e));
  }
}

function fillClipSense() {
  const on = $('clipEnabled');
  if (!on) return;
  on.checked = !!cfg.clipSenseEnabled;
  const el = clipRulesEl();
  // 编辑到一半（dirty）不能被配置刷新覆盖掉 —— 同输入框草稿的处理
  if (el && !el.dataset.dirty) {
    const v = cfg.clipSenseRules;
    el.value = v && Object.keys(v).length ? JSON.stringify(v, null, 2) : '';
  }
  validateClipRules();
}

function bindClipSense() {
  const on = $('clipEnabled');
  if (on) {
    on.addEventListener('change', async () => {
      try {
        cfg = await window.xw.setConfig({ clipSenseEnabled: on.checked });
        setToast(on.checked ? '剪贴板感知已开启' : '剪贴板感知已关闭');
      } catch (e) {
        on.checked = !on.checked;
        setToast('保存失败：' + ((e && e.message) || e));
      }
    });
  }
  const el = clipRulesEl();
  if (el) {
    el.addEventListener('input', () => {
      el.dataset.dirty = '1';
      scheduleClipValidate();
    });
  }
  const sample = $('clipRulesSample');
  if (sample) {
    sample.addEventListener('click', () => {
      if (el) {
        el.value = JSON.stringify(CLIP_RULES_SAMPLE, null, 2);
        el.dataset.dirty = '1';
      }
      validateClipRules();
    });
  }
  const clear = $('clipRulesClear');
  if (clear) {
    clear.addEventListener('click', () => {
      if (el) {
        el.value = '';
        el.dataset.dirty = '1';
      }
      validateClipRules();
    });
  }
  const save = $('clipRulesSave');
  if (save) save.addEventListener('click', saveClipRules);

  // ---- 导入 / 导出 ----
  // 导出的是**输入框里当前这一份**（含还没保存的编辑）：想先试一版再决定要不要存时，
  // 导出的正是他眼前看到的那份，而不是 config.json 里的旧版。
  const exp = $('clipRulesExport');
  if (exp) {
    exp.addEventListener('click', async () => {
      // 先校验：导出一份自己都编译不过的规则没有意义，原因得留在导出方手里
      const r = await validateClipRules();
      if (!r || !r.ok) {
        setToast('规则有误，先改好再导出');
        return;
      }
      let res = null;
      try {
        res = await window.xw.clipRulesExport(clipRulesText());
      } catch (e) {
        setToast('导出失败：' + ((e && e.message) || e));
        return;
      }
      if (!res || res.canceled) return;
      if (!res.ok) {
        setToast('导出失败：' + (res.error || '未知原因'));
        return;
      }
      const warns = (res.warnings || []).length;
      setToast('已导出到 ' + res.filePath + (warns ? `（有 ${warns} 条警告，见上方摘要）` : ''));
    });
  }

  const imp = $('clipRulesImport');
  if (imp) {
    imp.addEventListener('click', async () => {
      let res = null;
      try {
        res = await window.xw.clipRulesImport();
      } catch (e) {
        setToast('导入失败：' + ((e && e.message) || e));
        return;
      }
      if (!res || res.canceled) return;
      if (!res.ok) {
        setToast('导入失败：' + (res.error || '未知原因'));
        return;
      }
      // 导入只填进输入框、**不自动保存**：换机器时最怕是「导进来一份不对的规则
      // 直接生效」—— 那样连原来的规则都没了。让用户看过摘要再点保存。
      if (el) {
        el.value = res.text;
        el.dataset.dirty = '1';
        el.scrollIntoView({ block: 'nearest' });
      }
      const r = await validateClipRules();
      scheduleClipTest();
      if (r && r.ok) {
        setToast('已读入 ' + res.filePath + '，确认摘要无误后点「保存规则」才会生效');
      } else {
        setToast('读入的内容不是合法规则，请改好或重新导入');
      }
    });
  }
}

// ---- 拿一段内容试试 ----
// 为什么需要它：compileRules 只对**写坏**的规则报警（正则编译不过、字段名不认识），
// 对「规则本身没毛病、但这台机器上永远不会命中」一声不吭。主人照着示例写完一条
// `^\[corp\]`，复制公司日志毫无反应，此时他手上没有任何自证手段 —— 只能怀疑功能坏了。
// 判定链是硬编码的，从界面上根本看不出到底是「写错了」还是「压根没轮到它」。
let clipTestTimer = null;

function clipTestEl() {
  return $('clipTestText');
}

function clipTestText() {
  const el = clipTestEl();
  return el ? String(el.value || '') : '';
}

function renderClipTestResult(r) {
  const box = $('clipTestResult');
  if (!box) return r;
  box.textContent = '';
  const add = (cls, text) => {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    box.appendChild(d);
  };
  // 没贴内容就不占地方（.cb-result:empty 会自动收起）
  if (!clipTestText().trim()) return r;
  if (!r || !r.ok) {
    add('cb-err', '✗ 规则有误，先在上面改好再试：' + ((r && r.error) || '无法试跑'));
    return r;
  }
  if (r.labels && Object.keys(r.labels).length) clipKindLabels = r.labels;
  const v = r.verdict || {};
  if (v.worth) {
    const how = v.stage === 'custom' ? '你配的自定义类型' : '内置类型';
    add('cb-note', `✓ 会提示 —— 判为「${v.label || clipLabelOf(v.kind)}」（${how}），横幅上显示：${v.title}`);
    if (v.question) add('cb-ask', '复制后会自动填进输入框（仍要你按回车才发出去）：\n' + v.question);
    add('cb-warn', '提示本身还有 20 秒冷却期，这里试跑不受影响。');
  } else {
    add('cb-warn', `✗ 不会提示 —— ${v.reasonText}${v.detail ? '：' + v.detail : ''}`);
    if (v.reason === 'secret') {
      add('cb-note', '这是硬保护：既不会提示，内容也不会被带进任何地方。');
    } else if (v.reason === 'ignored') {
      add('cb-note', '是上面 ignorePatterns 里那条正则拦下的，改它或删掉即可。');
    } else if (v.reason === 'disabled') {
      add('cb-note', '把 disableKinds 里对应的类型去掉就会恢复提示。');
    }
  }
  return r;
}

async function runClipTest() {
  let r = null;
  try {
    r = await window.xw.clipRulesTest(clipTestText(), clipRulesText());
  } catch (e) {
    r = { ok: false, error: String((e && e.message) || e) };
  }
  return renderClipTestResult(r);
}

function scheduleClipTest() {
  if (clipTestTimer) clearTimeout(clipTestTimer);
  clipTestTimer = setTimeout(() => {
    clipTestTimer = null;
    runClipTest();
  }, 250);
}

function bindClipTest() {
  const el = clipTestEl();
  if (el) el.addEventListener('input', scheduleClipTest);
  const paste = $('clipTestPaste');
  if (paste) {
    paste.addEventListener('click', async () => {
      try {
        const r = await window.xw.clipboardRead();
        if (!r || !r.ok) {
          setToast('读剪贴板失败：' + ((r && r.error) || '未知原因'));
          return;
        }
        if (el) el.value = r.text || '';
        if (!String(r.text || '').trim()) {
          setToast('剪贴板里没有文本');
        }
        await runClipTest();
      } catch (e) {
        setToast('读剪贴板失败：' + ((e && e.message) || e));
      }
    });
  }
  const clear = $('clipTestClear');
  if (clear) {
    clear.addEventListener('click', () => {
      if (el) el.value = '';
      renderClipTestResult(null);
    });
  }
}

// ================== 截图与更新设置 ==================
function bindCapture() {
  const toggles = {
    capEnabled: 'captureEnabled',
    upEnabled: 'autoUpdate',
    upSilent: 'autoUpdateSilent',
    upSilentInstall: 'autoUpdateSilentInstall',
    upIdleInstall: 'autoUpdateInstallWhenIdle',
    upOnQuit: 'autoUpdateInstallOnQuit',
    upPre: 'autoUpdatePrerelease'
  };
  Object.entries(toggles).forEach(([id, key]) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', async () => {
      cfg = await window.xw.setConfig({ [key]: el.checked });
      setToast('已保存');
      if (id === 'capEnabled') renderHotkeyState(await window.xw.captureHotkeys());
    });
  });

  // 截图快捷键：不再让主人手打字符串（写错一个空格就静默失效），
  // 改成「录制」——按下组合键即写入，并立刻回显能不能用。
  // onApply 必须回报**实际生效的键**：空值会被主进程归一回默认键，
  // 界面自己猜就会像以前那样提示「已清空」，而系统里挂的是默认键。
  setupHotkeyRecorder({
    inputId: 'capRegionKey', btnId: 'capRegionRec', clearId: 'capRegionClear',
    label: '框选截图',
    onApply: async (v) => {
      cfg = await window.xw.setConfig({ captureRegionHotkey: v });
      const st = await window.xw.captureHotkeys();
      renderHotkeyState(st);
      return hotkeyOutcome(st, '框选截图');
    }
  });
  setupHotkeyRecorder({
    inputId: 'capFullKey', btnId: 'capFullRec', clearId: 'capFullClear',
    label: '整屏截图',
    onApply: async (v) => {
      cfg = await window.xw.setConfig({ captureFullHotkey: v });
      const st = await window.xw.captureHotkeys();
      renderHotkeyState(st);
      return hotkeyOutcome(st, '整屏截图');
    }
  });

  const capDir = $('capDir');
  if (capDir) {
    capDir.addEventListener('change', async () => {
      cfg = await window.xw.setConfig({ captureDir: capDir.value.trim() });
      setToast('已保存');
    });
  }

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
  setChk('upSilentInstall', cfg.autoUpdateSilentInstall !== false);
  setChk('upIdleInstall', cfg.autoUpdateInstallWhenIdle !== false);
  setChk('upOnQuit', cfg.autoUpdateInstallOnQuit !== false);
  setChk('upPre', cfg.autoUpdatePrerelease === true);
  window.xw.captureHotkeys().then(renderHotkeyState).catch(() => {});
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
    // 悬浮球 ⇄ 宠物 的分工（'auto' / true / false）
    ballEnabled: $('stBallMode')
      ? ($('stBallMode').value === 'true' ? true : ($('stBallMode').value === 'false' ? false : 'auto'))
      : undefined,
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
    petKeepTop: $('stPetKeepTop').checked,
    petSummonHotkey: $('stPetSummonKey').value.trim() || 'CommandOrControl+Alt+P',
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
