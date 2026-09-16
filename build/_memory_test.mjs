/**
 * 长期记忆检索 + 「谁能看到哪几条」回归测试 —— node build/_memory_test.mjs
 *
 * 为什么需要它
 * ------------
 * 设置页原本只有「记忆流水」：`memory:search` 这个 IPC 从建立起就有、也一直挂在 preload 上，
 * 但渲染层**一次都没调用过**（全仓 grep 得到 0 处）。于是用户看不到
 * 「我这句话会让小问想起哪几条」—— 记忆调不出来时无处可查，只能靠猜。
 *
 * 补入口的同时暴露了一个更隐蔽的问题：**同一套检索有两个条数**。
 * 对话注入写死 8（`agent.js` 直接传 8），设置页那条路径写死 10。
 * 两个数字都不报错，只是「你在设置里看到会被检索到的记忆」与「对话里真正注入的记忆」
 * 不是同一批 —— 用户按前者判断小问记住了什么，判断的却是另一个列表。
 * 这正是本仓库反复踩的「同一件事写两遍必然漂移」，所以这里连条数一起锁。
 *
 * 怎么锁的
 * --------
 * 不读源码猜形状，而是用一个最小 electron stub 把 jarvis 的 IPC handler **真注册、真调用**
 * （`ipcMain.handle` 被拦下来存进 map），断言 `memory:search` 的返回值与
 * `store.searchMemories(q, store.MEMORY_PROMPT_LIMIT)` 逐条相同。
 * 这样「两端看的是同一批」是被执行出来的，而不是被正则猜出来的
 *（初版这里用 `searchMemories\([^)]*,\s*\d+\s*\)` 判「有没有写死数字」——
 *  `searchMemories(String(q || ''), 10)` 里的内层 `)` 会让该正则漏判，已换成行为断言）。
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xw-mem-'));
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

// ---------------- 1. 条数只有一个来源 ----------------
section('1. 检索条数只有一个来源');
{
  ok(typeof store.MEMORY_PROMPT_LIMIT === 'number' && store.MEMORY_PROMPT_LIMIT > 0, 'store 导出了 MEMORY_PROMPT_LIMIT');
  eq(store.MEMORY_PROMPT_LIMIT, 8, '对话注入的条数');

  store.clearMemories();
  for (let i = 0; i < 20; i++) store.addMemory({ content: `第 ${i} 条偏好记忆`, category: 'fact' });
  const q = '偏好记忆';

  const injected = store.memoryPrompt(q).split('\n').slice(1).map((l) => l.replace(/^- /, ''));
  eq(injected.length, store.MEMORY_PROMPT_LIMIT, '注入条数应等于 MEMORY_PROMPT_LIMIT');
  const direct = store.searchMemories(q, store.MEMORY_PROMPT_LIMIT).map((m) => m.content);
  eq(JSON.stringify(injected), JSON.stringify(direct), '注入的清单与同一套检索取同样条数的结果必须逐条相同');

  // 反向对照：条数参数真的在起作用（否则上面那条「同源」断言是恒真的）
  eq(store.searchMemories(q, 3).length, 3, '条数参数没有生效 —— 上面的同源断言就失去了意义');
  ok(store.searchMemories(q, 30).length === 20, '条数放大后应拿回全部命中');
}

// ---------------- 2. 检索行为 ----------------
section('2. 检索行为');
{
  store.clearMemories();
  store.addMemory({ content: '我做 AI 平台产品，前端用 Vue3', category: 'fact' });
  store.addMemory({ content: '喜欢简洁直接的沟通方式', category: 'preference' });
  store.addMemory({ content: 'My favorite editor is vscode', category: 'fact' });

  eq(store.searchMemories('Vue3').length, 1, '英文数字关键词能命中');
  eq(store.searchMemories('Vue3')[0].content.includes('Vue3'), true, '命中的是正确的条目');
  eq(store.searchMemories('沟通方式').length, 1, '中文按二字组命中');
  eq(store.searchMemories('完全不相干的内容').length, 0, '不命中返回空数组（不是全部）');
  eq(store.searchMemories('').length, 3, '空查询回退成「最近 N 条」而不是空列表');

  const text = store.memoryPrompt('Vue3');
  ok(text.startsWith('你记得关于主人的这些事：'), `注入文本要有固定开头：${text.slice(0, 20)}`);
  eq(text.split('\n').length, 2, '注入文本 = 一行开头 + 命中条目');

  eq(store.memoryPrompt('完全不相干的内容'), '', '一条都没命中时返回空串（不注入空标题）');

  const id = store.getMemories()[0].id;
  eq(store.removeMemory(id), 2, '删除后条目数递减');
  ok(!store.searchMemories('AI 平台').length || true, '删除后不抛异常');
}

// ---------------- 3. 设置页与对话注入必须是同一批 ----------------
section('3. memory:search 真跑一遍 · 与对话注入同批同量');
{
  // 提取 `xxx(` 之后的顶层实参 —— 括号配平扫描，不能用 `[^)]*` 正则：
  // `searchMemories(String(q || ''), 10)` 里的内层 `)` 会让正则直接漏判。
  const callArgs = (src, call) => {
    const at = src.indexOf(call);
    if (at < 0) return null;
    const args = [''];
    let depth = 1;
    let quote = null;
    for (let i = at + call.length; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        args[args.length - 1] += c;
        if (c === quote && src[i - 1] !== '\\') quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; args[args.length - 1] += c; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) break; }
      else if (c === ',' && depth === 1) { args.push(''); continue; }
      args[args.length - 1] += c;
    }
    return args.map((s) => s.trim());
  };

  // 对话侧的调用形态：agent.js 不许自己塞一个条数。
  // 条数进了 store 的默认参数之后，「不传」就等于「用 MEMORY_PROMPT_LIMIT」，
  // 所以这里锁的不是数字，而是「没有第二个实参」这件事本身。
  const agentSrc = read('src/main/jarvis/agent.js');
  const mpArgs = callArgs(agentSrc, 'store.memoryPrompt(');
  ok(!!mpArgs, 'agent.js 不再调用 store.memoryPrompt —— 对话侧的长期记忆注入没了');
  eq(
    mpArgs && mpArgs.length,
    1,
    `agent.js 给记忆注入自己传了第二个实参（${mpArgs && mpArgs[1]}）—— 条数只能来自 store.MEMORY_PROMPT_LIMIT，` +
    '否则「对话里真正注入的」和「设置页看到的」不是同一批'
  );

  let jarvis = null;
  try {
    jarvis = require(path.join(ROOT, 'src/main/jarvis/index.js'));
  } catch (e) {
    ok(false, 'jarvis/index.js 加载失败（stub 不够用了）', (e && e.message) || String(e));
  }
  if (jarvis) {
    try { jarvis.registerAll(); } catch (e) { ok(false, 'registerAll 抛异常', (e && e.message) || String(e)); }

    const h = handlers.get('memory:search');
    ok(typeof h === 'function', '没有注册 memory:search 这个 IPC —— 设置页的搜索框会永远拿不到数据');

    if (typeof h === 'function') {
      store.clearMemories();
      for (let i = 0; i < 60; i++) store.addMemory({ content: `第 ${i} 条偏好记忆`, category: 'fact' });
      const q = '偏好记忆';

      const got = h(null, q);
      eq(got.length, store.MEMORY_PROMPT_LIMIT, 'IPC 不传条数时应等于对话注入的条数');
      eq(
        JSON.stringify(got.map((m) => m.content)),
        JSON.stringify(store.searchMemories(q, store.MEMORY_PROMPT_LIMIT).map((m) => m.content)),
        '设置页看到的清单必须与对话注入的清单逐条相同（这才是「同一批」）'
      );

      // 反向对照：界面真能要到别的条数，否则上面那条同源断言只是两个默认值碰巧相等
      eq(h(null, q, 3).length, 3, '界面传入的条数没有生效 —— 同源断言会退化成「默认值恰好相等」');
      eq(h(null, q, 50).length, 50, '条数放大应生效（命中 60 条，取 50）');
      eq(h(null, q, 999).length, 50, '条数要有上限，不能让界面一次把记忆全捞出来');
      eq(h(null, q, 0).length, store.MEMORY_PROMPT_LIMIT, '非法条数（0）要回落到默认，不能变成「一条都不给」');
      eq(h(null, q, 'abc').length, store.MEMORY_PROMPT_LIMIT, '非法条数（非数字）要回落到默认');
      eq(h(null, q, -5).length, 1, '负数要夹到最小 1，不能出现负数切片');

      // 查询串的边界：null / undefined 不能把 handler 打崩
      let threw = null;
      let nullQ = null;
      try { nullQ = h(null, null); } catch (e) { threw = e; }
      ok(!threw, '空查询打崩了 handler', threw && threw.message);
      eq(nullQ && nullQ.length, store.MEMORY_PROMPT_LIMIT, '空查询应回退成「最近 N 条」，N 同样是那个唯一条数');
    }
  }
}

// ---------------- 4. 界面入口真的存在 ----------------
section('4. 界面入口');
{
  const html = read('src/renderer/panel.html');
  for (const id of ['memSearch', 'memSearchClear', 'memSearchHint']) {
    ok(html.includes(`id="${id}"`), `panel.html 里没有 #${id}`);
  }

  const js = read('src/renderer/js/panel.js');
  ok(js.includes('window.xw.memorySearch('), 'panel.js 从没调用过 memorySearch —— 搜索框会是摆设');
  ok(js.includes("$('memSearch').addEventListener('input'"), '搜索框没有监听输入');
  ok(js.includes("$('memSearchClear').addEventListener('click'"), '清空按钮没有绑定');
  ok(/if\s*\(q\)/.test(js), '空查询与非空查询要分流（空查询显示全部）');

  const preload = read('src/main/preload.js');
  ok(/memorySearch:\s*\(q,\s*limit\)/.test(preload), 'preload 的 memorySearch 要能把条数透传（界面不该自己编一个数）');

  // 计数不变量：渲染记忆条目只允许有一处实现。列表与搜索结果各写一份必然漂移
  //（一边加了标签另一边没有、一边的删除按钮忘了刷新），所以这里数一数。
  // 数的是**类名字符串本身**而不是 `className = 'mem-item'`：
  // 换一种写法（`classList.add('mem-item')`、模板串里的 `class="mem-item"`）
  // 同样是「另起一份实现」，得一起抓住。
  const itemCls = (js.match(/['"]mem-item['"]/g) || []).length;
  eq(itemCls, 1, `panel.js 里出现 ${itemCls} 处 'mem-item' —— 渲染记忆条目的实现只允许有一处`);
  const deleters = (js.match(/memoryRemove\(/g) || []).length;
  eq(deleters, 1, `panel.js 里出现 ${deleters} 处 memoryRemove —— 删除后的刷新逻辑也要只有一份`);
}

Module._load = origLoad;

// ---------------- 汇总 ----------------
console.log('');
if (fails.length) {
  console.log(`  ${fails.length} 项失败：\n`);
  for (const f of fails) console.log(`    - ${f}\n`);
  console.log('长期记忆检索测试未通过。\n');
  process.exit(1);
}
console.log(`  ${pass} 项全部通过。\n`);
