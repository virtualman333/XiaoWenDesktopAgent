/**
 * 打包校验的清单与判据（**唯一来源**）
 *
 * 从 `_packed_check.mjs` 里抽出来，是为了让「打包校验」这件事本身可被测试：
 * `_packed_deps_test.mjs` 要拿同一份清单去合成一个假 asar，从而在**不跑
 * electron-builder**（一次几分钟、几百 MB）的前提下验证校验脚本对缺件会红、对齐全的会绿。
 * 清单要是抄第二份，测试就会拿一份已经漂移的期望去测另一份实现 —— 本仓的老毛病。
 */
import fs from 'fs';
import path from 'path';
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

/**
 * 运行期源码的**扫描面** —— 现算，不手抄。
 *
 * 这里原来是 `export const RUNTIME_SRC_DIRS = ['src/main']`，两个毛病：
 *
 *  1. **手抄的清单**：新加一个运行期目录（`src/worker/` 之类）不会被扫，于是
 *     「裸 require 的模块有没有声明」这件事对它静默失效 —— `iconv-lite` 那次
 *     只是恰好落在 `src/main/jarvis/` 里才被抓到。「扫描面写死目录清单」这个
 *     形状在本仓是第二次（另一处见 `_packed_check.mjs` 第 5 节的扫描面），
 *     在兄弟仓库还有第三处。
 *  2. **那个数组本身是假的**：`_packed_check.mjs` 只用了 `RUNTIME_SRC_DIRS[0]`，
 *     有人往数组里加第二个目录**既不报错也不生效**，只会以为自己加上了。
 *
 * 现在扫描面从 `package.json` 的 `build.files` **现算**：那份配置本来就是
 * 「什么会被打进 asar」的唯一来源，往它上面加一个目录就自动进扫描面。
 * 剩下两类取舍必须显式写出来：产物目录（`ARTIFACT_DIRS`）与刻意不扫的目录
 * （`EXCLUDED_PACKED_DIRS`）—— 后者的每一条都得真的挡住东西，否则被 `problems` 点名。
 */

/** 运行期源码的后缀 */
const RUNTIME_EXTS = /\.(js|mjs|cjs)$/;

/**
 * 构建 / 安装产物：**定义性排除**，不存在也不算异常 ——
 * `dist/` 是 .gitignore 里的构建产物，新克隆的本机根本没有它。
 */
const ARTIFACT_DIRS = new Set(['node_modules', 'dist', 'dist-app']);

/**
 * 刻意不扫的**打包内源码**目录 —— 默认是扫，这里是例外。
 *
 * 键是相对 app 根的路径；每一条都必须真的挡住源码，否则进 `problems`（清单腐烂）。
 * 这里**不做计数棘轮**：这些目录的成员数随开发节奏变（渲染层加一个模块就变），
 * 棘轮只会天天报假警；真正要钉的是「每一个被打包的目录都得有交代」，
 * 那条由 `runtimeSourceFiles()` 自己算。
 */
export const EXCLUDED_PACKED_DIRS = {
  'src/renderer':
    '渲染层是 vite 的**输入**：它以 dist/assets/*.js 的形式从 asar 加载，' +
    '不从 src/renderer/js 按源码 require —— 那里的模块由打包器解析，不属于「裸 require」扫描面',
};

/**
 * 从 `build.files` 现算「会进 asar 的目录前缀」。
 *
 * 只取每条 glob 的**字面前缀**（`src/**\/*` → `src`）；不含通配符的条目是单个文件
 * （`package.json`），跳过。取不出前缀的条目（如 `!**\/*.map`）也跳过 ——
 * 它描述的是排除，不是扫描面。
 */
