/**
 * 打包校验的**自测**：确认「依赖没进 asar / 入口不在包里 / 裸 require 没声明」
 * 这类问题真的会让 `_packed_check.mjs` 变红。
 *
 * 为什么需要它
 * ------------
 * `_packed_check.mjs` 唯一一次能跑到第 1–4 节，得先 `npm run dist:dir` 打一个包
 * （几分钟 + 几百 MB），而且它**读的是上一次打包的产物** —— 拿一个陈年 asar 去判
 * 「新的检查到底会不会红」是判不出来的（旧包里本来就缺文件，全红）。
 * 这里改用**合成 asar**：asar 的头部格式很简单（16 字节前缀 + JSON 目录 + 数据），
 * 造一个只含目标文件清单的假包，秒级、可重复、不依赖 electron-builder。
 *
 * 清单与判据从 `_packed_manifest.mjs` 取（与校验脚本同一份）：抄第二份的话，
 * 测试就会拿一份已经漂移的期望去测另一份实现 —— 本仓反复踩过这个形状。
 *
 * 用例：
 *   A. 齐全 → 全绿、退出码 0（守卫不许把正常包判红）
 *   B. 整个 `node_modules/ws/` 不在包里 → 红，且**点名 ws**
 *   C. `ws` 只剩一个 package.json（包被截断）→ 红，且说清是「截断」
 *   D. 依赖清单在、但**入口文件**没进包 → 红（旧脚本把 ws/index.js 写死，验不到别人）
 *   E. 源码 require 了没声明的模块 → 红且点名；require('electron') 不算漏
 *   F. `--src-only` 不需要 asar，退出码只由第 5 节决定
 *   G. `build.files` 里新加的打包目录自动进扫描面（扫描面现算）
 *   H. 扫描面的自证：配置不符 / 排除表腐烂 / 扫描面为空都要自己喊出来
 *   I. **fixture 自己的完整性**：两套独立算法枚举真实目录、清单必须一致；
 *      文件数触及报警阈值要报出来（原先是「收满 300 条就停」，静默截断）；
 *      FULL 每一项按**来源**分类后各问各该问的（构建产物问本源、不要求此刻存在）；
 *      「vite 会产出什么」⇄「清单登记了什么」两向对账，且产物面解析不出来要自己喊
 *
 * 用法：npm run test:packed-deps
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

import {
  REQUIRED, productionDeps, bareRequires, undeclaredRequires, entryCandidates, inPackage,
  EXCLUDED_PACKED_DIRS, packedDirPrefixes, runtimeSourceFiles,
  DEP_DIRS, ARTIFACT_DIRS, isArtifactPath, isDepPath, rendererBuildProducts
} from './_packed_manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CHECK = path.join(__dirname, '_packed_check.mjs');

let pass = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) {
    pass++;
    console.log('  PASS ' + name);
  } else {
    failures.push(name + (extra ? ' :: ' + extra : ''));
    console.log('  FAIL ' + name + (extra ? ' :: ' + extra : ''));
  }
}
function eq(actual, expected, name) {
  ok(JSON.stringify(actual) === JSON.stringify(expected),
    name, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xwda-packed-'));

// ── 合成 asar ────────────────────────────────────────────────────────────
/**
 * asar 头部：`[u32 4][u32 头部尺寸][u32 目录块尺寸][u32 JSON 字节数]` + JSON + 对齐填充。
 * 校验脚本只读 offset 12 拿 JSON 长度、再按 JSON 里的目录树列文件，所以内容可以是占位字节。
 */
function buildAsar(name, relPaths, bigPaths = []) {
  const header = { files: {} };
  let offset = 0;
  for (const p of relPaths) {
    const parts = p.split('/');
    let node = header;
    for (let i = 0; i < parts.length - 1; i++) {
      node.files[parts[i]] = node.files[parts[i]] || { files: {} };
      node = node.files[parts[i]];
    }
    const size = bigPaths.includes(p) ? 2000 : 8;
    node.files[parts[parts.length - 1]] = { offset, size };
    offset += size;
  }
  const json = Buffer.from(JSON.stringify(header), 'utf-8');
  const pad = (4 - (json.length % 4)) % 4;
  const headerPayload = 4 + json.length + pad;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(4 + headerPayload, 4);
  prefix.writeUInt32LE(headerPayload, 8);
  prefix.writeUInt32LE(json.length, 12);
  const dest = path.join(TMP, name);
  fs.writeFileSync(dest, Buffer.concat([prefix, json, Buffer.alloc(pad), Buffer.alloc(offset, 0x41)]));
  return dest;
}

