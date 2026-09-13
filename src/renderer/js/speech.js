/**
 * 语音模块
 *
 * 识别（两条路，按设置里的 asrProvider 切换）：
 *   A. dashscope —— 阿里云百炼 paraformer-realtime，走 WebSocket 实时流式识别。
 *      渲染进程只负责用 Web Audio 采集 16kHz 单声道 PCM 并转发给主进程，
 *      真正的网络请求与 API Key 都在主进程（见 main.js 的 asr:* 通道）。
 *   B. system   —— 系统内置的 Web Speech API。Electron 内置 Chromium，
 *      Windows 下依赖 Google 云端服务，国内网络通常返回 network 错误，
 *      保留下来只作为备选。
 *
 * 朗读：SpeechSynthesis，使用系统安装的语音引擎（完全离线）。
 */

// 目标采样率固定 16kHz —— 与 DashScope PCM 要求一致，
// 让浏览器重采样比发原始 44.1/48kHz 再让服务端处理更省带宽。
const TARGET_SAMPLE_RATE = 16000;
// 每次上行发送的音频块时长（毫秒）。100ms 兼顾实时性与 IPC 频率。
const CHUNK_MS = 100;

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// ---------------- 状态 ----------------
let mode = 'idle';           // idle | starting | running | stopping
let onResultCb = null;
let onErrorCb = null;
let onEndCb = null;
let onLevelCb = null;

let audioCtx = null;
let mediaStream = null;
let sourceNode = null;
let processorNode = null;
let workletNode = null;

let pcmBuffer = [];          // 累积待发送的 Int16 采样
let pcmBufferLen = 0;
let sendTimer = null;
let lastVoiceAt = 0;         // 最后一次检测到人声的时间
let silenceTimer = null;
let silenceMs = 2000;

let finalText = '';          // 已确认的成品文本
let interimText = '';        // 当前句的中间结果
let lastEmitted = '';        // 上一次向界面推送的合成文本（去重）

// 离线识别（system 模式）相关
let recognizer = null;
let recognizing = false;

export function isRecognitionSupported() {
  // 两种模式任一可用即返回 true
  if (typeof WebSocket === 'function' && !!navigator.mediaDevices?.getUserMedia) return true;
  return !!SR;
}

export function currentProvider() {
  return mode;
}

// ---------------- 音频采集 ----------------

/**
 * 把 Float32 单声道数据重采样为 16kHz 并转 Int16
 * 采用线性插值 —— 对语音识别足够，且无需引入额外依赖。
 */
