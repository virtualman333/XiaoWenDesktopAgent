/**
 * 桌面宠物 —— QQ 企鹅式互动宠物
 *
 * 6 只手绘 SVG 动物（企鹅 / 橘猫 / 熊猫 / 兔子 / 柴犬 / 青蛙），
 * 支持拖拽、点击互动、喂食、睡觉、散步、等级成长、气泡对话。
 *
 * 关键实现：
 *  - 窗口整体鼠标穿透，只有宠物身体区域接管鼠标（mouseenter/leave 动态开关）
 *  - 眨眼 = 缩放 .eyeball；眼神跟随 = 平移 .eye（两个 transform 分层，互不覆盖）
 *  - 散步由渲染层算路径，通过增量 IPC 移动窗口
 */

// ==================== 动物库 ====================
const EYE = (x, y, r, color, extra = '') =>
  `<g class="eye eye-l" data-eye="l"><ellipse class="eyeball" cx="${x}" cy="${y}" rx="${r}" ry="${r * 1.12}" fill="${color}" ${extra}/></g>`;
const EYE_R = (x, y, r, color, extra = '') =>
  `<g class="eye eye-r" data-eye="r"><ellipse class="eyeball" cx="${x}" cy="${y}" rx="${r}" ry="${r * 1.12}" fill="${color}" ${extra}/></g>`;
const SHINE = (x, y, r) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" opacity=".9"/>`;

