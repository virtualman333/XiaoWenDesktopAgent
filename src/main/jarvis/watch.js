/**
 * 主动关注 —— 让小问有了「自己盯着点事儿」的能力。
 *
 * 目前三类信源：
 *   quake  地震速报（USGS 公开 GeoJSON，无需 Key）
 *   hot    热搜上榜（百度热搜榜）
 *   weibo  微博热搜（可选，接口不稳定时自动跳过）
 *
 * 逻辑：按各自的间隔轮询 → 去重（记录已推过的条目）→ 命中阈值/关键词
 *      → 走统一的 deliver 播报（宠物气泡 + 托盘气泡 + 面板消息 + 可选朗读）。
 *
 * 首次运行只建立基线、不播报，避免一启动就糊一屏历史消息。
 */
const store = require('./store');
const T = require('./schedule-time');

const FILE = 'watch.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) XiaoWenAssistant/1.6';
const SEEN_TTL = 24 * 3600 * 1000; // 同一件事 24 小时内只提醒一次

let api = {
  getConfig: () => ({}),
  log: () => {},
  deliver: () => {}
};
let timer = null;
let polling = {};

function bind(opts = {}) {
  if (opts.getConfig) api.getConfig = opts.getConfig;
  if (opts.log) api.log = opts.log;
  if (opts.deliver) api.deliver = opts.deliver;
}
function cfg() { return api.getConfig() || {}; }
function log(m) { try { api.log('[主动关注] ' + m); } catch (e) { /* ignore */ } }

function load() {
  const d = store.readJson(FILE, { seen: {}, lastPoll: {}, snap: {}, inited: {} });
  if (!d.seen || typeof d.seen !== 'object') d.seen = {};
  if (!d.lastPoll || typeof d.lastPoll !== 'object') d.lastPoll = {};
  if (!d.snap || typeof d.snap !== 'object') d.snap = {};
  // inited：哪些信源已经建过基线。用它而不是 lastPoll 判断「首轮」，
  // 否则改一下轮询间隔（清掉 lastPoll）就会被当成首次运行、白建一次基线。
  if (!d.inited || typeof d.inited !== 'object') d.inited = {};
  return d;
}
function save(d) {
  // 修剪 seen，别让文件无限膨胀
  const now = Date.now();
  const keys = Object.keys(d.seen);
  if (keys.length > 600) {
    for (const k of keys) if (now - d.seen[k] > SEEN_TTL) delete d.seen[k];
    const rest = Object.keys(d.seen);
    if (rest.length > 600) {
      rest.sort((a, b) => d.seen[a] - d.seen[b]);
      for (const k of rest.slice(0, rest.length - 600)) delete d.seen[k];
    }
  }
  return store.writeJson(FILE, d);
}

function seenRecently(key) {
  const d = load();
  const at = d.seen[key];
  return !!at && (Date.now() - at) < SEEN_TTL;
}
function markSeen(keys) {
  const d = load();
  const now = Date.now();
  for (const k of [].concat(keys)) d.seen[k] = now;
  save(d);
}

// ---------------- 纯逻辑（可单测） ----------------

/** 中国及周边范围（用于「只看国内相关地震」） */
const CN_BOX = { minLat: 15, maxLat: 55, minLon: 72, maxLon: 136 };

function inChinaBox(lat, lon) {
  return lat >= CN_BOX.minLat && lat <= CN_BOX.maxLat && lon >= CN_BOX.minLon && lon <= CN_BOX.maxLon;
}

/** 把 USGS 的 feature 变成一句中文播报 */
function quakeLine(f) {
  const p = (f && f.properties) || {};
  const geo = (f && f.geometry) || {};
  const coords = Array.isArray(geo.coordinates) ? geo.coordinates : [];
  const mag = Number(p.mag);
  const place = String(p.place || '未知区域');
  const depth = Number(coords[2]);
  const d = new Date(Number(p.time) || Date.now());
  const time = `${T.pad2(d.getHours())}:${T.pad2(d.getMinutes())}`;
  const parts = [`M${Number.isFinite(mag) ? mag.toFixed(1) : '?'} 地震`, place, `${time}`];
  if (Number.isFinite(depth)) parts.push(`深度 ${Math.round(depth)}km`);
  return parts.join(' · ');
}

/**
 * 从榜单里挑出「新进前 N」的条目。
 * @param {string[]} prev  上一次的前 N 名（按名次）
 * @param {string[]} cur   本次的前 N 名（按名次）
 */
function diffTop(prev, cur) {
  const old = new Set(Array.isArray(prev) ? prev : []);
  return (Array.isArray(cur) ? cur : []).filter((w) => w && !old.has(w));
}

/** 关键词命中（逗号 / 空格分隔，空则视为全部通过） */
function matchKeywords(text, keywords) {
  const kws = String(keywords == null ? '' : keywords)
    .split(/[,，\s|]+/).map((s) => s.trim()).filter(Boolean);
  if (!kws.length) return true;
  const t = String(text || '');
  return kws.some((k) => t.includes(k));
}

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.round(n), min), max);
}

