/**
 * 标题画面(Beta)用到的素材小工具:挑表情、从图里取色、按脸摆立绘。
 * 都不认识具体的角色 —— 新导入的卡、新的场景包不用配置就能用。
 */

import type { CSSProperties } from 'react';
import type { CardSprite } from '../lib/api';
import type { FaceBox } from '../plugins/spriteLayout';

// ---- 表情 ----

/** 封面上的几种场合。菜单的按钮各对应一种,鼠标移上去她就换这个表情 */
export type TitleMood = 'idle' | 'continue' | 'new' | 'load' | 'config' | 'exit' | 'poke' | 'ghost';

/** 每种场合一串近义词,按顺序找立绘名(或别名)对得上的第一个;都没有就用默认表情 */
const MOODS: Record<TitleMood, string[]> = {
  idle: [],
  continue: ['微笑', '开心', '温柔'],
  new: ['开心', '兴奋', '期待', '大笑', '俏皮', '调皮', '得意', '偷笑'],
  load: ['认真', '观察', '说话', '平静', '好奇'],
  config: ['疑惑', '好奇', '眨眼', '惊讶'],
  exit: ['难过', '委屈', '幽怨', '担心', '闷闷', '无奈', '疲惫'],
  poke: ['害羞', '不好意思', '慌张', '惊讶', '羞恼', '心虚'],
  ghost: ['温柔', '平静', '微笑'],
};

/** 电影片头里每个镜头换一个,按顺序挑她有的 */
const MONTAGE: string[] = ['开心', '温柔', '害羞', '说话', '调皮', '俏皮', '眨眼', '兴奋', '好奇', '平静'];

const named = (sprites: readonly CardSprite[], name: string) =>
  sprites.find((s) => s.has_image && (s.label === name || s.aliases.includes(name))) ?? null;

/** sprites 是启用的立绘,排第一的是默认表情(和游戏里一样) */
export function spriteForMood(sprites: readonly CardSprite[], mood: TitleMood): CardSprite | null {
  for (const name of MOODS[mood]) {
    const hit = named(sprites, name);
    if (hit) return hit;
  }
  return sprites.find((s) => s.has_image) ?? null;
}

export function montageSprites(sprites: readonly CardSprite[]): CardSprite[] {
  return MONTAGE.map((n) => named(sprites, n)).filter((s): s is CardSprite => s !== null);
}

// ---- 按脸摆立绘 ----

/**
 * 封面上的一种摆法,单位和游戏里的 SpriteStage 一样是舞台高度;cx 是脸中线的横向位置(舞台宽度的比例)。
 * floor = 立绘下沿至少要到哪:原图只画到腰的会放大到盖住它,不在半空露出切边
 */
export interface TitlePose {
  faceSize: number;
  faceTop: number;
  cx: number;
  floor?: number;
}

/** 低清立绘别硬放大:显示高度最多到原图的这么多倍,超了就缩小(脸跟着变小,但不糊) */
const MAX_UPSCALE = 1.5;

/**
 * 立绘 <img> 的行内样式。stageH 是舞台的像素高度、canvasH 是原图高度(face_scan 里有),
 * 两个都知道才限制放大倍数。没有脸框的按老办法:撑满高度、底边对齐
 */
export function titleSpriteStyle(
  face: FaceBox | null,
  canvasH: number | null,
  pose: TitlePose,
  stageH: number,
): CSSProperties {
  if (!face) {
    return { height: '100cqh', left: `${pose.cx * 100}cqw`, bottom: 0, transform: 'translateX(-50%)' };
  }
  const floor = pose.floor ?? 1.02;
  let h = Math.max(pose.faceSize / face.h, (floor - pose.faceTop) / (1 - face.y));
  if (canvasH && stageH > 0) h = Math.min(h, (canvasH * MAX_UPSCALE) / stageH);
  // 被限住了还是够不着底:整体往下挪,宁可头低一点也别露出切边
  const top = Math.max(pose.faceTop, floor - h * (1 - face.y));
  return {
    height: `${h * 100}cqh`,
    left: `${pose.cx * 100}cqw`,
    top: `${top * 100}cqh`,
    bottom: 'auto',
    transform: `translate(${-(face.x + face.w / 2) * 100}%, ${-face.y * 100}%)`,
  };
}

// ---- 取色 ----

type Hsl = [number, number, number];

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const hsl = (h: number, s: number, l: number) =>
  `hsl(${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`;

/**
 * 把图缩小画到 canvas 上读像素。跨域的图要服务器放行(CORS)才读得到,读不到就给 null,
 * 调用方用默认配色 —— 取色只是锦上添花,不能让封面出不来
 */
