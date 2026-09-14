/**
 * 内置工具集 —— 让小问真正能操作这台电脑。
 *
 * 设计原则：
 *   1) 每个工具都是 OpenAI function-calling 的 JSON Schema，模型可以自动调用；
 *   2) 高危操作（执行命令 / 写文件 / 删文件 / 杀进程）走 confirmMode 二次确认；
 *   3) 读操作宽松、写操作受限（只允许 home / userData / 临时目录 / 用户白名单）；
 *   4) 所有输出都做长度截断，避免把上下文撑爆。
 */
const { app, shell, clipboard, Notification, screen } = require('electron');
const { exec, execFile, spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const store = require('./store');

// ---------------- 安全 ----------------
const DANGEROUS_PATTERNS = [
  /format\s+[a-z]:/i,
  /\bdel\s+\/[fs]\b/i,
  /\brm\s+-rf\s+(\/|\*|~)/i,
  /\bshutdown\b/i,
  /\bshutdown\s*\/\s*[sr]/i,
  /\bdiskpart\b/i,
  /\breg\s+(delete|add)\b/i,
  /\bnet\s+user\b/i,
  /\btakeown\b/i,
  /\bcipher\s+\/w/i,
  /\bRemove-Item\s+.*(-Recurse\s+)?(-Force\s+)?(C:\\Windows|C:\\\\|C:\/)/i,
  /\bStop-Computer\b/i,
  /\bRestart-Computer\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i
];

const HOME = os.homedir();
const TMP = os.tmpdir();

function allowedWriteRoots() {
  const s = store.getToolSettings();
  const roots = [HOME, TMP];
  try { roots.push(app.getPath('userData')); } catch (e) { /* ignore */ }
  try { roots.push(app.getPath('downloads')); } catch (e) { /* ignore */ }
  if (Array.isArray(s.allowPaths)) roots.push(...s.allowPaths);
  return roots.map((p) => path.resolve(String(p))).filter(Boolean);
}

function isUnder(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep) || t.startsWith(r + '/');
}

function assertWritable(p) {
  const roots = allowedWriteRoots();
  const target = path.resolve(String(p));
  if (roots.some((r) => isUnder(r, target))) return target;
  const err = new Error(`拒绝写入：${target} 不在允许范围内（允许：用户目录 / 下载 / 临时目录，可在设置里追加白名单）`);
  err.code = 'EPATH';
  throw err;
}

