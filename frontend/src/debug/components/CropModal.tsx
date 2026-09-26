import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * 头像裁剪 —— 换角色卡或玩家人设的头像时先框一块。
 *
 * 比例写死 1:1,输出 512×512,角色和玩家共用一套:调试台里头像都是方的
 * (聊天区左列、人设列表、卡面板),方图才是所见即所得。
 *
 * 这里刻意偏离了酒馆:酒馆的裁剪框默认 2:3、存成 512×768(popup.js 的
 * `aspectRatio: cropAspect ?? 2 / 3` + constants.js 的 AVATAR_WIDTH/HEIGHT)。
 * 它不校验图片尺寸 —— 卡的解析只读 PNG 里的 chara 数据块 —— 所以 1:1 的图
 * 照样能被酒馆导入,只是在它那边的卡列表里会按 2:3 裁着显示。
 *
 * 纯 canvas,不引依赖:显示层把图等比缩进盒子,选框坐标以显示尺寸为准,
 * 导出时换算回原图坐标再取样,所以不会因为预览缩小而掉画质。
 */
interface Props {
  file: File;
  onCancel: () => void;
  /** 裁剪完成:512×512 的 webp Blob(质量 0.9) */
  onCropped: (blob: Blob) => void;
}

/** 展示区上限:图片等比缩进这个盒子(不放大) */
const MAX_DISPLAY_W = 560;
const MAX_DISPLAY_H = 380;
/** 选框最小边长(显示像素) */
const MIN_SIZE = 32;

/** 输出尺寸:方图,和酒馆的 512 长边对齐 */
const OUT_W = 512;
const OUT_H = 512;
const RATIO = OUT_W / OUT_H;

type Rect = { x: number; y: number; w: number; h: number };
type HandleMode = 'move' | 'nw' | 'ne' | 'sw' | 'se';

interface DragState {
  mode: HandleMode;
  startX: number;
  startY: number;
  orig: Rect;
}

