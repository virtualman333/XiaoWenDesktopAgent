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

/**
 * 内置类型的显示名。**唯一定义处** —— 设置界面从主进程拿这张表，不自己再抄一份：
 * 抄一份的后果是「新增一类后界面显示原始 id」，且没有任何报错提示你抄漏了。
 * 「有哪些内置类型」也从它派生（见 BUILTIN_KINDS），不另写第二份清单。
 */
const BUILTIN_LABELS = { error: '报错', json: 'JSON', url: '链接', code: '代码', longtext: '长文本' };
/**
 * 可关闭的内置类型。**由 BUILTIN_LABELS 派生** —— 此前这里是一份独立的数组，
 * 与 BUILTIN_LABELS 各写一遍、靠人记着同时改。漏改的后果是静默的：
 * 只加进数组则界面显示原始 id（`newkind` 而不是「新类型」），只加进标签表则
 * 这个类型关不掉（`disableKinds` 里写它会报「未知类型」）。两处都不报错。
 */
const BUILTIN_KINDS = Object.keys(BUILTIN_LABELS);
/** 自定义正则长度上限：正则由主人自己写，太长既难读也容易被 ReDoS 拖死轮询 */
const MAX_PATTERN_LEN = 200;
/** 自定义类型条数上限 */
const MAX_CUSTOM_KINDS = 20;
/** `clipSenseRules` 认得的字段。**只有这三个**，多出来的字段一律报警（见 compileRules） */
const RULE_KEYS = ['disableKinds', 'ignorePatterns', 'customKinds'];

/**
 * 导出文件的格式标记：`$schema` 的值形如 `xwda-clip-rules/1`。
 *
 * 为什么需要它：导出的 JSON 就是「规则对象本身」，文件里没有任何东西说明它是什么、
 * 哪一版程序写的。将来规则加了字段（比如给 customKinds 增加 `weight`），旧版本程序
 * 导入新版本导出的文件时**只会打印一句「有未知字段」然后照样收下** —— 用户以为
 * 迁移成功了，实际丢掉了新字段；反向（新版本导入旧文件）也全靠字段存在性猜。
 * 有了标记，这两个方向都能说清楚。
 */
const RULES_SCHEMA = 'xwda-clip-rules';
/** 当前支持的规则文件格式版本。**新增会改变语义的字段时 +1**，并在下面补迁移说明。 */
const RULES_SCHEMA_VERSION = 1;

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

  // 未知字段必须报警。旧实现是**静默忽略**的：把 `ignorePatterns` 写成 `ignorePattern`
  // （少个 s）或 `customKinds` 写成 `customKind` 时，规则一条都不生效、却什么都不说 ——
  // 用户只会觉得「我明明填了」。改配置文件时这已经够难查，到了设置界面里就更是死胡同。
  if (Array.isArray(raw)) {
    warnings.push('clipSenseRules 应该是一个对象，收到的却是数组，已按空规则处理');
  } else {
    for (const k of Object.keys(src)) {
      if (!RULE_KEYS.includes(k)) {
        warnings.push(`clipSenseRules 里有未知字段「${k}」，已忽略（只认：${RULE_KEYS.join(' / ')}）`);
      }
    }
  }

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

/**
 * 规则编译结果的「人话摘要」。
 *
 * 界面上要显示的是**实际生效的结果**，不是用户填的原文：`compileRules` 对写错的
 * 条目一律只警告不抛，所以「填了 5 条、生效 1 条」完全可能。只回显原文的话，
 * 用户永远看不出哪几条被丢掉了。
 */
function summarizeRules(rules) {
  const off = rules.off instanceof Set ? rules.off : new Set(rules.disableKinds || []);
  return {
    disabledKinds: rules.disableKinds || [],
    /** 仍然会提示的内置类型（关掉的不算） */
    activeKinds: BUILTIN_KINDS.filter((k) => !off.has(k)),
    ignoreCount: (rules.ignoreRes || []).length,
    custom: (rules.custom || []).map((c) => ({ id: c.id, label: c.label }))
  };
}

/**
 * 读出规则 JSON 里的格式标记。
 *
 * 三种结果要分清楚，它们的处理方式完全不同：
 *   · **没有标记** → 视为第 1 版（手写的、或旧版本导出的文件都长这样），照常接受；
 *   · **标记是本程序认得的前缀** → 记下版本号，交给调用方比对；
 *   · **认不出的标记** → 报错。别小看这一条：VS Code 的 `settings.json` 这类文件
 *     第一行就是 `"$schema": "https://json.schemastore.org/..."`，以前选错文件时
 *     只会得到一串「未知字段」警告，看上去像是规则写得不对，其实文件压根不对。
 *
 * @returns {{present:boolean, version:number|null, error?:string}}
 */