const ANIMALS = {
  penguin: {
    name: '企鹅', emoji: '🐧', tint: '#3a4152',
    svg: `<svg viewBox="0 0 120 130">
      <ellipse cx="44" cy="119" rx="15" ry="7" fill="#f7a93b"/><ellipse cx="76" cy="119" rx="15" ry="7" fill="#f7a93b"/>
      <ellipse class="wing wing-l" cx="19" cy="75" rx="11" ry="25" fill="#2f3542"/>
      <ellipse class="wing wing-r" cx="101" cy="75" rx="11" ry="25" fill="#2f3542"/>
      <ellipse cx="60" cy="75" rx="39" ry="43" fill="#3a4152"/>
      <ellipse cx="60" cy="81" rx="28" ry="34" fill="#fdfdfd"/>
      <circle cx="60" cy="41" r="30" fill="#3a4152"/>
      <ellipse cx="60" cy="47" rx="22" ry="20" fill="#fdfdfd"/>
      ${EYE(51, 43, 5, '#22262f')}${EYE_R(69, 43, 5, '#22262f')}
      <path d="M53 55 Q60 63 67 55 Q60 58 53 55Z" fill="#f7a93b"/>
      <ellipse cx="40" cy="53" rx="5.5" ry="3.2" fill="#ffb0b0" opacity=".75"/>
      <ellipse cx="80" cy="53" rx="5.5" ry="3.2" fill="#ffb0b0" opacity=".75"/>
    </svg>`,
    lines: { happy: ['摇摇摆摆最开心！', '企鹅蹦迪中～', '主人最好了！'], idle: ['主人你在忙吗？', '南极好远，这里好暖和～', '（摇摇摆摆）'], food: ['小鱼干！' ] }
  },

  cat: {
    name: '橘猫', emoji: '🐱', tint: '#f9b167',
    svg: `<svg viewBox="0 0 120 130">
      <path d="M95 106 q24 4 20 -24" stroke="#f0a44c" stroke-width="11" fill="none" stroke-linecap="round"/>
      <ellipse cx="42" cy="118" rx="12" ry="6" fill="#fff5e8"/><ellipse cx="78" cy="118" rx="12" ry="6" fill="#fff5e8"/>
      <ellipse cx="60" cy="82" rx="34" ry="36" fill="#f9b167"/>
      <ellipse cx="60" cy="88" rx="22" ry="26" fill="#fff5e8"/>
      <circle cx="60" cy="44" r="30" fill="#f9b167"/>
      <path d="M34 30 L30 5 L53 20Z" fill="#f9b167"/><path d="M86 30 L90 5 L67 20Z" fill="#f9b167"/>
      <path d="M36 26 L34 12 L47 20Z" fill="#ffc7a0"/><path d="M84 26 L86 12 L73 20Z" fill="#ffc7a0"/>
      ${EYE(48, 44, 5.5, '#2f3542')}${EYE_R(72, 44, 5.5, '#2f3542')}
      <path d="M60 53 l-4.5 4.5 h9Z" fill="#e2736b"/>
      <path d="M54.5 59 q5.5 5.5 11 0" stroke="#2f3542" stroke-width="2" fill="none" stroke-linecap="round"/>
      <g stroke="#fff" stroke-width="1.6" opacity=".95" stroke-linecap="round">
        <line x1="33" y1="51" x2="16" y2="47"/><line x1="33" y1="56" x2="16" y2="58"/>
        <line x1="87" y1="51" x2="104" y2="47"/><line x1="87" y1="56" x2="104" y2="58"/>
      </g>
    </svg>`,
    lines: { happy: ['喵～（蹭蹭）', '呼噜呼噜…', '猫猫很高兴！'], idle: ['喵？', '（舔爪子）', '阳光正好，打个盹…', '铲屎的，摸摸我'], food: ['猫条！喵！'] }
  },

  panda: {
    name: '熊猫', emoji: '🐼', tint: '#3a3a3a',
    svg: `<svg viewBox="0 0 120 130">
      <ellipse cx="40" cy="118" rx="14" ry="8" fill="#3a3a3a"/><ellipse cx="80" cy="118" rx="14" ry="8" fill="#3a3a3a"/>
      <ellipse cx="22" cy="82" rx="13" ry="24" fill="#3a3a3a"/><ellipse cx="98" cy="82" rx="13" ry="24" fill="#3a3a3a"/>
      <ellipse cx="60" cy="80" rx="38" ry="40" fill="#fdfdfd"/>
      <ellipse cx="60" cy="88" rx="24" ry="26" fill="#f2f2f2"/>
      <circle cx="60" cy="42" r="31" fill="#fdfdfd"/>
      <circle cx="31" cy="20" r="12" fill="#3a3a3a"/><circle cx="89" cy="20" r="12" fill="#3a3a3a"/>
      <ellipse cx="48" cy="44" rx="12" ry="13.5" fill="#3a3a3a" transform="rotate(-14 48 44)"/>
      <ellipse cx="72" cy="44" rx="12" ry="13.5" fill="#3a3a3a" transform="rotate(14 72 44)"/>
      ${EYE(48, 44, 4.6, '#fdfdfd')}${EYE_R(72, 44, 4.6, '#fdfdfd')}
      <ellipse cx="60" cy="57" rx="5" ry="3.6" fill="#3a3a3a"/>
      <path d="M55 61 q5 4.5 10 0" stroke="#3a3a3a" stroke-width="2" fill="none" stroke-linecap="round"/>
      <ellipse cx="36" cy="56" rx="5" ry="3" fill="#ffb0b0" opacity=".5"/>
      <ellipse cx="84" cy="56" rx="5" ry="3" fill="#ffb0b0" opacity=".5"/>
    </svg>`,
    lines: { happy: ['（抱住竹子）', '滚滚滚～', '嘿嘿～'], idle: ['今天吃竹子还是睡觉呢…', '（打滚）', '竹林真香'], food: ['竹子！咔嚓咔嚓'] }
  },

  rabbit: {
    name: '兔子', emoji: '🐰', tint: '#fdfdfd',
    svg: `<svg viewBox="0 0 120 130">
      <ellipse cx="60" cy="120" rx="26" ry="7" fill="#f0f0f2"/>
      <circle cx="97" cy="100" r="12" fill="#fff"/>
      <ellipse cx="60" cy="86" rx="33" ry="33" fill="#fdfdfd"/>
      <ellipse cx="60" cy="92" rx="21" ry="23" fill="#fff"/>
      <circle cx="60" cy="52" r="29" fill="#fdfdfd"/>
      <ellipse cx="42" cy="18" rx="10" ry="27" fill="#fdfdfd" transform="rotate(-13 42 18)"/>
      <ellipse cx="78" cy="18" rx="10" ry="27" fill="#fdfdfd" transform="rotate(13 78 18)"/>
      <ellipse cx="42" cy="20" rx="5" ry="19" fill="#ffc2d1" transform="rotate(-13 42 20)"/>
      <ellipse cx="78" cy="20" rx="5" ry="19" fill="#ffc2d1" transform="rotate(13 78 20)"/>
      ${EYE(49, 52, 5.2, '#3a3a44')}${EYE_R(71, 52, 5.2, '#3a3a44')}
      <path d="M60 62 l-4 3.6 h8Z" fill="#ff9db3"/>
      <path d="M55 67 q5 4.5 10 0" stroke="#3a3a44" stroke-width="1.8" fill="none" stroke-linecap="round"/>
      <ellipse cx="38" cy="62" rx="5.5" ry="3.2" fill="#ffb0c4" opacity=".8"/>
      <ellipse cx="82" cy="62" rx="5.5" ry="3.2" fill="#ffb0c4" opacity=".8"/>
    </svg>`,
    lines: { happy: ['（蹦蹦跳跳）', '耳朵竖起来啦！', '胡萝卜！'], idle: ['蹦蹦？', '（竖起耳朵听）', '今天天气真好～'], food: ['胡萝卜最棒！'] }
  },

  shiba: {
    name: '柴犬', emoji: '🐶', tint: '#e8a86a',
    svg: `<svg viewBox="0 0 120 130">
      <path d="M96 92 q22 -2 14 -26 q-4 -10 -14 -4" stroke="#e0a468" stroke-width="12" fill="none" stroke-linecap="round"/>
      <ellipse cx="42" cy="119" rx="12" ry="6" fill="#fff6ea"/><ellipse cx="78" cy="119" rx="12" ry="6" fill="#fff6ea"/>
      <ellipse cx="60" cy="82" rx="34" ry="35" fill="#e8a86a"/>
      <ellipse cx="60" cy="90" rx="21" ry="25" fill="#fff6ea"/>
      <circle cx="60" cy="44" r="30" fill="#e8a86a"/>
      <path d="M33 30 L31 6 L54 19Z" fill="#e8a86a"/><path d="M87 30 L89 6 L66 19Z" fill="#e8a86a"/>
      <path d="M35 26 L34 13 L47 19Z" fill="#ffd9b0"/><path d="M85 26 L86 13 L73 19Z" fill="#ffd9b0"/>
      <ellipse cx="60" cy="54" rx="18" ry="15" fill="#fff6ea"/>
      ${EYE(48, 44, 5, '#3a3226')}${EYE_R(72, 44, 5, '#3a3226')}
      <ellipse cx="60" cy="51" rx="5.5" ry="4" fill="#3a3226"/>
      <path d="M53 60 q7 7 14 0" stroke="#3a3226" stroke-width="2" fill="none" stroke-linecap="round"/>
      <ellipse cx="37" cy="55" rx="5" ry="3" fill="#ff9d7a" opacity=".55"/>
      <ellipse cx="83" cy="55" rx="5" ry="3" fill="#ff9d7a" opacity=".55"/>
    </svg>`,
    lines: { happy: ['汪汪！（摇尾巴）', '出去玩！出去玩！', '最喜欢主人了'], idle: ['汪？', '（歪头）', '嗅嗅…'], food: ['肉干！汪！'] }
  },

  frog: {
    name: '青蛙', emoji: '🐸', tint: '#7cc47f',
    svg: `<svg viewBox="0 0 120 130">
      <ellipse cx="34" cy="118" rx="15" ry="7" fill="#5fa86a"/><ellipse cx="86" cy="118" rx="15" ry="7" fill="#5fa86a"/>
      <ellipse cx="60" cy="84" rx="40" ry="36" fill="#7cc47f"/>
      <ellipse cx="60" cy="92" rx="26" ry="24" fill="#dff3dc"/>
      <ellipse cx="38" cy="52" rx="17" ry="16" fill="#7cc47f"/><ellipse cx="82" cy="52" rx="17" ry="16" fill="#7cc47f"/>
      <circle cx="38" cy="52" r="12" fill="#fff"/><circle cx="82" cy="52" r="12" fill="#fff"/>
      ${EYE(38, 53, 6, '#2f3542')}${EYE_R(82, 53, 6, '#2f3542')}
      <path d="M34 78 q26 20 52 0" stroke="#4f9358" stroke-width="3.5" fill="none" stroke-linecap="round"/>
      <ellipse cx="30" cy="70" rx="6" ry="3.6" fill="#ff9db3" opacity=".6"/>
      <ellipse cx="90" cy="70" rx="6" ry="3.6" fill="#ff9db3" opacity=".6"/>
    </svg>`,
    lines: { happy: ['呱呱！（跳）', '池塘最棒！', '呱～'], idle: ['呱？', '（鼓腮帮子）', '荷叶真舒服…'], food: ['小虫子！'] }
  }
};

