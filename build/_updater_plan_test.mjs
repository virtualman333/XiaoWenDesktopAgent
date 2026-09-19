/**
 * 「自动更新怎么决策」回归测试 —— node build/_updater_plan_test.mjs
 *
 * 为什么现在才有
 * --------------
 * `src/main/updater.js`（290 行）第一行就 `require('electron')` —— 纯 Node **加载不了**，
 * 所以自动更新这套东西（四个开关的语义、空闲安装的判据、报错翻译、下完之后走哪条路）
 * **此前一条断言都没有**：`test:all` 串跑的每一个套件、`build/` 下的每一个文件，
 * 没有一个（也没有一行）是冲它来的 —— 全靠「读代码看着没问题」。
 *
 * 判据抽到 `src/main/updater-plan.js`（纯函数、零 electron 依赖）之后，这个文件才跑得起来 ——
 * 而第一次摊开就发现设置页给小问许的那条诺**是假的**：
 *
 *   「下载完成后弹窗提醒」= `autoUpdateNotify`，只在**非静默安装**那一支被读，
 *   而 `autoUpdateSilentInstall` 默认 **true** → **默认路径下这个开关完全不生效**。
 *   设置页里还根本没有这个勾选框，只能手改 config.json：关了没用、UI 里也没有。
 *
 * 六组：
 *   1. `afterDownloaded` —— 四象限真值表 + 两个提醒开关互斥 + 版本号进文案（期望值**手写**）
 *   2. `autoUpdaterOptions` —— 四个开关映射到 electron-updater 的选项，含一处**有意的不对称**
 *   3. `shouldIdleInstall` —— 空闲自动安装，边界值按秒算
 *   4. `installSilently` —— 显式布尔优先、否则跟设置（正控 + 反控）
 *   5. `friendlyError` —— 三类报错翻译 + 截断兜底，且三类文案互不相同
 *   6. 设置页 ⇄ DEFAULTS ⇄ 示例配置 ⇄ 接线：**三处两向对账**（本轮缺陷的形状就在这里）
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, residueErrors } from './_strip_comments.mjs';

const require = createRequire(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plan = require('../src/main/updater-plan.js');
const { DEFAULTS, IDLE_NEED_SECONDS, IDLE_POLL_MS, afterDownloaded, autoUpdaterOptions, friendlyError, installSilently, shouldIdleInstall } = plan;

let pass = 0;
const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else fails.push(name + (extra ? ` → ${extra}` : '')); };
const eq = (a, b, name) => ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
const section = (s) => console.log('\n' + s);

const readSrc = (rel) => fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8');

// ============================================================
// 1. afterDownloaded —— 四象限（期望值手写，不引用被测常量）
// ============================================================
section('1. 更新包下好了，接下来怎么走');

/** [说明, 配置, 静默安装, 轻提示, 问对话框, 开空闲巡检] */
const TABLE = [
  ['默认（两个开关都不写）', {}, true, true, false, true],
  ['关掉提醒', { autoUpdateNotify: false }, true, false, false, true],
  ['改成弹安装界面', { autoUpdateSilentInstall: false }, false, false, true, false],
  ['弹安装界面 + 关掉提醒', { autoUpdateSilentInstall: false, autoUpdateNotify: false }, false, false, false, false]
];
for (const [label, cfg, silent, light, ask, idle] of TABLE) {
  const p = afterDownloaded(cfg, '1.9.9');
  ok(p.silentInstall === silent && p.lightNotify === light && p.askDialog === ask && p.startIdleWatch === idle,
    `${label} → 静默安装 ${silent} / 轻提示 ${light} / 问对话框 ${ask} / 空闲巡检 ${idle}`,
    `实际 静默安装 ${p.silentInstall} / 轻提示 ${p.lightNotify} / 问对话框 ${p.askDialog} / 空闲巡检 ${p.startIdleWatch}`);
}