function resampleToInt16(input, inputRate, outputRate = TARGET_SAMPLE_RATE) {
  if (inputRate === outputRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  const ratio = inputRate / outputRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] || 0;
    const b = input[idx + 1] !== undefined ? input[idx + 1] : a;
    const s = Math.max(-1, Math.min(1, a + (b - a) * frac));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** 计算这一小段的音量（RMS），用于界面波纹与静音判断 */
function calcLevel(input) {
  let sum = 0;
  for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
  return Math.sqrt(sum / (input.length || 1));
}

/** 把累积的 PCM 按 100ms 一块推给主进程 */
function flushChunks(force = false) {
  const samplesPerChunk = (TARGET_SAMPLE_RATE * CHUNK_MS) / 1000;
  while (pcmBufferLen >= samplesPerChunk || (force && pcmBufferLen > 0)) {
    const take = force ? pcmBufferLen : samplesPerChunk;
    const chunk = new Int16Array(take);
    let filled = 0;
    while (filled < take && pcmBuffer.length) {
      const head = pcmBuffer[0];
      const need = take - filled;
      if (head.length <= need) {
        chunk.set(head, filled);
        filled += head.length;
        pcmBuffer.shift();
      } else {
        chunk.set(head.subarray(0, need), filled);
        pcmBuffer[0] = head.subarray(need);
        filled += need;
      }
    }
    pcmBufferLen -= take;
    try {
      window.xw.asrAudio(chunk.buffer);
    } catch (e) {
      console.warn('[asr] 发送音频失败:', e);
    }
  }
}

/** 重置静音计时器：每次检测到人声就延后自动结束 */
function touchSilenceTimer() {
  lastVoiceAt = Date.now();
  if (silenceTimer) return;
  silenceTimer = setInterval(() => {
    if (mode !== 'running') return;
    if (Date.now() - lastVoiceAt >= silenceMs) {
      console.log('[asr] 静音超时，自动结束');
      stopRecognition();
    }
  }, 200);
}

// ---------------- 在线识别（DashScope） ----------------

async function startDashscope({ lang, onLevel }) {
  // 1) 采集麦克风
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
  } catch (e) {
    const name = e && e.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new Error('麦克风权限被拒绝，请在系统设置中允许小问助手使用麦克风');
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      throw new Error('未找到麦克风设备，请检查硬件连接');
    }
    if (name === 'NotReadableError') {
      throw new Error('麦克风被其他程序占用，请关闭后重试');
    }
    throw new Error('无法打开麦克风：' + (e && e.message));
  }

  // 2) 建立音频图。AudioContext 直接用 16kHz —— 浏览器会自动重采样
  audioCtx = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: TARGET_SAMPLE_RATE
  });
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  sourceNode = audioCtx.createMediaStreamSource(mediaStream);

  // 优先用 AudioWorklet（性能好、不阻塞主线程）；
  // 不支持时回退到已废弃但兼容性最好的 ScriptProcessor。
  let usingWorklet = false;
  if (audioCtx.audioWorklet && typeof AudioWorkletNode === 'function') {
    try {
      const workletCode = `
        class XwCapture extends AudioWorkletProcessor {
          process(inputs) {
            const ch = inputs[0] && inputs[0][0];
            if (ch && ch.length) this.port.postMessage(new Float32Array(ch));
            return true;
          }
        }
        registerProcessor('xw-capture', XwCapture);
      `;
      const blob = new Blob([workletCode], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      await audioCtx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      workletNode = new AudioWorkletNode(audioCtx, 'xw-capture');
      workletNode.port.onmessage = (ev) => handleAudioFrame(ev.data, onLevel);
      sourceNode.connect(workletNode);
      // Worklet 需要接到 destination 才会被驱动；用一个静音增益避免回声
      const mute = audioCtx.createGain();
      mute.gain.value = 0;
      workletNode.connect(mute);
      mute.connect(audioCtx.destination);
      usingWorklet = true;
    } catch (e) {
      console.warn('[asr] AudioWorklet 不可用，回退 ScriptProcessor:', e && e.message);
    }
  }

  if (!usingWorklet) {
    processorNode = audioCtx.createScriptProcessor(4096, 1, 1);
    processorNode.onaudioprocess = (ev) => {
      const ch = ev.inputBuffer.getChannelData(0);
      handleAudioFrame(new Float32Array(ch), onLevel);
    };
    sourceNode.connect(processorNode);
    const mute = audioCtx.createGain();
    mute.gain.value = 0;
    processorNode.connect(mute);
    mute.connect(audioCtx.destination);
  }

  // 3) 通知主进程开一条识别会话（主进程负责 WebSocket + Key）
  const res = await window.xw.asrStart({
    sampleRate: TARGET_SAMPLE_RATE,
    language: lang || 'zh'
  });
  if (!res || res.ok !== true) {
    throw new Error((res && res.error) || '语音识别会话启动失败');
  }
}

/** 处理一个音频帧：转 Int16 → 入队 → 判断人声 → 触发发送 */
function handleAudioFrame(float32, onLevel) {
  if (mode !== 'running') return;

  const level = calcLevel(float32);
  // 留一点迟滞：超过阈值就算「有人在说话」，重新计时
  if (level > 0.012) touchSilenceTimer();
  if (onLevel) onLevel(Math.min(1, level * 12));

  const pcm = resampleToInt16(float32, audioCtx ? audioCtx.sampleRate : TARGET_SAMPLE_RATE);
  if (pcm.length) {
    pcmBuffer.push(pcm);
    pcmBufferLen += pcm.length;
  }
}

function stopMediaCapture() {
  if (sendTimer) { clearInterval(sendTimer); sendTimer = null; }
  if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }

  try { if (workletNode) { workletNode.port.onmessage = null; workletNode.disconnect(); } } catch {}
  try { if (processorNode) { processorNode.onaudioprocess = null; processorNode.disconnect(); } } catch {}
  try { if (sourceNode) sourceNode.disconnect(); } catch {}
  try { if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (audioCtx && audioCtx.state !== 'closed') audioCtx.close(); } catch {}

  workletNode = null;
  processorNode = null;
  sourceNode = null;
  mediaStream = null;
  audioCtx = null;
}

