/**
 * 工具安全边界 —— 纯函数，**不 require electron**，因此纯 Node 能直接加载并单测。
 *
 * 为什么单独成一个文件
 * --------------------
 * 下面这两条是 README 对小问下的安全承诺：
 *   · 高危命令（format / shutdown / reg / diskpart 等）**直接拦截**
 *   · 写 / 删操作**只允许**用户目录、下载、临时目录与白名单目录
 *
 * 但它们原本写死在 `tools.js` 里，而那个文件第一行就 `require('electron')` ——
 * 纯 Node 加载不了它。于是 `test:all` 里 18 套测试、上千条断言，
 * **没有任何一条碰过这两条承诺**：安全边界全凭「读代码看着没问题」。
 *
 * 判据搬到这里之后，`build/_tools_test.mjs` 才能真正跑它们 ——
 * 包括「Downloads 里放一个指向 C:\Windows 的目录联接」这种真实绕过。
 *
 * 本轮从实测里修掉的三处（每一处都有对应断言）
 * -------------------------------------------
 *   ① **目录联接 / 软链接绕过**：只看字面路径的话，联接落在 Downloads 之内、
 *      判定放行，写下去却进了系统目录。现在先对「已存在的最深祖先」做 realpath。
 *   ② **高危命令漏网**：`rd /s /q`、`rmdir /s` 与 `del /s` 同级，此前一条都没拦；
 *      `format.com c:` 绕开了 `format\s+[a-z]:`；`del /q /s` 也绕开了
 *      只认「紧跟 del 的那一个斜杠参数」的旧写法。
 *   ③ **分隔符两套写法**：原来 `startsWith(r + path.sep) || startsWith(r + '/')`
 *      是同一件事写了两遍（Windows 上后一半是死代码）。换成 `path.relative`，
 *      它内部就按平台语义比较（Windows 不区分大小写），也就没有第二份写法可漂。
 */
const fs = require('fs');
const path = require('path');

// ---------------- 高危命令 ----------------

/**
 * 高危命令名单。**每一条都必须有一个正例在 `build/_tools_test.mjs` 里命中** ——
 * 一条永远不响的规则比没有规则更坏（它让人以为这条防线在工作）。
 */
const DANGEROUS_PATTERNS = [
  /format\s+[a-z]:/i,
  /\bdel\s+\/[fs]\b/i,
  /\bdel\s+(\/[a-z]+\s+)*\/[a-z]*[fs]\b/i,
  /\b(rd|rmdir)\s+(\/[a-z]+\s+)*\/s\b/i,
  /\bformat\.com\b/i,
  /\brm\s+-rf\s+(\/|\*|~)/i,
  /\bshutdown\b/i,
  /\bshutdown\s*\/\s*[sr]/i,
  /\bdiskpart\b/i,
  /\breg\s+(delete|add)\b/i,
  /\bnet\s+user\b/i,
  /\btakeown\b/i,
  /\bcipher\s+\/w/i,
  /\bRemove-Item\s+.*(-Recurse\s+)?(-Force\s+)?(C:\\Windows|C:\\\\|C:\/)/i,
  /\bStop-Computer\b/i,
  /\bRestart-Computer\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i
];

/** 命中就返回命中的那条正则（原样带进错误信息，便于用户判断），否则 null */
function matchDangerousCommand(cmd) {
  const text = String(cmd == null ? '' : cmd);
  if (!text.trim()) return null;
  return DANGEROUS_PATTERNS.find((re) => re.test(text)) || null;
}

// ---------------- 写路径围栏 ----------------

/**
 * target 是否在 root 之内（含相等）。
 *
 * 用 `path.relative` 而不是字符串 `startsWith`：
 *   · 分隔符交给平台自己处理，不用再写一份 `r + '/'` 的兜底；
 *   · Windows 的 `path.win32.relative` 内部按**不区分大小写**比较，
 *     `C:\Users\Me\Downloads` 与 `c:\users\me\downloads` 是同一个目录这件事才成立。
 */
function isUnder(root, target) {
  const rel = path.relative(path.resolve(String(root)), path.resolve(String(target)));
  if (rel === '') return true; // 同一个路径
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/** realpath，取不到就返回 null（交给调用方决定是硬失败还是退回字面路径） */
function tryRealpath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch (e) {
    try {
      return fs.realpathSync(p);
    } catch (e2) {
      return null;
    }
  }
}

/**
 * 「已存在的最深祖先的 realpath」+ 尚未存在的后缀。
 *
 * 为什么不能直接对整条路径 realpath：`file_write` 的目标**通常还不存在**，
 * 而写入前必须先把围栏判完。所以要一路往上找到第一个真实存在的祖先，
 * 把它解析成真实路径，再把剩下那几段接回去。
 *
 * 这一条挡的是目录联接 / 软链接绕过 —— 字面路径落在允许目录里，
 * 解析后却指向别处。
 */
function realpathDeepest(p) {
  const abs = path.resolve(String(p));
  let cur = abs;
  const tail = [];
  for (;;) {
    const real = tryRealpath(cur);
    if (real) return tail.length ? path.join(real, ...tail.reverse()) : real;
    const parent = path.dirname(cur);
    if (parent === cur) return abs; // 一路到根都取不到（盘符不存在等）→ 退回字面路径
    tail.push(path.basename(cur));
    cur = parent;
  }
}

/** 逐条 root 判围栏。roots 里的空值一律忽略（白名单没配好不该变成放行） */
function isWritablePath(target, roots) {
  const t = realpathDeepest(target);
  return (Array.isArray(roots) ? roots : []).some((r) => r && isUnder(realpathDeepest(r), t));
}

/**
 * 判定并返回**解析后的绝对路径**（返回值仍与旧实现一致：写操作拿它当落地路径）。
 * 注意 realpath 只用于判定，不改返回值 —— 否则「新建文件」的返回值会被改写成
 * 另一条路径，调用方拿到的就不是它要写的地方了。
 */
function assertWritablePath(target, roots) {
  const resolved = path.resolve(String(target));
  if (isWritablePath(resolved, roots)) return resolved;
  const err = new Error(
    `拒绝写入：${resolved} 不在允许范围内（允许：用户目录 / 下载 / 临时目录，可在设置里追加白名单）`
  );
  err.code = 'EPATH';
  throw err;
}

module.exports = {
  DANGEROUS_PATTERNS,
  matchDangerousCommand,
  isUnder,
  realpathDeepest,
  isWritablePath,
  assertWritablePath
};
