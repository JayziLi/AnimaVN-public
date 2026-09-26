import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * 横滑手势 —— 手机上用来翻消息的分支,替掉「非得点中那颗 12px 的小箭头」。
 *
 * 只认触摸(pointerType === 'touch')。鼠标不接:桌面上按住拖动是选文字,
 * 抢过来当手势会把复制回复这件事弄坏,而桌面本来就有 ‹ › 两颗按钮。
 *
 * 方向和酒馆一致(RossAscends-mods.js 里那两个 swiped-left/right 监听):
 * 手指往左 = 看下一条,手指往右 = 看上一条 —— 跟着内容走,不是跟着按钮走。
 */

/** 滑够这么多像素才算数。酒馆用的是 50,我们带跟手动画,稍微抬高一点更稳 */
const COMMIT_PX = 56;
/** 先滑够这么多才判方向 —— 刚落指那几像素的抖动定不了轴 */
const AXIS_PX = 12;
/** 横向要压过纵向这么多倍才认成横滑,斜着划优先让页面滚 */
const AXIS_RATIO = 1.4;
/** 跟手位移的饱和值:越滑越黏,不会把气泡拖出屏幕 */
const MAX_DRAG = 88;

/** 平滑饱和,dx 越大越接近 MAX_DRAG 但永远到不了 */
function damp(dx: number): number {
  return Math.sign(dx) * MAX_DRAG * (1 - Math.exp(-Math.abs(dx) / MAX_DRAG));
}

export interface SwipeGestureOptions {
  /** 关掉时手势完全不介入(编辑中、生成中、这条不可滑) */
  enabled: boolean;
  /** 手指往左划够了 —— 看下一条 */
  onLeft: () => void;
  /** 手指往右划够了 —— 看上一条 */
  onRight: () => void;
}

export interface SwipeGesture {
  handlers: {
    onPointerDown: (e: ReactPointerEvent) => void;
    onPointerMove: (e: ReactPointerEvent) => void;
    onPointerUp: (e: ReactPointerEvent) => void;
    onPointerCancel: () => void;
  };
  /** 当前跟手的横向位移,0 = 没在滑 */
  offset: number;
  /** 正在横滑 —— 拿去关掉回弹动画,不然拖着手感是拖泥带水的 */
  active: boolean;
}

export function useSwipeGesture({ enabled, onLeft, onRight }: SwipeGestureOptions): SwipeGesture {
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const axis = useRef<'undecided' | 'x' | 'y'>('undecided');
  const [offset, setOffset] = useState(0);

  const reset = () => {
    start.current = null;
    axis.current = 'undecided';
    setOffset(0);
  };

  return {
    offset,
    active: offset !== 0,
    handlers: {
      onPointerDown: (e) => {
        if (!enabled || e.pointerType !== 'touch') return;
        start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
        axis.current = 'undecided';
      },

      onPointerMove: (e) => {
        const s = start.current;
        if (!s || e.pointerId !== s.id) return;
        const dx = e.clientX - s.x;
        const dy = e.clientY - s.y;

        if (axis.current === 'undecided') {
          if (Math.abs(dx) < AXIS_PX && Math.abs(dy) < AXIS_PX) return;
          if (Math.abs(dx) <= Math.abs(dy) * AXIS_RATIO) {
            // 判成竖划:这一趟彻底让给页面滚动,中途不再翻案
            start.current = null;
            axis.current = 'y';
            return;
          }
          axis.current = 'x';
          // 抓住指针,手指滑出气泡外也还算这一次
          e.currentTarget.setPointerCapture(s.id);
        }

        setOffset(damp(dx));
      },

      onPointerUp: (e) => {
        const s = start.current;
        if (!s) {
          reset();
          return;
        }
        const dx = e.clientX - s.x;
        const committed = axis.current === 'x' && Math.abs(dx) >= COMMIT_PX;
        reset();
        if (!committed) return;
        // iOS 长按选词之后拖动,轨迹和横滑一模一样 —— 手上有选区就别当手势
        // (酒馆在编辑态直接不接手势,原话是 "the ios selection gestures get
        //  picked up as swipe gestures",同一个坑)
        if (window.getSelection()?.toString()) return;
        if (dx < 0) onLeft();
        else onRight();
      },

      onPointerCancel: reset,
    },
  };
}