function truncate(s, max) {
  const str = String(s == null ? '' : s);
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n...[已截断，共 ${str.length} 字符]`;
}

// ---------------- 工具实现 ----------------
function runCmd(command, { cwd, shell: shellName, timeoutMs }) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const to = timeoutMs || 30000;
    let cmd, args, opts = { cwd: cwd || HOME, windowsHide: true, maxBuffer: 8 * 1024 * 1024 };

    if (shellName === 'bash' && !isWin) {
      cmd = '/bin/bash'; args = ['-lc', command];
    } else if (shellName === 'cmd' && isWin) {
      cmd = 'cmd.exe'; args = ['/c', command];
    } else if (isWin) {
      cmd = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command];
    } else {
      cmd = '/bin/sh'; args = ['-c', command];
    }

    let settled = false;
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
      resolve({ ok: false, code: null, stdout: out, stderr: err, error: `执行超时（${to / 1000}s）` });
    }, to);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ ok: false, code: null, stdout: out, stderr: err, error: e && e.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: out, stderr: err });
    });
  });
}

function listProcesses() {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin
      ? 'tasklist /FO CSV /NH'
      : 'ps -eo pid,pcpu,pmem,comm --sort=-pcpu';
    exec(cmd, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: isWin ? 'buffer' : 'utf8' }, (e, stdout, stderr) => {
      if (e && !stdout) return resolve({ ok: false, error: (stderr || e.message).toString() });
      let text = Buffer.isBuffer(stdout) ? decodeGbk(stdout) : String(stdout);
      if (isWin) {
        // CSV -> 简洁表格
        const rows = text.split(/\r?\n/).filter(Boolean).slice(0, 60).map((line) => {
          const m = line.match(/^"([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)"/);
          return m ? `${m[2].padEnd(28)} pid=${m[1].padEnd(7)} mem=${m[5]}` : line;
        });
        text = '进程名'.padEnd(28) + '\n' + rows.join('\n');
      } else {
        const rows = text.split(/\r?\n/).slice(0, 60);
        text = rows.join('\n');
      }
      resolve({ ok: true, output: truncate(text, 5000) });
    });
  });
}

function decodeGbk(buf) {
  // tasklist 在中文 Windows 输出 GBK，Buffer 直接 toString 会乱码
  try {
    const iconv = require('iconv-lite');
    return iconv.decode(buf, 'gbk');
  } catch (e) {
    return buf.toString('utf8').replace(/\ufffd/g, '?');
  }
}

/**
 * 截图：优先用 Electron 的 desktopCapturer（支持多屏、缩放、区域框选），
 * 失败再退回系统命令（PowerShell / screencapture / import）。
 */
async function screenshot({ mode, display } = {}) {
  try {
    const capture = require('../capture');
    const displayId = display ? capture.displayIdByIndex(display) : undefined;
    const r = mode === 'region'
      ? await capture.captureRegion({ displayId })
      : await capture.captureFull({ displayId, silent: true });
    if (r && r.ok) return { ok: true, file: r.path, width: r.width, height: r.height };
    // 用户主动取消（Esc）不算失败，但要如实告诉模型
    if (r && r.error && /取消/.test(r.error)) return { ok: false, error: r.error };
    if (r && r.error) console.warn('[screenshot] 主方案失败，回退系统命令：', r.error);
  } catch (e) {
    console.warn('[screenshot] 主方案异常，回退系统命令：', e && e.message);
  }
  return screenshotFallback();
}

async function screenshotFallback() {
  const dir = path.join(app.getPath('userData'), 'jarvis', 'shots');
  try { await fsp.mkdir(dir, { recursive: true }); } catch (e) { /* ignore */ }
  const file = path.join(dir, 'shot-' + Date.now() + '.png');
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';

  if (isWin) {
    const ps = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save("${file.replace(/\\/g, '\\\\')}", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "OK"
`.trim();
    const r = await runCmd(ps, { timeoutMs: 15000, shell: 'powershell' });
    if (fs.existsSync(file)) return { ok: true, file };
    return { ok: false, error: (r.stderr || r.error || '截图失败').toString().slice(0, 300) };
  }
  if (isMac) {
    const r = await runCmd(`screencapture -x "${file}"`, { timeoutMs: 15000 });
    if (fs.existsSync(file)) return { ok: true, file };
    return { ok: false, error: (r.stderr || r.error || '截图失败').toString() };
  }
  const r = await runCmd(`import -window root "${file}" || gnome-screenshot -f "${file}" || scrot "${file}"`, { timeoutMs: 15000 });
  if (fs.existsSync(file)) return { ok: true, file };
  return { ok: false, error: '未找到可用的截图工具（需 import / gnome-screenshot / scrot）' };
}

async function walk(dir, { maxDepth, maxEntries, pattern }) {
  const results = [];
  const re = pattern ? new RegExp(pattern, 'i') : null;
  const stack = [{ d: dir, depth: 0 }];
  while (stack.length && results.length < maxEntries) {
    const { d, depth } = stack.pop();
    let entries = [];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (!re || re.test(ent.name)) results.push({ path: full, type: ent.isDirectory() ? 'dir' : 'file' });
      if (results.length >= maxEntries) break;
      if (ent.isDirectory() && depth < maxDepth) stack.push({ d: full, depth: depth + 1 });
    }
  }
  return results;
}

