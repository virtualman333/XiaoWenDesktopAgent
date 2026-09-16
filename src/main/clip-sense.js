/**
 * clip-sense.js —— 剪贴板感知
 *
 * 复制一段报错、一段代码、一个链接之后，主人多半就是想问小问点什么，
 * 但还得先按快捷键、再粘一次。这个模块让桌面入口自己先开口：
 * 认出「值得问」的剪贴板内容，轻提示一句「这段要我看吗」，点通知直接开面板带上。
 *
 * 刻意不做的事：
 *   1. 不联网、不上传。分类全是本地正则，内容只在内存里过一遍，不落盘。
 *   2. 疑似凭证一律不提示 —— API Key / token / 私钥 / password 赋值 / JWT。
 *      提示本身就会把密钥印在通知横幅上，那比不提示更糟。
 *   3. 默认关闭（理由同 wakeEnabled）：常驻读剪贴板属隐私敏感行为，
 *      开不开交给主人自己在设置里决定。
 *   4. 配置只决定「认出什么、问什么」，不决定「什么绝对不能提示」：
 *      凭证识别永远是第一步，且**没有开关**（见下面「可配置规则」一节）。
 *
 * 本模块只依赖 Node 原生能力（clipboard 由调用方注入），纯逻辑可单测：
 *   node --test build/_clip_sense_test.mjs
 */

/** 预览片段长度：通知横幅上只放一行，太长会被系统截断 */
const MAX_PREVIEW = 56;
/** 比这还短的多半是随手复制的词或数字，不值得打扰 */
const MIN_LENGTH = 12;
/** 到这么长就值得问一句「要我看看吗」，哪怕认不出具体类型 */
const LONG_TEXT = 200;
/** 默认轮询间隔：够快能接住「复制完马上想用」，又不至于空转 */
const DEFAULT_INTERVAL = 1500;
/** 提示后的冷却期：连续复制时不要每条都喊一遍 */
const DEFAULT_COOLDOWN = 20000;

/**
 * 疑似凭证。命中直接忽略，连预览都不给。
 * 宁可漏报（用户自己粘一次就行），不可误报（横幅上印出密钥收不回来）。
 */
const SECRET_RES = [
  /(api[-_ ]?key|secret|passwd|password|access[-_ ]?token|refresh[-_ ]?token|authorization|bearer)\s*[:=]\s*\S{6,}/i,
  /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|LTAI[A-Za-z0-9]{12,})\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // JWT：三段 base64url，用点分隔
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/
];

/** 报错特征：异常名、栈帧、编译错误 */
const ERROR_RE = /\b(TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError|ValueError|KeyError|IndexError|AttributeError|ImportError|ModuleNotFoundError|NullPointerException|ClassCastException|Exception|Error|Traceback|panic:|FATAL)\b|error\[[A-Z]?\d+\]|^\s*at\s+\S+/m;

