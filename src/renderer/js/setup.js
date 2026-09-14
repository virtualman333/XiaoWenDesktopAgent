/**
 * 首次启动配置向导
 * ------------------------------------------------------------------
 * 新机器 clone 下来是没有 config.json 的，以前表现为「打开一片空白、不知道要先配 Key」。
 * 这里做一个三步引导：欢迎 → 填模型接口 → 个性化/语音（可跳过）。
 * 完成后写入 config.setupDone = true，之后不再打扰。
 *
 * 密钥只通过 window.xw.setConfig 交给主进程保存，前端不留真值。
 */

const PROVIDERS = [
  { name: 'DeepSeek（推荐，便宜快速）', base: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { name: '通义千问 Qwen', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: '月之暗面 Kimi', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: '自定义…', base: '', model: '' }
];

const STYLE = `
.xw-setup-mask{position:fixed;inset:0;z-index:9999;background:rgba(17,20,28,.55);
  backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
.xw-setup{width:520px;max-width:94vw;background:#fff;border-radius:16px;
  box-shadow:0 24px 60px rgba(0,0,0,.28);overflow:hidden;animation:xw-pop .22s ease}
@keyframes xw-pop{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
.xw-setup-head{padding:22px 26px 14px;border-bottom:1px solid #eef0f4}
.xw-setup-head h2{margin:0 0 6px;font-size:19px;color:#1b1f27}
.xw-setup-head p{margin:0;font-size:13px;color:#7a8290;line-height:1.6}
.xw-steps{display:flex;gap:6px;padding:14px 26px 0}
.xw-step{flex:1;height:3px;border-radius:2px;background:#e9ecf1}
.xw-step.on{background:#3b6cff}
.xw-setup-body{padding:20px 26px 6px;min-height:196px}
.xw-field{margin-bottom:16px}
.xw-field label{display:block;font-size:12.5px;color:#5b6371;margin-bottom:6px;font-weight:600}
.xw-field input,.xw-field select{width:100%;box-sizing:border-box;padding:9px 11px;
  border:1px solid #dfe3ea;border-radius:8px;font-size:13.5px;outline:none;background:#fff;color:#1b1f27}
.xw-field input:focus,.xw-field select:focus{border-color:#3b6cff;box-shadow:0 0 0 3px rgba(59,108,255,.12)}
.xw-hint{font-size:11.5px;color:#98a0ad;margin-top:5px;line-height:1.5}
.xw-setup-foot{display:flex;align-items:center;gap:10px;padding:14px 26px 20px}
.xw-setup-foot .spacer{flex:1}
.xw-btn{padding:8px 16px;border-radius:8px;font-size:13.5px;cursor:pointer;border:1px solid transparent}
.xw-btn-ghost{background:#fff;border-color:#dfe3ea;color:#5b6371}
.xw-btn-ghost:hover{background:#f6f7f9}
.xw-btn-primary{background:#3b6cff;color:#fff}
.xw-btn-primary:hover{background:#2f5be0}
.xw-btn-primary[disabled]{opacity:.55;cursor:not-allowed}
.xw-test{margin-top:8px;font-size:12.5px;line-height:1.5}
.xw-test.ok{color:#1a9c5b}.xw-test.err{color:#d9483b}.xw-test.loading{color:#8a91a0}
.xw-welcome-logo{width:52px;height:52px;border-radius:14px;background:linear-gradient(135deg,#3b6cff,#6d8cff);
  color:#fff;font-size:26px;display:flex;align-items:center;justify-content:center;font-weight:700;margin-bottom:12px}
.xw-list{margin:0;padding-left:18px;font-size:13px;color:#5b6371;line-height:1.9}
`;

let state = { step: 1, provider: 0, base: PROVIDERS[0].base, model: PROVIDERS[0].model, key: '', userName: '', asrKey: '' };
let mask = null;

function injectStyle() {
  if (document.getElementById('xw-setup-style')) return;
  const s = document.createElement('style');
  s.id = 'xw-setup-style';
  s.textContent = STYLE;
  document.head.appendChild(s);
}

/** 入口：按需自动弹出（未配置过模型 Key 时） */
export function maybeShowSetup(cfg) {
  if (cfg && (cfg.setupDone || cfg.apiKeyMasked)) return false;
  openSetup(cfg);
  return true;
}

/** 手动打开（设置页「重新运行新手引导」） */
export function openSetup(cfg) {
  state = {
    step: 1,
    provider: 0,
    base: (cfg && cfg.apiBaseUrl) || PROVIDERS[0].base,
    model: (cfg && cfg.model) || PROVIDERS[0].model,
    key: '',
    userName: (cfg && cfg.userName) || '',
    asrKey: ''
  };
  render();
}

function close() {
  if (mask) mask.remove();
  mask = null;
}

function render() {
  injectStyle();
  if (!mask) {
    mask = document.createElement('div');
    mask.className = 'xw-setup-mask';
    document.body.appendChild(mask);
  }
  mask.innerHTML = `
    <div class="xw-setup">
      <div class="xw-setup-head">
        <h2>${title()}</h2>
        <p>${desc()}</p>
      </div>
      <div class="xw-steps">
        <div class="xw-step ${state.step >= 1 ? 'on' : ''}"></div>
        <div class="xw-step ${state.step >= 2 ? 'on' : ''}"></div>
        <div class="xw-step ${state.step >= 3 ? 'on' : ''}"></div>
      </div>
      <div class="xw-setup-body" id="xwBody"></div>
      <div class="xw-setup-foot">
        <button class="xw-btn xw-btn-ghost" id="xwSkip">${state.step === 1 ? '以后再说' : '跳过'}</button>
        <div class="spacer"></div>
        ${state.step > 1 ? '<button class="xw-btn xw-btn-ghost" id="xwPrev">上一步</button>' : ''}
        <button class="xw-btn xw-btn-primary" id="xwNext">${state.step === 3 ? '完成配置' : '下一步'}</button>
      </div>
    </div>`;
  renderBody();
  bind();
}

function title() {
  return ['欢迎使用小问助手', '第 1 步 · 接入大模型', '第 2 步 · 认识一下'][state.step - 1] || '';
}

function desc() {
  return [
    '一个常驻桌面的 AI 助手。先花 30 秒完成配置，之后点悬浮球或按 Alt+Space 就能用。',
    '小问本身不含模型，需要你提供一个兼容 OpenAI 格式的接口。密钥只保存在本机。',
    '告诉我该怎么称呼你；想用语音的话，再填一个阿里云百炼 Key（可跳过，随时能在设置里补）。'
  ][state.step - 1] || '';
}

function renderBody() {
  const body = mask.querySelector('#xwBody');
  if (state.step === 1) {
    body.innerHTML = `
      <div class="xw-welcome-logo">问</div>
      <ul class="xw-list">
        <li>悬浮球常驻右下角，点一下或按 <b>Alt+Space</b> 直接提问</li>
        <li>支持语音输入与朗读、桌面宠物、Agent 工具（执行命令 / 读写文件 / 截图）</li>
        <li>所有对话、记忆、密钥都只存在你自己的电脑上</li>
      </ul>`;
    return;
  }

  if (state.step === 2) {
    body.innerHTML = `
      <div class="xw-field">
        <label>服务商</label>
        <select id="xwProv">
          ${PROVIDERS.map((p, i) => `<option value="${i}" ${i === state.provider ? 'selected' : ''}>${p.name}</option>`).join('')}
        </select>
      </div>
      <div class="xw-field">
        <label>API 地址</label>
        <input type="text" id="xwBase" value="${esc(state.base)}" placeholder="https://api.deepseek.com" />
      </div>
      <div class="xw-field">
        <label>模型名称</label>
        <input type="text" id="xwModel" value="${esc(state.model)}" placeholder="deepseek-chat" />
      </div>
      <div class="xw-field">
        <label>API Key</label>
        <input type="password" id="xwKey" value="${esc(state.key)}" placeholder="sk-..." />
        <div class="xw-hint">密钥仅写入本机 userData/config.json，不会上传到任何地方</div>
      </div>
      <div class="xw-test" id="xwTest"></div>`;
    return;
  }

  body.innerHTML = `
    <div class="xw-field">
      <label>该怎么称呼你？</label>
      <input type="text" id="xwName" value="${esc(state.userName)}" placeholder="比如：永贵（可留空）" />
    </div>
    <div class="xw-field">
      <label>阿里云百炼 API Key（语音，可跳过）</label>
      <input type="password" id="xwAsrKey" value="${esc(state.asrKey)}" placeholder="sk-... 留空则暂不使用语音" />
      <div class="xw-hint">用于语音识别与 CosyVoice 朗读。没有的话先用文字聊，之后在「设置 → 语音」里补。</div>
    </div>`;
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function collect() {
  if (state.step === 2) {
    state.base = (mask.querySelector('#xwBase') || {}).value ?? state.base;
    state.model = (mask.querySelector('#xwModel') || {}).value ?? state.model;
    state.key = (mask.querySelector('#xwKey') || {}).value ?? state.key;
  }
  if (state.step === 3) {
    state.userName = (mask.querySelector('#xwName') || {}).value ?? state.userName;
    state.asrKey = (mask.querySelector('#xwAsrKey') || {}).value ?? state.asrKey;
  }
}

function bind() {
  mask.querySelector('#xwSkip').onclick = async () => {
    // 跳过也记一笔，避免每次启动都弹；用户可随时在设置里重新运行
    try { await window.xw.setConfig({ setupDone: true }); } catch (e) {}
    close();
  };
  const prev = mask.querySelector('#xwPrev');
  if (prev) prev.onclick = () => { collect(); state.step -= 1; render(); };

  mask.querySelector('#xwNext').onclick = async () => {
    collect();
    if (state.step === 2) {
      if (!state.base || !state.model || !state.key) {
        setTest('请把接口地址、模型名称和 API Key 填完整', 'err');
        return;
      }
      const btn = mask.querySelector('#xwNext');
      btn.disabled = true;
      setTest('正在测试连接…', 'loading');
      try {
        const r = await window.xw.chatTest({ baseUrl: state.base, model: state.model, apiKey: state.key });
        if (!r || r.ok !== true) {
          btn.disabled = false;
          setTest('连接失败：' + ((r && r.error) || '未知错误') + '（也可以直接「跳过」，之后在设置里改）', 'err');
          return;
        }
        setTest('连接成功 ✓ ' + (r.text || '').slice(0, 40), 'ok');
      } catch (e) {
        btn.disabled = false;
        setTest('连接失败：' + (e && e.message), 'err');
        return;
      }
      btn.disabled = false;
      await saveModel();
      state.step = 3;
      render();
      return;
    }
    if (state.step === 3) { await finish(); return; }
    state.step += 1;
    render();
  };

  const prov = mask.querySelector('#xwProv');
  if (prov) {
    prov.onchange = () => {
      const i = Number(prov.value);
      state.provider = i;
      const p = PROVIDERS[i];
      if (p.base) {
        state.base = p.base; state.model = p.model;
        mask.querySelector('#xwBase').value = p.base;
        mask.querySelector('#xwModel').value = p.model;
      }
    };
  }
}

function setTest(text, cls) {
  const el = mask && mask.querySelector('#xwTest');
  if (el) { el.textContent = text; el.className = 'xw-test ' + (cls || ''); }
}

async function saveModel() {
  try {
    await window.xw.setConfig({
      apiBaseUrl: state.base.trim(),
      model: state.model.trim(),
      apiKey: state.key.trim() || '__KEEP__'
    });
  } catch (e) { /* 忽略，最后一步还会再存一次 */ }
}

async function finish() {
  const patch = { setupDone: true };
  if (state.base) patch.apiBaseUrl = state.base.trim();
  if (state.model) patch.model = state.model.trim();
  if (state.key) patch.apiKey = state.key.trim();
  if (state.asrKey) patch.asrApiKey = state.asrKey.trim();
  try { await window.xw.setConfig(patch); } catch (e) {}
  if (state.userName) {
    try { await window.xw.personaSet({ userName: state.userName.trim() }); } catch (e) {}
  }
  close();
  if (typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('setup:done'));
  }
}
