/**
 * 托盘图标回归测试（纯 Node，不需要 Electron）
 *
 * 背景：安装版「右下角托盘图标不显示」。两个叠加的坑：
 *   1) 图标只放在仓库 build/ 下，而 electron-builder 的 files 不含 build/，
 *      打包后图标不存在 → 走兜底；
 *   2) 兜底的内联 base64 是一张**截断的 PNG** → nativeImage 解出 0x0 空图
 *      → new Tray(空图) 不报错，但托盘上什么都看不见（纯静默失败）。
 * 所以这里把「图标资源真的存在 + 真的会随包发布 + 兜底 base64 真的能解码」
 * 全部钉成断言。
 *
 * 运行：npm run test:tray
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' :: ' + extra : '')); }
}

// ---------- 小工具：PNG 深度校验 ----------
/** 解析 PNG，返回 {ok, width, height, hasIEND, idat, error} */
function parsePng(buf) {
  const out = { ok: false, width: 0, height: 0, hasIEND: false, idat: Buffer.alloc(0), error: '' };
  if (!buf || buf.length < 16) { out.error = 'too short'; return out; }
  if (buf.slice(0, 8).toString('binary') !== '\x89PNG\r\n\x1a\n') { out.error = 'bad signature'; return out; }
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.slice(i + 4, i + 8).toString('latin1');
    const data = buf.slice(i + 8, i + 8 + len);
    if (data.length !== len) { out.error = `chunk ${type} truncated`; return out; }
    if (type === 'IHDR') {
      out.width = data.readUInt32BE(0);
      out.height = data.readUInt32BE(4);
    } else if (type === 'IDAT') {
      out.idat = Buffer.concat([out.idat, data]);
    } else if (type === 'IEND') {
      out.hasIEND = true;
    }
    i += 12 + len;
  }
  if (!out.hasIEND) { out.error = 'no IEND (文件被截断)'; return out; }
  if (i !== buf.length) { out.error = `尾部有多余 ${buf.length - i} 字节`; return out; }
  out.ok = true;
  return out;
}

/** 解压 IDAT 并统计有多少像素是不透明的 —— 全透明的图同样"看不见" */
function alphaStats(png) {
  const stride = png.width * 4 + 1;
  const raw = zlib.inflateSync(png.idat);
  if (raw.length !== stride * png.height) {
    return { error: `解压后 ${raw.length} 字节，期望 ${stride * png.height}` };
  }
  let opaque = 0;
  for (let y = 0; y < png.height; y++) {
    const row = raw.slice(y * stride + 1, (y + 1) * stride);
    for (let x = 0; x < png.width; x++) {
      if (row[x * 4 + 3] > 8) opaque++;
    }
  }
  return { opaque, total: png.width * png.height };
}

/** 解析 ICO，返回各档 {size, png} */
function parseIco(buf) {
  if (buf.length < 6) return [];
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return [];
  const count = buf.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    if (o + 16 > buf.length) break;
    const w = buf[o] || 256;
    const size = buf.readUInt32LE(o + 8);
    const offset = buf.readUInt32LE(o + 12);
    out.push({ size: w, png: buf.slice(offset, offset + size) });
  }
  return out;
}

/** 极简 glob：只支持 ** 与 *，够用来校验 files 规则是否覆盖资源 */
function globMatches(pattern, file) {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  const f = file.replace(/\\/g, '/');
  const re = new RegExp('^' + p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '\u0002')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0002/g, '.*') + '$');
  return re.test(f);
}

console.log('\n1. 图标资源是否随包发布（安装版「看不见托盘」的第一层坑）');

const icoPath = path.join(ROOT, 'src', 'assets', 'tray.ico');
const pngPath = path.join(ROOT, 'src', 'assets', 'tray.png');
ok(fs.existsSync(icoPath), 'src/assets/tray.ico 存在');
ok(fs.existsSync(pngPath), 'src/assets/tray.png 存在');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const files = (pkg.build && pkg.build.files) || [];
ok(Array.isArray(files) && files.length > 0, 'package.json 配了 build.files', JSON.stringify(files));
ok(files.some((g) => globMatches(g, 'src/assets/tray.ico')),
  'build.files 覆盖 src/assets/tray.ico（否则安装版里图标根本不存在）', files.join(', '));
