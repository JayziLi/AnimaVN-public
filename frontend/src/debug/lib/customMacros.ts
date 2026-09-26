/**
 * 自定义宏 —— 你自己定的 {{名字}} → 一段文本。
 *
 * 和显示偏好一样存 localStorage、不进数据库,但**不是**显示偏好:它会进提示词。
 * 所以单独一个键,「恢复默认」不该顺手把它清空。
 */

export interface CustomMacro {
  name: string;
  value: string;
}

const KEY = 'debug.customMacros';

/**
 * 名字里不能有大括号、冒号和空白 —— 这三样是 MACRO_RE 的分隔符,
 * 放进去解析器就找不着这个宏了。除此之外随便(中文名也行)。
 */
export const NAME_RE = /^[^{}:\s]+$/;

/** 编辑器里允许存在半成品(名字还没打完),但它不该进解析表 */
export function isUsable(m: CustomMacro): boolean {
  return NAME_RE.test(m.name);
}

/**
 * 列表 → 解析用的查找表。名字小写化,和内置宏一样大小写不敏感。
 * 同名的后来者覆盖前面的 —— UI 会把重名标出来,这里只需要有个确定的结果。
 */
export function toLookup(list: readonly CustomMacro[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of list) {
    if (isUsable(m)) out[m.name.toLowerCase()] = m.value;
  }
  return out;
}

export function loadCustomMacros(): CustomMacro[] {
  let raw: unknown;
  try {
    const text = window.localStorage.getItem(KEY);
    if (text === null) return [];
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .map((m) => ({
      name: typeof m.name === 'string' ? m.name : '',
      value: typeof m.value === 'string' ? m.value : '',
    }));
}

export function saveCustomMacros(list: readonly CustomMacro[]): void {
  window.localStorage.setItem(KEY, JSON.stringify(list));
}