// ---------------- 工具定义（function calling schema） ----------------
const DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_datetime',
      description: '获取当前日期、时间、星期几。涉及"今天/明天/现在几点"的问题先调用它。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'system_info',
      description: '获取本机信息：系统版本、主机名、用户名、CPU 型号、内存总量与剩余、电池状态。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'shell_exec',
      description: '在电脑上执行命令（Windows 默认 PowerShell，可切 cmd；macOS/Linux 为 sh/bash）。可用于查进程、查网络、跑脚本、装软件等。高危命令会被拦截，需要主人确认。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          shell: { type: 'string', enum: ['powershell', 'cmd', 'bash', 'sh'], description: '使用哪种 shell，默认按系统自动选择' },
          cwd: { type: 'string', description: '工作目录，默认用户主目录' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_list',
      description: '列出目录内容，或按文件名模糊搜索文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径，默认用户主目录' },
          pattern: { type: 'string', description: '文件名正则（可选），给定时会递归搜索' },
          maxDepth: { type: 'number', description: '递归深度，默认 2' },
          limit: { type: 'number', description: '最多返回多少条，默认 60' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_read',
      description: '读取文本文件内容。默认读前 200 行，可用 offset/limit 分页。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' },
          offset: { type: 'number', description: '从第几行开始（0 基），默认 0' },
          limit: { type: 'number', description: '读取行数，默认 200' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_write',
      description: '写入或追加文本文件。只允许写入用户目录、下载目录、临时目录或白名单目录。需要主人确认。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' },
          content: { type: 'string', description: '文件内容' },
          mode: { type: 'string', enum: ['overwrite', 'append'], description: '覆盖或追加，默认覆盖' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_delete',
      description: '删除文件或空目录。仅限允许目录内，需要主人确认。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '要删除的路径' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'app_open',
      description: '打开应用、文件或网址。Windows 上可以是 exe 名（如 notepad、calc）、完整路径，或 http(s) 链接。',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string', description: '应用名 / 文件路径 / 网址' } },
        required: ['target']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'process_list',
      description: '列出正在运行的进程（按 CPU 占用排序，最多 60 条）。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'process_kill',
      description: '结束指定 PID 的进程。需要主人确认。',
      parameters: {
        type: 'object',
        properties: { pid: { type: 'number', description: '进程 PID' } },
        required: ['pid']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description: '截取屏幕画面并保存为 PNG（同时复制到剪贴板）。mode=full 直接截光标所在的整块屏幕；mode=region 会弹框选窗口请主人选区域。想了解屏幕上有什么、帮主人看界面/报错时用。',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['full', 'region'], description: 'full=整屏（默认），region=弹框让主人选区域' },
          display: { type: 'number', description: '第几块屏幕，从 1 开始；留空截光标所在屏幕' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'clipboard_read',
      description: '读取剪贴板文本内容。',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'clipboard_write',
      description: '把文本写入剪贴板。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要写入的文本' } },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notify',
      description: '弹出一条系统通知。适合告知主人任务已完成。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '通知标题' },
          body: { type: 'string', description: '通知内容' }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_add',
      description: '把一条关于主人的重要信息存入长期记忆，以后每次对话都能想起来。主人说"记住…"、"以后都…"时务必调用。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要记住的内容，一句完整的话' },
          category: { type: 'string', enum: ['fact', 'preference', 'person', 'task', 'other'], description: '分类' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签，便于检索' }
        },
        required: ['content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_search',
      description: '检索长期记忆，找关于主人的已知信息。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '检索关键词或问题' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'http_request',
      description: '发起 HTTP 请求，用于查接口、抓网页。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整 URL' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: '默认 GET' },
          headers: { type: 'object', description: '请求头' },
          body: { type: 'string', description: '请求体（POST/PUT）' }
        },
        required: ['url']
      }
    }
  }
];

// ---------------- 执行 ----------------
async function httpRequest({ url, method, headers, body }) {
  const http = require('http');
  const https = require('https');
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return { ok: false, error: 'URL 不合法' }; }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      hostname: u.hostname, port: u.port || undefined,
      path: u.pathname + (u.search || ''), method: method || 'GET',
      headers: headers || {}, timeout: 20000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ ok: true, status: res.statusCode, body: truncate(Buffer.concat(chunks).toString('utf-8'), 8000) }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e && e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '请求超时' }); });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 统一执行入口。
 * 外面包一层 try/catch：像「越权写入」这类同步抛出的错误也要变成
 * { ok:false } 返回给模型，否则会把整个 Agent 循环打断。
 */
async function execute(name, args = {}) {
  try {
    return await executeInner(name, args || {});
  } catch (e) {
    const msg = (e && e.message) || String(e);
    return { ok: false, error: msg };
  }
}