// 通用台词池
const LINES = {
  click: ['（蹭蹭主人）', '摸摸头～', '嘿嘿', '在呢在呢！', '主人找我？', '（歪头看）'],
  drag: ['哇——飞起来了！', '轻点轻点～', '要掉下去啦！'],
  hungry: ['肚子咕咕叫…', '主人，我饿了…', '有吃的吗？'],
  sleepy: ['好困…', '（打哈欠）', '眼皮好重…'],
  levelUp: ['升级啦！我变强了！', '叮！等级提升～'],
  greet: ['主人你来啦！', '我等你好久啦～', '今天也一起加油吧！']
};

// ==================== 宠物 × Agent 联动 ====================
// 小问在后台干活时，宠物同步演出：思考 → 调工具 → 完成 / 失败。
// 动作只做「表演」，不阻塞、不弹权限，演出失败也不影响对话本身。
const AGENT_ACT = {
  think: { busy: 'busy-think', say: '让我想想…', tip: '思考中' },
  work: { busy: 'busy-work', say: '正在忙…', tip: '干活中' },
  listen: { busy: 'busy-listen', say: '我在听…', tip: '聆听中' },
  done: { busy: '', say: '搞定啦！', tip: '' },
  error: { busy: '', say: '好像出问题了…', tip: '' },
  idle: { busy: '', say: '', tip: '' }
};

