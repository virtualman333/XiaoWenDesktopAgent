/**
 * 用「普通模式」的 Electron 跑一个 GUI 测试脚本。
 *
 * 为什么要这么绕：这个仓库的开发终端里往往带着 ELECTRON_RUN_AS_NODE，
 * 直接调 electron.exe 会被当成 node 执行（require('electron') 只拿到一个路径）。
 * 所以统一从这里启动，启动前把那个变量摘掉。
 *
 * 用法：node build/_run-electron.mjs build/_xxx_test.js [args...]
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const target = process.argv[2];
if (!target) {
  console.error('用法：node build/_run-electron.mjs <要跑的脚本>');
  process.exit(2);
}

const exe = path.join(
  'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
);
if (!fs.existsSync(exe)) {
  console.error(`找不到 Electron：${exe}（先 npm install）`);
  process.exit(2);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const r = spawnSync(exe, [target, ...process.argv.slice(3)], { stdio: 'inherit', env });
if (r.error) {
  console.error('启动 Electron 失败：' + r.error.message);
  process.exit(1);
}
process.exit(typeof r.status === 'number' ? r.status : 1);
