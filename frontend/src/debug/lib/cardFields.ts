/**
 * 角色卡字段 ↔ 预设块 的对应关系。
 *
 * 这张表回答两个方向的问题:
 *   卡编辑抽屉  —— 「我填的这个字段会落到哪个块、排第几」(正向)
 *   块详情弹窗  —— 「这个 marker 块的内容是从卡的哪个字段来的」(反向)
 * 两处都读这一份,别再各写各的 —— 对不上的时候排查起来很要命。
 *
 * 注意表里有两类:
 *   marker   —— 块本身是空占位符,内容整个由卡的字段填(角色描述、场景…)
 *   override —— 块有自己的正文,卡填了才顶替它(main / jailbreak)
 * 只有 marker 那类适合在块详情弹窗里直接编辑:override 类的块有自己的
 * 预设正文要展示,两份字塞进一个框会分不清在改哪个。
 */

import type { TavernCard } from './cardParser';
import type { TavernPreset } from './presetParser';

export type PromptFieldKey =
  | 'system_prompt'
  | 'description'
  | 'personality'
  | 'scenario'
  | 'mes_example'
  | 'post_history_instructions';

export type FormatKey = keyof TavernPreset['formats'];

export interface PromptFieldDef {
  key: PromptFieldKey;
  label: string;
  /** 落到预设里的哪个块 */
  target: string;
  /** override = 顶替预设块正文;marker = 展开标记位 */
  mode: 'override' | 'marker';
  hint: string;
  /** 会被套进预设的哪个模板 */
  wrap?: FormatKey;
  rows: number;
  /** 预设里找不到这块时的排序兜底 */
  fallback: number;
}

export const PROMPT_FIELDS: PromptFieldDef[] = [
  {
    key: 'system_prompt',
    label: '主提示词覆盖 · System Prompt',
    target: 'main',
    mode: 'override',
    hint: '填了就顶替预设 main 块的正文;留空则用预设原文',
    rows: 5,
    fallback: 0,
  },
  {
    key: 'description',
    label: '角色描述 · Description',
    target: 'charDescription',
    mode: 'marker',
    hint: '角色人设主体。现代卡通常把性格、外貌、行为准则都写在这里',
    rows: 14,
    fallback: 1,
  },
  {
    key: 'personality',
    label: '性格摘要 · Personality',
    target: 'charPersonality',
    mode: 'marker',
    hint: '一句话性格。发出去的不是这段原文,而是套进 personality_format 之后的样子',
    wrap: 'personality_format',
    rows: 4,
    fallback: 2,
  },
  {
    key: 'scenario',
    label: '情景 · Scenario',
    target: 'scenario',
    mode: 'marker',
    hint: '交互发生的情况和背景。同样会被套进 scenario_format',
    wrap: 'scenario_format',
    rows: 4,
    fallback: 3,
  },
  {
    key: 'mes_example',
    label: '对话示例 · Example Dialogue',
    target: 'dialogueExamples',
    mode: 'marker',
    hint: '每段以 <START> 开头,段内用「名字:」分说话人;会被拆成多条消息',
    wrap: 'new_example_chat_prompt',
    rows: 10,
    fallback: 4,
  },
  {
    key: 'post_history_instructions',
    label: '历史后指令 · Post-History',
    target: 'jailbreak',
    mode: 'override',
    hint: '填了就顶替预设 jailbreak 块的正文,位置在聊天历史之后',
    rows: 5,
    fallback: 5,
  },
];

/** 反向查:这个 marker 块的内容由卡的哪个字段填?不是卡填的返回 null */
export function markerCardField(identifier: string): PromptFieldDef | null {
  return (
    PROMPT_FIELDS.find((f) => f.mode === 'marker' && f.target === identifier) ?? null
  );
}

/**
 * 块详情弹窗要展示的「这块的内容从哪儿来」。
 *
 * card     —— 卡的某个字段,能就地改,确定后写回卡
 * elsewhere —— 内容不在卡里(玩家人设 / 对话历史 / 世界书),只指路不给改
 */
export type MarkerSource =
  | {
      kind: 'card';
      def: PromptFieldDef;
      value: string;
      /** 发出去之前会被套进的模板原文,没有就是 null */
      wrapTemplate: string | null;
    }
  | { kind: 'elsewhere'; label: string; hint: string };

/** 内容不在角色卡里的那几个 marker —— 指路文案 */
const ELSEWHERE: Record<string, { label: string; hint: string }> = {
  personaDescription: {
    label: '玩家人设 · Persona',
    hint: '内容来自人设库,不在角色卡里。顶栏的「玩家」按钮打开人设面板去改。',
  },
  chatHistory: {
    label: '对话历史 · Chat History',
    hint: '内容是聊天区里的真实对话,运行时整个铺开。要改就直接改聊天记录。',
  },
  worldInfoBefore: {
    label: '世界书(前) · World Info',
    hint: '内容来自角色卡的世界书条目,是一组条目而不是一段文本,单个输入框装不下。',
  },
  worldInfoAfter: {
    label: '世界书(后) · World Info',
    hint: '内容来自角色卡的世界书条目,是一组条目而不是一段文本,单个输入框装不下。',
  },
};

/**
 * 解析一个 marker 块的内容来源。identifier 不是已知 marker 时返回 null
 * —— 那是预设作者自定义的 marker,酒馆里也是空的。
 */
export function resolveMarkerSource(
  identifier: string,
  card: TavernCard | null,
  preset: TavernPreset | null,
): MarkerSource | null {
  const def = markerCardField(identifier);
  if (def && card) {
    return {
      kind: 'card',
      def,
      value: card[def.key],
      wrapTemplate: def.wrap && preset ? preset.formats[def.wrap] : null,
    };
  }
  const elsewhere = ELSEWHERE[identifier];
  return elsewhere ? { kind: 'elsewhere', ...elsewhere } : null;
}
