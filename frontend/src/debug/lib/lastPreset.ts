/**
 * 上次打开的预设 —— 对齐酒馆:预设是全局的「当前配置」,关掉再开还是它。
 *
 * 存在 localStorage 而不是库里,和角色卡的 last_chat_id 是两回事:
 * 那个是「这张卡上次聊到哪」,属于数据;这个是「我这台机器习惯用哪套预设」,
 * 属于本机偏好,和字号、预算旋钮同一类。
 *
 * 只存 id。预设可能被删,所以读回来的 id 必须先在列表里找得到才算数 ——
 * 校验放在调用点(那儿才有列表),这里只负责存取。
 */

const KEY = 'debug.lastPresetId';

export function loadLastPresetId(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    // 隐私模式 / 存储被禁:当没记过,回退到列表第一个
    return null;
  }
}

export function saveLastPresetId(id: string): void {
  try {
    window.localStorage.setItem(KEY, id);
  } catch {
    // 存不进去就算了 —— 丢的只是「下次默认选哪个」
  }
}
