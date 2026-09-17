/**
 * 工具安全边界回归测试 —— node build/_tools_test.mjs
 *
 * 要保护的是 README 对小问下的两条**安全承诺**：
 *   · 「高危命令（format / shutdown / reg / diskpart 等）直接拦截」
 *   · 「写/删操作只允许用户目录、下载、临时目录与白名单目录」
 *
 * 这两条此前**一条断言都没有**。判据写死在 `tools.js` 里，而那个文件第一行就
 * `require('electron')` —— 纯 Node 加载不了它。于是 `test:all` 里 18 套测试、
 * 上千条断言，没有任何一条碰过这两条承诺（`tools.js` 只被 `_jarvis_e2e.js`
 * 这个需要真 Electron 的一次性脚本 require 过）。
 *
 * 本轮把判据抽到 `src/main/jarvis/tool-guard.js`（纯函数、零 electron 依赖）
 * 之后，这个文件才跑得起来。它真的去建一个目录联接来验绕过，而不是读一遍源码。
 *
 * 三组：
 *   1. 高危命令名单 —— 每条规则都要有正例命中（哑弹比没有规则更坏），
 *      且一批良性命令一条都不许误报
 *   2. 写路径围栏 —— 前缀混淆 / `..` 穿越 / 大小写 / 目录联接 / 边界相等
 *   3. 工具注册表 ⇄ README —— 「N 个内置工具」与逐条清单必须与注册表一致
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guard = require('../src/main/jarvis/tool-guard.js');

let pass = 0;
const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else fails.push(name + (extra ? ` → ${extra}` : '')); };
const eq = (a, b, name) => ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
const section = (s) => console.log('\n' + s);
const isWin = process.platform === 'win32';

// ============================================================
// 1. 高危命令：每条规则都要有正例，良性命令一条都不许误报
// ============================================================
section('1. 高危命令名单');

/** 正例登记表：每一条都必须被拦下 */
const BLOCKED = [
  ['format c: /q', '格式化 C 盘'],
  ['format d:', '格式化 D 盘'],
  ['format.com c:', '带扩展名的写法（旧名单只认 `format ` 加盘符，这条会漏）'],
  ['del /f important.txt', '强制删除'],
  ['del /s /q C:\\Users\\me', '递归强删目录'],
  ['del /q /s C:\\Users\\me', '参数顺序换一下（旧名单只认紧跟 del 的那一个参数）'],
  ['rd /s /q C:\\Users\\me', 'rd 递归删除 —— 与 del /s 同级，旧名单一条都没拦'],
  ['rmdir /s C:\\Windows', 'rmdir 写法同上'],
  ['rm -rf /', 'Linux 根目录'],
  ['sudo rm -rf ~', '家目录'],
  ['shutdown /s /t 0', '关机'],
  ['shutdown -h now', '关机（另一种写法）'],
  ['diskpart', '分区工具'],
  ['reg delete HKLM\\Software\\Foo /f', '删注册表'],
  ['reg add HKCU\\Software\\Foo /v x /d y', '写注册表'],
  ['net user hacker Passw0rd /add', '建系统账户'],
  ['takeown /f C:\\Windows', '夺所有权'],
  ['cipher /w:C:\\', '擦除可用空间'],
  ['powershell -c "Remove-Item -Recurse -Force C:\\Windows"', 'PowerShell 递归强删系统目录'],
  ['Stop-Computer', 'PowerShell 关机'],
  ['Restart-Computer -Force', 'PowerShell 重启'],
  ['mkfs.ext4 /dev/sda1', '格式化分区'],
  ['dd if=/dev/zero of=/dev/sda', '裸写磁盘']
];

/** 反例登记表：一条都不许命中（名单宁可误伤也不能漏网，所以只挑「确定不该拦」的） */
const ALLOWED = [
  'git status',
  'git rm --cached a.txt',
  'ls -la',
  'dir',
  'tasklist',
  'Get-Process',
  'node build/_tools_test.mjs',
  'npm install',
  'npm run format --write',
  'python -m http.server 8000',
  'mkdir newdir',
  'copy a.txt b.txt',
  'where python',
  'echo hello'
];

