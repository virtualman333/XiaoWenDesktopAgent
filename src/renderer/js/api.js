/**
 * 大模型调用（走主进程）
 *
 * 为什么不在渲染进程直接 fetch：
 *   渲染进程只能拿到脱敏后的 Key（形如 "sk-abc***wxyz"），
 *   直接用它请求会被服务端判为 key 无效（HTTP 401）。
 *   真实 Key 只保留在主进程，渲染进程只传「消息内容」。
 */

/**
 * 流式对话
 * @param {object} opts
 * @param {Array}  opts.messages [{role, content}]
 * @param {AbortSignal} [opts.signal]  目前仅用于界面层取消（主进程会自然收尾）
 * @param {(delta:string, full:string)=>void} opts.onDelta
 * @returns {Promise<string>} 完整回答
 */
export async function streamChat({ messages, onDelta }) {
  let full = '';
  let failed = null;

  // 逐片接收主进程推送的分片
  const off = window.xw.onChatDelta((delta) => {
    full += delta;
    onDelta && onDelta(delta, full);
  });

  try {
    const res = await window.xw.chatStream(messages);
    if (!res || res.ok !== true) {
      const err = new Error((res && res.error) || '未知错误');
      // 标记「用户主动停止」，让界面显示为已停止而不是报错
      if (res && res.aborted) err.aborted = true;
      throw err;
    }
    // 以主进程返回的完整文本为准（避免分片丢失）
    if (res.text) full = res.text;
    return full;
  } finally {
    off && off();
  }
}

/** 中断当前流式请求 */
export function abortChat() {
  try {
    return window.xw.chatAbort();
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * 非流式调用，用于「测试连接」
 * @param {object} opts
 * @param {string} [opts.baseUrl] 界面当前填写的地址（可能还没保存）
 * @param {string} [opts.model]
 * @param {string} [opts.apiKey]  界面当前填写的 Key；传 '__KEEP__' 表示沿用已保存的
 * @returns {Promise<string>} 模型回复
 */
export async function testConnection({ baseUrl, model, apiKey }) {
  const res = await window.xw.chatTest({ baseUrl, model, apiKey });
  if (!res || res.ok !== true) {
    throw new Error((res && res.error) || '未知错误');
  }
  return res.text || '';
}
