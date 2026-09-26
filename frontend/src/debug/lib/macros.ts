/**
 * 酒馆的宏替换。大小写不敏感,可以嵌套一层(比如 personality_format 里
 * 套了 {{char}} 又套 {{personality}})。
 */

export interface MacroContext {
  char: string;
  user: string;
  persona: string;
  description: string;
  personality: string;
  scenario: string;
  lastUserMessage: string;
  lastCharMessage: string;
  /** 用户自定义的宏,键是小写宏名。内置宏优先,这里覆盖不了 {{char}} 之类 */
  custom: Record<string, string>;
}

export const EMPTY_MACRO_CONTEXT: MacroContext = {
  char: '',
  user: '',
  persona: '',
  description: '',
  personality: '',
  scenario: '',
  lastUserMessage: '',
  lastCharMessage: '',
  custom: {},
};

/** 组装提示词和聊天区显示共用同一份取值 —— 两边算出不同的 {{user}} 是最难查的那种 bug */
export function buildMacroContext(input: {
  card: {
    name: string;
    description: string;
    personality: string;
    scenario: string;
  } | null;
  userName: string;
  personaDescription: string;
  history: readonly { role: 'user' | 'assistant'; content: string }[];
  /** 自定义宏的查找表(见 lib/customMacros 的 toLookup) */
  custom?: Record<string, string>;
}): MacroContext {
  const { card, userName, personaDescription, history, custom } = input;
  const last = (role: 'user' | 'assistant') =>
    [...history].reverse().find((h) => h.role === role)?.content ?? '';
  return {
    char: card?.name || 'Character',
    user: userName || 'User',
    persona: personaDescription,
    description: card?.description ?? '',
    personality: card?.personality ?? '',
    scenario: card?.scenario ?? '',
    lastUserMessage: last('user'),
    lastCharMessage: last('assistant'),
    custom: custom ?? {},
  };
}

export interface MacroOptions {
  /**
   * 给随机类宏(`{{random}}` / `{{roll}}`)定种子。
   *
   * 聊天区是每次 React 重渲染都跑一遍替换的,不定种子的话你在输入框里敲个字,
   * 上面开场白里的骰子就换个点数。传消息 id 进来,同一条消息永远掷出同一个数。
   * 思路照搬酒馆的 `{{pick}}`(macros.js:516 —— chatIdHash + contentHash + offset)。
   *
   * 不传 = 真随机,组装提示词走的是这条:每次发送本来就该重掷。
   */
  seed?: string;
}

/**
 * 内置宏总表 —— 解析和「设置 › 宏」那张说明表读的是同一份,
 * 加宏只需要往这里加一行,不会出现「实现支持了但界面没写」的漂移。
 */
export interface MacroInfo {
  /** 小写宏名,也是查找键 */
  key: string;
  /** 界面上怎么写它 */
  syntax: string;
  note: string;
  /** 同一个宏的别名 */
  alias?: string[];
  /** 当前会展开成什么 */
  value: (ctx: MacroContext) => string;
  /** 每次求值都可能不同(骰子、时间)—— 表里标一下,免得以为是固定映射 */
  dynamic?: boolean;
}

