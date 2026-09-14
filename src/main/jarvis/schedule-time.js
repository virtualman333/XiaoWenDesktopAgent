/**
 * 定时任务的时间计算 —— 纯函数，不依赖 Electron，方便直接跑回归测试。
 *
 * 支持五种排期（全部按本机时区，也就是主人在的时区）：
 *   once     { type:'once',      at: 1757822400000 | '2026-09-15 09:00' | ISO 串 }
 *   daily    { type:'daily',     time:'08:30' }
 *   weekly   { type:'weekly',    time:'09:00', days:[1,3,5] }   0=周日 … 6=周六
 *   monthly  { type:'monthly',   time:'09:00', day:1 }          1~31
 *   interval { type:'interval',  minutes:30 }                   每 30 分钟一次
 *
 * 另外支持几种「人话」简写，模型/用户都可能直接这么写：
 *   '08:30'            → daily
 *   '每30分钟' / '30m'  → interval
 *   '2026-09-15 09:00' → once
 */

const DAY_MS = 86400000;

const WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad2(n) { return String(n).padStart(2, '0'); }

/** '8:30' / '08：30' → { h:8, mi:30 }；非法返回 null */
function parseTime(v) {
  const m = /^(\d{1,2})\s*[:：]\s*(\d{1,2})$/.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return { h, mi };
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 解析『每N分钟』这类写法，返回分钟数或 0 */
function parseIntervalMinutes(v) {
  const s = String(v == null ? '' : v).trim();
  let m = /^(\d+)\s*(m|min|minute|minutes)$/i.exec(s);
  if (m) return Number(m[1]);
  m = /^每\s*(?:隔\s*)?(\d+)\s*分钟?$/.exec(s);
  if (m) return Number(m[1]);
  m = /^每\s*(?:隔\s*)?(\d+)\s*(?:个)?\s*小时$/.exec(s);
  if (m) return Number(m[1]) * 60;
  m = /^(\d+)\s*(h|hour|hours)$/i.exec(s);
  if (m) return Number(m[1]) * 60;
  return 0;
}

// 中文数字（只处理常见的 1~31 和时段，够用就行）
const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 把「一」「十」「十五」「二十」「二十三」译成数字；失败返回 null */
function cnNumber(s) {
  const str = String(s || '');
  if (/^\d+$/.test(str)) return Number(str);
  if (!/^[零一二两三四五六七八九十]+$/.test(str)) return null;
  if (str.length === 1) return CN_NUM[str] != null ? CN_NUM[str] : null;
  const idx = str.indexOf('十');
  if (idx === 0) {
    const r = str.slice(1);
    return 10 + (r ? (CN_NUM[r] != null ? CN_NUM[r] : null) : 0);
  }
  const high = CN_NUM[str[0]];
  if (high == null) return null;
  const low = str.slice(idx + 1);
  if (!low) return high * 10;
  const l = CN_NUM[low];
  return l == null ? null : high * 10 + l;
}

const DAY_MAP = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

/**
 * 从一句人话里「抠」出时间点。
 *   '每天 08:30' / '8点30' / '早上8点半' / '晚上 8 点' / '下午三点'
 * 带 下午/晚上 → 自动 +12 小时；带 早上/上午/凌晨 → 保持原值。
 */
function parseClockLoose(raw) {
  const s = String(raw == null ? '' : raw);
  const pm = /(下午|晚上|傍晚|夜里|夜间)/.test(s);
  const am = /(上午|早上|早晨|凌晨|清早)/.test(s);

  let h = null;
  let mi = 0;

  let m = /(\d{1,2})\s*[:：]\s*(\d{1,2})/.exec(s);
  if (m) {
    h = Number(m[1]);
    mi = Number(m[2]);
  } else {
    // 8点 / 8点半 / 8点15分 / 八点半 / 下午三点
    m = /(\d{1,2}|[一二两三四五六七八九十]+)\s*[点時时]\s*(半|\d{1,2}|[一二两三四五六七八九十]+)?/.exec(s);
    if (m) {
      const hv = cnNumber(m[1]);
      if (hv == null) return null;
      h = hv;
      if (m[2] === '半') mi = 30;
      else if (m[2] != null) {
        const mv = cnNumber(m[2]);
        if (mv == null) return null;
        mi = mv;
      }
    }
  }
  if (h == null) return null;
  if (pm && h < 12) h += 12;
  if (!pm && !am && h >= 1 && h <= 6) h += 0; // 凌晨/早上没写清就按原值
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return { h, mi };
}

/** 从「每周一三五」「周一、周三」「每周日」里抠出星期几（0=周日） */
function parseWeekdays(s) {
  const days = new Set();
  const re = /周\s*([一二三四五六日天]+)/g;
  let m;
  while ((m = re.exec(s))) {
    for (const ch of m[1]) if (ch in DAY_MAP) days.add(DAY_MAP[ch]);
  }
  return Array.from(days).sort((a, b) => a - b);
}

/**
 * 中文人话排期。识别不了返回 null。
 *   每天 08:30 / 每日 9 点      → daily
 *   每周一 09:00 / 每周一三五 9 点 → weekly
 *   每月 1 号 09:00             → monthly
 *   每 2 小时 / 每隔 30 分钟     → interval
 */
function parseWhenCn(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  if (!/[每周月天日点時时号:]/.test(s)) return null;

  const clock = parseClockLoose(s);

  // 1) 每隔 N 分钟 / 每 N 小时 / 每小时
  const isCalendarUnit = /每\s*[周月日天]|每日|每周|每月/.test(s);
  if (!isCalendarUnit) {
    const iv = parseIntervalMinutes(s) || (/每\s*(?:个)?\s*小时|每小时/.test(s) ? 60 : 0);
    if (iv > 0) return { type: 'interval', minutes: iv };
  }

  // 2) 每周一三五 09:00
  if (/每\s*个?\s*周|每周|周\s*[一二三四五六日天]/.test(s)) {
    const days = parseWeekdays(s);
    const t = clock || { h: 9, mi: 0 };
    return {
      type: 'weekly',
      time: `${pad2(t.h)}:${pad2(t.mi)}`,
      days: days.length ? days : [new Date().getDay()]
    };
  }

  // 3) 每月 1 号 09:00
  if (/每\s*个?\s*月|每月/.test(s)) {
    let m = /(\d{1,2})\s*[号日]/.exec(s) || /月\s*(\d{1,2})/.exec(s);
    const day = m ? Math.min(Math.max(Number(m[1]), 1), 31) : 1;
    const t = clock || { h: 9, mi: 0 };
    return { type: 'monthly', time: `${pad2(t.h)}:${pad2(t.mi)}`, day };
  }

  // 4) 每天 / 每日（没写时间就默认早 9 点）
  if (/每\s*[天日]|每日|天天/.test(s) || clock) {
    const t = clock || { h: 9, mi: 0 };
    return { type: 'daily', time: `${pad2(t.h)}:${pad2(t.mi)}` };
  }
  return null;
}

/**
 * 把各种写法统一成 when 对象。无法识别时返回 null。
 */
function normalizeWhen(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    const t = parseTime(s);
    if (t) return { type: 'daily', time: `${pad2(t.h)}:${pad2(t.mi)}` };
    const iv = parseIntervalMinutes(s);
    if (iv > 0) return { type: 'interval', minutes: iv };
    // 具体日期（2026-09-20 09:00）要排在中文人话之前，否则会被当成「每天 09:00」
    const ts = Date.parse(s.replace(/\//g, '-'));
    if (Number.isFinite(ts)) return { type: 'once', at: ts };
    const cn = parseWhenCn(s);
    if (cn) return cn;
    return null;
  }
  if (typeof raw !== 'object') return null;

  const type = String(raw.type || '').toLowerCase();
  if (type === 'once' || raw.at || raw.datetime) {
    let at = raw.at != null ? raw.at : raw.datetime;
    if (typeof at === 'string') {
      const s = at.trim();
      const t = parseTime(s);
      // '09:00' 当一次性任务 → 下一个 09:00
      if (t) {
        const base = startOfDay(Date.now()) + t.h * 3600000 + t.mi * 60000;
        at = base > Date.now() ? base : base + DAY_MS;
      } else {
        at = Date.parse(s.replace(/\//g, '-').replace(' ', 'T'));
      }
    }
    at = Number(at);
    if (!Number.isFinite(at) || at <= 0) return null;
    return { type: 'once', at };
  }
  if (type === 'interval' || raw.minutes || raw.every) {
    let minutes = Number(raw.minutes || raw.every || 0);
    if (!minutes && typeof raw.every === 'string') minutes = parseIntervalMinutes(raw.every);
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    return { type: 'interval', minutes: Math.max(1, Math.round(minutes)) };
  }
  if (type === 'monthly' || raw.day) {
    const t = parseTime(raw.time || '09:00') || { h: 9, mi: 0 };
    const day = Math.min(Math.max(Number(raw.day) || 1, 1), 31);
    return { type: 'monthly', time: `${pad2(t.h)}:${pad2(t.mi)}`, day };
  }
  if (type === 'weekly' || raw.days) {
    const t = parseTime(raw.time || '09:00') || { h: 9, mi: 0 };
    let days = Array.isArray(raw.days) ? raw.days : [raw.days];
    days = days.map((d) => Number(d)).filter((d) => Number.isFinite(d) && d >= 0 && d <= 7)
      .map((d) => (d === 7 ? 0 : d));
    if (!days.length) days = [new Date().getDay()];
    return { type: 'weekly', time: `${pad2(t.h)}:${pad2(t.mi)}`, days: Array.from(new Set(days)).sort() };
  }
  if (type === 'daily' || raw.time) {
    const t = parseTime(raw.time || '09:00');
    if (!t) return null;
    return { type: 'daily', time: `${pad2(t.h)}:${pad2(t.mi)}` };
  }
  return null;
}

/**
 * 算出下一次触发时间（毫秒）。
 * @param {object} when   normalizeWhen 之后的对象
 * @param {number} from   从这个时刻往后找，默认现在
 * @param {number} base   interval 类型的基准（一般是上次执行时间）
 * @returns {number} 时间戳；once 已经过期返回 0
 */
function computeNext(when, from = Date.now(), base = 0) {
  const w = normalizeWhen(when);
  if (!w) return 0;

  if (w.type === 'once') {
    return w.at > from ? w.at : 0;
  }

  if (w.type === 'interval') {
    const step = w.minutes * 60000;
    let next = (base && base > 0 ? base : from) + step;
    // 电脑休眠/关机期间错过的，只补到「下一个还没到的点」，避免一连串补跑
    let guard = 0;
    while (next <= from && guard < 10000) { next += step; guard++; }
    return next;
  }

  const t = parseTime(w.time) || { h: 9, mi: 0 };
  const dayStart = startOfDay(from);
  const offset = t.h * 3600000 + t.mi * 60000;

  if (w.type === 'daily') {
    const today = dayStart + offset;
    return today > from ? today : today + DAY_MS;
  }

  if (w.type === 'weekly') {
    for (let i = 0; i <= 7; i++) {
      const candidate = dayStart + i * DAY_MS + offset;
      const dow = new Date(candidate).getDay();
      if (w.days.includes(dow) && candidate > from) return candidate;
    }
    return 0;
  }

  if (w.type === 'monthly') {
    const d = new Date(from);
    for (let i = 0; i <= 13; i++) {
      const y = d.getFullYear();
      const m = d.getMonth() + i;
      const candidate = new Date(y, m, w.day, t.h, t.mi, 0, 0);
      // 2 月 31 号这种不存在的日期会被 JS 顺延，跳过
      if (candidate.getDate() !== w.day) continue;
      const ts = candidate.getTime();
      if (ts > from) return ts;
    }
    return 0;
  }

  return 0;
}

/** 人话描述这个排期 */
function describeWhen(when) {
  const w = normalizeWhen(when);
  if (!w) return '（无效排期）';
  if (w.type === 'once') {
    const d = new Date(w.at);
    return `仅一次 · ${fmtDateTime(d)}`;
  }
  if (w.type === 'interval') {
    if (w.minutes % 60 === 0) return `每 ${w.minutes / 60} 小时`;
    return `每 ${w.minutes} 分钟`;
  }
  if (w.type === 'daily') return `每天 ${w.time}`;
  if (w.type === 'weekly') return `每 ${w.days.map((d) => WEEK_NAMES[d]).join('、')} ${w.time}`;
  if (w.type === 'monthly') return `每月 ${w.day} 号 ${w.time}`;
  return '（无效排期）';
}

function fmtDateTime(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 距现在多久（人话） */
function describeEta(ts, now = Date.now()) {
  if (!ts) return '—';
  const diff = ts - now;
  if (diff <= 0) return '即将执行';
  const min = Math.round(diff / 60000);
  if (min < 1) return '不到 1 分钟';
  if (min < 60) return `${min} 分钟后`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时 ${min % 60} 分钟后`;
  return `${Math.floor(h / 24)} 天后`;
}

/**
 * 静默时段判断。range 形如 '23:00-07:00'，支持跨零点。
 * 空 / 非法 → 永不静默。
 */
function inQuietHours(range, now = Date.now()) {
  const s = String(range == null ? '' : range).trim();
  if (!s || s === '-' || s === 'off') return false;
  const m = /^(\d{1,2}[:：]\d{1,2})\s*[-~至]\s*(\d{1,2}[:：]\d{1,2})$/.exec(s);
  if (!m) return false;
  const a = parseTime(m[1]);
  const b = parseTime(m[2]);
  if (!a || !b) return false;
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  const start = a.h * 60 + a.mi;
  const end = b.h * 60 + b.mi;
  if (start === end) return false;
  if (start < end) return cur >= start && cur < end;
  // 跨零点
  return cur >= start || cur < end;
}

module.exports = {
  DAY_MS,
  WEEK_NAMES,
  pad2,
  parseTime,
  parseIntervalMinutes,
  parseClockLoose,
  parseWeekdays,
  parseWhenCn,
  normalizeWhen,
  computeNext,
  describeWhen,
  describeEta,
  inQuietHours,
  fmtDateTime,
  startOfDay
};
