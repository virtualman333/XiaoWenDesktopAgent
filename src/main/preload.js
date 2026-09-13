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

  // ---- 其他 ----
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  openUserData: () => ipcRenderer.invoke('open:userdata'),
  isDev: process.env.NODE_ENV === 'development',

  // ---- 渲染 / GPU ----
  gpuStatus: () => ipcRenderer.invoke('gpu:status'),
  gpuSetDisabled: (v) => ipcRenderer.invoke('gpu:set-disabled', v),
  gpuRestart: () => ipcRenderer.invoke('gpu:restart')
});
