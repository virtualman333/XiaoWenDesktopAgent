/**
 * 桌面入口规则（渲染层版本，和 `src/main/entry.js` 是同一套规则的镜像）
 *
 * 为什么要有两份：主进程是 CommonJS、渲染层是 ES Module，共用一个文件没法
 * 两边都 import。规则本身只有三行，与其塞进构建流程去共享，不如各写一份、
 * 然后用单测断言两边**对所有组合的结果完全一致**（见 build/_entry_test.mjs）。
 *
 * 这份目前只被宠物窗口用到：它要知道「唤醒监听是不是该由我托管」。
 * 悬浮球那边不需要判断 —— 它只在自己是唯一入口时才存在。
 */

/** 配置里的档位归一化成 'auto' | true | false */
export function entryMode(cfg) {
  const v = cfg && cfg.ballEnabled;
  if (v === true || v === false) return v;
  return 'auto';
}

/** 现在该不该显示悬浮球（球在场 = 宠物要让位） */
export function ballWanted(cfg) {
  const c = cfg || {};
  if (c.petEnabled === false) return true;
  return entryMode(c) === true;
}

/**
 * 宠物该不该托管语音唤醒监听。
 * 球在场时归球（它一直干这事，最稳）；球不在场才轮到宠物。
 * 用户没开唤醒开关的话，谁都不用听。
 */
export function shouldHostWake(cfg) {
  const c = cfg || {};
  if (c.wakeEnabled !== true) return false;
  if (c.petEnabled === false) return false; // 宠物不在场
  return !ballWanted(c);
}
