/**
 * 会议记录 —— 隐藏窗口里的采集器。
 *
 * 它只干一件事：把「会议里能听到的声音」变成文字，然后回传给主进程。
 *   · 系统声音（Windows loopback）：对方说话从扬声器出来，只有这条能录到
 *   · 麦克风（可选）：自己说话，直接采麦
 * 两路音频**加到同一个音频图里求和**（Web Audio 里多个 source 接到同一个输入节点
 * 就是相加，不需要自己写混音），再重采样成 16kHz 单声道 PCM，
 * 走主进程已有的 asr:* 通道（WebSocket + Key 都在主进程，这里不碰网络）。
 *
 * 两个必须处理的现实问题：
 *   1. 一次识别会话不能开几小时 —— 会掉线。所以每 segmentMinutes 主动换一条会话，
 *      换的期间音频先排在队列里，新会话起来立刻补发，避免丢话。
 *   2. 不同来源的 PCM 不能直接拼 —— 每一路都在自己的「分句」边界上累积文本，
 *      以「服务端给的成品句子」为单位回调给主进程，避免把半句话切碎。
 */

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_MS = 100;          // 音频上行节流：100ms 一批
const QUEUE_MAX_CHUNKS = 300;  // 换会话期间最多缓存 30 秒，超了丢最旧的
const VOICE_LEVEL = 0.012;     // 人声判定阈值（与 speech.js 保持一致）

const el = document.getElementById('stat');
let lastPaint = 0;
function paint(extra) {
  const now = Date.now();
  if (!extra && now - lastPaint < 400) return;
  lastPaint = now;
  if (!el) return;
  const s = [];
  s.push(`状态：<b>${st.running ? '记录中' : '待命'}</b>`);
  if (st.running) {
    s.push(`会话：${st.asrOn ? '已连接' : '连接中'}｜换会话 ${st.rotations} 次`);
    s.push(`来源：${st.sources.join(' + ') || '无'}`);
    s.push(`已上送：${st.sentChunks} 批 / ${Math.round(st.sentBytes / 1024)} KB`);
    s.push(`文字：${st.chars} 字｜${st.segments} 段`);
    s.push(`最近人声：${st.lastVoice ? Math.round((now - st.lastVoice) / 1000) + ' 秒前' : '还没听到'}`);
  }
  if (st.lastError) s.push(`最近错误：${st.lastError}`);
  el.innerHTML = s.join('<br>');
}

const st = {
  running: false,
  asrOn: false,
  rotating: false,
  rotations: 0,
  sources: [],
  queue: [],
  queuedLen: 0,
  sentChunks: 0,
  sentBytes: 0,
  chars: 0,
  segments: 0,
  lastVoice: 0,
  lastError: '',
  withMic: true,
  segmentMinutes: 5,
  startedAt: 0
};

let audioCtx = null;
let workletNode = null;
let processorNode = null;
let muteGain = null;
let systemStream = null;
let micStream = null;
let flushTimer = null;
let rotateTimer = null;
let voiceTimer = null;
let pendingText = '';   // 当前未成句的中间结果
let stopResolve = null;

// ---------------- 音频 ----------------

