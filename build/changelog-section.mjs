/**
 * 从 CHANGELOG.md 里抽某个版本的说明，给 Release 正文用。
 *
 *   node build/changelog-section.mjs 1.5.0     # 打印该版本段落
 *
 * 也可以被别的脚本 import：changelogSection('1.5.0') → 段落文本（找不到返回 ''）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function changelogSection(version) {
  const ver = String(version || '').replace(/^v/i, '').trim();
  if (!ver) return '';
  try {
    const md = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
    const lines = md.split(/\r?\n/);
    const head = new RegExp(`^##\\s*\\[?${ver.replace(/\./g, '\\.')}\\]?`);
    const start = lines.findIndex((l) => head.test(l));
    if (start < 0) return '';
    const out = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) break;
      out.push(lines[i]);
    }
    return out.join('\n').trim();
  } catch (e) {
    return '';
  }
}

/** 组装成 Release 正文 */
export function releaseBody(tag) {
  const body = changelogSection(tag);
  const tail = '---\n\n安装包见下方 **Assets**：`XiaoWen-Setup-<版本>.exe`（Windows x64），'
    + '下载后可直接覆盖安装，程序内也会自动检查更新。';
  if (!body) return `小问助手 ${tag} 安装包（Windows x64）。\n\n${tail}`;
  return `## 小问助手 ${tag}\n\n${body}\n\n${tail}`;
}

// 直接执行时打印到 stdout（给 CI 生成 release-body.md 用）
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && invoked === path.resolve(fileURLToPath(import.meta.url))) {
  const tag = process.argv[2];
  if (!tag) {
    console.error('用法: node build/changelog-section.mjs <版本或tag>');
    process.exit(1);
  }
  const out = releaseBody(tag);
  process.stdout.write(out.endsWith('\n') ? out : out + '\n');
}
