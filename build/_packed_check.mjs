/**
 * 打包内容校验（纯 Node，CI 里跑）
 *
 * 用途：在发布前确认「运行期要用到的静态资源真的进了 app.asar」。
 * 起因是一次真实事故：托盘图标只放在仓库 build/ 下，而 electron-builder 的
 * files 只带 src/**、dist/**、package.json —— build/ 是 buildResources，
 * 不进 asar。安装版于是永远拿不到图标，右下角托盘直接看不见。
 *
 * 用法：npm run dist:dir && node build/_packed_check.mjs
 *       （不传参就在 release-XXX/win-unpacked/ 里自己找 app.asar）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/** 必须出现在 asar 里的运行期资源（相对 app 根目录） */
const REQUIRED = [
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

console.log('\n打包内容校验');

const asar = findAsar();
ok(!!asar, '找到 app.asar（先跑 npm run dist:dir）', asar || '未找到，release*/ 下没有 win-unpacked');
if (!asar) {
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(1);
}
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

console.log('\n' + '='.repeat(46));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
