/**
 * 打包校验的清单与判据（**唯一来源**）
 *
 * 从 `_packed_check.mjs` 里抽出来，是为了让「打包校验」这件事本身可被测试：
 * `_packed_deps_test.mjs` 要拿同一份清单去合成一个假 asar，从而在**不跑
 * electron-builder**（一次几分钟、几百 MB）的前提下验证校验脚本对缺件会红、对齐全的会绿。
 * 清单要是抄第二份，测试就会拿一份已经漂移的期望去测另一份实现 —— 本仓的老毛病。
 */
import { builtinModules } from 'module';

/** 必须出现在 asar 里的运行期资源（相对 app 根目录） */
export const REQUIRED = [
  'src/main/main.js',
  'src/main/preload.js',
  'src/main/tray-icon.js',
  'src/main/meeting.js',
  // 桌面入口分工规则（main.js require 它算「球该不该显示」）
  'src/main/entry.js',
  'src/main/jarvis/meeting-detect.js',
  'src/main/jarvis/minutes.js',
  'src/assets/tray.ico',
  'src/assets/tray.png',
  'dist/panel.html',
  // 会议记录的隐藏采集页：新加的窗口页面，漏打包就会「检测到会议但录不了」
  'dist/minutes.html',
  'package.json'
];

/** 扫裸 `require()` 时看的源码目录（运行期主进程代码） */
export const RUNTIME_SRC_DIRS = ['src/main'];

/**
 * 从 `package.json` 现算「生产依赖」。
 * 只认 `dependencies`：electron-builder 只会把 `dependencies` 打进 asar，
 * `devDependencies` 一律不进（这也是「把 ws 挪到 devDependencies」这种改动
 * 会在打包版上静默失效的原因）。
 */
export function productionDeps(pkg) {
  return Object.keys((pkg && pkg.dependencies) || {}).sort();
}

/**
 * Electron **运行时自带**的模块：源码里 require 得到，但**不该**出现在 dependencies 里。
 *
 * `require('electron')` 在打包版里由 exe 自身提供；真把它写进 dependencies 反而会
 * 让 electron-builder 再去下载一份完整运行时。所以第 5 节的判据是
 * 「在 dependencies 里 **或者** 在 RUNTIME_PROVIDED 里」，两者都在才算漏。
 */
export const RUNTIME_PROVIDED = ['electron'];

const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/**
 * 从一段（或一组合并的）源码里挑出**裸模块** `require('xxx')`。
 *
 * 只关心「名字」，不解析 AST：运行期代码里 `require` 的写法很固定，
 * 而这条判据要抓的是「名字在不在 dependencies 里」，不是语法树。
 * 相对路径（`./x`、`../x`）、绝对路径、Node 内置模块（`fs`、`node:path`）一律排除 ——
 * 它们不来自 node_modules，不需要出现在 dependencies 里。
 */
export function bareRequires(sources) {
  const text = Array.isArray(sources) ? sources.join('\n') : String(sources || '');
  const out = new Set();
  let m;
  REQUIRE_RE.lastIndex = 0;
  while ((m = REQUIRE_RE.exec(text)) !== null) {
    const name = m[1];
    if (!name || name.startsWith('.') || name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) continue;
    if (BUILTINS.has(name)) continue;
    // 子路径形式的依赖（`ws/lib/x`）归到顶层包名
    out.add(name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]);
  }
  return [...out].sort();
}

/** 一条 asar 内的条目是否属于某个包（`node_modules/<name>/...`） */
export function inPackage(entryPath, name) {
  return entryPath.replace(/\\/g, '/').startsWith(`node_modules/${name}/`);
}

/**
 * 源码用到、但**既没声明在 dependencies 里、也不是运行时自带**的模块。
 *
 * 判定收敛在这里：检查脚本（第 5 节）与它的自测都调这一个函数，
 * 免得「哪些算漏」这件事出现第二份写法。
 */
export function undeclaredRequires(used, deps) {
  const known = new Set([...deps, ...RUNTIME_PROVIDED]);
  return used.filter((name) => !known.has(name));
}

/**
 * 一个依赖的**入口文件候选**（asar 内的相对路径），从依赖自己的 package.json 现算。
 *
 * 起因：旧脚本 `build/_packed_ws_check.js` 只找写死的 `node_modules/ws/index.js` ——
 * ws 恰好 main 就是 index.js 才蒙对，换成 electron-updater（main = out/main.js）就完全失效。
 *
 * 刻意排除两类：`package.json`（它是清单不是入口，且几乎总在包里，留着会让这条判据恒真）
 * 与 `.d.ts`（类型声明存在与否跟运行期能不能 require 是两件事）。
 */
export function entryCandidates(depPkg) {
  const out = new Set();
  const add = (v) => {
    if (typeof v !== 'string') return;
    const rel = v.trim().replace(/^\.\//, '').replace(/\\/g, '/');
    if (!rel || rel.endsWith('package.json') || rel.endsWith('.d.ts')) return;
    out.add(rel);
  };
  const walk = (v, key) => {
    if (typeof v === 'string') { if (key !== 'types' && key !== 'typings') add(v); return; }
    if (v && typeof v === 'object') Object.keys(v).forEach((k) => walk(v[k], k));
  };
  if (depPkg) { walk(depPkg.exports, 'exports'); add(depPkg.main); }
  return [...out].sort();
}
