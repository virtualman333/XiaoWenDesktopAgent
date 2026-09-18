/**
 * 「测试入口清单」自身的守卫 —— node build/_test_suites_check.mjs
 *
 * 为什么需要它
 * ------------
 * `package.json` 的 `test:all` 是一条**手写的 `&&` 串**，README 里那份「也可以单跑」
 * 清单是**手抄的第二份**。两处都没有任何东西守着：
 *
 *   · 新加一个 `test:xxx` 忘了写进 `test:all` → 它永远不会被跑，而 `npm test` 照样全绿
 *   · 从 `test:all` 里删掉一个入口 → 同上，没人发现
 *   · README 那份清单实测已经漂了：漏了 `test:packed-deps` / `test:schedule` / `test:tools`
 *     （后两个的 CHANGELOG 还明写着「已接入 test:all」）
 *
 * 判据一律**现算**，只保留一张「确实不进默认流程」的登记表，且登记表要写明理由 ——
 * 表会腐烂，所以「登记了却其实在 test:all 里」和「登记了但入口没了」都算失败。
 *
 * README 那两份名单（可单跑的 / 不进默认流程的）与这里的真值**两向对账**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};

let pass = 0;
const fails = [];
const ok = (cond, name, extra) => { if (cond) pass++; else fails.push(name + (extra ? ` → ${extra}` : '')); };
const section = (s) => console.log('\n' + s);

/**
 * 确实**不**进默认流程的入口 —— 只减不增，每条必须写明为什么。
 * 在 test:all 里出现的、或已经不存在的条目都会判失败（白名单会烂）。
 */
const MANUAL = {
  'test:packed': '先 npm run dist:dir 生成真实 app.asar 才能跑（依赖打包产物）',
  'test:pet-top': '需要真实桌面（Electron 窗口置顶），纯 Node / 无头环境跑不了',
};

section('1. 解析面不许为空');
const suites = Object.keys(scripts).filter((k) => k.startsWith('test:') && k !== 'test:all');
const allStr = String(scripts['test:all'] || '');
const allRefs = [...allStr.matchAll(/npm run ([\w:.-]+)/g)].map((m) => m[1]);
const allSet = new Set(allRefs);
ok(suites.length > 0, `从 package.json 现算出 test:* 入口（${suites.length} 个）`,
  '算不出来说明命名变了 —— 这个检查必须跟着改，否则它从此在空集上通过');
ok(allRefs.length > 0, `从 test:all 里解析出被串跑的入口（${allRefs.length} 个）`,
  '解析面为空时下面每一条都会在空集上通过');
ok(!!scripts['test:all'], 'test:all 入口存在');

section('2. 谁在 test:all 里，谁不在');
console.log(`   test:all 串跑 ${allRefs.length} 个：${allRefs.join(' ')}`);
const inAll = suites.filter((k) => allSet.has(k));
const notInAll = suites.filter((k) => !allSet.has(k));
console.log(`   test:* 共 ${suites.length} 个，其中 ${inAll.length} 个进默认流程`);
console.log(`   不进默认流程的 ${notInAll.length} 个：${notInAll.join(' ') || '（无）'}`);

const silent = notInAll.filter((k) => !MANUAL[k]);
ok(silent.length === 0, '每个 test:* 要么进 test:all，要么在 MANUAL 登记表里写明理由',
  `${silent.join('，')} —— 它们永远不会被跑到，而 npm test 照样全绿`);

section('3. 登记表不许腐烂');
for (const [k, why] of Object.entries(MANUAL)) {
  ok(suites.includes(k), `登记表里的 ${k} 还是一个真实入口`, '入口已删/改名，条目该删');
  ok(!allSet.has(k), `登记表里的 ${k} 确实不在 test:all 里`, '它已经在跑了，这条豁免是多余的');
  ok(typeof why === 'string' && why.trim().length >= 8, `登记表里的 ${k} 写清了理由`, String(why));
}

