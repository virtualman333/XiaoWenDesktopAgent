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

function preview(text) {
  const one = String(text).replace(/\s+/g, ' ').trim();
  return one.length > MAX_PREVIEW ? one.slice(0, MAX_PREVIEW) + '…' : one;
}

/**
 * 判断一段剪贴板文本值不值得问一句。
 * 纯函数：同样的输入永远同样的输出，不碰全局状态、不读时钟。
 *
 * @param {string} text 剪贴板原文
 * @returns {{worth: boolean, kind: string, title: string, preview: string}}
 *   kind: secret | ignore | error | json | url | code | longtext
 */
function classifyClipboard(text) {
  const miss = { worth: false, kind: 'ignore', title: '', preview: '' };
  const raw = String(text == null ? '' : text);
  const trimmed = raw.trim();
  if (trimmed.length < MIN_LENGTH) return miss;

  // 凭证优先于一切判断：先排除，再谈分类
  for (const re of SECRET_RES) {
    if (re.test(trimmed)) return { worth: false, kind: 'secret', title: '', preview: '' };
  }

  const lines = trimmed.split(/\r?\n/).length;
  const pv = preview(trimmed);

  if (ERROR_RE.test(trimmed)) {
    return { worth: true, kind: 'error', title: '这段报错要我看看吗？', preview: pv };
  }
  if (JSON_RE.test(trimmed) && lines >= 3) {
    return { worth: true, kind: 'json', title: '这段 JSON 要我看看吗？', preview: pv };
  }
  if (URL_RE.test(trimmed)) {
    return { worth: true, kind: 'url', title: '这个链接要我看看吗？', preview: pv };
  }
  if (lines >= 3 && CODE_RE.test(trimmed)) {
    return { worth: true, kind: 'code', title: '这段代码要我看看吗？', preview: pv };
  }
  if (trimmed.length >= LONG_TEXT) {
    return { worth: true, kind: 'longtext', title: '这段内容要我看看吗？', preview: pv };
  }
  return miss;
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
 * @param {Function} [opts.now]     取时间（注入以便单测冷却逻辑）
 */
function createClipSense(opts = {}) {
  const read = typeof opts.readClip === 'function' ? opts.readClip : () => '';
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const intervalMs = Math.max(500, Number(opts.intervalMs) || DEFAULT_INTERVAL);
  const rawCooldown = opts.cooldownMs == null ? DEFAULT_COOLDOWN : Number(opts.cooldownMs);
  const cooldownMs = Math.max(0, Number.isFinite(rawCooldown) ? rawCooldown : DEFAULT_COOLDOWN);

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

    const hit = classifyClipboard(text);
    if (!hit.worth) return null;
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
    /** 忘记上次内容：主人手动问过一次后，同样的内容不该再提示第二遍 */
    forget() {
      lastSeen = '';
    }
  };
}

module.exports = { classifyClipboard, createClipSense, MAX_PREVIEW, MIN_LENGTH, LONG_TEXT, DEFAULT_INTERVAL, DEFAULT_COOLDOWN };