{
  const missed = BLOCKED.filter(([cmd]) => !guard.matchDangerousCommand(cmd));
  ok(missed.length === 0, `正例全部被拦下（${BLOCKED.length} 条）`,
    missed.map(([c]) => c).join('；'));

  const noisy = ALLOWED.filter((cmd) => guard.matchDangerousCommand(cmd));
  ok(noisy.length === 0, `良性命令一条都没误报（${ALLOWED.length} 条）`,
    noisy.map((c) => c).join('；'));

  // 双向对账：名单里每条规则都必须真的会响。
  // 「哑弹」比「没有规则」更坏 —— 它让人以为这条防线在工作（台账第 18 轮教训）。
  const duds = guard.DANGEROUS_PATTERNS
    .map((re, i) => ({ i, re }))
    .filter(({ re }) => !BLOCKED.some(([cmd]) => re.test(cmd)));
  ok(duds.length === 0, `名单里没有哑弹（${guard.DANGEROUS_PATTERNS.length} 条规则都至少有一个正例）`,
    duds.map((d) => d.re.source).join('；'));

  // 反向对照：把名单换成空数组，正例必须**全部**漏网。
  // 不这样做的话，上面那条「正例全部被拦下」可能被别的什么东西兜住，我们并不知道是谁在扛。
  const original = guard.DANGEROUS_PATTERNS.splice(0, guard.DANGEROUS_PATTERNS.length);
  const leakedWhenEmpty = BLOCKED.filter(([cmd]) => !guard.matchDangerousCommand(cmd)).length;
  guard.DANGEROUS_PATTERNS.push(...original);
  eq(leakedWhenEmpty, BLOCKED.length, '反向对照：名单清空后正例全部漏网（证明拦截确实由名单承担）');

  // 空命令不该抛，也不该被当成高危
  eq(guard.matchDangerousCommand(''), null, '空命令不报高危');
  eq(guard.matchDangerousCommand('   '), null, '纯空白不报高危');
  eq(guard.matchDangerousCommand(null), null, 'null 不抛异常');
  eq(guard.matchDangerousCommand(undefined), null, 'undefined 不抛异常');
}

// ============================================================
// 2. 写路径围栏
// ============================================================
section('2. 写路径围栏');

{
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xw-guard-root-'));
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'xw-guard-out-'));
  const J = (...p) => path.join(ROOT, ...p);

  // 2a. 边界与包含
  eq(guard.isUnder(ROOT, ROOT), true, 'root 本身算在内（相等是包含）');
  eq(guard.isUnder(ROOT, J('sub', 'a.txt')), true, '子树里的文件在内');
  eq(guard.isUnder(ROOT, ROOT + '-evil' + path.sep + 'a.txt'), false,
    '前缀混淆：`<root>-evil` 不在 root 内（这就是 `startsWith(r)` 少写一个分隔符会犯的错）');
  eq(guard.isUnder(ROOT, OUT), false, '并列的另一个目录不在内');
  eq(guard.isUnder(ROOT, J('..', path.basename(OUT), 'a.txt')), false, '`..` 穿越被规范化后拒绝');
  eq(guard.isUnder(ROOT, path.join(ROOT, 'a', '..', 'b.txt')), true, '`..` 又绕回来时仍在内');

  if (isWin) {
    eq(guard.isUnder(ROOT, ROOT.toUpperCase()), true,
      'Windows 路径不区分大小写：同一个目录全大写写法仍在内');
  }

  // 2b. 目录联接绕过 —— 本轮修掉的真洞
  const link = J('link');
  let linked = true;
  try {
    fs.symlinkSync(OUT, link, 'junction');
  } catch (e) {
    linked = false;
  }

  if (!linked) {
    // 建不出来就没有资格说这条防线是通的 —— 记一条 FAIL，别悄悄跳过
    fails.push(`无法在 ${ROOT} 下创建目录联接（${isWin ? 'junction' : 'symlink'}），「联接绕过」这条没验到`);
  } else {
    const throughLink = path.join(link, 'evil.txt');
    // 对照：只看字面路径，它**确实**落在 root 之内 —— 所以旧实现会放行
    eq(guard.isUnder(ROOT, throughLink), true,
      '对照：字面路径判定落 root 之内（旧实现正是靠这条放行的）');
    // 真判定：解析真实路径后必须拒绝
    eq(guard.isWritablePath(throughLink, [ROOT]), false,
      '目录联接指向 root 之外的目录时被拒绝（本轮修掉的绕过）');
    eq(guard.isWritablePath(J('ok.txt'), [ROOT]), true,
      '对照：同一目录下的普通路径照常放行（不是「一律拒绝」）');
  }

  // 2c. roots 的空值不许变成放行
  eq(guard.isWritablePath(J('a.txt'), ['', null, undefined]), false, 'roots 里的空值不构成允许');
  eq(guard.isWritablePath(J('a.txt'), []), false, '空 roots 一律拒绝');
  eq(guard.isWritablePath(J('a.txt'), null), false, 'roots 为 null 也不放行');

  // 2d. assertWritablePath
  // 用 try 包住：这是「本该成功」的调用，一旦它抛错，我们要的是一条 FAIL 而不是整个套件崩掉
  // —— 崩掉只会打印半截输出，看不出是哪个断言在扛（台账第 17 轮教训）。
  let resolved = null;
  try {
    resolved = guard.assertWritablePath(J('x', '..', 'y.txt'), [ROOT]);
  } catch (e) {
    resolved = `抛错了：${e && e.message}`;
  }
  eq(resolved, path.join(ROOT, 'y.txt'), '返回解析后的绝对路径（写操作拿它落地）');
  let threw = null;
  try {
    guard.assertWritablePath(path.join(OUT, 'a.txt'), [ROOT]);
  } catch (e) {
    threw = e;
  }
  ok(threw !== null, '越界路径必须抛错');
  eq(threw && threw.code, 'EPATH', '错误码是 EPATH（调用方靠它区分「越界」和「IO 失败」）');

  // 清理（临时目录是自己建的，直接删）
  for (const d of [ROOT, OUT]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响判定 */ }
  }
}