// 内置工具名 → 宠物能念出来的中文（认不出来的直接原样念）
const TOOL_LABEL = {
  get_datetime: '看时间',
  system_info: '查机器状态',
  shell_exec: '跑命令',
  file_list: '翻目录',
  file_read: '读文件',
  file_write: '写文件',
  file_delete: '删文件',
  app_open: '开软件',
  process_list: '看进程',
  process_kill: '结束进程',
  screenshot: '看屏幕',
  clipboard_read: '看剪贴板',
  clipboard_write: '写剪贴板',
  notify: '发通知',
  memory_add: '记笔记',
  memory_search: '翻记忆',
  http_request: '访问网络',
  load_skill: '用技能',
  ask_supervisor: '请示小问',
  delegate_task: '派活给子代理',
  // 兼容别的工具集 / MCP 常见命名（同义名字也能翻出来）
  read_file: '读文件',
  write_file: '写文件',
  list_dir: '翻目录',
  run_command: '跑命令',
  open_app: '开软件',
  web_search: '搜网页',
  fetch_url: '抓网页',
  get_time: '看时间',
  use_skill: '用技能'
};

function toolLabel(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  if (TOOL_LABEL[n]) return TOOL_LABEL[n];
  // mcp:xxx → 去掉前缀只留后面一段
  const short = n.includes(':') ? n.split(':').pop() : n;
  return short || n;
}

// ==================== 状态 ====================
let cfg = {};
let state = {
  animal: 'penguin',
  mood: 80,
  hunger: 70,
  level: 1,
  exp: 0,
  lastSeen: Date.now(),
  autoWalk: false,
  sleeping: false
};
let walkTimer = null;
let walkTarget = null;
let idleTimer = null;
let blinkTimer = null;
let bubbleTimer = null;
let dragging = false;
let moved = false;
let dragStart = null;
let lastInteract = Date.now();
let busyCls = '';        // 当前持续的「忙碌」演出（think / work / listen）
let busyResetTimer = null; // 兜底：长时间没收到收尾事件就自己回待机

const $ = (id) => document.getElementById(id);
const els = {};

