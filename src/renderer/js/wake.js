/**
 * 语音唤醒引擎（「小问小问」）
 *
 * 设计取舍：
 *   专业唤醒词方案（Porcupine / sherpa-onnx）要么要额外 Key、要么要下载模型 + 原生依赖，
 *   对一个纯 JS 的 Electron 小工具来说太重。这里走「两级检测」：
 *
 *   第一级（本地，零成本常驻）：Web Audio 采集 + RMS 能量 VAD。
 *     一直听着，但只算音量，不发任何网络请求，CPU 占用很低。
 *   第二级（云端，仅在有人说话时）：一旦 VAD 判定「有人在说话」，
 *     才开一条 ASR 会话，识别 2~3 秒，拿文本做关键词匹配。
 *
 *   这样平时不烧钱，只有真的说了话才产生一次短识别。
 *
 *   难点在于：VAD 触发后再去连 ASR（WebSocket 握手约 0.3~0.8s），
 *   唤醒词的前半截已经过去了。解决办法是维护一段「预缓冲」（pre-roll）——
 *   环形保留最近 700ms 的音频，ASR 会话一建立就先把这段补发过去。
 *
 * 注意：本模块运行在悬浮球窗口（ball.html）——它常驻且可见，
 * 不像 panel 窗口隐藏后会被 Chromium 限流。
 */

const TARGET_SR = 16000;
const CHUNK_MS = 100;
const SAMPLES_PER_CHUNK = (TARGET_SR * CHUNK_MS) / 1000; // 1600

const PRE_ROLL_MS = 700;      // 触发前保留的音频长度
const MAX_CAPTURE_MS = 2800;  // 单次识别最长采集时长
const TAIL_SILENCE_MS = 900;  // 说话结束后再录这么久就收尾
const COOLDOWN_MS = 1200;     // 两次触发之间的最小间隔
const END_TIMEOUT_MS = 4000;  // asr:end 迟迟不来时的兜底

// 限流：开着电视/开会的场景下 VAD 会被反复触发，每次触发都要开一次 ASR 会话。
// 这里限制「1 分钟内最多 12 次」，超了就自动歇 5 分钟，避免默默烧掉配额。
const RATE_WINDOW_MS = 60000;
const RATE_MAX = 12;
const RATE_COOLDOWN_MS = 5 * 60 * 1000;

// 中文 ASR 同音字太多（「小问」常被写成小文/小闻/小吻…），
// 这里给高频易混字建组，匹配时按字符类放宽。
const HOMOPHONE_GROUPS = [
  ['问', '文', '闻', '吻', '雯', '温', '稳', '紊', '瘟'],
  ['小', '晓', '肖', '笑'],
  ['助', '住', '注', '助', '著'],
  ['手', '首', '守']
];

export const DEFAULT_WAKE_WORDS = ['小问', '小文', '小闻', '小吻'];

// 宽松匹配的反面：这些词里也含「小问」，但显然不是在叫它。
// 「小问题不大」「小问号」这类日常表达会造成误唤醒，先拦掉。
const NEGATIVE_WORDS = ['小问题', '小问号', '小问卷'];

// ---------------- 状态 ----------------
let running = false;
let suspended = false;      // 外部（面板已打开 / 正在录音）要求暂停
let state = 'idle';         // idle | listening | recognizing | waiting

let audioCtx = null;
let mediaStream = null;
let sourceNode = null;
let workletNode = null;
let processorNode = null;
let muteGain = null;

let preRoll = [];           // 环形预缓冲：Float32Array 队列
let preRollLen = 0;

let sendBuf = [];           // 识别期间待发送的 Int16 队列
let sendBufLen = 0;

let noiseFloor = 0.006;     // 自适应底噪
let loudFrames = 0;         // 连续超阈值帧数
let lastVoiceAt = 0;
let cooldownUntil = 0;

let session = null;         // 当前识别会话
let endTimer = null;
let suspendTimer = null;

