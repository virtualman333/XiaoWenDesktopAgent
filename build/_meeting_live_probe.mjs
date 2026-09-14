/**
 * 会议检测「实机体检」—— node build/_meeting_live_probe.mjs
 *
 * 干的事：真的去读本机注册表（谁占着麦克风/摄像头）+ 真的列一遍进程，
 * 然后把结果喂给 meeting-detect 的判定函数，把结论和理由原样打出来。
 *
 * 为什么单独做这个工具：
 *   1. 判定逻辑的输入是**系统输出的文本**，桩数据再像也不等于真机格式
 *      （比如键名里的 `#`、包族名、值是 REG_QWORD 而不是 DWORD 这些细节）。
 *   2. 主人问「我都开会在说了，小问怎么没反应」时，跑一下就知道卡在哪一环 ——
 *      是没采到麦、是进程名不在白名单、还是标题没命中。
 *
 * 只读，不改任何东西，可以随时跑。
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const detect = require('../src/main/jarvis/meeting-detect.js');

const ROOT = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore';

function reg(device) {
  try {
    // 拿 Buffer 自己解 —— 这些工具按 OEM 代码页（简体中文 = GBK）输出，
    // 直接 encoding:'utf8' 会把中文窗口标题变成乱码。
    const buf = execFileSync('reg', ['query', `${ROOT}\\${device}`, '/s'], { maxBuffer: 8 << 20 });
    return detect.decodeOemText(buf);
  } catch (e) {
    return '';
  }
}

function procs() {
  try {
    return execFileSync('tasklist', ['/v', '/fo', 'csv', '/nh'], { maxBuffer: 16 << 20 });
  } catch (e) {
    return Buffer.alloc(0);
  }
}

const micText = reg('microphone');
const camText = reg('webcam');
const procBuf = procs();
const decoded = detect.decodeOemTextBoth(procBuf);

const micUsers = detect.activeUsers(micText);
const camUsers = detect.activeUsers(camText);
const list = detect.parseTasklist(decoded.primary, { altText: decoded.alt });

console.log('=== 1. 麦克风 / 摄像头占用记录 ===');
const showUsers = (name, users) => {
  const now = users.filter((u) => u.active);
  console.log(`\n[${name}] 注册表里共 ${users.length} 条记录，其中 ${now.length} 条是「还在用」：`);
  if (!now.length) {
    console.log('  （没有）');
    return;
  }
  for (const u of now) {
    const started = u.start ? new Date(u.start).toLocaleString('zh-CN') : '?';
    console.log(`  · ${u.exe || u.leaf}${u.packaged ? '（应用商店应用）' : ''}`
      + `  开始于 ${started}  记录完整=${u.stopKnown}`);
  }
};
showUsers('microphone', micUsers);
showUsers('webcam', camUsers);

console.log('\n=== 2. 白名单应用进程 / 会议关键词命中的窗口 ===');
const known = list.filter((p) => detect.isKnown(p.exe));
if (!known.length) console.log('  （没有正在运行的会议类应用）');
for (const p of known) {
  const hit = detect.titleHit(`${p.title || ''} ${p.titleAlt || ''}`);
  console.log(`  · ${p.exe}  ${detect.labelOf(p.exe)}${p.title ? `  标题=「${p.title}」` : '  标题空'}`
    + (hit ? `  ★命中关键词「${hit}」` : ''));
}

console.log('\n=== 3. 判定结果 ===');
const r = detect.classify({
  micUsers,
  camUsers,
  procs: list,
  selfExe: 'electron.exe',
  allowUnknown: true   // 体检时把弱信号也摊出来，方便看「有谁在用麦但不是会议」
});
const label = { meeting: '✅ 判定在开会/通话（会自动开始记录）', mic: '⚠️ 有人在用麦克风，但不是会议类应用', none: '⬜ 没有检测到通话' };
console.log('  ' + (label[r.level] || r.level) + (r.app ? ` → ${r.app}` : ''));
console.log('  理由：');
for (const x of r.reasons) console.log('    - ' + x);

console.log('\n=== 4. 说明 ===');
console.log('  · 「登记在注册表但进程不在」的记录会被忽略 —— 系统偶尔会留下没人认领的条目。');
console.log('  · 微信 / QQ / 腾讯会议 / 钉钉 / 飞书 / Zoom / Teams / Webex / Discord / Slack 等在白名单里。');
console.log('  · 浏览器里的网页会议：需要标题命中（如 Google Meet）且同一个浏览器正在用麦克风。');
console.log('  · 小问自己（含 electron.exe 调试进程）用麦克风不算 —— 否则一语音问答就以为在开会。');
