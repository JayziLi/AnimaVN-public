/**
 * 插件共用的零件 —— 立绘、背景、BGM 三个插件是同一个套路,只是占位符和块不同:
 *   标签模板(比如 <sprite:{表情}>)→ 匹配正则 / 给 AI 看的示例
 *   AI 写的名字 → 映射表里的那一行(名字和别名都认)
 *   往预设里插一个插件块、查这块的状态
 */

import type { PresetOrderEntry, PresetPrompt, TavernPreset } from '../lib/presetParser';

/** 名字的长度上限,和后端 LABEL_MAX 一致 */
export const LABEL_MAX = 40;

/** 所有插件块的 identifier。新的插件块插在已有插件块后面,几块挨在一起 */
export const PLUGIN_BLOCK_IDS = [
  'anima_sprite',
  'anima_bg',
  'anima_bgm',
  'anima_lang',
  'anima_player',
] as const;

export interface PluginConfig {
  /** 标签格式,必须恰好包含一个占位符 */
  tagTemplate: string;
  /** 「加入当前预设」时写进块里的内容 */
  blockPrompt: string;
}

/** 模板不合法时返回原因,合法时返回 null */
export function validateTagTemplate(template: string, placeholder: string): string | null {
  const parts = template.split(placeholder);
  if (parts.length !== 2) return `模板里必须有且只有一个 ${placeholder}`;
  const [prefix, suffix] = parts;
  // 前后都得有东西夹着,不然分不出标签从哪开始、到哪结束
  if (!prefix.trim() || !suffix.trim()) {
    return `${placeholder} 的前后都要有固定字符,比如 <tag:${placeholder}>`;
  }
  if (/\n/.test(template)) return '模板不能换行';
  return null;
}