// ---------------- 离线识别（系统内置） ----------------

function startSystemRecognition({ lang }) {
  if (!SR) throw new Error('当前环境不支持系统语音识别');
  if (recognizer) {
    try { recognizer.abort(); } catch {}
  }
  recognizer = new SR();
  recognizer.lang = lang || 'zh-CN';
  recognizer.continuous = false;
  recognizer.interimResults = true;
  recognizer.maxAlternatives = 1;

  recognizer.onresult = (event) => {
    let interim = '';
    let fin = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) fin += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (fin) finalText += fin;
    interimText = interim;
    emitResult(false);
  };

  recognizer.onerror = (event) => {
    recognizing = false;
    let msg;
    switch (event.error) {
      case 'not-allowed':
      case 'service-not-allowed':
        msg = '麦克风权限被拒绝，请在系统设置中允许';
        break;
      case 'no-speech':
        msg = '没有检测到说话声';
        break;
      case 'audio-capture':
        msg = '未找到麦克风设备';
        break;
      case 'network':
        msg = '系统语音识别依赖云端服务，当前网络不可达。建议改用「阿里云百炼」识别';
        break;
      case 'aborted':
        msg = '已取消';
        break;
      default:
        msg = '识别出错：' + event.error;
    }
    if (msg !== '已取消') onErrorCb && onErrorCb(msg);
  };

  recognizer.onend = () => {
    recognizing = false;
    finish();
  };

  recognizer.start();
  recognizing = true;
}

// ---------------- 对外接口 ----------------

/**
 * 开始语音识别
 * @param {object} cb
 * @param {(text:string, isFinal:boolean)=>void} cb.onResult
 * @param {(err:string)=>void} cb.onError
 * @param {(finalText:string)=>void} cb.onEnd
 * @param {(level:number)=>void} [cb.onLevel]  音量 0~1，用于界面动效
 * @param {string} [lang]
 * @param {'dashscope'|'system'} [provider]
 * @param {number} [silenceMs] 静音多久后自动结束
 */
export async function startRecognition({
  onResult, onError, onEnd, onLevel,
  lang = 'zh',
  provider = 'dashscope',
  silenceMs: silence = 2000
} = {}) {
  if (mode !== 'idle') stopRecognition();

  onResultCb = onResult || null;
  onErrorCb = onError || null;
  onEndCb = onEnd || null;
  onLevelCb = onLevel || null;
  finalText = '';
  interimText = '';
  lastEmitted = '';
  pcmBuffer = [];
  pcmBufferLen = 0;
  silenceMs = silence;

  mode = 'starting';

  try {
    if (provider === 'system') {
      startSystemRecognition({ lang: lang === 'zh' ? 'zh-CN' : lang });
      mode = 'running';
      return true;
    }
    await startDashscope({ lang, onLevel });
    mode = 'running';
    touchSilenceTimer();
    // 定时把缓冲区里的音频推给主进程（也保证静音期间有数据流）
    sendTimer = setInterval(() => flushChunks(false), CHUNK_MS);
    return true;
  } catch (e) {
    mode = 'idle';
    stopMediaCapture();
    onErrorCb && onErrorCb(String(e && e.message || e));
    return false;
  }
}

function emitResult(isFinal) {
  const text = (finalText + interimText).trim();
  if (text === lastEmitted && !isFinal) return;
  lastEmitted = text;
  onResultCb && onResultCb(text, isFinal);
}

/** 结束识别：把剩余音频发完并让服务端做最后判决 */
export function stopRecognition() {
  if (mode === 'idle') return;

  if (recognizer && recognizing) {
    // 系统模式：交给它自己的 onend 收尾
    try { recognizer.stop(); } catch {}
    return;
  }

  if (mode !== 'running' && mode !== 'starting') return;
  mode = 'stopping';

  // 把缓冲区剩下的音频一次性发完，再通知服务端结束
  try { flushChunks(true); } catch {}
  stopMediaCapture();

  setTimeout(() => {
    try { window.xw.asrStop(); } catch {}
  }, 120);
}

