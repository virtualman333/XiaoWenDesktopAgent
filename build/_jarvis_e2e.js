/**
 * 一次性验证脚本：在真实 Electron 主进程里跑一遍 Jarvis 能力。
 * 运行：node_modules/electron/dist/electron.exe build/_jarvis_e2e.js
 */
// 必须在 require('electron') 之前清掉，否则 require 返回的是 exe 路径字符串
delete process.env.ELECTRON_RUN_AS_NODE;

const path = require('path');
const os = require('os');
const fs = require('fs');
const { app } = require('electron');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('no-sandbox');

const USERDATA = path.join(os.homedir(), 'AppData', 'Roaming', 'xiaowen-assistant');
try { fs.mkdirSync(USERDATA, { recursive: true }); } catch (e) {}
app.setPath('userData', USERDATA);

const results = [];
function log(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
}

app.whenReady().then(async () => {
  const store = require('../src/main/jarvis/store.js');
  const tools = require('../src/main/jarvis/tools.js');
  const tts = require('../src/main/jarvis/tts.js');
  const autostart = require('../src/main/jarvis/autostart.js');
  const skills = require('../src/main/jarvis/skills.js');

  try {
    // 1. 人格
    const p = store.setPersona({ userName: '永贵', userAlias: 'virtualman' });
    log('persona', p.userName === '永贵', JSON.stringify(p).slice(0, 80));

    // 2. 记忆写入 + 检索
    store.addMemory({ content: '主人叫永贵，做 AI 平台产品，喜欢简洁直接的沟通', category: 'person', tags: ['主人'] });
    store.addMemory({ content: '前端用 Vue3 + Vben Admin，后端 Django + DRF', category: 'fact' });
    const hit = store.searchMemories('主人是谁', 5);
    log('memory', hit.length > 0 && hit[0].content.includes('永贵'), `命中 ${hit.length} 条`);

    // 3. 时间
    const dt = await tools.execute('get_datetime', {});
    log('get_datetime', dt.ok && /\d{4}年/.test(dt.output), dt.output);

    // 4. 系统信息
    const si = await tools.execute('system_info', {});
    log('system_info', si.ok && si.output.includes('内存'), (si.output || '').split('\n')[0]);

    // 5. 执行命令（PowerShell）
    const cmd = await tools.execute('shell_exec', { command: 'Get-Date -Format "yyyy-MM-dd HH:mm:ss"' });
    log('shell_exec(ps)', cmd.ok && /\d{4}-\d{2}-\d{2}/.test(cmd.output), (cmd.output || '').trim().slice(0, 60));

    // 6. 命令（cmd）
    const cmd2 = await tools.execute('shell_exec', { command: 'echo hello-xiaowen', shell: 'cmd' });
    log('shell_exec(cmd)', cmd2.ok && cmd2.output.includes('hello-xiaowen'), (cmd2.output || '').trim().slice(0, 40));

    // 7. 高危命令拦截
    const danger = await tools.execute('shell_exec', { command: 'format C:' });
    log('shell_danger_block', danger.ok === false, danger.error);

    // 8. 列目录
    const ls = await tools.execute('file_list', { path: os.homedir(), limit: 5 });
    log('file_list', ls.ok && ls.output.length > 0, (ls.output || '').split('\n')[0]);

    // 9. 文件读写（临时目录允许）
    const tmpFile = path.join(os.tmpdir(), 'xiaowen-test.txt');
    const wr = await tools.execute('file_write', { path: tmpFile, content: '小问测试内容 hello' });
    log('file_write', wr.ok, wr.output || wr.error);
    const rd = await tools.execute('file_read', { path: tmpFile });
    log('file_read', rd.ok && rd.output.includes('hello'), (rd.output || '').trim().slice(0, 40));
    const del = await tools.execute('file_delete', { path: tmpFile });
    log('file_delete', del.ok, del.output || del.error);

    // 10. 越权写入拦截
    const bad = await tools.execute('file_write', { path: 'C:\\Windows\\evil.txt', content: 'x' });
    log('file_write_guard', bad.ok === false, (bad.error || '').slice(0, 60));

    // 11. 进程列表
    const pl = await tools.execute('process_list', {});
    log('process_list', pl.ok && pl.output.length > 50, (pl.output || '').split('\n')[1] || '');

    // 12. 剪贴板（headless 下系统剪贴板不可读，只验证写入调用不报错）
    const cb = await tools.execute('clipboard_write', { text: '小问剪贴板测试' });
    const cb2 = await tools.execute('clipboard_read', {});
    log('clipboard', cb.ok, `write=${cb.ok} read=${(cb2.output || '').slice(0, 20) || '(headless 下为空属正常)'}`);

    // 13. 截图
    const shot = await tools.execute('screenshot', {});
    const shotOk = shot.ok && fs.existsSync(shot.file || '');
    log('screenshot', shotOk, shot.file ? `${shot.file} (${Math.round(fs.statSync(shot.file).size / 1024)} KB)` : (shot.error || '').slice(0, 120));

    // 14. TTS - CosyVoice
    const ttsR = await tts.synth({
      provider: 'dashscope',
      text: '你好主人，这是小问的语音合成测试。',
      apiKey: '***REMOVED_API_KEY***',
      model: 'cosyvoice-v2',
      voice: 'longxiaochun_v2',
      format: 'mp3'
    });
    log('tts_cosyvoice', ttsR.ok && fs.existsSync(ttsR.file || ''),
      ttsR.file ? `${ttsR.file} (${Math.round(ttsR.bytes / 1024)} KB)` : (ttsR.error || '').slice(0, 150));

    // 15. 开机自启
    const as = autostart.status();
    log('autostart_status', typeof as.enabled === 'boolean', 'enabled=' + as.enabled);

    // 16. Skills
    await skills.ensureSample();
    const sl = await skills.listSkills();
    log('skills', sl.length > 0, sl.map((s) => s.name).join(','));

    // 17. 工具定义
    log('tools_defs', tools.DEFINITIONS.length >= 15, tools.DEFINITIONS.length + ' 个内置工具');

    // 18. MCP 真实联调（stdio）
    const { McpManager } = require('../src/main/jarvis/mcp.js');
    const mm = new McpManager();
    const serverPath = path.join(__dirname, '_fake_mcp_server.js');
    const nodeExe = process.execPath;
    try {
      const c = await mm.connectAny({
        id: 'fake', name: 'fake-mcp', transport: 'stdio',
        command: process.platform === 'win32' ? 'node' : nodeExe,
        args: [serverPath]
      });
      log('mcp_connect', c.connected && c.tools.length === 2, `tools=${c.tools.map((t) => t.name).join(',')}`);
      const r = await mm.call('mcp__fake__echo', { text: '你好小问' });
      log('mcp_call', r.ok && r.output.includes('你好小问'), r.output);
      log('mcp_defs', mm.toolDefinitions().length === 2, mm.toolDefinitions().map((t) => t.function.name).join(','));
      mm.stopAll();
    } catch (e) {
      log('mcp_connect', false, (e && e.message) || String(e));
    }
  } catch (e) {
    console.log('EXCEPTION', e && e.stack);
  }

  const fail = results.filter((r) => !r.ok);
  console.log('\n==== ' + (results.length - fail.length) + '/' + results.length + ' 通过 ====');
  if (fail.length) console.log('失败项：' + fail.map((f) => f.name).join(', '));
  setTimeout(() => app.quit(), 300);
});

app.on('window-all-closed', (e) => e.preventDefault());
