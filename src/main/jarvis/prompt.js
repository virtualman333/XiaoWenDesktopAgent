/**
 * system prompt 的拼装点 —— 全仓唯一。
 *
 * 为什么单独抽出来：**人设此前有两份，而且互不相干。**
 *   ① `jarvis/store.js` 的 `personaPrompt()` —— 设置页「人格与记忆」
 *      写的就是它（`persona.json`），agent 路径读它。
 *   ② `DEFAULT_CONFIG.systemPrompt` —— 一句写死的中文人设，**只有渲染层
 *      的普通对话路径读它**，而设置页里根本没有这个键的入口。
 *
 * 于是默认人设在两处各写一遍（`DEFAULT_PERSONA` 与 `systemPrompt`），
 * 用户在界面上怎么改都只动①。一旦走的是普通对话 —— `agentEnabled=false`，
 * 或者**模型不支持函数调用时自动降级**（panel.js 的 `err.disabled` 那条分支，
 * 并且会把 `agentEnabled` 落盘成 false）—— 小问就当场忘了自己叫什么、
 * 忘了主人是谁、也忘了所有说话风格要求，**而且没有任何提示**。
 *
 * 所以这里把「人设段」收敛成一个函数，两条路径都调它：
 *   - agent 路径（`jarvis/agent.js`）：人设段之后还要拼记忆 / 技能 / 工具规则
 *   - 普通对话（`main.js` 的 `chat:stream`）：只有人设段
 * 谁都不许自己再从 `cfg.systemPrompt` 拼第二份 —— 它现在只是**追加项**
 * （用户想补一句「回答别用 Markdown」这种），而不是人设本体。
 */

/**
 * 旧版本 `DEFAULT_CONFIG.systemPrompt` 的原文。
 *
 * 它被写进过**每一个**已存在的 `config.json` —— 因为 `saveConfig()` 落盘的是
 * 合并后的全量配置，不是用户手写的差量。升级后如果把它照原样当「追加项」拼到
 * 人设后面，人设里会平白多出一句「名字叫「小问」」，跟 persona 打架。
 *
 * 所以：**等于这句就视为没写**。代价是「用户自己手打一句一模一样的话会不生效」，
 * 可以接受；而且这一条能被测到（见 build/_llm_test.mjs）。
 */
const LEGACY_SYSTEM_PROMPT = '你是一个常驻桌面的 AI 助手，名字叫「小问」。回答要简洁、直接、口语化，适合语音朗读。除非用户明确要求详细，否则控制在 200 字以内。';

/**
 * 人设段 = 人格（唯一来源 store.personaPrompt()）+ 追加指令（cfg.systemPrompt）。
 * 两个来源都拿不到时返回空串（调用方据此决定要不要放 system 消息）。
 */
function personaSection(store, cfg) {
  const parts = [];
  let persona = '';
  try {
    persona = store && typeof store.personaPrompt === 'function' ? store.personaPrompt() : '';
  } catch (e) {
    // persona.json 坏了也不该把整轮对话带走 —— 退回「没有格式」的坏情况
    persona = '';
  }
  persona = String(persona || '').trim();
  if (persona) parts.push(persona);

  let extra = String((cfg && cfg.systemPrompt) || '').trim();
  if (extra === LEGACY_SYSTEM_PROMPT) extra = '';
  if (extra) parts.push(extra);

  return parts.join('\n\n');
}

/**
 * 摘掉调用方传来的 system 消息。
 *
 * 渲染层此前会自己拼一条 `{ role:'system', content: cfg.systemPrompt }` 塞进
 * messages。那条**必须丢掉**：它不是人设的来源，留着就会把上面这个唯一来源
 * 盖掉（而且它来自界面改不到的 `config.json`）。
 * 返回值把「丢了几条」带出来，日志里要说一声 —— 静默丢弃正是这一版修的东西。
 */
function splitSystemMessages(messages) {
  const list = Array.isArray(messages) ? messages.filter(Boolean) : [];
  return {
    systems: list.filter((m) => m.role === 'system'),
    rest: list.filter((m) => m.role !== 'system')
  };
}

module.exports = { personaSection, splitSystemMessages, LEGACY_SYSTEM_PROMPT };
