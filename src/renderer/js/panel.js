import { streamChat, testConnection, abortChat } from './api.js';
import { renderMarkdown, toPlainText } from './markdown.js';
import * as speech from './speech.js';

// ============ 全局状态 ============
let cfg = {};
let messages = [];          // 当前会话（不含 system）
let streaming = false;
let abortCtrl = null;
let currentAiNode = null;   // 正在流式输出的气泡节点
let lastUserText = '';

const $ = (id) => document.getElementById(id);

const els = {
  messages: $('messages'),
  welcome: $('welcome'),
  input: $('input'),
  btnSend: $('btnSend'),
  btnVoice: $('btnVoice'),
  btnNew: $('btnNew'),
  btnSettings: $('btnSettings'),
  btnMin: $('btnMin'),
  btnClose: $('btnClose'),
  modelTag: $('modelTag'),
  statusTip: $('statusTip'),
  ttsToggle: $('ttsToggle'),
  voiceOverlay: $('voiceOverlay'),
  voiceText: $('voiceText'),
  voiceCancel: $('voiceCancel')
};

// 页面用途：设置窗口会带 #settings 打开。
// 注意：打包后走 file:// 协议，loadFile 的 hash 有时不生效，
// 所以这里除了看 hash，也看 URL 里是否含 settings，再兜底。
function detectPage() {
  const h = (location.hash || '').toLowerCase();
  const u = decodeURIComponent(location.href || '').toLowerCase();
  if (h.includes('settings') || u.includes('#settings') || u.includes('%23settings')) {
    return 'settings';
  }
  return 'chat';
}

const PAGE = detectPage();

/** 显式切换两个视图的显示状态 */
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
  try {
    cfg = await window.xw.getConfig();
  } catch (e) {
    console.error('[init] 读取配置失败:', e);
    cfg = {};
  }

  if (PAGE === 'settings') {
    showView('settings');
    initSettings();
    return;
  }
  showView('chat');
  initChat();
}

// 监听 hash 变化：支持在同一窗口内切换视图
window.addEventListener('hashchange', () => {
  const p = detectPage();
  showView(p);
  if (p === 'settings') initSettings();
  else initChat();
});

// 主进程会在窗口显示时明确告知页面用途（作为 hash 的兜底）
try {
  window.xw.onPageMode((mode) => {
    if (mode === 'settings') {
      showView('settings');
      initSettings();
    } else {
      showView('chat');
    }
  });
} catch (e) {
  console.warn('[page] onPageMode 不可用:', e);
}

// ================== 对话页 ==================
async function initChat() {
  els.modelTag.textContent = cfg.model || '未配置模型';
  els.ttsToggle.checked = cfg.ttsEnabled !== false;

  // 载入历史
  const history = await window.xw.getHistory();
  if (history && history.length) {
    els.welcome.style.display = 'none';
    history.slice(-20).forEach((m) => {
      addMessageBubble(m.role, m.content, { save: false, animate: false });
      messages.push({ role: m.role, content: m.content });
    });
    scrollToBottom();
  }

  bindEvents();

  // 主进程事件
  window.xw.onConfigUpdate((c) => {
    cfg = c;
    els.modelTag.textContent = c.model || '未配置模型';
  });
  window.xw.onVoiceStart(() => startVoice());
  window.xw.onHistoryCleared(() => {
    messages = [];
    clearMessageNodes();
    els.welcome.style.display = '';
  });
}

function bindEvents() {
  els.btnSend.addEventListener('click', send);
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  els.input.addEventListener('input', autoResize);

  // 快捷问题
  document.querySelectorAll('.quick').forEach((b) => {
    b.addEventListener('click', () => {
      els.input.value = b.dataset.q;
      autoResize();
      send();
    });
  });

  els.btnVoice.addEventListener('click', startVoice);
  els.btnNew.addEventListener('click', newChat);
  els.btnSettings.addEventListener('click', () => window.xw.openSettings());
  els.btnMin.addEventListener('click', () => window.xw.hidePanel());
  els.btnClose.addEventListener('click', () => window.xw.closePanel());
  els.voiceCancel.addEventListener('click', cancelVoice);

  els.ttsToggle.addEventListener('change', async () => {
    cfg = await window.xw.setConfig({ ttsEnabled: els.ttsToggle.checked });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (els.voiceOverlay.classList.contains('show')) cancelVoice();
      else if (streaming) stopStreaming();
    }
  });
}

