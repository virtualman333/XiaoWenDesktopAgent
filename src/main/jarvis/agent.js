/**
 * Agent 循环 —— 让模型能自主调用工具（内置 / MCP / Skills），像贾维斯一样干活。
 *
 * 流程：
 *   组装 system prompt（人格 + 长期记忆 + 技能清单）
 *     → 流式请求模型（带 tools）
 *     → 若返回 tool_calls：执行工具、把结果作为 tool 消息回灌、再请求
 *     → 直到模型不再调用工具（或达到最大轮数）
 *
 * 高危工具在执行前会向渲染进程发 agent:confirm 请求，等主人点确认。
 */
const tools = require('./tools');
const skills = require('./skills');
const store = require('./store');

let mcpManager = null;
function bindMcp(m) { mcpManager = m; }

// ---------------- 确认机制 ----------------
const pendingConfirms = new Map();

function requestConfirm(sender, { id, toolName, args, reason }) {
  return new Promise((resolve) => {
    pendingConfirms.set(id, resolve);
    try { sender && !sender.isDestroyed() && sender.send('agent:confirm', { id, toolName, args, reason }); }
    catch (e) { pendingConfirms.delete(id); return resolve(false); }
    setTimeout(() => {
      if (pendingConfirms.has(id)) { pendingConfirms.delete(id); resolve(false); }
    }, 120000);
  });
}

function resolveConfirm(id, approved) {
  const r = pendingConfirms.get(id);
  if (r) { pendingConfirms.delete(id); r(!!approved); return true; }
  return false;
}

// ---------------- 工具定义 ----------------
const SKILL_TOOL = {
  type: 'function',
  function: {
    name: 'load_skill',
    description: '读取某个技能的完整指令。当你判断某个技能能更好完成主人交代的任务时调用它。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '技能 id' } },
      required: ['id']
    }
  }
};

function normalizeBaseUrl(base) {
  return String(base || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

const ROLE_MAP = { ai: 'assistant' };
function sanitizeMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => ({ ...m, role: ROLE_MAP[m.role] || m.role }))
    .filter((m) => ['system', 'user', 'assistant', 'tool', 'function'].includes(m.role))
    .map((m) => (m.role === 'assistant' && m.tool_calls ? { role: 'assistant', content: m.content || '', tool_calls: m.tool_calls } : m));
}