// 本轮修的那一条，单独点名（修复前它是绿的：lightNotify 无条件 true）
eq(afterDownloaded({ autoUpdateNotify: false }, '9.9.9').lightNotify, false,
  '★ 默认（静默安装）路径下关掉提醒，就必须真的不提醒 —— 这正是本轮修的缺陷');
// 反控：显式打开时不许被误伤
eq(afterDownloaded({ autoUpdateNotify: true }, '9.9.9').lightNotify, true,
  '反控：显式 autoUpdateNotify:true 时轻提示照发，修复没把开关钉死');
// 反控：关提醒 ≠ 放弃空闲自动安装
eq(afterDownloaded({ autoUpdateNotify: false }, '9.9.9').startIdleWatch, true,
  '反控：关掉「提醒我」不等于放弃「空闲时自动装好」—— 少打扰和自动升级是两件事');
// 非静默那一支本来就读它，别被顺手改坏
eq(afterDownloaded({ autoUpdateSilentInstall: false, autoUpdateNotify: true }, '9.9.9').askDialog, true,
  '非静默安装 + 开着提醒 → 照旧问一句「现在重启安装？」');

// 两个提醒开关互斥：最打断人的对话框只在非静默时出现
for (const [label, cfg] of [['默认', {}], ['关提醒', { autoUpdateNotify: false }], ['非静默', { autoUpdateSilentInstall: false }]]) {
  const p = afterDownloaded(cfg, '1.0.0');
  ok(!(p.lightNotify && p.askDialog), `${label}：轻提示与对话框互斥（不许两个都弹）`,
    `轻提示 ${p.lightNotify} / 对话框 ${p.askDialog}`);
}

// 版本号必须进文案（设置页状态行读的就是它），且不许漏出 undefined
for (const [label, v] of [['正常版本号', '1.9.9'], ['空版本号', ''], ['未传版本号', undefined], ['数字版本号', 123]]) {
  const m = afterDownloaded({}, v).message;
  ok(typeof m === 'string' && m.length > 0, `${label}：文案非空`, String(m));
  ok(!/undefined|null|NaN/.test(m), `${label}：文案里不许漏出 undefined / null / NaN`, m);
}
ok(afterDownloaded({}, '1.9.9').message.includes('1.9.9'), '文案里带着版本号（设置页状态行全靠它）', afterDownloaded({}, '1.9.9').message);
ok(afterDownloaded({}, '1.9.9').message !== afterDownloaded({ autoUpdateSilentInstall: false }, '1.9.9').message,
  '静默 / 非静默两条路的文案不同（后者要提示「重启后生效」）');
ok(!/undefined/.test(afterDownloaded({}, undefined).message), '不传版本号时文案不出现 undefined');

// 纯函数：不读全局、不共享引用、不因为传 null 崩
eq(afterDownloaded(null, '1.0.0').silentInstall, true, 'cfg 传 null 时按默认处理，不崩');
eq(afterDownloaded(undefined, '1.0.0').silentInstall, true, 'cfg 传 undefined 时按默认处理，不崩');
ok(afterDownloaded({}, '1.0.0') !== afterDownloaded({}, '1.0.0'), '每次返回新对象（调用方改它不会污染下一次）');
{
  const a = afterDownloaded({}, '1.0.0');
  a.lightNotify = false;
  eq(afterDownloaded({}, '1.0.0').lightNotify, true, '改上一次的返回值不影响下一次（没有共享对象）');
}

// ============================================================
// 2. autoUpdaterOptions
// ============================================================
section('2. 设置 → electron-updater 选项');

