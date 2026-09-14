/**
 * 截图快捷键回归测试 —— node build/_hotkey_test.mjs
 *
 * 用假的 globalShortcut 复现真实的「键位表」，验证：
 *   1) 改快捷键之后，旧键真的被释放了（这曾经是个 bug：旧键一直挂着）
 *   2) 冲突要如实回报，不能假装成功
 *   3) 关掉截图开关 → 一个键都不留
 *   4) 试键（probe）不留副作用
 */
import Module from 'node:module';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

const TMP = path.join(os.tmpdir(), 'xw-hotkey-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });

// ---------------- 桩：一个「像真的一样」的快捷键表 ----------------
const table = new Map();          // accel -> handler
const outsiders = new Set(['Ctrl+Shift+Q']);   // 假装被别的程序占了
const calls = [];                 // 记录每次 register / unregister

const globalShortcut = {
  register(accel, handler) {
    calls.push(['register', accel]);
    if (outsiders.has(accel)) return false;
    if (table.has(accel)) return false;   // 重复注册会被 Electron 拒绝
    table.set(accel, handler);
    return true;
  },
  unregister(accel) {
    calls.push(['unregister', accel]);
    table.delete(accel);
  },
  isRegistered(accel) { return table.has(accel); },
  unregisterAll() { table.clear(); }
};

const fakeElectron = {
  app: { getPath: () => TMP, getVersion: () => '1.7.0', isPackaged: false, getAppPath: () => TMP },
  ipcMain: { handle: () => {}, on: () => {}, once: () => {}, removeAllListeners: () => {} },
  desktopCapturer: { getSources: async () => [] },
  screen: {
    getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
    getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }],
    getCursorScreenPoint: () => ({ x: 0, y: 0 })
  },
  BrowserWindow: function () { return { isDestroyed: () => true, loadFile: () => {}, on: () => {} }; },
  clipboard: { writeImage: () => {}, readText: () => '' },
  nativeImage: { createFromPath: () => ({ getSize: () => ({ width: 0, height: 0 }) }), createFromBuffer: () => ({ toDataURL: () => '' }) },
  globalShortcut,
  shell: { openPath: () => true, showItemInFolder: () => {} }
};
fakeElectron.BrowserWindow.getAllWindows = () => [];

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, arguments);
};

const capture = require('../src/main/capture.js');

let pass = 0; const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else fails.push(name + (extra ? ` → ${extra}` : '')); };
const eq = (a, b, name) => ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
const section = (s) => console.log('\n' + s);
const live = () => [...table.keys()].sort().join(',');

let cfg = { captureEnabled: true, captureRegionHotkey: 'Alt+Shift+A', captureFullHotkey: 'Alt+Shift+S' };
capture.bindConfig(() => cfg);

// ---------------- 1. 默认注册 ----------------
section('1. 默认键位');
{
  const st = capture.registerShortcuts();
  eq(st.enabled, true, '截图功能默认开着');
  eq(st.items.length, 2, '注册了两个快捷键');
  ok(st.items.every((i) => i.ok), '两个都注册成功');
  eq(live(), 'Alt+Shift+A,Alt+Shift+S', '系统里确实挂着这两个键');
  eq(st.items[0].label, '框选截图', '第一个是框选');
  eq(st.items[1].label, '整屏截图', '第二个是整屏');

  const hs = capture.hotkeyStatus();
  eq(hs.items.length, 2, 'hotkeyStatus 能读到上次结果');
  eq(hs.at > 0, true, '带了时间戳');
  // 返回值不能被外部改坏内部状态
  hs.items[0].ok = false;
  eq(capture.hotkeyStatus().items[0].ok, true, '外部改动不会污染内部状态');
}

// ---------------- 2. 改键：旧键必须释放（回归点） ----------------
section('2. 改快捷键');
{
  calls.length = 0;
  cfg = { ...cfg, captureRegionHotkey: 'Ctrl+Alt+X' };
  const st = capture.registerShortcuts();
  eq(live(), 'Alt+Shift+S,Ctrl+Alt+X', '旧键 Alt+Shift+A 被撤掉，新键 Ctrl+Alt+X 生效', live());
  ok(!table.has('Alt+Shift+A'), 'Alt+Shift+A 真的不在系统里了');
  ok(st.items[0].ok && st.items[0].accel === 'Ctrl+Alt+X', '回报的是新键位');
  ok(calls.some(([k, a]) => k === 'unregister' && a === 'Alt+Shift+A'), '确实调了 unregister');

  // 两个键对调（经典「互相占坑」场景）
  cfg = { ...cfg, captureRegionHotkey: 'Alt+Shift+S', captureFullHotkey: 'Alt+Shift+A' };
  const st2 = capture.registerShortcuts();
  ok(st2.items.every((i) => i.ok), '对调键位也能成功（先全撤再注册）', JSON.stringify(st2.items.map((i) => i.error)));
  eq(live(), 'Alt+Shift+A,Alt+Shift+S', '对调后两个键都在', live());
  const regionHandler = table.get('Alt+Shift+S');
  const fullHandler = table.get('Alt+Shift+A');
  ok(typeof regionHandler === 'function' && typeof fullHandler === 'function', '两个键都挂上了处理函数');
  ok(regionHandler !== fullHandler, '框选和整屏挂的不是同一个函数（没串线）');
}