function readPixels(src: string, maxSide: number): Promise<Uint8ClampedArray | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * k));
        const h = Math.max(1, Math.round(img.naturalHeight * k));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(ctx.getImageData(0, 0, w, h).data);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * 取色用的小图:立绘、背景的接口认 ?w=,缩成这个宽度的 WebP。
 * 不只是省流量 —— 原图地址早被游戏里的普通 <img> 缓存过(响应里没有 CORS 头),
 * 同一个地址再以 CORS 方式请求会被浏览器拦下,换个地址才读得到像素(见 AnimaBackend/app/images.py)
 */
const shrunk = (src: string, w: number) => `${src}${src.includes('?') ? '&' : '?'}w=${w}`;

function cached<T>(fn: (src: string) => Promise<T>): (src: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (src) => {
    let hit = cache.get(src);
    if (!hit) {
      hit = fn(src);
      cache.set(src, hit);
    }
    return hit;
  };
}

/** 角色的点缀色:深色界面上用 acc,纸面上用 deep;ink 是压在 acc 底色上的字色(游戏里的主题色用) */
export interface Accent {
  acc: string;
  deep: string;
  ink: string;
  /** 「r, g, b」—— 画光点用 */
  rgb: string;
}

/**
 * 从立绘里取主色:按色相分 18 桶,饱和度越高、越不偏黑白的像素分量越重;肤色、近黑近白不算。
 * 衣服太灰(饱和度都很低)时放宽一次,还取不到就是 null
 */
export const accentOf = cached(async (src: string): Promise<Accent | null> => {
  const px = await readPixels(shrunk(src, 160), 128);
  if (!px) return null;
  for (const minSat of [0.2, 0.06]) {
    const buckets = new Map<number, [number, number, number, number]>();
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 200) continue;
      const [h, s, l] = rgbToHsl(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
      if (l < 0.12 || l > 0.8 || s < minSat) continue;
      if (h <= 43 && l > 0.5 && s < 0.8) continue; // 肤色
      const w = s * s * (1 - Math.abs(l - 0.5));
      const k = Math.floor(h / 20);
      const e = buckets.get(k) ?? [0, 0, 0, 0];
      e[0] += w;
      e[1] += px[i] * w;
      e[2] += px[i + 1] * w;
      e[3] += px[i + 2] * w;
      buckets.set(k, e);
    }
    let best: [number, number, number, number] | null = null;
    for (const e of buckets.values()) if (!best || e[0] > best[0]) best = e;
    if (best && best[0] > 3) {
      const [h, s] = rgbToHsl(best[1] / best[0] / 255, best[2] / best[0] / 255, best[3] / best[0] / 255);
      const acc = hslToRgb(h, clamp(s, 0.42, 0.78), 0.72);
      return {
        acc: `rgb(${acc.join(' ')})`,
        deep: hsl(h, clamp(s, 0.35, 0.62), 0.36),
        ink: hsl(h, clamp(s, 0.3, 0.5), 0.13),
        rgb: acc.join(', '),
      };
    }
  }
  return null;
});

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((x) => Math.round(x * 255)) as [number, number, number];
}

/** 海报的纸面配色:亮的场景浅色纸染上场景色调;暗的场景(夜景)深色纸、字反白 */
export interface Paper {
  paper: string;
  ink: string;
  dark: boolean;
}

/**
 * 背景的色调:色相按饱和度加权平均(灰的地方不算数),明暗看平均亮度。
 * 缩到 64 宽就够了,要的只是大概的颜色
 */
export const paperOf = cached(async (src: string): Promise<Paper | null> => {
  const px = await readPixels(shrunk(src, 96), 64);
  if (!px) return null;
  let wr = 0;
  let wg = 0;
  let wb = 0;
  let ws = 0;
  let lum = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] / 255;
    const g = px[i + 1] / 255;
    const b = px[i + 2] / 255;
    const [, s] = rgbToHsl(r, g, b);
    const w = s * s + 0.02;
    wr += r * w;
    wg += g * w;
    wb += b * w;
    ws += w;
    lum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    n++;
  }
  if (n === 0) return null;
  const [h, s] = rgbToHsl(wr / ws, wg / ws, wb / ws);
  const dark = lum / n < 0.3;
  return dark
    ? { paper: hsl(h, clamp(s * 0.55, 0.18, 0.5), 0.14), ink: hsl(h, 0.22, 0.93), dark }
    : { paper: hsl(h, clamp(s * 0.5, 0.12, 0.38), 0.9), ink: hsl(h, 0.3, 0.12), dark };
});
