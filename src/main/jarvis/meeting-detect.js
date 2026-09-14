/**
 * 会议 / 视频 / 语音通话「自动检测」——纯逻辑层（不 import Electron，可直接单测）。
 *
 * 为什么要这么绕：Windows 没有现成的「现在在开会吗」接口。可用的客观信号只有三个：
 *
 *   1. **麦克风 / 摄像头被谁占着**
 *      Windows 会把「哪个程序正在用麦克风」写进注册表：
 *        HKCU\...\CapabilityAccessManager\ConsentStore\microphone\NonPackaged\<编码后的 exe 路径>
 *          LastUsedTimeStart  REG_QWORD  FILETIME
 *          LastUsedTimeStop   REG_QWORD  FILETIME（**0 表示还在用**）
 *      摄像头同理，在 webcam 子键下。这是最硬的信号。
 *
 *   2. **进程列表**
 *      tasklist 能拿到进程名 + 窗口标题。用于把「谁在用麦」翻译成人话，
 *      也用于识别浏览器里的 Google Meet / 腾讯会议网页版（标题里带会议字样）。
 *
 *   3. **窗口标题**
 *      Chrome 里开着 Google Meet 时标题会是「Meet - xxx」；但**光看标题不够**，
 *      因为「腾讯会议」这类客户端开机常驻、标题也常在，会一直误判成在开会，
 *      所以标题必须配合「麦克风真的被占用」才算数。
 *
 * 所以判定策略是「强信号 + 迟滞」：
 *   强信号 = 白名单应用占着麦克风/摄像头，或白名单应用的窗口标题命中会议关键词
 *   迟滞   = 连续 N 次采到才算「开始了」，连续 M 秒采不到才算「结束了」
 * 宁可晚一点开始记录，也不要一开机就误报。
 */

// ---------------- 常量表 ----------------

/** 已知的会议 / 通话类应用。exe 名一律小写比较。 */
const KNOWN_APPS = {
  // —— 专业会议 ——
  'wemeetapp.exe': { label: '腾讯会议', kind: 'meeting' },
  'tencentmeeting.exe': { label: '腾讯会议', kind: 'meeting' },
  'voov.exe': { label: '腾讯会议国际版', kind: 'meeting' },
  'dingtalk.exe': { label: '钉钉', kind: 'meeting' },
  'feishu.exe': { label: '飞书', kind: 'meeting' },
  'lark.exe': { label: '飞书', kind: 'meeting' },
  'zoom.exe': { label: 'Zoom', kind: 'meeting' },
  'teams.exe': { label: 'Microsoft Teams', kind: 'meeting' },
  'ms-teams.exe': { label: 'Microsoft Teams', kind: 'meeting' },
  'webex.exe': { label: 'Webex', kind: 'meeting' },
  'webexmta.exe': { label: 'Webex', kind: 'meeting' },
  'ciscowebexstart.exe': { label: 'Webex', kind: 'meeting' },
  'atmgr.exe': { label: 'Webex', kind: 'meeting' },
  'wemeeting.exe': { label: '华为云会议', kind: 'meeting' },
  'hwm.exe': { label: '华为云会议', kind: 'meeting' },
  'netease-mtg.exe': { label: '网易会议', kind: 'meeting' },
  'easyvaas.exe': { label: '网易会议', kind: 'meeting' },
  // —— 社交软件的语音 / 视频通话 ——
  'wechat.exe': { label: '微信', kind: 'call' },
  'weixin.exe': { label: '微信', kind: 'call' },
  'qq.exe': { label: 'QQ', kind: 'call' },
  'tim.exe': { label: 'TIM', kind: 'call' },
  'discord.exe': { label: 'Discord', kind: 'call' },
  'slack.exe': { label: 'Slack', kind: 'call' },
  'skype.exe': { label: 'Skype', kind: 'call' },
  'telegram.exe': { label: 'Telegram', kind: 'call' },
  'yy.exe': { label: 'YY', kind: 'call' },
  // —— 直播/录屏：会占麦，但不是会议。识别出来只为把话说清楚 ——
  'obs64.exe': { label: 'OBS', kind: 'broadcast' },
  'obs32.exe': { label: 'OBS', kind: 'broadcast' },
  'bilibili直播姬.exe': { label: '哔哩哔哩直播姬', kind: 'broadcast' },
  'douyin.exe': { label: '抖音直播伴侣', kind: 'broadcast' },
  'livecompanion.exe': { label: '抖音直播伴侣', kind: 'broadcast' }
};

