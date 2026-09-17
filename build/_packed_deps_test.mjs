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
 *
 * 用法：npm run test:packed-deps
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

import {
  REQUIRED, productionDeps, bareRequires, undeclaredRequires, entryCandidates, inPackage
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
function realFiles(dep) {
  const base = path.join(ROOT, 'node_modules', dep);
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= 300) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); }
      else out.push(path.relative(base, full).replace(/\\/g, '/'));
    }
  })(base);
  return out.sort();
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

console.log('\n1. 纯函数：清单的算法本身');
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
