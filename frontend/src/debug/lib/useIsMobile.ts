import { useEffect, useState } from 'react';

/** 移动端断点 —— 和酒馆 public/css/mobile-styles.css 对齐,单档 1000px,
    竖屏 iPad 也算进来。debug.css 里的 @media 用的是同一个数,改一处就得改两处。 */
export const MOBILE_QUERY = '(max-width: 1000px)';

/**
 * 移动端布局要不要生效。
 *
 * 绝大部分适配都在 CSS 里做完了,这个钩子只服务于改不动 CSS 的那几件事:
 * 进移动端得把两侧面板收起来(它们在移动端是盖住聊天区的全屏抽屉,默认开着
 * 等于开局就看不见对话),以及拖拽调宽要整个停掉。
 */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}

/**
 * 主输入设备是手指还是鼠标。
 *
 * 「有没有软键盘」没有直接的检测手段,pointer: coarse 是最接近的一个 ——
 * 手机和平板命中,带触摸屏的笔记本不命中(它的主指针仍是鼠标)。
 *
 * 不能拿 useIsMobile 代替:那是个宽度断点,桌面窗口拖窄到 1000px 以下也会命中,
 * 于是硬件键盘上的 Enter 发送就莫名其妙失灵了。两者量的不是一件事。
 */
export function useCoarsePointer(): boolean {
  return useMediaQuery('(pointer: coarse)');
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener('change', onChange);
    // 订阅之前那一小段里可能已经转过向了,补一次
    setMatches(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