/** 跑校验脚本，拿 stdout + 退出码（脚本自身断言 exit code 只由检查结果决定） */
function runCheck(asar, extraArgs = []) {
  const r = spawnSync(process.execPath, [CHECK, ...(asar ? [asar] : []), ...extraArgs], {
    cwd: ROOT, encoding: 'utf-8', windowsHide: true
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const DEPS = productionDeps(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')));

/**
 * 列出一个已安装依赖的**真实文件**（跳过它自己的嵌套 node_modules，那部分由
 * electron-builder 单独处理），用来造「跟真包一样」的假 asar。
 *
 * 这里刻意**不**按 `entryCandidates()` 的结果去造 —— 否则 fixture 与被测函数
 * 共用同一份实现：函数退化成「写死 index.js」，fixture 也跟着只塞 index.js，
 * 用例 A 照样全绿，等于没验（本轮真踩过：D3 注入 0 项红）。
 */
/**
 * 一个依赖的文件数上限。**这不是截断阈值，是报警阈值**。
 *
 * 这里原先写的是「收满 300 条就停」，而那个上限是**静默生效**的：依赖升级到超过 300 个
 * 文件时，fixture 会悄悄少一批文件 —— 少的是入口候选就直接让用例 A 变红（理由看起来
 * 像「校验脚本坏了」），少的是别的文件则更坏：**检查的覆盖面缩水而没有任何信号**。
 * 假 asar 每个文件只占 8 字节，几千个文件也就几十 KB，根本没有省的必要。
 * 所以现在**不截断**；真出现病态依赖（超过这里）时由第 9 节明确报出来，等人看一眼。
 */
const MAX_FILES_PER_DEP = 5000;

function realFiles(dep) {
  const base = path.join(ROOT, 'node_modules', dep);
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); }
      else out.push(path.relative(base, full).replace(/\\/g, '/'));
    }
  })(base);
  return out.sort();
}

/**
 * 用**另一套算法**枚举同一个依赖的真实文件（Node 自带的递归 readdir）。
 *
 * 为什么需要第二套：手写 walk 里有「跳过嵌套 node_modules」「一层层拼相对路径」两个
 * 容易写歪的地方，写歪了 fixture 就悄悄少文件，而上面所有用例照样绿。交叉验证的
 * 判据是「两套独立实现必须给出同一份清单」（本仓第 17 轮在 AUT 的 lockfile 解析上
 * 用过同一手法：状态机 vs 按缩进建树，22 个包 0 差异才敢下结论）。
 */
function realFilesIndependently(dep) {
  const base = path.join(ROOT, 'node_modules', dep);
  return fs.readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(base, path.join(e.parentPath, e.name)).replace(/\\/g, '/'))
    .filter((rel) => !rel.split('/').includes('node_modules'))
    .sort();
}