/** 后端存的是任意 JSON —— 缺字段或类型不对的就退回默认值 */
export function normalizePluginConfig(
  raw: unknown,
  defaults: PluginConfig,
  placeholder: string,
): PluginConfig {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const tagTemplate =
    typeof r.tagTemplate === 'string' && validateTagTemplate(r.tagTemplate, placeholder) === null
      ? r.tagTemplate
      : defaults.tagTemplate;
  const blockPrompt = typeof r.blockPrompt === 'string' ? r.blockPrompt : defaults.blockPrompt;
  return { tagTemplate, blockPrompt };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 模板里的冒号放宽匹配:模型常把 <sprite:微笑> 写成 <sprite：微笑>(全角)、
 * <sprite: 微笑>(多空格),甚至 <sprite>微笑>(冒号写成了 >)。认不出来的标签会
 * 原样漏进对话框,所以这几种都当成同一个标签。
 */
const tolerant = (part: string) => escapeRe(part).replace(/[:：]/g, '\\s*[:：>]\\s*');

/**
 * 模板 → 匹配标签的正则(带 g 标志,每次调用都新建一个 —— 带 g 的正则有
 * lastIndex 状态,多处共用同一个实例会互相干扰)。模板不合法时返回 null。
 */
export function buildTagRegExp(template: string, placeholder: string): RegExp | null {
  if (validateTagTemplate(template, placeholder) !== null) return null;
  const [prefix, suffix] = template.split(placeholder);
  return new RegExp(`${tolerant(prefix)}([^\\n]{1,${LABEL_MAX}}?)${tolerant(suffix)}`, 'g');
}

/** 展示给 AI 看的样子:占位符换成一个说明词,比如 <sprite:表情名> */
export function tagExampleOf(template: string, placeholder: string, word: string): string {
  return template.replace(placeholder, word);
}

/** 模板里占位符前面那段,用来识别流式输出时写了一半的标签 */
export function tagPrefixOf(template: string, placeholder: string): string {
  return template.split(placeholder)[0] ?? '';
}

/** 映射表的一行:AI 用名字或别名点它 */
export interface Labeled {
  label: string;
  aliases: string[];
}

/** AI 写的名字 → 映射表里的那一行。名字和别名都认,不区分大小写,忽略两端空白 */
export function resolveByLabel<T extends Labeled>(label: string, items: readonly T[]): T | null {
  const key = label.trim().toLowerCase();
  if (!key) return null;
  return (
    items.find(
      (s) => s.label.toLowerCase() === key || s.aliases.some((a) => a.toLowerCase() === key),
    ) ?? null
  );
}

/**
 * 游戏里用的素材:禁用的当作不存在(不进提示词、不认标签、不显示)。只在插件抽屉里
 * 看得到禁用的那些,好重新打开。每次返回新数组,放进依赖列表之前先 useMemo
 */
export const enabledOnly = <T extends { enabled: boolean }>(items: readonly T[]): T[] =>
  items.filter((x) => x.enabled);

// ---- 预设里的插件块 ----

export type BlockState = 'no-preset' | 'missing' | 'off' | 'on';

export function pluginBlockState(
  preset: TavernPreset | null,
  order: readonly PresetOrderEntry[],
  identifier: string,
): BlockState {
  if (!preset) return 'no-preset';
  const inLibrary = preset.prompts.some((p) => p.identifier === identifier);
  const entry = order.find((o) => o.identifier === identifier);
  if (!inLibrary || !entry) return 'missing';
  return entry.enabled ? 'on' : 'off';
}

export interface PluginBlock {
  identifier: string;
  name: string;
  content: string;
}

/**
 * 把插件块加进预设:块库里没有就新建;当前编排里没有就插进去并开启。
 *
 * 插在哪:
 *   1. 编排里已经有别的插件块 —— 插在最后一个插件块后面,几块挨在一起好管理
 *   2. 否则插在 chatHistory 后面:格式要求离模型要写的回复越近越管用。插在历史后面、
 *      而不是整个编排的最末尾,是为了让预设原本的「历史后指令」(比如 jailbreak)
 *      仍然排在最后,末尾的 assistant 预填充块也不会被隔开。
 *      不少中文预设用一对 <history> / </history> 块把历史包起来 —— 紧跟在历史后面的
 *      收尾标签块要跳过去,不然插件指令会被包进「历史」里
 *   3. 编排里没有 chatHistory 时追加到末尾
 */
export function insertPluginBlock(
  preset: TavernPreset,
  groupIndex: number,
  block: PluginBlock,
): TavernPreset {
  const prompts = preset.prompts.some((p) => p.identifier === block.identifier)
    ? preset.prompts
    : [
        ...preset.prompts,
        {
          identifier: block.identifier,
          name: block.name,
          role: 'system',
          content: block.content,
          marker: false,
          systemPrompt: false,
          injectionPosition: 0,
          injectionDepth: 4,
          forbidOverrides: false,
        } satisfies PresetPrompt,
      ];

  const groups =
    preset.orderGroups.length > 0 ? preset.orderGroups : [{ characterId: 100000, order: [] }];
  const target = groups[groupIndex] ? groupIndex : 0;
  const siblings = new Set<string>(PLUGIN_BLOCK_IDS);

  return {
    ...preset,
    prompts,
    orderGroups: groups.map((g, i) => {
      if (i !== target || g.order.some((o) => o.identifier === block.identifier)) return g;
      let at = -1;
      g.order.forEach((o, j) => {
        if (siblings.has(o.identifier)) at = j;
      });
      if (at === -1) {
        at = g.order.findIndex((o) => o.identifier === 'chatHistory');
        if (at !== -1) {
          while (at + 1 < g.order.length && isClosingTag(prompts, g.order[at + 1].identifier)) at++;
        }
      }
      const order = [...g.order];
      order.splice(at === -1 ? order.length : at + 1, 0, {
        identifier: block.identifier,
        enabled: true,
      });
      return { ...g, order };
    }),
  };
}

export const isPluginBlock = (identifier: string) =>
  (PLUGIN_BLOCK_IDS as readonly string[]).includes(identifier);

/**
 * 插件块的正文只认插件里的提示词模板,预设里存的那份只是副本:读预设时一律换成
 * 模板(identifier → 模板正文)。这样改一处模板,所有预设里的这块都跟着变,
 * 不会出现「插件里改了、预设里还是旧的」。
 * 没有要换的就原样返回同一个对象,不引起多余的重算。
 */
export function syncPluginBlocks(
  preset: TavernPreset | null,
  templates: Readonly<Record<string, string>>,
): TavernPreset | null {
  if (!preset) return preset;
  const stale = preset.prompts.some(
    (p) => p.identifier in templates && p.content !== templates[p.identifier],
  );
  if (!stale) return preset;
  return {
    ...preset,
    prompts: preset.prompts.map((p) =>
      p.identifier in templates ? { ...p, content: templates[p.identifier] } : p,
    ),
  };
}

/** 名字或内容以 </xxx> 开头的块 —— 预设里用来闭合包裹标签的那种 */
function isClosingTag(prompts: readonly PresetPrompt[], identifier: string): boolean {
  const p = prompts.find((x) => x.identifier === identifier);
  if (!p || p.marker) return false;
  return /^<\/[^>\s]+>/.test(p.name.trim()) || /^<\/[^>\s]+>/.test(p.content.trim());
}
