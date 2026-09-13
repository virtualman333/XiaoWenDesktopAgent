/**
 * 语音合成（TTS）—— 多方案可选
 *
 *   1. web       ：Web Speech API / 系统内置语音（Windows SAPI、macOS 语音）。
 *                  零配置、离线、延迟最低；音色机械、中文可选少。
 *   2. dashscope ：阿里云百炼 CosyVoice（cosyvoice-v1 / v2）。音质最好、中文自然，
 *                  需要 DashScope API Key，可与语音识别共用同一个 Key。
 *   3. openai    ：OpenAI 兼容 /v1/audio/speech 接口。自建服务或中转都能用，
 *                  音色由服务端决定（alloy / echo / nova ...）。
 *
 * dashscope 走的是和 ASR 同一个 WebSocket 端点，协议要点（实测）：
 *   - 连接后发 run-task（task_group=audio, task=tts, function=SpeechSynthesizer）
 *   - 服务端回 task-started，随后 result-generated 成对出现：
 *     先一个 JSON 文本帧（元数据），紧跟一个二进制帧（真实音频分片）
 *   - 注意：连 JSON 控制帧也是以二进制帧形式下发的，必须按首字节 '{' 判断
 *   - 服务端不会主动发 task-finished，用「静默 900ms 无新帧」判定合成结束
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');

const DASHSCOPE_TTS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';

// 与 main.js 中 ASR 保持一致的懒加载策略：Electron 内置 Node 20 没有全局 WebSocket
let WebSocketCtor = null;
(function resolveWebSocket() {
  try {
    const ws = require('ws');
    const C = ws.WebSocket || ws;
    if (typeof C === 'function') { WebSocketCtor = C; return; }
  } catch (e) { /* ignore */ }
  if (typeof globalThis.WebSocket === 'function') WebSocketCtor = globalThis.WebSocket;
})();

/** CosyVoice 音色（实测可用），按模型分组 */
const COSY_VOICES = {
  'cosyvoice-v2': [
    { id: 'longxiaochun_v2', name: '龙小淳（女·温柔）' },
    { id: 'longxiaoxia_v2', name: '龙小夏（女·活泼）' },
    { id: 'longcheng_v2', name: '龙橙（女·明亮）' },
    { id: 'longfei_v2', name: '龙飞（男·沉稳）' },
    { id: 'longshuo_v2', name: '龙硕（男·浑厚）' },
    { id: 'longtian_v2', name: '龙天（男·青年）' },
    { id: 'longyuan_v2', name: '龙媛（女·知性）' },
    { id: 'longjielidou_v2', name: '龙杰力豆（童声）' }
  ],
  'cosyvoice-v1': [
    { id: 'longxiaochun', name: '龙小淳（女·温柔）' },
    { id: 'longxiaoxia', name: '龙小夏（女·活泼）' },
    { id: 'longcheng', name: '龙橙（女·明亮）' },
    { id: 'longfei', name: '龙飞（男·沉稳）' },
    { id: 'longshuo', name: '龙硕（男·浑厚）' },
    { id: 'longjielidou', name: '龙杰力豆（童声）' }
  ]
};

const OPENAI_VOICES = [
  { id: 'alloy', name: 'Alloy（中性）' },
  { id: 'echo', name: 'Echo（男）' },
  { id: 'fable', name: 'Fable（英式）' },
  { id: 'onyx', name: 'Onyx（男·低沉）' },
  { id: 'nova', name: 'Nova（女）' },
  { id: 'shimmer', name: 'Shimmer（女·轻快）' }
];

function tmpAudioFile(ext) {
  const dir = path.join(os.tmpdir(), 'xiaowen-tts');
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
  return path.join(dir, 'tts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.' + ext);
}

