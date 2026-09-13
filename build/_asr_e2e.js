// ASR 端到端验证（一次性脚本，跑完即退出）
//
// 关键点：必须用 ws 包。Electron 32 内置 Node 20.18，没有全局 WebSocket，
// 而 ws 的回调签名 (data, isBinary) 与浏览器 (event) 不同 —— 这里刻意用
// 与 main.js 中完全一致的兼容写法，确保验证结果对生产代码有参考价值。
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

app.disableHardwareAcceleration();
// 与 main.js 保持一致：Windows 上关闭硬件加速与进程沙箱，
// 否则部分环境下 GPU 进程会反复崩溃并连带终止主进程。
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-setuid-sandbox');
app.setPath('userData', path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'xiaowen-assistant'));

function log(...a) { console.log('[E2E]', ...a); }

const DASHSCOPE_ASR_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';

function loadCfg() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf-8'));
  } catch { return {}; }
}

app.whenReady().then(async () => {
  const cfg = loadCfg();
  const key = cfg.asrApiKey;
  const model = cfg.asrModel || 'paraformer-realtime-v2';

  log('userData =', app.getPath('userData'));
  log('key =', key ? key.slice(0, 6) + '***' + key.slice(-4) : '(空)');
  log('model =', model);
  log('node =', process.versions.node, '/ electron =', process.versions.electron);

  // 1) 验证 ws 模块加载（这是本次修复的核心）
  let WS;
  try {
    const wsMod = require('ws');
    WS = wsMod.WebSocket || wsMod;
    log('1) require("ws") 成功，WebSocket 类型 =', typeof WS);
  } catch (e) {
    log('1) require("ws") 失败:', e.code || e.message);
    return app.exit(1);
  }
  log('   globalThis.WebSocket =', typeof globalThis.WebSocket, '(预期 undefined)');

  if (!key) { log('结论: 失败 —— 无 asrApiKey'); return app.exit(1); }

  // 2) 合成 3 秒 16kHz 单声道 PCM（2 秒正弦 + 1 秒静音）
  const SR = 16000;
  const pcm = new Int16Array(SR * 3);
  for (let i = 0; i < SR * 2; i++) pcm[i] = Math.round(5000 * Math.sin((2 * Math.PI * 441 * i) / SR));
  log('2) 合成音频:', pcm.length, '采样 /', pcm.buffer.byteLength, '字节');

  const taskId = require('crypto').randomUUID();
  let ws;
  try {
    ws = new WS(`${DASHSCOPE_ASR_URL}/?api_key=${encodeURIComponent(key)}`);
  } catch (e) {
    log('结论: 失败 —— 构造 WebSocket 异常:', e.message);
    return app.exit(1);
  }
  ws.binaryType = 'arraybuffer';

  const events = [];
  let frames = 0, bytes = 0;

  const finish = (code, msg) => {
    log('');
    log('=== 结论:', msg, '===');
    log('事件序列:', events.join(' → '));
    log('音频:', frames, '帧 /', bytes, '字节');
    try { ws.close(); } catch {}
    setTimeout(() => app.exit(code), 300);
  };
  const overall = setTimeout(() => finish(1, '失败 —— 整体超时(25s)'), 25000);

  const readText = (ev) => {
    if (typeof ev === 'string') return ev;
    if (ev && typeof ev.data === 'string') return ev.data;
    if (Buffer.isBuffer(ev)) { try { return ev.toString('utf-8'); } catch { return ''; } }
    return '';
  };

  ws.onopen = () => {
    log('3) WebSocket 连接成功 → 发送 run-task');
    ws.send(JSON.stringify({
      header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
      payload: {
        task_group: 'audio', task: 'asr', function: 'recognition', model,
        parameters: { format: 'pcm', sample_rate: SR, language_hints: ['zh'], heartbeat: true },
        input: {}
      }
    }));
  };

  ws.onmessage = (ev) => {
    const raw = readText(ev);
    if (!raw) return;
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const e = msg.header && msg.header.event;
    events.push(e);

    if (e === 'task-started') {
      log('4) 收到 task-started → 开始推送音频帧');
      const CHUNK = SR / 10;
      let off = 0;
      const t = setInterval(() => {
        if (off >= pcm.length) {
          clearInterval(t);
          log('5) 音频推送完毕 → finish-task');
          ws.send(JSON.stringify({
            header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
            payload: { input: {} }
          }));
          return;
        }
        if (ws.readyState !== 1) return;
        const slice = pcm.slice(off, off + CHUNK);
        ws.send(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength), { binary: true });
        frames++; bytes += slice.byteLength;
        off += CHUNK;
      }, 60);
      return;
    }

    if (e === 'result-generated') {
      const out = msg.payload && msg.payload.output;
      const sen = out && out.sentence;
      if (out && out.heartbeat) return;
      if (sen) log('   识别结果: text=' + JSON.stringify(sen.text) + ' end=' + sen.sentence_end);
      return;
    }

    if (e === 'task-finished') {
      clearTimeout(overall);
      finish(0, '成功 —— run-task → 音频流 → finish-task → task-finished 全链路通过');
      return;
    }

    if (e === 'task-failed') {
      clearTimeout(overall);
      const code = (msg.header && msg.header.error_code) || '';
      const detail = (msg.header && msg.header.error_message) || '';
      log('   task-failed:', code, detail);
      if (/NO_VALID_AUDIO/i.test(code)) {
        finish(0, '成功 —— 通道完整可用（合成正弦波非语音，服务端正确判定无有效音频）');
      } else {
        finish(1, '失败 —— ' + code + ' ' + detail);
      }
      return;
    }
  };

  ws.onerror = (e) => log('WebSocket 错误:', (e && e.message) || String(e));
  ws.onclose = (ev) => log('WebSocket 关闭 code=', ev && ev.code, 'reason=', ev && ev.reason);
});

app.on('window-all-closed', () => {});
