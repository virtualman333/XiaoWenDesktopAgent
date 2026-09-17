/**
 * 会话（多轮短期记忆）回归测试 —— node build/_session_test.mjs
 *
 * 为什么需要它
 * ------------
 * `sessions.json` 一直是**零测试**的一块：建会话、自动命名、改名、删会话、切活动会话，
 * 全都没有任何东西守着。而这里恰好有一条从建立起就悬着的能力：
 * `sessionRename` 在 preload 上有、主进程也实现了，**渲染层一次都没调用过** ——
 * 用户想给一段对话起个自己认得出来的名字，只能删掉重建（会话名只能停在
 * 「新对话」或首条消息前 24 字）。
 *
 * 本轮把入口接上，同时把这条链路的行为钉住：
 *
 *   1. 走的是真 IPC（`ipcMain.handle('session:rename')` 被拦下来存进 map，再真调用它），
 *      不是读源码猜形状；
 *   2. 空标题 / 纯空白标题**不生效**（抽屉里会多出一块无名条目），且不写盘；
 *   3. 超长标题按 `store.SESSION_TITLE_MAX` 截断 —— 上限只在 store 里定义一次，
 *      界面侧不设 maxLength，避免两处各写一个数字后漂移；
 *   4. 重命名**不动 updatedAt**：它不是「这个会话有了新动静」，把条目顶到列表最前
 *      会打乱用户刚整理过的顺序；
 *   5. 界面落点：抽屉的渲染函数里真有 `window.xw.sessionRename(` 调用点
 *      （只断言「文件里出现过这个名字」是假锁 —— 注释里写一句就能满足）。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else fails.push(name + (extra ? ` → ${extra}` : '')); };
const eq = (a, b, name) => ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
const section = (s) => console.log('\n' + s);

// ---------------- electron stub（够 store.js + jarvis/index.js 加载与注册） ----------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xw-sess-'));
const handlers = new Map();
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return {
      app: { getPath: () => tmp, on: () => {}, whenReady: () => Promise.resolve(), isPackaged: false, getVersion: () => '0.0.0' },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {}, removeHandler: () => {} },
      shell: { openExternal: () => {}, showItemInFolder: () => {} },
      BrowserWindow: { getAllWindows: () => [] },
      nativeImage: {}, Notification: function () {},
      screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
      Tray: function () {}, Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} }
    };
  }
  return origLoad.call(this, request, ...rest);
};

const store = require(path.join(ROOT, 'src/main/jarvis/store.js'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

section('[1] 主进程：建会话 / 自动命名 / 改名 / 删会话');
try {
  const jarvis = require(path.join(ROOT, 'src/main/jarvis/index.js'));
  // 注册不是 import 的副作用，得显式调一次 —— 否则 handlers 是空的，
  // 后面每个断言都只能拿到 undefined（在空集上假绿）。
  jarvis.registerAll();
  ok(handlers.has('session:rename'), 'session:rename 没有注册成 IPC handler');
} catch (e) {
  ok(false, 'jarvis/index.js 加载失败', e.message);
}

const sessionsFile = path.join(tmp, 'jarvis', 'sessions.json');
const readSessions = () => JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
const renameIpc = (id, title) => handlers.get('session:rename')(null, { id, title });

const s1 = store.createSession();
eq(s1.title, '新对话', '新建会话的默认标题');
store.appendMessage(s1.id, { role: 'user', content: '帮我把这个月的账单按类别汇总一下' });
eq(
  store.getSession(s1.id).title,
  '帮我把这个月的账单按类别汇总一下'.slice(0, 24),
  '首条用户消息没有变成自动标题（或长度规则变了）'
);

const clean = await renameIpc(s1.id, '  账单   汇总  ');
eq(clean.title, '账单 汇总', '重命名没做空白清洗（首尾空白 + 连续空白压成一个空格）');
eq(store.getSession(s1.id).title, '账单 汇总', '重命名没有落盘');

const before = store.getSession(s1.id).updatedAt;
await renameIpc(s1.id, '改个名不应该把它顶到列表最前');
eq(store.getSession(s1.id).updatedAt, before, '★ 重命名改动了 updatedAt —— 刚整理好的列表顺序会被打乱');

const s2 = store.createSession('第二个');
const snapshot = JSON.stringify(readSessions());
for (const blank of ['', '   ', '\n\t ', null, undefined]) {
  await renameIpc(s2.id, blank);
  eq(store.getSession(s2.id).title, '第二个', `空白标题 ${JSON.stringify(blank)} 生效了（抽屉里会变成无名条目）`);
}
eq(JSON.stringify(readSessions()), snapshot, '空标题的调用改动了磁盘内容（一次无效果的调用不该写盘）');

const longTitle = '标'.repeat(store.SESSION_TITLE_MAX + 25);
const long = await renameIpc(s2.id, longTitle);
eq(long.title.length, store.SESSION_TITLE_MAX, '超长标题没有按 SESSION_TITLE_MAX 截断');
ok(store.SESSION_TITLE_MAX > 0, 'SESSION_TITLE_MAX 没有导出（界面与测试都拿不到这个上限）');

section('[2] 标题上限：数字只有一份，但要真的送到界面手里');
// 第 15 轮之前界面干脆不设上限，全交给主进程截断 —— 代价是超长标题在回车那一瞬间
// **突然变短**。修法不是「界面再写一个 60」，而是把 store 里那个数字透传出去。
// 所以这里既验「送的是那个数」，也验「界面拿它设了 maxLength 而不是自己写死」。
try {
  const listed = handlers.get('session:list')(null, {});
  eq(listed.titleMax, store.SESSION_TITLE_MAX, '★ session:list 没有把 SESSION_TITLE_MAX 带给界面（界面只能自己编一个数字）');
  eq(typeof listed.titleMax, 'number', 'titleMax 不是数字 —— 界面侧的 Number() 会得到 NaN');
} catch (e) {
  ok(false, 'session:list 调用失败', e.message);
}
// 两侧字段名必须对上：主进程改了 key、界面还在读旧名字，是这类透传最常见的坏法
const jarvisSrc = read('src/main/jarvis/index.js');
const panelSrc = read('src/renderer/js/panel.js');
const listBlock = jarvisSrc.slice(jarvisSrc.indexOf("ipcMain.handle('session:list'"));
const listKeys = listBlock.slice(0, listBlock.indexOf('});'));
ok(listKeys.includes('titleMax'), '主进程的 session:list 载荷里没有 titleMax');
ok(panelSrc.includes('data.titleMax'), '界面没有读 data.titleMax —— 两边字段名已经对不上了');

eq(await renameIpc('不存在的会话 id', 'x'), null, '未知 id 没有返回 null（调用方无从判断失败）');
eq(store.getSession('不存在的会话 id'), null, '未知 id 的 getSession 不为 null');

section('[3] 排序与删除');
const ids = readSessions().sessions.map((x) => x.id);
ok(ids.includes(s1.id) && ids.includes(s2.id), '两个会话都在磁盘上（后面顺序断言的前提）');
const n = store.deleteSession(s2.id);
eq(n, 1, '删会话后的剩余数量不对');
eq(store.getSession(s2.id), null, '会话没被删掉');

section('[4] 界面落点：抽屉里真有重命名入口');
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const panel = strip(read('src/renderer/js/panel.js'));
// 反向对照：这个判定方式确实认得出现有的调用点，否则「找不到」全是假报告
ok(panel.includes('window.xw.sessionDelete('), '反向对照：能认出已知的调用点');
ok(panel.includes('window.xw.sessionRename('), '★ 抽屉里没有 sessionRename 调用点 —— 能力又躺回「有实现没入口」');

// 只断言「文件里出现过这个名字」是假锁：别处赋值 / 注释都能满足它。
// 这里把入口挂载那个函数的**函数体**抠出来，断言调用发生在函数体这一层。
const fnBody = (src, name) => {
  const i = src.indexOf(name);
  if (i < 0) return '';
  const s = src.indexOf('{', i);
  let depth = 0;
  for (let j = s; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(s, j + 1); }
  }
  return '';
};
const body = fnBody(panel, 'async function renderSessionList');
ok(body.length > 200, '抠到了抽屉渲染函数体（抠不到时下面会在空串上假绿）');
ok(body.includes('startSessionRename'), '抽屉条目上没有挂重命名入口');
const renBody = fnBody(panel, 'function startSessionRename');
ok(renBody.length > 200, '抠到了 startSessionRename 的函数体');
ok(renBody.includes('window.xw.sessionRename('), '重命名入口没有真的调主进程（界面里另写一套？）');
ok(renBody.includes('stopPropagation('), '输入框没挡住冒泡 —— 点一下会顺带切到那个会话');
ok(/key\s*===\s*'Escape'/.test(renBody), '没有 Esc 取消（用户点错了只能硬着头皮改完）');
/* 上限：界面**不许自己写死一个数字**（本仓「同一件事写两遍」的老毛病），
   必须拿主进程给的那个值设到输入框上。判据是「赋给 maxLength 的不是数字字面量」，
   而不是「文件里没有 60」——后者会被别处的无关数字满足，是假锁。 */
