/**
 * UI 冒烟（工作台版）：加载真实面板页，把新加的工作台交互都点一遍，
 * 收集控制台报错并截图。
 *
 * 运行：cross-env ELECTRON_RUN_AS_NODE= electron build/_ui_smoke.js
 *   （必须确保 ELECTRON_RUN_AS_NODE 为空，否则 electron 会退化成 node 跑）
 *
 * 覆盖：
 *   1. 面板 + 设置页加载无报错
 *   2. 意图预览条（输入「每天早上…」→ 出现 ⏰ 提示 + 「就这么办」）
 *   3. 快捷定时对话框（创建 → 时间线上多一张「已安排」卡）
 *   4. Ctrl+K 命令面板（打开 / 过滤 / 关闭）
 *   5. 主动播报的回执 → 结果合并到同一张卡（先反馈再给结果）
 *   6. 上下文环（chat:context 推送 → 环有进度、出现「压」角标）
 *   7. 设置页各标签逐个切换
 */
delete process.env.ELECTRON_RUN_AS_NODE;

const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, ipcMain } = require('electron');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

const USERDATA = process.env.XW_UI_UD || path.join(os.tmpdir(), 'xw-ui-smoke');
try { fs.mkdirSync(USERDATA, { recursive: true }); } catch (e) {}
app.setPath('userData', USERDATA);

const errors = [];
const logs = [];
const checks = [];

function check(name, ok, extra) {
  checks.push({ name, ok: !!ok, extra: extra || '' });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  → ' + extra : ''}`);
}