export function packedDirPrefixes(buildFiles) {
  const out = new Set();
  for (const raw of buildFiles || []) {
    const s = String(raw).replace(/\\/g, '/').replace(/^\.\//, '');
    if (s.startsWith('!')) continue;
    const globAt = s.search(/[*?[{]/);
    if (globAt === -1) continue; // 单个文件，不是目录
    const dir = s.slice(0, globAt).replace(/\/+$/, '');
    if (dir) out.add(dir);
  }
  return [...out].sort();
}

/**
 * 收一个目录下的运行期源码（绝对路径）；产物目录直接跳过。
 * 抽出来是因为 `--src <dir>` 那条临时通道也要用**同一份**遍历口径，
 * 不能让它自己再写一遍（写两遍必然有一天不一样）。
 */
export function collectRuntimeFiles(absDir) {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (ARTIFACT_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name));
      } else if (RUNTIME_EXTS.test(e.name)) {
        out.push(path.join(dir, e.name));
      }
    }
  })(absDir);
  return out.sort();
}

/**
 * 现算第 5 节要扫的运行期源码：`build.files` 覆盖的目录里的全部 `.js/.mjs/.cjs`，
 * 减去产物目录与排除表。
 *
 * 返回 `problems` 供调用方一条 `ok()` 报出去：空数组才是可以下结论的状态。
 * `opts.excluded` 只为让失败分支能被测到（见 `_packed_deps_test.mjs` 第 8/9 节）。
 */
export function runtimeSourceFiles(root, pkg, opts = {}) {
  const excludedTable = opts.excluded || EXCLUDED_PACKED_DIRS;
  const prefixes = packedDirPrefixes(pkg && pkg.build && pkg.build.files);
  const problems = [];
  const files = [];
  const roots = [];
  const excludedKeys = Object.keys(excludedTable);
  const under = (rel, dir) => rel === dir || rel.startsWith(`${dir}/`);

  if (!prefixes.length) {
    problems.push(
      'build.files 里没算出任何打包目录 —— 打包配置改过？第 5 节的扫描面会变成空的'
    );
    return { files, roots, problems, prefixes, scanned: [] };
  }

  // ① 每个被打包的目录都必须有交代：进扫描面 / 是产物 / 被排除。
  //    少一条（比如 build.files 里加了 `native/**/*`）这里就会说话。
  for (const prefix of prefixes) {
    if (ARTIFACT_DIRS.has(prefix) || excludedKeys.some((d) => under(prefix, d))) {
      roots.push(`${prefix}（不扫）`);
      continue;
    }
    const abs = path.join(root, prefix);
    if (!fs.existsSync(abs)) {
      problems.push(`build.files 声明了 ${prefix}/，但磁盘上没有这个目录 —— 配置与实际不符`);
      continue;
    }
    const inside = collectRuntimeFiles(abs).map((f) => path.relative(root, f).replace(/\\/g, '/'));
    if (!inside.length) {
      problems.push(`${prefix}/ 被当成运行期源码扫，但一个源码文件都没有 —— 判据在这里是空跑的`);
      continue;
    }
    // 排除表按**文件路径**再过一道：`src` 的扫描面里要滤掉 `src/renderer/**`
    const kept = inside.filter((rel) => !excludedKeys.some((d) => under(rel, d)));
    files.push(...kept);
    roots.push(kept.length === inside.length ? prefix : `${prefix}（滤掉 ${inside.length - kept.length} 个）`);
  }

  // ② 排除表里的每一条都必须真的挡住东西（少一条多一条都要显式来改）
  for (const dir of excludedKeys) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) {
      problems.push(`EXCLUDED_PACKED_DIRS 里的 "${dir}/" 不存在 —— 清单腐烂，请删掉这一条`);
      continue;
    }
    if (collectRuntimeFiles(abs).length === 0) {
      problems.push(`EXCLUDED_PACKED_DIRS 里的 "${dir}/" 下面没有源码了 —— 这条排除已经没用了`);
    }
  }

  // ③ 扫描面不许为空
  if (!files.length) {
    problems.push('运行期源码扫出来是空的 —— 「裸 require 的模块都有归处」会变成一句空话');
  }

  return { files: files.sort(), roots, problems, prefixes, scanned: files };
}

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
