/**
 * config.json 的读 / 写 / 坏了怎么办 —— **判据只此一份**，纯 Node（不 require electron）。
 *
 * 为什么单独成模块：
 *   原来 `loadConfig()` 的 catch 直接 `return { ...DEFAULT_CONFIG }`，
 *   而 `saveConfig()` 无条件覆盖 config.json。而 README 教的正是「手改这个文件」
 *   （「复制 config.example.json 为 config.json，填自己的值即可」）。
 *   于是用户手抖多一个逗号，会发生这样一串**没有任何提示**的事：
 *
 *     启动 → JSON.parse 抛错 → 静默回落成「全新安装」的样子（Key / 人格 / 规则全没了）
 *          → 随手点任意一个开关（甚至只是发一条消息，`history:add` 也会落盘）
 *          → 那份**本来还能救回来**的 config.json 被默认值覆盖
 *          → 用户永远不知道自己填的东西去哪了，也没有任何东西留下来可以恢复。
 *
 * 现在的口径（四条，都不依赖 electron）：
 *   1) **读不出来 ≠ 没有配置**。先把原始内容**逐字节**备份成 `config.json.bad-<时间戳>-<指纹>`，
 *      再回落默认值；同一份坏内容只备份一次（按内容指纹去重，不然每次 load 都写一份）。
 *   2) 坏文件备份过了就**允许继续写** —— 否则界面会变成「点了保存但没生效」，更难查；
 *      原文件已经有逐字节副本，数据没丢。
 *   3) **读不动就拒绝写**（EACCES / EBUSY / EPERM）：连读都没读到，
 *      无从判断写下去会毁掉什么。这是唯一一种「保存被拒绝」的情形。
 *   4) 空文件（或只有空白）**不算损坏** —— 那是写入中断的典型残留，没有内容可备份。
 *      顺手把写盘改成「临时文件 + rename」原子替换，从根上消掉这种残留。
 *
 * 另外顺手报一件事：**配置文件里出现了不认识的键**。用户写 `hotKey` / `apiKeyy`
 * 这类拼错的名字时，合并默认值不会报错、改动也不会生效，界面上完全看不出来。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 读盘结果：config.json 当前处于哪种状态 */
const STATES = {
  OK: 'ok',                 // 读到了合法对象
  MISSING: 'missing',       // 还没有这个文件（全新安装）
  EMPTY: 'empty',           // 文件在，但没有内容（写入中断的残留）
  INVALID: 'invalid',       // 不是 JSON
  NOT_OBJECT: 'not-object', // 是 JSON，但顶层不是对象（数组 / 字符串 / null / 数字）
  UNREADABLE: 'unreadable'  // 压根读不动（权限 / 被占用）
};

/** 哪些状态意味着「这份文件已经不是用户的配置了」—— 需要备份 */
const NEEDS_BACKUP = new Set([STATES.INVALID, STATES.NOT_OBJECT]);

/** 顶层类型的中文说法，用来把错误讲成人话 */
function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '数组';
  return typeof v === 'object' ? '对象' : typeof v;
}

/**
 * 把一段文本判成上面那几种状态。
 *
 * 注意 `JSON.parse('123')` / `JSON.parse('"x"')` 都是**成功**的，
 * 但结果不是配置对象：`{ ...DEFAULT_CONFIG, ...123 }` 是默认值，而
 * `{ ...DEFAULT_CONFIG, ...'ab' }` 会得到 `{0:'a',1:'b',...}` 这种垃圾键 ——
 * 所以「能解析」不等于「能用」，这两种要分开报。
 */
function classifyText(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { kind: STATES.EMPTY, error: '文件没有内容' };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { kind: STATES.INVALID, error: (e && e.message) || String(e) };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: STATES.NOT_OBJECT, error: `顶层不是对象，是${typeName(value)}` };
  }
  return { kind: STATES.OK, value };
}

