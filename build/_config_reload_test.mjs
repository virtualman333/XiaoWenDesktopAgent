/**
 * 配置热更新判据测试 —— node build/_config_reload_test.mjs
 *
 * 被测对象是 `src/main/config-reload.js`（纯函数，不碰 electron）。
 * 这里钉住的是那条**用户能看到的**毛病：
 *
 *   主人点「框选截图」旁边的清空 → 渲染层 setConfig({ captureRegionHotkey: '' })
 *   → 旧代码用 `patch.captureRegionHotkey && ...` 判「改没改」，空串为假
 *   → 热更新整段跳过：配置里已经空了、输入框也空了、还提示「已清空」，
 *     可系统里那把旧键还挂着，按下去照样截图 —— 一直到重启才回落默认键。
 *
 * 所以第 1 节直接盯住「空串必须算改动」，第 3 节再跨文件核对表里的字段名
 * 是不是真的存在于 DEFAULT_CONFIG —— 写错一个字母（hotKey / captureHotKey）
 * 整条重载就会永久静默失效，而这种错没有任何东西会当场报出来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const { changed, planReloads, tableFields, hotkeyFields, RULES } = require('../src/main/config-reload.js');

let pass = 0; const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else fails.push(name + (extra ? ` → ${extra}` : '')); };
const eq = (a, b, name) => ok(
  JSON.stringify(a) === JSON.stringify(b), name,
  `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`
);
const section = (s) => console.log('\n' + s);

// ---------------- 1. 清空一个值，必须算「改了」 ----------------
section('1. 清空 = 改成空，不是「没改」');
{
  // 这四个字段用户都能清空，而它们的值一旦是空串，真值判断就会漏掉它们
  const HOTKEYS = ['hotkey', 'petSummonHotkey', 'captureRegionHotkey', 'captureFullHotkey'];
  for (const k of HOTKEYS) {
    const cur = { [k]: 'Alt+Shift+A' };
    ok(changed({ [k]: '' }, cur, k), `${k}：清成空串算改动`);
    ok(planReloads({ [k]: '' }, cur).length > 0, `${k}：清空之后有重载动作要跑`, JSON.stringify(planReloads({ [k]: '' }, cur)));
  }
  // 回到最初那个具体场景
  eq(planReloads({ captureRegionHotkey: '' }, { captureRegionHotkey: 'Alt+Shift+A' }),
    ['capture'], '清空框选快捷键 → 必须去重注册截图快捷键');
  eq(planReloads({ captureFullHotkey: '' }, { captureFullHotkey: 'Alt+Shift+S' }),
    ['capture'], '清空整屏快捷键 → 必须去重注册截图快捷键');

  // 不止空串：false / 0 同样是合法的「改成空」
  eq(planReloads({ captureEnabled: false }, { captureEnabled: true }),
    ['capture'], '关掉截图开关 → 要去重注册（一个键都不留）');
  eq(planReloads({ ballOpacity: 0 }, { ballOpacity: 0.9 }),
    ['ball-opacity'], '透明度改成 0 → 要重设（0 也是合法值）');
  eq(planReloads({ petOpacity: 0 }, { petOpacity: 0.9 }),
    ['pet-opacity'], '宠物透明度改成 0 → 要重设');
}

// ---------------- 2. 「没改」不要白跑一遍 ----------------
section('2. 没改就别重载');
{
  const cur = { hotkey: 'Alt+Space', captureRegionHotkey: 'Alt+Shift+A', ballOpacity: 0.9 };
  eq(planReloads({}, cur), [], '空 patch → 什么都不用重载');
  eq(planReloads({ hotkey: 'Alt+Space' }, cur), [], '同值 → 不重载');
  eq(planReloads({ captureRegionHotkey: 'Alt+Shift+A' }, cur), [], '同一个键位再存一次 → 不重载');
  eq(planReloads({ ballOpacity: 0.9 }, cur), [], '透明度同值 → 不重载');

  // 只认自己带的键：原型链上挂着的不算「显式改了」。
  // 注意这里的原型值**故意和 cur 不一样** —— 要是写成一样，`key in p` 那种写法
  // 也会因为「值没变」而返回 false，这条断言就永远绿、什么都锁不住。
  const inherited = Object.create({ hotkey: 'Ctrl+Alt+Z' });
  inherited.other = 1;
  eq(changed(inherited, cur, 'hotkey'), false, '继承来的键不算 patch 显式指定');
  eq(planReloads(inherited, cur), [], '继承来的值不会触发重载');

  // 其它字段变了，但重载表里没有 → 不该被顺带触发
  eq(planReloads({ model: 'deepseek-reasoner' }, cur), [], '不在表里的字段不会触发任何重载');
}

// ---------------- 3. 跨文件核对：表里的字段名必须真的存在 ----------------
section('3. 表里的字段名与 DEFAULT_CONFIG 对齐');
{
  const src = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf-8');
  const start = src.indexOf('const DEFAULT_CONFIG = {');
  ok(start > 0, '能在 main.js 里找到 DEFAULT_CONFIG');
  const lines = src.slice(start).split('\n');
  const configKeys = [];
  for (let n = 1; n < lines.length; n++) {
    if (/^};/.test(lines[n])) break;
    const m = /^ {2}(\w+):/.exec(lines[n]);
    if (m) configKeys.push(m[1]);
  }
  ok(configKeys.length > 50, 'DEFAULT_CONFIG 解析出足够的键', `只解析到 ${configKeys.length} 个`);

  // (a) 表里的每个字段都必须是真实存在的配置项 —— 写错一个字母就整条静默失效
  const missing = tableFields().filter((f) => !configKeys.includes(f));
  eq(missing, [], '重载表里的字段在 DEFAULT_CONFIG 里都有（拼错就会永久静默失效）');

  // (b) 反方向：凡是快捷键类配置项，都必须进重载表 —— 新增一个快捷键配置
  //     却忘了加重载，就会复现本轮修掉的那个毛病
  const hotkeyKeys = configKeys.filter((k) => /^(hotkey|[a-z][\w]*Hotkey)$/.test(k));
  ok(hotkeyKeys.length >= 4, 'DEFAULT_CONFIG 里的快捷键类配置项被认出来了', hotkeyKeys.join(', '));
  eq(hotkeyKeys.filter((k) => !tableFields().includes(k)), [], '每个快捷键类配置项都在重载表里');
  eq(hotkeyFields().slice().sort(), hotkeyKeys.slice().sort(), '两张名单互为镜像');

  // (c) 前缀规则不能是死的：meeting 前缀下必须真有配置项
  for (const rule of RULES.filter((r) => r.prefix)) {
    const hit = configKeys.filter((k) => k.startsWith(rule.prefix));
    ok(hit.length > 0, `前缀规则「${rule.prefix}」下有真实的配置项`, '一个都没有，规则是死的');
  }
}

// ---------------- 4. 去重与顺序 ----------------
section('4. 去重与顺序');
{
  eq(planReloads({ captureRegionHotkey: 'Ctrl+1', captureFullHotkey: 'Ctrl+2', captureEnabled: false },
    { captureRegionHotkey: '', captureFullHotkey: '', captureEnabled: true }),
    ['capture'], '三个截图字段一起改 → capture 只跑一次');

  // 宠物窗口要先落定，入口分工才敢算宿主
  const both = planReloads({ petEnabled: false, ballEnabled: false }, { petEnabled: true, ballEnabled: true });
  eq(both, ['pet', 'entry'], '宠物重载排在入口分工前面');
  ok(both.indexOf('pet') < both.indexOf('entry'), 'pet 必须先于 entry');

  eq(planReloads({ meetingEnabled: false, meetingPollSec: 9 }, {}),
    ['meeting'], 'meeting 前缀一族合并成一个动作');

  // 顺序必须和表一致（表里有位置，才谈得上「顺序不能随意调」）
  const order = RULES.map((r) => r.action);
  const uniq = order.filter((a, i) => order.indexOf(a) === i);
  eq(planReloads({ hotkey: 'a', ballEnabled: false, petEnabled: false, meetingPollSec: 1 },
    { hotkey: 'b', ballEnabled: true, petEnabled: true, meetingPollSec: 3 }),
    ['hotkeys', 'meeting', 'pet', 'entry'], '多个动作按表里的顺序返回');
  ok(uniq.length > 0, '表里有动作定义');
}

// ---------------- 5. 判据必须真的被 config:set 用上 ----------------
// 这一节是**源码级**的锁，比前面几节弱，但必须留着：main.js 是 Electron 入口，
// 一个单测里 require 不了（一 require 就整个应用跑起来），所以没法行为断言。
// 它守的是「有人把 config:set 里的派发改回手写 if」这件事 —— 那会让前面
// 所有行为断言继续全绿，而线上的毛病原样回来（历史上就是这么写出来的）。
section('5. config:set 用的是同一份判据');
{
  const src = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf-8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const start = src.indexOf("ipcMain.handle('config:set'");
  ok(start > 0, '找得到 config:set 处理器');
  const rest = src.slice(start);
  const end = rest.indexOf('\nipcMain.handle(', 10);
  const body = strip(end > 0 ? rest.slice(0, end) : rest);

  ok(body.includes('configReload.planReloads('), 'config:set 走的是 configReload.planReloads');
  ok(!/if\s*\(\s*patch\./.test(body), 'config:set 里不再手写 `if (patch.x ...)` 判断');

  // 表里的字段不许再出现真值判断（`patch.x &&` / `!patch.x`）—— 那正是本轮的毛病
  const bad = [];
  for (const f of tableFields()) {
    const re = new RegExp('patch\\.' + f + '\\s*&&|!\\s*patch\\.' + f + '\\b');
    if (re.test(body)) bad.push(f);
  }
  eq(bad, [], '没有任何重载字段被真值判断过滤（空串 / false / 0 会被漏掉）');

  // 派发要覆盖表里的每个动作，别表里挂了、dispatch 里没接
  const actions = RULES.map((r) => r.action).filter((a, i, arr) => arr.indexOf(a) === i);
  eq(actions.filter((a) => !body.includes(`'${a}'`)), [], '表里每个动作在 config:set 里都有分支');
}

// ---------------- 汇总 ----------------
console.log('\n' + '='.repeat(46));
if (fails.length) {
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`配置热更新判据：通过 ${pass} / ${pass}`);