/** 浏览器：网页版会议 / 通话走这里，必须配合窗口标题 */
const BROWSERS = [
  'chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe',
  'vivaldi.exe', '360se.exe', '360chrome.exe', 'qqbrowser.exe', 'sogouexplorer.exe'
];

/** 窗口标题里的会议关键词。注意：只对白名单应用 / 浏览器生效。 */
const TITLE_HINTS = [
  '腾讯会议', '钉钉会议', '飞书会议', '视频会议', '语音会议', '会议中', '正在开会',
  '语音通话', '视频通话', '正在通话', '通话中', '屏幕共享', '正在共享', '共享屏幕',
  'google meet', 'zoom meeting', 'zoom 会议', 'webex meeting', 'teams meeting',
  'in a call', 'huddle', 'voice channel', 'meeting - google chrome', 'meet - '
];

// ---------------- 注册表解析 ----------------

/** FILETIME（100ns since 1601）→ Unix 毫秒 */
function filetimeToMs(ft) {
  const v = typeof ft === 'bigint' ? ft : BigInt(String(ft || 0));
  if (v <= 0n) return 0;
  const ms = (v / 10000n) - 11644473600000n;
  return ms > 0n ? Number(ms) : 0;
}

/** 解析十六进制 / 十进制混合的数值（reg query 的 QWORD 一律输出 0x…） */
function parseNum(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return 0;
  if (/^0x[0-9a-f]+$/i.test(s)) return BigInt(s).toString();
  if (/^[0-9]+$/.test(s)) return s;
  return '0';
}

/**
 * 把 `reg query <key> /s` 的输出解析成 { 键路径: { 值名: 值 } }。
 *
 * 输出长这样（键行顶格，值行缩进）：
 *   HKEY_CURRENT_USER\SOFTWARE\...\microphone\NonPackaged
 *       Value    REG_SZ    Allow
 *   HKEY_CURRENT_USER\SOFTWARE\...\NonPackaged\C#Program Files#Tencent#WeMeet#wemeetapp.exe
 *       LastUsedTimeStart    REG_QWORD    0x1dc0e2f2a3b4c5d6
 *       LastUsedTimeStop     REG_QWORD    0x0
 */
function parseRegQuery(text) {
  const out = {};
  let cur = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line) continue;
    if (/^HKEY_/i.test(line)) {
      cur = line.trim();
      if (!out[cur]) out[cur] = {};
      continue;
    }
    const m = /^\s+([^\s].*?)\s{2,}(REG_[A-Z_]+)\s+(.*)$/.exec(line);
    if (m && cur) {
      out[cur][m[1].trim()] = { type: m[2], value: m[3].trim() };
    }
  }
  return out;
}

/**
 * 注册表里 NonPackaged 的键名把反斜杠换成了 `#`：
 *   C#Program Files#Tencent#WeMeet#wemeetapp.exe  →  C:\Program Files\Tencent\WeMeet\wemeetapp.exe
 * Packaged（应用商店应用）则是 `Microsoft.WindowsCamera_8wekyb3d8bbwe` 这种，没有 `#`。
 */
function decodeKeyName(name) {
  const s = String(name || '');
  if (!s.includes('#')) return s;
  return s.split('#').join('\\');
}

/** 从键名里取 exe 文件名（小写）。取不到返回 ''。 */
function exeFromKeyName(name) {
  const decoded = decodeKeyName(name);
  const m = /([^\\/]+\.exe)$/i.exec(decoded);
  return m ? m[1].toLowerCase() : '';
}

