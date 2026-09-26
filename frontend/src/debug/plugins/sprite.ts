/**
 * 立绘插件 —— 让 AI 在正文里用标签标出表情,视觉小说界面按标签切换立绘。
 *
 * 三样东西,分别存在三个地方:
 *   标签格式 + 提示词模板   全局一份,存在后端 app_settings(键 plugin.sprite),
 *                            手机和电脑读的是同一份
 *   提示词块                写进预设,identifier 固定为 anima_sprite;和普通块一样
 *                            可以开关、拖动位置、改写内容。插件只新增这一块,
 *                            预设里原有的块一个字都不动
 *   表情 → 图的映射          每张卡一套,存在后端 card_sprites
 *
 * 块的内容通过 {{sprites}} / {{sprite_tag}} / {{sprite_examples}} 几个宏引用映射表和标签格式,
 * 所以换卡、改格式之后都不用回头改块。
 *
 * AI 在 {{char}} 的每句台词前都写一个标签(照 LingChat 的做法);对不上立绘名的交给
 * 后端模型挑列表里最像的,见 plugins/emotionMatch.ts 和
 * docs/superpowers/specs/2026-09-25-sprite-emotion-matching-design.md
 */

import type { CardSprite } from '../lib/api';
import type { PresetOrderEntry, TavernPreset } from '../lib/presetParser';
import {
  buildTagRegExp,
  insertPluginBlock,
  normalizePluginConfig,
  pluginBlockState,
  resolveByLabel,
  tagExampleOf,
  validateTagTemplate,
  type BlockState,
  type PluginConfig,
} from './common';
import { BUILTIN_EMOTIONS } from './emotions';

export const SPRITE_BLOCK_ID = 'anima_sprite';
export const SPRITE_SETTING_KEY = 'plugin.sprite';
/** 标签模板里代表表情名的占位符 */
export const PLACEHOLDER = '{表情}';

export type SpritePluginConfig = PluginConfig;
export type SpriteBlockState = BlockState;

export const DEFAULT_BLOCK_PROMPT = `[立绘指令]
{{char}} 说的每一句话，都必须以 {{sprite_tag}} 开头，用来形容 {{char}} 说这句话时的心情。
从下面这些表情里选一个，作为每句话开头的表情：
{{sprites}}

表情务必简短，2~5 个字，比如「慌张」「难为情」。列表里实在没有合适的，也可以写一个别的情绪词。
绝对不要在标签里写动作或主语！只允许写表情。
旁白和其他角色说的话前面不用写。标签单独写，不要放进引号或括号里，也不要解释它。

{{sprite_examples}}`;

/** 以前的默认模板。存着的模板和它们一字不差 = 用户没改过,读取时换成新版 */
const OLD_DEFAULT_BLOCK_PROMPTS = [
  `[立绘指令]
{{char}} 有这些立绘表情可以用：
{{sprites}}

写回复时，在 {{char}} 表情发生变化的那一句前面插入 {{sprite_tag}}，把「表情名」换成上面列表里的一个名字，一字不差。
- 每条回复的第一句前必须写一次，交代 {{char}} 此刻的表情
- 表情没变就不要重复写
- 标签单独写，不要放进引号或括号里，也不要解释它`,
];

export const DEFAULT_SPRITE_CONFIG: SpritePluginConfig = {
  tagTemplate: '<sprite:{表情}>',
  blockPrompt: DEFAULT_BLOCK_PROMPT,
};

export function normalizeSpriteConfig(raw: unknown): SpritePluginConfig {
  const config = normalizePluginConfig(raw, DEFAULT_SPRITE_CONFIG, PLACEHOLDER);
  return OLD_DEFAULT_BLOCK_PROMPTS.includes(config.blockPrompt)
    ? { ...config, blockPrompt: DEFAULT_BLOCK_PROMPT }
    : config;
}

export const validateTemplate = (template: string) => validateTagTemplate(template, PLACEHOLDER);

export const tagRegExp = (template: string) => buildTagRegExp(template, PLACEHOLDER);

/** 展示给 AI 看的样子:<sprite:表情名> */
export const tagExample = (template: string) => tagExampleOf(template, PLACEHOLDER, '表情名');

export const resolveSprite = (label: string, sprites: readonly CardSprite[]) =>
  resolveByLabel(label, sprites);

/** {{sprite_examples}}:照 LingChat 的正误示范,标签按当前格式写 */
function spriteExamples(template: string): string {
  const tag = (word: string) => tagExampleOf(template, PLACEHOLDER, word);
  return [
    '正确的示范：',
    `${tag('高兴')}「今天要不要一起吃蛋糕呀？」`,
    `${tag('无语')}「只是今天天气有点不好呢。」`,
    '她后退了两步。',
    `${tag('慌张')}「被那种东西碰到的话，感觉浑身都不干净啦！」`,
    '错误的示范：',
    `${tag('我高兴地走过来')}「今天要不要一起吃蛋糕呀？」`,
    '错误原因：标签里不能写动作或主语，必须简短。',
  ].join('\n');
}

/** 插件提供的宏,并入自定义宏的查找表(键是小写宏名) */
export function spriteMacros(
  config: SpritePluginConfig,
  sprites: readonly CardSprite[],
): Record<string, string> {
  // 一张立绘都没配:给内置基础表情,照样每句写、照样匹配(语音靠它带语气)
  const list =
    sprites.length === 0
      ? BUILTIN_EMOTIONS.map((e) => `- ${e.label}`).join('\n')
      : sprites
          .map((s) => (s.description.trim() ? `- ${s.label}：${s.description.trim()}` : `- ${s.label}`))
          .join('\n');
  return {
    sprites: list,
    sprite_tag: tagExample(config.tagTemplate),
    sprite_examples: spriteExamples(config.tagTemplate),
  };
}

export const spriteBlockState = (preset: TavernPreset | null, order: readonly PresetOrderEntry[]) =>
  pluginBlockState(preset, order, SPRITE_BLOCK_ID);

/** 把立绘块加进预设(插在哪见 insertPluginBlock) */
export const insertSpriteBlock = (preset: TavernPreset, groupIndex: number, content: string) =>
  insertPluginBlock(preset, groupIndex, {
    identifier: SPRITE_BLOCK_ID,
    name: '立绘指令 · 插件',
    content,
  });