export const BUILTIN_MACROS: MacroInfo[] = [
  { key: 'char', syntax: '{{char}}', note: '角色卡的名字', alias: ['bot'], value: (c) => c.char },
  { key: 'user', syntax: '{{user}}', note: '当前激活人设的名字', value: (c) => c.user },
  { key: 'persona', syntax: '{{persona}}', note: '当前激活人设的描述', value: (c) => c.persona },
  { key: 'description', syntax: '{{description}}', note: '角色描述', value: (c) => c.description },
  {
    key: 'personality',
    syntax: '{{personality}}',
    note: '角色性格',
    value: (c) => c.personality,
  },
  { key: 'scenario', syntax: '{{scenario}}', note: '场景', value: (c) => c.scenario },
  {
    key: 'lastusermessage',
    syntax: '{{lastUserMessage}}',
    note: '最后一条玩家消息',
    value: (c) => c.lastUserMessage,
  },
  {
    key: 'lastcharmessage',
    syntax: '{{lastCharMessage}}',
    note: '最后一条角色消息',
    value: (c) => c.lastCharMessage,
  },
  { key: 'newline', syntax: '{{newline}}', note: '一个换行符', value: () => '\n' },
  {
    key: 'original',
    // 只在「卡覆盖预设块」的场景里有值,组装时我们不走覆盖,所以恒为空
    syntax: '{{original}}',
    note: '被覆盖掉的预设原文 —— 本工具不走覆盖,恒为空',
    value: () => '',
  },
  {
    key: 'random',
    syntax: '{{random:红,绿,蓝}}',
    note: '逗号分隔,随机挑一个',
    dynamic: true,
    value: () => '每次求值都不同',
  },
  {
    key: 'roll',
    syntax: '{{roll:d20}}',
    note: '掷一个 N 面骰',
    dynamic: true,
    value: () => '每次求值都不同',
  },
  {
    key: 'time',
    syntax: '{{time}}',
    note: '当前时间',
    dynamic: true,
    value: () => new Date().toLocaleTimeString('zh-CN'),
  },
  {
    key: 'date',
    syntax: '{{date}}',
    note: '当前日期',
    dynamic: true,
    value: () => new Date().toLocaleDateString('zh-CN'),
  },
];

/** 自定义宏不许占用这些名字 —— 内置的优先,占了也不会生效,不如提前拦住 */
export const RESERVED_MACRO_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_MACROS.flatMap((m) => [m.key, ...(m.alias ?? [])]),
);

/** 简单替换:宏名 → 取值函数(含别名) */
const SIMPLE: Record<string, (ctx: MacroContext) => string> = Object.fromEntries(
  BUILTIN_MACROS.filter((m) => !m.dynamic).flatMap((m) =>
    [m.key, ...(m.alias ?? [])].map((k) => [k, m.value] as const),
  ),
);

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** mulberry32。不求分布多漂亮,只求「同一条消息每次渲染掷出同一个数」 */
function seededRandom(seed: string): () => number {
  let a = hash32(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function resolveOne(
  name: string,
  arg: string,
  ctx: MacroContext,
  rand: () => number,
): string | null {
  const key = name.toLowerCase();

  const simple = SIMPLE[key];
  if (simple) return simple(ctx);

  if (key === 'random') {
    const options = arg.split(',').map((s) => s.trim()).filter(Boolean);
    return options.length ? options[Math.floor(rand() * options.length)] : '';
  }
  if (key === 'roll') {
    const sides = Number.parseInt(arg.replace(/^d/i, ''), 10);
    return Number.isFinite(sides) && sides > 0 ? String(Math.floor(rand() * sides) + 1) : '';
  }
  if (key === 'time') return new Date().toLocaleTimeString('zh-CN');
  if (key === 'date') return new Date().toLocaleDateString('zh-CN');

  // 自定义宏排在内置之后:占不到 {{char}} 这种名字,也就不会把角色名改没了
  const own = ctx.custom[key];
  if (own !== undefined) return own;

  return null; // 不认识的宏原样留着,方便在调试台里看见
}

const MACRO_RE = /\{\{([^{}:]+?)(?::([^{}]*))?\}\}/g;

export function substituteMacros(
  text: string,
  ctx: MacroContext,
  opts: MacroOptions = {},
  depth = 2,
): string {
  if (!text) return '';
  let out = text.replace(
    MACRO_RE,
    (whole: string, name: string, arg: string | undefined, offset: number) => {
      // 位置也进种子:同一条消息里的两个 {{roll:d6}} 该是两个独立的骰子
      const rand =
        opts.seed === undefined ? Math.random : seededRandom(`${opts.seed}:${offset}:${whole}`);
      const resolved = resolveOne(name.trim(), arg ?? '', ctx, rand);
      return resolved === null ? whole : resolved;
    },
  );
  // 展开出来的内容里可能还有宏(格式模板套字段的情况)
  if (depth > 0 && MACRO_RE.test(out)) {
    MACRO_RE.lastIndex = 0;
    out = substituteMacros(out, ctx, opts, depth - 1);
  }
  MACRO_RE.lastIndex = 0;
  return out;
}

/** 找出文本里所有没被解析掉的宏,调试台上标黄提示 */
export function findUnresolvedMacros(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(MACRO_RE)) found.add(m[0]);
  return [...found];
}