// 暂停分两种来源，必须分开记：
//   panelPaused —— 面板打开中，由主进程同步，只能由主进程解除
//   suspended   —— 临时暂停（刚唤醒过一次 / 正在录音），可带自动恢复
// 混在一起会出现「面板还开着，25 秒定时器到点又把监听放开了」的 bug。
let panelPaused = false;
let rateLimited = false;
let triggerTimes = [];
let cfg = {
  wakeWords: DEFAULT_WAKE_WORDS,
  sensitivity: 60,
  sound: true
};
let hooks = { onWake: null, onState: null, onError: null };
let offFns = [];

// ---------------- 工具 ----------------

function now() { return Date.now(); }

function setState(s) {
  if (state === s) return;
  state = s;
  hooks.onState && hooks.onState(s);
}

/** 是否处于暂停态（面板打开 or 临时暂停，任一成立即暂停） */
function isPaused() {
  return panelPaused || suspended;
}

/** 限流闸门：返回 false 表示这一分钟内触发太多次，已经自动歇了 */
function allowTrigger() {
  const t = now();
  triggerTimes = triggerTimes.filter((x) => t - x < RATE_WINDOW_MS);
  if (triggerTimes.length >= RATE_MAX) {
    if (!rateLimited) {
      rateLimited = true;
      suspendWake(true, RATE_COOLDOWN_MS);
      hooks.onError && hooks.onError('环境声音过于嘈杂，唤醒监听已暂停 5 分钟');
    }
    return false;
  }
  rateLimited = false;
  triggerTimes.push(t);
  return true;
}

