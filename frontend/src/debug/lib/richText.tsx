import type { ReactNode } from 'react';

/**
 * 把引号里的内容挑出来单独上色 —— 叙述和「谁在说话」一眼分得开。
 *
 * 正则的引号部分照搬酒馆 (public/script.js 里 messageFormatting 那段),
 * 六种引号:英文直引号 / 弯引号 / 直角 / 双直角 / 法式 / 全角。
 * 引号本身也一起包进去,酒馆的 <q> 标签同样是连符号一起染的。
 *
 * 两个刻意保留的行为:
 *
 * - `.` 不匹配换行 ⇒ 引号不跨行。落单的一个 " 只会一直找不到配对,
 *   而不会把它后面整篇正文都染成对话色。
 * - 必须成对才算数 ⇒ 流式输出时前半句先按原样显示,补上后引号的那一刻
 *   才整段染色。不需要为「还没说完」写任何特判。
 *
 * 这里不处理代码块和 HTML 转义(酒馆那条正则里还有几个分支干这个)——
 * 调试台的正文是 white-space:pre-wrap 的纯文本,没有 markdown 也没有标签。
 */
const QUOTE_RE =
  /(".*?")|(“.*?”)|(「.*?」)|(『.*?』)|(«.*?»)|(＂.*?＂)/g;

/**
 * 返回可直接塞进 JSX 的内容:没命中任何引号(或者关掉了高亮)时原样返回
 * 字符串,省掉一层没意义的数组和 span。
 */
export function renderQuoted(text: string, enabled: boolean): ReactNode {
  if (!enabled || !text) return text;

  const parts: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  QUOTE_RE.lastIndex = 0; // 正则带 g,是模块级共享的,每次用之前先归零
  for (let m = QUOTE_RE.exec(text); m !== null; m = QUOTE_RE.exec(text)) {
    if (m.index > cursor) parts.push(text.slice(cursor, m.index));
    parts.push(
      <span className="chat-quote" key={key++}>
        {m[0]}
      </span>,
    );
    cursor = m.index + m[0].length;
  }

  if (cursor === 0) return text; // 一处都没命中
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}