/** Float32 → 16k Int16（线性插值，对语音识别足够） */
function resampleToInt16(input, inputRate, outputRate = TARGET_SAMPLE_RATE) {
  if (!input || !input.length) return new Int16Array(0);
  if (inputRate === outputRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  const ratio = inputRate / outputRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = pos - i0;
    const s = Math.max(-1, Math.min(1, input[i0] * (1 - frac) + input[i1] * frac));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function calcLevel(float32) {
  let sum = 0;
  for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
  return Math.sqrt(sum / (float32.length || 1));
}

function enqueue(pcm) {
  if (!pcm || !pcm.length) return;
  st.queue.push(pcm);
  st.queuedLen += pcm.length;
  while (st.queue.length > QUEUE_MAX_CHUNKS) {
    const drop = st.queue.shift();
    st.queuedLen -= drop.length;
  }
}

/** 每 100ms 把队列里的音频发一批 */
function flushChunks(force = false) {
  if (!st.asrOn || (!st.queue.length && !force)) return;
  const parts = st.queue;
  const total = st.queuedLen;
  st.queue = [];
  st.queuedLen = 0;
  if (!parts.length) return;
  const merged = new Int16Array(total);
  let off = 0;
  for (const p of parts) { merged.set(p, off); off += p.length; }
  try {
    window.xw.asrAudio(merged.buffer);
    st.sentChunks += 1;
    st.sentBytes += merged.byteLength;
  } catch (e) {
    st.lastError = '音频上送失败：' + ((e && e.message) || e);
  }
}

let lastVoicePing = 0;
function onFrame(float32) {
  if (!st.running) return;
  const level = calcLevel(float32);
  if (level > VOICE_LEVEL) {
    st.lastVoice = Date.now();
    // 心跳别打太密：一秒钟一次足够主进程判断「还有人在说话」
    if (Date.now() - lastVoicePing > 1000) {
      lastVoicePing = Date.now();
      try { window.xw.minutesVoice({ level }); } catch (e) { /* ignore */ }
    }
  }
  enqueue(resampleToInt16(float32, audioCtx ? audioCtx.sampleRate : TARGET_SAMPLE_RATE));
}

async function buildGraph(withMic) {
  // 1) 系统声音（loopback）。video 是 Chromium 要求的形参，只用音轨。
  try {
    systemStream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 320, height: 180, frameRate: 1 },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
  } catch (e) {
    throw new Error('无法采集系统声音：' + ((e && e.message) || e));
  }
  const audioTracks = systemStream.getAudioTracks();
  if (!audioTracks.length) {
    throw new Error('没有取到系统声音轨道（这台机器可能没有可用的输出设备）');
  }
  st.sources = ['系统声音'];

  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: TARGET_SAMPLE_RATE });
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  // 2) 麦克风（可选）：自己说话从麦直接进来，比从扬声器绕一圈清楚
  if (withMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      st.sources.push('麦克风');
    } catch (e) {
      st.lastError = '麦克风打开失败（继续只用系统声音）：' + ((e && e.message) || e);
    }
  }

  // 3) 两路都接到同一个分析节点 —— Web Audio 会自动求和，不用自己混音
  const sources = [audioCtx.createMediaStreamSource(new MediaStream(audioTracks))];
  if (micStream) sources.push(audioCtx.createMediaStreamSource(micStream));

  let usingWorklet = false;
  if (audioCtx.audioWorklet && typeof AudioWorkletNode === 'function') {
    try {
      const code = `
        class XwMeetingCapture extends AudioWorkletProcessor {
          process(inputs) {
            const ch = inputs[0] && inputs[0][0];
            if (ch && ch.length) this.port.postMessage(new Float32Array(ch));
            return true;
          }
        }
        registerProcessor('xw-meeting-capture', XwMeetingCapture);
      `;
      const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      await audioCtx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      workletNode = new AudioWorkletNode(audioCtx, 'xw-meeting-capture');
      workletNode.port.onmessage = (ev) => onFrame(ev.data);
      for (const s of sources) s.connect(workletNode);
      muteGain = audioCtx.createGain();
      muteGain.gain.value = 0;    // 不往外放声，免得自己听自己
      workletNode.connect(muteGain);
      muteGain.connect(audioCtx.destination);
      usingWorklet = true;
    } catch (e) {
      st.lastError = 'AudioWorklet 不可用，回退 ScriptProcessor：' + ((e && e.message) || e);
    }
  }
  if (!usingWorklet) {
    processorNode = audioCtx.createScriptProcessor(4096, 1, 1);
    processorNode.onaudioprocess = (ev) => onFrame(new Float32Array(ev.inputBuffer.getChannelData(0)));
    for (const s of sources) s.connect(processorNode);
    muteGain = audioCtx.createGain();
    muteGain.gain.value = 0;
    processorNode.connect(muteGain);
    muteGain.connect(audioCtx.destination);
  }
}