/** 每个依赖的入口候选（校验脚本用的那个函数，这里只用来挑「哪些文件该拿掉」） */
const ENTRIES = {};
const depFiles = [];
for (const d of DEPS) {
  ENTRIES[d] = entryCandidates(
    JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', d, 'package.json'), 'utf-8')));
  depFiles.push(...realFiles(d).map((rel) => `node_modules/${d}/${rel}`));
}
/** 一个「应有尽有」的包：REQUIRED + 每个生产依赖的真实文件；tray.ico 给足 2000 字节 */
const FULL = [...REQUIRED, ...depFiles];
const BIG = ['src/assets/tray.ico'];

console.log('\n1. 前提：fixture 的输入面本身');
{
  /* 这一节跑在**所有用例之前**，因为后面的 B/C/D 几条直接点名 `ws` / `electron-updater`。
     输入面塌了的时候必须**干净地报出来**，而不是让脚本在更下面某一行抛
     `Cannot read properties of undefined` —— 「崩掉的脚本 = 没有结论的脚本」，
     连前面已经跑过的用例的结论也一起丢了。所以这里是 fail fast：报完就退出。
     （本节的这两条断言是被负向注入逼出来的：把 DEPS 注入成空数组时，
     原先的写法是在第 233 行崩掉、一条失败信息都没有。） */
  ok(DEPS.length >= 2,
    `生产依赖不少于 2 个（现在 ${DEPS.length} 个：${JSON.stringify(DEPS)}）—— 解析面不许为空`, '');
  ok(DEPS.includes('ws'),
    `生产依赖里有 ws（后面对照用例点名用它，现在 ${JSON.stringify(DEPS)}）`, '');
  for (const f of failures) console.log('  - ' + f);
  if (failures.length) {
    console.log('\nfixture 的输入面不成立 —— 后面的用例没有意义，先修上面这几条。');
    process.exit(1);
  }
}

console.log('\n2. 纯函数：清单的算法本身');
eq(bareRequires("const a = require('ws'); const b = require('./local.js');"),
  ['ws'], '裸 require() 只挑第三方模块（相对路径不算）');
eq(bareRequires("require('fs'); require('node:path'); require('electron');"),
  ['electron'], 'Node 内置模块不算（含 node: 前缀写法）');
eq(bareRequires("require('@scope/pkg/sub'); require('ws/lib/x.js');"),
  ['@scope/pkg', 'ws'], '子路径归到顶层包名');
eq(bareRequires('const x = 1;'), [], '没有 require 时返回空（不要凭空造出模块）');
eq(undeclaredRequires(['ws', 'electron'], ['ws']), [],
  '运行时自带的 electron 不算「没声明」');
eq(undeclaredRequires(['ws', 'ghost'], ['ws']), ['ghost'],
  '真的没声明的要点出来');
eq(entryCandidates({ main: './out/main.js' }), ['out/main.js'], 'main 去掉 ./ 前缀');
eq(entryCandidates({ exports: { '.': { require: './index.js', types: './index.d.ts' } } }), ['index.js'],
  'exports 里跳过 types 分支与 .d.ts（类型在不在跟能不能 require 是两件事）');
eq(entryCandidates({ exports: { './package.json': './package.json' } }), [],
  'exports 指向 package.json 不算入口（它几乎总在包里，留着会让判据恒真）');
eq(entryCandidates({}), [], '什么都没声明的包返回空（由调用方判「判据失效」）');
ok(inPackage('node_modules/ws/index.js', 'ws'), 'inPackage 认得出 ws 自己的文件');
ok(!inPackage('node_modules/wsx/index.js', 'ws'), 'inPackage 不把前缀相同的别的包算成 ws');
eq(packedDirPrefixes(['src/**/*', 'dist/**/*', 'package.json']), ['dist', 'src'],
  '从 build.files 现算打包目录：取字面前缀，单个文件的条目跳过');
eq(packedDirPrefixes(['native/**', '!**/*.map']), ['native'],
  '取不到前缀的排除项（`!` 开头）不算扫描面');
eq(packedDirPrefixes([]), [], '空配置算出空（由调用方判「判据失效」，别静默当没事）');
ok(Object.keys(EXCLUDED_PACKED_DIRS).length > 0,
  `排除表里有条目（${Object.keys(EXCLUDED_PACKED_DIRS).join(', ')}）—— 它是空的说明「刻意不扫」的声明没了`);
ok(DEPS.includes('ws'), `package.json 的 dependencies 里有 ws（${DEPS.join(', ')}）`);
ok(ENTRIES.ws && ENTRIES.ws.length > 0, `ws 的入口候选非空（${(ENTRIES.ws || []).join(', ')}）`);

console.log('\n2. A. 齐全的包 → 全绿');
{
  ok(depFiles.length > 8,
    `假 asar 用的是 node_modules 里的真实文件清单（${depFiles.length} 个）`,
    '依赖没装上或目录挪了 —— 那样 A 组会变得什么都验不到');
  const asar = buildAsar('full.asar', FULL, BIG);
  const { code, out } = runCheck(asar);
  ok(code === 0, '退出码 0（守卫不许把正常包判红）', out.split('\n').filter((l) => l.includes('FAIL')).join(' | '));
  for (const d of DEPS) {
    ok(out.includes(`PASS asar 内含完整依赖 ${d}`), `报出依赖 ${d} 的检查项`);
    ok(out.includes(`PASS 依赖 ${d} 的入口文件在包里`), `报出依赖 ${d} 的入口检查项`);
  }
  ok(out.includes('都有归处'), '第 5 节给了结论');
}

console.log('\n3. B. 整个 node_modules/ws/ 不在包里 → 红且点名 ws');
{
  const asar = buildAsar('no-ws.asar', FULL.filter((p) => !p.startsWith('node_modules/ws/')), BIG);
  const { code, out } = runCheck(asar);
  ok(code === 1, '退出码 1');
  ok(out.includes('FAIL asar 内含完整依赖 ws'), '点名了 ws', out.split('\n').filter((l) => l.includes('完整依赖')).join(' | '));
  ok(/node_modules\/ws\/ 都不在包里/.test(out), '说清了「整个包都不在」而不是只报一句失败');
}

console.log('\n4. C. ws 只剩一个 package.json（包被截断）→ 红且说清是截断');
{
  const asar = buildAsar('broken-ws.asar',
    [...FULL.filter((p) => !p.startsWith('node_modules/ws/')), 'node_modules/ws/package.json'], BIG);
  const { code, out } = runCheck(asar);
  ok(code === 1, '退出码 1');
  ok(/被截断/.test(out), '说清了是「文件被截断」而不是「没有」');
}

console.log('\n5. D. 依赖清单在、入口文件却没进包 → 红（旧脚本只认写死的 ws/index.js）');
{
  // ws 的候选入口（${ENTRIES.ws.join(' / ')}）全部拿掉，只留清单与一个无关文件
  const asar = buildAsar('no-entry.asar',
    FULL.filter((p) => !ENTRIES.ws.some((rel) => p === `node_modules/ws/${rel}`)), BIG);
  const { code, out } = runCheck(asar);
  ok(code === 1, '退出码 1');
  ok(out.includes('FAIL asar 内含完整依赖 ws') === false,
    '「整包存在」那条仍然是 PASS（这正是要区分的两种失败）',
    out.split('\n').filter((l) => l.includes('完整依赖')).join(' | '));
  ok(out.includes(`FAIL 依赖 ws 的入口文件在包里`), '点名了入口文件缺失',
    out.split('\n').filter((l) => l.includes('入口文件')).join(' | '));
}

console.log('\n6. E. 源码 require 了没声明的模块 → 红且点名；electron 不算漏');
{
  const srcDir = path.join(TMP, 'src-fake');
  fs.mkdirSync(srcDir, { recursive: true });
  // 造够 5 个文件，免得「扫描面塌了」那条先红（那样就测不到本节真正要测的东西）
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(srcDir, `f${i}.js`), "require('ws');\n");
  fs.writeFileSync(path.join(srcDir, 'f4.js'),
    "const ws = require('ws');\nconst { app } = require('electron');\nconst ghost = require('ghost-lib');\n");
  const pkgPath = path.join(TMP, 'pkg.json');
  fs.writeFileSync(pkgPath, JSON.stringify({ dependencies: { ws: '^8.18.0' } }), 'utf-8');

  const asar = buildAsar('ok-for-e.asar', FULL, BIG);
  const { code, out } = runCheck(asar, ['--src', srcDir, '--pkg', pkgPath]);
  ok(code === 1, '退出码 1');
  ok(out.includes('ghost-lib'), '点名了那个没声明的模块', out.split('\n').filter((l) => l.includes('归处')).join(' | '));
  // 按「漏项清单」比对，不要拿整段输出做负则匹配 —— 措辞里的 `electron-builder`
  // 会让 /electron/ 这种负则永远命中，把正确的实现判红。
  const listed = (out.match(/既不在 dependencies、也不是运行时自带：([^\n—]*)/) || [, ''])[1]
    .split(/[,，\s]+/).filter(Boolean);
  eq(listed, ['ghost-lib'], '点名的漏项恰好只有 ghost-lib（electron 在运行时白名单里）');
  ok(!out.includes('扫描面塌了'), '没把「扫描面」那条一起弄红');
}

