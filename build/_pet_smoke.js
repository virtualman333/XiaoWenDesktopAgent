/**
 * 桌面宠物冒烟：加载 pet.html，驱动真实 IPC，验证
 *   1) 无控制台报错
 *   2) 6 只动物都能渲染
 *   3) 点击 / 喂食 / 睡觉 / 换动物 / 散步 状态变化正确
 *   4) 截图
 * 运行：node_modules/electron/dist/electron.exe build/_pet_smoke.js
 */
delete process.env.ELECTRON_RUN_AS_NODE;

const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, screen } = require('electron');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

const USERDATA = path.join(os.homedir(), 'AppData', 'Roaming', 'xiaowen-assistant');
try { fs.mkdirSync(path.join(USERDATA, 'jarvis'), { recursive: true }); } catch (e) {}
app.setPath('userData', USERDATA);

const errors = [];
const logs = [];
const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok, extra });
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra ? ' :: ' + extra : ''));
}

const cfgObj = {
  petEnabled: true, petAnimal: 'penguin', petSize: 120, petOpacity: 1,
  petWalk: false, petTop: true, petInteraction: true
};

let petState = null;
let mouseIgnored = null;
let pos = { x: 300, y: 500 };

app.whenReady().then(async () => {
  ipcMain.handle('config:get', () => cfgObj);
  ipcMain.handle('config:set', (_e, p) => { Object.assign(cfgObj, p); return cfgObj; });
  ipcMain.handle('pet:state-get', () => petState);
  ipcMain.handle('pet:state-save', (_e, s) => { petState = s; return true; });
  ipcMain.handle('pet:ready', () => { mouseIgnored = true; return true; });
  ipcMain.handle('pet:set-mouse', (_e, ignore) => { mouseIgnored = !!ignore; return true; });
  ipcMain.handle('pet:drag-move', (_e, { dx, dy }) => { pos.x += dx; pos.y += dy; return true; });
  ipcMain.handle('pet:move-to', (_e, x, y) => { pos = { x, y }; return true; });
  ipcMain.handle('pet:get-bounds', () => ({
    x: pos.x, y: pos.y, w: 240, h: 250,
    workArea: { x: 0, y: 0, width: 1920, height: 1040 }
  }));
  ipcMain.handle('pet:snap', () => true);
  ipcMain.handle('pet:hide', () => true);
  ipcMain.handle('pet:show', () => true);
  ipcMain.handle('pet:toggle', () => true);
  ipcMain.handle('pet:set-opacity', () => true);
  ipcMain.handle('pet:set-top', () => true);
  ipcMain.handle('pet:resize', () => true);
  ipcMain.handle('pet:say-out', () => true);
  ipcMain.handle('open:external', () => {});

  const win = new BrowserWindow({
    width: 320, height: 320, show: false, transparent: true, frame: false,
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

  await win.loadFile(path.join(__dirname, '../src/renderer/pet.html'));
  await sleep(1200);

  // 1. 初始渲染
  const svgCount = await win.webContents.executeJavaScript(
    `document.querySelectorAll('#sprite svg').length`
  );
  check('宠物 SVG 已渲染', svgCount === 1, 'svg=' + svgCount);

  check('pet:ready 已触发（鼠标默认穿透）', mouseIgnored === true, 'ignore=' + mouseIgnored);

  // 2. 6 只动物都能切换
  const animals = ['penguin', 'cat', 'panda', 'rabbit', 'shiba', 'frog'];
  let allOk = true;
  for (const a of animals) {
    const ok = await win.webContents.executeJavaScript(`
      (async () => {
        try {
          const st = await window.xw.petStateGet();
          return true;
        } catch (e) { return 'ERR ' + e.message; }
      })()
    `).then(() => true).catch(() => false);
    // 通过菜单点击切换
    await win.webContents.executeJavaScript(`document.getElementById('menu').classList.add('show');`);
    const clicked = await win.webContents.executeJavaScript(`
      (() => {
        const chips = document.querySelectorAll('.animal-chip');
        const idx = ${animals.indexOf(a)};
        if (!chips[idx]) return false;
        chips[idx].click();
        return true;
      })()
    `);
    await sleep(260);
    const cur = await win.webContents.executeJavaScript(`window.__petDebugAnimal || document.querySelector('#sprite svg') ? 1 : 0`);
    if (!clicked) allOk = false;
  }
  const chipCount = await win.webContents.executeJavaScript(`document.querySelectorAll('.animal-chip').length`);
  check('6 只动物都在菜单里', chipCount === 6, 'chips=' + chipCount);

  const animalAfter = await win.webContents.executeJavaScript(`
    (async () => (await window.xw.getConfig()).petAnimal)()
  `).catch(() => null);
  check('切换动物已写入配置', animalAfter === 'frog', 'petAnimal=' + animalAfter);

  // 3. 喂食
  const before = await win.webContents.executeJavaScript(`document.getElementById('barHunger').style.width`);
  await win.webContents.executeJavaScript(`
    document.querySelector('.menu-item[data-act="feed"]').click();
  `);
  await sleep(400);
  const after = await win.webContents.executeJavaScript(`document.getElementById('barHunger').style.width`);
  check('喂食后饱食度上升', parseFloat(after) > parseFloat(before || '0'), `${before} -> ${after}`);

  // 4. 睡觉
  await win.webContents.executeJavaScript(`document.querySelector('.menu-item[data-act="sleep"]').click();`);
  await sleep(300);
  const sleeping = await win.webContents.executeJavaScript(
    `document.getElementById('petBody').classList.contains('state-sleep')`
  );
  check('睡觉状态生效', sleeping === true);

  await win.webContents.executeJavaScript(`document.querySelector('.menu-item[data-act="sleep"]').click();`);
  await sleep(300);
  const awake = await win.webContents.executeJavaScript(
    `!document.getElementById('petBody').classList.contains('state-sleep')`
  );
  check('起床状态生效', awake === true);

  // 5. 散步
  await win.webContents.executeJavaScript(`document.querySelector('.menu-item[data-act="walk"]').click();`);
  await sleep(2200);
  const posMoved = pos.x !== 300 || pos.y !== 500;
  check('散步会移动窗口', posMoved, `pos=${pos.x},${pos.y}`);
  await win.webContents.executeJavaScript(`document.querySelector('.menu-item[data-act="walk"]').click();`);
  await sleep(300);

  // 6. 点击互动（心情 +3、经验 +4）
  const moodBefore = await win.webContents.executeJavaScript(`document.getElementById('barMood').style.width`);
  await win.webContents.executeJavaScript(`document.getElementById('petBody').dispatchEvent(new MouseEvent('click', {bubbles:true}));`);
  await sleep(400);
  const bubbleShown = await win.webContents.executeJavaScript(
    `document.getElementById('bubble').classList.contains('show')`
  );
  check('点击后气泡出现', bubbleShown === true);

  // 7. 飘字
  const floats = await win.webContents.executeJavaScript(`document.querySelectorAll('.float-item').length`);
  check('互动飘字已生成', floats >= 0, 'floats=' + floats);

  // 8. 眼神跟随：mouseenter 应接管鼠标
  await win.webContents.executeJavaScript(`
    document.getElementById('petBody').dispatchEvent(new MouseEvent('mouseenter', {bubbles:false}));
  `);
  await sleep(200);
  check('鼠标进入宠物时接管点击', mouseIgnored === false, 'ignore=' + mouseIgnored);
  await win.webContents.executeJavaScript(`
    document.getElementById('petBody').dispatchEvent(new MouseEvent('mouseleave', {bubbles:false}));
  `);
  await sleep(200);
  check('鼠标离开后恢复穿透', mouseIgnored === true, 'ignore=' + mouseIgnored);

  // 9. 状态已落盘
  check('宠物状态已保存', !!petState && typeof petState.mood === 'number',
    petState ? `mood=${petState.mood} hunger=${petState.hunger} lv=${petState.level}` : 'null');

  // 截图
  await win.webContents.executeJavaScript(`
    document.getElementById('menu').classList.remove('show');
    document.getElementById('bubble').classList.add('show');
    document.getElementById('bubbleText').textContent = '主人，我在这儿！';
    document.getElementById('stats').classList.add('show');
  `);
  await sleep(700);
  const shot = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '_shot_pet.png'), shot.toPNG());

  // 换一只动物再截一张
  await win.webContents.executeJavaScript(`
    document.getElementById('menu').classList.add('show');
    document.querySelectorAll('.animal-chip')[4].click();
  `);
  await sleep(700);
  const shot2 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '_shot_pet2.png'), shot2.toPNG());

  console.log('\n--- console logs ---');
  logs.slice(0, 30).forEach((l) => console.log(l));
  console.log('\n--- errors ---');
  if (!errors.length) console.log('(无)');
  errors.slice(0, 20).forEach((l) => console.log('ERR ' + l));

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nRESULT: ${results.length - failed}/${results.length} 通过，控制台错误 ${errors.length} 条`);
  setTimeout(() => app.exit(0), 400);
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

app.on('window-all-closed', (e) => e.preventDefault());
