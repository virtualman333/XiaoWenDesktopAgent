/**
 * 发版前统一改版本号，避免 package.json 里 version 和打包输出目录不一致。
 *
 *   node build/bump-version.mjs 1.5.1
 *
 * 会改：version、build.directories.output = release-v1.5.1
 * 输出的目录名必须和 gh-release.mjs / CI 的 release* 通配对上，所以这里一起改。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'package.json');

const raw = process.argv[2];
if (!raw || !/^\d+\.\d+\.\d+$/.test(raw)) {
  console.error('用法: node build/bump-version.mjs <主.次.修订>，例如 1.5.1');
  process.exit(1);
}

const buf = fs.readFileSync(FILE, 'utf8');
const crlf = buf.includes('\r\n');
const pkg = JSON.parse(buf);

const old = pkg.version;
pkg.version = raw;
pkg.build.directories.output = `release-v${raw}`;

let out = JSON.stringify(pkg, null, 2);
if (crlf) out = out.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
fs.writeFileSync(FILE, out, 'utf8');

console.log(`✓ 版本 ${old} → ${raw}`);
console.log(`✓ 打包输出目录 → ${pkg.build.directories.output}`);
console.log('\n接下来：');
console.log('  1. 补 CHANGELOG.md（新建 ## [' + raw + '] 段落）');
console.log('  2. npm run test:wake && npm run test:pet && npm run test:orch');
console.log('  3. git commit -am "release: v' + raw + '" && git push origin main');
console.log('  4. git tag -a v' + raw + ' -m "v' + raw + '" && git push origin v' + raw);
console.log('     （推 tag 后 GitHub Actions 会自动编译并挂安装包）');
