/**
 * 背景插件 + BGM 插件 —— AI 在正文里写 <bg:食堂>、<bgm:日常>,视觉小说界面换背景、换音乐。
 *
 * 和立绘插件同一个套路(见 sprite.ts),区别在两处:
 *   素材放在「场景包」里,卡绑定一个包;多张卡可以绑同一个(同一个世界观共用素材)
 *   背景和音乐是「状态」:只在变化时写,没写就沿用。块里用 {{current_bg}} /
 *   {{current_bgm}} 告诉 AI 现在在哪、在放什么
 *
 * BGM 的规则是「场景默认 + AI 覆盖」:每个背景可以指定一首默认曲,换场景时音乐
 * 跟着换;同一个场景里气氛变了,AI 再写 BGM 标签。关掉 BGM 块,就退化成音乐只跟着
 * 场景走。
 */

import type { SceneAsset } from '../lib/api';
import type { PresetOrderEntry, TavernPreset } from '../lib/presetParser';
import type { ChatEntry } from '../lib/chatEntry';
import { currentText } from '../lib/chatEntry';
import { extractTags, type TagKind } from '../vn/script';
import {
  buildTagRegExp,
  insertPluginBlock,
  normalizePluginConfig,
  pluginBlockState,
  resolveByLabel,
  tagExampleOf,
  tagPrefixOf,
  validateTagTemplate,
  type PluginConfig,
} from './common';

export type SceneKindKey = 'bg' | 'bgm';

interface SceneSpec {
  blockId: string;
  blockName: string;
  settingKey: string;
  placeholder: string;
  /** {{bg_tag}} 展开时占位符换成的词 */
  exampleWord: string;
  defaults: PluginConfig;
}

export const DEFAULT_BG_PROMPT = `[场景指令]
可以用的场景（背景图）：
{{backgrounds}}
当前场景：{{current_bg}}

剧情换到另一个地点时，在换场景的那一句前面插入 {{bg_tag}}，把「场景名」换成上面列表里的一个名字，一字不差。
- 场景没变就不要写
- 列表里没有完全对应的地点时，选最接近的一个
- 标签单独写，不要放进引号或括号里，也不要解释它`;

export const DEFAULT_BGM_PROMPT = `[音乐指令]
可以用的背景音乐（按气氛分）：
{{bgms}}
当前音乐：{{current_bgm}}

换场景时，音乐会自动换成那个场景的默认曲，不用写。只有在同一个场景里气氛明显转变时（比如闲聊转为紧张、热闹转为伤感），才在转变的那一句前面插入 {{bgm_tag}}，把「音乐名」换成上面列表里的一个名字，一字不差。
- 气氛没有明显变化就不要写，不要频繁换
- 标签单独写，不要放进引号或括号里，也不要解释它`;

export const SCENE: Record<SceneKindKey, SceneSpec> = {
  bg: {
    blockId: 'anima_bg',
    blockName: '场景指令 · 插件',
    settingKey: 'plugin.bg',
    placeholder: '{场景}',
    exampleWord: '场景名',
    defaults: { tagTemplate: '<bg:{场景}>', blockPrompt: DEFAULT_BG_PROMPT },
  },
  bgm: {
    blockId: 'anima_bgm',
    blockName: '音乐指令 · 插件',
    settingKey: 'plugin.bgm',
    placeholder: '{音乐}',
    exampleWord: '音乐名',
    defaults: { tagTemplate: '<bgm:{音乐}>', blockPrompt: DEFAULT_BGM_PROMPT },
  },
};

export const normalizeSceneConfig = (kind: SceneKindKey, raw: unknown) =>
  normalizePluginConfig(raw, SCENE[kind].defaults, SCENE[kind].placeholder);

export const validateSceneTemplate = (kind: SceneKindKey, template: string) =>
  validateTagTemplate(template, SCENE[kind].placeholder);

export const sceneTagExample = (kind: SceneKindKey, template: string) =>
  tagExampleOf(template, SCENE[kind].placeholder, SCENE[kind].exampleWord);

/** 给解析器用的一类标签 */
export function sceneTagKind(kind: SceneKindKey, template: string): TagKind {
  const { placeholder } = SCENE[kind];
  return {
    kind,
    pattern: buildTagRegExp(template, placeholder),
    prefix: tagPrefixOf(template, placeholder),
  };
}

export const sceneBlockState = (
  kind: SceneKindKey,
  preset: TavernPreset | null,
  order: readonly PresetOrderEntry[],
) => pluginBlockState(preset, order, SCENE[kind].blockId);