{
  const o = autoUpdaterOptions({});
  eq(o.autoDownload, true, '默认：有更新就后台下载');
  eq(o.allowPrerelease, false, '默认：不接收预发布版本');
  eq(o.autoInstallOnAppQuit, true, '默认：退出时自动应用已下载的更新');
  eq(o.disableDifferentialDownload, false, '差分下载保持开启（这里没有理由关掉它）');
}
eq(autoUpdaterOptions({ autoUpdateSilent: false }).autoDownload, false, '关掉「后台下载」→ autoDownload 跟着关');
eq(autoUpdaterOptions({ autoUpdatePrerelease: true }).allowPrerelease, true, '显式开启预发布 → allowPrerelease 打开');
eq(autoUpdaterOptions({ autoUpdateInstallOnQuit: false }).autoInstallOnAppQuit, false, '关掉「退出时自动应用」→ 跟着关');

// ★ 有意的不对称：其他开关都是「缺失算开」（!== false），只有预发布是「缺失算关」
// （只认显式 true）—— 默认收预发布对普通用户是实打实的事故，所以只收紧不放宽。
eq(autoUpdaterOptions({ autoUpdatePrerelease: 'yes' }).allowPrerelease, false,
  '★ autoUpdatePrerelease 只认显式 true（字符串 / 1 这类真值不算开）—— 默认收预发布是事故');
eq(autoUpdaterOptions({ autoUpdateSilent: 0 }).autoDownload, true,
  '★ 与之相对：autoUpdateSilent 传 0 仍算开（判据是 !== false，缺失/0 都算默认开）');
eq(autoUpdaterOptions({ autoUpdateSilent: null }).autoDownload, true, 'autoUpdateSilent 传 null 算开（不静默地改用户设置）');
ok(autoUpdaterOptions({}) !== autoUpdaterOptions({}), '每次返回新对象');
eq(autoUpdaterOptions(null).autoDownload, true, 'cfg 传 null 不崩');

// ============================================================
// 3. shouldIdleInstall
// ============================================================
section('3. 空闲自动安装的判据');

eq(IDLE_NEED_SECONDS, 90, '「主人不在」的门槛是 90 秒（写死字面量：引用被测常量会变成恒真）');
eq(IDLE_POLL_MS, 20000, '巡检间隔是 20 秒（同样是字面量）');

const base = { cfg: {}, state: 'downloaded', installKicked: false, idleSeconds: 90 };
eq(shouldIdleInstall(base), true, '正好空闲满 90 秒 → 装（边界含等号）');
eq(shouldIdleInstall({ ...base, idleSeconds: 89 }), false, '差一秒不够 → 不装');
eq(shouldIdleInstall({ ...base, idleSeconds: 0 }), false, '刚动过键盘 → 不装');
eq(shouldIdleInstall({ ...base, state: 'downloading' }), false, '还没下完 → 不装（半截包装上去等于自杀）');
eq(shouldIdleInstall({ ...base, state: 'error' }), false, '出错状态 → 不装');
eq(shouldIdleInstall({ ...base, state: 'idle' }), false, '空闲状态（没有待装包）→ 不装');
eq(shouldIdleInstall({ ...base, installKicked: true }), false, '已经触发过安装 → 不重复触发');
eq(shouldIdleInstall({ ...base, cfg: { autoUpdateInstallWhenIdle: false } }), false,
  '用户关掉「空闲时自动装」→ 就算空闲一小时也不装');
eq(shouldIdleInstall({ ...base, cfg: { autoUpdateInstallWhenIdle: false }, idleSeconds: 99999 }), false,
  '关掉这个开关后，空闲多久都不装（不能因为「等够久」就绕过开关）');
eq(shouldIdleInstall({ ...base, idleSeconds: 5, idleNeed: 5 }), true, '门槛可覆盖（测试 / 自定义场景用）');
eq(shouldIdleInstall({ ...base, idleSeconds: 4, idleNeed: 5 }), false, '覆盖后的边界同样含等号');
eq(shouldIdleInstall({ ...base, idleSeconds: '90' }), true, '字符串秒数被转成数字比较（powerMonitor 的返回值类型不稳定）');
eq(shouldIdleInstall({ ...base, idleSeconds: undefined }), false, '拿不到空闲秒数时（undefined）不许当成「空闲很久」');
eq(shouldIdleInstall(null), false, '传 null 不崩，且不许装');
eq(shouldIdleInstall(undefined), false, '传 undefined 不崩，且不许装');

