/**
 * 开机自启
 *
 * Windows / macOS 用 Electron 自带的 login item（macOS 走 LaunchAgent，Windows 走注册表 Run）。
 * Linux 用 ~/.config/autostart 的 .desktop 文件兜底。
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const FLAG = 'autostart.json';
const store = require('./store');

function readFlag() {
  const d = store.readJson(FLAG, { enabled: false });
  return !!d.enabled;
}

function writeFlag(v) {
  return store.writeJson(FLAG, { enabled: !!v, updatedAt: Date.now() });
}

function linuxDesktopFile() {
  const dir = path.join(os.homedir(), '.config', 'autostart');
  return path.join(dir, 'xiaowen-assistant.desktop');
}

function setLinuxAutostart(enabled) {
  const f = linuxDesktopFile();
  try {
    if (!enabled) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
      return true;
    }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const execPath = process.execPath.replace(/\\/g, '/');
    fs.writeFileSync(f, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=XiaoWen Assistant',
      `Exec=${execPath}`,
      'Hidden=false',
      'NoDisplay=false',
      'X-GNOME-Autostart-enabled=true'
    ].join('\n'), 'utf-8');
    return true;
  } catch (e) {
    console.error('[autostart] linux failed', e);
    return false;
  }
}

function setEnabled(enabled, options = {}) {
  const v = !!enabled;
  try {
    if (process.platform === 'linux') {
      setLinuxAutostart(v);
    } else if (typeof app.setLoginItemSettings === 'function') {
      app.setLoginItemSettings({
        openAtLogin: v,
        openAsHidden: true,
        // Windows 下开机自启时不要用「启动文件夹」模式，走注册表更稳
        args: options.args || []
      });
    } else {
      return { ok: false, reason: '当前平台不支持开机自启' };
    }
    writeFlag(v);
    return { ok: true, enabled: v };
  } catch (e) {
    console.error('[autostart] set failed', e);
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

function status() {
  let osEnabled = readFlag();
  try {
    if (process.platform !== 'linux' && typeof app.getLoginItemSettings === 'function') {
      const s = app.getLoginItemSettings();
      osEnabled = !!(s && s.openAtLogin);
    } else if (process.platform === 'linux') {
      osEnabled = fs.existsSync(linuxDesktopFile());
    }
  } catch (e) { /* 读不到就用本地标记 */ }
  return { enabled: osEnabled };
}

/** 应用启动时同步一次：本地标记与系统状态不一致时以本地标记为准 */
function syncOnBoot() {
  const want = readFlag();
  const cur = status();
  if (want && !cur.enabled) {
    setEnabled(true);
  }
  return status();
}

module.exports = { setEnabled, status, syncOnBoot, readFlag };
