/**
 * updater-plan.js —— 自动更新里「该不该 / 怎么走」的这些判据，只此一份（纯函数、零 electron 依赖）
 *
 * 为什么要有它
 * ------------
 * `updater.js` 第一行就 `require('electron')`，纯 Node **加载不了**，所以自动更新这套东西
 * （状态机、四个设置开关、空闲安装、报错翻译）此前**一条断言都没有**：
 * `test:all` 里 18 个套件、`build/` 下 30 个文件，没有一个是冲它来的。
 *
 * 第一次把判据摊开来看，就发现设置页给小问许的那条诺**是假的**：
 *
 *   「下载完成后弹窗提醒」= `autoUpdateNotify`
 *
 * 而 `update-downloaded` 里它只在**非静默安装**那一支被读：
 *
 *     if (silentInstall) { notify(...) }               // 无条件弹
 *     else if (cfg.autoUpdateNotify !== false) { 弹对话框 }
 *
 * `autoUpdateSilentInstall` 默认是 **true** —— 也就是说**默认路径下这个开关完全不生效**：
 * 用户把它关掉，轻提示照样弹；设置页里还根本没有这个开关（六个 `up*` 勾选框里没有它），
 * 只能手改 config.json。关了没用、UI 里也没有，这个键等于半死。
 *
 * 现在语义收敛成一句话：**`autoUpdateNotify` 管的是「下完之后要不要打扰你」，与用哪种安装方式无关**。
 * 静默安装那一支同样先问它。关掉之后不是「什么都看不见」—— 设置页的状态行照样会显示
 * 「vX 已就绪，空闲时会自动静默安装」，只是不再主动弹东西。
 *
 * 默认值也只此一份
 * ----------------
 * 这 7 个键此前写在三处（`main.js` 的 `DEFAULT_CONFIG`、设置页 `fillCapture()` 里的
 * `cfg.autoUpdateXxx !== false`、以及 `updater.js` 各读取点自带的兜底），
 * `config.example.json` 里还漏了两个（`autoUpdateSilentInstall` / `autoUpdateInstallWhenIdle`）
 * —— 照着示例配置抄的用户根本不知道有这两个设置。现在 `DEFAULTS` 是唯一来源，
 * 示例配置与 `main.js` 都从它取。
 *
 * 用法：`require('./updater-plan')`（updater.js / main.js）、`build/_updater_plan_test.mjs`（测试）
 */
'use strict';

/**
 * 自动更新的默认值 —— **唯一来源**。四个开关的语义都是「默认开」，
 * 所以判据统一写成 `!== false`：缺失 / null / 未设置都算开，只有显式 `false` 才算关。
 */
const DEFAULTS = {
  autoUpdate: true, // 启动时静默检查
  autoUpdateSilent: true, // 有更新就后台下载，下完再问
  autoUpdatePrerelease: false, // 是否接收预发布版本
  autoUpdateInstallOnQuit: true, // 退出时自动应用已下载的更新
  autoUpdateNotify: true, // 下完之后要不要打扰主人（与用哪种安装方式无关）
  autoUpdateSilentInstall: true, // 静默安装：不弹 NSIS 界面，装完自动拉起
  autoUpdateInstallWhenIdle: true // 空闲时自动重启安装，不打断主人干活
};

/** 连续多少秒没有键鼠输入才算「主人不在」 */
const IDLE_NEED_SECONDS = 90;

/** 空闲巡检的间隔（毫秒） */
const IDLE_POLL_MS = 20000;

/**
 * 把 electron-updater 的英文报错翻成人话。
 *
 * 只认 `Error` 的 `message` 与裸字符串。以前写的是 `String((err && err.message) || err || '未知错误')`
 * —— 传进来一个没有 `message` 的对象（`{ code: 'ERR_UPDATER_...' }` 之类）会被
 * `String()` 原样吐成 **`[object Object]`**，而这行字会**直接显示在设置页的状态行上**。
 * 新写的测试第一条就抓到了它。
 */