async function executeInner(name, args) {
  const s = store.getToolSettings();
  switch (name) {
    case 'get_datetime': {
      const d = new Date();
      const week = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][d.getDay()];
      return { ok: true, output: `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${week} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}` };
    }
    case 'system_info': {
      const cpus = os.cpus();
      return {
        ok: true,
        output: [
          `系统：${os.type()} ${os.release()} (${os.platform()}/${os.arch()})`,
          `主机名：${os.hostname()}`,
          `用户：${os.userInfo().username}`,
          `CPU：${cpus[0] ? cpus[0].model : '未知'} × ${cpus.length} 核`,
          `内存：${(os.totalmem() / 1073741824).toFixed(1)} GB 总量，${(os.freemem() / 1073741824).toFixed(1)} GB 可用`,
          `已运行：${Math.round(os.uptime() / 60)} 分钟`
        ].join('\n')
      };
    }
    case 'shell_exec': {
      const cmd = String(args.command || '');
      if (!cmd.trim()) return { ok: false, error: '命令为空' };
      const hit = DANGEROUS_PATTERNS.find((re) => re.test(cmd));
      if (hit) return { ok: false, error: `已拦截高危命令（匹配 ${hit}），如需执行请让主人手动操作` };
      const r = await runCmd(cmd, { cwd: args.cwd, shell: args.shell, timeoutMs: s.shellTimeoutMs });
      const text = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
      return { ok: r.ok, output: truncate(text || '(无输出)', s.maxOutputChars), code: r.code, error: r.error };
    }
    case 'file_list': {
      const base = args.path ? path.resolve(String(args.path)) : HOME;
      const limit = Math.min(Math.max(Number(args.limit) || 60, 1), 300);
      if (args.pattern) {
        const res = await walk(base, { maxDepth: Math.min(Number(args.maxDepth) || 2, 6), maxEntries: limit, pattern: String(args.pattern) });
        return { ok: true, output: res.map((r) => `${r.type === 'dir' ? '[D]' : '[F]'} ${r.path}`).join('\n') || '(无匹配)' };
      }
      let entries = [];
      try { entries = await fsp.readdir(base, { withFileTypes: true }); } catch (e) { return { ok: false, error: e && e.message }; }
      const lines = entries.slice(0, limit).map((e) => {
        const full = path.join(base, e.name);
        let size = '';
        try { if (e.isFile()) size = ` ${fs.statSync(full).size} B`; } catch (err) { /* ignore */ }
        return `${e.isDirectory() ? '[D]' : '[F]'} ${e.name}${size}`;
      });
      return { ok: true, output: lines.join('\n') || '(空目录)' };
    }
    case 'file_read': {
      const p = path.resolve(String(args.path || ''));
      if (!p) return { ok: false, error: '缺少路径' };
      try {
        const raw = await fsp.readFile(p, 'utf-8');
        const lines = raw.split(/\r?\n/);
        const off = Math.max(0, Number(args.offset) || 0);
        const lim = Math.min(Math.max(Number(args.limit) || 200, 1), 2000);
        const slice = lines.slice(off, off + lim);
        return { ok: true, output: truncate(slice.map((l, i) => `${off + i + 1}: ${l}`).join('\n'), s.maxOutputChars) };
      } catch (e) { return { ok: false, error: e && e.message }; }
    }
    case 'file_write': {
      const target = assertWritable(args.path);
      try {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        if (args.mode === 'append') await fsp.appendFile(target, String(args.content), 'utf-8');
        else await fsp.writeFile(target, String(args.content), 'utf-8');
        return { ok: true, output: `已写入 ${target}` };
      } catch (e) { return { ok: false, error: (e && e.message) || '写入失败' }; }
    }
    case 'file_delete': {
      const target = assertWritable(args.path);
      try {
        const st = await fsp.stat(target);
        if (st.isDirectory()) await fsp.rm(target, { recursive: true, force: true });
        else await fsp.unlink(target);
        return { ok: true, output: `已删除 ${target}` };
      } catch (e) { return { ok: false, error: (e && e.message) || '删除失败' }; }
    }
    case 'app_open': {
      const t = String(args.target || '');
      if (!t) return { ok: false, error: '缺少目标' };
      if (/^https?:\/\//i.test(t)) { await shell.openExternal(t); return { ok: true, output: `已在浏览器打开 ${t}` }; }
      if (fs.existsSync(t)) {
        const err = await shell.openPath(t);
        return err ? { ok: false, error: err } : { ok: true, output: `已打开 ${t}` };
      }
      // 当成命令名，交给系统解析
      if (process.platform === 'win32') {
        try {
          exec(`start "" "${t}"`, { windowsHide: true });
          return { ok: true, output: `已尝试启动 ${t}` };
        } catch (e) { return { ok: false, error: e && e.message }; }
      }
      const r = await runCmd(process.platform === 'darwin' ? `open -a "${t}"` : `${t} &`, { timeoutMs: 8000 });
      return r.ok || !r.error ? { ok: true, output: `已尝试启动 ${t}` } : { ok: false, error: (r.stderr || r.error).toString() };
    }
    case 'process_list': return listProcesses();
    case 'process_kill': {
      const pid = Number(args.pid);
      if (!pid) return { ok: false, error: 'PID 无效' };
      try { process.kill(pid, 'SIGTERM'); return { ok: true, output: `已结束进程 ${pid}` }; }
      catch (e) { return { ok: false, error: e && e.message }; }
    }
    case 'screenshot': {
      const r = await screenshot({ mode: args.mode, display: args.display });
      if (!r.ok) return r;
      try { require('electron').clipboard.writeImage(require('electron').nativeImage.createFromPath(r.file)); } catch (e) { /* ignore */ }
      return { ok: true, output: `截图已保存：${r.file}（${r.width || '?'}×${r.height || '?'}，已复制到剪贴板）`, file: r.file };
    }
    case 'clipboard_read': {
      let text = '';
      try { text = clipboard.readText() || ''; } catch (e) { /* ignore */ }
      // 无窗口时 Electron 的剪贴板偶尔读不到，用系统命令兜底
      if (!text && process.platform === 'win32') {
        const r = await runCmd('Get-Clipboard -Raw', { timeoutMs: 5000, shell: 'powershell' });
        text = (r.stdout || '').replace(/\r?\n$/, '');
      } else if (!text && process.platform === 'darwin') {
        const r = await runCmd('pbpaste', { timeoutMs: 5000 });
        text = r.stdout || '';
      }
      return { ok: true, output: truncate(text || '(空)', 8000) };
    }
    case 'clipboard_write': {
      const t = String(args.text || '');
      try { clipboard.writeText(t); } catch (e) { /* ignore */ }
      if (process.platform === 'win32') {
        // Set-Clipboard 对特殊字符更稳，用 -Value 传参避免转义问题
        try {
          execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value $env:XW_CLIP'],
            { env: { ...process.env, XW_CLIP: t }, windowsHide: true, timeout: 5000 });
        } catch (e) { /* ignore */ }
      } else if (process.platform === 'darwin') {
        try { execFile('pbcopy', [], { windowsHide: true }); } catch (e) { /* ignore */ }
      }
      return { ok: true, output: `已写入剪贴板（${t.length} 字符）` };
    }
    case 'notify': {
      try {
        if (Notification.isSupported()) new Notification({ title: String(args.title || '小问'), body: String(args.body || '') }).show();
      } catch (e) { /* ignore */ }
      return { ok: true, output: '通知已弹出' };
    }
    case 'memory_add': {
      const m = store.addMemory({ content: args.content, category: args.category, tags: args.tags, source: 'agent' });
      return m ? { ok: true, output: `已记住：${m.content}` } : { ok: false, error: '内容为空' };
    }
    case 'memory_search': {
      const list = store.searchMemories(String(args.query || ''), 10);
      return { ok: true, output: list.length ? list.map((m) => `- ${m.content}`).join('\n') : '没有找到相关记忆' };
    }
    case 'http_request': return httpRequest(args);
    default:
      return { ok: false, error: `未知工具：${name}` };
  }
}

/** 给渲染进程/模型用的工具描述（附带来源信息，便于界面展示） */
function listTools() {
  return DEFINITIONS.map((d) => ({
    name: d.function.name,
    description: d.function.description,
    danger: store.getToolSettings().dangerTools.includes(d.function.name)
  }));
}

module.exports = {
  DEFINITIONS,
  execute,
  listTools,
  DANGEROUS_PATTERNS,
  allowedWriteRoots
};