// ---------------- 抓取 ----------------

async function httpJson(url, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(to);
  }
}

/** 地震：USGS 最近一小时（没有新数据时退回最近一天） */
async function fetchQuakes() {
  let data;
  try {
    data = await httpJson('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson');
  } catch (e) {
    data = await httpJson('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson');
  }
  return Array.isArray(data && data.features) ? data.features : [];
}

/** 百度热搜榜 */
async function fetchBaiduTop() {
  const data = await httpJson('https://top.baidu.com/api/board?platform=wise&tab=realtime');
  const cards = (data && data.data && data.data.cards) || [];
  const items = [];
  for (const card of cards) {
    const list = card && (card.content || card.topContent);
    if (!Array.isArray(list)) continue;
    for (const it of list) {
      const word = String((it && (it.word || it.query || it.name)) || '').trim();
      if (!word) continue;
      items.push({
        word,
        desc: String((it && (it.desc || it.description)) || '').slice(0, 60),
        hot: Number(it && (it.hotScore || it.hot)) || 0,
        url: String((it && (it.url || it.rawUrl)) || '')
      });
    }
    if (items.length) break;
  }
  return items;
}

/** 微博热搜榜 */
async function fetchWeiboTop() {
  const data = await httpJson('https://weibo.com/ajax/side/hotSearch');
  const list = (data && data.data && data.data.realtime) || [];
  return list.map((it) => ({
    word: String((it && (it.word || it.note)) || '').trim(),
    desc: String((it && it.note) || '').slice(0, 60),
    hot: Number(it && it.num) || 0,
    url: it && it.word_scheme ? `https://s.weibo.com/weibo?q=${encodeURIComponent(it.word_scheme)}` : ''
  })).filter((x) => x.word);
}

// ---------------- 播报 ----------------

function deliver(payload) {
  const c = cfg();
  if (c.watchPet === false && payload.pet !== false) payload.pet = false;
  try { api.deliver(payload); } catch (e) { log('播报失败: ' + ((e && e.message) || e)); }
}

function quiet() {
  return T.inQuietHours(cfg().watchMute);
}

// ---------------- 各信源的轮询 ----------------

async function pollQuake(force = false) {
  const c = cfg();
  if (!force && c.watchQuake === false) return { ok: true, skipped: 'off' };
  const minMag = Number(c.watchQuakeMinMag) || 5;
  const region = c.watchQuakeRegion === 'global' ? 'global' : 'cn';

  let feats = [];
  try { feats = await fetchQuakes(); }
  catch (e) { log('地震数据抓取失败: ' + ((e && e.message) || e)); return { ok: false, error: '抓取失败' }; }

  const d = load();
  const firstRun = !d.inited.quake;
  const now = Date.now();
  const fresh = feats.filter((f) => {
    const p = (f && f.properties) || {};
    const mag = Number(p.mag);
    if (!Number.isFinite(mag) || mag < minMag) return false;
    const coords = ((f && f.geometry) || {}).coordinates || [];
    if (region === 'cn' && !inChinaBox(Number(coords[1]), Number(coords[0]))) return false;
    // 只推最近 45 分钟内发生的，避免把榜单里的历史数据当成突发
    return now - (Number(p.time) || 0) < 45 * 60000;
  }).sort((a, b) => (b.properties.mag || 0) - (a.properties.mag || 0));

  d.lastPoll.quake = now;
  d.inited.quake = true;
  save(d);

  if (firstRun) {
    markSeen(fresh.slice(0, 50).map((f) => 'quake:' + (f.id || f.properties.time)));
    log(`地震信源就绪（基线 ${fresh.length} 条，不播报）`);
    return { ok: true, baseline: fresh.length };
  }

  const news = fresh.filter((f) => !seenRecently('quake:' + (f.id || f.properties.time)));
  if (!news.length) return { ok: true, count: 0 };

  markSeen(news.map((f) => 'quake:' + (f.id || f.properties.time)));

  // 一次来好几条时，报最强的两条 + 条数
  const lines = news.slice(0, 2).map(quakeLine);
  if (news.length > 2) lines.push(`（另有 ${news.length - 2} 次较小地震未逐条播报）`);
  const text = lines.join('\n');

  if (!force && quiet()) { log('静默时段，地震消息只记录不播报'); return { ok: true, muted: news.length }; }

  const strongest = news[0];
  deliver({
    kind: 'quake',
    title: `🔔 地震速报 · M${Number(strongest.properties.mag).toFixed(1)}`,
    text,
    open: force || cfg().watchOpenPanel === true || Number(strongest.properties.mag) >= 6,
    speak: cfg().watchSpeak === true,
    pet: cfg().watchPet !== false,
    urgent: Number(strongest.properties.mag) >= 6
  });
  return { ok: true, count: news.length };
}