const maxAssign = /maxLength\s*=\s*([^;]+);/.exec(renBody);
ok(maxAssign, '输入框没有设 maxLength —— 超长标题会在回车那一瞬间突然变短（用户以为手抖了）');
ok(maxAssign && !/^\s*\d+\s*$/.test(maxAssign[1]), `maxLength 被写成了数字字面量（${maxAssign && maxAssign[1].trim()}）—— 上限又变成两份了`);
ok(renBody.includes('titleMax'), '输入框的长度上限不是从主进程给的 titleMax 来的');
ok(renBody.includes('oninput'), '没有监听输入 —— 那就没有实时计数');
ok(/['"`]\$\{[^}]*\}\/\$\{limit\}/.test(renBody) || /\$\{[^}]*\}\/\$\{limit\}/.test(renBody), '没有「已输入/上限」的计数 —— 到顶静默不进字会让人以为键盘坏了');
ok(renBody.includes("classList.toggle("), '计数到顶没有视觉提示（颜色不变的话用户不知道为什么打不进去字）');
// 抽屉调用的那一处要把上限传进去
ok(/startSessionRename\(\s*title\s*,\s*meta\s*,\s*s\s*,\s*data\.titleMax\s*\)/.test(body), '抽屉里调用重命名时没有把 data.titleMax 传下去 —— 透传断在这一步');
const cssLimit = read('src/renderer/styles/panel.css');
ok(/\.sess-meta--limit\s*\{/.test(cssLimit), '样式里没有 .sess-meta--limit —— 计数到顶不会变色');
// 这条是**源码形态**的锁，刻意保留：本测试没有 DOM，没法跑「进入编辑时名字是否被选中」。
// 判据退一步 —— 至少确认调用存在，别让「点开还得先手动全选删掉」这种体验悄悄回来。
ok(renBody.includes('input.select()'), '进入编辑没有选中原名字 —— 改名得先手动全选删掉');
ok(renBody.includes('input.focus()'), '进入编辑没把焦点给输入框');

const css = read('src/renderer/styles/panel.css');
ok(/\.sess-ren\s*\{/.test(css), '样式里没有 .sess-ren —— 重命名按钮没有可点的形状');
ok(/\.sess-rename-input\s*\{/.test(css), '样式里没有 .sess-rename-input —— 编辑时不输入框不可见');
ok(/\.sess-item\s*\{[^}]*padding:[^;]*46px/.test(css), '条目右侧没给两个图标留出宽度 —— 标题会压在图标下面');

section('');
if (fails.length) {
  console.log(`  ${fails.length} 项失败：`);
  for (const f of fails) console.log(`    - ${f}`);
  process.exit(1);
}
console.log(`  ${pass} 项全部通过。`);
