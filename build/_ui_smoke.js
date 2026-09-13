/**
 * UI 冒烟：加载真实面板页，收集控制台报错，并截图。
 * 运行：node_modules/electron/dist/electron.exe build/_ui_smoke.js
 */
delete process.env.ELECTRON_RUN_AS_NODE;

const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

const USERDATA = path.join(os.homedir(), 'AppData', 'Roaming', 'xiaowen-assistant');
try { fs.mkdirSync(USERDATA, { recursive: true }); } catch (e) {}
app.setPath('userData', USERDATA);

const errors = [];
const logs = [];

app.whenReady().then(async () => {
  // 注册 Jarvis IPC，页面才能拿到数据
  const { ipcMain } = require('electron');
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

  await win.loadFile(path.join(__dirname, '../src/renderer/panel.html'));
  await sleep(1800);

  const shot = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '_shot_chat.png'), shot.toPNG());

  // 切到设置页（走 hashchange 触发 initSettings）
  await win.webContents.executeJavaScript(`location.hash = '#settings';`);
  await sleep(1200);
  const shot2 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '_shot_settings.png'), shot2.toPNG());

  // 逐个点设置分组，看看有没有报错
  for (const tab of ['persona', 'agent', 'mcp', 'skills', 'voice', 'pet']) {
    await win.webContents.executeJavaScript(
      `document.querySelector('.st-nav-item[data-tab="${tab}"]').click();`
    );
    await sleep(450);
    if (tab === 'pet') {
      const shotPet = await win.webContents.capturePage();
      fs.writeFileSync(path.join(__dirname, '_shot_settings_pet.png'), shotPet.toPNG());
    }
  }
  const shot3 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '_shot_voice.png'), shot3.toPNG());

  console.log('--- console logs ---');
  logs.slice(0, 40).forEach((l) => console.log(l));
  console.log('\n--- errors ---');
  if (!errors.length) console.log('(无)');
  errors.slice(0, 20).forEach((l) => console.log('ERR ' + l));

  console.log('\nRESULT: ' + (errors.length ? errors.length + ' 个错误' : 'UI 无报错'));
  setTimeout(() => app.exit(0), 400);
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

app.on('window-all-closed', (e) => e.preventDefault());
