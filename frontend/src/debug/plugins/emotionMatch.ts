/**
 * 立绘标签 → 这张卡的哪个表情。先精确匹配(名字 / 别名,不分大小写),对不上的交给
 * 后端模型挑列表里最像的(/api/emotion/match)。立绘层、占位框、语音、控制台都用这里。
 * 规则见 docs/superpowers/specs/2026-09-25-sprite-emotion-matching-design.md
 */

import type { CardSprite } from '../lib/api';
import type { TagHit } from '../vn/script';
import { resolveByLabel } from './common';
import { BUILTIN_EMOTIONS } from './emotions';

/** 一个能被匹配到的表情:有立绘时是一张立绘,没有时是一个内置表情 */
export interface EmotionCandidate {
  key: string;
  label: string;
  aliases: string[];
}

export function emotionCandidates(sprites: readonly CardSprite[]): EmotionCandidate[] {
  if (sprites.length > 0) return sprites.map((s) => ({ key: s.id, label: s.label, aliases: s.aliases }));
  return BUILTIN_EMOTIONS.map((e) => ({ key: e.label, label: e.label, aliases: [...e.aliases] }));
}

/** 候选变了(换卡、改立绘)结果就作废:缓存键里带着它 */
export const candidatesSignature = (candidates: readonly EmotionCandidate[]) =>
  candidates.map((c) => [c.key, c.label, ...c.aliases].join('\u0001')).join('\u0002');

/** 后端一次最多收 40 字的词,更长的不问 */
export const MAX_TAG_LEN = 40;
const MAX_NAMES = 20;

export const normTag = (label: string) => label.trim();

/** 发给后端的候选:名字 + 别名,去掉太长的,最多 20 个 */
export function toRequestCandidate(c: EmotionCandidate): { key: string; names: string[] } {
  const names = [c.label, ...c.aliases]
    .map((n) => n.trim())
    .filter((n) => n && n.length <= MAX_TAG_LEN)
    .slice(0, MAX_NAMES);
  return { key: c.key, names };
}

/** 后端的结果;出错时记下原因和时间(过一会儿再试) */
export type ModelEntry = { key: string; score: number } | { error: string; at: number };

export type TagMatch =
  | { state: 'exact'; label: string }
  | { state: 'model'; label: string; score: number }
  | { state: 'pending' }
  | { state: 'failed'; reason: string };

export type TagResolver = (label: string) => TagMatch;

export function matchTag(
  label: string,
  candidates: readonly EmotionCandidate[],
  lookup: (tag: string) => ModelEntry | undefined,
): TagMatch {
  const tag = normTag(label);
  if (!tag) return { state: 'failed', reason: '标签里没写表情' };
  const exact = resolveByLabel(tag, candidates);
  if (exact) return { state: 'exact', label: exact.label };
  if (tag.length > MAX_TAG_LEN) return { state: 'failed', reason: '标签太长' };
  const r = lookup(tag);
  if (!r) return { state: 'pending' };
  if ('error' in r) return { state: 'failed', reason: r.error };
  const c = candidates.find((x) => x.key === r.key);
  return c ? { state: 'model', label: c.label, score: r.score } : { state: 'pending' };
}

/** 标签后面紧跟的是另一个有名字的角色的台词:不切主角的立绘 */
export const isNpcHit = (h: TagHit, charName: string) =>
  h.kind === 'sprite' && typeof h.speaker === 'string' && h.speaker !== charName;

/** 累计表情时要的东西:查结果、没立绘时失败用原词、认 NPC 用的角色名 */
export interface EmotionContext {
  resolve: TagResolver;
  /** 这张卡一张立绘都没有:模型不可用时占位框 / 语音用 AI 写的原词(以前的行为) */
  rawOnFail: boolean;
  charName: string;
}