function friendlyError(err) {
  const raw =
    typeof err === 'string' ? err
      : err && typeof err.message === 'string' ? err.message
        : '';
  const msg = raw.trim() || '未知错误';
  if (/ENOENT|no such file|app-update.yml|404/i.test(msg)) {
    return '发布源里还没有可用的更新包（需在 GitHub Releases 上传新版本）。';
  }
  if (/net::|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network/i.test(msg)) {
    return '连不上更新服务器，请检查网络后重试。';
  }
  if (/code\s*signature|signature/i.test(msg)) {
    return '更新包签名校验失败。';
  }
  return msg.slice(0, 300);
}

/** 设置 → electron-updater 的选项。原样搬过来，只是把默认值改成从 `DEFAULTS` 的语义推。 */
function autoUpdaterOptions(cfg) {
  const c = cfg || {};
  return {
    autoDownload: c.autoUpdateSilent !== false,
    allowPrerelease: c.autoUpdatePrerelease === true,
    autoInstallOnAppQuit: c.autoUpdateInstallOnQuit !== false,
    disableDifferentialDownload: false
  };
}

/**
 * 「更新包下好了，接下来怎么办」—— 这一段此前全写在事件回调里，没法单独验。
 *
 * 返回（每一项都是**决策结果**，不是「顺便读一下配置」）：
 *   - `silentInstall`  走静默安装（不弹 NSIS 向导）还是弹安装界面
 *   - `lightNotify`    要不要发那条不打断人的轻提示（托盘气泡 / 宠物）
 *   - `askDialog`      要不要弹「现在重启安装？」对话框
 *   - `startIdleWatch` 要不要开始「空闲就自动装」的巡检
 *   - `message`        给设置页状态行看的那句话
 *
 * ⚠ 两个提醒开关**互斥**：静默安装时只发轻提示（对话框最打断人），非静默时才问一句。
 *   但**两者都先受 `autoUpdateNotify` 管** —— 这正是修掉的那个缺陷。
 *   `startIdleWatch` 与提醒开关**无关**：关闭提醒不等于放弃「空闲自动安装」。
 */
function afterDownloaded(cfg, version) {
  const c = cfg || {};
  const v = String(version == null ? '' : version);
  const wantNotify = c.autoUpdateNotify !== false;
  const silentInstall = c.autoUpdateSilentInstall !== false;

  if (silentInstall) {
    return {
      silentInstall: true,
      lightNotify: wantNotify,
      askDialog: false,
      startIdleWatch: true,
      message: `v${v} 已就绪，空闲时会自动静默安装`
    };
  }
  return {
    silentInstall: false,
    lightNotify: false,
    askDialog: wantNotify,
    startIdleWatch: false,
    message: `v${v} 已下载完成，重启后生效`
  };
}

/**
 * 空闲自动安装的判据。把 `setInterval` 里那串 `if` 搬出来，才测得了 ——
 * 原来的写法里「状态不是 downloaded 就别装」和「装过了别重复装」混在回调里，
 * 没有任何办法在不真等 90 秒的前提下验它。
 */
function shouldIdleInstall(input) {
  const { cfg, state, installKicked, idleSeconds, idleNeed } = input || {};
  const c = cfg || {};
  if (c.autoUpdateInstallWhenIdle === false) return false;
  if (state !== 'downloaded') return false;
  if (installKicked) return false;
  const need = typeof idleNeed === 'number' ? idleNeed : IDLE_NEED_SECONDS;
  return Number(idleSeconds) >= need;
}

/**
 * 安装方式：显式布尔优先，否则跟着设置走。
 * `ipcMain` 的两条入口分别写死 `true` / `false`（静默 / 带界面），
 * 只有「空闲自动安装」和退出时走设置 —— 这条判据也收在这里，免得两处各写一遍。
 */
function installSilently(cfg, explicit) {
  if (typeof explicit === 'boolean') return explicit;
  return (cfg || {}).autoUpdateSilentInstall !== false;
}

module.exports = {
  DEFAULTS,
  IDLE_NEED_SECONDS,
  IDLE_POLL_MS,
  afterDownloaded,
  autoUpdaterOptions,
  friendlyError,
  installSilently,
  shouldIdleInstall
};
