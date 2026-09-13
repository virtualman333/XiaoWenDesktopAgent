/**
 * MCP（Model Context Protocol）客户端
 *
 * 支持两种 transport：
 *   - stdio ：本地进程（npx / node / python ...），按行读 JSON-RPC
 *   - http  ：远程 Streamable HTTP，POST 一条 JSON-RPC，响应为 JSON 或 SSE
 *
 * 只实现 Agent 真正需要的三个方法：initialize / tools/list / tools/call。
 */
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');

let requestSeq = 0;

class McpClient {
  constructor(cfg) {
    this.cfg = cfg;                 // { id, name, transport, command, args, env, url, headers, enabled }
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.ready = false;
    this.serverInfo = null;
    this.tools = [];
    this.lastError = null;
    this.protocolVersion = '2024-11-05';
  }

  get id() { return this.cfg.id; }
  get name() { return this.cfg.name || this.cfg.id; }
  get connected() { return this.ready && (this.cfg.transport === 'http' || !!(this.child && !this.child.killed)); }

  // ---------- stdio ----------
  startStdio() {
    return new Promise((resolve, reject) => {
      const { command, args = [], env = {} } = this.cfg;
      if (!command) return reject(new Error('缺少启动命令'));
      let cmd = command;
      let argv = args;
      let useShell = false;
      // Windows 上 npx/node/python 都是 .cmd 或 .exe，spawn 不会自动解析 PATHEXT。
      // 直接拼 .cmd 也不可靠（node 是 .exe、npx 是 .cmd），所以交给 cmd.exe 解析。
      if (process.platform === 'win32' && !/\.(cmd|exe|bat|ps1)$/i.test(command)) useShell = true;
      try {
        this.child = spawn(cmd, argv, {
          env: { ...process.env, ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: useShell
        });
      } catch (e) { return reject(e); }

      this.child.stdout.on('data', (d) => {
        this.buffer += d.toString('utf-8');
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (line) this._onLine(line);
        }
      });
      this.child.stderr.on('data', (d) => {
        const s = d.toString('utf-8').trim();
        if (s) this.lastError = s.slice(0, 500);
      });
      this.child.on('error', (e) => { this.lastError = e.message; reject(e); });
      this.child.on('exit', () => { this.ready = false; });

      this._handshake().then(resolve).catch(reject);
    });
  }

  _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch (e) { return; }
    if (msg.id !== undefined && this.pending.has(String(msg.id))) {
      const p = this.pending.get(String(msg.id));
      this.pending.delete(String(msg.id));
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  }

  _sendStdio(obj) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.killed) return reject(new Error('MCP 进程未运行'));
      const id = String(++requestSeq);
      this.pending.set(id, { resolve, reject });
      const payload = JSON.stringify({ ...obj, id });
      try { this.child.stdin.write(payload + '\n'); } catch (e) { this.pending.delete(id); reject(e); }
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('MCP 请求超时')); }
      }, 30000);
    });
  }

  // ---------- http ----------
  _sendHttp(obj) {
    return new Promise((resolve, reject) => {
      const u = new URL(this.cfg.url);
      const mod = u.protocol === 'http:' ? http : https;
      const body = JSON.stringify({ ...obj, id: ++requestSeq, jsonrpc: '2.0' });
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
        ...(this.cfg.headers || {})
      };
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
      const req = mod.request({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + (u.search || ''), method: 'POST', headers, timeout: 30000 }, (res) => {
        const sid = res.headers['mcp-session-id'];
        if (sid) this.sessionId = sid;
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          // SSE 格式：event: message\ndata: {...}
          const dataLine = raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          const text = dataLine || raw;
          try {
            const msg = JSON.parse(text);
            if (msg.error) return reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            resolve(msg.result);
          } catch (e) {
            reject(new Error('无法解析响应：' + text.slice(0, 200)));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('MCP 请求超时')); });
      req.write(body);
      req.end();
    });
  }

  _send(obj) {
    return this.cfg.transport === 'http' ? this._sendHttp(obj) : this._sendStdio(obj);
  }

  async _handshake() {
    const result = await this._send({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: this.protocolVersion,
        capabilities: { tools: {} },
        clientInfo: { name: 'xiaowen-assistant', version: '1.1.0' }
      }
    });
    this.serverInfo = result && result.serverInfo;
    if (result && result.protocolVersion) this.protocolVersion = result.protocolVersion;
    // 通知服务端已初始化（不需要回执）
    try { this._send({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => {}); } catch (e) { /* ignore */ }
    this.ready = true;
    await this.refreshTools();
    return this.serverInfo;
  }

  async refreshTools() {
    const r = await this._send({ jsonrpc: '2.0', method: 'tools/list', params: {} });
    this.tools = (r && r.tools) || [];
    return this.tools;
  }

  async callTool(name, args) {
    const r = await this._send({ jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args || {} } });
    if (!r) return { ok: false, error: 'MCP 返回为空' };
    const content = (r.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
    return { ok: !r.isError, output: content || '(无输出)' };
  }

  stop() {
    this.ready = false;
    if (this.child && !this.child.killed) {
      try { this.child.kill(); } catch (e) { /* ignore */ }
    }
    this.child = null;
    this.pending.clear();
  }
}

// ---------------- 管理器 ----------------
class McpManager {
  constructor() {
    this.clients = new Map();
  }

  async connect(cfg) {
    const client = new McpClient(cfg);
    await client.startStdio();
    this.clients.set(cfg.id, client);
    return client;
  }

  async connectHttp(cfg) {
    const client = new McpClient({ ...cfg, transport: 'http' });
    await client._handshake();
    this.clients.set(cfg.id, client);
    return client;
  }

  async connectAny(cfg) {
    const c = new McpClient(cfg);
    if (cfg.transport === 'http') await c._handshake();
    else await c.startStdio();
    this.clients.set(cfg.id, c);
    return c;
  }

  stop(id) {
    const c = this.clients.get(id);
    if (c) { c.stop(); this.clients.delete(id); }
  }

  stopAll() {
    for (const c of this.clients.values()) c.stop();
    this.clients.clear();
  }

  status() {
    return [...this.clients.values()].map((c) => ({
      id: c.id,
      name: c.name,
      transport: c.cfg.transport || 'stdio',
      connected: c.connected,
      toolCount: c.tools.length,
      tools: c.tools.map((t) => t.name),
      lastError: c.lastError,
      serverInfo: c.serverInfo
    }));
  }

  /** 汇总所有已连接服务器的工具，转成 OpenAI function-calling 格式 */
  toolDefinitions() {
    const out = [];
    for (const c of this.clients.values()) {
      if (!c.connected) continue;
      for (const t of c.tools) {
        out.push({
          type: 'function',
          function: {
            name: 'mcp__' + c.id + '__' + t.name,
            description: `[MCP:${c.name}] ${t.description || t.name}`,
            parameters: t.inputSchema && Object.keys(t.inputSchema).length ? t.inputSchema : { type: 'object', properties: {} }
          }
        });
      }
    }
    return out;
  }

  async call(fullName, args) {
    const m = /^mcp__(.+?)__(.+)$/.exec(fullName);
    if (!m) return { ok: false, error: '工具名不合法：' + fullName };
    const c = this.clients.get(m[1]);
    if (!c) return { ok: false, error: 'MCP 服务器未连接：' + m[1] };
    return c.callTool(m[2], args);
  }
}

module.exports = { McpManager, McpClient };
