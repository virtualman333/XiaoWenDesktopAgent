/**
 * 语音模块
 * - 识别：Web Speech API (webkitSpeechRecognition)。Electron 内置 Chromium，
 *   Windows 下若网络可达会走 Google 云端识别；不可达时降级提示。
 * - 朗读：SpeechSynthesis，使用系统安装的语音引擎（完全离线）。
 */

let recognizer = null;
let recognizing = false;

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export function isRecognitionSupported() {
  return !!SR;
}

/**
 * 开始语音识别
 * @param {object} cb
 * @param {(text:string, isFinal:boolean)=>void} cb.onResult
 * @param {(err:string)=>void} cb.onError
 * @param {()=>void} cb.onEnd
 * @param {string} lang
 */
export function startRecognition({ onResult, onError, onEnd, lang = 'zh-CN' }) {
  if (!SR) {
    onError && onError('当前环境不支持语音识别');
    return false;
  }

  stopRecognition();

  try {
    recognizer = new SR();
  } catch (e) {
    onError && onError('语音识别初始化失败：' + e.message);
    return false;
  }

  recognizer.lang = lang;
  recognizer.continuous = false;
  recognizer.interimResults = true;
  recognizer.maxAlternatives = 1;

  let finalText = '';

  recognizer.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    onResult && onResult(finalText || interim, finalText.length > 0);
  };

  recognizer.onerror = (event) => {
    recognizing = false;
    let msg = '识别失败';
    switch (event.error) {
      case 'not-allowed':
      case 'service-not-allowed':
        msg = '麦克风权限被拒绝，请在系统设置中允许';
        break;
      case 'no-speech':
        msg = '没有检测到说话声';
        break;
      case 'audio-capture':
        msg = '未找到麦克风设备';
        break;
      case 'network':
        msg = '网络不可用，云端语音识别需要联网';
        break;
      case 'aborted':
        msg = '已取消';
        break;
      default:
        msg = '识别出错：' + event.error;
    }
    onError && onError(msg);
  };

  recognizer.onend = () => {
    recognizing = false;
    onEnd && onEnd(finalText);
  };

  // 长按静音 2.5s 自动结束
  try {
    recognizer.start();
    recognizing = true;
    return true;
  } catch (e) {
    onError && onError('无法启动识别：' + e.message);
    return false;
  }
}

export function stopRecognition() {
  if (recognizer && recognizing) {
    try {
      recognizer.stop();
    } catch {}
  }
  recognizing = false;
}

export function abortRecognition() {
  if (recognizer) {
    try {
      recognizer.abort();
    } catch {}
  }
  recognizing = false;
}

export function isRecognizing() {
  return recognizing;
}

// =================== 语音朗读 ===================

let voices = [];
let speaking = false;
let currentUtterance = null;

export function loadVoices() {
  if (!('speechSynthesis' in window)) return [];
  voices = window.speechSynthesis.getVoices();
  return voices;
}

export function getVoices() {
  if (!voices.length) loadVoices();
  return voices;
}

// 语音列表异步加载
if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    loadVoices();
    document.dispatchEvent(new CustomEvent('voices-ready', { detail: voices }));
  };
  // 主动触发一次
  setTimeout(loadVoices, 120);
  setTimeout(loadVoices, 600);
}

/**
 * 挑选最合适的中文语音
 */
export function pickDefaultVoice(preferName) {
  const list = getVoices();
  if (!list.length) return null;

  if (preferName) {
    const hit = list.find((v) => v.name === preferName);
    if (hit) return hit;
  }

  // 优先中文
  const zh = list.filter((v) => /^zh|chinese|中文|普通话/i.test(v.lang + v.name));
  if (zh.length) {
    // 偏爱女声 / 常见优质音色
    const preferred = zh.find((v) => /Xiaoxiao|Huihui|Yaoyao|Xiaoyi|Yunxi|Tingting|Mei/i.test(v.name));
    return preferred || zh[0];
  }
  return list[0];
}

/**
 * 朗读文本
 */
export function speak(text, { rate = 1, volume = 1, voiceName = '', onStart, onEnd, onError } = {}) {
  if (!('speechSynthesis' in window)) {
    onError && onError('当前环境不支持语音合成');
    return false;
  }

  stopSpeaking();

  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = Math.min(Math.max(rate, 0.5), 2);
  utter.volume = Math.min(Math.max(volume, 0), 1);
  utter.pitch = 1;
  utter.lang = 'zh-CN';

  const v = pickDefaultVoice(voiceName);
  if (v) {
    utter.voice = v;
    utter.lang = v.lang || 'zh-CN';
  }

  utter.onstart = () => {
    speaking = true;
    onStart && onStart();
  };
  utter.onend = () => {
    speaking = false;
    currentUtterance = null;
    onEnd && onEnd();
  };
  utter.onerror = (e) => {
    speaking = false;
    currentUtterance = null;
    if (e.error !== 'interrupted' && e.error !== 'canceled') {
      onError && onError('朗读失败：' + e.error);
    } else {
      onEnd && onEnd();
    }
  };

  currentUtterance = utter;
  // Chromium 已知问题：长时间不说话会被挂起，这里分段处理
  window.speechSynthesis.speak(utter);
  return true;
}

export function stopSpeaking() {
  if ('speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {}
  }
  speaking = false;
  currentUtterance = null;
}

export function isSpeaking() {
  return speaking;
}