// ==================== 初始化 ====================
async function init() {
  els.stage = $('stage');
  els.body = $('petBody');
  els.sprite = $('sprite');
  els.bubble = $('bubble');
  els.bubbleText = $('bubbleText');
  els.menu = $('menu');
  els.menuAnimals = $('menuAnimals');
  els.stats = $('stats');
  els.floatLayer = $('floatLayer');
  els.badge = $('badge');
  els.badgeTip = $('badgeTip');

  try { cfg = await window.xw.getConfig(); } catch (e) { cfg = {}; }
  try {
    const saved = await window.xw.petStateGet();
    if (saved && typeof saved === 'object') state = { ...state, ...saved };
  } catch (e) { /* ignore */ }

  state.animal = ANIMALS[state.animal] ? state.animal : (cfg.petAnimal || 'penguin');
  state.autoWalk = !!cfg.petWalk;

  applyLook();
  renderAnimal();
  buildMenu();
  bindEvents();
  startBlink();
  scheduleIdle();
  decayTick();
  setInterval(decayTick, 30000);
  updateStats();
  if (state.autoWalk && !state.sleeping) startWalk();

  // 许久没见的问候
  const away = Date.now() - (state.lastSeen || 0);
  if (away > 30 * 60 * 1000) say(pick(LINES.greet), 3200);
  state.lastSeen = Date.now();

  // AI 回复时宠物播报
  try {
    window.xw.onPetSay && window.xw.onPetSay((text) => {
      if (text) say(String(text).slice(0, 60), 4200);
    });
  } catch (e) { /* ignore */ }

  // 小问干活时同步演出（思考 / 调工具 / 完成 / 失败）
  try {
    window.xw.onPetAct && window.xw.onPetAct((p) => agentAct(p));
  } catch (e) { /* ignore */ }

  // 让主进程把鼠标事件转发进来（窗口默认穿透）
  try { window.xw.petReady && window.xw.petReady(); } catch (e) { /* ignore */ }
}

function applyLook() {
  const size = Number(cfg.petSize) || 120;
  document.documentElement.style.setProperty('--pet-size', size + 'px');
  try { window.xw.petSetOpacity && window.xw.petSetOpacity(Number(cfg.petOpacity) || 1); } catch (e) { /* ignore */ }
}

function renderAnimal() {
  const a = ANIMALS[state.animal];
  if (!a) return;
  els.sprite.innerHTML = a.svg;
  els.body.classList.toggle('state-sleep', !!state.sleeping);
  els.body.classList.toggle('state-walk', state.autoWalk && !state.sleeping);
  els.body.classList.toggle('state-idle', !state.autoWalk && !state.sleeping);
}

// ==================== 气泡 ====================
function say(text, ms = 2600) {
  if (!text) return;
  els.bubbleText.textContent = text;
  els.bubble.classList.add('show');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => els.bubble.classList.remove('show'), ms);
}