// ============================================================
// 4. installSilently
// ============================================================
section('4. 安装方式：显式优先，否则跟设置');

eq(installSilently({}, true), true, '显式 true → 静默（即便设置里关了）');
eq(installSilently({ autoUpdateSilentInstall: false }, true), true,
  '★ 显式 true 压过设置：主进程 IPC 那条「静默安装」入口必须真的静默');
eq(installSilently({ autoUpdateSilentInstall: true }, false), false,
  '★ 反控：显式 false 压过设置硬开的静默 —— 否则「带界面安装」那个按钮点下去照样静默装');
eq(installSilently({}, undefined), true, '没显式传 → 跟设置（默认静默）');
eq(installSilently({ autoUpdateSilentInstall: false }, undefined), false, '没显式传 → 跟设置（用户关了就带界面）');
eq(installSilently({ autoUpdateSilentInstall: false }, null), false, 'null 不算显式布尔 → 跟设置');
eq(installSilently(null, undefined), true, 'cfg 传 null 不崩，按默认');
// 这条是「显式布尔」而不是「真值」：0 / '' 这类不该被当成显式
eq(installSilently({ autoUpdateSilentInstall: true }, 0), true, "0 不是布尔 → 走设置（不许拿 truthiness 当判据）");

// ============================================================
// 5. friendlyError
// ============================================================
section('5. 英文报错翻译成人话');

const e404 = friendlyError(new Error('ENOENT: no such file or directory, open app-update.yml'));
ok(e404.includes('发布源'), '缺 latest.yml / 404 → 指向「发布源里还没有更新包」', e404);
ok(friendlyError(new Error('HttpError: 404 Not Found')).includes('发布源'), '404 走同一支');
const eNet = friendlyError(new Error('net::ERR_INTERNET_DISCONNECTED'));
ok(eNet.includes('网络') || eNet.includes('连不上'), 'net:: 开头 → 网络类', eNet);
ok(friendlyError(new Error('ETIMEDOUT')).includes('网络') || friendlyError(new Error('ETIMEDOUT')).includes('连不上'), 'ETIMEDOUT 走同一支');
ok(friendlyError(new Error('ECONNREFUSED')).includes('网络') || friendlyError(new Error('ECONNREFUSED')).includes('连不上'), 'ECONNREFUSED 走同一支');
ok(friendlyError(new Error('code signature verification failed')).includes('签名'), '签名失败 → 签名类');

// 三类文案必须互不相同，否则「翻译」等于没翻
const three = new Set([e404, eNet, friendlyError(new Error('code signature verification failed'))]);
eq(three.size, 3, '三类报错的文案互不相同（都翻成同一句就等于没翻）');

