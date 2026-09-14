/**
 * 桌面宠物「置顶被侵犯」回归测试（白盒）—— electron build/_pet_top_test.js
 *
 * why：
 *   alwaysOnTop 只是把窗口放进「最上层那一组」，组内顺序取决于最后激活时间。
 *   任何后创建的置顶窗口（会议共享画面、全屏播放器）都能把宠物压住 ——
 *   用户看到的就是「宠物没显示」。修法是周期性重夺最上层 + 用更高级的
 *   screen-saver 级别 + 必要时整个重建窗口。
 *
 * 白盒做法：直接在窗口对象上打点，断言「到底有没有调 setAlwaysOnTop /
 * moveTop / 用什么级别」，不抓屏幕像素（那玩意又慢又会受机器状态影响）。
 *
 * 跑法：node_modules/electron/dist/electron.exe build/_pet_top_test.js
 */
delete process.env.ELECTRON_RUN_AS_NODE;
const { app, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');
const UD = path.join(os.tmpdir(), 'xw-pet-top-' + Date.now());
fs.mkdirSync(UD, { recursive: true });
app.setPath('userData', UD);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; const fails = [];
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (extra ? ` → ${extra}` : '')); console.log('  ✗ ' + name + (extra ? ` → ${extra}` : '')); }
};
const eq = (a, b, name) => ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
const section = (s) => console.log('\n' + s);

/** 在窗口上打点：记录 setAlwaysOnTop / moveTop 的调用 */
let spy = null;
function attachSpy(win) {
  spy = { top: [], moveTop: 0 };
  if (!win) return spy;
  const t = win.setAlwaysOnTop.bind(win);
  win.setAlwaysOnTop = (flag, level, rel) => { spy.top.push([flag, level]); return t(flag, level, rel); };
  const m = win.moveTop.bind(win);
  win.moveTop = () => { spy.moveTop++; return m(); };
  return spy;
}

let pet = null;
const cfgObj = { petEnabled: true, petTop: true, petKeepTop: true, petSize: 120 };

app.whenReady().then(async () => {
  console.log('\n=== 桌面宠物 · 置顶重夺（白盒）===');
  pet = require('../src/main/pet.js');
  pet.init({
    getConfig: () => cfgObj,
    log: () => {},
    // 只要一个干净的窗口，不加载渲染端（我们验证的是窗口层级，不是企鹅画得美不美）
    loadRenderer: (win) => win.loadURL('data:text/html,<body style="margin:0;background:rgb(4,81,222)"></body>')
  });

  const w0 = pet.createPetWindow();
  await sleep(1800);
  attachSpy(w0);

  // ---------------- 1. 起手式 ----------------
  section('1. 建窗口');
  ok(!!w0 && !w0.isDestroyed(), '宠物窗口建出来了');
  const d0 = pet.diag();
  eq(d0.exists, true, 'diag 说窗口存在');
  eq(d0.visible, true, 'diag 说窗口可见');
  eq(d0.alwaysOnTop, true, '窗口带着 alwaysOnTop 属性');
  eq(d0.onScreen, true, '窗口落在某块屏幕范围内（多屏也算）', JSON.stringify(d0.pos));
  ok(d0.size[0] > 0 && d0.size[1] > 0, '尺寸正常（不是 0×0）', JSON.stringify(d0.size));

  // ---------------- 2. resyncTop 到底做了什么 ----------------
  section('2. resyncTop 的行为（白盒）');
  spy.top = []; spy.moveTop = 0;
  const r1 = pet.resyncTop('test');
  eq(r1, true, '返回成功');
  ok(spy.top.some(([f, lv]) => f === true && lv === 'screen-saver'),
    '用的是 screen-saver 级别（比普通置顶高一级，普通 alwaysOnTop 窗口盖不住）',
    JSON.stringify(spy.top));
  ok(spy.top.every(([f]) => f === true), '没有把置顶关掉');
  eq(spy.moveTop > 0, true, '调了 moveTop()（把后建的置顶窗口压下去）');

  section('2b. resyncTop 的节流');
  const before = spy.moveTop;
  pet.resyncTop('test'); pet.resyncTop('test');
  ok(spy.moveTop > before, '重复调用依然会尝试（真正的节流交给 tickTop）');

  // ---------------- 3. 开关要听话 ----------------
  section('3. 尊重主人的开关');
  cfgObj.petTop = false;
  spy.top = []; spy.moveTop = 0;
  eq(pet.resyncTop('test'), false, '主人关了置顶 → 不再强抢');
  eq(spy.moveTop, 0, '一个动作都没做（不跟主人对着干）');

  cfgObj.petTop = true;
  cfgObj.petKeepTop = false;
  eq(pet.resyncTop('timer'), false, '只关掉「周期重夺」→ 定时器那次不强抢');
  eq(pet.resyncTop('summon'), true, '但主人主动召唤时照样抢到最上层');
  cfgObj.petKeepTop = true;

  // ---------------- 4. 窗口没了要敢承认 ----------------
  section('4. 窗口没了的兜底');
  pet.closePetWindow();
  eq(pet.resyncTop('test'), false, '窗口已经被关 → 返回 false 而不是抛异常');
  eq(pet.diag().exists, false, 'diag 如实报告窗口没了');

  // ---------------- 5. 硬恢复 ----------------
  section('5. 硬恢复');
  const id0 = w0.id;
  pet.hardRecover('测试');
  await sleep(1800);
  ok(!!pet.window && pet.window.id !== id0, '确实重建了一个新窗口', String(id0));
  const d1 = pet.diag();
  eq(d1.exists, true, '重建后窗口存在');
  eq(d1.visible, true, '重建后窗口可见');
  eq(d1.alwaysOnTop, true, '重建后依然是置顶的');
  attachSpy(pet.window);
  eq(pet.resyncTop('test'), true, '重建后还能重夺');

  // ---------------- 6. 召唤到鼠标处 ----------------
  section('6. 召唤到鼠标处');
  ok(pet.summon() !== false, 'summon 有返回');
  await sleep(900);
  const d2 = pet.diag();
  eq(d2.visible, true, '召唤之后仍然可见');
  eq(d2.onScreen, true, '落在鼠标所在那块屏的工作区里（不会被扔到屏幕外）', JSON.stringify(d2.pos));

  // ---------------- 7. 关掉 / 打开 ----------------
  section('7. 显示与隐藏');
  pet.hidePet();
  await sleep(300);
  eq(pet.isVisible(), false, 'hidePet 之后不可见');
  pet.showPet();
  await sleep(600);
  eq(pet.isVisible(), true, 'showPet 之后又回来了');
  const d3 = pet.diag();
  eq(d3.onScreen, true, '来回切换不会把它甩出屏幕');

  // ---------------- 汇总 ----------------
  console.log('\n' + '='.repeat(46));
  if (fails.length) {
    console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
    fails.forEach((f) => console.log('  ✗ ' + f));
    setTimeout(() => app.exit(1), 150);
  } else {
    console.log(`桌面宠物置顶：通过 ${pass} / ${pass}`);
    setTimeout(() => app.exit(0), 150);
  }
});

app.on('window-all-closed', (e) => e.preventDefault());