// ---------------- 3. 冲突要如实回报 ----------------
section('3. 键位被别的程序占着');
{
  cfg = { captureEnabled: true, captureRegionHotkey: 'Ctrl+Shift+Q', captureFullHotkey: 'Alt+Shift+S' };
  const st = capture.registerShortcuts();
  eq(st.items[0].ok, false, '被占用的键如实报失败');
  ok(/占用/.test(st.items[0].error), '错误信息说清是被占用', st.items[0].error);
  ok(st.items[1].ok, '另一个键不受影响，照常注册');
  eq(live(), 'Alt+Shift+S', '失败的那个键没有留在系统里');
  eq(capture.hotkeyStatus().items[0].ok, false, 'hotkeyStatus 保持失败状态（设置页据此提示）');
}

// ---------------- 4. 关掉开关 ----------------
section('4. 关掉截图功能');
{
  cfg = { captureEnabled: false, captureRegionHotkey: 'Alt+Shift+A', captureFullHotkey: 'Alt+Shift+S' };
  const st = capture.registerShortcuts();
  eq(st.enabled, false, '状态是「未启用」');
  eq(st.items.length, 0, '没有注册任何键');
  eq(live(), '', '系统里一个键都不剩（不留幽灵快捷键）', live());
  eq(capture.hotkeyStatus().items.length, 0, 'hotkeyStatus 也是空的');
}

// ---------------- 5. 空键位 / 试键 ----------------
section('5. 空键位与试键');
{
  cfg = { captureEnabled: true, captureRegionHotkey: '', captureFullHotkey: '' };
  const st = capture.registerShortcuts();
  eq(st.items[0].accel, 'Alt+Shift+A', '空键位回落到默认框选键');
  eq(st.items[1].accel, 'Alt+Shift+S', '空键位回落到默认整屏键');
  eq(st.items.length, 2, '回落之后照常注册');

  // probe：占用 / 可用 / 自己已注册
  const p1 = capture.probeHotkey('Ctrl+Shift+Q');
  eq(p1.ok, false, '被占用的键试出来是失败的');
  ok(/占用/.test(p1.error), 'probe 的错误信息解释清楚', p1.error);

  const p2 = capture.probeHotkey('Ctrl+Alt+9');
  eq(p2.ok, true, '空闲的键试出来可用');
  eq(table.has('Ctrl+Alt+9'), false, '试完把试注册的键撤掉了（不留副作用）');
  eq(live(), 'Alt+Shift+A,Alt+Shift+S', '试键没有破坏原有键位', live());

  const p3 = capture.probeHotkey('Alt+Shift+A');
  eq(p3.ok, true, '自己已经注册的键 → 可用');
  eq(p3.self, true, '并标明「是我自己占的」');

  const p4 = capture.probeHotkey('');
  eq(p4.ok, false, '空键位直接判失败');
  const p5 = capture.probeHotkey('   ');
  eq(p5.ok, false, '空白键位也算空');
}

// ---------------- 6. 「先试后存」的覆盖层 ----------------
section('6. 先试后存');
{
  cfg = { captureEnabled: true, captureRegionHotkey: 'Alt+Shift+A', captureFullHotkey: 'Alt+Shift+S' };
  capture.registerShortcuts();
  eq(live(), 'Alt+Shift+A,Alt+Shift+S', '当前生效的是配置里的键');

  const st = capture.applyOverride({ region: 'Ctrl+Alt+R' });
  ok(st.items.some((i) => i.accel === 'Ctrl+Alt+R' && i.ok), '临时覆盖层生效，试到了新键');
  eq(live(), 'Alt+Shift+S,Ctrl+Alt+R', '系统里挂的是试用键');

  // 覆盖层是临时的：下一次按配置注册要回到原样
  const back = capture.registerShortcuts();
  ok(back.items.some((i) => i.accel === 'Alt+Shift+A'), '回到配置里的键位（覆盖层没有落盘）', JSON.stringify(back.items.map((i) => i.accel)));
  eq(live(), 'Alt+Shift+A,Alt+Shift+S', '系统里也是原键位', live());
}

// ---------------- 汇总 ----------------
console.log('\n' + '='.repeat(46));
if (fails.length) {
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`截图快捷键：通过 ${pass} / ${pass}`);