// 兜底：认不出的原样带出来，但要截断（别把一整页堆栈刷进设置页）
const long = friendlyError(new Error('X'.repeat(500)));
eq(long.length, 300, '认不出的长报错截断到 300 字符');
eq(friendlyError(new Error('认不出的短报错')).length, '认不出的短报错'.length, '认不出的短报错原样返回');
// 入口必须容错：null / undefined / 字符串 / 没有 message 的对象
eq(friendlyError(null), '未知错误', 'null → 「未知错误」，不抛异常');
eq(friendlyError(undefined), '未知错误', 'undefined → 「未知错误」，不抛异常');
eq(friendlyError(''), '未知错误', '空串 → 「未知错误」');
eq(friendlyError({ code: 'E1' }), '未知错误', '没有 message 的对象 → 「未知错误」');
// 通用规则：兜底输入一律给一句人话，绝不许把 [object Object] 这类字面量漏到设置页上
for (const weird of [null, undefined, '', 0, false, {}, { code: 'E1' }, [], new Date(0)]) {
  const m = friendlyError(weird);
  ok(typeof m === 'string' && m.length > 0 && !/\[object /.test(m),
    `兜底输入 ${JSON.stringify(weird)} → 一句人话，且不许漏出 [object Object]`, m);
}
ok(typeof friendlyError('ENOENT app-update.yml') === 'string' && friendlyError('ENOENT app-update.yml').includes('发布源'),
  '直接传字符串（不是 Error）也能翻译');

// ============================================================
// 6. 两向对账：DEFAULTS ⇄ 设置页 ⇄ 示例配置 ⇄ 接线
// ============================================================
section('6. 默认值必须「一处写、四处对得上」');

const defaultKeys = Object.keys(DEFAULTS);
ok(defaultKeys.length >= 7, `DEFAULTS 现算出 ${defaultKeys.length} 个键`, '算不出来说明结构变了，下面的对账会变成在空集上通过');
for (const [k, v] of Object.entries(DEFAULTS)) {
  eq(typeof v, 'boolean', `DEFAULTS.${k} 是布尔（判据写的是 !== false，非布尔会静默走错分支）`);
  ok(/^autoUpdate/.test(k), `DEFAULTS.${k} 命名前缀一致（设置页的 up* 勾选框按前缀对账）`);
}
eq(defaultKeys.filter((k) => DEFAULTS[k] === false).join(','), 'autoUpdatePrerelease',
  '唯一默认为关的是「接收预发布版本」（其余默认开 —— 手写字面量，不引用被测常量）');

// ---- 解析三个来源 ----
const html = readSrc('src/renderer/panel.html');
const uiIds = [];
for (const m of html.matchAll(/<input\b[^>]*>/g)) {
  const tag = m[0];
  if (!/type="checkbox"/.test(tag)) continue;
  const id = (/id="([^"]+)"/.exec(tag) || [])[1];
  if (id && id.startsWith('up')) uiIds.push(id);
}

const panelJs = stripComments(readSrc('src/renderer/js/panel.js'));
const toggleBlock = (() => {
  const i = panelJs.indexOf('function bindCapture()');
  const j = panelJs.indexOf('const toggles = {', i);
  const k = panelJs.indexOf('};', j);
  if (i === -1 || j === -1 || k === -1) return '';
  return panelJs.slice(j, k);
})();
const toggles = new Map();
for (const m of toggleBlock.matchAll(/(\w+)\s*:\s*'([^']+)'/g)) toggles.set(m[1], m[2]);

const example = JSON.parse(readSrc('config.example.json'));
const exampleKeys = Object.keys(example).filter((k) => /^autoUpdate/.test(k));