function readRulesSchema(obj) {
  if (!obj || typeof obj !== 'object') return { present: false, version: null };
  const raw = obj.$schema;
  if (raw === undefined || raw === null || raw === '') return { present: false, version: null };
  const m = /^xwda-clip-rules\/(\d+)$/.exec(String(raw).trim());
  if (!m) {
    return {
      present: true,
      version: null,
      error:
        `认不出的格式标记 $schema：${JSON.stringify(raw)}。` +
        `本程序导出的规则文件第一行是 "$schema": "${RULES_SCHEMA}/${RULES_SCHEMA_VERSION}"，` +
        '请确认选对了文件。'
    };
  }
  return { present: true, version: Number(m[1]) };
}

/**
 * 解析设置界面里那段规则文本 —— **纯函数**，不碰文件也不碰 Electron。
 *
 * 为什么不把这段逻辑写在渲染进程里：规则知识（哪些字段合法、哪些条目会被丢掉、
 * 凭证为什么不能关）只有 `clip-sense.js` 一份。界面再实现一遍必然漂移，而漂移的
 * 后果是「界面说没问题、实际全被丢弃」——最坏的一种。
 *
 * @param {string} text 规则 JSON 文本；空串表示「不用自定义规则」
 * @returns {{ok:boolean, error?:string, value?:object, summary?:object, warnings:string[]}}
 */
function parseRulesText(text) {
  const s = String(text == null ? '' : text).trim();
  // labels 随校验结果一起下发：内置类型的显示名只有这一份（见 BUILTIN_LABELS），
  // 界面照抄即可，自己再抄一份的话「新增一类后界面显示原始 id」不会有人发现。
  if (!s) {
    return {
      ok: true,
      value: {},
      summary: summarizeRules(compileRules({})),
      warnings: [],
      labels: BUILTIN_LABELS,
      schema: { present: false, version: null }
    };
  }
  let obj;
  try {
    obj = JSON.parse(s);
  } catch (e) {
    return { ok: false, error: `JSON 语法错误：${(e && e.message) || e}`, warnings: [] };
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: '规则必须是一个 JSON 对象，形如 {"disableKinds": ["url"]}', warnings: [] };
  }

  // 格式版本：比本程序新的文件一律**拒绝**，不静默收下
  const schema = readRulesSchema(obj);
  if (schema.error) return { ok: false, error: schema.error, warnings: [] };
  if (schema.version !== null && schema.version > RULES_SCHEMA_VERSION) {
    return {
      ok: false,
      error:
        `这份规则文件是更新版本的程序导出的（${RULES_SCHEMA}/${schema.version}），` +
        `当前版本只认识到 ${RULES_SCHEMA_VERSION}。强行导入会静默丢掉新版本才有的字段，` +
        '所以这里直接拒绝 —— 请先升级程序。',
      warnings: []
    };
  }

  // 标记不是规则：剥掉再交给 compileRules，否则它会被报成「未知字段」，
  // 还会顺着「导入 → 保存」写进 config.json 一直传下去（导出时再补一个新的）。
  const rulesObj = { ...obj };
  delete rulesObj.$schema;

  const rules = compileRules(rulesObj);
  return {
    ok: true,
    value: rulesObj,
    summary: summarizeRules(rules),
    warnings: rules.warnings,
    labels: BUILTIN_LABELS,
    schema: { present: schema.present, version: schema.version }
  };
}

/** 判定结果里「为什么」的那一半 —— 界面直接印，不在渲染进程再写一遍文案 */
const REASON_TEXT = {
  hit: '会提示',
  empty: '没有内容',
  'too-short': `太短（不足 ${MIN_LENGTH} 个字符）`,
  secret: '疑似凭证 —— 硬保护，任何配置都改不了',
  ignored: '命中「永不提示」正则',
  disabled: '命中的内置类型被关掉了（disableKinds）',
  unrecognized: '认不出类型'
};