function autoResize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 130) + 'px';
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    els.messages.scrollTop = els.messages.scrollHeight;
  });
}

function clearMessageNodes() {
  [...els.messages.querySelectorAll('.msg')].forEach((n) => n.remove());
}

// ---------- 发送 ----------
async function send(textOverride) {
  if (streaming) return;
  const text = (textOverride ?? els.input.value).trim();
  if (!text) return;

  // 渲染进程只知道「有没有配过 Key」（apiKeyMasked 非空即表示已配置），
  // 真实 Key 在主进程，这里不需要也不应该拿到它。
  if (!cfg.apiKeyMasked) {
    setStatus('请先在设置中配置 API Key');
    window.xw.openSettings();
    return;
  }

  els.welcome.style.display = 'none';
  els.input.value = '';
  autoResize();
  updateSendBtn(true);

  // 用户消息
  lastUserText = text;
  addMessageBubble('user', text);
  messages.push({ role: 'user', content: text });
  window.xw.addHistory({ role: 'user', content: text });

  // 上下文裁剪
  const maxTurns = cfg.contextTurns ?? 10;
  const recent = maxTurns > 0 ? messages.slice(-maxTurns * 2) : messages.slice(-1);

  const payload = [
    { role: 'system', content: cfg.systemPrompt || '' },
    ...recent
  ].filter((m) => m.content);

  // 占位气泡
  currentAiNode = addMessageBubble('ai', '', { thinking: true });

  let full = '';
  abortCtrl = new AbortController();
  streaming = true;
  setStatus('思考中…');
  document.querySelector('.ball');

  try {
    full = await streamChat({
      messages: payload,
      onDelta: (_d, acc) => {
        full = acc;
        renderStreaming(currentAiNode, acc);
        scrollToBottom();
      }
    });
  } catch (err) {
    if (err.name === 'AbortError' || err.aborted) {
      // 用户点了「停止」：保留已经收到的内容，不当作错误
      if (full) {
        renderStreaming(currentAiNode, full, true);
        finalizeAiNode(currentAiNode, full);
        messages.push({ role: 'ai', content: full });
        window.xw.addHistory({ role: 'ai', content: full });
      } else {
        els.messages.removeChild(currentAiNode);
      }
      setStatus('已停止');
    } else {
      const msg = String(err.message || err);
      renderStreaming(currentAiNode, full + `\n\n> ⚠️ 请求失败：${msg}`, true);
      setStatus('请求失败');
      console.error('[chat]', err);
    }
    streaming = false;
    updateSendBtn(false);
    return;
  }

  streaming = false;
  updateSendBtn(false);

  if (full) {
    messages.push({ role: 'ai', content: full });
    window.xw.addHistory({ role: 'ai', content: full });
    finalizeAiNode(currentAiNode, full);
    setStatus('就绪');

    // 语音朗读
    if (cfg.ttsEnabled !== false) {
      speakText(full);
    }
  } else {
    currentAiNode && currentAiNode.remove();
    setStatus('未收到回复');
  }
  currentAiNode = null;
  scrollToBottom();
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
  // 通知主进程真正中断请求（否则后台仍在消费 token）
  abortChat();
  if (abortCtrl) abortCtrl.abort();
  speech.stopSpeaking();
  streaming = false;
  updateSendBtn(false);
  setStatus('已停止');
}

