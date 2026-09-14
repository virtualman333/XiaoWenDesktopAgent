/**
 * 把「编译产物」挂到 GitHub Release 上（发版必须是发安装包，不是发源码）。
 *
 * 用法：
 *   node build/gh-release.mjs v1.5.0                  # 自动取 release-* 目录下的产物
 *   node build/gh-release.mjs v1.5.0 某个文件.exe ...  # 指定文件
 *
 * 凭据来源（按顺序）：
 *   1. 环境变量 GH_TOKEN / GITHUB_TOKEN
 *   2. git 已保存的 github.com 凭据（git credential fill）
 * 脚本本身不存任何密钥。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const pub = (pkg.build && pkg.build.publish) || {};
const OWNER = pub.owner || 'virtualman333';
const REPO = pub.repo || pkg.name;
const API = 'https://api.github.com';
const UPLOAD = 'https://uploads.github.com';

// ---------- 凭据 ----------
function resolveToken() {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env && env.trim()) return env.trim();
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      cwd: ROOT,
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8'
    });
    const line = out.split(/\r?\n/).find((l) => l.startsWith('password='));
    if (line) return line.slice('password='.length).trim();
  } catch (e) {
    /* ignore */
  }
  return '';
}

const TOKEN = resolveToken();
if (!TOKEN) {
  console.error('✗ 没拿到 GitHub 凭据。请设置 GH_TOKEN，或先用 git 推一次代码让系统记住登录。');
  process.exit(1);
}

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'xiaowen-release'
};

async function api(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...HEADERS, ...(init.headers || {}) } });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* ignore */ }
  return { status: res.status, ok: res.ok, json, text };
}

// ---------- 参数 ----------
const tag = process.argv[2];
if (!tag) {
  console.error('用法: node build/gh-release.mjs <tag> [文件...]');
  process.exit(1);
}
const explicit = process.argv.slice(3);

/** 从 CHANGELOG 里抠出这一版的说明，找不到就用一句兜底 */
function releaseBody() {
  const ver = tag.replace(/^v/, '');
  try {
    const md = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
    const lines = md.split(/\r?\n/);
    const start = lines.findIndex((l) => new RegExp(`^##\\s*\\[?${ver.replace(/\./g, '\\.')}\\]?`).test(l));
    if (start >= 0) {
      const out = [];
      for (let i = start + 1; i < lines.length; i++) {
        if (/^##\s/.test(lines[i])) break;
        out.push(lines[i]);
      }
      const body = out.join('\n').trim();
      if (body) return `## 小问助手 ${tag}\n\n${body}\n\n---\n\n安装包在下方 Assets（Windows x64 安装版，可直接覆盖安装）。`;
    }
  } catch (e) { /* ignore */ }
  return `小问助手 ${tag} 安装包（Windows x64）。`;
}

/** 没显式传文件时，自动去 release-* 目录里找编译产物 */
function collectFiles() {
  if (explicit.length) return explicit.map((f) => path.resolve(ROOT, f));
  const outDirs = [];
  if (pkg.build && pkg.build.directories && pkg.build.directories.output) {
    outDirs.push(path.resolve(ROOT, pkg.build.directories.output));
  }
  for (const d of fs.readdirSync(ROOT)) {
    if (/^release-?/.test(d)) outDirs.push(path.resolve(ROOT, d));
  }
  const files = [];
  for (const dir of outDirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (/\.exe$|\.blockmap$|^latest.*\.yml$|\.exe\.sha256\.txt$/i.test(f)) {
        files.push(path.join(dir, f));
      }
    }
    if (files.length) break; // 只取一个目录（最新的那个）
  }
  return files;
}

function human(n) {
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n > 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

// ---------- 主流程 ----------
const files = collectFiles().filter((f) => fs.existsSync(f));
if (!files.length) {
  console.error('✗ 没找到编译产物。先跑 npm run dist，或显式传文件路径。');
  process.exit(1);
}

console.log(`→ 仓库 ${OWNER}/${REPO}，tag ${tag}`);
console.log('→ 待上传：');
files.forEach((f) => console.log(`   - ${path.basename(f)}  (${human(fs.statSync(f).size)})`));

// 1) 找 Release，没有就建一个（非草稿，自动更新才拉得到）
let rel = await api(`${API}/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag)}`);
if (rel.status === 404) {
  console.log('… 该 tag 还没有 Release，正在创建');
  const created = await api(`${API}/repos/${OWNER}/${REPO}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: tag,
      body: releaseBody(),
      draft: false,
      prerelease: /-(beta|rc|alpha)/i.test(tag)
    })
  });
  if (!created.ok) {
    console.error('✗ 创建 Release 失败：', created.status, created.text.slice(0, 400));
    process.exit(1);
  }
  rel = created;
} else if (!rel.ok) {
  console.error('✗ 查询 Release 失败：', rel.status, rel.text.slice(0, 300));
  process.exit(1);
}

const release = rel.json;
console.log(`→ Release #${release.id}  ${release.html_url || ''}`);

// 2) 逐个上传（同名先删，避免 422）
let okCount = 0;
for (const f of files) {
  const name = path.basename(f);
  const exist = (release.assets || []).find((a) => a.name === name);
  if (exist) {
    console.log(`… 已存在同名资产，先删除：${name}`);
    await api(`${API}/repos/${OWNER}/${REPO}/releases/assets/${exist.id}`, { method: 'DELETE' });
  }
  const size = fs.statSync(f).size;
  process.stdout.write(`↑ 上传 ${name} (${human(size)}) … `);
  const res = await fetch(
    `${UPLOAD}/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: {
        ...HEADERS,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size)
      },
      body: fs.createReadStream(f),
      duplex: 'half'
    }
  );
  const txt = await res.text();
  if (res.ok) {
    console.log('✓');
    okCount++;
  } else {
    console.log('✗');
    console.error('   ', res.status, txt.slice(0, 300));
  }
}

console.log(okCount === files.length
  ? `✓ 完成，${okCount} 个编译产物已挂到 ${tag} 的 Release 上`
  : `△ 部分失败：成功 ${okCount}/${files.length}`);
process.exit(okCount === files.length ? 0 : 2);