/**
 * 从一段 `reg query ...\microphone /s` 的输出里，提取「当前正在使用麦克风」的应用。
 * 判据：LastUsedTimeStop 为 0（还没释放）且 LastUsedTimeStart > 0。
 */
function activeUsers(regText) {
  const tree = parseRegQuery(regText);
  const out = [];
  for (const key of Object.keys(tree)) {
    const vals = tree[key];
    if (!vals.LastUsedTimeStart) continue;
    const start = filetimeToMs(parseNum(vals.LastUsedTimeStart.value));
    const stop = filetimeToMs(parseNum(vals.LastUsedTimeStop && vals.LastUsedTimeStop.value));
    const leaf = key.split('\\').pop();
    // 父级目录是 Packaged（应用商店应用）还是 NonPackaged（普通桌面程序）。
    // 注意别用 /Packaged$/ 去匹配 —— "NonPackaged" 也以 Packaged 结尾。
    const parent = (key.split('\\').slice(0, -1).pop() || '').toLowerCase();
    const exe = exeFromKeyName(leaf);
    // 应用商店应用两种形态：显式的 Packaged 子键，或直接用「包族名」当键名
    // （实机上是后者：microphone\Microsoft.WindowsCamera_8wekyb3d8bbwe）。
    const packaged = parent === 'packaged' || (!exe && /_[a-z0-9]{13}$/i.test(leaf));
    out.push({
      key,
      leaf,
      name: decodeKeyName(leaf),
      exe,
      packaged,
      start,
      stop,
      // Windows 会在应用开始用麦时写 Start、用完时写 Stop（0 = 还没用完）。
      // 两个值都写全了才算「能判断」，免得把只有 Start 的残缺记录当成正在通话。
      stopKnown: !!vals.LastUsedTimeStop,
      active: start > 0 && stop === 0
    });
  }
  return out.sort((a, b) => b.start - a.start);
}

// ---------------- 进程 / 窗口标题 ----------------

/**
 * 解码 Windows 命令行工具的输出。
 *
 * 踩过的坑（实机验证时发现的）：`tasklist` / `reg query` 这些工具按**控制台 OEM 代码页**
 * 输出，简体中文系统上是 GBK/936，而 Node 默认按 UTF-8 解 —— 于是中文窗口标题
 * 全变成「����ͨ��」这种乱码，标题关键词（「语音通话」等）就**永远匹配不上**。
 * 表现是：明明在开会，检测却毫无反应，而且日志里看不出问题。
 *
 * 判据：能被 UTF-8 完整解出来（不含 U+FFFD）就按 UTF-8，否则按 GBK。
 * 纯 ASCII 两种解一致，走哪条都行。
 * 极端情况下（GBK 双字节恰好都是合法 UTF-8 序列）会判错，代价只是标题显示乱码，
 * 所以另外用 decodeOemTextBoth 把两种解都留着做关键词匹配。
 */
function decodeOemText(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf == null ? '' : buf), 'utf8');
  if (!b.length) return '';
  let gbk = null;
  try { gbk = new TextDecoder('gbk'); } catch (e) { gbk = null; }
  if (!gbk) return b.toString('utf8');
  const asUtf8 = b.toString('utf8');
  if (!asUtf8.includes('\uFFFD')) return asUtf8;
  try { return gbk.decode(b); } catch (e) { return asUtf8; }
}

/** 同时给两种解码结果：主用（启发式挑选）+ 备用（另一种），匹配关键词时两个都看 */
function decodeOemTextBoth(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf == null ? '' : buf), 'utf8');
  const primary = decodeOemText(b);
  let alt = '';
  try {
    let gbk = null;
    try { gbk = new TextDecoder('gbk'); } catch (e) { gbk = null; }
    alt = (gbk && primary === b.toString('utf8')) ? gbk.decode(b) : b.toString('utf8');
  } catch (e) { alt = ''; }
  if (alt === primary || alt.includes('\uFFFD')) alt = '';
  return { primary, alt };
}

