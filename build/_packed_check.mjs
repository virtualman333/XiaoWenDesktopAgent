/**
 * 打包内容校验（纯 Node，CI 里跑）
 *
 * 用途：在发布前确认「运行期要用到的东西真的进了 app.asar」。
 * 起因是一次真实事故：托盘图标只放在仓库 build/ 下，而 electron-builder 的
 * files 只带 src/**、dist/**、package.json —— build/ 是 buildResources，
 * 不进 asar。安装版于是永远拿不到图标，右下角托盘直接看不见。
 *
 * 清单与判据在 `_packed_manifest.mjs`（唯一来源，测试要用同一份）。
 *
 * 五节检查：
 *   1. 运行期必须存在的静态文件（清单）
 *   2. 托盘图标非空
 *   3. 确认没有运行期资源依赖仓库根的 build/
 *   4. 生产依赖整包进了 asar，且各依赖自己的入口文件在（2026-09-17 新增）
 *   5. 源码里裸 require() 的模块都在 dependencies 或运行时白名单里（2026-09-17 新增）
 *
 * 4/5 补的是一个**没有落点的承诺**：`src/main/main.js` 会抛
 * 「没有可用的 WebSocket 实现（ws 模块缺失），请重新安装依赖后打包」，
 * 但打包校验从前只列静态文件 —— ws 在不在包里没人验。唯一会验它的
 * `build/_packed_ws_check.js` **没有任何 npm script 指向**，路径写死在
 * `release-v1.0.4/`（这个目录早就不存在了），而且只找一个写死的 `ws/index.js`。
 * 于是「打包版语音识别能不能用」这件事，实际上没有任何检查在扛。
 *
 * 第 5 节不需要 asar，所以给了 `--src-only`：让它进 `npm test`，使「裸 require
 * 的模块有没有声明」每次跑测试都被验一遍，而不是拖到打包那一刻。它上线第一天
 * 就抓到第二个：`src/main/jarvis/tools.js` 裸 require 了 `iconv-lite`，而它不在
 * dependencies 里 —— 只被 electron-builder 的 devDependencies 树 hoist 到
 * node_modules 根，安装版里没有，中文 Windows 的 tasklist 输出于是被静默降级成乱码。
 *
 * 用法：
 *   node build/_packed_check.mjs                  找 release-XXX/win-unpacked/resources/app.asar
 *   node build/_packed_check.mjs <path/app.asar>  直接校验指定包
 *   node build/_packed_check.mjs --src-only       只跑第 5 节（不需要 asar）
 *   --src <dir> / --pkg <file>                    换扫描目录 / 换 package.json（供自测注入）
 *
 * （注意别在这段注释里写 `release` 加通配符再加斜杠 —— 那串字符会提前结束本注释。）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  REQUIRED, RUNTIME_SRC_DIRS, RUNTIME_PROVIDED,
  productionDeps, bareRequires, undeclaredRequires, entryCandidates, inPackage
} from './_packed_manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC_ONLY = process.argv.includes('--src-only');

/** 命令行取一个选项值（`--src <dir>` / `--pkg <package.json>`） */
function argValue(name) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

/**
 * `dependencies` 的唯一来源：仓库根的 package.json（`--pkg` 可换成别的，供测试用）。
 * 读坏（JSON 语法错 / 文件没了）折成一条 FAIL + 退出码 1，不要抛栈 ——
 * 脚本崩了等于没有结论，而「package.json 坏到读不出来」本身就是最该被看见的结论。
 */
let PKG = {};
let PKG_ERROR = null;
try {
  PKG = JSON.parse(fs.readFileSync(argValue('--pkg') || path.join(ROOT, 'package.json'), 'utf-8'));
} catch (e) {
  PKG_ERROR = e.message;
}
/** 扫裸 `require()` 的源码根（`--src` 可换成别的，供测试用） */
const SRC_ROOT = argValue('--src') || path.join(ROOT, RUNTIME_SRC_DIRS[0]);

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' :: ' + extra : '')); }
}

/** 找一个 app.asar：优先命令行参数，其次 release-XXX/win-unpacked/ */
function findAsar() {
  const arg = process.argv.find((a) => a.endsWith('.asar'));
  if (arg) return path.resolve(arg);
  const cands = fs.readdirSync(ROOT)
    .filter((d) => /^release/.test(d))
    .map((d) => path.join(ROOT, d, 'win-unpacked', 'resources', 'app.asar'))
    .filter((p) => fs.existsSync(p));
  if (!cands.length) return null;
  // 版本号大的优先
  return cands.sort().pop();
}