/** `20260918-133045` —— 本地时间，只用来拼文件名，不走 Date 的本地化 */
function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-`
    + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 内容指纹（短），用来给备份文件命名并去重 */
function fingerprint(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 8);
}

/**
 * 造一个配置读写器。
 *
 * @param {string|Function} dir     配置目录（userData）；传函数则每次现取
 * @param {object} defaults         默认配置 —— 唯一的默认值来源
 * @param {object} [opt]
 * @param {Function} [opt.now]      取当前时间，测试可注入
 * @param {object}   [opt.fs]       文件系统，测试可注入（默认真实 fs）
 */
function createConfigStore(dir, defaults, opt) {
  const o = opt || {};
  const FS = o.fs || fs;
  const now = o.now || (() => new Date());
  if (!defaults || typeof defaults !== 'object') {
    throw new TypeError('createConfigStore: defaults 必须是一个对象（默认值的唯一来源）');
  }
  const dirOf = typeof dir === 'function' ? dir : () => dir;

  const file = () => path.join(dirOf(), 'config.json');
  const tmpFile = () => file() + '.tmp';

  /** 已经备份过的内容指纹 —— 同一份坏内容只写一次备份 */
  const backedUp = new Set();
  /** 本进程写下的备份文件（给界面 / 通知用） */
  const backups = [];

  let state = STATES.MISSING;
  let backupPath = '';
  let error = '';
  let unknownKeys = [];
  /** 真值：这次能不能写盘。只有「读不动」会把它关掉 */
  let writeAllowed = true;

  function ensureDir() {
    const d = dirOf();
    if (!FS.existsSync(d)) FS.mkdirSync(d, { recursive: true });
  }

  /** 把坏内容逐字节留一份；同一份内容只留一次。返回落盘的路径（没备份则空串） */
  function backupBroken(text) {
    const fp = fingerprint(text);
    if (backedUp.has(fp)) return backups.length ? backups[backups.length - 1] : '';
    ensureDir();
    let target = `${file()}.bad-${stamp(now())}-${fp}`;
    // 同一秒里连撞两次指纹（内容不同）时别互相覆盖
    for (let i = 2; FS.existsSync(target) && i < 100; i++) {
      target = `${file()}.bad-${stamp(now())}-${fp}-${i}`;
    }
    FS.writeFileSync(target, text, 'utf-8');
    backedUp.add(fp);
    backups.push(target);
    return target;
  }

  function load() {
    let text;
    try {
      text = FS.readFileSync(file(), 'utf-8');
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        state = STATES.MISSING;
        backupPath = '';
        error = '';
        unknownKeys = [];
        writeAllowed = true;
        return { config: { ...defaults }, state, backupPath, error, unknownKeys };
      }
      // 读不动：既不知道现在是什么，也就没资格覆盖它
      state = STATES.UNREADABLE;
      backupPath = '';
      error = (e && e.message) || String(e);
      unknownKeys = [];
      writeAllowed = false;
      return { config: { ...defaults }, state, backupPath, error, unknownKeys };
    }

    const c = classifyText(text);
    if (c.kind === STATES.OK) {
      state = STATES.OK;
      backupPath = '';
      error = '';
      writeAllowed = true;
      const raw = c.value;
      // `_` 开头的键是**模板的注释约定** —— config.example.json 里用它写「这一组键是干什么的」，
      // 而 README 教的正是「复制模板为 config.json」。不豁免的话，照抄模板的用户一进设置页
      // 就会看到一条「配置文件里有 1 项不认识：_说明 —— 多半是名字拼错了」的假警告，
      // 而真正的拼写错误反而被这条假警告稀释掉。除 `_` 前缀外一律照旧上报。
      unknownKeys = Object.keys(raw).filter(
        (k) => !k.startsWith('_') && !Object.prototype.hasOwnProperty.call(defaults, k)
      );
      return { config: { ...defaults, ...raw }, state, backupPath, error, unknownKeys };
    }

    unknownKeys = [];
    writeAllowed = true;                       // 空文件没有内容可丢；坏文件已经/即将备份
    error = c.error;
    if (c.kind === STATES.EMPTY) {
      state = STATES.EMPTY;
      backupPath = '';
    } else {
      state = c.kind;                        // invalid / not-object
      backupPath = backupBroken(text);
      if (!backupPath) writeAllowed = false; // 备份写不下去 → 不许覆盖
    }
    return { config: { ...defaults }, state, backupPath, error, unknownKeys };
  }

  function save(cfg) {
    if (!writeAllowed) {
      return {
        ok: false,
        reason: state,
        error: `配置当前处于「${state}」状态（${error}），为避免覆盖掉读不出来的内容，这次不写盘`
      };
    }
    ensureDir();
    const text = JSON.stringify(cfg, null, 2);
    const tmp = tmpFile();
    try {
      // 先写完整内容到临时文件，再 rename 原子替换 ——
      // 直接 writeFileSync 到 config.json 时进程被杀就会留下半截文件，
      // 那正是上面 EMPTY / INVALID 两种状态的来源。
      FS.writeFileSync(tmp, text, 'utf-8');
      FS.renameSync(tmp, file());
      return { ok: true };
    } catch (e) {
      // 别把临时文件留在 userData 里
      try { if (FS.existsSync(tmp)) FS.unlinkSync(tmp); } catch (e2) { /* ignore */ }
      return { ok: false, reason: 'write-failed', error: (e && e.message) || String(e) };
    }
  }

  /** 给界面用的一份现状（不含任何配置值，密钥自然也就不会被带出去） */
  function health() {
    return {
      state,
      error,
      writeAllowed,
      unknownKeys: unknownKeys.slice(),
      backupPath: backupPath || (backups.length ? backups[backups.length - 1] : ''),
      backups: backups.slice(),
      describe: describe()
    };
  }

  /** 一段人话，直接贴到设置页横幅上 */
  function describe() {
    if (state === STATES.INVALID || state === STATES.NOT_OBJECT) {
      return `配置文件读不出来（${error}）。已经把原始内容原样备份成 ${path.basename(backupPath)}，`
        + '现在用的是默认配置 —— 把备份里能救的部分填回新的 config.json 就能恢复。';
    }
    if (state === STATES.UNREADABLE) {
      return `配置文件读不动（${error}）。为了不覆盖掉里面的内容，本次运行不会写入任何设置`
        + '（关掉占用这个文件的程序后重启即可）。';
    }
    if (unknownKeys.length) {
      return `配置文件里有 ${unknownKeys.length} 项不认识：${unknownKeys.slice(0, 6).join('、')}`
        + `${unknownKeys.length > 6 ? ' 等' : ''} —— 多半是名字拼错了，这些改动不会生效。`;
    }
    return '';
  }

  return { load, save, health, describe, filePath: file, tmpFilePath: tmpFile, STATES };
}

/**
 * 往 `config.json` 的 `history` 里追加一条，并按 `maxHistory` 裁剪。**纯函数。**
 *
 * 为什么要单独成函数：这段「push + 超了就 slice」在本仓有两个调用点
 * （主动关注的播报落痕、渲染层的 `history:add`），而两份实现都把**判据**与**动作**
 * 写成了两个不同的表达式：
 *
 *     if (cfg.history.length > (cfg.maxHistory || 200)) {   // 判据：缺省按 200
 *       cfg.history = cfg.history.slice(-cfg.maxHistory);   // 动作：用原值
 *     }
 *
 * `maxHistory` 缺失（老 config.json 里没有这一项、用户手改成 0 或 null、写成字符串）
 * 时判据说「该裁了」，动作却是 `slice(-undefined)` = `slice(NaN)` = `slice(0)`
 * —— **返回整个数组，一条都不裁**。历史于是无上限地长下去，而两条路径看起来都
 * 「处理过了」。所以这里只算一次上限，判据与动作用的是同一个数。
 *
 * @param {object} cfg          配置对象（会被就地改写 `history`）
 * @param {object} msg          要追加的一条
 * @param {number} [fallbackMax] 上限取不到时的兜底（与 DEFAULT_CONFIG 的初值一致）
 * @returns {Array} 裁剪后的 `cfg.history`
 */
function appendHistory(cfg, msg, fallbackMax) {
  if (!cfg || typeof cfg !== 'object') {
    throw new TypeError('appendHistory: cfg 必须是一个对象');
  }
  const list = Array.isArray(cfg.history) ? cfg.history : [];
  list.push({ ...msg });
  const raw = Number(cfg.maxHistory);
  const max = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : (fallbackMax || 200);
  cfg.history = list.length > max ? list.slice(-max) : list;
  return cfg.history;
}

module.exports = {
  createConfigStore, classifyText, stamp, fingerprint, appendHistory, STATES, NEEDS_BACKUP
};