/** 解析一行 CSV（tasklist 的引号里会带逗号，比如 "300,000 K"） */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  const s = String(line == null ? '' : line);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; }
        else q = false;
      } else cur += ch;
    } else if (ch === '"') {
      q = true;
    } else if (ch === ',') {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** 「没有窗口标题」的各种本地化写法：中文版 Windows 的 tasklist 会给「暂缺」而不是 N/A */
function isNoTitle(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return true;
  return /^(N\/A|暂缺|無|なし|해당 없음|n\/a)$/i.test(s);
}

/**
 * 解析 `tasklist /v /fo csv /nh` 的输出。
 * 列顺序：映像名称, PID, 会话名, 会话#, 内存使用, 状态, 用户名, CPU 时间, 窗口标题
 *
 * @param {string} text
 * @param {{altText?:string}} [opts] altText 是同一份输出的另一种编码解码结果，
 *        用来兜住「编码判错」的情况：标题匹配时两个都看。
 */
function parseTasklist(text, opts = {}) {
  const out = [];
  const altLines = String(opts.altText || '').split(/\r?\n/);
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const c = splitCsvLine(line);
    if (c.length < 2) continue;
    const name = String(c[0] || '').trim();
    if (!/\.exe$/i.test(name)) continue;
    const title = String(c[8] == null ? '' : c[8]).trim();
    const norm = (v) => (isNoTitle(v) ? '' : String(v || '').trim());
    const altTitle = altLines[i] ? norm(splitCsvLine(altLines[i])[8]) : '';
    out.push({
      name,
      exe: name.toLowerCase(),
      pid: Number(String(c[1] || '').replace(/[^\d]/g, '')) || 0,
      mem: String(c[4] || '').trim(),
      title: norm(title),
      // 两种解码不一致时把另一种也留着 —— 关键词匹配时两个都试
      titleAlt: altTitle && altTitle !== norm(title) ? altTitle : ''
    });
  }
  return out;
}

// ---------------- 判定 ----------------

function appInfo(exe) {
  return KNOWN_APPS[String(exe || '').toLowerCase()] || null;
}

function isBrowser(exe) {
  return BROWSERS.includes(String(exe || '').toLowerCase());
}

function isKnown(exe) {
  return !!appInfo(exe) || isBrowser(exe);
}

/** 标题里有没有会议关键词（两种解码可以一起传进来） */
function titleHit(title) {
  const t = String(title || '').toLowerCase();
  if (!t) return '';
  for (const k of TITLE_HINTS) if (t.includes(k.toLowerCase())) return k;
  return '';
}

/** 把「谁在用麦」翻译成人话 */
function labelOf(exe, fallback) {
  const info = appInfo(exe);
  if (info) return info.label;
  const s = String(fallback || exe || '').trim();
  if (!s) return '未知应用';
  const base = s.split(/[\\/]/).pop().replace(/\.exe$/i, '');
  return base || '未知应用';
}

/**
 * 综合判定一次采样结果。
 *
 * @param {object} input
 *   micUsers  activeUsers(mic 注册表输出) 的结果
 *   camUsers  activeUsers(webcam 注册表输出) 的结果
 *   procs     parseTasklist 的结果
 *   selfExe   小问自己的 exe 名（要排除：小问用麦做语音识别，不能算成「在开会」）
 *   allowUnknown  麦克风被非白名单应用占用时，算不算信号（默认 false）
 * @returns {{ level:'none'|'meeting'|'mic', app:string, appExe:string, score:number, reasons:string[] }}
 *   level: 'meeting' 命中白名单（可自动记录）/ 'mic' 只是有应用在用麦（只提示）/ 'none' 无事发生
 */