// ---------- 气泡渲染 ----------
function addMessageBubble(role, content, { save = true, animate = true, thinking = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  if (!animate) wrap.style.animation = 'none';

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = role === 'user' ? '我' : '问';

  const body = document.createElement('div');
  body.className = 'msg-body';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (thinking) {
    bubble.innerHTML = `<span class="thinking-dots"><i></i><i></i><i></i></span>`;
  } else if (role === 'ai') {
    bubble.innerHTML = renderMarkdown(content);
  } else {
    bubble.textContent = content;
  }

  body.appendChild(bubble);

  // AI 消息操作条
  if (role === 'ai' && !thinking) {
    body.appendChild(buildActions(content, bubble));
  }

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
  if (isError) {
    bubble.innerHTML = renderMarkdown(text);
  } else {
    bubble.innerHTML = renderMarkdown(text) + '<span class="cursor"></span>';
  }
}

function finalizeAiNode(node, text) {
  if (!node) return;
  const bubble = node.querySelector('.bubble');
  if (bubble) bubble.innerHTML = renderMarkdown(text);
  const body = node.querySelector('.msg-body');
  if (body && !body.querySelector('.msg-actions')) {
    body.appendChild(buildActions(text, bubble));
  }
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
    if (speech.isSpeaking()) {
      speech.stopSpeaking();
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
    // 移除当前 AI 消息
    const wrap = bar.closest('.msg');
    const idx = messages.findIndex((m) => m.role === 'ai' && m.content === text);
    if (idx >= 0) messages.splice(idx, 1);
    wrap && wrap.remove();
    // 用最后一个用户消息重发
    if (lastUserText) {
      // 去掉末尾 user 消息，重新发送
      const lastIdx = messages.map((m) => m.role).lastIndexOf('user');
      if (lastIdx >= 0) messages.splice(lastIdx, 1);
      send(lastUserText);
    }
  };

  bar.appendChild(copyBtn);
  bar.appendChild(speakBtn);
  bar.appendChild(retryBtn);
  return bar;
}

function speakText(text) {
  if (cfg.ttsEnabled === false) return;
  const plain = toPlainText(text);
  if (!plain) return;
  speech.speak(plain, {
    rate: 1 + (cfg.ttsRate || 0) / 10,
    volume: (cfg.ttsVolume ?? 100) / 100,
    voiceName: cfg.ttsVoice || '',
    onEnd: () => document.dispatchEvent(new CustomEvent('speech-ended'))
  });
}

function setStatus(t) {
  els.statusTip.textContent = t;
}

function newChat() {
  if (streaming) stopStreaming();
  speech.stopSpeaking();
  messages = [];
  lastUserText = '';
  clearMessageNodes();
  els.welcome.style.display = '';
  setStatus('就绪');
}

// ================== 语音问答 ==================
let voiceFinalText = '';

function startVoice() {
  if (!speech.isRecognitionSupported()) {
    setStatus('当前环境不支持语音识别');
    return;
  }
  speech.stopSpeaking();
  voiceFinalText = '';
  els.voiceText.textContent = '正在聆听…';
  els.voiceOverlay.classList.add('show');
  els.btnVoice.classList.add('active');

  speech.startRecognition({
    lang: 'zh-CN',
    onResult: (text, isFinal) => {
      els.voiceText.textContent = text || '正在聆听…';
      if (isFinal) voiceFinalText = text;
    },
    onError: (msg) => {
      els.voiceText.textContent = msg;
      setStatus(msg);
      setTimeout(() => closeVoiceOverlay(), 1400);
    },
    onEnd: (finalText) => {
      const t = (finalText || voiceFinalText || els.voiceText.textContent || '').trim();
      closeVoiceOverlay();
      if (t && t !== '正在聆听…' && !t.startsWith('识别') && !t.startsWith('没有') && !t.startsWith('麦克风') && !t.startsWith('网络') && !t.startsWith('未找到')) {
        send(t);
      } else {
        setStatus('未识别到内容');
      }
    }
  });
}

function cancelVoice() {
  speech.abortRecognition();
  closeVoiceOverlay();
}

function closeVoiceOverlay() {
  els.voiceOverlay.classList.remove('show');
  els.btnVoice.classList.remove('active');
}

// ================== 设置页 ==================
let settingsInited = false;

function initSettings() {
  if (settingsInited) return;
  settingsInited = true;

  const el = {
    provider: $('stProvider'),
    baseUrl: $('stBaseUrl'),
    model: $('stModel'),
    apiKey: $('stApiKey'),
    keyToggle: $('stKeyToggle'),
    test: $('stTest'),
    testResult: $('stTestResult'),
    systemPrompt: $('stSystemPrompt'),
    context: $('stContext'),
    contextVal: $('stContextVal'),
    ttsEnabled: $('stTtsEnabled'),
    ttsRate: $('stTtsRate'),
    rateVal: $('stRateVal'),
    ttsVolume: $('stTtsVolume'),
    volumeVal: $('stVolumeVal'),
    voice: $('stVoice'),
    testVoice: $('stTestVoice'),
    opacity: $('stOpacity'),
    opacityVal: $('stOpacityVal'),
    hotkey: $('stHotkey'),
    gpuDisabled: $('stGpuDisabled'),
    gpuStatus: $('stGpuStatus'),
    restart: $('stRestart'),
    openData: $('stOpenData'),
    clearHistory: $('stClearHistory'),
    save: $('stSave')
  };

  // 填充表单
  function fill(c) {
    el.baseUrl.value = c.apiBaseUrl || '';
    el.model.value = c.model || '';
    // 不要把打码后的 Key 填进输入框 —— 否则用户直接点保存会把 "xx***xx" 当成真 Key 存下去。
    // 改为留空 + placeholder 提示，并标记 keep=1（保存时沿用它）。
    const hasKey = !!(c.apiKeyMasked || (c.apiKey && c.apiKey !== '__KEEP__'));
    el.apiKey.value = '';
    el.apiKey.placeholder = hasKey
      ? `已配置：${c.apiKeyMasked || '••••••'}（留空保持不变，重新填写则覆盖）`
      : 'sk-... 请粘贴服务商提供的 API Key';
    el.apiKey.dataset.keep = hasKey ? '1' : '0';
    el.systemPrompt.value = c.systemPrompt || '';
    el.context.value = c.contextTurns ?? 10;
    el.contextVal.textContent = c.contextTurns ?? 10;
    el.ttsEnabled.checked = c.ttsEnabled !== false;
    el.ttsRate.value = c.ttsRate || 0;
    el.rateVal.textContent = (1 + (c.ttsRate || 0) / 10).toFixed(1) + 'x';
    el.ttsVolume.value = c.ttsVolume ?? 100;
    el.volumeVal.textContent = (c.ttsVolume ?? 100) + '%';
    el.opacity.value = Math.round((c.ballOpacity ?? 0.92) * 100);
    el.opacityVal.textContent = Math.round((c.ballOpacity ?? 0.92) * 100) + '%';
    el.hotkey.value = c.hotkey || 'Alt+Space';

    // 匹配服务商
    const match = [...el.provider.options].find(
      (o) => o.value === `${c.apiBaseUrl}|${c.model}`
    );
    el.provider.value = match ? match.value : 'custom';
  }

  fill(cfg);

  window.xw.onConfigUpdate(fill);

  // 服务商切换
  el.provider.addEventListener('change', () => {
    const v = el.provider.value;
    if (v === 'custom') return;
    const [url, model] = v.split('|');
    el.baseUrl.value = url;
    el.model.value = model;
  });

  // API Key 显隐
  el.keyToggle.addEventListener('click', () => {
    const isPwd = el.apiKey.type === 'password';
    el.apiKey.type = isPwd ? 'text' : 'password';
    el.keyToggle.textContent = isPwd ? '隐藏' : '显示';
  });
  el.apiKey.addEventListener('input', () => {
    el.apiKey.dataset.keep = '0';
  });

  // 滑块
  el.context.addEventListener('input', () => (el.contextVal.textContent = el.context.value));
  el.ttsRate.addEventListener('input', () => {
    el.rateVal.textContent = (1 + Number(el.ttsRate.value) / 10).toFixed(1) + 'x';
  });
  el.ttsVolume.addEventListener('input', () => {
    el.volumeVal.textContent = el.ttsVolume.value + '%';
  });
  el.opacity.addEventListener('input', () => {
    el.opacityVal.textContent = el.opacity.value + '%';
    window.xw.ballSetOpacity(Number(el.opacity.value) / 100);
  });

  // 快捷键录制
  el.hotkey.addEventListener('keydown', (e) => {
    e.preventDefault();
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Super');
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) parts.push(key);
    if (parts.length >= 2) el.hotkey.value = parts.join('+');
  });

  // 语音音色列表
  function fillVoices() {
    const list = speech.getVoices();
    if (!list.length) return;
    el.voice.innerHTML = '<option value="">自动选择（推荐）</option>';
    list.forEach((v) => {
      const o = document.createElement('option');
      o.value = v.name;
      o.textContent = `${v.name} · ${v.lang}${v.localService ? ' (本地)' : ''}`;
      el.voice.appendChild(o);
    });
    el.voice.value = cfg.ttsVoice || '';
  }
  fillVoices();
  document.addEventListener('voices-ready', fillVoices);
  setTimeout(fillVoices, 700);

  // 试听
  el.testVoice.addEventListener('click', () => {
    speech.speak('你好，我是小问，这是语音朗读效果。', {
      rate: 1 + Number(el.ttsRate.value) / 10,
      volume: Number(el.ttsVolume.value) / 100,
      voiceName: el.voice.value
    });
  });

  // 测试连接
  el.test.addEventListener('click', async () => {
    const baseUrl = el.baseUrl.value.trim();
    const model = el.model.value.trim();
    // 用户改过 Key 就传新值；没改过则传 __KEEP__，由主进程用已保存的真实 Key
    const keyInput = el.apiKey.value.trim();
    const apiKey = el.apiKey.dataset.keep === '1'
      ? '__KEEP__'
      : (keyInput && !keyInput.includes('***') ? keyInput : '__KEEP__');

    if (!baseUrl || !model) {
      showTest('请先填写接口地址与模型名', 'err');
      return;
    }
    showTest('正在测试连接…', 'loading');
    try {
      const reply = await testConnection({ baseUrl, model, apiKey });
      showTest(`连接成功 ✓ 模型回复：${reply || '(空)'}`, 'ok');
    } catch (e) {
      showTest(`连接失败：${e.message}`, 'err');
    }
  });

  function showTest(msg, type) {
    el.testResult.textContent = msg;
    el.testResult.className = 'test-result show ' + type;
  }

  el.openData.addEventListener('click', () => window.xw.openUserData());

  // ---- 显示与兼容性 ----
  async function refreshGpuStatus() {
    try {
      const st = await window.xw.gpuStatus();
      const enabled = st.hardwareAcceleration;
      el.gpuDisabled.checked = !enabled;

      let txt = enabled
        ? '当前：硬件加速已启用（推荐）'
        : `当前：已禁用硬件加速\n原因：${st.reason}`;

      const g = st.gpuFeatureStatus;
      if (g && g.gpu_compositing) {
        txt += `\nGPU 合成：${g.gpu_compositing}`;
      }
      el.gpuStatus.textContent = txt;
      el.gpuStatus.className = 'gpu-status ' + (enabled ? 'ok' : 'warn');
    } catch (e) {
      el.gpuStatus.textContent = '无法获取状态：' + e.message;
      el.gpuStatus.className = 'gpu-status warn';
    }
  }
  refreshGpuStatus();

  el.gpuDisabled.addEventListener('change', async () => {
    await window.xw.gpuSetDisabled(el.gpuDisabled.checked);
    const tip = el.gpuDisabled.checked
      ? '已设置：下次启动将禁用硬件加速。点下方「立即重启程序」生效。'
      : '已设置：下次启动恢复硬件加速。点下方「立即重启程序」生效。';
    el.gpuStatus.textContent = tip;
    el.gpuStatus.className = 'gpu-status warn';
  });

  el.restart.addEventListener('click', () => {
    window.xw.gpuRestart();
  });

  el.clearHistory.addEventListener('click', async () => {
    await window.xw.clearHistory();
    el.clearHistory.textContent = '已清空 ✓';
    setTimeout(() => (el.clearHistory.textContent = '清空所有对话历史'), 1600);
  });

  // 保存
  el.save.addEventListener('click', async () => {
    const patch = {
      apiBaseUrl: el.baseUrl.value.trim(),
      model: el.model.value.trim(),
      systemPrompt: el.systemPrompt.value,
      contextTurns: Number(el.context.value),
      ttsEnabled: el.ttsEnabled.checked,
      ttsRate: Number(el.ttsRate.value),
      ttsVolume: Number(el.ttsVolume.value),
      ttsVoice: el.voice.value,
      ballOpacity: Number(el.opacity.value) / 100,
      hotkey: el.hotkey.value.trim() || 'Alt+Space'
    };

    // 输入框留空 = 沿用已保存的 Key；填了新值才覆盖
    const keyInput = el.apiKey.value.trim();
    if (!keyInput) {
      patch.apiKey = '__KEEP__';
    } else if (keyInput.includes('***')) {
      el.apiKey.placeholder = '这个值里包含 ***（是打码文本），请粘贴完整 Key';
      el.apiKey.classList.add('input-error');
      setTimeout(() => el.apiKey.classList.remove('input-error'), 2500);
      return;
    } else {
      patch.apiKey = keyInput;
    }

    await window.xw.setConfig(patch);
    el.apiKey.value = '';
    el.save.textContent = '已保存 ✓';
    setTimeout(() => (el.save.textContent = '保存'), 1500);
  });
}

// ============ 启动 ============
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