/** 直接取消：不发 finish-task，立即断开 */
export function abortRecognition() {
  if (mode === 'idle') return;
  mode = 'stopping';
  if (recognizer) {
    try { recognizer.abort(); } catch {}
  }
  stopMediaCapture();
  try { window.xw.asrCancel(); } catch {}
  mode = 'idle';
}

export function isRecognizing() {
  return mode === 'running' || mode === 'starting' || mode === 'stopping';
}

/**
 * 由 panel.js 在主进程推送识别结果时调用。
 * 把「中间结果 / 最终结果」统一收口到这里，避免界面各处理一套。
 */
export function pushAsrResult({ text, isFinal }) {
  if (isFinal) {
    // 服务端按句切分：成品句子累加，中间结果清空
    finalText = (finalText + text).replace(/\s+/g, '');
    interimText = '';
  } else {
    interimText = text || '';
  }
  emitResult(!!isFinal);
}

/** 主进程告知会话结束（task-finished / 连接关闭） */
export function handleAsrEnd() {
  stopMediaCapture();
  const wasStopping = mode === 'stopping';
  mode = 'idle';
  const t = (finalText || '').trim();
  onEndCb && onEndCb(t);
}

export function handleAsrError(msg) {
  stopMediaCapture();
  mode = 'idle';
  onErrorCb && onErrorCb(msg);
}

// =================== 语音朗读 ===================

let voices = [];
let speaking = false;
let currentUtterance = null;

export function loadVoices() {
  if (!('speechSynthesis' in window)) return [];
  voices = window.speechSynthesis.getVoices();
  return voices;
}

export function getVoices() {
  if (!voices.length) loadVoices();
  return voices;
}

// 语音列表异步加载
if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    loadVoices();
    document.dispatchEvent(new CustomEvent('voices-ready', { detail: voices }));
  };
  // 主动触发一次
  setTimeout(loadVoices, 120);
  setTimeout(loadVoices, 600);
}

/**
 * 挑选最合适的中文语音
 */
export function pickDefaultVoice(preferName) {
  const list = getVoices();
  if (!list.length) return null;

  if (preferName) {
    const hit = list.find((v) => v.name === preferName);
    if (hit) return hit;
  }

  // 优先中文
  const zh = list.filter((v) => /^zh|chinese|中文|普通话/i.test(v.lang + v.name));
  if (zh.length) {
    // 偏爱女声 / 常见优质音色
    const preferred = zh.find((v) => /Xiaoxiao|Huihui|Yaoyao|Xiaoyi|Yunxi|Tingting|Mei/i.test(v.name));
    return preferred || zh[0];
  }
  return list[0];
}

/**
 * 朗读文本
 */
export function speak(text, { rate = 1, volume = 1, voiceName = '', onStart, onEnd, onError } = {}) {
  if (!('speechSynthesis' in window)) {
    onError && onError('当前环境不支持语音合成');
    return false;
  }

  stopSpeaking();

  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = Math.min(Math.max(rate, 0.5), 2);
  utter.volume = Math.min(Math.max(volume, 0), 1);
  utter.pitch = 1;
  utter.lang = 'zh-CN';

  const v = pickDefaultVoice(voiceName);
  if (v) {
    utter.voice = v;
    utter.lang = v.lang || 'zh-CN';
  }

  utter.onstart = () => {
    speaking = true;
    onStart && onStart();
  };
  utter.onend = () => {
    speaking = false;
    currentUtterance = null;
    onEnd && onEnd();
  };
  utter.onerror = (e) => {
    speaking = false;
    currentUtterance = null;
    if (e.error !== 'interrupted' && e.error !== 'canceled') {
      onError && onError('朗读失败：' + e.error);
    } else {
      onEnd && onEnd();
    }
  };

  currentUtterance = utter;
  // Chromium 已知问题：长时间不说话会被挂起，这里分段处理
  window.speechSynthesis.speak(utter);
  return true;
}

export function stopSpeaking() {
  if ('speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {}
  }
  speaking = false;
  currentUtterance = null;
}

export function isSpeaking() {
  return speaking;
}