function float(text, kind = 'plus') {
  const el = document.createElement('div');
  el.className = 'float-item ' + kind;
  el.textContent = text;
  el.style.left = (Math.random() * 40 - 20) + 'px';
  els.floatLayer.appendChild(el);
  setTimeout(() => el.remove(), 1300);
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function line(kind) {
  const a = ANIMALS[state.animal];
  if (kind === 'happy' && a.lines.happy) return pick(a.lines.happy);
  if (kind === 'food' && a.lines.food) return pick(a.lines.food);
  return pick(LINES[kind] || a.lines.idle || LINES.click);
}

// ==================== 宠物 × Agent 联动 ====================
/** 切换持续的「忙碌」演出（传空串回到待机） */
function setBusy(cls) {
  const next = cls || '';
  if (busyCls === next) return;
  if (busyCls) els.body.classList.remove(busyCls);
  busyCls = next;
  if (busyCls) els.body.classList.add(busyCls);
  if (els.badge) els.badge.classList.toggle('show', !!busyCls);
}

/**
 * 收到主进程的状态事件后演出一次。
 * payload: { action, text?, tool? }
 */
function agentAct(payload) {
  if (cfg.petAgentLink === false) return;
  const p = payload || {};
  const action = String(p.action || 'idle');
  const meta = AGENT_ACT[action] || AGENT_ACT.idle;

  clearTimeout(busyResetTimer);

  // 干活时把睡觉的宠物叫醒（不然表情看不出来）
  if (meta.busy && state.sleeping) {
    state.sleeping = false;
    renderAnimal();
  }

  if (action === 'done') {
    setBusy('');
    doAction('happy');
    addMood(2, false);
    addExp(3);
  } else if (action === 'error') {
    setBusy('');
    doAction('shake');
    addMood(-3, false);
  } else {
    setBusy(meta.busy);
  }

  let text = meta.say;
  if (action === 'work') {
    const names = String(p.tool || '').split(/[、,]/).map((s) => s.trim()).filter(Boolean);
    text = names.length ? '正在' + names.map(toolLabel).join('、') + '…' : '正在忙…';
  }
  if (els.badgeTip && meta.tip) els.badgeTip.textContent = meta.tip;
  if (text) say(text, action === 'done' || action === 'error' ? 2600 : 8000);

  // 兜底：万一收尾事件丢了（说完话没发、窗口卡过），到点自己回待机
  if (meta.busy) {
    busyResetTimer = setTimeout(() => setBusy(''), action === 'listen' ? 15000 : 60000);
  }
}

// ==================== 数值 ====================
function addMood(v, showFloat = true) {
  state.mood = Math.max(0, Math.min(100, state.mood + v));
  if (showFloat && v) float((v > 0 ? '心情 +' : '心情 ') + v, v > 0 ? 'plus' : 'minus');
  updateStats();
}
function addHunger(v, showFloat = true) {
  state.hunger = Math.max(0, Math.min(100, state.hunger + v));
  if (showFloat && v) float((v > 0 ? '饱食 +' : '饱食 ') + v, v > 0 ? 'plus' : 'minus');
  updateStats();
}
function addExp(v) {
  state.exp += v;
  const need = state.level * 100;
  while (state.exp >= need) {
    state.exp -= need;
    state.level += 1;
    say(LINES.levelUp[0], 2800);
    doAction('happy');
  }
  updateStats();
  save();
}

function updateStats() {
  if (!els.stats) return;
  $('barMood').style.width = state.mood + '%';
  $('barHunger').style.width = state.hunger + '%';
  $('barExp').style.width = Math.min(100, (state.exp / (state.level * 100)) * 100) + '%';
  $('lvNum').textContent = state.level;
}

function save() {
  state.lastSeen = Date.now();
  try { window.xw.petStateSave(state); } catch (e) { /* ignore */ }
}

/** 每 30 秒衰减一次；长时间没互动也会掉心情 */
function decayTick() {
  if (cfg.petInteraction === false) return;
  const now = Date.now();
  const minsAway = (now - lastInteract) / 60000;
  if (minsAway > 20 && Math.random() < 0.5) addMood(-2, false);
  addHunger(-1, false);
  if (state.hunger < 25 && !state.sleeping && Math.random() < 0.4) say(line('hungry') || '肚子饿了…', 3000);
  if (state.hunger < 12) addMood(-3, false);
  updateStats();
  save();
}

// ==================== 动作 ====================
function doAction(act) {
  const cls = 'act-' + act;
  els.body.classList.remove('act-happy', 'act-eat', 'act-shake');
  // 强制重排以重启动画
  void els.body.offsetWidth;
  els.body.classList.add(cls);
  setTimeout(() => els.body.classList.remove(cls), act === 'eat' ? 1500 : 1300);
}

function blink() {
  els.sprite.classList.add('blink');
  setTimeout(() => els.sprite.classList.remove('blink'), 130);
}

function startBlink() {
  clearTimeout(blinkTimer);
  const next = 2200 + Math.random() * 3600;
  blinkTimer = setTimeout(() => {
    if (!state.sleeping) blink();
    startBlink();
  }, next);
}

/** 随机小动作 + 随机台词 */
function scheduleIdle() {
  clearTimeout(idleTimer);
  const next = 12000 + Math.random() * 18000;
  idleTimer = setTimeout(() => {
    if (!state.sleeping && !dragging) {
      const a = ANIMALS[state.animal];
      if (Math.random() < 0.5) say(pick(a.lines.idle), 3000);
      if (Math.random() < 0.35) doAction('happy');
    }
    scheduleIdle();
  }, next);
}

// ==================== 散步 ====================
async function startWalk() {
  if (walkTimer) return;
  els.body.classList.add('state-walk');
  els.body.classList.remove('state-idle');
  const step = async () => {
    if (!state.autoWalk || state.sleeping || dragging) {
      walkTimer = setTimeout(step, 800);
      return;
    }
    try {
      const b = await window.xw.petGetBounds();
      const cxNow = b.x + b.w / 2;
      const cyNow = b.y + b.h / 2;
      const reached = walkTarget && dist(cxNow, cyNow, walkTarget.x, walkTarget.y) < 8;

      if (!walkTarget) {
        // 第一次：立刻挑个目标，马上出发
        walkTarget = pickTarget(b);
      } else if (reached) {
        // 到达：歇一会儿再换目标
        walkTarget = pickTarget(b);
        walkTimer = setTimeout(step, 1000 + Math.random() * 2600);
        return;
      }

      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const dx = walkTarget.x - cx;
      const dy = walkTarget.y - cy;
      const len = Math.max(1, Math.hypot(dx, dy));
      const sp = Math.min(6, len);
      const mx = (dx / len) * sp;
      const my = (dy / len) * sp;
      if (Math.abs(mx) > 0.5) setFace(mx > 0 ? 1 : -1);
      await window.xw.petMoveTo(Math.round(b.x + mx), Math.round(b.y + my));
      walkTimer = setTimeout(step, 60);
    } catch (e) {
      walkTimer = setTimeout(step, 1500);
    }
  };
  step();
}

function stopWalk() {
  clearTimeout(walkTimer);
  walkTimer = null;
  walkTarget = null;
  els.body.classList.remove('state-walk');
  els.body.classList.add('state-idle');
}

function dist(x1, y1, x2, y2) { return Math.hypot(x1 - x2, y1 - y2); }

/** 在屏幕底部一带随机挑一个落脚点（宠物沿着「地面」逛） */
function pickTarget(b) {
  const wa = b.workArea || { x: 0, y: 0, width: 1440, height: 900 };
  const spanX = Math.max(60, wa.width - b.w - 120);
  return {
    x: wa.x + 60 + Math.random() * spanX + b.w / 2,
    y: wa.y + wa.height - b.h - 8 - Math.random() * 40 + b.h / 2
  };
}
function setFace(d) {
  document.documentElement.style.setProperty('--face', String(d));
}

// ==================== 事件 ====================
function bindEvents() {
  // 悬停：接管鼠标 / 显示状态条
  els.body.addEventListener('mouseenter', () => {
    els.body.classList.add('hover');
    els.stats.classList.add('show');
    // 窗口默认鼠标穿透，进入宠物身体才接管点击
    try { window.xw.petSetMouse(false); } catch (e) { /* ignore */ }
  });
  els.body.addEventListener('mouseleave', () => {
    els.body.classList.remove('hover');
    els.stats.classList.remove('show');
    if (!els.menu.classList.contains('show')) {
      try { window.xw.petSetMouse(true); } catch (e) { /* ignore */ }
    }
  });

  // 拖拽
  els.body.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    dragStart = { x: e.screenX, y: e.screenY };
    document.body.classList.add('dragging');
    els.body.classList.add('dragging');
    hideMenu();
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    // 眼神跟随
    if (els.body && !state.sleeping) followCursor(e);
    if (!dragging) return;
    const dx = e.screenX - dragStart.x;
    const dy = e.screenY - dragStart.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) {
      moved = true;
      dragStart = { x: e.screenX, y: e.screenY };
      window.xw.petDragMove({ dx, dy });
      setFace(dx >= 0 ? 1 : -1);
      stopWalk();
      if (!els.body.classList.contains('state-walk')) {
        // 拖动时保持走路姿态
        els.body.classList.add('state-walk');
      }
    }
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('dragging');
    els.body.classList.remove('dragging');
    if (moved) {
      window.xw.petSnap();
      if (Math.random() < 0.5) say(pick(LINES.drag), 2200);
      els.body.classList.remove('state-walk');
      els.body.classList.toggle('state-walk', state.autoWalk && !state.sleeping);
      if (state.autoWalk) { stopWalk(); startWalk(); }
    }
  });

  // 点击互动
  els.body.addEventListener('click', (e) => {
    if (moved) { moved = false; return; }
    interact();
  });

  // 双击：找小问
  els.body.addEventListener('dblclick', () => {
    window.xw.openPanel && window.xw.openPanel();
  });

  // 右键菜单
  els.body.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    toggleMenu();
  });
  document.addEventListener('click', (e) => {
    if (els.menu.classList.contains('show') && !els.menu.contains(e.target)) hideMenu();
  });

  // 键盘：空格互动
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); interact(); }
    if (e.key === 'Escape') hideMenu();
  });

  // 配置更新
  try {
    window.xw.onConfigUpdate((c) => {
      cfg = c;
      applyLook();
      const wantWalk = !!c.petWalk;
      if (wantWalk !== state.autoWalk) {
        state.autoWalk = wantWalk;
        if (wantWalk) { renderAnimal(); startWalk(); }
        else stopWalk();
      }
      if (c.petAnimal && c.petAnimal !== state.animal) {
        state.animal = c.petAnimal;
        renderAnimal();
      }
      // 关掉联动时立刻收工，别让宠物一直转圈
      if (c.petAgentLink === false && busyCls) {
        clearTimeout(busyResetTimer);
        setBusy('');
      }
    });
  } catch (e) { /* ignore */ }
}