/**
 * 拿一段内容「试跑」当前规则 —— 设置界面那块「试试我的规则」按的就是这个。
 *
 * 为什么需要它：`compileRules` 只对**写坏**的规则报警（正则编译不过、字段名不认识），
 * 对「规则写对了、但永远匹配不上你这台机器上的内容」一声不吭。主人照着示例写完
 * 一条 `^\[corp\]`，复制公司日志却毫无反应，此时他手上没有任何自证手段 ——
 * 只能怀疑功能坏了。判定链（凭证 → ignore → custom → 内置）是硬编码的，
 * 但从界面上完全看不出来是「写错了」还是「压根没轮到它」。
 *
 * 试跑**只读**：不读真剪贴板、不落盘、不改变任何状态，随时可以试。
 *
 * @param {string} text    想试的内容
 * @param {string} rulesText 界面里那段规则 JSON（未保存的也要能试）
 * @returns {{ok:boolean, error?:string, warnings:string[], verdict?:object}}
 */
function testRules(text, rulesText) {
  const parsed = parseRulesText(rulesText);
  if (!parsed.ok) return { ok: false, error: parsed.error, warnings: [] };
  const rules = compileRules(parsed.value || {});
  const raw = String(text == null ? '' : text);
  const hit = classifyClipboard(raw, rules);
  const custom = (rules.custom || []).find((c) => c.id === hit.kind);
  const label =
    hit.kind === 'secret' ? '疑似凭证'
      : hit.kind === 'ignore' ? ''
        : (custom ? custom.label : BUILTIN_LABELS[hit.kind] || hit.kind);
  // 问法由主进程生成（与真提示走的是同一个函数），界面只负责显示 ——
  // 试跑看到的就是复制后真实会填进输入框的那段字，不是另写一份演示文案。
  const ask = hit.worth ? buildClipQuestion(hit.kind, raw, rules) : { question: '', hint: '' };
  return {
    ok: true,
    warnings: rules.warnings,
    labels: BUILTIN_LABELS,
    verdict: {
      worth: hit.worth,
      kind: hit.kind,
      label,
      title: hit.title,
      preview: hit.preview,
      reason: hit.reason,
      stage: hit.stage,
      detail: hit.detail,
      reasonText: REASON_TEXT[hit.reason] || hit.reason,
      question: ask.question,
      hint: ask.hint
    }
  };
}

function preview(text) {
  const one = String(text).replace(/\s+/g, ' ').trim();
  return one.length > MAX_PREVIEW ? one.slice(0, MAX_PREVIEW) + '…' : one;
}

/**
 * 判定链上「不提示」的那几种结果。
 *
 * 为什么要分开：不提示有**五种完全不同的原因** —— 内容太短、被凭证保护拦下、
 * 被自己的「永不提示」正则拦下、命中的内置类型被自己关掉、以及真的认不出来。
 * 原先它们都是同一个「不提示」，于是主人没有任何办法知道该去改哪里：
 * 明明写了自定义规则却不生效，可能只是前面有条忽略正则先命中了。
 * 现在原因与「命中的是什么」都带上，界面上直接说得清。
 */
function missWith(reason, stage, detail) {
  return { worth: false, kind: 'ignore', title: '', preview: '', reason, stage, detail: detail || '' };
}