async function pollTop(kind, force = false) {
  const c = cfg();
  const onKey = kind === 'hot' ? 'watchHot' : 'watchWeibo';
  // 微博默认关闭，只有显式打开才跑
  if (!force) {
    if (kind === 'hot' && c.watchHot === false) return { ok: true, skipped: 'off' };
    if (kind === 'weibo' && c.watchWeibo !== true) return { ok: true, skipped: 'off' };
  }

  let items = [];
  try {
    items = kind === 'hot' ? await fetchBaiduTop() : await fetchWeiboTop();
  } catch (e) {
    log(`${kind} 榜单抓取失败: ` + ((e && e.message) || e));
    return { ok: false, error: '抓取失败' };
  }
  if (!items.length) return { ok: true, count: 0 };

  const topN = clampInt(c.watchHotTop, 1, 20, 5);
  const curTop = items.slice(0, topN).map((x) => x.word);
  const d = load();
  const prev = Array.isArray(d.snap[kind]) ? d.snap[kind] : null;
  d.snap[kind] = curTop;
  d.lastPoll[kind] = Date.now();
  d.inited[kind] = true;
  save(d);

  if (!prev) {
    log(`${kind} 榜单就绪（基线 ${curTop.length} 条，不播报）`);
    return { ok: true, baseline: curTop.length };
  }

  const newcomers = diffTop(prev, curTop)
    .map((w) => items.find((x) => x.word === w))
    .filter(Boolean)
    .filter((x) => !seenRecently(`${kind}:${x.word}`))
    .filter((x) => matchKeywords(x.word + ' ' + x.desc, c.watchKeywords));

  if (!newcomers.length) return { ok: true, count: 0 };
  markSeen(newcomers.map((x) => `${kind}:${x.word}`));

  if (!force && quiet()) { log('静默时段，热搜消息只记录不播报'); return { ok: true, muted: newcomers.length }; }

  const picked = newcomers.slice(0, 3);
  const text = picked.map((x, i) => `${i + 1}. ${x.word}${x.hot ? `（热度 ${x.hot}）` : ''}`).join('\n')
    + (newcomers.length > picked.length ? `\n（还有 ${newcomers.length - picked.length} 条新上榜）` : '');

  deliver({
    kind,
    title: kind === 'hot' ? '🔥 热搜新上榜' : '🔥 微博新上榜',
    text,
    open: force || c.watchOpenPanel === true,
    speak: c.watchSpeak === true,
    pet: c.watchPet !== false,
    url: picked[0] && picked[0].url ? picked[0].url : ''
  });
  return { ok: true, count: newcomers.length };
}

const POLLERS = {
  quake: () => pollQuake(false),
  hot: () => pollTop('hot', false),
  weibo: () => pollTop('weibo', false)
};

/** 手动「立即检查」，忽略静默时段和开关 */
async function checkNow(source) {
  const s = String(source || 'quake');
  if (s === 'quake') return pollQuake(true);
  if (s === 'hot' || s === 'weibo') return pollTop(s, true);
  return { ok: false, error: '未知信源' };
}

const DEFAULT_INTERVAL = { quake: 5, hot: 30, weibo: 30 };

async function tick() {
  const c = cfg();
  if (c.watchEnabled === false) return;
  const d = load();
  const now = Date.now();
  const jobs = [];

  for (const key of Object.keys(POLLERS)) {
    if (key === 'weibo' && c.watchWeibo !== true) continue;
    if (key === 'quake' && c.watchQuake === false) continue;
    if (key === 'hot' && c.watchHot === false) continue;
    if (polling[key]) continue;

    const ivKey = key === 'quake' ? 'watchQuakeInterval' : 'watchHotInterval';
    const iv = clampInt(c[ivKey], 1, 720, DEFAULT_INTERVAL[key]);
    const last = Number(d.lastPoll[key]) || 0;
    if (now - last < iv * 60000) continue;
    jobs.push(key);
  }

  for (const key of jobs) {
    polling[key] = true;
    try { await POLLERS[key](); }
    catch (e) { log(`${key} 轮询异常: ` + ((e && e.message) || e)); }
    finally { polling[key] = false; }
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, 60000);
  if (timer.unref) timer.unref();
  // 启动 30 秒后先跑一轮（首轮只建基线）
  setTimeout(() => { tick().catch(() => {}); }, 30000);
  log('主动关注已启动');
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function status() {
  const c = cfg();
  const d = load();
  return {
    enabled: c.watchEnabled !== false,
    quake: { on: c.watchQuake !== false, minMag: Number(c.watchQuakeMinMag) || 5, region: c.watchQuakeRegion || 'cn', lastPoll: d.lastPoll.quake || 0, inited: !!d.inited.quake },
    hot: { on: c.watchHot !== false, lastPoll: d.lastPoll.hot || 0, snap: d.snap.hot || [], inited: !!d.inited.hot },
    weibo: { on: c.watchWeibo === true, lastPoll: d.lastPoll.weibo || 0 },
    quiet: T.inQuietHours(c.watchMute),
    quietRange: c.watchMute || ''
  };
}

module.exports = {
  bind,
  start,
  stop,
  tick,
  checkNow,
  status,
  // 纯逻辑导出，供回归测试
  quakeLine,
  diffTop,
  matchKeywords,
  inChinaBox,
  CN_BOX
};