function followCursor(e) {
  const eyes = els.sprite.querySelectorAll('.eye');
  if (!eyes.length) return;
  const rect = els.body.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = Math.max(-1, Math.min(1, (e.clientX - cx) / 160));
  const dy = Math.max(-1, Math.min(1, (e.clientY - cy) / 160));
  eyes.forEach((el) => {
    el.style.setProperty('--px', (dx * 3.2).toFixed(2) + 'px');
    el.style.setProperty('--py', (dy * 2.6).toFixed(2) + 'px');
  });
}

function interact() {
  lastInteract = Date.now();
  if (state.sleeping) {
    state.sleeping = false;
    renderAnimal();
    say('（睡眼惺忪）主人叫我？', 2600);
    return;
  }
  addMood(3);
  addExp(4);
  const r = Math.random();
  if (r < 0.45) { doAction('happy'); say(line('happy'), 2400); }
  else if (r < 0.7) { doAction('shake'); say('嗯～？', 1800); }
  else say(line('click'), 2200);
  float('❤', 'heart');
  save();
}

function feed() {
  if (state.sleeping) { state.sleeping = false; renderAnimal(); }
  if (state.hunger >= 95) {
    doAction('shake');
    say('吃不下了…', 2000);
    return;
  }
  addHunger(18);
  addMood(6);
  addExp(8);
  doAction('eat');
  say(line('food'), 2600);
  save();
}

