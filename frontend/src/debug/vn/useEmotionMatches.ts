/**
 * 对不上立绘名的标签,批量问后端模型;结果放在整个页面共用的缓存里(重新进视觉小说
 * 不用再问),键 = 候选签名 + 标签。返回一个查询函数,结果回来后换成新函数,
 * 用到它的 useMemo 会跟着重算。
 */

import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { debugApi } from '../lib/api';
import { resolveByLabel } from '../plugins/common';
import {
  candidatesSignature,
  matchTag,
  MAX_TAG_LEN,
  normTag,
  toRequestCandidate,
  type EmotionCandidate,
  type ModelEntry,
  type TagResolver,
} from '../plugins/emotionMatch';

const cache = new Map<string, ModelEntry>();
const inflight = new Set<string>();
/** 失败过的标签过这么久再问一次(后端重启了、刚装好模型) */
const RETRY_MS = 60_000;
/** 后端一次最多收 50 个 */
const BATCH = 50;

const keyOf = (sig: string, tag: string) => `${sig}\u0000${tag}`;

export function useEmotionMatches(
  labels: readonly string[],
  candidates: readonly EmotionCandidate[],
): TagResolver {
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  const sig = useMemo(() => candidatesSignature(candidates), [candidates]);

  // 要问的:精确匹配不上、长度合法的标签,去重
  const wanted = useMemo(() => {
    const out = new Set<string>();
    for (const l of labels) {
      const tag = normTag(l);
      if (!tag || tag.length > MAX_TAG_LEN || resolveByLabel(tag, candidates)) continue;
      out.add(tag);
    }
    return [...out];
  }, [labels, candidates]);

  useEffect(() => {
    const now = Date.now();
    const todo = wanted
      .filter((t) => {
        const k = keyOf(sig, t);
        if (inflight.has(k)) return false;
        const hit = cache.get(k);
        return !hit || ('error' in hit && now - hit.at > RETRY_MS);
      })
      .slice(0, BATCH);
    const request = candidates.map(toRequestCandidate).filter((c) => c.names.length > 0);
    if (todo.length === 0 || request.length === 0) return;
    const keys = todo.map((t) => keyOf(sig, t));
    keys.forEach((k) => inflight.add(k));
    debugApi
      .emotionMatch({ tags: todo, candidates: request })
      .then((res) => {
        res.results.forEach((r, i) => cache.set(keys[i], { key: r.key, score: r.score }));
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        keys.forEach((k) => cache.set(k, { error, at: Date.now() }));
      })
      .finally(() => {
        keys.forEach((k) => inflight.delete(k));
        bump();
      });
  }, [wanted, sig, candidates, version]);

  return useCallback(
    (label: string) => matchTag(label, candidates, (tag) => cache.get(keyOf(sig, tag))),
    // version:结果回来后换一个新函数
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [candidates, sig, version],
  );
}