/** 归一化：去空白标点、全角转半角、繁体常见字简化 */
function normalize(text) {
  if (!text) return '';
  let s = String(text);
  s = s.replace(/[\s，。！？、,.!?~～"'“”‘’:;；·\-—_()（）[\]【】]/g, '');
  s = s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );
  const tw = { 問: '问', 聞: '闻', 溫: '温', 穩: '稳', 曉: '晓', 麼: '么' };
  s = s.replace(/[問聞溫穩曉麼]/g, (c) => tw[c] || c);
  return s;
}

/** 把关键词编译成正则：同音字放宽为字符类 */
function compileWord(word) {
  const w = normalize(word);
  if (!w) return null;
  let pattern = '';
  for (const ch of w) {
    const group = HOMOPHONE_GROUPS.find((g) => g.includes(ch));
    if (group) {
      pattern += '[' + group.join('') + ']';
    } else {
      pattern += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/** 文本是否命中唤醒词，返回命中的词（未命中返回空串） */
export function matchWakeWord(text, words) {
  const t = normalize(text);
  if (!t) return '';
  for (const bad of NEGATIVE_WORDS) {
    if (t.includes(bad)) return '';
  }
  const list = (words && words.length ? words : DEFAULT_WAKE_WORDS);
  for (const w of list) {
    const re = compileWord(w);
    if (re && re.test(t)) return w;
  }
  return '';
}

/** 灵敏度 0~100 → 能量阈值（越灵敏阈值越低） */
function thresholdFor(sensitivity) {
  const s = Math.min(100, Math.max(0, Number(sensitivity) || 0)) / 100;
  return 0.05 - (0.05 - 0.006) * s;
}

function rms(input) {
  let sum = 0;
  for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
  return Math.sqrt(sum / (input.length || 1));
}

function floatToInt16(input, inputRate) {
  let src = input;
  if (inputRate && inputRate !== TARGET_SR) {
    const ratio = inputRate / TARGET_SR;
    const outLen = Math.floor(input.length / ratio);
    const tmp = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = input[idx] || 0;
      const b = input[idx + 1] !== undefined ? input[idx + 1] : a;
      tmp[i] = a + (b - a) * frac;
    }
    src = tmp;
  }
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const s = Math.max(-1, Math.min(1, src[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// ---------------- 预缓冲 ----------------

function pushPreRoll(float32) {
  preRoll.push(float32);
  preRollLen += float32.length;
  const limit = (TARGET_SR * PRE_ROLL_MS) / 1000;
  while (preRollLen > limit && preRoll.length > 1) {
    preRollLen -= preRoll.shift().length;
  }
}

function drainPreRoll() {
  const chunks = preRoll;
  preRoll = [];
  preRollLen = 0;
  for (const c of chunks) queuePcm(floatToInt16(c, audioCtx ? audioCtx.sampleRate : TARGET_SR));
}

// ---------------- 发送缓冲 ----------------

function queuePcm(int16) {
  if (!int16 || !int16.length) return;
  sendBuf.push(int16);
  sendBufLen += int16.length;
  flushPcm(false);
}

function flushPcm(force) {
  if (!session) return; // 没有会话时不要往 IPC 里塞音频
  while (sendBufLen >= SAMPLES_PER_CHUNK || (force && sendBufLen > 0)) {
    const take = force ? sendBufLen : SAMPLES_PER_CHUNK;
    const chunk = new Int16Array(take);
    let filled = 0;
    while (filled < take && sendBuf.length) {
      const head = sendBuf[0];
      const need = take - filled;
      if (head.length <= need) {
        chunk.set(head, filled);
        filled += head.length;
        sendBuf.shift();
      } else {
        chunk.set(head.subarray(0, need), filled);
        sendBuf[0] = head.subarray(need);
        filled += need;
      }
    }
    sendBufLen -= take;
    try {
      window.xw.asrAudio(chunk.buffer);
      if (session) session.frames++;
    } catch (e) {
      /* 会话已关闭时忽略 */
    }
  }
}

// ---------------- 提示音 ----------------

function playChime() {
  try {
    if (!audioCtx || audioCtx.state === 'closed') return;
    const t0 = audioCtx.currentTime;
    [880, 1320].forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + i * 0.09);
      gain.gain.exponentialRampToValueAtTime(0.16, t0 + i * 0.09 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.09 + 0.16);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t0 + i * 0.09);
      osc.stop(t0 + i * 0.09 + 0.2);
    });
  } catch {}
}

// ---------------- 音频帧处理 ----------------

function handleFrame(float32) {
  if (!running) return;
  const rate = audioCtx ? audioCtx.sampleRate : TARGET_SR;
  const level = rms(float32);

  // 底噪自适应：向下跟得快、向上跟得慢，避免人声把阈值抬上去
  if (level < noiseFloor) noiseFloor = noiseFloor * 0.85 + level * 0.15;
  else noiseFloor = noiseFloor * 0.995 + level * 0.005;
  noiseFloor = Math.min(0.05, Math.max(0.0015, noiseFloor));

  if (state === 'listening') {
    pushPreRoll(float32);
    const th = Math.max(thresholdFor(cfg.sensitivity), noiseFloor * 2.2);
    if (level > th) loudFrames++;
    else loudFrames = Math.max(0, loudFrames - 1);

    if (loudFrames >= 3 && now() >= cooldownUntil && !isPaused() && allowTrigger()) {
      loudFrames = 0;
      startSession();
    }
    return;
  }

  if (state === 'recognizing') {
    if (!session) {
      // 会话还在握手（asrStart 是异步的，约 0.3~0.8s）。这段时间的音频不能丢，
      // 否则唤醒词的开头正好被吃掉 —— 继续攒进预缓冲，会话建好后一起补发。
      pushPreRoll(float32);
      return;
    }
    queuePcm(floatToInt16(float32, rate));
    if (level > Math.max(thresholdFor(cfg.sensitivity) * 0.6, noiseFloor * 1.6)) {
      lastVoiceAt = now();
    }
    const elapsed = now() - session.startedAt;
    if (elapsed > MAX_CAPTURE_MS || now() - lastVoiceAt > TAIL_SILENCE_MS) {
      finishSession();
    }
  }
}

// ---------------- 识别会话 ----------------

async function startSession() {
  setState('recognizing');
  sendBuf = [];
  sendBufLen = 0;

  let res;
  try {
    res = await window.xw.asrStart({ sampleRate: TARGET_SR, language: 'zh' });
  } catch (e) {
    res = { ok: false, error: String(e && e.message || e) };
  }

  if (!running) return; // 期间被停掉了

  if (!res || res.ok !== true) {
    hooks.onError && hooks.onError((res && res.error) || '唤醒识别启动失败');
    backToListening();
    return;
  }

  session = { text: '', startedAt: now(), frames: 0, stopped: false };
  lastVoiceAt = now();
  drainPreRoll();
}

function finishSession() {
  if (!session || session.stopped) return;
  session.stopped = true;
  setState('waiting');
  flushPcm(true);
  setTimeout(() => {
    try { window.xw.asrStop(); } catch {}
  }, 150);

  // 兜底：服务端没回 asr:end 也要复位，否则会卡死在 waiting
  clearTimeout(endTimer);
  endTimer = setTimeout(() => {
    if (state === 'waiting') {
      hooks.onError && hooks.onError('唤醒识别超时');
      backToListening();
    }
  }, END_TIMEOUT_MS);
}

function backToListening() {
  clearTimeout(endTimer);
  endTimer = null;
  session = null;
  sendBuf = [];
  sendBufLen = 0;
  loudFrames = 0;
  cooldownUntil = now() + COOLDOWN_MS;
  if (running) setState('listening');
  else setState('idle');
}

function onWakeHit(word, rawText) {
  if (cfg.sound) playChime();
  const cb = hooks.onWake;
  backToListening();
  cb && cb({ word, text: rawText });
}

// ---------------- 生命周期 ----------------

export function isWakeSupported() {
  return !!navigator.mediaDevices?.getUserMedia &&
    typeof (window.AudioContext || window.webkitAudioContext) === 'function';
}

export function isWakeRunning() {
  return running;
}

export function wakeState() {
  return state;
}

/**
 * 启动唤醒监听
 * @param {object} o
 * @param {string[]} [o.wakeWords]    唤醒词（可多个，同音字自动放宽）
 * @param {number}   [o.sensitivity]  灵敏度 0~100
 * @param {boolean}  [o.sound]        命中时播放提示音
 * @param {(info:{word:string,text:string})=>void} [o.onWake]
 * @param {(s:string)=>void} [o.onState]
 * @param {(msg:string)=>void} [o.onError]
 */
export async function startWake(o = {}) {
  if (running) return true;
  if (!isWakeSupported()) {
    o.onError && o.onError('当前环境不支持麦克风采集');
    return false;
  }

  cfg = {
    wakeWords: (o.wakeWords && o.wakeWords.length ? o.wakeWords : cfg.wakeWords),
    sensitivity: o.sensitivity != null ? o.sensitivity : cfg.sensitivity,
    sound: o.sound != null ? o.sound : cfg.sound
  };
  hooks = {
    onWake: o.onWake || null,
    onState: o.onState || null,
    onError: o.onError || null
  };

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
    let msg = '无法打开麦克风：' + (e && e.message);
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      msg = '麦克风权限被拒绝，唤醒功能无法使用';
    } else if (name === 'NotFoundError') {
      msg = '未找到麦克风设备';
    } else if (name === 'NotReadableError') {
      msg = '麦克风被其他程序占用';
    }
    o.onError && o.onError(msg);
    return false;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: TARGET_SR
  });
  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch {}
  }
  // 窗口失焦等场景下 Chromium 可能挂起音频时钟，这里自动拉回来
  audioCtx.onstatechange = () => {
    if (running && audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
  };

  sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  muteGain = audioCtx.createGain();
  muteGain.gain.value = 0;
  muteGain.connect(audioCtx.destination);

  let usingWorklet = false;
  if (audioCtx.audioWorklet && typeof AudioWorkletNode === 'function') {
    try {
      const code = `
        class XwWake extends AudioWorkletProcessor {
          process(inputs) {
            const ch = inputs[0] && inputs[0][0];
            if (ch && ch.length) this.port.postMessage(new Float32Array(ch));
            return true;
          }
        }
        registerProcessor('xw-wake', XwWake);
      `;
      const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      await audioCtx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      workletNode = new AudioWorkletNode(audioCtx, 'xw-wake');
      workletNode.port.onmessage = (ev) => handleFrame(ev.data);
      sourceNode.connect(workletNode);
      workletNode.connect(muteGain);
      usingWorklet = true;
    } catch {
      /* 回退 ScriptProcessor */
    }
  }

  if (!usingWorklet) {
    processorNode = audioCtx.createScriptProcessor(4096, 1, 1);
    processorNode.onaudioprocess = (ev) => {
      handleFrame(new Float32Array(ev.inputBuffer.getChannelData(0)));
    };
    sourceNode.connect(processorNode);
    processorNode.connect(muteGain);
  }

  // ASR 事件：只发给发起窗口，所以这里独享，不会和面板的识别串台
  offFns.push(window.xw.onAsrResult((res) => {
    if (!session) return;
    const t = (res && res.text) || '';
    if (res && res.isFinal) session.text += t;

    // 中间结果里已经出现唤醒词就别等了，立刻收尾 —— 能省下半秒多的响应延迟
    if (session && !session.stopped) {
      const probe = session.text + (res && res.isFinal ? '' : t);
      const word = matchWakeWord(probe, cfg.wakeWords);
      if (word) {
        session.earlyHit = word;
        session.earlyText = probe;
        finishSession();
      }
    }
  }));

  offFns.push(window.xw.onAsrEnd(() => {
    if (!session) { backToListening(); return; }
    // 命中优先取「中间结果阶段」抓到的那个，响应更快
    const word = session.earlyHit || matchWakeWord(session.text || '', cfg.wakeWords);
    const text = session.earlyText || session.text || '';
    if (word) onWakeHit(word, text);
    else backToListening();
  }));

  offFns.push(window.xw.onAsrError((msg) => {
    hooks.onError && hooks.onError(String(msg || '唤醒识别出错'));
    backToListening();
  }));

  running = true;
  noiseFloor = 0.006;
  preRoll = [];
  preRollLen = 0;
  setState('listening');
  return true;
}

