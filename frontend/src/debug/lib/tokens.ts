/**
 * 粗略 token 估算。不追求准确 —— 调试台只需要相对量级,
 * 让你一眼看出「哦这块占了一半上下文」。
 *
 * CJK 大致 1 字 1 token,拉丁文大致 4 字符 1 token。
 */

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let rest = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk += 1;
    else rest += 1;
  }
  return Math.ceil(cjk + rest / 4);
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