/** 内置类型命中（worth:true）。detail 放显示名，界面不必再翻译一次 */
function builtinHit(kind, title, pv) {
  return {
    worth: true, kind, title, preview: pv,
    reason: 'hit', stage: 'builtin', detail: BUILTIN_LABELS[kind] || kind
  };
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
 * @returns {{worth: boolean, kind: string, title: string, preview: string,
 *            reason: string, stage: string, detail: string}}
 *   kind:   secret | ignore | 内置 5 类 | 自定义 id
 *   reason: hit | empty | too-short | secret | ignored | disabled | unrecognized
 *   stage:  length | secret | ignore | custom | builtin | none
 *   detail: 命中的那条规则 / 类型的可读说明（没有则为空串）
 */
function classifyClipboard(text, rules) {
  const raw = String(text == null ? '' : text);
  const trimmed = raw.trim();
  if (!trimmed) return missWith('empty', 'length');
  if (trimmed.length < MIN_LENGTH) return missWith('too-short', 'length');

  // 凭证优先于一切判断：先排除，再谈分类。这一步**不受任何配置影响**。
  for (const re of SECRET_RES) {
    if (re.test(trimmed)) {
      return { worth: false, kind: 'secret', title: '', preview: '', reason: 'secret', stage: 'secret', detail: '' };
    }
  }

  const r = rules && typeof rules === 'object' ? rules : EMPTY_RULES;

  // 主人自己写的「永不提示」压过其它一切（凭证已在上一步拦掉）
  for (const re of r.ignoreRes || []) {
    if (re.test(trimmed)) return missWith('ignored', 'ignore', String(re));
  }

  const lines = trimmed.split(/\r?\n/).length;
  const pv = preview(trimmed);

  // 自定义类型先于内置：主人自己配的规则优先于我们的猜测
  for (const c of r.custom || []) {
    if (c.re.test(trimmed)) {
      return {
        worth: true, kind: c.id, title: c.title, preview: pv,
        reason: 'hit', stage: 'custom', detail: c.label
      };
    }
  }

  const off = r.off || EMPTY_RULES.off;
  // 内置 5 类：先命中先返回。**顺序即优先级**，与加配置之前逐条一致。
  // 命中但被 disableKinds 关掉的，记下来继续往下试 —— 这正是今天的行为
  // （关了「报错」还有「长文本」兜底），记下来的那份只用于「为什么没提示」的诊断。
  const trial = [
    ['error', () => ERROR_RE.test(trimmed), '这段报错要我看看吗？'],
    ['json', () => JSON_RE.test(trimmed) && lines >= 3, '这段 JSON 要我看看吗？'],
    ['url', () => URL_RE.test(trimmed), '这个链接要我看看吗？'],
    ['code', () => CODE_RE.test(trimmed) && lines >= 3, '这段代码要我看看吗？'],
    ['longtext', () => trimmed.length >= LONG_TEXT, '这段内容要我看看吗？']
  ];
  let offHit = '';
  for (const [id, hit, title] of trial) {
    if (!hit()) continue;
    if (off.has(id)) {
      if (!offHit) offHit = id;
      continue;
    }
    return builtinHit(id, title, pv);
  }
  if (offHit) return missWith('disabled', 'builtin', BUILTIN_LABELS[offHit] || offHit);
  return missWith('unrecognized', 'none');
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

/**
 * 导出规则时的默认文件名（带日期，便于留档与「这台机器 vs 那台机器」对比）。
 * 单独一个函数而不是在 IPC 里拼字符串：日期格式是**用户看得见**的东西，
 * 拼错（月份少补零、用了 UTC）不会报错，只是文件看起来莫名其妙。
 */
function rulesExportName(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `clip-sense-rules-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`;
}

/** 规则文件的大小上限：手写的规则几 KB 顶天了，大到离谱多半是选错了文件 */
const MAX_RULES_FILE_BYTES = 256 * 1024;

/**
 * 把界面里那段（可能还没保存的）规则整理成可导出的文本。
 *
 * 复用 `parseRulesText`，**不另写一份校验**：导出一份自己都编译不过的规则毫无意义
 * —— 导入方看到的只会是「JSON 语法错误」，而真正的原因（哪条正则写错了）留在了
 * 导出方，正是最该被告知的那个人。
 *
 * @returns {{ok:boolean, error?:string, text?:string, empty?:boolean,
 *            summary?:object, warnings?:string[], labels?:object}}
 */
function rulesExportText(text) {
  const parsed = parseRulesText(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const value = parsed.value && typeof parsed.value === 'object' ? parsed.value : {};
  const empty = Object.keys(value).length === 0;
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.slice() : [];
  if (empty) {
    warnings.push('当前没有任何规则，导出的是一份空规则集（导入后与「留空」等效）');
  }
  return {
    ok: true,
    empty,
    // 第一行是格式标记（人打开文件第一眼就能看出这是什么、哪一版写的）；
    // 结尾补一个换行：手写的 JSON 文件都带换行，diff 时不会显示「\ No newline at end of file」
    text: JSON.stringify({ $schema: `${RULES_SCHEMA}/${RULES_SCHEMA_VERSION}`, ...value }, null, 2) + '\n',
    summary: parsed.summary,
    warnings,
    labels: parsed.labels
  };
}

module.exports = {
  classifyClipboard,
  buildClipQuestion,
  compileRules,
  parseRulesText,
  rulesExportName,
  rulesExportText,
  MAX_RULES_FILE_BYTES,
  testRules,
  summarizeRules,
  createClipSense,
  MAX_PREVIEW,
  MIN_LENGTH,
  LONG_TEXT,
  DEFAULT_INTERVAL,
  DEFAULT_COOLDOWN,
  ASK_TEMPLATES,
  NEUTRAL_HINT,
  BUILTIN_KINDS,
  BUILTIN_LABELS,
  REASON_TEXT,
  RULE_KEYS,
  RULES_SCHEMA,
  RULES_SCHEMA_VERSION,
  readRulesSchema
};