// ---------------- 方案一：阿里云百炼 CosyVoice ----------------
function synthDashscope({ text, apiKey, model, voice, format, sampleRate, rate, volume, timeoutMs }) {
  return new Promise((resolve) => {
    if (!WebSocketCtor) return resolve({ ok: false, error: '缺少 WebSocket 实现（ws 模块未安装）' });
    if (!apiKey) return resolve({ ok: false, error: '未配置百炼 API Key' });
    if (!text || !text.trim()) return resolve({ ok: false, error: '合成内容为空' });

    const fmt = (format || 'mp3').toLowerCase();
    const url = `${DASHSCOPE_TTS_URL}/?api_key=${encodeURIComponent(apiKey)}`;
    let ws;
    try {
      ws = new WebSocketCtor(url);
    } catch (e) {
      return resolve({ ok: false, error: '建立连接失败：' + (e && e.message) });
    }

    const chunks = [];
    let bytes = 0;
    let settled = false;
    let silenceTimer = null;
    const taskId = 'tts-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const hardTimeout = setTimeout(() => finish(true), timeoutMs || 25000);

    function finish(isTimeout) {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      if (silenceTimer) clearTimeout(silenceTimer);
      try { ws && ws.close && ws.close(); } catch (e) { /* ignore */ }
      if (!bytes) return resolve({ ok: false, error: '未收到音频数据' });
      const file = tmpAudioFile(fmt);
      try {
        fs.writeFileSync(file, Buffer.concat(chunks));
        resolve({ ok: true, file, bytes, format: fmt, truncated: !!isTimeout });
      } catch (e) {
        resolve({ ok: false, error: '写入临时音频失败：' + (e && e.message) });
      }
    }

    function armSilence() {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => finish(false), 900);
    }

    const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ } };
    const onOpen = () => {
      send({
        header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio',
          task: 'tts',
          function: 'SpeechSynthesizer',
          model: model || 'cosyvoice-v2',
          input: { text: text.slice(0, 2000) },
          parameters: {
            voice: voice || 'longxiaochun_v2',
            format: fmt,
            sample_rate: sampleRate || 24000,
            volume: typeof volume === 'number' ? volume : 50,
            rate: typeof rate === 'number' ? rate : 1.0,
            pitch: 1.0
          }
        }
      });
    };

    const onMessage = (data) => {
      let buf;
      if (Buffer.isBuffer(data)) buf = data;
      else if (data instanceof ArrayBuffer) buf = Buffer.from(data);
      else if (data && data.data !== undefined) buf = Buffer.isBuffer(data.data) ? data.data : Buffer.from(String(data.data));
      else if (typeof data === 'string') buf = Buffer.from(data, 'utf-8');
      else return;

      // 控制帧也是二进制下发的：首字节 '{' 视为 JSON
      if (buf.length && buf[0] === 0x7b) {
        try {
          const obj = JSON.parse(buf.toString('utf-8'));
          const ev = obj.header && obj.header.event;
          if (ev === 'task-failed') {
            const msg = (obj.payload && (obj.payload.message || obj.payload.error && obj.payload.error.message)) || obj.header.error_message || '合成失败';
            settled = true;
            clearTimeout(hardTimeout);
            if (silenceTimer) clearTimeout(silenceTimer);
            try { ws && ws.close && ws.close(); } catch (e) { /* ignore */ }
            return resolve({ ok: false, error: String(msg).slice(0, 300) });
          }
          if (ev === 'task-finished') { finish(false); return; }
        } catch (e) { /* 不是 JSON，当音频处理 */ }
      }

      chunks.push(buf);
      bytes += buf.length;
      armSilence();
    };

    if (typeof ws.addEventListener === 'function') {
      // 浏览器风格（globalThis.WebSocket）
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', (ev) => onMessage(ev.data));
      ws.addEventListener('error', () => { if (!settled) { settled = true; clearTimeout(hardTimeout); resolve({ ok: false, error: 'WebSocket 连接错误' }); } });
    } else {
      ws.on('open', onOpen);
      ws.on('message', onMessage);
      ws.on('error', (e) => { if (!settled) { settled = true; clearTimeout(hardTimeout); resolve({ ok: false, error: 'WebSocket 错误：' + (e && e.message) }); } });
      ws.on('close', () => { if (!settled) finish(true); });
    }
  });
}

// ---------------- 方案二：OpenAI 兼容 TTS ----------------
function synthOpenai({ text, baseUrl, apiKey, model, voice, format, speed, timeoutMs }) {
  return new Promise((resolve) => {
    if (!baseUrl) return resolve({ ok: false, error: '未配置 TTS 接口地址' });
    if (!text || !text.trim()) return resolve({ ok: false, error: '合成内容为空' });

    const base = String(baseUrl).replace(/\/+$/, '');
    const endpoint = /\/audio\/speech$/.test(base) ? base : base + '/v1/audio/speech';
    const fmt = (format || 'mp3').toLowerCase();
    const body = JSON.stringify({
      model: model || 'tts-1',
      input: text.slice(0, 4000),
      voice: voice || 'alloy',
      response_format: fmt,
      speed: typeof speed === 'number' ? speed : 1.0
    });

    let u;
    try { u = new URL(endpoint); } catch (e) { return resolve({ ok: false, error: '接口地址不合法' }); }
    const mod = u.protocol === 'http:' ? http : https;

    const req = mod.request({
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {})
      },
      timeout: timeoutMs || 30000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const file = tmpAudioFile(fmt);
          try {
            fs.writeFileSync(file, buf);
            resolve({ ok: true, file, bytes: buf.length, format: fmt });
          } catch (e) {
            resolve({ ok: false, error: '写入临时音频失败' });
          }
        } else {
          resolve({ ok: false, error: `HTTP ${res.statusCode}：${buf.toString('utf-8').slice(0, 300)}` });
        }
      });
    });

    req.on('error', (e) => resolve({ ok: false, error: '请求失败：' + (e && e.message) }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '请求超时' }); });
    req.write(body);
    req.end();
  });
}

/** 统一入口：返回 { ok, file?, error? }。file 为本地音频路径（web 方案返回 null，由渲染进程朗读） */
async function synth(opts = {}) {
  const provider = opts.provider || 'web';
  if (provider === 'dashscope') {
    return synthDashscope(opts);
  }
  if (provider === 'openai') {
    return synthOpenai(opts);
  }
  return { ok: false, error: 'web 方案由渲染进程直接朗读，无需主进程合成' };
}

/** 测试连通性：合成一句固定的话 */
async function test(opts = {}) {
  if (opts.provider === 'web') {
    return { ok: true, provider: 'web', note: '系统内置语音无需联网' };
  }
  const r = await synth({ ...opts, text: opts.text || '你好主人，我是小问，语音合成测试成功。' });
  return { ...r, provider: opts.provider };
}

module.exports = { synth, test, COSY_VOICES, OPENAI_VOICES };
