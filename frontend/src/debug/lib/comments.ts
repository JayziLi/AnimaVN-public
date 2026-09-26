/**
 * 提示词注释 —— 行首 // 的整行不进请求。
 *
 * 规则刻意定得很窄:只认行首(允许前置空白)。
 * 不做行尾注释,因为 `见 https://x.com` 里就有 //,切了就毁 URL;
 * 也不做块注释。提示词是自然语言,出现这些字符的概率远高于代码,
 * 规则越窄越安全。
 */

/** 行首(允许前置空白)以 // 开头 */
const COMMENT_LINE = /^\s*\/\//;

/**
 * 这一行是注释吗?
 *
 * 编辑器的着色必须走这个函数,不能自己再写一遍正则 —— 两边一旦不一致,
 * 编辑器就会对「哪些字会发出去」撒谎,而那正是它唯一要说清楚的事。
 */
export function isCommentLine(line: string): boolean {
  return COMMENT_LINE.test(line);
}

/** 剔除所有注释行(连同该行的换行符) */
export function stripComments(text: string): string {
  // 绝大多数块里没有 //,先挡一道省掉 split/join
  if (!text.includes('//')) return text;
  return text
    .split('\n')
    .filter((line) => !isCommentLine(line))
    .join('\n');
}

/** 有几行被剔除 —— 详情弹窗的提示行用 */
export function countCommentLines(text: string): number {
  if (!text.includes('//')) return 0;
  return text.split('\n').filter(isCommentLine).length;
}