section('4. test:all 里不许有幽灵引用');
const ghost = [...allSet].filter((r) => !scripts[r]);
ok(ghost.length === 0, 'test:all 引用的每个入口都真实存在（拼错 / 已删都会在这里现形）', ghost.join('，'));
const notTestish = [...allSet].filter((r) => scripts[r] && !k2(r));
function k2(r) { return scripts[r].startsWith('node ') || r.startsWith('test:') || r.startsWith('check:'); }
ok(notTestish.length === 0, 'test:all 只串 test:* / check:* 这类测试入口', notTestish.join('，'));

section('5. README 两份名单 ⇄ 真值（两向）');
const readme = fs.readFileSync(path.join(ROOT_DIR, 'README.md'), 'utf8');
const startMark = '也可以单跑';
const endMark = 'test:pet-top';
const i0 = readme.indexOf(startMark);
const i1 = readme.indexOf(endMark);
ok(i0 !== -1 && i1 !== -1 && i1 > i0, 'README 里两块标记都在（「也可以单跑」…「test:pet-top」）',
  '标记没了说明文案形态变了 —— 这里必须跟着改，否则下面两条会在空集上通过');

if (i0 !== -1 && i1 > i0) {
  const region = readme.slice(i0, i1);
  const docRunnable = [...new Set([...region.matchAll(/test:[\w-]+/g)].map((m) => m[0]))];
  // 「可单跑」= 进默认流程的那些（清单里的每一项都真的能被单独 npm run）
  const expectRunnable = inAll.slice().sort();
  const docSet = docRunnable.slice().sort();
  const missingInDoc = expectRunnable.filter((k) => !docSet.includes(k));
  const extraInDoc = docSet.filter((k) => !expectRunnable.includes(k));
  ok(docRunnable.length > 0, `README 那份清单解析出 ${docRunnable.length} 个入口`, '解析面为空，这条检查等于没查');
  ok(missingInDoc.length === 0, 'README 的「可以单跑」清单没有漏项', missingInDoc.join('，'));
  ok(extraInDoc.length === 0, 'README 的「可以单跑」清单没有多余项（列了但跑不了 / 已删）', extraInDoc.join('，'));

  // 豁免项必须在 README 里被说明过 —— 只做**单向**：README 把 `test:pet-top` 写在清单末尾那句、
  // 把 `test:packed` 写在下面「打包内容校验」块里，两处位置不同，硬求集合相等会把散文当表格查。
  const tail = readme.slice(i1, i1 + 200);
  for (const k of Object.keys(MANUAL)) {
    ok(readme.includes(k), `豁免的 ${k} 在 README 里有说明`, '豁免了却不在文档里提，用户不知道它还存不存在');
  }
  ok(tail.includes('test:pet-top'), 'README 那句「不在默认流程里」仍然点名 test:pet-top');

  const undeclared = notInAll.filter((k) => !Object.keys(MANUAL).includes(k));
  ok(undeclared.length === 0, '每个不在默认流程里的入口都进了 MANUAL 登记表', undeclared.join('，'));
}

section('6. README 点名的每个入口都必须真实存在');
{
  const named = [...new Set([...readme.matchAll(/test:[\w-]+/g)].map((m) => m[0]))];
  ok(named.length > 0, `README 里抓到 ${named.length} 个 test:* 引用`, '抓不到说明文案形态变了');
  const stale = named.filter((k) => !Object.prototype.hasOwnProperty.call(scripts, k));
  ok(stale.length === 0, 'README 里没有已经不存在的入口名（改了名 / 删了入口都会在这里现形）', stale.join('，'));
  const sup = [...new Set([...readme.matchAll(/check:[\w-]+/g)].map((m) => m[0]))];
  const staleSup = sup.filter((k) => !Object.prototype.hasOwnProperty.call(scripts, k));
  ok(staleSup.length === 0, 'README 里点名的 check:* 入口也都真实存在', staleSup.join('，'));
}

console.log('\n' + '='.repeat(46));
if (fails.length) {
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`测试入口清单：通过 ${pass} / ${pass}`);
