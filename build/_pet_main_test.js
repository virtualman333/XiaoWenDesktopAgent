/**
 * 宠物主进程接线验证：真实加载 src/main/pet.js 模块，确认
 *   1) 窗口创建 + pet.html 装载无报错
 *   2) resize / toggle / petSay 正常
 * 运行：node_modules/electron/dist/electron.exe build/_pet_main_test.js
 */
delete process.env.ELECTRON_RUN_AS_NODE;

const path = require('path');
const os = require('os');
const fs = require('fs');
const { app } = require('electron');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

const USERDATA = path.join(os.homedir(), 'AppData', 'Roaming', 'xiaowen-assistant');
try { fs.mkdirSync(USERDATA, { recursive: true }); } catch (e) {}
app.setPath('userData', USERDATA);

const cfgObj = { petEnabled: true, petAnimal: 'penguin', petSize: 120, petOpacity: 1, petWalk: false, petTop: true, petInteraction: true };
const errors = [];

app.whenReady().then(async () => {
  // pet.html 引用的 preload 需要 config / pet:* IPC；pet.init 会注册 pet:*，
  // 这里补齐页面启动所需的少量 handler。
  const { ipcMain } = require('electron');
  ipcMain.handle('config:get', () => cfgObj);

  const pet = require('../src/main/pet.js');
  pet.init({
    loadRenderer: (win, file) => win.loadFile(path.join(__dirname, '../src/renderer', file)),
    getConfig: () => cfgObj,
    log: (m) => console.log('[pet]', m)
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(2500);

  const w = pet.window;
  console.log((w && !w.isDestroyed()) ? 'PASS 窗口已创建' : 'FAIL 窗口未创建');
  console.log((w && w.isVisible()) ? 'PASS 窗口可见' : 'FAIL 窗口不可见');
  const [ww, wh] = w ? w.getSize() : [0, 0];
  console.log((ww === 240 && wh === 250) ? `PASS 默认尺寸 240x250 (实际 ${ww}x${wh})` : `FAIL 尺寸异常 ${ww}x${wh}`);

  // resize 到大号
  cfgObj.petSize = 200;
  pet.resize();
  await sleep(400);
  const [, wh2] = w.getSize();
  console.log(wh2 === 330 ? `PASS resize 后高度 330 (实际 ${wh2})` : `FAIL resize 高度异常 ${wh2}`);
  cfgObj.petSize = 120;
  pet.resize();
  await sleep(300);

  // petSay 不崩溃
  pet.petSay('主进程播报测试');
  await sleep(500);
  console.log('PASS petSay 已发送');

  // 渲染层有没有报错
  w.webContents.on('console-message', (e, level, msg) => { if (level >= 2) errors.push(msg); });

  // toggle 隐藏 / 显示
  pet.togglePet();
  await sleep(300);
  const hidden = !w.isVisible();
  pet.togglePet();
  await sleep(300);
  const shown = w.isVisible();
  console.log(hidden && shown ? 'PASS toggle 显示/隐藏' : `FAIL toggle hidden=${hidden} shown=${shown}`);

  console.log('\n渲染层错误: ' + (errors.length ? errors.join(' | ') : '(无)'));
  setTimeout(() => app.exit(0), 300);
});

app.on('window-all-closed', (e) => e.preventDefault());
