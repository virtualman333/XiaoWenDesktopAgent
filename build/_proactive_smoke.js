/**
 * 定时任务 / 主动关注 / 桌面宠物 的主进程接线冒烟测试
 *
 * 真的起 Electron、真的加载 dist/panel.html 设置页、真的走一遍 IPC：
 *   1) 宠物窗口能显示、体型正确
 *   2) 设置页多了「定时任务 / 主动关注」两个页签，且没有控制台报错
 *   3) schedule IPC 能建任务、能执行、结果能通过 bindProactive 播报出去
 *
 * 运行：node_modules/electron/dist/electron.exe build/_proactive_smoke.js
 */
delete process.env.ELECTRON_RUN_AS_NODE;

const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, ipcMain, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

// 独立 userData：正式版实例可能正在跑，共用目录会被单实例锁挡住
const REAL = path.join(os.homedir(), 'AppData', 'Roaming', 'xiaowen-assistant');
const USERDATA = path.join(__dirname, '_smoke_userdata');
try {
  fs.mkdirSync(path.join(USERDATA, 'jarvis'), { recursive: true });
  fs.copyFileSync(path.join(REAL, 'config.json'), path.join(USERDATA, 'config.json'));
  for (const f of fs.readdirSync(path.join(REAL, 'jarvis'))) {
    try { fs.copyFileSync(path.join(REAL, 'jarvis', f), path.join(USERDATA, 'jarvis', f)); } catch (e) { /* ignore */ }
  }
} catch (e) { /* ignore */ }
app.setPath('userData', USERDATA);

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' :: ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(USERDATA, 'config.json'), 'utf-8')); } catch (e) { /* ignore */ }
cfg.apiKey = 'sk-smoke';
cfg.model = 'smoke-model';

// 桩：对话请求返回流式
globalThis.fetch = async (url, opts) => {
  const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '今日晴，26 度。' } }] }) + '\n\n'
    + 'data: [DONE]\n\n';
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    text: async () => sse,
    body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } })
  };
};

// 主进程侧少量 IPC（真实由 main.js 注册）
ipcMain.handle('config:get', () => cfg);
ipcMain.handle('config:set', (_e, p) => { cfg = { ...cfg, ...p }; return cfg; });
ipcMain.handle('history:get', () => []);
ipcMain.handle('history:add', () => true);
ipcMain.handle('updater:state', () => ({ state: 'idle' }));
ipcMain.handle('gpu:status', () => ({ hardwareAcceleration: false, reason: '冒烟测试' }));
// 托盘主进程侧：这里用真实的 Tray 复现 main.js 的 diag / reload 语义
let smokeTrayDiag = { exists: false, source: '(未加载)', iconEmpty: true, iconSize: null, bounds: null };
ipcMain.handle('tray:diag', () => smokeTrayDiag);
ipcMain.handle('tray:reload', () => smokeTrayDiag);

const errors = [];