export function stopWake() {
  running = false;
  clearTimeout(endTimer);
  clearTimeout(suspendTimer);
  endTimer = null;
  suspendTimer = null;
  session = null;
  panelPaused = false;
  suspended = false;
  rateLimited = false;
  triggerTimes = [];

  offFns.forEach((fn) => { try { fn && fn(); } catch {} });
  offFns = [];

  try { if (workletNode) { workletNode.port.onmessage = null; workletNode.disconnect(); } } catch {}
  try { if (processorNode) { processorNode.onaudioprocess = null; processorNode.disconnect(); } } catch {}
  try { if (sourceNode) sourceNode.disconnect(); } catch {}
  try { if (muteGain) muteGain.disconnect(); } catch {}
  try { if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (audioCtx && audioCtx.state !== 'closed') audioCtx.close(); } catch {}

  workletNode = null;
  processorNode = null;
  sourceNode = null;
  muteGain = null;
  mediaStream = null;
  audioCtx = null;
  preRoll = [];
  preRollLen = 0;
  sendBuf = [];
  sendBufLen = 0;
  setState('idle');
}

/**
 * 临时暂停/恢复监听（刚唤醒过一次、或正在对话录音时用）
 * @param {boolean} value
 * @param {number} [autoResumeMs] 传了就在这段时间后自动恢复，防止漏掉 resume 卡死
 */