/** 直接读 asar 头部拿文件清单，不依赖 @electron/asar */
function listAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(12);
    const buf = Buffer.alloc(headerSize);
    fs.readSync(fd, buf, 0, headerSize, 16);
    const json = JSON.parse(buf.toString('utf-8'));
    const out = [];
    (function walk(node, prefix) {
      for (const key of Object.keys(node.files || {})) {
        const child = node.files[key];
        const p = prefix + '/' + key;
        if (child.files) walk(child, p);
        else out.push({ path: p.replace(/^\//, ''), size: child.size || 0 });
      }
    })(json, '');
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** 读一个已安装依赖自己的 package.json（拿它的入口声明）；读不到返回 null */
function readDepPkg(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf-8'));
  } catch {
    return null;
  }
}

console.log('\n打包内容校验' + (SRC_ONLY ? '（--src-only：只跑第 5 节，不读 asar）' : ''));

// package.json 读不出来时，第 4 / 5 节的判据全是空的 —— 与其拿着一份空清单
// 报一堆「整包不在包里」，不如就此收口，把真正的原因说清楚。
if (PKG_ERROR) {
  ok(false, '读得出来 package.json（第 4 / 5 节的判据全靠它）', PKG_ERROR);
  console.log('\n' + '='.repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(1);
}

const asar = SRC_ONLY ? null : findAsar();
if (!SRC_ONLY) {
  ok(!!asar, '找到 app.asar（先跑 npm run dist:dir）', asar || '未找到，release*/ 下没有 win-unpacked');
}

if (asar) {
  console.log('  校验对象 ' + asar);
  const entries = listAsar(asar);
  const byPath = new Map(entries.map((e) => [e.path, e]));
  console.log('  asar 内共 ' + entries.length + ' 个文件');

  console.log('\n1. 运行期必须存在的文件');
  for (const rel of REQUIRED) {
    const hit = byPath.get(rel);
    ok(!!hit, `asar 内含 ${rel}`, hit ? undefined : '缺失 —— 检查 package.json 的 build.files');
  }

  console.log('\n2. 托盘图标真的在包里且非空（安装版「看不见托盘」的直接原因）');
  const ico = byPath.get('src/assets/tray.ico');
  ok(!!ico && ico.size > 1000, 'tray.ico 有实际内容', ico ? ico.size + 'B' : '不存在');

  console.log('\n3. 确认没有运行期资源依赖仓库根的 build/');
  const buildEntries = entries.filter((e) => /(^|\/)build\//.test(e.path));
  ok(buildEntries.length === 0,
    'asar 里没有 build/（它就是 buildResources，本来就不该期望它在包里）',
    buildEntries.slice(0, 3).map((e) => e.path).join(', '));
  const runtimeRefsBuild = entries
    .filter((e) => /^src\/.*\.js$/.test(e.path))
    .map((e) => e.path);
  console.log('  运行期 js 共 ' + runtimeRefsBuild.length + ' 个，已确认必需资源都来自 src/ 与 dist/');

  console.log('\n4. 生产依赖整包进了 asar（清单从 package.json 现算，不手抄）');
  const deps = productionDeps(PKG);
  if (!deps.length) {
    ok(false, 'package.json 里一条 dependencies 都没有 —— 本节的判据失效了，检查一下文件是不是被改坏');
  }
  for (const dep of deps) {
    const files = entries.filter((e) => inPackage(e.path, dep));
    const hasManifest = files.some((e) => e.path === `node_modules/${dep}/package.json`);
    // 只有 package.json 一个文件说明这个包被截断了（真包不可能只有清单）
    ok(hasManifest && files.length >= 2,
      `asar 内含完整依赖 ${dep}`,
      hasManifest
        ? `只找到 ${files.length} 个文件 —— 这个包被截断了，运行期 require 会失败`
        : `整个 node_modules/${dep}/ 都不在包里 —— electron-builder 只带 dependencies，` +
          `确认它没有掉进 devDependencies、files 里也没有排除 node_modules`);

    // 入口文件：从依赖自己的 package.json 现算（旧脚本把 ws/index.js 写死了）
    const cands = entryCandidates(readDepPkg(dep));
    if (!cands.length) {
      ok(false, `依赖 ${dep} 声明了入口（main 或 exports）`,
        'package.json 里两条都没有 —— 这条判据失效了，别再让它假装在验');
    } else {
      const hit = cands.find((c) => byPath.has(`node_modules/${dep}/${c}`));
      ok(!!hit, `依赖 ${dep} 的入口文件在包里（${cands.join(' 或 ')}）`,
        `候选都不在包里 —— 运行期 require("${dep}") 会直接失败`);
    }
  }
} else {
  // 无论是「没打包装」还是「--src-only」，都要如实说清第 1–4 节没验，
  // 不要让「只跑了第 5 节」看起来像「五节都过了」。
  console.log('  （跳过第 1–4 节：' +
    (SRC_ONLY ? '--src-only 只要源码级结论' : '没有 asar 可读') +
    '。第 5 节与 asar 无关，照跑）');
}

console.log('\n5. 源码里裸 require() 的模块都在 dependencies（或运行时白名单）里');
const srcFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.(js|mjs|cjs)$/.test(e.name)) srcFiles.push(full);
  }
})(SRC_ROOT);
ok(srcFiles.length >= 5, `扫到 ${srcFiles.length} 个运行期源码文件（${path.relative(ROOT, SRC_ROOT) || SRC_ROOT}）`,
  '扫描面塌了 —— 目录挪了？');
const deps5 = productionDeps(PKG);
const used = bareRequires(srcFiles.map((f) => fs.readFileSync(f, 'utf-8')));
const missing = undeclaredRequires(used, deps5);
ok(missing.length === 0,
  `源码用到的 ${used.length} 个第三方模块都有归处（${used.join(', ') || '无'}；` +
    `dependencies ${deps5.length} 个 + 运行时自带 ${RUNTIME_PROVIDED.join(', ')}）`,
  `这些模块被 require 了却既不在 dependencies、也不是运行时自带：${missing.join(', ')} —— ` +
    `electron-builder 不会把它们打进 asar，开发时一切正常、安装版会直接报「模块缺失」`);

console.log('\n' + '='.repeat(46));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