function teardownGraph() {
  try { if (workletNode) { workletNode.port.onmessage = null; workletNode.disconnect(); } } catch (e) { /* ignore */ }
  try { if (processorNode) { processorNode.onaudioprocess = null; processorNode.disconnect(); } } catch (e) { /* ignore */ }
  try { if (muteGain) muteGain.disconnect(); } catch (e) { /* ignore */ }
  for (const s of [systemStream, micStream]) {
    try { if (s) s.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
  }
  try { if (audioCtx && audioCtx.state !== 'closed') audioCtx.close(); } catch (e) { /* ignore */ }
  workletNode = null;
  processorNode = null;
  muteGain = null;
  systemStream = null;
  micStream = null;
  audioCtx = null;
}

// ---------------- 识别会话 ----------------

function postSegment(text) {
  const t = String(text || '').replace(/\s+/g, '');
  if (!t) return;
  st.chars += t.length;
  st.segments += 1;
  try {
    window.xw.minutesChunk({ text: t, at: Date.now(), source: 'loopback' });
  } catch (e) { /* ignore */ }
}

async function startAsrSession() {
  const res = await window.xw.asrStart({ sampleRate: TARGET_SAMPLE_RATE, language: 'zh' });
  if (!res || res.ok !== true) {
    throw new Error((res && res.error) || '语音识别会话启动失败');
  }
  st.asrOn = true;
  flushChunks();
  paint();
}

/** 换一条识别会话：先把队列留下，新会话起来后立刻补发，不丢话 */
async function rotateSession() {
  if (!st.running || st.rotating) return;
  st.rotating = true;
  st.rotations += 1;
  try {
    st.asrOn = false;
    try { window.xw.asrStop(); } catch (e) { /* ignore */ }
  } catch (e) { /* ignore */ }
}

/** 用户点了「停止」 */
async function stopCapture(reason) {
  if (!st.running) return;
  st.running = false;
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
  if (voiceTimer) { clearInterval(voiceTimer); voiceTimer = null; }
  // 把还没发走的音频发完，再让服务端把最后一句吐出来
  try { flushChunks(true); } catch (e) { /* ignore */ }
  try { window.xw.asrStop(); } catch (e) { /* ignore */ }

  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    stopResolve = finish;
    setTimeout(finish, 6000);
  });
  stopResolve = null;
  teardownGraph();
  st.asrOn = false;
  paint(true);
  try { window.xw.minutesAck({ ok: true, reason, chars: st.chars, segments: st.segments }); } catch (e) { /* ignore */ }
}

// ---------------- 主进程结果回传 ----------------

window.xw.onAsrResult?.((p) => {
  if (!st.running) return;
  const text = String((p && p.text) || '');
  if (p && p.isFinal) {
    const whole = (pendingText + text).replace(/\s+/g, '');
    pendingText = '';
    if (whole) postSegment(whole);
  } else {
    pendingText = text;
  }
  paint();
});

window.xw.onAsrEnd?.(() => {
  st.asrOn = false;
  // 收尾时把半句话也存下来（服务端可能刚好在分句边界上断开）
  if (pendingText) { postSegment(pendingText); pendingText = ''; }
  // 注意：stopCapture 会先把 running 置 false 再等这条消息，
  // 所以 stopResolve 必须先判，否则「停止」要等满 6 秒超时。
  if (stopResolve) { stopResolve(); return; }
  if (!st.running) return;
  // 换会话：歇一下再开一条新的
  setTimeout(() => {
    if (!st.running) return;
    startAsrSession().catch((e) => {
      st.lastError = (e && e.message) || '重连失败';
      paint(true);
      // 重连失败就再试一次，还是不行就收尾，别让音频一直堆在内存里
      setTimeout(() => {
        if (!st.running) return;
        startAsrSession().catch((e2) => {
          st.lastError = '语音识别重连失败：' + ((e2 && e2.message) || e2);
          paint(true);
          stopCapture('reconnect-failed');
        });
      }, 4000);
    });
    st.rotating = false;
  }, 400);
});

window.xw.onAsrError?.((msg) => {
  st.asrOn = false;
  st.lastError = String(msg || '识别出错');
  paint(true);
  if (stopResolve) { stopResolve(); return; }
  if (!st.running) return;
  setTimeout(() => {
    if (!st.running) return;
    startAsrSession().catch(() => {});
  }, 3000);
});

// ---------------- 主进程指令 ----------------

window.xw.onMinutesCmd?.((payload) => {
  const cmd = payload && payload.cmd;
  if (cmd === 'start') {
    st.withMic = payload.withMic !== false;
    st.segmentMinutes = Number(payload.segmentMinutes) || 5;
    startAll().then(() => {
      window.xw.minutesAck({ ok: true, sources: st.sources });
    }).catch((e) => {
      st.lastError = (e && e.message) || String(e);
      paint(true);
      teardownGraph();
      window.xw.minutesAck({ ok: false, error: st.lastError });
    });
  } else if (cmd === 'stop') {
    stopCapture('manual').catch(() => {});
  } else if (cmd === 'ping') {
    window.xw.minutesAck({ ok: st.running });
  }
});

async function startAll() {
  if (st.running) return;
  st.lastError = '';
  st.chars = 0;
  st.segments = 0;
  st.sentChunks = 0;
  st.sentBytes = 0;
  st.rotations = 0;
  st.queue = [];
  st.queuedLen = 0;
  st.startedAt = Date.now();
  pendingText = '';
  await buildGraph(st.withMic);
  await startAsrSession();
  st.running = true;
  st.lastVoice = Date.now();
  flushTimer = setInterval(() => flushChunks(), CHUNK_MS);
  rotateTimer = setInterval(() => { rotateSession().catch(() => {}); }, Math.max(1, st.segmentMinutes) * 60000);
  paint(true);
}

paint(true);