interface ImageSize {
  w: number;
  h: number;
  naturalW: number;
  naturalH: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** 在 bw×bh 里摆一个正方形选框:先取 80%,装不下就缩到装得下,居中 */
function fitRect(bw: number, bh: number, scale = 0.8): Rect {
  let w = bw * scale;
  let h = w / RATIO;
  if (h > bh * scale) {
    h = bh * scale;
    w = h * RATIO;
  }
  w = Math.min(w, bw);
  h = Math.min(h, bh);
  return { x: (bw - w) / 2, y: (bh - h) / 2, w, h };
}

export function CropModal({ file, onCancel, onCropped }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState<ImageSize | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [exporting, setExporting] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    // StrictMode 下 effect 会双跑:第一跑的 onload 可能晚于清理才回来,
    // 那时它那个 objectUrl 已经被 revoke 掉了。cancelled 挡住过期的那一跑,
    // 否则最终 state 里可能坐着一个已失效的 URL —— 表现就是弹窗开了但图不出来
    let cancelled = false;
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const scale = Math.min(MAX_DISPLAY_W / img.naturalWidth, MAX_DISPLAY_H / img.naturalHeight, 1);
      const w = Math.max(MIN_SIZE, Math.round(img.naturalWidth * scale));
      const h = Math.max(MIN_SIZE, Math.round(img.naturalHeight * scale));
      setSize({ w, h, naturalW: img.naturalWidth, naturalH: img.naturalHeight });
      setRect(fitRect(w, h));
      setUrl(objectUrl);
    };
    img.src = objectUrl;
    return () => {
      cancelled = true;
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  const beginDrag = (e: ReactPointerEvent, mode: HandleMode) => {
    if (!rect) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { mode, startX: e.clientX, startY: e.clientY, orig: { ...rect } };
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || !size) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const orig = drag.orig;

    if (drag.mode === 'move') {
      setRect({
        ...orig,
        x: clamp(orig.x + dx, 0, size.w - orig.w),
        y: clamp(orig.y + dy, 0, size.h - orig.h),
      });
      return;
    }

    // 四角缩放:锚点是被拉角的对角,向内收缩不允许越过锚点
    const east = drag.mode.includes('e');
    const south = drag.mode.includes('s');
    const ax = east ? orig.x : orig.x + orig.w;
    const ay = south ? orig.y : orig.y + orig.h;
    const availW = east ? size.w - ax : ax;
    const availH = south ? size.h - ay : ay;

    // 对角线上两个分量各说各话,取更"大"的那个当主导,另一边按比例跟着算,
    // 这样斜着拖手感是连续的,不会在两个方向之间跳
    let w = Math.max(east ? orig.w + dx : orig.w - dx, (south ? orig.h + dy : orig.h - dy) * RATIO);
    w = clamp(w, MIN_SIZE, availW);
    let h = w / RATIO;
    if (h > availH) {
      h = availH;
      w = h * RATIO;
    }
    if (h < MIN_SIZE) {
      h = MIN_SIZE;
      w = h * RATIO;
    }

    setRect({ x: east ? ax : ax - w, y: south ? ay : ay - h, w, h });
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  /**
   * 显示坐标 → 原图坐标,并把比例掰回严格 1:1 ——
   * 显示坐标是取整过的,换算回去 346×345 早就不是正方形了。
   */
  const sourceRect = (r: Rect, s: ImageSize) => {
    const scaleX = s.naturalW / s.w;
    const scaleY = s.naturalH / s.h;
    const sx = Math.round(r.x * scaleX);
    const sy = Math.round(r.y * scaleY);
    let sw = Math.max(1, Math.round(r.w * scaleX));
    let sh = Math.max(1, Math.round(r.h * scaleY));
    // 先按宽反算高;顶到图片下边界就反过来用高回算宽,总之不越界
    sh = clamp(Math.round(sw / RATIO), 1, s.naturalH - sy);
    sw = clamp(Math.round(sh * RATIO), 1, s.naturalW - sx);
    return { sx, sy, sw, sh };
  };

  const confirm = () => {
    if (!size || !rect || !imgRef.current) return;
    const { sx, sy, sw, sh } = sourceRect(rect, size);
    // 一律输出 512×512:框小了也放大,免得头像位上尺寸参差
    const canvas = document.createElement('canvas');
    canvas.width = OUT_W;
    canvas.height = OUT_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(imgRef.current, sx, sy, sw, sh, 0, 0, OUT_W, OUT_H);
    setExporting(true);
    canvas.toBlob(
      (blob) => {
        setExporting(false);
        if (blob) onCropped(blob);
      },
      'image/webp',
      0.9,
    );
  };

  const src = size && rect ? sourceRect(rect, size) : null;

  return (
    <div className="inspector-backdrop" onClick={onCancel}>
      <div className="inspector crop-inspector" onClick={(e) => e.stopPropagation()}>
        <div className="inspector-head">
          <span className="inspector-title">裁剪头像 · Crop</span>
          <span className="crop-spec">1:1 · 输出 {`${OUT_W}×${OUT_H}`}</span>
          <div style={{ flex: 1 }} />
          <button className="btn small" onClick={onCancel} disabled={exporting}>
            取消
          </button>
          <button className="btn small accent" onClick={confirm} disabled={!rect || exporting}>
            {exporting ? '导出中…' : '确认裁剪'}
          </button>
        </div>

        <div className="crop-body">
          {!url || !size || !rect ? (
            <div className="crop-hint">加载图片中……</div>
          ) : (
            <div
              className="crop-stage"
              style={{ width: size.w, height: size.h }}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <img ref={imgRef} className="crop-img" src={url} alt="待裁剪图片" draggable={false} />
              <div
                className="crop-rect"
                style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
                onPointerDown={(e) => beginDrag(e, 'move')}
              >
                <span className="crop-handle nw" onPointerDown={(e) => beginDrag(e, 'nw')} />
                <span className="crop-handle ne" onPointerDown={(e) => beginDrag(e, 'ne')} />
                <span className="crop-handle sw" onPointerDown={(e) => beginDrag(e, 'sw')} />
                <span className="crop-handle se" onPointerDown={(e) => beginDrag(e, 'se')} />
              </div>
            </div>
          )}
          <div className="crop-hint">
            {size && `原图 ${size.naturalW}×${size.naturalH}`}
            {src && ` · 取样 ${src.sw}×${src.sh}`}
            {' · 比例锁死 1:1,拖角只改大小'}
          </div>
        </div>
      </div>
    </div>
  );
}