const fillBlock = (() => {
  const i = panelJs.indexOf('function fillCapture()');
  const k = panelJs.indexOf('\n}', i);
  return i === -1 ? '' : panelJs.slice(i, k);
})();
const filledKeys = [...new Set([...fillBlock.matchAll(/setChk\(\s*'[^']+'\s*,\s*cfg\.(\w+)/g)].map((m) => m[1]))];

// 解析面自证：三处都真的解出东西了，否则下面每条都在空集上通过
ok(uiIds.length > 0, `从设置页解析出 ${uiIds.length} 个自动更新勾选框`, '解析面为空 —— HTML 结构变了就得跟着改这个解析');
ok(toggles.size > 0, `从 panel.js 的 toggles 表解析出 ${toggles.size} 条绑定`, '解析面为空：绑定表的写法变了');
ok(exampleKeys.length > 0, `从 config.example.json 解析出 ${exampleKeys.length} 个自动更新键`, '解析面为空');
ok(filledKeys.length > 0, `从 fillCapture() 解析出 ${filledKeys.length} 个回填的键`, '解析面为空');

// ★ 对账器自证：喂合成样本，两个方向都必须报得出来（否则对账本身是假锁）
const reconcile = (keys, bound) => ({
  noUi: keys.filter((k) => !bound.includes(k)),
  dead: bound.filter((k) => !keys.includes(k))
});
eq(reconcile(['autoUpdateX'], []).noUi.length, 1, '对账器自证：没有开关的键必须被算出来（noUi）');
eq(reconcile(['autoUpdateX'], ['autoUpdateY']).dead.length, 1, '对账器自证：绑了不存在的键必须被算出来（dead）');
eq(reconcile(['autoUpdateX'], ['autoUpdateY']).noUi.length, 1, '对账器自证：两个方向同时报，不会互相遮蔽');

// 界面上的勾选框与 JS 的绑定表合起来才是一条完整链路：
//   面板勾选框(id) → toggles 表 → 配置键 → DEFAULTS
// ★ 只比「JS 绑定的键」是不够的（负向验证 N10 当场证明：把 HTML 里那个勾选框删掉，
//   只看绑定表的断言照样绿）—— 得从**设置页上真有的元素**出发往上走一遍。
const bindKeys = [...toggles.values()].filter((k) => /^autoUpdate/.test(k));
const uiKeys = uiIds.map((id) => toggles.get(id)).filter((k) => k && /^autoUpdate/.test(k));
// ① 每个默认键在**设置页上**都得有个勾选框 —— ★ 本轮缺陷正是踩在这里
const r1 = reconcile(defaultKeys, uiKeys);
ok(r1.noUi.length === 0, '★ DEFAULTS 的每个键在设置页里都有勾选框（否则用户只能手改 config.json）', r1.noUi.join('，'));
ok(uiKeys.length > 0, `从设置页的勾选框走到了 ${uiKeys.length} 个配置键`, '一个都没走到说明这半边链路断了，① 会在空集上通过');
// ② 每个 up* 勾选框都必须绑到某个键 —— 死开关（改了没反应）比没有更坏
const uiToggles = uiIds.filter((id) => !toggles.has(id));
ok(uiToggles.length === 0, '设置页里每个 up* 勾选框都绑到了一个配置键（不许有改了没反应的死开关）', uiToggles.join('，'));
// ③ 反向：绑定的键必须在 DEFAULTS 里
const r2 = reconcile(defaultKeys, bindKeys);
ok(r2.dead.length === 0, 'toggles 表里绑的 key 都在 DEFAULTS 里（绑了不存在的键 = 写进 config 也没人读）', r2.dead.join('，'));
// ④ 反向的另一半：JS 里的绑定不许指向页面上不存在的元素
const orphanToggles = [...toggles.keys()].filter((id) => /^up/.test(id) && !uiIds.includes(id));
ok(orphanToggles.length === 0, 'toggles 表里绑的每个 up* 元素都在设置页上存在（否则 $() 拿到 null 被静默跳过）', orphanToggles.join('，'));
eq(new Set(uiKeys).size, defaultKeys.length, '设置页上的自动更新勾选框个数与默认键个数一致（7 ↔ 7）');
// ④ 示例配置里的键集合必须与 DEFAULTS 相等（本轮补上了漏掉的两个）
{
  const missing = defaultKeys.filter((k) => !exampleKeys.includes(k));
  const extra = exampleKeys.filter((k) => !defaultKeys.includes(k));
  ok(missing.length === 0, 'config.example.json 没漏掉任何默认键（照着示例抄的用户得知道有这些设置）', missing.join('，'));
  ok(extra.length === 0, 'config.example.json 里没有多余/已改名的自动更新键', extra.join('，'));
}
// ⑤ 每个键都得被回填（只写不读 → 重开面板显示的是假状态）
{
  const notFilled = defaultKeys.filter((k) => !filledKeys.includes(k));
  ok(notFilled.length === 0, '每个默认键都在 fillCapture() 里回填（否则开关永远显示「关」）', notFilled.join('，'));
}

// ---- 接线锁：updater.js ----
section('7. 接线锁（updater.js / main.js）');

const upd = stripComments(readSrc('src/main/updater.js'));
ok(/require\(\s*['"]\.\/updater-plan['"]\s*\)/.test(upd), 'updater.js 引入了唯一判据模块');
for (const fn of ['afterDownloaded', 'autoUpdaterOptions', 'shouldIdleInstall', 'installSilently']) {
  ok(new RegExp(`${fn}\\s*\\(`).test(upd), `updater.js 真的调用了 ${fn}()`);
}
ok(!/function\s+friendlyError/.test(upd), 'updater.js 里不许再有第二份 friendlyError（判据只此一份）');
ok(!/autoUpdateNotify/.test(upd), '★ 接线层不许自己读 autoUpdateNotify —— 提醒与否一律由 afterDownloaded 决定');
ok(!/autoUpdateSilentInstall/.test(upd), '接线层不许自己读 autoUpdateSilentInstall（走 installSilently / afterDownloaded）');
// 旧形态：静默那一支无条件 notify，autoUpdateNotify 只在 else 里 —— 修掉的正是它
ok(!/if\s*\(\s*silentInstall\s*\)[\s\S]{0,80}?notify\s*\(/.test(upd),
  '旧的「静默安装就无条件提示」写法不得复活（它让提醒开关在默认路径下失效）');
ok(/plan\.lightNotify/.test(upd), '轻提示由 plan.lightNotify 决定');
ok(/plan\.askDialog/.test(upd), '对话框由 plan.askDialog 决定');
ok(/plan\.startIdleWatch/.test(upd), '空闲巡检由 plan.startIdleWatch 决定');
eq((upd.match(/IDLE_POLL_MS/g) || []).length > 0, true, '巡检间隔取自判据模块，不是写死的数字');
ok(!/setInterval\([\s\S]{0,120}?90\b/.test(upd), '空闲门槛没有第二份写死的 90');

const main = stripComments(readSrc('src/main/main.js'));
ok(/require\(\s*['"]\.\/updater-plan['"]\s*\)/.test(main), 'main.js 引入了判据模块');
ok(/\.\.\.\s*updaterPlan\.DEFAULTS/.test(main), 'DEFAULT_CONFIG 从 updaterPlan.DEFAULTS 展开（默认值只此一份）');
ok(!/autoUpdateSilentInstall\s*:/.test(main), 'main.js 里不许再手抄 autoUpdate 默认值（展开之后就别留着旧表）');
ok(!/autoUpdateNotify\s*:/.test(main), 'main.js 里不许再手抄 autoUpdateNotify 默认值');

/* 剥注释器总闸（第 25 轮补）：它扛着本文件**所有**读源码的判定，而它此前在 panel.js 上
   几乎什么都没做（42 条唯一块注释留着 33 条，体量只减 1.5%，却照样返回字符串、不抛错）
   —— 上面那些 lock 是对着「带注释的源码」做的判定，注释里的旧代码随时能把它们判红或
   判绿。剥不干净必须当场喊出来，而不是让结论悄悄变弱。 */
for (const rel of ['src/renderer/js/panel.js', 'src/main/updater.js', 'src/main/main.js']) {
  const src = readSrc(rel);
  const res = residueErrors(src, stripComments(src));
  ok(res.length === 0, `剥注释器在 ${rel} 上没有残留`, res[0]);
}

// ---------------- 汇总 ----------------
console.log('\n' + '='.repeat(46));
const total = pass + fails.length + 1; // +1 = 下面这条自己
// 断言条数下限：解析面失灵或整块被删掉时，别让它「零断言全绿」
ok(total >= 110, `断言条数下限（${total} ≥ 110）`, '条数骤降说明有整组断言没跑起来');
if (fails.length) {
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`自动更新的决策判据：通过 ${pass} / ${pass}`);