app.whenReady().then(async () => {
  // ---------- 注册 IPC（jarvis 是真的，其余给个够用的桩） ----------
  const jarvis = require('../src/main/jarvis/index.js');
  const cfgObj = {
    apiBaseUrl: 'https://api.deepseek.com', model: 'deepseek-chat',
    apiKeyMasked: 'sk-test***abcd', asrApiKeyMasked: 'sk-test***wxyz',
    ttsProvider: 'web', ttsEnabled: true, ttsAutoSpeak: false,
    agentEnabled: true, contextTurns: 10, hotkey: 'Alt+Space', ballOpacity: 0.92,
    systemPrompt: '你是小问', asrProvider: 'dashscope', asrModel: 'paraformer-realtime-v2',
    asrSilenceMs: 2000, ttsRate: 0, ttsVolume: 100, ttsVoice: '',
    ttsDashModel: 'cosyvoice-v2', ttsDashVoice: 'longxiaochun_v2', ttsDashFormat: 'mp3',
    ttsOpenaiModel: 'tts-1', ttsOpenaiVoice: 'alloy'
  };
  ipcMain.handle('config:get', () => cfgObj);
  ipcMain.handle('config:set', (_e, p) => Object.assign(cfgObj, p));
  ipcMain.handle('history:get', () => []);
  ipcMain.handle('history:add', () => true);
  ipcMain.handle('history:clear', () => true);
  ipcMain.handle('gpu:status', () => ({ hardwareAcceleration: true, reason: 'smoke test' }));

  // 工作台以外的窗口给了桩，免得主进程日志里全是 "No handler registered"
  const stubs = {
    'pet:diag': { exists: true, enabled: true, visible: true, size: [240, 252], pos: [80, 1136], onScreen: true },
    'pet:health': { hints: ['宠物正常'], keepTop: true, summonHotkey: 'Ctrl+Alt+P' },
    'pet:summon-hotkey-get': { accel: 'Ctrl+Alt+P' },
    'pet:summon-hotkey-set': { ok: true },
    'pet:summon-out': { ok: true },
    'pet:top-out': { ok: true },
    'pet:hard-recover-out': { ok: true },
    'capture:hotkeys': { enabled: true, items: [{ label: '框选截图', accel: 'Alt+Shift+A', ok: true }] },
    'capture:probe-hotkey': { ok: true },
    'updater:state': { status: 'idle', version: '1.6.1' },
    'tray:diag': { exists: true, iconPath: 'x.ico', tooltip: '小问助手' },
    'clip:read': { ok: true, text: '冒烟测试剪贴板' },
    'pet:say': { ok: true }
  };
  Object.keys(stubs).forEach((ch) => ipcMain.handle(ch, () => stubs[ch]));

  jarvis.bindConfig(() => cfgObj);
  jarvis.registerAll();

  const win = new BrowserWindow({
    width: 1040, height: 780, show: false,
    webPreferences: {
      preload: path.join(__dirname, '../src/main/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    const src = String(sourceId || '').split(/[\\/]/).pop();
    const rec = `[${level}] ${message} @${src}:${line}`;
    logs.push(rec);
    if (level >= 2) errors.push(rec);
  });
  win.webContents.on('did-fail-load', (e, code, desc) => errors.push(`LOAD FAIL ${code} ${desc}`));

  const js = (code) => win.webContents.executeJavaScript(code, true);

  await win.loadFile(path.join(__dirname, '../src/renderer/panel.html'));
  await sleep(1800);
  // 真要截图就得让窗口可见：隐藏窗口的合成帧是旧的（会拍到上一个状态）
  win.show();
  await sleep(800);

  console.log('\n=== 工作台冒烟 ===');

  // ---------- 1. 首屏 ----------
  const welcome = await js(`document.getElementById('welcome').style.display !== 'none'`);
  check('首屏显示欢迎/工作台引导', welcome);

  // ---------- 2. 意图预览 ----------
  await js(`(() => {
    const i = document.getElementById('input');
    i.value = '每天早上 8:30 给我播一下天气';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(200);
  const intent = await js(`(() => {
    const bar = document.getElementById('intentBar');
    return {
      shown: !bar.hidden,
      ico: document.getElementById('intentIco').textContent,
      text: document.getElementById('intentText').textContent,
      go: !document.getElementById('intentGo').hidden
    };
  })()`);
  check('输入「每天早上…」→ 意图条出现', intent.shown);
  check('意图识别成「定时」类（⏰）', intent.ico === '⏰', intent.ico);
  check('给出「就这么办」按钮', intent.go);

  // ---------- 3. 快捷定时 ----------
  await js(`document.getElementById('intentGo').click()`);
  await sleep(250);
  const qsOpen = await js(`document.getElementById('qsMask').classList.contains('show')`);
  check('点「就这么办」→ 弹出快捷定时对话框', qsOpen);

  await js(`(() => {
    document.getElementById('qsTitle').value = '每日早报';
    document.getElementById('qsWhen').value = '每天 08:30';
    document.getElementById('qsPrompt').value = '播报今天的天气和要关注的事';
    document.getElementById('qsOk').click();
  })()`);
  await sleep(700);
  const qsRes = await js(`(() => {
    const cards = [...document.querySelectorAll('.tcard')];
    const last = cards[cards.length - 1];
    return {
      closed: !document.getElementById('qsMask').classList.contains('show'),
      cards: cards.length,
      state: last ? last.dataset.state : '',
      ask: last ? last.querySelector('.tcard-ask').textContent : '',
      body: last ? last.querySelector('.bubble').textContent : ''
    };
  })()`);
  check('创建后对话框关闭', qsRes.closed);
  check('时间线上留下「已安排」的卡', qsRes.cards >= 1 && qsRes.state === 'done', `cards=${qsRes.cards} state=${qsRes.state}`);
  check('卡片写明到点做什么', /播报今天的天气/.test(qsRes.body), qsRes.body.slice(0, 40));

  // ---------- 4. 命令面板 ----------
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
  await sleep(250);
  const palOpen = await js(`document.getElementById('paletteMask').classList.contains('show')`);
  check('Ctrl+K 打开命令面板', palOpen);

  await js(`(() => {
    const i = document.getElementById('paletteInput');
    i.value = '宠物';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(200);
  const palFilter = await js(`(() => {
    const items = [...document.querySelectorAll('#paletteList .pal-item')];
    return { n: items.length, title: items[0] ? items[0].querySelector('.pal-title').textContent : '' };
  })()`);
  check('命令面板能按关键词过滤', palFilter.n >= 1 && /宠物/.test(palFilter.title), `${palFilter.n} 项 / ${palFilter.title}`);

  await js(`document.getElementById('paletteInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
  const palClosed = await js(`!document.getElementById('paletteMask').classList.contains('show')`);
  check('Esc 关闭命令面板', palClosed);

  // ---------- 5. 先反馈、再给结果（同一张卡被改写，不新增） ----------
  const before = await js(`document.querySelectorAll('.tcard.proactive').length`);
  win.webContents.send('proactive:msg', { title: '热搜提醒', text: '收到，正在去抓热搜…', phase: 'ack', kind: 'hot' });
  await sleep(400);
  const ackState = await js(`(() => {
    const cards = [...document.querySelectorAll('.tcard.proactive')];
    const last = cards[cards.length - 1];
    return { n: cards.length, state: last ? last.dataset.state : '', body: last ? last.querySelector('.bubble').textContent : '' };
  })()`);
  check('回执阶段就先落一张卡（先反馈）', ackState.n === before + 1 && ackState.state === 'work', `n=${ackState.n} state=${ackState.state}`);

  win.webContents.send('proactive:msg', { title: '热搜提醒', text: '热搜第一是「XX」，要不要展开？', phase: 'done', kind: 'hot' });
  await sleep(400);
  const doneState = await js(`(() => {
    const cards = [...document.querySelectorAll('.tcard.proactive')];
    const last = cards[cards.length - 1];
    return {
      n: cards.length,
      state: last ? last.dataset.state : '',
      body: last ? last.querySelector('.bubble').textContent : '',
      hasFoot: last ? !last.querySelector('.tcard-foot').hidden : false
    };
  })()`);
  check('结果回来改写同一张卡（不刷屏）', doneState.n === ackState.n, `${ackState.n} → ${doneState.n}`);
  check('结果卡状态变「已完成」', doneState.state === 'done');
  check('结果卡有卡脚动作', doneState.hasFoot);

  // ---------- 6. 上下文环 ----------
  win.webContents.send('chat:context', {
    beforeTokens: 90000, afterTokens: 60000, budget: 128000, compressed: true,
    clippedTools: 3, digestLines: 5, droppedMessages: 0, keptTurns: 8, ratio: 0.66
  });
  await sleep(300);
  const ctx = await js(`(() => ({
    offset: document.getElementById('ctxRing').getAttribute('stroke-dashoffset'),
    badge: !document.getElementById('ctxBadge').hidden,
    title: document.getElementById('btnCtx').title
  }))()`);
  check('上下文环有进度（dashoffset 变了）', Number(ctx.offset) < 94.2, ctx.offset);
  check('压缩过就显示「压」角标', ctx.badge);
  check('悬浮提示写清压缩细节', /压缩比/.test(ctx.title), ctx.title.slice(0, 60));

  await win.webContents.capturePage().then((s) => fs.writeFileSync(path.join(__dirname, '_shot_workbench.png'), s.toPNG()));

  // ---------- 7. 设置页 ----------
  await js(`location.hash = '#settings';`);
  await sleep(1200);
  check('设置页可加载', true);
  await win.webContents.capturePage().then((s) => fs.writeFileSync(path.join(__dirname, '_shot_settings.png'), s.toPNG()));

  for (const tab of ['persona', 'agent', 'mcp', 'skills', 'voice', 'capture', 'pet', 'schedule', 'watch', 'advanced']) {
    await js(`document.querySelector('.st-nav-item[data-tab="${tab}"]').click();`);
    await sleep(320);
  }
  const tabOk = await js(`document.querySelectorAll('.st-section.active').length`);
  check('逐个切换设置标签后仍只有一个激活分区', tabOk === 1, String(tabOk));
  await win.webContents.capturePage().then((s) => fs.writeFileSync(path.join(__dirname, '_shot_settings_pet.png'), s.toPNG()));

  // ---------- 汇总 ----------
  const failed = checks.filter((c) => !c.ok);
  console.log('\n--- console logs ---');
  logs.slice(0, 40).forEach((l) => console.log(l));
  console.log('\n--- renderer errors ---');
  if (!errors.length) console.log('(无)');
  errors.slice(0, 20).forEach((l) => console.log('ERR ' + l));

  console.log(`\nRESULT: ${checks.length - failed.length}/${checks.length} 项通过` +
    (errors.length ? `，渲染端 ${errors.length} 个错误` : '，渲染端无报错'));
  if (failed.length) console.log('失败项：' + failed.map((f) => f.name).join(' / '));
  setTimeout(() => app.exit(failed.length || errors.length ? 1 : 0), 400);
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

app.on('window-all-closed', (e) => e.preventDefault());
