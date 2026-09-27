/**
 * 预设绑角色卡:选这张卡、打开它的任何一条对话,都换成绑定的预设。
 *
 * 和人设绑定(lib/personaBinding.ts)一个思路,但没有「默认预设」:没绑的卡照旧 ——
 * 打开对话恢复那条对话记的预设,新对话沿用当前预设。绑了的卡,绑定比对话记的预设优先。
 * 玩着临时换预设不改绑定,下次选这张卡还是换回来。
 * 全局一份,存在后端 app_settings(键 preset.bindings)。
 * 设计见 docs/superpowers/specs/2026-09-26-card-bindings-design.md
 */

import { cardMapOf } from './personaBinding';

export const PRESET_BINDING_KEY = 'preset.bindings';

export interface PresetBindings {
  /** 角色卡 id → 预设 id */
  cards: Record<string, string>;
}

export const EMPTY_PRESET_BINDINGS: PresetBindings = { cards: {} };

export function normalizePresetBindings(raw: unknown): PresetBindings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { cards: cardMapOf(r.cards) };
}

/** 这张卡绑的预设;没绑、或者绑的预设已经删了是 null */
export function presetForCard(
  b: PresetBindings,
  cardId: string | null,
  presetIds: readonly string[],
): string | null {
  const bound = cardId ? b.cards[cardId] : undefined;
  return bound && presetIds.includes(bound) ? bound : null;
}

/** 预设删了:指向它的绑定清掉 */
export function forgetPreset(b: PresetBindings, presetId: string): PresetBindings {
  return { cards: Object.fromEntries(Object.entries(b.cards).filter(([, p]) => p !== presetId)) };
}
