/**
 * 角色卡在两种形态之间转换:
 *   TavernCard  —— 组装器吃的形态(cardParser 规范化过的)
 *   StoredCard  —— 后端存的形态(字段名照搬 chara_card_v2/v3 spec)
 *
 * 两者字段几乎一一对应,差别只在 character_book 的形状和 sourceChunk
 * (后者是「从哪个 PNG chunk 读出来的」,只在导入那一刻有意义,不入库)。
 */

import type { StoredCard, StoredCardPayload } from './api';
import { EMPTY_CARD, type CharacterBookEntry, type TavernCard } from './cardParser';

function normalizeBook(v: unknown): TavernCard['character_book'] {
  if (!v || typeof v !== 'object') return null;
  const entries = (v as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return null;
  return {
    entries: entries.map((e: Record<string, unknown>): CharacterBookEntry => ({
      keys: Array.isArray(e.keys) ? e.keys.filter((k): k is string => typeof k === 'string') : [],
      content: typeof e.content === 'string' ? e.content : '',
      enabled: e.enabled !== false,
      insertion_order: typeof e.insertion_order === 'number' ? e.insertion_order : 0,
      comment: typeof e.comment === 'string' ? e.comment : '',
    })),
  };
}

/** DB 行 → 组装器形态 */
export function cardFromStored(row: StoredCard): TavernCard {
  return {
    ...EMPTY_CARD,
    name: row.name,
    description: row.description,
    personality: row.personality,
    scenario: row.scenario,
    first_mes: row.first_mes,
    mes_example: row.mes_example,
    system_prompt: row.system_prompt,
    post_history_instructions: row.post_history_instructions,
    creator_notes: row.creator_notes,
    alternate_greetings: row.alternate_greetings,
    tags: row.tags,
    creator: row.creator,
    character_version: row.character_version,
    character_book: normalizeBook(row.character_book),
    extensions: row.extensions,
    spec: row.spec,
    sourceChunk: 'db',
    avatar: null,
  };
}

/** 组装器形态 → DB 行(不含 avatar,头像单独走;也不含 last_chat_id ——
 *  那是「上次打开哪条对话」的书签,由切对话时单独写,编辑卡不该碰它。
 *  自动保存走的就是这个函数,带上它等于每次敲字都把书签覆写一遍) */
export function cardToStored(
  card: TavernCard,
): Omit<StoredCardPayload, 'avatar' | 'last_chat_id'> {
  return {
    name: card.name,
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    first_mes: card.first_mes,
    mes_example: card.mes_example,
    system_prompt: card.system_prompt,
    post_history_instructions: card.post_history_instructions,
    creator_notes: card.creator_notes,
    alternate_greetings: card.alternate_greetings,
    tags: card.tags,
    creator: card.creator,
    character_version: card.character_version,
    character_book: card.character_book as Record<string, unknown> | null,
    extensions: card.extensions,
    spec: card.spec,
  };
}

/** 导出成酒馆能吃的 V2 卡 JSON。avatar 传进来才带上 —— JSON 本身不天然有图,
 *  这样纯 JSON 导出/再导入也能把头像带一圈,不用非得走 PNG。 */
export function cardToFileJson(card: TavernCard, avatar: string | null): string {
  const data = { ...cardToStored(card), avatar };
  return JSON.stringify({ spec: card.spec || 'chara_card_v2', spec_version: '2.0', data }, null, 2);
}

/** 图片 File/Blob → data URL,这样头像能进 JSON 一起 POST(裁剪产出的是 Blob) */
export function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('头像读取失败'));
    reader.readAsDataURL(file);
  });
}
