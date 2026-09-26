/**
 * SillyTavern Chat Completion 预设解析。
 *
 * 预设是两层结构,别搞混:
 *   prompts[]      — 块库,无序,可能有几十个块躺在里面从来没被用过
 *   prompt_order[] — 实际编排,按 character_id 分组,每项 {identifier, enabled}
 * 只有出现在 prompt_order 里且 enabled 的块才会进入最终请求。
 *
 * 块本身分两类:
 *   marker: true   — 占位符(charDescription / chatHistory / scenario ...),
 *                    没有 content,运行时由宿主填入真实内容
 *   marker: false  — 真实文本块,带 role + content
 */

export type PromptRole = 'system' | 'user' | 'assistant';

export interface PresetPrompt {
  identifier: string;
  name: string;
  role: PromptRole;
  content: string;
  marker: boolean;
  systemPrompt: boolean;
  /** 0 = 相对位置(按 order 排),1 = 绝对深度(插进历史里第 N 条前) */
  injectionPosition: number;
  injectionDepth: number;
  /** 卡自带的 system_prompt / post_history_instructions 能否覆盖这一块 */
  forbidOverrides: boolean;
}

export interface PresetOrderEntry {
  identifier: string;
  enabled: boolean;
}

export interface PresetOrderGroup {
  characterId: number;
  order: PresetOrderEntry[];
}

export interface PresetFormats {
  wi_format: string;
  scenario_format: string;
  personality_format: string;
  group_nudge_prompt: string;
  new_chat_prompt: string;
  new_example_chat_prompt: string;
}

export interface TavernPreset {
  name: string;
  prompts: PresetPrompt[];
  orderGroups: PresetOrderGroup[];
  formats: PresetFormats;
  /** 采样参数,只做展示,不参与组装 */
  params: Record<string, number | string | boolean>;
  /** 是否把相邻的 system 消息合并成一条 */
  squashSystemMessages: boolean;
}

const DEFAULT_FORMATS: PresetFormats = {
  wi_format: '{0}',
  scenario_format: '[Circumstances and context of the dialogue: {{scenario}}]',
  personality_format: "[{{char}}'s personality: {{personality}}]",
  group_nudge_prompt: '[Write the next reply only as {{char}}.]',
  new_chat_prompt: '[Start a new Chat]',
  new_example_chat_prompt: '[Start a new Chat]',
};

/** 这些 marker 是酒馆内置的,组装时要展开成真实内容 */
export const KNOWN_MARKERS = new Set([
  'charDescription',
  'charPersonality',
  'scenario',
  'personaDescription',
  'dialogueExamples',
  'chatHistory',
  'worldInfoBefore',
  'worldInfoAfter',
]);

/** 展示用的中文名 */
export const MARKER_LABELS: Record<string, string> = {
  charDescription: '角色描述',
  charPersonality: '角色性格',
  scenario: '场景',
  personaDescription: '玩家人设',
  dialogueExamples: '示例对话',
  chatHistory: '对话历史',
  worldInfoBefore: '世界书(前)',
  worldInfoAfter: '世界书(后)',
};

const SAMPLING_KEYS = [
  'temperature',
  'top_p',
  'top_k',
  'top_a',
  'min_p',
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'openai_max_context',
  'openai_max_tokens',
  'seed',
];

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asRole(v: unknown): PromptRole {
  return v === 'user' || v === 'assistant' ? v : 'system';
}