ok(files.some((g) => globMatches(g, 'src/assets/tray.png')), 'build.files 覆盖 src/assets/tray.png');

console.log('\n2. tray.ico 本身要能用');

const icoBuf = fs.readFileSync(icoPath);
const entries = parseIco(icoBuf);
ok(entries.length >= 2, 'ico 是多尺寸图标', String(entries.length));
ok(entries.some((e) => e.size === 16), 'ico 里有 16x16 那一档（托盘默认尺寸）');
for (const e of entries) {
  const p = parsePng(e.png);
  if (!p.ok) { ok(false, `ico 内 ${e.size}x${e.size} 档可解码`, p.error); }
}
ok(entries.every((e) => parsePng(e.png).ok), 'ico 内每一档都是完整可解码的 PNG');

const pngParse = parsePng(fs.readFileSync(pngPath));
ok(pngParse.ok && pngParse.width >= 16 && pngParse.height >= 16,
  'tray.png 是完整 PNG 且不小于 16x16', JSON.stringify({ w: pngParse.width, h: pngParse.height, err: pngParse.error }));

console.log('\n3. 内联兜底 base64 —— 历史事故就是它坏了');

const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'tray-icon.js'), 'utf-8');
const m = src.match(/TRAY_FALLBACK_PNG\s*=\s*'([A-Za-z0-9+/=]+)'/);
ok(!!m, '能在 tray-icon.js 里找到 TRAY_FALLBACK_PNG');

if (m) {
  let buf = null;
  try { buf = Buffer.from(m[1], 'base64'); } catch (e) { /* ignore */ }
  ok(!!buf && buf.length > 100, 'base64 能解码', buf ? String(buf.length) : 'null');

  const p = parsePng(buf || Buffer.alloc(0));
  ok(p.ok, '兜底图是完整 PNG（有 IEND，不是截断的）', p.error);
  ok(p.width >= 16 && p.height >= 16, '兜底图不小于 16x16', `${p.width}x${p.height}`);

  if (p.ok) {
    const stats = alphaStats(p);
    ok(!stats.error, '兜底图 IDAT 能完整解压', stats.error);
    ok(!stats.error && stats.opaque > p.width * p.height * 0.2,
      '兜底图有足够的不透明像素（全透明一样看不见）',
      stats.opaque !== undefined ? `${stats.opaque}/${stats.total}` : stats.error);
  } else {
    ok(false, '兜底图 IDAT 能完整解压', 'PNG 本身就不完整');
    ok(false, '兜底图有足够的不透明像素', 'PNG 本身就不完整');
  }
}

console.log('\n4. 候选路径必须落在 src/ 下');

const assetDirDef = src.match(/const ASSETS_DIR\s*=\s*path\.join\(__dirname,\s*'\.\.',\s*'assets'\s*\)/);
ok(!!assetDirDef, 'ASSETS_DIR 指向模块同级的 src/assets');

const candBlock = src.match(/const TRAY_ICON_CANDIDATES\s*=\s*\[([\s\S]*?)\];/);
ok(!!candBlock, '能找到 TRAY_ICON_CANDIDATES');
if (candBlock) {
  const body = candBlock[1];
  const list = body.split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean);
  // 第一、二个候选必须是随包的 src/assets
  ok(list.length >= 2 && /ASSETS_DIR/.test(list[0]) && /ASSETS_DIR/.test(list[1]),
    '前两个候选都指向随包发布的 src/assets', list.join(' | '));
  // 仓库根的 build/ 只能作为开发兜底，排在最后
  const buildRefs = (body.match(/'build'/g) || []).length;
  ok(buildRefs <= 1 && /ASSETS_DIR/.test(list[0]) && /'build'/.test(list[list.length - 1] || ''),
    '仓库根 build/ 只作为最后一个开发兜底（它不进安装包）', list.join(' | '));
}

console.log('\n' + '='.repeat(46));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
