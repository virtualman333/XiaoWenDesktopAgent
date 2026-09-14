/**
 * 统一的对话请求出口。
 *
 * 规则：**一律走流式**（stream: true）。
 * 原因：有些 OpenAI 兼容网关/服务商明确不支持非流式请求，会直接返回
 *   HTTP 400 · 11101 Non-stream chat request is currently not supported
 * 所以哪怕是「只要一段完整文本」的场景（连通性测试、编排规划、复核判定），
 * 也发流式请求，再把分片拼起来用。
 *
 * 另：个别服务商忽略 stream 参数、直接返回整包 JSON，这里也兼容。
 */

/** 去掉末尾斜杠与多余的 /v1（界面提示里写不写 /v1 都能用） */
function normalizeBaseUrl(base) {
  return String(base || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * 发一次请求并收集完整文本。
 * @returns {Promise<{ok:boolean, text?:string, error?:string, status?:number, raw?:string}>}
 */
async function collectChat({
  baseUrl,
  apiKey,
  model,
  messages,
  temperature = 0.7,
  maxTokens,
  timeoutMs = 60000,
  signal,
  onDelta
} = {}) {
  const root = normalizeBaseUrl(baseUrl);
  if (!root) return { ok: false, error: '接口地址为空' };
  if (!model) return { ok: false, error: '模型名为空' };
  if (!apiKey) return { ok: false, error: 'API Key 为空' };

  // 超时与外部中断合并成一个 signal
  const ctrl = new AbortController();
  let timer = null;
  if (timeoutMs > 0) {
    timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { /* ignore */ } }, timeoutMs);
  }
  if (signal && typeof signal.addEventListener === 'function') {
    const onAbort = () => { try { ctrl.abort(); } catch (e) { /* ignore */ } };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort);
  }

  const body = {
    model,
    messages,
    temperature,
    stream: true           // ← 默认流式，别再改回 false
  };
  if (typeof maxTokens === 'number' && maxTokens > 0) body.max_tokens = maxTokens;

  try {
    const res = await fetch(root + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });

    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: friendlyHttp(res.status, res.statusText, raw), raw };
    }

    // 服务商忽略了 stream、直接给整包 JSON —— 兼容一下
    // （有些 fetch 实现/测试桩没有 headers 或 body，这里也一并兜住）
    const ctype = (res.headers && typeof res.headers.get === 'function')
      ? String(res.headers.get('content-type') || '')
      : '';
    if (ctype.includes('application/json') || !res.body) {
      const raw = await res.text().catch(() => '');
      let text = '';
      try {
        const j = JSON.parse(raw);
        text = j?.choices?.[0]?.message?.content || j?.choices?.[0]?.delta?.content || '';
      } catch (e) { /* ignore */ }
      if (onDelta && text) { try { onDelta(text); } catch (e) { /* ignore */ } }
      return { ok: true, text: String(text || ''), raw };
    }

    // 正常 SSE：逐行解析，把 delta 拼起来
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let full = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith(':')) continue;
        // 允许 "data:" 与 "data: " 两种写法
        let payload = '';
        if (line.startsWith('data:')) payload = line.slice(5).trim();
        else if (line.startsWith('{')) payload = line;   // 有些网关不写 data: 前缀
        else continue;
        if (!payload || payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const delta = j?.choices?.[0]?.delta?.content
            ?? j?.choices?.[0]?.message?.content
            ?? '';
          if (delta) {
            full += delta;
            if (onDelta) { try { onDelta(delta); } catch (e) { /* ignore */ } }
          }
        } catch (e) {
          // 分片不完整就忽略，下一轮会补
        }
      }
    }

    return { ok: true, text: full };
  } catch (e) {
    const m = String((e && e.message) || e);
    if (e && (e.name === 'AbortError' || /aborted/i.test(m))) {
      return { ok: false, aborted: true, error: '已中断' };
    }
    return { ok: false, error: m + netHint(m) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function netHint(m) {
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return '（域名解析失败，检查接口地址是否写错、或网络/DNS 是否正常）';
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket hang up/i.test(m)) return '（连接不上服务器，检查网络、代理，或该地址是否需要代理才能访问）';
  if (/certificate|SSL|TLS/i.test(m)) return '（证书校验失败，可能是代理软件拦截了 HTTPS）';
  return '';
}

/** 把服务端返回的错误整理成人能看懂的一句话 */
function friendlyHttp(status, statusText, raw) {
  let msg = '';
  try {
    const j = JSON.parse(raw);
    msg = j?.error?.message || j?.msg || j?.message || '';
  } catch (e) { /* ignore */ }
  const head = `HTTP ${status} ${statusText || ''}`.trim();
  const tail = msg ? ` · ${msg}` : (raw ? ` · ${String(raw).slice(0, 200)}` : '');
  const hint = /non-stream|stream/i.test(raw)
    ? '（该接口要求流式请求，程序已默认流式；若仍报错请检查接口地址）'
    : '';
  return head + tail + hint;
}

module.exports = { collectChat, normalizeBaseUrl, friendlyHttp };