export function parsePreset(json: string, fallbackName: string): TavernPreset {
  const raw: unknown = JSON.parse(json);
  if (!raw || typeof raw !== 'object') throw new Error('预设内容不是一个对象');
  const root = raw as Record<string, unknown>;

  if (!Array.isArray(root.prompts)) {
    throw new Error('预设里没有 prompts 数组 —— 这可能是 Text Completion 预设,当前只支持 Chat Completion 预设');
  }

  const prompts: PresetPrompt[] = root.prompts.map((p: Record<string, unknown>) => ({
    identifier: asString(p.identifier),
    name: asString(p.name, '(未命名)'),
    role: asRole(p.role),
    content: asString(p.content),
    marker: p.marker === true,
    systemPrompt: p.system_prompt === true,
    injectionPosition: typeof p.injection_position === 'number' ? p.injection_position : 0,
    injectionDepth: typeof p.injection_depth === 'number' ? p.injection_depth : 4,
    forbidOverrides: p.forbid_overrides === true,
  }));

  const orderGroups: PresetOrderGroup[] = Array.isArray(root.prompt_order)
    ? root.prompt_order.map((g: Record<string, unknown>) => ({
        characterId: typeof g.character_id === 'number' ? g.character_id : 0,
        order: Array.isArray(g.order)
          ? g.order.map((o: Record<string, unknown>) => ({
              identifier: asString(o.identifier),
              enabled: o.enabled !== false,
            }))
          : [],
      }))
    : [];

  const params: Record<string, number | string | boolean> = {};
  for (const key of SAMPLING_KEYS) {
    const v = root[key];
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
      params[key] = v;
    }
  }
  // 模型名单独挑出来,不同 provider 存在不同键里
  for (const key of ['custom_model', 'openai_model', 'claude_model', 'deepseek_model']) {
    const v = root[key];
    if (typeof v === 'string' && v) {
      params[key] = v;
      break;
    }
  }

  return {
    name: fallbackName,
    prompts,
    orderGroups,
    formats: {
      wi_format: asString(root.wi_format, DEFAULT_FORMATS.wi_format),
      scenario_format: asString(root.scenario_format, DEFAULT_FORMATS.scenario_format),
      personality_format: asString(root.personality_format, DEFAULT_FORMATS.personality_format),
      group_nudge_prompt: asString(root.group_nudge_prompt, DEFAULT_FORMATS.group_nudge_prompt),
      new_chat_prompt: asString(root.new_chat_prompt, DEFAULT_FORMATS.new_chat_prompt),
      new_example_chat_prompt: asString(
        root.new_example_chat_prompt,
        DEFAULT_FORMATS.new_example_chat_prompt,
      ),
    },
    params,
    squashSystemMessages: root.squash_system_messages === true,
  };
}

/**
 * 选用哪一组编排。酒馆按当前角色 id 查,查不到退回 100000(default)。
 * 我们没有对应的角色 id,所以默认取「非 default 的最后一组」——
 * 那通常就是作者实际在用的那份,default 往往是没动过的模板。
 */
export function pickDefaultOrderGroup(groups: PresetOrderGroup[]): PresetOrderGroup | null {
  if (groups.length === 0) return null;
  const nonDefault = groups.filter((g) => g.characterId !== 100000);
  return nonDefault.at(-1) ?? groups[0];
}

export function orderGroupLabel(group: PresetOrderGroup): string {
  return group.characterId === 100000
    ? `默认编排 (${group.characterId})`
    : `角色编排 (${group.characterId})`;
}

/**
 * 「新建预设」的骨架 —— 酒馆默认预设的那 10 个标准块,按同一顺序,全部启用。
 *
 * main / jailbreak 故意留空:骨架只是给个能跑的架子,正文让玩家自己写。
 * 空块组装时被记成「块内容为空」跳过,检查器里看得见,不是静默丢失。
 * 全部 systemPrompt: true —— 它们都是内置块,只能关不能删(规则同酒馆)。
 */
export function buildPresetSkeleton(name: string): TavernPreset {
  const text = (identifier: string, blockName: string): PresetPrompt => ({
    identifier,
    name: blockName,
    role: 'system',
    content: '',
    marker: false,
    systemPrompt: true,
    injectionPosition: 0,
    injectionDepth: 4,
    forbidOverrides: false,
  });
  const marker = (identifier: string): PresetPrompt => ({
    ...text(identifier, MARKER_LABELS[identifier] ?? identifier),
    marker: true,
  });

  // 顺序就是酒馆默认预设 prompt_order 的顺序
  const prompts: PresetPrompt[] = [
    text('main', '主提示词'),
    marker('worldInfoBefore'),
    marker('charDescription'),
    marker('charPersonality'),
    marker('scenario'),
    marker('worldInfoAfter'),
    marker('personaDescription'),
    marker('dialogueExamples'),
    marker('chatHistory'),
    text('jailbreak', 'Jailbreak 提示词'),
  ];

  return {
    name,
    prompts,
    orderGroups: [
      {
        characterId: 100000,
        order: prompts.map((p) => ({ identifier: p.identifier, enabled: true })),
      },
    ],
    formats: { ...DEFAULT_FORMATS },
    params: {},
    squashSystemMessages: false,
  };
}
