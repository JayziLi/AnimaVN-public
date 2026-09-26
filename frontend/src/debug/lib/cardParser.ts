/**
 * SillyTavern 角色卡解析(PNG tEXt chunk / 裸 JSON)。
 *
 * 卡有三代规格,字段位置不一样:
 *   V1  — 字段平铺在根对象上
 *   V2  — 根上有 spec:"chara_card_v2",真实字段在 data 里,根上同时留一份镜像
 *   V3  — 同 V2,但 spec:"chara_card_v3",PNG 里额外写一个 ccv3 chunk
 * 我们统一读 data(没有就退回根),这样三代都能吃。
 */

export interface CharacterBookEntry {
  keys: string[];
  content: string;
  enabled: boolean;
  insertion_order: number;
  comment: string;
}

export interface TavernCard {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  /** 卡自带的系统提示词,会覆盖预设的 main(除非该块 forbid_overrides) */
  system_prompt: string;
  /** 卡自带的历史后指令,会覆盖预设的 jailbreak */
  post_history_instructions: string;
  creator_notes: string;
  alternate_greetings: string[];
  tags: string[];
  creator: string;
  character_version: string;
  character_book: { entries: CharacterBookEntry[] } | null;
  extensions: Record<string, unknown>;
  /** 原始 spec 字符串,UI 上标注用 */
  spec: string;
  /** 从哪个 PNG chunk 读出来的,或 "json" */
  sourceChunk: string;
  /**
   * JSON 卡里带的头像 data URL —— 酒馆官方导出的 JSON 通常没有(头像单独在
   * PNG 里),但我们自己导出的 JSON 会带上,这样纯 JSON 也能带头像走一圈。
   * 只在导入那一刻有意义,不入库(cardToStored 不认这个字段)。
   */
  avatar: string | null;
}

export const EMPTY_CARD: TavernCard = {
  name: '',
  description: '',
  personality: '',
  scenario: '',
  first_mes: '',
  mes_example: '',
  system_prompt: '',
  post_history_instructions: '',
  creator_notes: '',
  alternate_greetings: [],
  tags: [],
  creator: '',
  character_version: '',
  character_book: null,
  extensions: {},
  spec: '',
  sourceChunk: '',
  avatar: null,
};

/** PNG 的 tEXt chunk: keyword \0 text,两段都是 latin1。 */
function readPngTextChunks(buf: ArrayBuffer): Map<string, string> {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const out = new Map<string, string>();

  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error('不是合法的 PNG 文件');
  }

  const latin1 = new TextDecoder('latin1');
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const length = view.getUint32(pos);
    const type = latin1.decode(bytes.subarray(pos + 4, pos + 8));
    const dataStart = pos + 8;

    if (type === 'tEXt') {
      const chunk = bytes.subarray(dataStart, dataStart + length);
      const nul = chunk.indexOf(0);
      if (nul !== -1) {
        out.set(
          latin1.decode(chunk.subarray(0, nul)),
          latin1.decode(chunk.subarray(nul + 1)),
        );
      }
    }
    if (type === 'IEND') break;
    pos = dataStart + length + 4; // 4 = CRC
  }
  return out;
}

/** base64 → UTF-8。atob 给的是 latin1 字节串,必须再走一次 UTF-8 解码。 */
function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64.trim());
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 只认真的 data URL —— 酒馆卡的 avatar 字段常年是字面量 "none",别把它当图存进去 */
function asDataUrl(v: unknown): string | null {
  return typeof v === 'string' && v.startsWith('data:image') ? v : null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function normalizeBook(v: unknown): TavernCard['character_book'] {
  if (!v || typeof v !== 'object') return null;
  const entries = (v as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return null;
  return {
    entries: entries.map((e: Record<string, unknown>) => ({
      keys: asStringArray(e.keys),
      content: asString(e.content),
      // 世界书条目默认生效,只有显式 false 才关掉
      enabled: e.enabled !== false,
      insertion_order: typeof e.insertion_order === 'number' ? e.insertion_order : 0,
      comment: asString(e.comment),
    })),
  };
}

function normalizeCard(raw: unknown, sourceChunk: string): TavernCard {
  if (!raw || typeof raw !== 'object') throw new Error('角色卡内容不是一个对象');
  const root = raw as Record<string, unknown>;
  // V2/V3 把真实字段放在 data 下;V1 是平铺的
  const d = (root.data ?? root) as Record<string, unknown>;

  return {
    name: asString(d.name),
    description: asString(d.description),
    personality: asString(d.personality),
    scenario: asString(d.scenario),
    first_mes: asString(d.first_mes),
    mes_example: asString(d.mes_example),
    system_prompt: asString(d.system_prompt),
    post_history_instructions: asString(d.post_history_instructions),
    creator_notes: asString(d.creator_notes) || asString(root.creatorcomment),
    alternate_greetings: asStringArray(d.alternate_greetings),
    tags: asStringArray(d.tags),
    creator: asString(d.creator),
    character_version: asString(d.character_version),
    character_book: normalizeBook(d.character_book),
    extensions:
      d.extensions && typeof d.extensions === 'object'
        ? (d.extensions as Record<string, unknown>)
        : {},
    spec: asString(root.spec) || 'chara_card_v1',
    sourceChunk,
    avatar: asDataUrl(d.avatar),
  };
}

export async function parseCardFile(file: File): Promise<TavernCard> {
  const isPng = file.name.toLowerCase().endsWith('.png') || file.type === 'image/png';

  if (!isPng) {
    return normalizeCard(JSON.parse(await file.text()), 'json');
  }

  const chunks = readPngTextChunks(await file.arrayBuffer());
  // ccv3 优先:同一张卡里 ccv3 是新规格,chara 是向后兼容的镜像
  for (const key of ['ccv3', 'chara']) {
    const payload = chunks.get(key);
    if (payload) return normalizeCard(JSON.parse(decodeBase64Utf8(payload)), key);
  }
  throw new Error(
    `PNG 里没有找到角色卡数据(chara / ccv3 chunk)。读到的 chunk: ${
      [...chunks.keys()].join(', ') || '无'
    }`,
  );
}

/** 把 PNG 本身做成可显示的 URL,用作头像。 */
export function cardImageUrl(file: File): string | null {
  const isPng = file.name.toLowerCase().endsWith('.png') || file.type === 'image/png';
  return isPng ? URL.createObjectURL(file) : null;
}
