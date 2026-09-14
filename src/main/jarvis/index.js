/**
 * Jarvis 模块统一入口：把所有新能力的 IPC 集中注册在这里。
 * main.js 只需在 app ready 之后调用一次 registerAll()。
 */
const { ipcMain, shell } = require('electron');

const store = require('./store');
const autostart = require('./autostart');
const tts = require('./tts');
const tools = require('./tools');
const skills = require('./skills');
const agent = require('./agent');
const { McpManager } = require('./mcp');
// 桌面宠物（Agent 状态联动用；宠物窗口没开时 petAct 内部会直接返回）
const pet = require('../pet');

const mcp = new McpManager();
agent.bindMcp(mcp);

// 供主进程中断正在进行的 Agent 请求
const abortAgent = () => agent.abortCurrent();

let registered = false;

// 让主进程能读到最新的 config（含 TTS / Agent 设置）
let getConfig = () => ({});
function bindConfig(fn) { getConfig = fn; }

function registerAll() {
  if (registered) return;
  registered = true;

  // ---------------- 开机自启 ----------------
  ipcMain.handle('autostart:get', () => autostart.status());
  ipcMain.handle('autostart:set', (_e, enabled) => autostart.setEnabled(!!enabled));

  // ---------------- 人格 ----------------
  ipcMain.handle('persona:get', () => store.getPersona());
  ipcMain.handle('persona:set', (_e, patch) => store.setPersona(patch));

  // ---------------- 记忆 ----------------
  ipcMain.handle('memory:list', () => store.getMemories());
  ipcMain.handle('memory:add', (_e, m) => store.addMemory(m || {}));
  ipcMain.handle('memory:remove', (_e, id) => store.removeMemory(id));
  ipcMain.handle('memory:clear', () => store.clearMemories());
  ipcMain.handle('memory:search', (_e, q) => store.searchMemories(String(q || ''), 10));

  // ---------------- 会话（短期记忆） ----------------
  ipcMain.handle('session:list', () => {
    const d = store.getSessions();
    return {
      activeId: d.activeId,
      sessions: d.sessions.map((s) => ({
        id: s.id, title: s.title, updatedAt: s.updatedAt, count: (s.messages || []).length
      }))
    };
  });
  ipcMain.handle('session:create', (_e, title) => store.createSession(title));
  ipcMain.handle('session:get', (_e, id) => store.getSession(id));
  ipcMain.handle('session:active', () => store.getActiveSession());
  ipcMain.handle('session:set-active', (_e, id) => store.setActiveSession(id));
  ipcMain.handle('session:rename', (_e, { id, title }) => store.renameSession(id, title));
  ipcMain.handle('session:delete', (_e, id) => store.deleteSession(id));
  ipcMain.handle('session:append', (_e, { id, msg }) => store.appendMessage(id, msg));
  ipcMain.handle('session:set-messages', (_e, { id, messages }) => store.setSessionMessages(id, messages));

  // ---------------- 内置工具 ----------------
  ipcMain.handle('tools:settings-get', () => store.getToolSettings());
  ipcMain.handle('tools:settings-set', (_e, patch) => store.setToolSettings(patch));
  ipcMain.handle('tools:list', () => tools.listTools());
  ipcMain.handle('tools:exec', async (_e, { name, args }) => {
    try {
      return await tools.execute(name, args || {});
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });
  ipcMain.handle('tools:open-file', (_e, p) => {
    if (p) shell.showItemInFolder(String(p));
    return true;
  });

  // ---------------- MCP ----------------
  ipcMain.handle('mcp:list', () => store.getMcpServers());
  ipcMain.handle('mcp:status', () => mcp.status());
  ipcMain.handle('mcp:tools', () => mcp.toolDefinitions());
  ipcMain.handle('mcp:add', async (_e, cfg) => {
    const list = store.getMcpServers();
    const item = {
      id: cfg.id || ('mcp-' + Date.now().toString(36)),
      name: cfg.name || cfg.id || 'MCP Server',
      transport: cfg.transport || 'stdio',
      command: cfg.command || '',
      args: Array.isArray(cfg.args) ? cfg.args : [],
      env: cfg.env || {},
      url: cfg.url || '',
      headers: cfg.headers || {},
      enabled: cfg.enabled !== false
    };
    const idx = list.findIndex((s) => s.id === item.id);
    if (idx >= 0) list[idx] = item; else list.push(item);
    store.saveMcpServers(list);
    if (item.enabled) {
      try { await connectOne(item); } catch (e) { /* 连不上也先存着 */ }
    }
    return store.getMcpServers();
  });
  ipcMain.handle('mcp:remove', async (_e, id) => {
    mcp.stop(id);
    store.saveMcpServers(store.getMcpServers().filter((s) => s.id !== id));
    return store.getMcpServers();
  });
  ipcMain.handle('mcp:connect', async (_e, id) => {
    const cfg = store.getMcpServers().find((s) => s.id === id);
    if (!cfg) return { ok: false, error: '未找到该服务器' };
    try {
      const c = await connectOne(cfg);
      return { ok: true, tools: c.tools.length };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });
  ipcMain.handle('mcp:disconnect', (_e, id) => { mcp.stop(id); return mcp.status(); });
  ipcMain.handle('mcp:connect-all', async () => {
    const list = store.getMcpServers().filter((s) => s.enabled);
    const out = [];
    for (const cfg of list) {
      try { const c = await connectOne(cfg); out.push({ id: cfg.id, ok: true, tools: c.tools.length }); }
      catch (e) { out.push({ id: cfg.id, ok: false, error: (e && e.message) || String(e) }); }
    }
    return out;
  });

  // ---------------- Skills ----------------
  ipcMain.handle('skills:list', () => skills.listSkills());
  ipcMain.handle('skills:load', (_e, id) => skills.loadSkill(id));
  ipcMain.handle('skills:save', (_e, s) => skills.saveSkill(s || {}));
  ipcMain.handle('skills:delete', (_e, id) => skills.deleteSkill(id));
  ipcMain.handle('skills:open-dir', () => { shell.openPath(store.skillsDir()); return true; });

  // ---------------- TTS ----------------
  ipcMain.handle('tts:voices', () => ({
    dashscope: tts.COSY_VOICES,
    openai: tts.OPENAI_VOICES
  }));
  ipcMain.handle('tts:synth', (_e, opts) => {
    const cfg = getConfig() || {};
    return tts.synth({
      provider: (opts && opts.provider) || cfg.ttsProvider || 'web',
      text: (opts && opts.text) || '',
      apiKey: cfg.ttsApiKey || cfg.asrApiKey || '',
      model: cfg.ttsDashModel || 'cosyvoice-v2',
      voice: cfg.ttsDashVoice || 'longxiaochun_v2',
      format: cfg.ttsDashFormat || 'mp3',
      sampleRate: 24000,
      rate: typeof cfg.ttsRate === 'number' ? 1 + cfg.ttsRate / 20 : 1.0,
      volume: typeof cfg.ttsVolume === 'number' ? cfg.ttsVolume : 50,
      baseUrl: cfg.ttsOpenaiBaseUrl || cfg.apiBaseUrl || '',
      openaiKey: cfg.ttsOpenaiKey || cfg.apiKey || '',
      speed: typeof cfg.ttsRate === 'number' ? 1 + cfg.ttsRate / 20 : 1.0
    });
  });
  ipcMain.handle('tts:test', (_e, opts) => {
    const cfg = getConfig() || {};
    return tts.test({
      provider: (opts && opts.provider) || cfg.ttsProvider || 'web',
      apiKey: (opts && opts.apiKey) || cfg.ttsApiKey || cfg.asrApiKey || '',
      model: (opts && opts.model) || cfg.ttsDashModel || 'cosyvoice-v2',
      voice: (opts && opts.voice) || cfg.ttsDashVoice || 'longxiaochun_v2',
      format: cfg.ttsDashFormat || 'mp3',
      baseUrl: (opts && opts.baseUrl) || cfg.ttsOpenaiBaseUrl || cfg.apiBaseUrl || '',
      openaiKey: (opts && opts.openaiKey) || cfg.ttsOpenaiKey || cfg.apiKey || ''
    });
  });

  // ---------------- Agent ----------------
  ipcMain.handle('agent:run', async (event, { messages, sessionId } = {}) => {
    const cfg = getConfig() || {};
    if (!cfg.agentEnabled) {
      return { ok: false, error: 'AGENT_DISABLED' };
    }

    // 宠物 × Agent 联动：把「思考 / 调工具 / 完成 / 失败」演给桌面宠物看
    const link = cfg.petAgentLink !== false;
    const act = (a, o) => {
      if (!link) return;
      try { pet.petAct(a, o); } catch (e) { /* ignore */ }
    };

    return agent.runAgent({
      messages,
      cfg,
      sender: event.sender,
      opts: {
        useTools: cfg.agentUseTools !== false,
        useMcp: cfg.agentUseMcp !== false,
        useSkills: cfg.agentUseSkills !== false,
        useMemory: cfg.agentUseMemory !== false,
        sessionId,
        hooks: {
          onStart: () => act('think'),
          onTool: (p) => act(p && p.status === 'start' ? 'work' : 'think',
            { tool: ((p && p.names) || []).join('、') }),
          onDone: () => act('done'),
          onStop: () => act('idle'),
          onError: () => act('error')
        }
      }
    });
  });
  ipcMain.handle('agent:confirm-reply', (_e, { id, approved }) => agent.resolveConfirm(id, approved));

  // ---------------- 总览 ----------------
  ipcMain.handle('jarvis:status', async () => ({
    autostart: autostart.status().enabled,
    tools: store.getToolSettings(),
    toolCount: tools.DEFINITIONS.length,
    mcp: mcp.status(),
    skills: (await skills.listSkills()).length,
    memories: store.getMemories().length
  }));
}

async function connectOne(cfg) {
  mcp.stop(cfg.id);
  const c = await mcp.connectAny(cfg);
  return c;
}

async function boot() {
  // 首次运行写入示例技能
  try { await skills.ensureSample(); } catch (e) { /* ignore */ }
  // 自动重连已启用的 MCP 服务器
  const list = store.getMcpServers().filter((s) => s.enabled);
  for (const cfg of list) {
    try { await connectOne(cfg); } catch (e) { console.error('[mcp] auto connect failed', cfg.id, e && e.message); }
  }
}

function cleanup() {
  mcp.stopAll();
}

module.exports = { registerAll, bindConfig, boot, cleanup, mcp, abortAgent };
