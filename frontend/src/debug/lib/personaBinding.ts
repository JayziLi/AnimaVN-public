/**
 * 人设绑角色卡 —— 对应酒馆的「锁定人设到角色」和「默认人设」。
 *
 * 人设本身是全局的,同一时刻只启用一个。绑定只管「选中一张卡时自动切到哪个」:
 * 这张卡绑了人设就切到它;没绑就切回默认人设;两样都没设(或者绑的人设已经删了)就不动。
 * 全局一份,存在后端 app_settings(键 persona.bindings)。
 */

export const PERSONA_BINDING_KEY = 'persona.bindings';

export interface PersonaBindings {
  /** 没绑人设的卡用它;null = 不自动切 */
  default: string | null;
  /** 角色卡 id → 人设 id */
  cards: Record<string, string>;
}

export const EMPTY_BINDINGS: PersonaBindings = { default: null, cards: {} };

/** 后端存的是任意 JSON —— 缺字段或类型不对的丢掉 */
export function normalizeBindings(raw: unknown): PersonaBindings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    default: typeof r.default === 'string' && r.default ? r.default : null,
    cards: cardMapOf(r.cards),
  };
}

/** 选中这张卡时该用哪个人设,以及是绑的还是默认的;null = 不动 */
export function personaForCard(
  b: PersonaBindings,
  cardId: string,
  personaIds: readonly string[],
): { id: string; bound: boolean } | null {
  const bound = b.cards[cardId];
  if (bound && personaIds.includes(bound)) return { id: bound, bound: true };
  if (b.default && personaIds.includes(b.default)) return { id: b.default, bound: false };
  return null;
}

/** 把这张卡绑到某个人设(预设绑定也用它);id 为 null 是解绑 */
export function bindCard<T extends { cards: Record<string, string> }>(
  b: T,
  cardId: string,
  id: string | null,
): T {
  const cards = { ...b.cards };
  if (id) cards[cardId] = id;
  else delete cards[cardId];
  return { ...b, cards };
}

/** 角色卡 id → 绑定的 id 这张表:后端存的是任意 JSON,不是字符串的丢掉 */
export function cardMapOf(raw: unknown): Record<string, string> {
  const cards: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string' && v) cards[k] = v;
    }
  }
  return cards;
}

/** 人设删了:指向它的绑定和默认都清掉 */
export function forgetPersona(b: PersonaBindings, personaId: string): PersonaBindings {
  const cards = Object.fromEntries(Object.entries(b.cards).filter(([, p]) => p !== personaId));
  return { default: b.default === personaId ? null : b.default, cards };
}
