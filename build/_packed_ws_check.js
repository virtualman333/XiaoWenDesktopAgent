// 验证「已打包的 asar」里的 ws 能被主进程 require 到。
// 用法：electron build/_packed_ws_check.js  （从源码目录跑）
// 它通过 overrideAppPath 的思路间接验证：直接 require app.asar 内的路径。
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(() => {
  const asar = path.join(__dirname, '..', 'release-v1.0.4', 'win-unpacked', 'resources', 'app.asar');
  console.log('[PACKED] asar 存在:', fs.existsSync(asar));
  if (!fs.existsSync(asar)) { console.log('结论: 跳过 —— 没有 asar'); return app.exit(2); }

  // 读取 asar 内 package.json，确认 dependencies 带了 ws
  const { execFileSync } = require('child_process');
  const node = process.execPath;
  const asarTool = path.join(__dirname, '..', 'node_modules', '@electron', 'asar', 'bin', 'asar.js');

  let entries = [];
  try {
    const out = execFileSync(node, [asarTool, 'list', asar], { encoding: 'utf-8', windowsHide: true });
    entries = out.split(/\s+/).filter(Boolean);
  } catch (e) {
    console.log('结论: 无法列出 asar:', e.message);
    return app.exit(1);
  }

  const hasWsIndex = entries.some((e) => e.replace(/\\/g, '/').endsWith('node_modules/ws/index.js'));
  const hasWsLib = entries.filter((e) => e.replace(/\\/g, '/').includes('node_modules/ws/lib/'));
  const hasMain = entries.some((e) => e.replace(/\\/g, '/').endsWith('src/main/main.js'));
  const hasPreload = entries.some((e) => e.replace(/\\/g, '/').endsWith('src/main/preload.js'));
  const hasDist = entries.some((e) => e.replace(/\\/g, '/').includes('dist/panel.html'));

  console.log('[PACKED] 主进程 main.js :', hasMain);
  console.log('[PACKED] preload.js     :', hasPreload);
  console.log('[PACKED] dist/panel.html:', hasDist);
  console.log('[PACKED] ws/index.js    :', hasWsIndex);
  console.log('[PACKED] ws/lib 文件数  :', hasWsLib.length);
  hasWsLib.slice(0, 8).forEach((f) => console.log('           ', f.replace(/\\/g, '/')));

  // 真正 require 一次 asar 里的 ws，确认运行时可用
  let requireOk = false;
  try {
    const WS = require(path.join(asar, 'node_modules', 'ws'));
    const Ctor = WS.WebSocket || WS;
    requireOk = typeof Ctor === 'function';
    console.log('[PACKED] require(asar 内 ws) :', requireOk ? '成功' : '失败', '| 类型 =', typeof Ctor);
  } catch (e) {
    console.log('[PACKED] require(asar 内 ws) 异常:', e.code || e.message);
  }

  const ok = hasWsIndex && hasWsLib.length >= 5 && hasMain && requireOk;
  console.log('');
  console.log('=== 结论:', ok
    ? '成功 —— 打包版包含完整可用的 ws，语音识别依赖已正确封装'
    : '失败 —— 打包内容不完整', '===');
  setTimeout(() => app.exit(ok ? 0 : 1), 300);
});

app.on('window-all-closed', () => {});