function classify(input = {}) {
  const micUsers = Array.isArray(input.micUsers) ? input.micUsers : [];
  const camUsers = Array.isArray(input.camUsers) ? input.camUsers : [];
  const procs = Array.isArray(input.procs) ? input.procs : [];
  const selfExe = String(input.selfExe || '').toLowerCase();
  const allowUnknown = input.allowUnknown === true;

  const reasons = [];
  const alive = new Set(procs.map((p) => p.exe));
  const titles = new Map();
  for (const p of procs) if (p.title) titles.set(p.exe, p.title);

  const isSelf = (exe) => !!selfExe && String(exe).toLowerCase() === selfExe;

  // —— 信号 1：谁占着麦克风 ——
  const micHolders = [];
  for (const u of micUsers) {
    if (!u.active) continue;
    if (!u.stopKnown) {
      reasons.push(`${labelOf(u.exe, u.name)} 的麦克风记录不完整（没有 Stop 时间），不采信`);
      continue;
    }
    if (!u.exe) {
      // 应用商店应用没有 exe 名，对不上进程就没法确认它是不是还活着 —— 只能忽略
      if (u.packaged) { reasons.push(`${u.leaf} 是应用商店应用，对不上进程（已忽略）`); continue; }
      reasons.push('检测到有程序占用麦克风（无法识别进程名）');
      continue;
    }
    if (isSelf(u.exe)) { reasons.push('小问自己在用麦克风（忽略）'); continue; }
    if (!alive.has(u.exe)) { reasons.push(`${u.exe} 记录为占用麦克风，但进程已不在（视为残留记录）`); continue; }
    micHolders.push(u.exe);
  }

  const camHolders = [];
  for (const u of camUsers) {
    if (!u.active) continue;
    if (!u.stopKnown) continue;
    if (!u.exe) continue;
    if (isSelf(u.exe)) continue;
    if (!alive.has(u.exe)) continue;
    camHolders.push(u.exe);
  }

  // —— 信号 2：窗口标题 ——
  let titleHitExe = '';
  let titleHitWord = '';
  for (const p of procs) {
    if (isSelf(p.exe)) continue;
    if (!isKnown(p.exe)) continue;
    // 两种解码结果一起匹配：编码判错时另一份就是对的
    const w = titleHit(`${p.title || ''} ${p.titleAlt || ''}`);
    if (w) { titleHitExe = p.exe; titleHitWord = w; break; }
  }

  // —— 优先级：占麦的白名单应用 > 标题命中 > 摄像头 ——
  const pickKnown = (list) => list.find((e) => {
    const info = appInfo(e);
    return info && info.kind !== 'broadcast';
  }) || '';

  let appExe = pickKnown(micHolders) || pickKnown(camHolders);
  let strong = '';
  if (appExe) {
    const src = micHolders.includes(appExe) ? '麦克风' : '摄像头';
    const info = appInfo(appExe);
    strong = `${info.label}正在使用${src}`;
  } else if (titleHitExe && micHolders.includes(titleHitExe)) {
    appExe = titleHitExe;
    strong = `${labelOf(appExe)} 窗口标题命中「${titleHitWord}」且正在使用麦克风`;
  } else if (titleHitExe && camHolders.includes(titleHitExe)) {
    appExe = titleHitExe;
    strong = `${labelOf(appExe)} 窗口标题命中「${titleHitWord}」且正在使用摄像头`;
  }

  if (strong) {
    reasons.unshift(strong);
    return { level: 'meeting', app: labelOf(appExe), appExe, score: 90, reasons };
  }

  // 弱信号：有应用在用麦，但不在「会议 / 通话」白名单里。
  // 注意要把直播/录屏类（OBS 等）算进来 —— 它们在白名单里，但性质不是会议，
  // 也要走弱信号分支，否则会一路掉到「none」，界面上就说不清「有人在用麦但不是开会」。
  const weakMic = micHolders.filter((e) => {
    const info = appInfo(e);
    return !info || info.kind === 'broadcast';
  });
  if (weakMic.length) {
    const first = weakMic[0];
    const info = appInfo(first);
    if (info && info.kind === 'broadcast') {
      reasons.unshift(`${info.label}正在使用麦克风（直播/录屏，不是会议）`);
      return { level: 'mic', app: info.label, appExe: first, score: 40, reasons };
    }
    if (allowUnknown) {
      reasons.unshift(`${labelOf(first, first)} 正在使用麦克风`);
      return { level: 'mic', app: labelOf(first, first), appExe: first, score: 30, reasons };
    }
    reasons.push(`${labelOf(first, first)} 正在使用麦克风（未在会议应用白名单内，已忽略）`);
  }

  // 只有标题命中、但没人用麦 —— 大概率是常驻托盘 / 只是开着页面，不算在开会
  if (titleHitExe) {
    reasons.push(`${labelOf(titleHitExe)} 标题命中「${titleHitWord}」，但没有检测到麦克风占用（可能只是开着窗口）`);
  }

  return { level: 'none', app: '', appExe: '', score: 0, reasons };
}

