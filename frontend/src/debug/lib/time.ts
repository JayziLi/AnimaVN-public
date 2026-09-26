/**
 * 后端的时间戳是 UTC,但序列化时不带 tz 后缀(SQLite 存的是 naive datetime)。
 * 直接喂给 Date 会被当成本地时间,相对时间能差出好几个小时 —— 没有 Z / ±hh:mm
 * 就补一个 Z 再解析。
 */
export function parseUtc(iso: string): number {
  return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`).getTime();
}

export const two = (n: number) => String(n).padStart(2, '0');

/** 「刚刚 / 3 分钟前 / 昨天」—— 超过一周退回日期,相对说法反而不好定位 */
export function relTime(iso: string): string {
  const t = parseUtc(iso);
  if (Number.isNaN(t)) return '';
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  const d = new Date(t);
  const date = `${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  return d.getFullYear() === new Date().getFullYear() ? date : `${d.getFullYear()}-${date}`;
}
