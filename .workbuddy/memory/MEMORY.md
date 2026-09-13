# 小问助手（XiaoWenDesktopAgent）· 项目长期笔记

## 基本信息
- 路径：`C:\Users\15155\WorkBuddy\小问助手`　远程：`git@github.com:virtualman333/XiaoWenDesktopAgent.git`　主分支：`main`
- 技术栈：Electron 32.3.3（内置 Node 20.18.1，无全局 WebSocket）+ 原生 JS + Vite 5 + electron-builder 25.1.8
- 版本：v1.0.0 初始化 → v1.0.4b → v1.1.0 贾维斯版（Agent/MCP/Skills/记忆人格/TTS） → v1.2.0 桌面宠物

## 版本管理约定
- **任务完成后自动提交并推送**（用户要求，无需再确认）：`git add <相关文件>` → `commit` → `push`；
  发版本时同步 `git tag vX.Y.Z` + `push --tags`。
- commit message 中文，`feat:` / `fix:` / `docs:` / `chore:` 前缀。
- 不入库：`release-*/`、`dist/`、`node_modules/`、`config.json`、`.env*`、截图 `build/_shot_*.png`。
- 打包前必须改 `package.json` 的 `version` 与 `build.directories.output`（旧的 output 目录被占用会导致
  `ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`）。

## 关键结构
- `src/main/main.js` — 主进程（悬浮球/面板/设置窗口、托盘、快捷键、ASR、config）
- `src/main/pet.js` — 桌面宠物窗口（v1.2）
- `src/main/jarvis/` — Agent 能力：agent / tools / mcp / skills / tts / autostart / store / index
- `src/main/preload.js` — contextBridge 暴露 `window.xw`
- `src/renderer/panel.html` — 一个 HTML 双用途，`#settings` hash 区分对话页/设置页
- 安全模型：真实 API Key 只在主进程，渲染进程只拿 `__KEEP__` 占位符 + `xxxMasked`

## 环境坑（本机沙箱）
1. **bash 无 coreutils**（ls/cat/tail 全无）——用 Node 脚本代替 shell 命令。
2. **跑 Electron 必须清 `ELECTRON_RUN_AS_NODE`**，且要在 spawn 的父进程 env 里删；同时加
   `disable-gpu` + **`no-sandbox`**（缺 no-sandbox 会 GPU 进程连环崩溃 → `loadFile ERR_FAILED`）。
3. **npm 被沙箱策略拦截**——用 `node node_modules/vite/bin/vite.js build`、
   `node node_modules/electron-builder/cli.js --win nsis`。
4. **同一文件必须串行编辑**，并行 Edit 会丢改动（曾导致 `abortAgent is not defined`）。
5. 隐藏窗口 `capturePage()` 常拿到上一帧，验证要以 `executeJavaScript` 读 DOM 为准。

## 验证脚本（build/）
- `_pet_smoke.js` 宠物渲染层 13 项、`_pet_main_test.js` 宠物主进程接线 6 项
- `_jarvis_e2e.js` 主进程 22 项（含 MCP 真实联调）、`_ui_smoke.js` 面板 UI 零报错

## 待办
- 补 `LICENSE`（package.json 声明 MIT 但文件缺失）
- 各版本 Setup 上传 GitHub Releases 备份
- 用户曾泄露阿里云 AccessKey，建议确认是否已在 RAM 控制台禁用