function toggleSleep() {
  state.sleeping = !state.sleeping;
  renderAnimal();
  if (state.sleeping) { stopWalk(); say('Zzz…我去睡一会儿', 2600); }
  else { say('（伸懒腰）我醒啦！', 2200); if (state.autoWalk) startWalk(); }
  save();
}

// ==================== 菜单 ====================
function buildMenu() {
  els.menuAnimals.innerHTML = '';
  Object.entries(ANIMALS).forEach(([id, a]) => {
    const b = document.createElement('button');
    b.className = 'animal-chip' + (id === state.animal ? ' active' : '');
    b.innerHTML = `<span class="chip-ico">${a.svg}</span><span>${a.name}</span>`;
    b.onclick = () => selectAnimal(id);
    els.menuAnimals.appendChild(b);
  });

  els.menu.querySelectorAll('.menu-item').forEach((btn) => {
    btn.onclick = () => {
      const act = btn.dataset.act;
      hideMenu();
      if (act === 'feed') feed();
      else if (act === 'sleep') toggleSleep();
      else if (act === 'walk') toggleWalk();
      else if (act === 'chat') window.xw.openPanel && window.xw.openPanel();
      else if (act === 'top') toggleTop();
      else if (act === 'hide') window.xw.petHide && window.xw.petHide();
    };
  });
}

function selectAnimal(id) {
  if (!ANIMALS[id]) return;
  state.animal = id;
  renderAnimal();
  hideMenu();
  doAction('happy');
  say(`我是${ANIMALS[id].name}${ANIMALS[id].emoji}，请多关照！`, 3000);
  try { window.xw.setConfig({ petAnimal: id }); } catch (e) { /* ignore */ }
  buildMenu();
  save();
}

async function toggleWalk() {
  state.autoWalk = !state.autoWalk;
  try { await window.xw.setConfig({ petWalk: state.autoWalk }); } catch (e) { /* ignore */ }
  if (state.autoWalk) { renderAnimal(); startWalk(); say('出去溜达溜达～', 2400); }
  else { stopWalk(); say('休息一下～', 2000); }
  save();
}

async function toggleTop() {
  const on = !(cfg.petTop !== false);
  cfg.petTop = on;
  try { await window.xw.setConfig({ petTop: on }); window.xw.petSetTop && window.xw.petSetTop(on); } catch (e) { /* ignore */ }
  say(on ? '已固定在最上层' : '取消置顶了', 2000);
}

function toggleMenu() {
  const show = !els.menu.classList.contains('show');
  els.menu.classList.toggle('show', show);
  try { window.xw.petSetMouse(!show); } catch (e) { /* ignore */ }
}

function hideMenu() {
  if (!els.menu.classList.contains('show')) return;
  els.menu.classList.remove('show');
  try { window.xw.petSetMouse(true); } catch (e) { /* ignore */ }
}

// 供回归测试 import（浏览器里作为模块加载，多几个导出没有副作用）
export { AGENT_ACT, TOOL_LABEL, toolLabel, agentAct };

// ==================== 启动 ====================
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
