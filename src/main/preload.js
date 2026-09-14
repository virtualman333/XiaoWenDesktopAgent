const { contextBridge, ipcRenderer } = require('electron');

/**
 * 暴露给渲染进程的安全 API。
 * 所有跨进程调用统一走 invoke/on，避免开启 nodeIntegration。
 */
contextBridge.exposeInMainWorld('xw', {
  // ---- 配置 ----
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  onConfigUpdate: (cb) => {
    const handler = (_e, cfg) => cb(cfg);
    ipcRenderer.on('config:update', handler);
    return () => ipcRenderer.removeListener('config:update', handler);
  },

  // ---- 对话历史 ----
  getHistory: () => ipcRenderer.invoke('history:get'),
  addHistory: (msg) => ipcRenderer.invoke('history:add', msg),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  onHistoryCleared: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('history:cleared', handler);
    return () => ipcRenderer.removeListener('history:cleared', handler);
  },

  // ---- 窗口 ----
  openPanel: () => ipcRenderer.invoke('win:panel-open'),
  openPanelVoice: () => ipcRenderer.invoke('win:panel-open-voice'),
  hidePanel: () => ipcRenderer.invoke('win:panel-hide'),
  closePanel: () => ipcRenderer.invoke('win:panel-close'),
  openSettings: () => ipcRenderer.invoke('win:settings-open'),
  closeSettings: () => ipcRenderer.invoke('win:settings-close'),

  // ---- 悬浮球 ----
  ballDragMove: (d) => ipcRenderer.invoke('ball:drag-move', d),
  ballSnap: () => ipcRenderer.invoke('ball:snap'),
  ballSetOpacity: (v) => ipcRenderer.invoke('ball:set-opacity', v),
  ballShowMenu: () => ipcRenderer.invoke('ball:show-menu'),

  // ---- 事件订阅 ----
  onVoiceStart: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('voice:start', handler);
    return () => ipcRenderer.removeListener('voice:start', handler);
  },
  onPageMode: (cb) => {
    const handler = (_e, mode) => cb(mode);
    ipcRenderer.on('page:mode', handler);
    return () => ipcRenderer.removeListener('page:mode', handler);
  },
  onToast: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('toast', handler);
    return () => ipcRenderer.removeListener('toast', handler);
  },

  // ---- 大模型调用（真实 API Key 只在主进程使用，不进入页面上下文） ----
  chatStream: (messages) => ipcRenderer.invoke('chat:stream', { messages }),
  chatAbort: () => ipcRenderer.invoke('chat:abort'),
  chatTest: (opts) => ipcRenderer.invoke('chat:test', opts || {}),
  onChatDelta: (cb) => {
    const handler = (_e, delta) => cb(delta);
    ipcRenderer.on('chat:delta', handler);
    return () => ipcRenderer.removeListener('chat:delta', handler);
  },

  // ---- 语音识别（阿里云百炼 paraformer-realtime） ----
  // 渲染进程只负责「采集 PCM 音频」和「展示识别文本」，
  // WebSocket 连接与 API Key 都留在主进程。
  asrStart: (opts) => ipcRenderer.invoke('asr:start', opts || {}),
  asrAudio: (chunk) => ipcRenderer.invoke('asr:audio', chunk),
  asrStop: () => ipcRenderer.invoke('asr:stop'),
  asrCancel: () => ipcRenderer.invoke('asr:cancel'),
  asrTest: (opts) => ipcRenderer.invoke('asr:test', opts || {}),
  onAsrStarted: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on('asr:started', handler);
    return () => ipcRenderer.removeListener('asr:started', handler);
  },
  onAsrResult: (cb) => {
    const handler = (_e, res) => cb(res);
    ipcRenderer.on('asr:result', handler);
    return () => ipcRenderer.removeListener('asr:result', handler);
  },
  onAsrEnd: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on('asr:end', handler);
    return () => ipcRenderer.removeListener('asr:end', handler);
  },
  onAsrError: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('asr:error', handler);
    return () => ipcRenderer.removeListener('asr:error', handler);
  },
  // 主进程通知：面板打开/关闭，唤醒监听要相应让出或收回麦克风
  onWakeSync: (cb) => {
    const handler = (_e, info) => cb(info || {});
    ipcRenderer.on('wake:sync', handler);
    return () => ipcRenderer.removeListener('wake:sync', handler);
  },

  // ---- 截图 ----
  captureInit: () => ipcRenderer.invoke('capture:__init'),
  captureDone: (rect) => ipcRenderer.send('capture:__done', rect),
  captureCancel: () => ipcRenderer.send('capture:__done', null),
  captureFull: (opts) => ipcRenderer.invoke('capture:full', opts || {}),
  captureRegion: (opts) => ipcRenderer.invoke('capture:region', opts || {}),
  captureDir: () => ipcRenderer.invoke('capture:dir'),
  captureOpenDir: () => ipcRenderer.invoke('capture:open-dir'),
  captureRead: (p) => ipcRenderer.invoke('capture:read', p),
  onCapture: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('capture:done', h);
    return () => ipcRenderer.removeListener('capture:done', h);
  },

  // ---- 自动更新 ----
  updaterState: () => ipcRenderer.invoke('updater:state'),
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterDownload: () => ipcRenderer.invoke('updater:download'),
  updaterInstall: () => ipcRenderer.invoke('updater:install'),
  updaterOpenReleases: () => ipcRenderer.invoke('updater:open-releases'),
  onUpdaterEvent: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('updater:event', h);
    return () => ipcRenderer.removeListener('updater:event', h);
  },

  // ---- 其他 ----
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  openUserData: () => ipcRenderer.invoke('open:userdata'),
  isDev: process.env.NODE_ENV === 'development',

  // ---- 渲染 / GPU ----
  gpuStatus: () => ipcRenderer.invoke('gpu:status'),
  gpuSetDisabled: (v) => ipcRenderer.invoke('gpu:set-disabled', v),
  gpuRestart: () => ipcRenderer.invoke('gpu:restart'),

  // ---- 桌面宠物 ----
  petStateGet: () => ipcRenderer.invoke('pet:state-get'),
  petStateSave: (s) => ipcRenderer.invoke('pet:state-save', s),
  petReady: () => ipcRenderer.invoke('pet:ready'),
  petSetMouse: (ignore) => ipcRenderer.invoke('pet:set-mouse', ignore),
  petDragMove: (d) => ipcRenderer.invoke('pet:drag-move', d),
  petMoveTo: (x, y) => ipcRenderer.invoke('pet:move-to', x, y),
  petGetBounds: () => ipcRenderer.invoke('pet:get-bounds'),
  petSnap: () => ipcRenderer.invoke('pet:snap'),
  petHide: () => ipcRenderer.invoke('pet:hide'),
  petShow: () => ipcRenderer.invoke('pet:show'),
  petToggle: () => ipcRenderer.invoke('pet:toggle'),
  petVisible: () => ipcRenderer.invoke('pet:visible'),
  petSetOpacity: (v) => ipcRenderer.invoke('pet:set-opacity', v),
  petSetTop: (v) => ipcRenderer.invoke('pet:set-top', v),
  petResize: () => ipcRenderer.invoke('pet:resize'),
  // 让宠物替小问播报（面板 / 任意窗口调用，主进程转发给宠物窗口）
  petSay: (text) => ipcRenderer.invoke('pet:say-out', text),
  onPetSay: (cb) => {
    const h = (_e, text) => cb(text);
    ipcRenderer.on('pet:say', h);
    return () => ipcRenderer.removeListener('pet:say', h);
  },
  // 让宠物演出小问的工作状态（think / work / done / error / listen / idle）
  petAct: (action, opts) => ipcRenderer.invoke('pet:act-out', { action, ...(opts || {}) }),
  onPetAct: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('pet:act', h);
    return () => ipcRenderer.removeListener('pet:act', h);
  },

  // ================= Jarvis 能力 =================
  // 开机自启
  autostartGet: () => ipcRenderer.invoke('autostart:get'),
  autostartSet: (v) => ipcRenderer.invoke('autostart:set', v),

  // 人格（我是谁 / 主人是谁）
  personaGet: () => ipcRenderer.invoke('persona:get'),
  personaSet: (patch) => ipcRenderer.invoke('persona:set', patch),

  // 长期记忆
  memoryList: () => ipcRenderer.invoke('memory:list'),
  memoryAdd: (m) => ipcRenderer.invoke('memory:add', m),
  memoryRemove: (id) => ipcRenderer.invoke('memory:remove', id),
  memoryClear: () => ipcRenderer.invoke('memory:clear'),
  memorySearch: (q) => ipcRenderer.invoke('memory:search', q),

  // 短期记忆（会话）
  sessionList: () => ipcRenderer.invoke('session:list'),
  sessionCreate: (title) => ipcRenderer.invoke('session:create', title),
  sessionGet: (id) => ipcRenderer.invoke('session:get', id),
  sessionActive: () => ipcRenderer.invoke('session:active'),
  sessionSetActive: (id) => ipcRenderer.invoke('session:set-active', id),
  sessionRename: (id, title) => ipcRenderer.invoke('session:rename', { id, title }),
  sessionDelete: (id) => ipcRenderer.invoke('session:delete', id),
  sessionAppend: (id, msg) => ipcRenderer.invoke('session:append', { id, msg }),
  sessionSetMessages: (id, messages) => ipcRenderer.invoke('session:set-messages', { id, messages }),

  // 内置工具
  toolsSettingsGet: () => ipcRenderer.invoke('tools:settings-get'),
  toolsSettingsSet: (patch) => ipcRenderer.invoke('tools:settings-set', patch),
  toolsList: () => ipcRenderer.invoke('tools:list'),
  toolsExec: (name, args) => ipcRenderer.invoke('tools:exec', { name, args }),
  toolsOpenFile: (p) => ipcRenderer.invoke('tools:open-file', p),

  // MCP
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  mcpTools: () => ipcRenderer.invoke('mcp:tools'),
  mcpAdd: (cfg) => ipcRenderer.invoke('mcp:add', cfg),
  mcpRemove: (id) => ipcRenderer.invoke('mcp:remove', id),
  mcpConnect: (id) => ipcRenderer.invoke('mcp:connect', id),
  mcpDisconnect: (id) => ipcRenderer.invoke('mcp:disconnect', id),
  mcpConnectAll: () => ipcRenderer.invoke('mcp:connect-all'),

  // Skills
  skillsList: () => ipcRenderer.invoke('skills:list'),
  skillsLoad: (id) => ipcRenderer.invoke('skills:load', id),
  skillsSave: (s) => ipcRenderer.invoke('skills:save', s),
  skillsDelete: (id) => ipcRenderer.invoke('skills:delete', id),
  skillsOpenDir: () => ipcRenderer.invoke('skills:open-dir'),

  // 语音合成
  ttsVoices: () => ipcRenderer.invoke('tts:voices'),
  ttsSynth: (opts) => ipcRenderer.invoke('tts:synth', opts),
  ttsTest: (opts) => ipcRenderer.invoke('tts:test', opts),

  // Agent
  agentRun: (payload) => ipcRenderer.invoke('agent:run', payload),
  agentConfirmReply: (id, approved) => ipcRenderer.invoke('agent:confirm-reply', { id, approved }),

  // 子代理编排（小问派活 / 监督）
  orchRun: (goal) => ipcRenderer.invoke('orch:run', { goal }),
  orchAbort: () => ipcRenderer.invoke('orch:abort'),
  onOrchPlan: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('orch:plan', h);
    return () => ipcRenderer.removeListener('orch:plan', h);
  },
  onOrchTask: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('orch:task', h);
    return () => ipcRenderer.removeListener('orch:task', h);
  },
  onOrchAsk: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('orch:ask', h);
    return () => ipcRenderer.removeListener('orch:ask', h);
  },
  onOrchDone: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('orch:done', h);
    return () => ipcRenderer.removeListener('orch:done', h);
  },
  onAgentTool: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('agent:tool', h);
    return () => ipcRenderer.removeListener('agent:tool', h);
  },
  onAgentConfirm: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('agent:confirm', h);
    return () => ipcRenderer.removeListener('agent:confirm', h);
  },

  jarvisStatus: () => ipcRenderer.invoke('jarvis:status')
});