/** 代码特征：行首关键字（缩进不计，粘出来的片段常带缩进） */
const CODE_RE = /^\s*(import|export|from|const|let|var|function|class|async|await|def|package|public|private|protected|return|if|for|while|try|catch|switch|struct|impl|fn|use|mod|#include|SELECT|INSERT|UPDATE|CREATE)\b/m;

/** JSON 片段：首尾是被括号包住的整体 */
const JSON_RE = /^\s*[[{][\s\S]*[\]}]\s*$/;

/** 单行链接 */
const URL_RE = /^https?:\/\/\S+$/i;

/** 单行选项：/^\s*-\s+\S/ 之类不算，避免把购物清单当代码 */

// ─────────────────────────────────────────────────────────────────────────
// 可配置规则
//
// 内置的 5 类 + 凭证正则覆盖的是「通用开发者场景」。但每个人还有自己的世界：
// 公司内部日志前缀（`[corp]`）、内部域名、某个框架特有的栈帧格式……这些内置
// 规则一律认不出来，于是功能对这类主人等于半残 —— 而它们完全不该由我们猜。
//
// 配置从 config.json 的 clipSenseRules 读：
//   {
//     "disableKinds": ["url"],            // 不想被提示的内置类型
//     "ignorePatterns": ["^\\[内部\\]"],  // 永不提示（命中即静默）
//     "customKinds": [
//       { "id": "corp-log", "label": "公司日志", "pattern": "^\\[corp\\]",
//         "flags": "im", "title": "这段公司日志要我看看吗？", "ask": "帮我分析这段公司日志。" }
//     ]
//   }
//
// ★ 一条不可配置的边界：**凭证识别永远是第一步，且无法关闭**。
//   没有 `disableKinds: ["secret"]` 这种写法（secret 不在内置类型表里，
//   写了会报「未知类型」并忽略）。理由见文件头第 2 条：误报一次，密钥就印在
//   系统通知横幅上了，收不回来。这条捷径不该开放。
//
// ★ 优先级（从上到下，先命中先返回）：
//   凭证（不可配置） → ignorePatterns → customKinds → 内置 5 类（disableKinds 可关）
//   —— 主人自己写的「永不提示」压过自己写的「自定义类型」，因为「别打扰我」
//   是比「认出来」更强的意图。
// ─────────────────────────────────────────────────────────────────────────

/** 内置类型表（凭证不在此列，也永远不会进来） */
const BUILTIN_KINDS = ['error', 'json', 'url', 'code', 'longtext'];
/** 自定义正则长度上限：正则由主人自己写，太长既难读也容易被 ReDoS 拖死轮询 */
const MAX_PATTERN_LEN = 200;
/** 自定义类型条数上限 */
const MAX_CUSTOM_KINDS = 20;

/** 空规则集：不传规则时的默认行为，与加配置之前完全一致 */
const EMPTY_RULES = { off: new Set(), disableKinds: [], ignoreRes: [], custom: [], warnings: [] };

/**
 * 安全地把配置里的字符串编译成正则。任何问题都**只警告不抛** ——
 * 配置写错不该让剪贴板感知整个停摆，更不该让主进程崩。
 */
function safeRe(pattern, flags, warnings, where) {
  const src = String(pattern == null ? '' : pattern).trim();
  if (!src) {
    warnings.push(`${where}：正则为空，已忽略`);
    return null;
  }
  if (src.length > MAX_PATTERN_LEN) {
    warnings.push(`${where}：正则超过 ${MAX_PATTERN_LEN} 字符，已忽略`);
    return null;
  }
  const f = String(flags == null ? '' : flags).trim();
  if (/[^dgimsuvy]/.test(f)) {
    warnings.push(`${where}：flags 含非法字符「${f}」，已忽略`);
    return null;
  }
  // 必须去掉 g / y：带 g 的正则有 lastIndex 状态，re.test() 会交替命中与不命中，
  // 表现为「同一段内容时提示时不提示」—— 这类 bug 极难查，直接在这里掐掉。
  const clean = f.replace(/[gy]/g, '');
  try {
    return new RegExp(src, clean);
  } catch (e) {
    warnings.push(`${where}：正则无法编译（${(e && e.message) || e}），已忽略`);
    return null;
  }
}

/**
 * 把 config.json 里的原始配置编译成分类器能直接用的规则集。
 * 纯函数：同样的输入永远同样的输出，不碰全局状态。
 *
 * @param {object} raw clipSenseRules 原始值（可能为 undefined / 写错）
 * @returns {{off: Set<string>, disableKinds: string[], ignoreRes: RegExp[],
 *            custom: Array<{id:string,label:string,title:string,lead:string,re:RegExp}>,
 *            warnings: string[]}}
 */
function compileRules(raw) {
  const warnings = [];
  const src = raw && typeof raw === 'object' ? raw : {};

  const disableKinds = [];
  for (const k of Array.isArray(src.disableKinds) ? src.disableKinds : []) {
    const id = String(k == null ? '' : k).trim();
    if (!BUILTIN_KINDS.includes(id)) {
      // 这里会拦下 disableKinds: ["secret"] —— 凭证识别不可关闭
      warnings.push(`disableKinds 里有未知类型「${id}」，已忽略（可关的只有：${BUILTIN_KINDS.join(' / ')}）`);
      continue;
    }
    if (!disableKinds.includes(id)) disableKinds.push(id);
  }

  const ignoreRes = [];
  for (const p of Array.isArray(src.ignorePatterns) ? src.ignorePatterns : []) {
    const re = safeRe(p, '', warnings, 'ignorePatterns');
    if (re) ignoreRes.push(re);
  }

  const custom = [];
  const list = Array.isArray(src.customKinds) ? src.customKinds : [];
  if (list.length > MAX_CUSTOM_KINDS) {
    warnings.push(`customKinds 超过上限 ${MAX_CUSTOM_KINDS} 条，多余的已忽略`);
  }
  for (const item of list.slice(0, MAX_CUSTOM_KINDS)) {
    if (!item || typeof item !== 'object') {
      warnings.push('customKinds 里有一项不是对象，已忽略');
      continue;
    }
    const id = String(item.id == null ? '' : item.id).trim();
    if (!id) {
      warnings.push('customKinds 里有一项缺少 id，已忽略');
      continue;
    }
    if (BUILTIN_KINDS.includes(id) || id === 'secret' || id === 'ignore') {
      warnings.push(`customKinds 的 id「${id}」与内置类型冲突，已忽略`);
      continue;
    }
    if (custom.some((c) => c.id === id)) {
      warnings.push(`customKinds 的 id「${id}」重复，已忽略`);
      continue;
    }
    const re = safeRe(item.pattern, item.flags, warnings, `customKinds「${id}」`);
    if (!re) continue;
    const label = String(item.label == null ? '' : item.label).trim() || id;
    custom.push({
      id,
      label,
      re,
      title: String(item.title == null ? '' : item.title).trim() || `这段${label}要我看看吗？`,
      lead: String(item.ask == null ? '' : item.ask).trim() || `帮我看看这段${label}。`
    });
  }

  return { off: new Set(disableKinds), disableKinds, ignoreRes, custom, warnings };
}

function preview(text) {
  const one = String(text).replace(/\s+/g, ' ').trim();
  return one.length > MAX_PREVIEW ? one.slice(0, MAX_PREVIEW) + '…' : one;
}

/**
 * 判断一段剪贴板文本值不值得问一句。
 * 纯函数：同样的输入永远同样的输出，不碰全局状态、不读时钟。
 *
 * 判定顺序：凭证（不可配置）→ ignorePatterns → customKinds → 内置 5 类。
 * 不传 rules 时行为与本文件加配置之前**完全一致**（EMPTY_RULES）。
 *
 * @param {string} text 剪贴板原文
 * @param {object} [rules] compileRules() 的产物
 * @returns {{worth: boolean, kind: string, title: string, preview: string}}
 *   kind: secret | ignore | 内置 5 类 | 自定义 id
 */
function classifyClipboard(text, rules) {
  const miss = { worth: false, kind: 'ignore', title: '', preview: '' };
  const raw = String(text == null ? '' : text);
  const trimmed = raw.trim();
  if (trimmed.length < MIN_LENGTH) return miss;

  // 凭证优先于一切判断：先排除，再谈分类。这一步**不受任何配置影响**。
  for (const re of SECRET_RES) {
    if (re.test(trimmed)) return { worth: false, kind: 'secret', title: '', preview: '' };
  }

  const r = rules && typeof rules === 'object' ? rules : EMPTY_RULES;

  // 主人自己写的「永不提示」压过其它一切（凭证已在上一步拦掉）
  for (const re of r.ignoreRes || []) {
    if (re.test(trimmed)) return miss;
  }

  const lines = trimmed.split(/\r?\n/).length;
  const pv = preview(trimmed);

  // 自定义类型先于内置：主人自己配的规则优先于我们的猜测
  for (const c of r.custom || []) {
    if (c.re.test(trimmed)) {
      return { worth: true, kind: c.id, title: c.title, preview: pv };
    }
  }

  const off = r.off || EMPTY_RULES.off;
  if (!off.has('error') && ERROR_RE.test(trimmed)) {
    return { worth: true, kind: 'error', title: '这段报错要我看看吗？', preview: pv };
  }
  if (!off.has('json') && JSON_RE.test(trimmed) && lines >= 3) {
    return { worth: true, kind: 'json', title: '这段 JSON 要我看看吗？', preview: pv };
  }
  if (!off.has('url') && URL_RE.test(trimmed)) {
    return { worth: true, kind: 'url', title: '这个链接要我看看吗？', preview: pv };
  }
  if (!off.has('code') && lines >= 3 && CODE_RE.test(trimmed)) {
    return { worth: true, kind: 'code', title: '这段代码要我看看吗？', preview: pv };
  }
  if (!off.has('longtext') && trimmed.length >= LONG_TEXT) {
    return { worth: true, kind: 'longtext', title: '这段内容要我看看吗？', preview: pv };
  }
  return miss;
}

/**
 * 每类内容预置的问法。
 *
 * 为什么需要它：内容被带进输入框时是**裸文本**，主人还得多打一句「帮我看看这段报错」
 * 才能按下回车 —— 而「复制这段」这个动作本身就已经表达了意图。这里把意图补全，
 * 问句**仍由主人按下回车才发出**（本模块从不代发，见文件头第 3 条）。
 */
const ASK_TEMPLATES = {
  error: { lead: '帮我看看这段报错，是什么原因、怎么改？', hint: '已按报错写好问法，可直接回车（也能改）' },
  code: { lead: '帮我看看这段代码，有没有问题？', hint: '已按代码写好问法，可直接回车（也能改）' },
  json: { lead: '帮我看看这段 JSON 有没有问题？', hint: '已按 JSON 写好问法，可直接回车（也能改）' },
  url: { lead: '帮我看看这个链接讲的是什么，有值得注意的吗？', hint: '已按链接写好问法，可直接回车（也能改）' },
  longtext: { lead: '帮我看看这段内容，提炼下要点。', hint: '已按长文写好问法，可直接回车（也能改）' }
};

/** 认不出类型时，问法与提示都退回中性说法 */
const NEUTRAL_HINT = '剪贴板那段已带过来，想问什么直接说';

/**
 * 把内容包成代码围栏。
 * 围栏必须**比内容里最长的连续反引号还长**：粘来的代码自己带 ``` 时，等长围栏会被
 * 提前闭合，后面的内容就跑到代码块外面去了（模型看到的是半截结构）。
 */
function fence(text) {
  const runs = String(text).match(/`+/g) || [];
  const bar = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return `${bar}\n${text}\n${bar}`;
}

/**
 * 按内容类型生成一句「已经写好的提问」，供面板预填。
 * 纯函数，不碰全局状态。
 *
 * @param {string} kind classifyClipboard 给出的类型
 * @param {string} text 剪贴板原文
 * @param {object} [rules] compileRules() 的产物（自定义类型要从中取问法）
 * @returns {{question: string, hint: string}} question 为空串表示没有可用内容
 */
function buildClipQuestion(kind, text, rules) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { question: '', hint: '' };
  const r = rules && typeof rules === 'object' ? rules : EMPTY_RULES;

  // 自定义类型：问法与提示由配置给（没给就用中性说法兜底）
  const custom = (r.custom || []).find((c) => c.id === kind);
  if (custom) {
    // 多行才加围栏：单行的日志前缀、内部域名加了反而碍事
    const body = raw.includes('\n') ? fence(raw) : raw;
    return {
      question: `${custom.lead}\n\n${body}`,
      hint: `已按${custom.label}写好问法，可直接回车（也能改）`
    };
  }

  const t = ASK_TEMPLATES[kind];
  if (!t) return { question: raw, hint: NEUTRAL_HINT };
  // 链接不加围栏：加了反而没法直接点，也没有多行结构需要保
  const body = kind === 'url' ? raw : fence(raw);
  return { question: `${t.lead}\n\n${body}`, hint: t.hint };
}

/**
 * 剪贴板轮询器。
 *
 * 两个刻意的行为：
 *   - 内容没变过就不再提示（复制A→复制A 只喊一次）；
 *   - 提示后有冷却期，连续复制多段时不会被刷屏。冷却期内被拦下的内容**翻篇**，
 *     冷却结束后不补提 —— 二十秒后再来说「你刚才复制的那段要看看吗」很怪。
 *     新的内容照常提示。
 *
 * @param {object} opts
 * @param {Function} opts.readClip  读剪贴板，返回字符串（注入以便单测）
 * @param {Function} opts.onSuggest 命中时回调 (hit, text)
 * @param {number}  [opts.intervalMs]
 * @param {number}  [opts.cooldownMs]
 * @param {object}  [opts.rules]    compileRules() 的产物；配置改了调 setRules 换掉
 * @param {Function} [opts.now]     取时间（注入以便单测冷却逻辑）
 */
function createClipSense(opts = {}) {
  const read = typeof opts.readClip === 'function' ? opts.readClip : () => '';
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const intervalMs = Math.max(500, Number(opts.intervalMs) || DEFAULT_INTERVAL);
  const rawCooldown = opts.cooldownMs == null ? DEFAULT_COOLDOWN : Number(opts.cooldownMs);
  const cooldownMs = Math.max(0, Number.isFinite(rawCooldown) ? rawCooldown : DEFAULT_COOLDOWN);
  // 规则可热替换，因此不必为了「改了配置」重建轮询器（重建会丢掉冷却与去重状态）
  let rules = opts.rules && typeof opts.rules === 'object' ? opts.rules : EMPTY_RULES;

  let timer = null;
  let running = false;
  let lastSeen = '';
  // null 表示「这轮生命周期里还没提示过」。不能用 0 占位 ——
  // 那样 now() - 0 会小于冷却期，启动后头二十秒的提示会被全部吞掉。
  let lastSuggestAt = null;

  /** 跑一轮检测。返回命中结果（没命中返回 null），供单测直接驱动。 */
  function checkNow() {
    let text = '';
    try {
      text = String(read() || '');
    } catch (e) {
      // 剪贴板偶发读取失败（被别的程序占着）不算异常，下一轮再来
      return null;
    }
    if (!text || text === lastSeen) return null;
    lastSeen = text;

    // 分类现在会跑到主人自己写的正则上。写岔了（或碰上灾难性回溯）不能把
    // 主进程的定时器带崩 —— 那是整只桌面宠物都停摆，代价远大于漏一次提示。
    let hit;
    try {
      hit = classifyClipboard(text, rules);
    } catch (e) {
      return null;
    }
    if (!hit || !hit.worth) return null;
    if (lastSuggestAt !== null && now() - lastSuggestAt < cooldownMs) return null;
    lastSuggestAt = now();
    try {
      if (typeof opts.onSuggest === 'function') opts.onSuggest(hit, text);
    } catch (e) {
      // 提示失败不该让轮询停摆
    }
    return hit;
  }

  return {
    start() {
      if (running) return;
      running = true;
      timer = setInterval(checkNow, intervalMs);
      // 别让这个定时器把进程钉住不退出
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    isRunning: () => running,
    checkNow,
    /** 换规则集（主人改了配置时调用）。不重建轮询器，冷却与去重状态都保留。 */
    setRules(next) {
      rules = next && typeof next === 'object' ? next : EMPTY_RULES;
    },
    /** 忘记上次内容：主人手动问过一次后，同样的内容不该再提示第二遍 */
    forget() {
      lastSeen = '';
    }
  };
}

module.exports = {
  classifyClipboard,
  buildClipQuestion,
  compileRules,
  createClipSense,
  MAX_PREVIEW,
  MIN_LENGTH,
  LONG_TEXT,
  DEFAULT_INTERVAL,
  DEFAULT_COOLDOWN,
  ASK_TEMPLATES,
  NEUTRAL_HINT,
  BUILTIN_KINDS
};
