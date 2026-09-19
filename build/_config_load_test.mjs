/**
 * 配置文件读写的判据测试 —— node build/_config_load_test.mjs
 *
 * 被测对象是 `src/main/config-store.js`（纯 Node，不 require electron）。
 * 这一节钉住的是一条**用户能一路走到黑**的路径：
 *
 *   README 教用户「复制 config.example.json 为 config.json，填自己的值」，
 *   而老代码在 JSON.parse 抛错时直接 `return { ...DEFAULT_CONFIG }`，
 *   saveConfig 又无条件覆盖。于是一次手抖（多一个逗号 / 少一个引号）会变成：
 *     设置全没了 → 随手点一下任何开关（甚至只是发一条消息，history:add 也落盘）
 *     → 那份本来还能救回来的 config.json 被默认值覆盖 → 没有任何提示、也留不下任何东西。
 *
 * 所以这里的断言分三层：
 *   1) 坏文件必须**逐字节**留下备份，再回落默认值；
 *   2) 读不动（权限 / 被占用）时**不许写** —— 连读都没读到，无从判断会毁掉什么；
 *   3) 配置的「默认值只有一份」必须有人扛：设置界面会写的每个键都得在 DEFAULT_CONFIG 里。
 *      （这一条本轮就抓到了真漂移：`orchReview` 界面在写、默认值里没有。）
 *
 * 注意第 1、2 层是**真跑**：真建临时目录、真写文件、真读回来比对字节。
 * 只有「读不动」那一节注入了一个假的 fs —— 因为 Windows 上 chmod 造不出稳定的 EACCES，
 * 而用假 fs 注入时被测的 store 逻辑（怎么分诊、写不写盘）仍然是真的。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const { createConfigStore, classifyText } = require('../src/main/config-store.js');

let pass = 0; const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else fails.push(name + (extra ? ` → ${extra}` : '')); };
const eq = (a, b, name) => ok(
  JSON.stringify(a) === JSON.stringify(b), name,
  `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`
);
const section = (s) => console.log('\n' + s);

const DEFAULTS = { apiKey: '', model: 'deepseek-chat', hotkey: 'Alt+Space', petSize: 120 };
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xw-cfg-'));
const dirs = [];
function newDir(tag) {
  const d = path.join(tmpRoot, tag);
  fs.mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}
const cfgFile = (d) => path.join(d, 'config.json');
const badFiles = (d) => fs.readdirSync(d).filter((f) => f.startsWith('config.json.bad-'));
// 有的机器 / 有的损坏内容带 BOM，逐字节比对时用 Buffer 而不是字符串
const readBuf = (p) => fs.readFileSync(p);

// ---------------- 1. 分类：能解析 ≠ 能用 ----------------
section('1. 一段文本属于哪种状态');
{
  eq(classifyText('').kind, 'empty', '空串是 empty');
  eq(classifyText('   \r\n\t ').kind, 'empty', '只有空白也是 empty');
  eq(classifyText('{').kind, 'invalid', '半个对象是 invalid');
  eq(classifyText('{"apiKey": }').kind, 'invalid', '值缺失是 invalid');
  eq(classifyText('[1,2]').kind, 'not-object', '数组能 parse，但顶层不是对象');
  eq(classifyText('null').kind, 'not-object', 'null 能 parse，但不是对象');
  eq(classifyText('123').kind, 'not-object', '数字能 parse，但不是对象');
  eq(classifyText('"abc"').kind, 'not-object', '字符串能 parse，但不是对象');
  eq(classifyText('{"a":1}').kind, 'ok', '正常对象是 ok');
  ok(classifyText('{"a":1}').value && classifyText('{"a":1}').value.a === 1, 'ok 时把解析结果带出来');
  // 字符串被展开成索引键是「能解析但不能用」最坑的一种，单独点名
  eq(Object.keys({ ...'ab' }).join(','), '0,1',
    '把字符串展开进配置会得到 0/1 这种垃圾键 —— 所以 not-object 必须单独拦');
}

// ---------------- 2. 没有文件 = 全新安装 ----------------
section('2. 还没有 config.json');
{
  const store = createConfigStore(newDir('missing'), DEFAULTS);
  const r = store.load();
  eq(r.state, 'missing', '没有文件 → missing');
  eq(r.config, DEFAULTS, '回落默认值');
  ok(store.save({ ...DEFAULTS, model: 'x' }).ok, '全新安装时当然可以写盘');
  ok(fs.existsSync(cfgFile(path.dirname(store.filePath()))), '写盘之后文件真的出现了');
  eq(store.load().state, 'ok', '再读就是 ok');
}

// ---------------- 3. 正常读写 ----------------
section('3. 正常读写');
{
  const d = newDir('ok');
  fs.writeFileSync(cfgFile(d), JSON.stringify({ model: 'my-model', petSize: 200 }, null, 2), 'utf-8');
  const store = createConfigStore(d, DEFAULTS);
  const r = store.load();
  eq(r.state, 'ok', '合法 JSON 对象 → ok');
  eq(r.config.model, 'my-model', '文件里的值覆盖默认值');
  eq(r.config.apiKey, '', '文件里没写的键回落默认值');
  eq(r.unknownKeys, [], '没有不认识的键');
  eq(store.health().describe, '', '一切正常时横幅是空的（不该没事找事）');

  // 原子写：临时文件不许留在目录里
  ok(store.save({ ...r.config, model: 'next' }).ok, '保存成功');
  eq(fs.readdirSync(d).filter((f) => f.endsWith('.tmp')), [], '临时文件不留在配置目录里');
  eq(store.load().config.model, 'next', '保存的内容读得回来');

  // ★ 原子性的**可证伪**断言：最后那一步 rename 失败时，原文件必须一个字节都没动。
  // （只断言「没有 .tmp 残留」是假锁 —— 换成直接 writeFileSync 也照样绿。）
  const da = newDir('atomic');
  fs.writeFileSync(cfgFile(da), JSON.stringify({ model: 'keep-me' }), 'utf-8');
  const before = readBuf(cfgFile(da));
  const badRenameFs = {
    ...fs,
    renameSync: () => { const e = new Error('EPERM: rename blocked'); e.code = 'EPERM'; throw e; }
  };
  const atomicStore = createConfigStore(da, DEFAULTS, { fs: badRenameFs });
  atomicStore.load();
  const ra = atomicStore.save({ ...DEFAULTS, model: 'should-not-land' });
  ok(ra.ok === false, '★ rename 失败时保存必须报失败（不许报成功）');
  ok(readBuf(cfgFile(da)).equals(before), '★ rename 失败时原文件逐字节不变 —— 这正是原子替换的意义');
  eq(fs.readdirSync(da).filter((f) => f.endsWith('.tmp')), [], 'rename 失败后临时文件被清掉');
}

// ---------------- 4. ★ 坏文件：逐字节备份 + 回落默认值 ----------------
section('4. ★ 读不出来时必须先留证据');
{
  const d = newDir('corrupt');
  // 用 Buffer 造，确保写下去的字节 = 读回来的字节（含 CRLF 与中文）
  const broken = Buffer.from('{\r\n  "apiKey": "sk-my-real-key",\r\n  "model": "deepseek-chat",,\r\n}\r\n', 'utf-8');
  fs.writeFileSync(cfgFile(d), broken);
  const store = createConfigStore(d, DEFAULTS);
  const r = store.load();

  eq(r.state, 'invalid', '少一个逗号 → invalid');
  eq(r.config, DEFAULTS, '回落默认值');
  const bf = badFiles(d);
  eq(bf.length, 1, '★ 坏内容被备份了一份');
  // 注意：备份没写出来时**不要**继续去读它 —— 断言失败就该安静地记一笔，
  // 崩在 TypeError 上会把后面所有断言一起带走（失败路径也要走通）。
  const bp = bf.length ? path.join(d, bf[0]) : '';
  ok(!!bp && readBuf(bp).equals(broken), '★ 备份与原文件逐字节相同（含 CRLF / 中文 / 密钥）');
  ok(!!r.backupPath && r.backupPath.endsWith(bf[0] || '\u0000'), 'load() 把备份路径交出来了，界面才有的可显示');
  ok(/读了不|读不出来/.test(store.health().describe), '横幅文案说清了「读不出来」');
  ok(bf.length > 0 && store.health().describe.includes(bf[0]), '横幅文案里带着备份文件名');
  ok(fs.existsSync(cfgFile(d)), '★ 原文件没有被删掉 —— 只是回落到默认值，不动它的盘');

  // 反复读不许反复备份（loadConfig 每次发消息都会被调到）
  store.load(); store.load();
  eq(badFiles(d).length, 1, '★ 同一份坏内容只备份一次，不会每次 load 都写一份');

  // 备份之后允许写：不然界面会变成「点了保存但没生效」，更难查
  ok(store.save({ ...DEFAULTS, model: 'after' }).ok, '坏文件备份过之后允许写盘');
  eq(store.load().config.model, 'after', '写完之后读得到新内容');
  ok(!!bp && readBuf(bp).equals(broken), '★ 写新配置不会碰那份备份 —— 用户填的 Key 还在里面');
  eq(badFiles(d).length, 1, '修复之后不会再冒出新备份');;
}

// ---------------- 5. 顶层不是对象，同样要留证据 ----------------
section('5. 能解析但顶层不是对象');
{
  const d = newDir('notobject');
  const broken = '[{"model":"deepseek-chat"}]\n';
  fs.writeFileSync(cfgFile(d), broken, 'utf-8');
  const store = createConfigStore(d, DEFAULTS);
  const r = store.load();
  eq(r.state, 'not-object', '数组 → not-object');
  eq(r.config, DEFAULTS, '回落默认值');
  const bf5 = badFiles(d);
  eq(bf5.length, 1, '这种也要备份（不然用户问「我的配置呢」没人答得上来）');
  ok(bf5.length > 0 && readBuf(path.join(d, bf5[0])).equals(Buffer.from(broken, 'utf-8')), '备份逐字节相同');
  ok(store.health().describe.includes('顶层不是对象'), '文案说清是哪种坏法，而不是笼统一句「格式错误」');
}

// ---------------- 6. 空文件不算损坏 ----------------
section('6. 空文件（写入中断的残留）');
{
  const d = newDir('empty');
  fs.writeFileSync(cfgFile(d), '', 'utf-8');
  const store = createConfigStore(d, DEFAULTS);
  const r = store.load();
  eq(r.state, 'empty', '空文件 → empty');
  eq(r.config, DEFAULTS, '回落默认值');
  eq(badFiles(d).length, 0, '没有内容可备份，别造一个 0 字节的 .bad 文件出来');
  ok(store.save({ ...DEFAULTS, hotkey: 'Ctrl+1' }).ok, '空文件允许覆盖');
  eq(store.load().config.hotkey, 'Ctrl+1', '覆盖之后读得到');

  // 只有空白也算空 —— 编辑器「全选删除后保存」的产物长这样
  const d2 = newDir('blank');
  fs.writeFileSync(cfgFile(d2), '  \n\n\t\n', 'utf-8');
  eq(createConfigStore(d2, DEFAULTS).load().state, 'empty', '只有空白也是 empty');
}

// ---------------- 7. ★ 读不动就拒绝写 ----------------
section('7. ★ 读不动的文件，一个字都不许写下去');
{
  const d = newDir('unreadable');
  const real = JSON.stringify({ apiKey: 'sk-real', model: 'deepseek-chat' });
  fs.writeFileSync(cfgFile(d), real, 'utf-8');

  // 注入一个「读就抛 EACCES」的 fs：Windows 上 chmod 造不出稳定的 EACCES，
  // 但这里被替换的只有文件系统，store 自己怎么分诊、肯不肯写，仍然是真逻辑。
  const denyFs = {
    ...fs,
    readFileSync: () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
  };
  const store = createConfigStore(d, DEFAULTS, { fs: denyFs });
  const r = store.load();
  eq(r.state, 'unreadable', 'EACCES → unreadable');
  eq(r.config, DEFAULTS, '同样回落默认值（界面总得有东西可用）');
  ok(store.health().writeAllowed === false, '★ health 明确说这次不许写');
  const s = store.save({ ...DEFAULTS, model: 'should-not-land' });
  ok(s.ok === false, '★ 保存被拒绝');
  ok(/不写盘|拒绝|unreadable/.test(String(s.error)), '拒绝时把原因讲出来了', s.error);
  eq(fs.readFileSync(cfgFile(d), 'utf-8'), real, '★ 文件内容一个字节都没变');
  eq(fs.readdirSync(d).filter((f) => f.endsWith('.tmp')), [], '被拒绝的写入也没留下临时文件');
  ok(/读不动/.test(store.health().describe), '横幅文案换了说法：读不动 ≠ 读不出来');
}

// ---------------- 8. 不认识的键：拼错了要有人讲 ----------------
section('8. 配置文件里拼错的键');
{
  const d = newDir('unknown');
  fs.writeFileSync(cfgFile(d), JSON.stringify({
    model: 'deepseek-chat', hotKey: 'Ctrl+1', apiKeyy: 'sk-x', petSize: 120
  }, null, 2), 'utf-8');
  const store = createConfigStore(d, DEFAULTS);
  const r = store.load();
  eq(r.state, 'ok', '拼错了也还是合法 JSON，不该当成损坏');
  eq(r.unknownKeys.slice().sort(), ['apiKeyy', 'hotKey'], '把不认识的键报出来');
  eq(r.config.petSize, 120, '认识的键照常生效');
  ok(store.health().describe.includes('hotKey'), '横幅点名到具体的键');
  ok(store.health().describe.includes('拼错'), '并且说明后果：改了不生效');
  ok(!store.health().describe.includes('sk-x'), '★ 横幅里绝不带配置值（密钥不能从这儿漏出去）');
}

// ---------------- 9. ★ 默认值只有一份：谁在扛 ----------------
// main.js 是 Electron 入口（一 require 就整个应用跑起来），单测里没法行为断言，
// 所以这一节是**跨文件核对**：设置界面会写的每个键，都必须在 DEFAULT_CONFIG 里。
// 写错一个字母（hotKey / captureHotKey）不会报错、也不会生效 —— 界面显示已保存，
// 重启后回到旧值，用户完全无从下手。本轮就是靠这条抓到 `orchReview`。
section('9. ★ 设置界面会写的键，DEFAULT_CONFIG 必须都有');
{
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf-8');
  const start = mainSrc.indexOf('const DEFAULT_CONFIG = {');
  ok(start > 0, '能定位 DEFAULT_CONFIG');
  const lines = mainSrc.slice(start).split('\n');
  const defaultKeys = [];
  // 键有两种来源：行首的对象字面量 `key:`，以及 `...someModule.DEFAULTS,` 这种展开。
  // **展开必须跟着解** —— 否则「把默认值收敛到唯一来源」这个改动本身会让下面那条
  // 「config.example.json 里没有假键」误判成 7 个假键（本轮就撞了一次）。
  // 别名 → 文件 的映射从 main.js 自己的 require 现算，不手抄映射表。
  const aliasToFile = new Map();
  for (const m of mainSrc.matchAll(/const\s+(\w+)\s*=\s*require\(\s*['"](\.\/[\w./-]+)['"]\s*\)/g)) {
    aliasToFile.set(m[1], path.join(ROOT, 'src/main', m[2]));
  }
  const spreads = [];
  for (let n = 1; n < lines.length; n++) {
    if (/^};/.test(lines[n])) break;
    const m = /^ {2}(\w+):/.exec(lines[n]);
    if (m) { defaultKeys.push(m[1]); continue; }
    const sp = /^ {2}\.\.\.(\w+)\.(\w+)\s*,/.exec(lines[n]);
    if (sp) spreads.push([sp[1], sp[2]]);
  }
  ok(spreads.length > 0, `DEFAULT_CONFIG 里有 ${spreads.length} 处展开（键的另一半来源）`,
    '一处都没解析到的话，下面那条「展开进来的键得算数」会在空集上通过');
  for (const [alias, prop] of spreads) {
    const file = aliasToFile.get(alias);
    ok(!!file, `认得出展开 ${alias} 是从哪个文件 require 的`, `main.js 的 require 表里没有 ${alias}`);
    if (!file) continue;
    const keys = Object.keys(require(file)[prop] || {});
    ok(keys.length > 0, `展开的 ${alias}.${prop} 是非空对象`, `拿到 ${keys.length} 个键`);
    defaultKeys.push(...keys);
  }
  ok(defaultKeys.length > 50, 'DEFAULT_CONFIG 解析出足够的键', `只解析到 ${defaultKeys.length} 个`);
  ok(defaultKeys.includes('autoUpdateNotify'),
    '★ 从 updater-plan.DEFAULTS 展开进来的键也算 DEFAULT_CONFIG 的键（否则收敛默认值的那次改动会让这条锁失效）');

  const panelSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/js/panel.js'), 'utf-8');

  // (a) 保存按钮唯一会写的那份 patch —— collectPatch() 返回的对象字面量
  const cp = panelSrc.indexOf('function collectPatch()');
  ok(cp > 0, '能在 panel.js 里找到 collectPatch');
  const cpBody = panelSrc.slice(cp, panelSrc.indexOf('\n}\n', cp));
  const patchKeys = [];
  for (const m of cpBody.matchAll(/^\s{4}([a-zA-Z][\w]*)\s*:/gm)) patchKeys.push(m[1]);
  for (const m of cpBody.matchAll(/^\s{2}patch\.([a-zA-Z][\w]*)\s*=/gm)) patchKeys.push(m[1]);
  ok(patchKeys.length > 30, 'collectPatch 解析出足够的键', `只解析到 ${patchKeys.length} 个`);
  eq(patchKeys.filter((k) => !defaultKeys.includes(k)), [],
    '★ 保存按钮写的每个键都在 DEFAULT_CONFIG 里（写错一个字母就是永久静默失效）');

  // (b) 那些「一个开关一行」的表：['元素 id', '配置键'] —— 第二项必须是真配置键。
  //     只要第一项**真是页面上的一个元素 id**（以 panel.html 的 `id="..."` 为准，
  //     不是以 `$('...')` 为准 —— 有的表是 `$(id)` 循环绑的，那样一个字都认不出来）。
  //     第二项本身不能也是元素 id。
  //     （`['microphone','webcam']` 这种设备名列表、`['stPetTop','stPetWalk']` 这种
  //      id 列表都会被挡掉，不需要手抄一份豁免名单。）
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/panel.html'), 'utf-8');
  const isElId = (s) => htmlSrc.includes(`id="${s}"`);
  ok(isElId('mtEnabled') && isElId('wEnabled'), '从 panel.html 能认出元素 id（解析面自证）');

  const pairs = [...panelSrc.matchAll(/\[\s*'([A-Za-z][\w-]*)'\s*,\s*'([a-z][\w]*)'\s*[,\]]/g)];
  const tableKeys = [];
  for (const [, a, b] of pairs) {
    if (!isElId(a)) continue;      // 第一项不是页面上的元素 → 与配置无关
    if (isElId(b)) continue;       // 第二项本身也是个元素 id → 不是配置键
    tableKeys.push(b);
  }
  ok(tableKeys.length >= 10, '配置键表解析出足够的项', `只解析到 ${tableKeys.length} 个`);
  ok(tableKeys.includes('meetingEnabled') && tableKeys.includes('meetingCaptureMic'),
    '解析面没退化（认得出「元素 id → 配置键」那两张会议表）', tableKeys.join(', '));
  eq([...new Set(tableKeys.filter((k) => !defaultKeys.includes(k)))], [],
    '★ 表格里登记的配置键都在 DEFAULT_CONFIG 里');

  // (c) 自映射的小表（orchToggles 那种 `X: 'X'`）—— 本轮那处漂移就是在这里
  const selfMaps = [...panelSrc.matchAll(/\b([a-z][\w]*)\s*:\s*'([a-z][\w]*)'\s*[,\}]/g)]
    .filter((m) => m[1] === m[2]).map((m) => m[1]);
  // 自证：两处解析面都别是空的 —— 解析面为空时下面的「差集为空」恒真
  console.log(`  · 解析面自证：collectPatch ${patchKeys.length} 项 / 配置键表 ${tableKeys.length} 项 / 自我映射表 ${[...new Set(selfMaps)].length} 项`);
  ok(selfMaps.length >= 3, '解析出自我映射的键表', selfMaps.join(', '));
  eq([...new Set(selfMaps.filter((k) => !defaultKeys.includes(k)))], [],
    '★ 自我映射表里的键都在 DEFAULT_CONFIG 里');
  ok(defaultKeys.includes('orchReview'),
    '★ orchReview 必须在 DEFAULT_CONFIG 里（它是设置页的一个开关，之前只存在于界面和示例文件里）');

  // (d) 示例文件是给用户照抄的，里面的键更得是真的
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf-8'));
  const exKeys = Object.keys(example).filter((k) => !k.startsWith('_'));
  eq(exKeys.filter((k) => !defaultKeys.includes(k)), [],
    '★ config.example.json 里没有假键（用户照抄它是要能生效的）');
}

// ---------------- 10. 判据必须真的被主进程用上 ----------------
// 回归主要发生在「有人把 loadConfig 改回直接 JSON.parse」的那一刻：上面所有行为断言
// 都会继续全绿（它们测的是 config-store.js），而线上的毛病原样回来。
section('10. main.js 走的是同一份判据');
{
  const src = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf-8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const loadStart = src.indexOf('function loadConfig()');
  ok(loadStart > 0, '找得到 loadConfig');
  const loadBody = strip(src.slice(loadStart, src.indexOf('\n}', loadStart)));
  ok(loadBody.includes('configStore.load()'), 'loadConfig 走 configStore.load()');
  ok(!loadBody.includes('JSON.parse'), 'loadConfig 里不再自己 JSON.parse（那条路径没有备份）');

  const saveStart = src.indexOf('function saveConfig(cfg)');
  ok(saveStart > 0, '找得到 saveConfig');
  const saveBody = strip(src.slice(saveStart, src.indexOf('\n}', saveStart)));
  ok(saveBody.includes('configStore.save('), 'saveConfig 走 configStore.save()');
  ok(!saveBody.includes('writeFileSync'), 'saveConfig 里不再直接 writeFileSync（那就没有原子替换）');

  ok(/createConfigStore\(CONFIG_DIR,\s*DEFAULT_CONFIG\)/.test(src),
    '★ store 是用 DEFAULT_CONFIG 建的 —— 默认值的唯一来源不能有第二份');
  ok(src.includes("ipcMain.handle('config:health'"), '主进程暴露了 config:health');
  const pre = fs.readFileSync(path.join(ROOT, 'src/main/preload.js'), 'utf-8');
  ok(pre.includes('configHealth:'), 'preload 把 configHealth 暴露给渲染层');
  const panel = fs.readFileSync(path.join(ROOT, 'src/renderer/js/panel.js'), 'utf-8');
  ok(panel.includes('renderConfigHealth'), '设置页真的会渲染这条状态');
}

// ---------------- 清理 ----------------
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {
  console.log('（临时目录没删掉，不影响结论：' + tmpRoot + '）');
}

// ---------------- 汇总 ----------------
console.log('\n' + '='.repeat(46));
if (fails.length) {
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`配置文件读写判据：通过 ${pass} / ${pass}`);