app.whenReady().then(async () => {
  const pet = require('../src/main/pet.js');
  const jarvis = require('../src/main/jarvis/index.js');

  // ---------- 1. 桌面宠物 ----------
  console.log('\n1. 桌面宠物窗口');
  pet.init({
    loadRenderer: (win, file) => win.loadFile(path.join(__dirname, '../dist', file)),
    getConfig: () => cfg,
    getSanitizedConfig: () => cfg,
    log: () => {}
  });
  await sleep(3000);
  let d = pet.diag();
  ok(d.exists === true, '宠物窗口已创建');
  ok(d.visible === true, '宠物窗口可见', JSON.stringify(d));

  // 故意把尺寸改坏，再叫回来，应该能自动纠正
  const w = pet.window;
  if (w && !w.isDestroyed()) {
    try { w.setSize(240, 1542); } catch (e) { /* ignore */ }
    // 立刻读：宠物散步时渲染层每秒十几次 pet:get-bounds，那条热路径上就带纠偏，
    // 等一会儿再读会「看起来没改坏」，反而让断言失去意义。
    const big = w.getSize();
    try { pet.rescue(); } catch (e) { /* ignore */ }
    await sleep(600);
    const fixed = w.getSize();
    console.log('   尺寸试验：改坏后 ' + JSON.stringify(big) + ' → 救援后 ' + JSON.stringify(fixed)
      + '，期望高度 ' + d.expectedHeight);
    d = pet.diag();
    ok(big[1] > 500, '确实把窗口改坏了（用于验证纠偏）', JSON.stringify(big));
    ok(Math.abs(fixed[1] - d.expectedHeight) <= 8, '体型跑偏后能被修正', JSON.stringify(fixed));
    ok(d.visible === true, '救援后依然可见');

    // 再改坏一次，这回不喊救援 —— 散步热路径应该自己把它掰回来
    try { w.setSize(240, 1200); } catch (e) { /* ignore */ }
    await sleep(900);
    const selfHealed = w.getSize();
    console.log('   热路径自愈：改坏后 ' + JSON.stringify(selfHealed) + '（期望接近 ' + d.expectedHeight + '）');
    ok(Math.abs(selfHealed[1] - d.expectedHeight) <= 8,
      '不用喊救援，散步时的纠偏也能把尺寸掰回来', JSON.stringify(selfHealed));
  }

  // 运行期自检：尺寸正常时不该乱动手
  const sc = pet.selfCheck();
  ok(sc && sc.fixed === '' && sc.diag && sc.diag.visible === true, '自检报告宠物正常（不误纠）', JSON.stringify(sc));

  // 被藏起来时，自检要能自动唤出
  if (w && !w.isDestroyed()) {
    try { w.hide(); } catch (e) { /* ignore */ }
    await sleep(400);
    ok(pet.diag().visible === false, '已把宠物藏起来（用于验证自检）');
    const sc2 = pet.selfCheck();
    await sleep(700);
    ok(/唤出/.test(sc2.fixed || '') && pet.diag().visible === true, '自检能把藏起来的宠物唤出', JSON.stringify(sc2));
  }

  // 源码扫描：pet.js 不能再用 setPosition（透明窗口上每调一次高度 +1px，
  // 散步时每秒十几调，一分钟就能把宠物顶出屏幕 —— 见 v1.6.0 修复）
  const petSrc = fs.readFileSync(path.join(__dirname, '../src/main/pet.js'), 'utf-8');
  ok(!/petWin\.setPosition\s*\(/.test(petSrc), 'pet.js 不再调用 setPosition');
  ok(/function moveWindow\s*\(/.test(petSrc) && /petWin\.setBounds\(\{/.test(petSrc),
    'pet.js 用 setBounds 显式带尺寸来移动窗口');

  // 回归：高频移动（模拟散步）不能把窗口撑大
  if (w && !w.isDestroyed()) {
    try { pet.rescue(); } catch (e) { /* ignore */ }
    await sleep(500);
    for (let i = 0; i < 300; i++) pet.moveWindow(300 + (i % 900), 1100);
    await sleep(800);
    const afterMove = w.getSize();
    console.log('   高频移动 300 次后尺寸 ' + JSON.stringify(afterMove) + '，期望高度 ' + d.expectedHeight);
    ok(Math.abs(afterMove[1] - d.expectedHeight) <= 8, '高频移动不会把窗口撑大', JSON.stringify(afterMove));
  }

  // ---------- 2. 系统托盘 ----------
  // 回归：安装版「右下角托盘图标不显示」= 图标没随包 + 兜底 base64 是张截断的 PNG
  // → nativeImage 解出 0x0 空图 → new Tray(空图) 不报错但什么都看不见。
  console.log('\n2. 系统托盘图标');
  const trayIcon = require('../src/main/tray-icon.js');
  const { Tray, nativeImage } = require('electron');

  const res = trayIcon.resolveTrayIcon({ log: (m) => console.log('   [tray] ' + m) });
  console.log('   图标来源 ' + res.source + ' 空图=' + res.empty
    + ' 尺寸=' + JSON.stringify(res.image ? res.image.getSize() : null));
  ok(!res.empty && res.image && !res.image.isEmpty(), '默认候选解出的是非空图标', res.source);
  ok(/src[\\/]assets[\\/]tray\.(ico|png)$/i.test(res.source),
    '用的是随包发布的 src/assets 图标（不是内联兜底）', res.source);

  const trayImg = trayIcon.iconForTray(res);
  ok(!trayImg.isEmpty(), 'iconForTray 给出非空图');
  let liveTray = null;
  try {
    liveTray = new Tray(trayImg);
    liveTray.setToolTip('小问助手 · 冒烟测试');
    const b = liveTray.getBounds();
    ok(b.width > 0 && b.height > 0, '托盘能建出来且占据托盘区域', JSON.stringify(b));
  } catch (e) {
    ok(false, '托盘能建出来', (e && e.message) || String(e));
  }

  // 设置页要读得到的诊断信息
  smokeTrayDiag = {
    exists: !!liveTray,
    source: res.source,
    iconEmpty: res.empty,
    iconSize: res.image ? res.image.getSize() : null,
    bounds: liveTray ? (() => { const b = liveTray.getBounds(); return [b.width, b.height]; })() : null
  };

  // 强制走内联兜底：它必须是**能用**的图（历史上它解出来是空图）
  const fb = trayIcon.resolveTrayIcon({ candidates: [path.join(__dirname, 'no-such-icon.ico')] });
  console.log('   兜底来源 ' + fb.source + ' 空图=' + fb.empty
    + ' 尺寸=' + JSON.stringify(fb.image ? fb.image.getSize() : null));
  ok(fb.source === 'inline-fallback' && !fb.empty && !fb.image.isEmpty(),
    '拿不到图标文件时，内联兜底也不是空图', JSON.stringify(fb.empty));

  // 源码扫描：图标解析必须收口到 tray-icon.js（且自带 isEmpty 校验）
  const mainSrc = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf-8');
  ok(/require\('\.\/tray-icon'\)/.test(mainSrc), 'main.js 使用 tray-icon.js 解析图标');
  ok(!/function getTrayIcon\(\)\s*\{\s*const icoPath/.test(mainSrc),
    'main.js 里不再有「只认 build/icon.ico」的老实现');
  const iconSrc = fs.readFileSync(path.join(__dirname, '../src/main/tray-icon.js'), 'utf-8');
  ok(/isEmpty\(\)/.test(iconSrc), 'tray-icon.js 会校验 isEmpty（空图是静默失败的根源）');

  // ---------- 3. 设置页 ----------
  console.log('\n3. 设置页新增分组');
  jarvis.bindConfig(() => cfg);
  jarvis.registerAll();
  const delivered = [];
  jarvis.bindProactive((p) => delivered.push(p));
  await jarvis.boot();

  const win = new BrowserWindow({
    width: 900,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../src/main/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) errors.push(msg); });
  await win.loadURL('file://' + path.join(__dirname, '../dist/panel.html').replace(/\\/g, '/') + '#settings');
  await sleep(1800);

  const dom = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({
    tabs: Array.from(document.querySelectorAll('.st-nav-item')).map(function(b){return b.dataset.tab;}),
    hasSchList: !!document.getElementById('schList'),
    hasSchEnabled: !!document.getElementById('schEnabled'),
    hasWatchEnabled: !!document.getElementById('wEnabled'),
    hasWatchCheck: !!document.getElementById('wCheckQuake'),
    weekdays: document.querySelectorAll('#schDays .wd').length,
    petDiag: (document.getElementById('stPetDiag')||{}).textContent || '',
    hasTrayReload: !!document.getElementById('stTrayReload'),
    trayDiag: (document.getElementById('stTrayDiag')||{}).textContent || ''
  })`));

  ok(dom.tabs.includes('schedule'), '设置页有「定时任务」页签', dom.tabs.join(','));
  ok(dom.tabs.includes('watch'), '设置页有「主动关注」页签');
  ok(dom.hasSchList && dom.hasSchEnabled, '定时任务表单元素齐全');
  ok(dom.hasWatchEnabled && dom.hasWatchCheck, '主动关注表单元素齐全');
  ok(dom.weekdays === 7, '星期多选有 7 个', String(dom.weekdays));
  ok(/宠物窗口状态/.test(dom.petDiag), '宠物状态自检显示出来了', dom.petDiag);
  ok(dom.hasTrayReload, '设置页有「重新载入托盘图标」按钮');
  ok(/托盘状态：正常/.test(dom.trayDiag), '托盘状态显示为正常（图标非空）', dom.trayDiag);

  // 点一下「重新载入托盘图标」：走 preload → IPC → 回填状态
  const trayClick = await win.webContents.executeJavaScript(`(function(){
    document.getElementById('stTrayReload').click();
    return new Promise(function(r){ setTimeout(function(){
      r((document.getElementById('stTrayDiag')||{}).textContent || '');
    }, 600); });
  })()`);
  ok(/托盘状态：正常/.test(trayClick), '点「重新载入托盘图标」后状态仍正常', trayClick);

  // ---------- 4. 定时任务走一遍（含主动播报） ----------
  console.log('\n4. 定时任务端到端');
  const added = await win.webContents.executeJavaScript(
    `window.xw.scheduleAdd({title:'冒烟任务', prompt:'播一下天气', when:{type:'daily', time:'08:30'}}).then(r=>JSON.stringify(r))`
  );
  const addRes = JSON.parse(added);
  ok(addRes.ok === true, '渲染层能新建任务', added);

  const listed = JSON.parse(await win.webContents.executeJavaScript(
    'window.xw.scheduleList().then(r=>JSON.stringify(r))'
  ));
  ok(listed.some((t) => t.title === '冒烟任务'), '渲染层能读到任务列表');
  ok(!!listed[0].whenText && !!listed[0].etaText, '任务带上了「什么时候 / 还有多久」', JSON.stringify(listed[0]));

  const runRes = JSON.parse(await win.webContents.executeJavaScript(
    `window.xw.scheduleRun(${JSON.stringify(addRes.task.id)}).then(r=>JSON.stringify(r))`
  ));
  ok(runRes.ok === true, '「跑一次」执行成功', JSON.stringify(runRes));
  ok(delivered.length >= 1, '结果被主动播报出去', String(delivered.length));
  ok(delivered.some((p) => p.kind === 'schedule' && /26 度/.test(p.text)), '播报内容正确', JSON.stringify(delivered[0] || {}));

  const ws = JSON.parse(await win.webContents.executeJavaScript('window.xw.watchStatus().then(r=>JSON.stringify(r))'));
  ok(ws && ws.quake && ws.hot, '主动关注状态能读到', JSON.stringify(ws));

  const removed = JSON.parse(await win.webContents.executeJavaScript(
    `window.xw.scheduleRemove(${JSON.stringify(addRes.task.id)}).then(r=>JSON.stringify(r))`
  ));
  ok(removed.ok === true, '能删除任务');

  ok(errors.length === 0, '设置页没有控制台报错', errors.slice(0, 3).join(' | '));

  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  setTimeout(() => app.exit(fail ? 1 : 0), 200);
});

app.on('window-all-closed', (e) => e.preventDefault());
