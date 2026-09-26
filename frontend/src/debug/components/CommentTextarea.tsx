import { useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, UIEvent as ReactUIEvent } from 'react';
import { isCommentLine } from '../lib/comments';

/**
 * 带注释着色的提示词输入框 —— 注释行灰下去,像代码编辑器。
 *
 * 做法是经典的「双层」:一个 <pre> 垫在底下渲染着色后的文本,上面盖一个
 * 文字透明、只留光标的 textarea。不引编辑器依赖(CodeMirror 之类几百 KB),
 * 也不用 contentEditable —— 后者会毁掉撤销栈,中文输入法下更是灾难。
 *
 * 两层必须严丝合缝地对齐,否则光标会飘。所以字号/行高/padding 全部写在
 * 同一条规则里,padding 还走 CSS 变量,变体只能整体改、没法让两层各走各的。
 *
 * 着色判定走 lib/comments 的 isCommentLine —— 和真正剔除注释的是同一个函数。
 * 这里绝不能自己再写一遍正则:两边不一致,编辑器就在骗人。
 */

interface Props {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  placeholder?: string;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
}

export function CommentTextarea({
  value,
  onChange,
  autoFocus,
  placeholder,
  onKeyDown,
}: Props) {
  const hlRef = useRef<HTMLPreElement>(null);
  /**
   * 输入法组字期间把真字露出来。
   * 候选词上屏之前它还不在 value 里,底层的 <pre> 画不出来;
   * 而 textarea 的字是透明的 —— 不特殊处理的话,打中文时屏幕上一片空白。
   */
  const [composing, setComposing] = useState(false);

  /** 两层各自滚动会错位,把底层焊在上层的滚动位置上 */
  const syncScroll = (e: ReactUIEvent<HTMLTextAreaElement>) => {
    const el = hlRef.current;
    if (!el) return;
    el.scrollTop = e.currentTarget.scrollTop;
    el.scrollLeft = e.currentTarget.scrollLeft;
  };

  const lines = value.split('\n');

  return (
    <div className={`ct-wrap ct-modal${composing ? ' composing' : ''}`}>
      <pre className="ct-hl" aria-hidden="true" ref={hlRef}>
        {lines.map((line, i) => (
          // 每行后面都补一个换行(包括最后一行) —— 否则末尾空行没有高度,
          // 滚到底时两层会差一行
          <span key={i} className={isCommentLine(line) ? 'ct-comment' : undefined}>
            {line}
            {'\n'}
          </span>
        ))}
      </pre>
      <textarea
        className="ct-input"
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={onKeyDown}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
      />
    </div>
  );
}
