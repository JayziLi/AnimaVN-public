/**
 * 预算条的刻度与持久化。
 *
 * 轨道是线性的,量程(轨道右端代表多少 token)由 −/+ 在阶梯上换挡 ——
 * 线性才能让固定开销的填充段长度是真比例,换挡等于把那两段放大缩小着看。
 */

const BUDGET_KEY = 'debug.tokenBudget';
const RANGE_KEY = 'debug.tokenRange';

export const DEFAULT_BUDGET = 16384;

/** 量程阶梯。挡距在小值处密、大值处疏,和常用上下文长度对齐 */
export const RANGE_STEPS = [8192, 16384, 32768, 65536, 131072, 204800];

/**
 * 读预算。undefined = 从来没设过(该从预设播种默认值);
 * null = 用户明确关掉了截断(要粘住,刷新后不能又自己开回来)。
 */
export function loadBudget(): number | null | undefined {
  const raw = window.localStorage.getItem(BUDGET_KEY);
  if (raw === null) return undefined;
  if (raw === 'off') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function saveBudget(value: number | null): void {
  window.localStorage.setItem(BUDGET_KEY, value === null ? 'off' : String(value));
}

export function loadRange(): number | null {
  const raw = window.localStorage.getItem(RANGE_KEY);
  if (raw === null) return null;
  const n = Number(raw);
  return RANGE_STEPS.includes(n) ? n : null;
}

export function saveRange(value: number): void {
  window.localStorage.setItem(RANGE_KEY, String(value));
}

/** 阶梯上移/下移一挡。越界就钉在端点上,不循环 */
export function stepRange(current: number, dir: 1 | -1): number {
  const i = RANGE_STEPS.indexOf(current);
  if (i === -1) return autoRange(current);
  const next = Math.min(RANGE_STEPS.length - 1, Math.max(0, i + dir));
  return RANGE_STEPS[next];
}

/** 最小的、装得下 budget 的那一挡;超过顶端就钉在最高挡 */
export function autoRange(budget: number): number {
  return RANGE_STEPS.find((r) => r >= budget) ?? RANGE_STEPS[RANGE_STEPS.length - 1];
}

/** show more 的渲染窗口大小。设置 UI 下一轮再补,先把接口留好 */
const VISIBLE_KEY = 'debug.visibleMessages';

export const DEFAULT_VISIBLE = 50;

export function loadVisible(): number {
  const raw = window.localStorage.getItem(VISIBLE_KEY);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 10 ? Math.floor(n) : DEFAULT_VISIBLE;
}