console.log('\n7. F. --src-only：不需要 asar，退出码只由第 5 节决定');
{
  const srcDir = path.join(TMP, 'src-ok');
  fs.mkdirSync(srcDir, { recursive: true });
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(srcDir, `g${i}.js`), "require('ws');\nrequire('electron');\n");
  const goodPkg = path.join(TMP, 'good.json');
  fs.writeFileSync(goodPkg, JSON.stringify({ dependencies: { ws: '^8.18.0' } }), 'utf-8');
  const badPkg = path.join(TMP, 'bad.json');
  fs.writeFileSync(badPkg, JSON.stringify({ dependencies: {} }), 'utf-8');

  const a = runCheck(null, ['--src-only', '--src', srcDir, '--pkg', goodPkg]);
  ok(a.code === 0, '干净源码 → 退出码 0（不需要 asar 也敢下结论）',
    a.out.split('\n').filter((l) => l.includes('FAIL')).join(' | '));
  ok(/跳过第 1–4 节/.test(a.out), '明确说了第 1–4 节被跳过，不假装验过');

  const b = runCheck(null, ['--src-only', '--src', srcDir, '--pkg', badPkg]);
  ok(b.code === 1, '源码 require 了没声明的 ws → 退出码 1（dependencies 是空的）');
  ok(b.out.includes('ws'), '点名了 ws');
}