// ---------------- 迟滞状态机 ----------------

const DEFAULTS = {
  enterSamples: 2,      // 连续几次采到正信号才算「开始了」
  exitMs: 90000,        // 连续多久采不到才算「结束了」
  hintCooldownMs: 10 * 60000, // 「好像要开会？」提示的冷却时间
  hintEnabled: true
};

class MeetingWatcher {
  constructor(opts = {}) {
    this.opt = { ...DEFAULTS, ...opts };
    this.state = 'idle';      // idle | active
    this.streak = 0;
    this.negSince = 0;
    this.since = 0;
    this.lastHintAt = 0;
    this.last = null;
  }

  /**
   * 喂一次采样。
   * @returns {{state:string, changed:boolean, event:null|'hint'|'started'|'ended', durationMs:number, sample:object}}
   */
  feed(sample, now = Date.now()) {
    const s = sample || { level: 'none', app: '', appExe: '', reasons: [] };
    this.last = s;
    const positive = s.level !== 'none';

    if (positive) {
      this.negSince = 0;
      this.streak += 1;
      if (this.state === 'idle' && this.streak >= Math.max(1, this.opt.enterSamples)) {
        this.state = 'active';
        this.since = now;
        return { state: this.state, changed: true, event: 'started', durationMs: 0, sample: s };
      }
      // 只采到一次、还没凑够 —— 可以先轻轻提示一句「要不要开始记录」
      if (this.state === 'idle' && this.opt.hintEnabled) {
        const cd = Math.max(0, this.opt.hintCooldownMs);
        if (!this.lastHintAt || now - this.lastHintAt >= cd) {
          this.lastHintAt = now;
          return { state: this.state, changed: false, event: 'hint', durationMs: 0, sample: s };
        }
      }
      return { state: this.state, changed: false, event: null, durationMs: 0, sample: s };
    }

    // 负信号
    this.streak = 0;
    if (this.state === 'active') {
      if (!this.negSince) this.negSince = now;
      const quiet = now - this.negSince;
      if (quiet >= Math.max(0, this.opt.exitMs)) {
        const dur = this.since ? now - this.since : 0;
        this.state = 'idle';
        this.since = 0;
        this.negSince = 0;
        return { state: this.state, changed: true, event: 'ended', durationMs: dur, sample: s };
      }
      return { state: this.state, changed: false, event: null, durationMs: 0, sample: s };
    }
    return { state: this.state, changed: false, event: null, durationMs: 0, sample: s };
  }

  /** 强制回到 idle（用户在界面上点了「结束」/ 关掉功能时用） */
  reset() {
    this.state = 'idle';
    this.streak = 0;
    this.negSince = 0;
    this.since = 0;
  }

  status() {
    return {
      state: this.state,
      since: this.since,
      streak: this.streak,
      last: this.last ? { level: this.last.level, app: this.last.app, reasons: this.last.reasons } : null
    };
  }
}

module.exports = {
  KNOWN_APPS,
  BROWSERS,
  TITLE_HINTS,
  DEFAULTS,
  MeetingWatcher,
  filetimeToMs,
  parseRegQuery,
  decodeKeyName,
  exeFromKeyName,
  activeUsers,
  decodeOemText,
  decodeOemTextBoth,
  isNoTitle,
  splitCsvLine,
  parseTasklist,
  appInfo,
  isBrowser,
  isKnown,
  titleHit,
  labelOf,
  classify
};
