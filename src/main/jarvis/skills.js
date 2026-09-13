/**
 * Skills 系统
 *
 * 兼容 Claude / WorkBuddy 的 SKILL.md 约定：
 *   jarvis/skills/<skill-name>/SKILL.md
 *   ---
 *   name: my-skill
 *   description: 这个技能做什么、什么时候用
 *   ---
 *   正文（Markdown 指令）
 *
 * 模型在 system prompt 里只看到「技能清单（名称 + 描述）」，
 * 需要时通过 load_skill 工具把正文读进上下文，避免一次性塞满。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const store = require('./store');

/** 极简 YAML frontmatter 解析（只支持 key: value 与行内数组） */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  m[1].split(/\r?\n/).forEach((line) => {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) return;
    let v = kv[2].trim();
    if ((v.startsWith('[') && v.endsWith(']')) || (v.startsWith('"') && v.endsWith('"'))) {
      try { v = JSON.parse(v); } catch (e) { /* 保留字符串 */ }
    }
    data[kv[1]] = v;
  });
  return { data, body: text.slice(m[0].length) };
}

function slugify(name) {
  return String(name || '').trim().toLowerCase().replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '');
}

async function listSkills() {
  const dir = store.skillsDir();
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const file = path.join(dir, ent.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    try {
      const raw = await fsp.readFile(file, 'utf-8');
      const { data } = parseFrontmatter(raw);
      out.push({
        id: ent.name,
        name: data.name || ent.name,
        description: data.description || '',
        enabled: data.enabled !== false,
        path: file,
        updatedAt: (fs.statSync(file).mtimeMs || 0)
      });
    } catch (e) { /* 跳过坏技能 */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function loadSkill(id) {
  const dir = store.skillsDir();
  const file = path.join(dir, id, 'SKILL.md');
  if (!file.startsWith(dir)) return null;   // 防目录穿越
  if (!fs.existsSync(file)) return null;
  const raw = await fsp.readFile(file, 'utf-8');
  const { data, body } = parseFrontmatter(raw);
  return { id, name: data.name || id, description: data.description || '', content: body.trim() };
}

async function saveSkill({ id, name, description, content }) {
  const dir = store.skillsDir();
  const sid = slugify(id || name) || ('skill-' + Date.now().toString(36));
  const sdir = path.join(dir, sid);
  await fsp.mkdir(sdir, { recursive: true });
  const text = [
    '---',
    `name: ${name || sid}`,
    `description: ${description || ''}`,
    '---',
    '',
    content || ''
  ].join('\n');
  await fsp.writeFile(path.join(sdir, 'SKILL.md'), text, 'utf-8');
  return { id: sid };
}

async function deleteSkill(id) {
  const dir = store.skillsDir();
  const target = path.join(dir, id);
  if (!target.startsWith(dir)) return false;
  try {
    await fsp.rm(target, { recursive: true, force: true });
    return true;
  } catch (e) { return false; }
}

/** 给 system prompt 的技能清单 */
async function skillsPrompt() {
  const list = (await listSkills()).filter((s) => s.enabled);
  if (!list.length) return '';
  return '你掌握以下技能，需要时调用 load_skill 读取完整指令：\n'
    + list.map((s) => `- ${s.name}（id=${s.id}）：${s.description}`).join('\n');
}

/** 内置技能：首次运行时写入一个示例 */
async function ensureSample() {
  const list = await listSkills();
  if (list.length) return;
  await saveSkill({
    id: 'daily-brief',
    name: 'daily-brief',
    description: '早晨简报：汇报今天日期、系统状态、磁盘剩余，并用一句话提醒。主人说"早报/简报"时使用。',
    content: [
      '# 每日简报',
      '',
      '1. 调用 get_datetime 获取今天日期与星期。',
      '2. 调用 system_info 获取内存与运行时间。',
      '3. 用 3~5 句话汇报：日期、星期、内存剩余、已运行时间。',
      '4. 最后加一句简短的提醒或问候，语气像贾维斯。'
    ].join('\n')
  });
}

module.exports = { listSkills, loadSkill, saveSkill, deleteSkill, skillsPrompt, ensureSample, parseFrontmatter };