// ============================================================
// 3. 工具注册表 ⇄ README
// ============================================================
section('3. 工具注册表与 README 对账');

/** 从 tools.js 源码里取出 DEFINITIONS 数组体内的工具名（宽扫：不看结构，只看 `name: '...'`） */
function registryNames() {
  const src = fs.readFileSync(path.join(ROOT_DIR, 'src', 'main', 'jarvis', 'tools.js'), 'utf8');
  const at = src.indexOf('const DEFINITIONS = ');
  ok(at >= 0, '能在 tools.js 里找到 DEFINITIONS（找不到就没法对账，必须失败）');
  if (at < 0) return [];
  const lb = src.indexOf('[', at);
  let depth = 0;
  let end = -1;
  for (let i = lb; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  ok(end > lb, 'DEFINITIONS 的方括号配对成功（结构坏掉时必须失败，不许静默返回空集）');
  const body = src.slice(lb, end + 1);
  return [...body.matchAll(/name:\s*['"]([a-z0-9_]+)['"]/g)].map((m) => m[1]);
}

{
  const names = registryNames();
  ok(names.length > 0, `解析到工具名（${names.length} 个）`, '解析面为空 → 下面每条都会在空集上「通过」');

  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  ok(dup.length === 0, '工具名互不重复', dup.join('，'));

  // 每个工具都要有 description 与 parameters —— 少了模型就调不动它
  const src = fs.readFileSync(path.join(ROOT_DIR, 'src', 'main', 'jarvis', 'tools.js'), 'utf8');
  const lb = src.indexOf('[', src.indexOf('const DEFINITIONS = '));
  let depth = 0, end = -1;
  for (let i = lb; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(lb, end + 1);
  const noDesc = names.filter((n) => !new RegExp(`name:\\s*['"]${n}['"][\\s\\S]{0,600}?description:`).test(body));
  ok(noDesc.length === 0, '每个工具都有 description（模型靠它决定何时调用）', noDesc.join('，'));
  const noParams = names.filter((n) => !new RegExp(`name:\\s*['"]${n}['"][\\s\\S]{0,900}?parameters:`).test(body));
  ok(noParams.length === 0, '每个工具都有 parameters（缺了 function calling 会失败）', noParams.join('，'));

  // README 的数量声称必须等于注册表长度
  const readme = fs.readFileSync(path.join(ROOT_DIR, 'README.md'), 'utf8');
  const claims = [...readme.matchAll(/(\d+)\s*个内置工具/g)].map((m) => ({ n: Number(m[1]), at: readme.slice(0, m.index).split('\n').length }));
  ok(claims.length > 0, `README 里抓到了数量声称（${claims.length} 处）`,
    '抓不到说明文案形态变了 —— 这条检查必须跟着改，否则它从此在空集上通过');
  const wrong = claims.filter((c) => c.n !== names.length);
  ok(wrong.length === 0, `README 的数量声称与注册表一致（真值 ${names.length}）`,
    wrong.map((c) => `第 ${c.at} 行写「${c.n} 个内置工具」`).join('；'));

  // 逐条对账：注册表里每个工具都必须在 README 里出现过（README 有别的反引号标识符，
  // 所以只做这一个方向 —— 反向会误判）
  const missing = names.filter((n) => !readme.includes('`' + n + '`'));
  ok(missing.length === 0, '每个内置工具都在 README 里有文档', missing.join('，'));
}

// ---------------- 汇总 ----------------
console.log('\n' + '='.repeat(46));
if (fails.length) {
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`工具安全边界：通过 ${pass} / ${pass}`);
