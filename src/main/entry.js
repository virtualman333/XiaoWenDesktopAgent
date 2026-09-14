'use strict';
/**
 * 桌面入口：「悬浮球」和「宠物」谁上场（纯函数，不碰 Electron，可以单测）
 *
 * 背景：这两个其实是**同一个入口的两种样子** —— 都能单击聊天、双击语音问答、
 * 拖着换位置、右键出菜单，还能常驻监听唤醒词。功能完全重叠，同时摆在桌面上
 * 只会互相抢地盘、还让用户不知道该点哪个。
 *
 * 所以规则定成「同一时刻只出现一个」：
 *
 *   宠物开着  → 悬浮球退场（宠物完全代替它）
 *   宠物关掉  → 悬浮球回来
 *
 * `ballEnabled` 留了个显式口子：
 *   'auto'（默认）—— 按上面那条规则走
 *   true          —— 两个都要（少数人喜欢球当快捷入口）
 *   false         —— 只要宠物，球永远不出现
 *
 * ⚠️ 唯一不能破的底线：**桌面上不能两个入口都没有**。所以宠物关着时，
 * 不管 `ballEnabled` 配的是什么，悬浮球一定会回来。历史上有过
 * 「配置里都关掉了、桌面上什么都点不到，用户只能去任务管理器」的坑。
 *
 * 唤醒监听（那个常驻开麦的模块）跟着宿主走，见 `entryHost`。
 */

/** 配置里的档位归一化成 'auto' | true | false */
function entryMode(cfg) {
  const v = cfg && cfg.ballEnabled;
  if (v === true || v === false) return v;
  return 'auto';
}

/** 现在该不该显示悬浮球 */
function ballWanted(cfg) {
  const c = cfg || {};
  // 宠物没开 → 球必须顶上（兜底：别让桌面彻底没入口）
  if (c.petEnabled === false) return true;
  // 宠物开着 → 只有用户显式要求「两个都要」才显示球
  return entryMode(c) === true;
}

/** 谁托管语音唤醒：球在场就归球（一直这么跑，最稳），否则归宠物 */
function entryHost(cfg, ballAlive) {
  if (ballAlive) return 'ball';
  return ballWanted(cfg) ? 'ball' : 'pet';
}

/** 给设置页 / 右键菜单用的一份概要 */
function entryStatus(cfg, ballAlive) {
  const c = cfg || {};
  const host = entryHost(c, ballAlive);
  const ballShown = !!ballAlive;
  return {
    host,
    ballShown,
    ballWanted: ballWanted(c),
    // 期望值和实际值不一致 = 窗口还没跟上配置（同步中或出了问题）
    inSync: ballShown === ballWanted(c),
    mode: entryMode(c),
    petOn: c.petEnabled !== false
  };
}

/** 一句话说清现在是谁在当入口，给日志和界面用 */
function describeEntry(cfg, ballAlive) {
  const st = entryStatus(cfg, ballAlive);
  const who = st.ballShown ? '悬浮球' : '桌面宠物';
  const why = st.petOn ? '宠物开着，宠物完全代替了它' : '宠物关着，悬浮球顶班';
  return `${who}（${why}）`;
}

module.exports = { entryMode, ballWanted, entryHost, entryStatus, describeEntry };