export function suspendWake(value, autoResumeMs) {
  suspended = !!value;
  clearTimeout(suspendTimer);
  suspendTimer = null;

  if (suspended) {
    if (state === 'recognizing') finishSession();
    loudFrames = 0;
    if (autoResumeMs && autoResumeMs > 0) {
      suspendTimer = setTimeout(() => { suspended = false; suspendTimer = null; }, autoResumeMs);
    }
  } else {
    cooldownUntil = now() + COOLDOWN_MS;
  }
}

/**
 * 面板打开/关闭时由主进程同步。和 suspendWake 分开记，
 * 避免临时暂停的定时器把「面板还开着」这个状态覆盖掉。
 */
export function setPanelPaused(value) {
  panelPaused = !!value;
  if (panelPaused) {
    clearTimeout(suspendTimer);
    suspendTimer = null;
    if (state === 'recognizing') finishSession();
    loudFrames = 0;
  } else {
    cooldownUntil = now() + COOLDOWN_MS;
  }
}

export function isWakeSuspended() {
  return isPaused();
}

/** 运行中改配置（设置页调完立即生效，不用重启监听） */
export function updateWakeConfig(patch = {}) {
  if (patch.wakeWords && patch.wakeWords.length) cfg.wakeWords = patch.wakeWords;
  if (patch.sensitivity != null) cfg.sensitivity = patch.sensitivity;
  if (patch.sound != null) cfg.sound = patch.sound;
}