function toolNameOf(name) {
  return String(name || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

// ---------------- 单次流式请求 ----------------
async function chatOnce({ baseUrl, apiKey, model, messages, toolDefs, sender, signal, temperature, quiet }) {
  const body = {
    model,
    messages,
    stream: true,
    temperature: typeof temperature === 'number' ? temperature : 0.7
  };
  if (toolDefs && toolDefs.length) {
    body.tools = toolDefs;
    body.tool_choice = 'auto';
  }

  const res = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok || !res.body) {
    const raw = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${res.statusText}：${raw.slice(0, 400)}`);
    err.status = res.status;
    err.raw = raw;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let text = '';
  const toolCalls = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let json;
      try { json = JSON.parse(payload); } catch { continue; }
      const choice = json && json.choices && json.choices[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.content) {
        text += delta.content;
        // quiet：子代理 / 主管内部的中间调用，不要把碎片文本刷到主人的面板上
        if (!quiet) {
          try { sender && !sender.isDestroyed() && sender.send('chat:delta', delta.content); } catch (e) { /* ignore */ }
        }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : toolCalls.length;
          if (!toolCalls[idx]) toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function && tc.function.name) toolCalls[idx].function.name += tc.function.name;
          if (tc.function && tc.function.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
        }
      }
      // 有些实现把 tool_calls 放在 message 上（非流式增量）
      if (!delta.tool_calls && choice.message && Array.isArray(choice.message.tool_calls)) {
        toolCalls.push(...choice.message.tool_calls);
      }
    }
  }

  const validCalls = toolCalls
    .filter((t) => t && t.function && t.function.name)
    .map((t) => ({
      id: t.id || ('call_' + Math.random().toString(36).slice(2, 10)),
      type: 'function',
      function: { name: toolNameOf(t.function.name), arguments: t.function.arguments || '{}' }
    }));

  return { text, toolCalls: validCalls };
}

// ---------------- 工具执行 ----------------
async function runOneTool(call, { sender, settings, sessionId, intercept, workerId }) {
  const name = call.function.name;
  let args = {};
  try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) { args = {}; }

  // 上层接管的虚拟工具（例如子代理向主管请示）：返回 null 表示继续走正常执行
  if (typeof intercept === 'function') {
    try {
      const hijacked = await intercept(name, args, call);
      if (hijacked !== null && hijacked !== undefined) {
        const out = String((hijacked && hijacked.content) || '');
        try {
          sender && !sender.isDestroyed() && sender.send('agent:tool', {
            id: call.id, name, args, status: 'result', ok: true,
            output: out.slice(0, 3000), virtual: true, workerId: workerId || null
          });
        } catch (e) { /* ignore */ }
        return { role: 'tool', tool_call_id: call.id, name, content: out };
      }
    } catch (e) {
      return { role: 'tool', tool_call_id: call.id, name, content: `请示失败：${(e && e.message) || e}` };
    }
  }

  const isDanger = settings.dangerTools.includes(name);
  const needConfirm = settings.confirmMode === 'all'
    || (settings.confirmMode === 'danger' && isDanger);

  const emit = (payload) => {
    try { sender && !sender.isDestroyed() && sender.send('agent:tool', { ...payload, workerId: workerId || null }); } catch (e) { /* ignore */ }
  };
  emit({ id: call.id, name, args, status: 'start', danger: isDanger });

  if (needConfirm) {
    const ok = await requestConfirm(sender, { id: call.id, toolName: name, args, reason: isDanger ? '高危操作' : '工具调用' });
    if (!ok) {
      emit({ id: call.id, name, args, status: 'rejected' });
      return { role: 'tool', tool_call_id: call.id, name, content: '主人拒绝了这次操作，不要再尝试同样的动作。' };
    }
  }

  let result;
  try {
    if (name === 'load_skill') {
      const s = await skills.loadSkill(String(args.id || ''));
      result = s
        ? { ok: true, output: `已加载技能「${s.name}」：\n\n${s.content}` }
        : { ok: false, error: `技能 ${args.id} 不存在` };
    } else if (name.startsWith('mcp__')) {
      result = mcpManager ? await mcpManager.call(name, args) : { ok: false, error: 'MCP 未启用' };
    } else {
      result = await tools.execute(name, args);
    }
  } catch (e) {
    const msg = e && e.code === 'EPATH' ? e.message : (e && e.message) || String(e);
    result = { ok: false, error: msg };
  }

  const content = result.ok ? (result.output || '(执行成功，无输出)') : `执行失败：${result.error || '未知错误'}`;
  emit({ id: call.id, name, args, status: 'result', ok: !!result.ok, output: String(content).slice(0, 3000) });
  return { role: 'tool', tool_call_id: call.id, name, content: String(content) };
}

// ---------------- 请求中断 ----------------
let activeAbort = null;
function abortCurrent() {
  if (activeAbort) {
    try { activeAbort.abort(); } catch (e) { /* ignore */ }
    activeAbort = null;
    return true;
  }
  return false;
}

// ---------------- 主循环 ----------------
async function runAgent({ messages, cfg, sender, signal, opts = {} }) {
  const settings = store.getToolSettings();
  const baseUrl = normalizeBaseUrl(cfg.apiBaseUrl);
  const apiKey = cfg.apiKey;
  const model = cfg.model;

  if (!baseUrl || !model) return { ok: false, error: '请先在设置中填写接口地址与模型名' };
  if (!apiKey) return { ok: false, error: '请先在设置中配置 API Key' };

  // system prompt：人格 + 记忆 + 技能
  const parts = [];
  const persona = store.personaPrompt();
  if (persona) parts.push(persona);
  const query = (messages || []).filter((m) => m.role === 'user').slice(-2).map((m) => m.content).join(' ');
  if (opts.useMemory !== false) {
    const mem = store.memoryPrompt(query, 8);
    if (mem) parts.push(mem);
  }
  if (opts.useSkills !== false) {
    const sk = await skills.skillsPrompt();
    if (sk) parts.push(sk);
  }
  parts.push(
    '你拥有操作这台电脑的工具能力。规则：',
    '1. 需要真实信息（时间、文件、进程、命令结果）时，先调用工具，不要凭空回答。',
    '2. 一次可以调用多个工具，能并行的就并行。',
    '3. 工具失败时换一种方式重试，最多两次。',
    '4. 最后用自然语言向主人汇报结果，不要罗列原始工具输出。'
  );
  // 子代理 / 编排场景追加的角色指令
  if (opts.systemExtra) parts.push(String(opts.systemExtra));
  const systemMsg = { role: 'system', content: parts.join('\n\n') };

  // 工具清单
  let toolDefs = [];
  if (opts.useTools !== false && settings.enabled) {
    toolDefs = tools.DEFINITIONS.slice();
    if (opts.useSkills !== false) toolDefs.push(SKILL_TOOL);
    if (opts.useMcp !== false && mcpManager) toolDefs = toolDefs.concat(mcpManager.toolDefinitions());
  }
  if (Array.isArray(opts.extraTools) && opts.extraTools.length) toolDefs = toolDefs.concat(opts.extraTools);
  if (Array.isArray(opts.dropTools) && opts.dropTools.length) {
    toolDefs = toolDefs.filter((t) => !opts.dropTools.includes(t.function.name));
  }

  const history = sanitizeMessages(messages);
  const convo = [systemMsg, ...history.filter((m) => m.role !== 'system')];

  let fullText = '';
  let rounds = 0;
  const MAX_ROUNDS = opts.maxRounds || 8;

  // 外部状态钩子（宠物联动 / UI 指示器等），任何异常都不允许影响主流程
  const hooks = opts.hooks || {};
  const fire = (name, payload) => {
    try {
      const fn = hooks[name];
      if (typeof fn === 'function') fn(payload || {});
    } catch (e) { /* ignore */ }
  };

  const controller = new AbortController();
  activeAbort = controller;
  const sig = signal || controller.signal;

  fire('onStart');

  try {
    while (rounds < MAX_ROUNDS) {
      rounds++;
      const { text, toolCalls } = await chatOnce({
        baseUrl, apiKey, model, messages: convo, toolDefs, sender, signal: sig,
        temperature: cfg.temperature, quiet: opts.quiet === true
      });
      if (text) fullText += text;

      if (!toolCalls.length) break;

      convo.push({
        role: 'assistant',
        content: text || '',
        tool_calls: toolCalls
      });

      const toolNames = toolCalls.map((c) => (c.function && c.function.name) || '').filter(Boolean);
      fire('onTool', { names: toolNames, status: 'start' });
      for (const call of toolCalls) {
        const msg = await runOneTool(call, {
          sender, settings, sessionId: opts.sessionId,
          intercept: opts.intercept, workerId: opts.workerId || null
        });
        convo.push(msg);
      }
      fire('onTool', { names: toolNames, status: 'end' });
      // 工具执行完后再生成时，不要重复播报已有内容
    }

    fire('onDone', { text: fullText, rounds });
    return { ok: true, text: fullText, rounds, toolRounds: rounds - 1 };
  } catch (e) {
    if (e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || e)))) {
      fire('onStop');
      return { ok: false, aborted: true, error: '已停止' };
    }
    const m = String((e && e.message) || e);
    // 模型不支持 tools：降级提示
    if (e && e.status === 400 && /tool/i.test(e.raw || '')) {
      fire('onError', { error: '不支持函数调用' });
      return { ok: false, error: '当前模型/接口不支持函数调用，请关闭「Agent 工具能力」后重试。' };
    }
    fire('onError', { error: m });
    return { ok: false, error: m };
  } finally {
    if (activeAbort === controller) activeAbort = null;
    pendingConfirms.clear();
  }
}

module.exports = { runAgent, bindMcp, resolveConfirm, abortCurrent };