console.log('\n8. G. 扫描面现算：build.files 里新加的打包目录自动进扫描面');
{
  const app = fs.mkdtempSync(path.join(TMP, 'app-'));
  const put = (rel, body = "require('ws');\n") => {
    const p = path.join(app, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  for (let i = 0; i < 6; i++) put(`src/main/f${i}.js`);
  put('src/renderer/js/a.js');
  const pkg = { build: { files: ['src/**/*', 'dist/**/*', 'package.json'] }, dependencies: { ws: '^8' } };

  const before = runtimeSourceFiles(app, pkg);
  eq(before.problems, [], '基准树自洽（problems 空）');
  eq(before.files.length, 6, 'src/main 的 6 个文件在扫描面里，src/renderer 被排除表挡掉');
  eq(before.roots, ['dist（不扫）', 'src（滤掉 1 个）'], '每个打包目录都有交代：产物、被过滤，各有说法');
  eq(before.prefixes, ['dist', 'src'], '打包目录现算自 build.files');

  // 打包配置里新增一个目录 —— 现算的扫描面自动带上它，不需要谁去改清单
  put('native/bridge.js');
  const pkg2 = { ...pkg, build: { files: [...pkg.build.files, 'native/**/*'] } };
  const after = runtimeSourceFiles(app, pkg2);
  eq(after.problems, [], '加了打包目录后仍然自洽');
  ok(after.files.includes('native/bridge.js'), 'build.files 里新加的 native/** 自动进了扫描面');

  // 反向对照：旧的手抄口径（写死 src/main）看不见它 —— 这正是被修掉的洞
  const handCopied = ['src/main'];
  ok(!handCopied.some((d) => 'native/bridge.js'.startsWith(d + '/')),
    '反向对照：旧口径 src/main 下没有 native/bridge.js');

  // 接到底：native/ 里 require 了没声明的模块，第 5 节的判据现在会点名它
  put('native/bridge.js', "require('ws');\nrequire('ghost-lib');\n");
  const bad = runtimeSourceFiles(app, pkg2);
  eq(undeclaredRequires(bareRequires(bad.files.map((rel) => fs.readFileSync(path.join(app, rel), 'utf-8'))),
    productionDeps(pkg2)), ['ghost-lib'],
    '新目录里的裸 require 会被第 5 节点名（旧口径下它连扫都扫不到）');
}

console.log('\n9. H. 扫描面的自证：配置不符 / 排除表腐烂 / 扫描面为空都要自己喊出来');
{
  const app = fs.mkdtempSync(path.join(TMP, 'app2-'));
  const put = (rel, body = "require('ws');\n") => {
    const p = path.join(app, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  put('src/main/f0.js');

  const missingDir = runtimeSourceFiles(app, { build: { files: ['src/**/*', 'ghost/**/*'] } });
  ok(missingDir.problems.some((p) => /ghost\//.test(p)),
    'build.files 声明了不存在的打包目录 → 点名它',
    JSON.stringify(missingDir.problems));

  const noPrefix = runtimeSourceFiles(app, { build: { files: ['package.json'] } });
  ok(noPrefix.problems.some((p) => /没算出任何打包目录/.test(p)),
    'build.files 里一条目录都算不出来 → 明说判据失效',
    JSON.stringify(noPrefix.problems));

  const rotten = runtimeSourceFiles(app, { build: { files: ['src/**/*'] } },
    { excluded: { 'src/nowhere': '目录并不存在' } });
  ok(rotten.problems.some((p) => /src\/nowhere/.test(p) && /清单腐烂/.test(p)),
    '排除表指向一个不存在的目录 → 报「清单腐烂」',
    JSON.stringify(rotten.problems));

  // 目录在、但下面一个源码文件都没有 —— 这条排除已经挡不住东西了
  fs.mkdirSync(path.join(app, 'src/empty'), { recursive: true });
  const emptyExcl = runtimeSourceFiles(app, { build: { files: ['src/**/*'] } },
    { excluded: { 'src/empty': '存在但没有源码' } });
  ok(emptyExcl.problems.some((p) => /没有源码了/.test(p)),
    '排除表条目下面没有源码 → 报「这条排除已经没用了」',
    JSON.stringify(emptyExcl.problems));

  // 被当成源码扫的目录里一个源码都没有（目录在，但里面是空的）
  fs.mkdirSync(path.join(app, 'empty'), { recursive: true });
  const noFiles = runtimeSourceFiles(app, { build: { files: ['empty/**/*'] } });
  ok(noFiles.problems.some((p) => /一个源码文件都没有/.test(p)),
    '被当成源码扫的目录里没有任何源码 → 报「判据在这里是空跑的」',
    JSON.stringify(noFiles.problems));
}

console.log('\n10. I. fixture 的完整性：独立枚举交叉验证，且截断要自己喊出来');
{
  /* 这一节盯的是**测试自己的前提**：上面 A~H 全部拿 `FULL`（合成的假包清单）当输入，
     而 `FULL` 来自 `realFiles()`。`realFiles()` 少收文件时，所有用例照样绿 ——
     检查的覆盖面悄悄缩水，没有任何信号。这正是本仓反复踩的「覆盖面靠人记得」形状，
     只不过这次「人」是 fixture 自身。
     两道判据：① 两套独立算法枚举同一份真实目录，清单必须完全一致；
               ② 文件数触及报警阈值要报出来（不截断，只喊）。 */
  const counts = {};
  for (const d of DEPS) {
    const manual = realFiles(d);
    const independent = realFilesIndependently(d);
    counts[d] = manual.length;
    ok(manual.length > 0,
      `${d}：fixture 非空（0 个文件的话上面 A~E 全是空跑）`, '');
    eq(manual, independent, `${d}：手写 walk 与递归 readdir 枚举出的文件清单一致`);
    ok(manual.length < MAX_FILES_PER_DEP,
      `${d}：文件数 ${manual.length} 在报警阈值 ${MAX_FILES_PER_DEP} 之内（超了就说明假 asar 规模失控，需要人过一眼）`,
      '');
  }
  console.log('     fixture 文件数：' + JSON.stringify(counts));

  /* fixture 里必须真的收进了每个依赖**磁盘上存在的**入口候选 —— 否则第 5 节那条
     「依赖清单在、入口文件却没进包」验的是别的东西 */
  for (const d of DEPS) {
    const have = realFiles(d);
    const missing = ENTRIES[d].filter(
      (c) => fs.existsSync(path.join(ROOT, 'node_modules', d, c)) && !have.includes(c));
    eq(missing, [], `${d}：磁盘上存在的入口候选都收进了 fixture`);
  }

  /* FULL 是假的包清单，但它的每一项都该指向一个真文件或真目录 —— 掺进不存在的路径
     会让「齐全 → 全绿」这条用例失去意义 */
  /* ⚠ 这条断言第一版写的是 `[...REQUIRED, ...depFiles]` 而不是 `FULL` —— 于是它证的是
     「两个来源拼起来没有幽灵路径」，**而判据真正用的那个变量（FULL）一条都没被查过**：
     往 FULL 里掺一条不存在的路径，它照样绿（本轮负向验证 X3 实测抓到）。 */
  /*
   * ⚠ 第二版（`FULL` 每一项都必须在磁盘上存在）把一个**隐含前提**当成了判据：
   *   `REQUIRED` 里那两条 `dist/*.html` 是构建产物，本地构建过就有、干净检出必然没有。
   *   于是这条断言量的是「这台机器构建过没有」，不是「仓库能不能产出它」——
   *   2026-09-18 的 v1.12.0 / v1.13.0 因此连着两次发不出安装包（CI 第 5 步跑测试，
   *   第 6 步才 `npm run build:renderer`，见 `.github/workflows/release.yml`）。
   *   本机复现方式：把 dist/ 改个名再跑，报的就是 CI 里那句一样的话。
   *
   * 现在按**来源**把 FULL 分成三类，各问各该问的：
   *   ① 仓库自有文件（`src/**`、`package.json` …）→ 必须存在；
   *   ② 第三方依赖文件（`node_modules/**`）→ 必须存在（`npm ci` 之后一定有，不然测试根本跑不起来）；
   *   ③ 构建产物（`dist/**`、`dist-app/**`）→ **不要求此刻存在**，但必须真会被产出：
   *      本源必须列在 `vite.config.mjs` 的 `rollupOptions.input` 里、且本源文件真的在仓库里。
   *      产物面现算自 `rendererBuildProducts()`，解析不出来就自己喊（不许在空集上通过）。
   *   外加两份独立声明对账：`ARTIFACT_DIRS` / `DEP_DIRS`（清单里写的「不存在也不算异常」的目录）
   *   ⇄ `.gitignore`（仓库自己声明的忽略面）。对不上就说明口径出现了第二份。
   */
  const firstSeg = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').split('/')[0];
  const gitignoreTopDirs = (() => {
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    return new Set(
      gi.split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
        .map((l) => l.replace(/^\//, '').replace(/\/+$/, ''))
        // 只留「顶层目录」这种字面规则：带通配符 / 带子路径的另算，别在这里硬凑
        .filter((l) => !/[*?[\]]/.test(l) && !l.includes('/'))
    );
  })();

  // ③ 先对账：口径必须只有一份
  ok(gitignoreTopDirs.size > 0, '.gitignore 里解析出了顶层忽略目录', '解析面为空的话下面两条在空集上通过');
  const notIgnored = [...DEP_DIRS, ...ARTIFACT_DIRS].filter((d) => !gitignoreTopDirs.has(d));
  eq(notIgnored, [], 'DEP_DIRS / ARTIFACT_DIRS 里的每个目录都被 .gitignore 忽略（否则它其实该存在，判据就错了）');
  const ignoredButNotArtifact = FULL.filter(
    (p) => gitignoreTopDirs.has(firstSeg(p)) && !isArtifactPath(p) && !isDepPath(p));
  eq(ignoredButNotArtifact, [],
    'FULL 里凡落在忽略目录下的项，都必须被归成「产物」或「依赖」（否则又会出现「要求一个干净检出上不存在的东西」）');

  // ①② 会存在的那两类：仓库自有文件与依赖文件
  const repoFiles = FULL.filter((p) => !isArtifactPath(p) && !isDepPath(p));
  const depFiles2 = FULL.filter((p) => isDepPath(p));
  const artifactFiles = FULL.filter((p) => isArtifactPath(p));
  ok(repoFiles.length > 0, `FULL 里有 ${repoFiles.length} 项是本仓库的文件`, '一项都没有说明分类塌了');
  ok(depFiles2.length > 0, `FULL 里有 ${depFiles2.length} 项来自 dependencies`, '一项都没有说明分类塌了');
  ok(artifactFiles.length > 0, `FULL 里有 ${artifactFiles.length} 项是构建产物`, '一项都没有说明分类塌了');
  const ghost = [...repoFiles, ...depFiles2].filter((p) => !fs.existsSync(path.join(ROOT, p)));
  eq(ghost, [], 'FULL 里「应当存在」的每一项（仓库文件 + 依赖）都真的在磁盘上');

  // ② 产物项：不要求此刻存在，但必须真会被构建出来
  const build = rendererBuildProducts(ROOT);
  eq(build.problems, [], '渲染层产物面算得出来（vite.config.mjs 解析得出 outDir 与 .html 入口，且本源文件都在）');
  ok(build.products.length > 0, `渲染层会产出 ${build.products.length} 个文件`, '空集上下面的断言会假绿');
  const unknownProducts = artifactFiles.filter((p) => !build.products.includes(p));
  eq(unknownProducts, [],
    'FULL 里的产物项都在「渲染层真会产出」的清单里（写一个 vite 不会产出的 dist/xxx.html 会被抓）');
  // 反向：vite 声明会产出的，清单里也应该有 —— 漏一个就是「装完之后才发现界面没了」
  const unlisted = build.products.filter((p) => !artifactFiles.includes(p));
  eq(unlisted, [], '渲染层会产出的每个文件都登记进了打包清单（漏登记等于打包时不保证它在）');
}

// 收尾
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* 临时目录清不掉不影响结论 */
}
console.log('\n' + '='.repeat(46));
if (failures.length) {
  console.log(`${failures.length} 项失败：`);
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log(`${pass} 项全部通过。`);