export const insertSceneBlock = (
  kind: SceneKindKey,
  preset: TavernPreset,
  groupIndex: number,
  content: string,
) =>
  insertPluginBlock(preset, groupIndex, {
    identifier: SCENE[kind].blockId,
    name: SCENE[kind].blockName,
    content,
  });

// ---- 状态:现在是哪个场景、在放哪首 ----

export interface SceneState {
  bg: SceneAsset | null;
  bgm: SceneAsset | null;
  /** 音乐是怎么来的 —— 控制台里显示 */
  bgmFrom: 'initial' | 'scene' | 'tag' | null;
}

export const backgroundsOf = (assets: readonly SceneAsset[]) => assets.filter((a) => a.kind === 'bg');
export const bgmsOf = (assets: readonly SceneAsset[]) => assets.filter((a) => a.kind === 'bgm');

/** 对话开头的状态:排第一的背景,以及它的默认曲 */
export function initialScene(assets: readonly SceneAsset[]): SceneState {
  const bg = backgroundsOf(assets)[0] ?? null;
  const bgm = bg?.bgm_id ? (assets.find((a) => a.id === bg.bgm_id) ?? null) : null;
  return { bg, bgm, bgmFrom: bgm ? 'initial' : null };
}

/**
 * 应用一个标签。对不上名字的标签不改状态(控制台里会标红)。
 * 换到一个「不同的」场景时,如果它有默认曲就换上;重复写同一个场景不会把
 * AI 刚点的曲子冲掉。
 */
export function applySceneTag(
  state: SceneState,
  tag: { kind: string; label: string },
  assets: readonly SceneAsset[],
): SceneState {
  if (tag.kind === 'bg') {
    const bg = resolveByLabel(tag.label, backgroundsOf(assets));
    if (!bg || bg.id === state.bg?.id) return state;
    const def = bg.bgm_id ? (assets.find((a) => a.id === bg.bgm_id) ?? null) : null;
    return def ? { bg, bgm: def, bgmFrom: 'scene' } : { ...state, bg };
  }
  if (tag.kind === 'bgm') {
    const bgm = resolveByLabel(tag.label, bgmsOf(assets));
    return bgm ? { ...state, bgm, bgmFrom: 'tag' } : state;
  }
  return state;
}

/**
 * 整段对话末尾的状态 —— 组装提示词时 {{current_bg}} / {{current_bgm}} 用它。
 * 只摘标签、不切句:句子边界不影响标签的先后顺序。
 */
export function sceneAtEnd(
  entries: readonly ChatEntry[],
  kinds: readonly TagKind[],
  assets: readonly SceneAsset[],
): SceneState {
  let state = initialScene(assets);
  if (assets.length === 0) return state;
  for (const e of entries) {
    if (e.role !== 'assistant') continue;
    for (const t of extractTags(currentText(e), kinds, false).tags) {
      state = applySceneTag(state, t, assets);
    }
  }
  return state;
}

/** 插件提供的宏,并入自定义宏的查找表 */
export function sceneMacros(
  configs: Record<SceneKindKey, PluginConfig>,
  bound: boolean,
  assets: readonly SceneAsset[],
  state: SceneState,
): Record<string, string> {
  const nameOf = (id: string | null) => assets.find((a) => a.id === id)?.label;
  const line = (a: SceneAsset, extra?: string) => {
    const desc = a.description.trim();
    const tail = [desc, extra].filter(Boolean).join('；');
    return tail ? `- ${a.label}：${tail}` : `- ${a.label}`;
  };
  const none = bound ? '(场景包里还没有素材)' : '(这张卡还没有绑定场景包)';
  const bgs = backgroundsOf(assets);
  const bgms = bgmsOf(assets);
  return {
    backgrounds: bgs.length
      ? bgs.map((a) => line(a, a.bgm_id && nameOf(a.bgm_id) ? `默认音乐：${nameOf(a.bgm_id)}` : '')).join('\n')
      : none,
    bg_tag: sceneTagExample('bg', configs.bg.tagTemplate),
    current_bg: state.bg?.label ?? '(还没有场景)',
    bgms: bgms.length ? bgms.map((a) => line(a)).join('\n') : none,
    bgm_tag: sceneTagExample('bgm', configs.bgm.tagTemplate),
    current_bgm: state.bgm?.label ?? '(没有音乐)',
  };
}
