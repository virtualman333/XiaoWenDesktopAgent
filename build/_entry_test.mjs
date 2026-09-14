/**
 * 桌面入口（宠物 ⇄ 悬浮球）回归测试 —— node build/_entry_test.mjs
 *
 * 需求原话：「小宠物开启的时候，要求是可以完全代替悬浮窗的，悬浮窗就可以隐藏掉。」
 *
 * 所以规则只有两条，必须**穷举所有组合**验证：
 *   1) 宠物开着 → 悬浮球不出现在桌面上（宠物完全代替它）
 *   2) 桌面上不能两个入口都没有（宠物关着时球一定回来）
 *
 * 顺带盯一个很容易写漂的地方：主进程是 CommonJS、渲染层是 ES Module，
 * 「谁上场」这套规则只能各写一份。这里用同一张真值表分别喂给两边，
 * 断言结果逐格一致 —— 谁改漏了一边，这个测试立刻红。
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// 主进程版（CJS）
const mainRule = require('../src/main/entry.js');
// 渲染层版（ESM）
const uiRule = await import('../src/renderer/js/entry-rule.js');

let pass = 0; const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else fails.push(name + (extra ? ` → ${extra}` : '')); };
const eq = (a, b, name) => ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
const section = (s) => console.log('\n' + s);

// 所有组合：宠物开关 × 悬浮球档位 × 唤醒开关
const PETS = [true, false];
const MODES = ['auto', true, false];
const WAKES = [true, false];
const cases = [];
for (const petEnabled of PETS) {
  for (const ballEnabled of MODES) {
    for (const wakeEnabled of WAKES) {
      cases.push({ petEnabled, ballEnabled, wakeEnabled });
    }
  }
}

// ---------------- 1. 档位归一化 ----------------
section('1. 档位归一化');
{
  eq(mainRule.entryMode({ ballEnabled: true }), true, 'true 原样');
  eq(mainRule.entryMode({ ballEnabled: false }), false, 'false 原样');
  eq(mainRule.entryMode({ ballEnabled: 'auto' }), 'auto', 'auto 原样');
  eq(mainRule.entryMode({}), 'auto', '没配过 = auto（老用户升级上来的默认行为）');
  eq(mainRule.entryMode(null), 'auto', '空配置也当 auto');
  eq(mainRule.entryMode({ ballEnabled: '随便什么' }), 'auto', '脏值兜回 auto，不会让球凭空消失');
  eq(uiRule.entryMode({ ballEnabled: true }), true, '渲染层同规则：true');
  eq(uiRule.entryMode({}), 'auto', '渲染层同规则：默认 auto');
}

// ---------------- 2. 真值表：宠物开着 → 球退场 ----------------
section('2. 「宠物代替悬浮球」的三种档位');
{
  // 默认档：宠物开着就不显示球
  eq(mainRule.ballWanted({ petEnabled: true, ballEnabled: 'auto' }), false,
    '宠物开着 + auto → 悬浮球不显示（宠物完全代替它）');
  eq(mainRule.ballWanted({ petEnabled: true, ballEnabled: false }), false,
    '宠物开着 + 「不显示」→ 悬浮球不显示');
  eq(mainRule.ballWanted({ petEnabled: true, ballEnabled: true }), true,
    '宠物开着 + 「总是显示」→ 两个都在（用户显式要求，尊重）');

  // 宠物关着 → 球一定回来
  eq(mainRule.ballWanted({ petEnabled: false, ballEnabled: 'auto' }), true,
    '宠物关着 + auto → 悬浮球回来');
  eq(mainRule.ballWanted({ petEnabled: false, ballEnabled: true }), true,
    '宠物关着 + 「总是显示」→ 悬浮球在');
}

// ---------------- 3. 底线：桌面上永远有入口 ----------------
section('3. 不允许「两个入口都消失」');
{
  for (const ballEnabled of MODES) {
    const cfg = { petEnabled: false, ballEnabled };
    ok(mainRule.ballWanted(cfg) === true,
      `宠物关着时悬浮球必须顶上（ballEnabled=${JSON.stringify(ballEnabled)}）`);
  }
  // 宠物开着、又明确说不要球 → 入口是宠物，这是允许的（用户要的就是这个）
  eq(mainRule.ballWanted({ petEnabled: true, ballEnabled: false }), false,
    '宠物开着 + 不要球 → 入口由宠物承担，不算「没有入口」');
}

// ---------------- 4. 谁是唤醒宿主 ----------------
section('4. 语音唤醒归谁托管');
{
  eq(mainRule.entryHost({ petEnabled: true, ballEnabled: 'auto' }, false), 'pet',
    '球不在场 → 宠物托管唤醒');
  eq(mainRule.entryHost({ petEnabled: true, ballEnabled: 'auto' }, true), 'ball',
    '球在场 → 还是球托管（它一直干这事，最稳）');
  eq(mainRule.entryHost({ petEnabled: true, ballEnabled: true }, true), 'ball',
    '两个都在 → 唤醒归球，宠物不抢麦克风');

  // 渲染层视角：宠物自己算「要不要接管」
  eq(uiRule.shouldHostWake({ petEnabled: true, ballEnabled: 'auto', wakeEnabled: true }), true,
    '宠物开着、球退场、唤醒开着 → 宠物接管');
  eq(uiRule.shouldHostWake({ petEnabled: true, ballEnabled: true, wakeEnabled: true }), false,
    '球也在场 → 宠物让出麦克风（两个一起抢会互相顶掉识别会话）');
  eq(uiRule.shouldHostWake({ petEnabled: true, ballEnabled: 'auto', wakeEnabled: false }), false,
    '用户没开唤醒 → 谁都不听');
  eq(uiRule.shouldHostWake({ petEnabled: false, ballEnabled: 'auto', wakeEnabled: true }), false,
    '宠物不在场 → 不接管');
  eq(uiRule.shouldHostWake(null), false, '空配置安全地返回 false（宁可少听，不可乱开麦）');

  // 两边必须在每一格上都一致：宠物接管 ⟺ 主进程认为宿主是宠物
  for (const c of cases) {
    const mainHostIsPet = mainRule.entryHost(c, mainRule.ballWanted(c)) === 'pet';
    const uiShouldHost = uiRule.shouldHostWake(c);
    eq(uiShouldHost, mainHostIsPet && c.wakeEnabled === true,
      `两边判定一致（宠物=${c.petEnabled} 球=${JSON.stringify(c.ballEnabled)} 唤醒=${c.wakeEnabled}）`);
  }
}

// ---------------- 5. 逐格比对两份规则 ----------------
section('5. 主进程规则 ⇄ 渲染层规则 逐格一致');
{
  let diff = 0;
  for (const c of cases) {
    const a = mainRule.ballWanted(c);
    const b = uiRule.ballWanted(c);
    if (a !== b) { diff++; fails.push(`ballWanted 不一致（宠物=${c.petEnabled} 球=${JSON.stringify(c.ballEnabled)}）：主 ${a} / 渲染 ${b}`); }
    const am = mainRule.entryMode(c);
    const bm = uiRule.entryMode(c);
    if (am !== bm) { diff++; fails.push(`entryMode 不一致：主 ${am} / 渲染 ${bm}`); }
  }
  ok(diff === 0, `${cases.length} 种组合两边结果完全一致`, `有 ${diff} 处不一致`);
}

// ---------------- 6. 状态概要 ----------------
section('6. entryStatus 概要');
{
  const st1 = mainRule.entryStatus({ petEnabled: true, ballEnabled: 'auto' }, false);
  eq(st1.host, 'pet', '宠物在场、球不在 → 宿主是宠物');
  eq(st1.ballShown, false, '球不在场');
  eq(st1.ballWanted, false, '期望值也是不显示');
  eq(st1.inSync, true, '实际与期望一致');
  eq(st1.petOn, true, '宠物开着');
  eq(st1.mode, 'auto', '档位 auto');

  const st2 = mainRule.entryStatus({ petEnabled: false, ballEnabled: 'auto' }, true);
  eq(st2.host, 'ball', '宠物关着 → 宿主是球');
  eq(st2.ballShown, true, '球在场');
  eq(st2.inSync, true, '一致');

  // 窗口还没跟上配置时，inSync 必须是 false（同步中 / 出问题了，能看出来）
  const st3 = mainRule.entryStatus({ petEnabled: true, ballEnabled: 'auto' }, true);
  eq(st3.inSync, false, '球还赖着不走 → 标记为不同步（同步中或出问题了）');

  ok(/桌面宠物/.test(mainRule.describeEntry({ petEnabled: true, ballEnabled: 'auto' }, false)),
    '一句话描述里说的是宠物在当入口');
  ok(/悬浮球/.test(mainRule.describeEntry({ petEnabled: false, ballEnabled: 'auto' }, true)),
    '宠物关了 → 描述里说的是悬浮球顶班');
}

// ---------------- 7. 兼容老配置 ----------------
section('7. 老配置（没有 ballEnabled 字段）');
{
  // 从 v1.7 及以前升级上来的用户，配置里没有 ballEnabled。
  // 此时「宠物开着」是最常见状态，行为应该正好是「宠物代替球」。
  const legacy = { petEnabled: true, petAnimal: 'penguin' };
  eq(mainRule.ballWanted(legacy), false, '老配置 + 宠物开着 → 球自动让位（升级即生效）');
  eq(mainRule.entryMode(legacy), 'auto', '档位视为 auto');

  const legacyPetOff = { petEnabled: false };
  eq(mainRule.ballWanted(legacyPetOff), true, '老配置 + 宠物关着 → 球照旧在');
}

// ---------------- 汇总 ----------------
console.log('\n' + '='.repeat(46));
if (fails.length) {
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`桌面入口分工：通过 ${pass} / ${pass}`);
