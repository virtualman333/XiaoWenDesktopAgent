/**
 * 启动冒烟 —— node build/_run-electron.mjs build/_boot_check.js
 *
 * 目的：确认「整个主进程能真的起来」——托盘建好、宠物窗口显示、Jarvis 各模块加载、
 * 看门狗第一次巡检没有 fatal。改动过 main.js / pet.js / updater.js 这类「装配层」之后
 * 最该跑的就是它：单元测试全绿但装配层写错一个标识符，用户那边就是起不来。
 *
 * 退出码 0 = 正常；非 0 = 关键模块没起来 / 出现致命日志 / 宠物巡检不通过。
 */
delete process.env.ELECTRON_RUN_AS_NODE;
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app } = require('electron');

// 用独立的 userData，别去动主人真实的配置和会话
const UD = path.join(os.tmpdir(), 'xw-boot-' + Date.now());
fs.mkdirSync(UD, { recursive: true });
app.setPath('userData', UD);

const LOG_FILE = path.join(os.homedir(), '.xiaowen', 'launch.log');
let startSize = 0;
try { startSize = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0; } catch (e) { /* ignore */ }

require('../src/main/main.js');

/** 只读「这次启动新增」的日志，不去翻历史 */
function freshLog() {
  try {
    const size = fs.statSync(LOG_FILE).size;
    const len = size - startSize;
    if (len <= 0) return '';
    const fd = fs.openSync(LOG_FILE, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, startSize);
    fs.closeSync(fd);
    return buf.toString('utf-8');
  } catch (e) { return ''; }
}

setTimeout(() => {
  const lines = freshLog().split('\n');
  const has = (re) => lines.filter((l) => re.test(l));
  const checks = [
    ['托盘图标就绪', /\[tray\] 托盘图标就绪/],
    ['宠物窗口已创建', /\[pet\] 宠物窗口已创建/],
    ['宠物已显示', /\[pet\] 宠物已显示/],
    ['Jarvis 模块已加载', /\[jarvis\] 模块已加载/],
    ['截图模块已加载', /\[capture\] 截图模块已加载/],
    ['更新模块已加载', /\[updater\] 更新模块已加载/],
    ['定时调度已启动', /调度已启动/],
    ['主进程初始化成功', /\[ready\] 初始化成功/]
  ];

  console.log('\n=== 启动冒烟 ===');
  let bad = 0;
  for (const [name, re] of checks) {
    if (has(re).length) console.log('  ✓ ' + name);
    else { console.log('  ✗ ' + name); bad++; }
  }

  const fatals = has(/\[fatal\]|\[render-gone\]|\[child-gone\]|UnhandledPromiseRejection/);
  console.log(fatals.length ? `  ✗ 启动期间出现 ${fatals.length} 条致命日志` : '  ✓ 启动期间没有致命日志');
  fatals.slice(0, 5).forEach((l) => console.log('      ' + l.trim().slice(0, 160)));
  if (fatals.length) bad++;

  // 看门狗第一轮巡检：宠物必须是「存在 + 可见 + 在屏内 + 置顶」
  const wd = has(/\[watchdog\] 宠物状态 (.*)/)[0];
  if (wd) {
    try {
      const st = JSON.parse(wd.replace(/^.*\[watchdog\] 宠物状态 /, ''));
      const okAll = st.exists && st.visible && st.alwaysOnTop && st.onScreen;
      console.log((okAll ? '  ✓ ' : '  ✗ ') + '看门狗认为宠物正常 ' + JSON.stringify(st));
      if (!okAll) bad++;
    } catch (e) { console.log('  ✗ 看门狗日志解析失败：' + e.message); bad++; }
  } else {
    console.log('  ✗ 没有等到看门狗巡检日志');
    bad++;
  }

  console.log(bad ? `\n启动冒烟：${bad} 项不通过` : '\n启动冒烟：全部通过');
  process.exit(bad ? 1 : 0);
}, 9000);
