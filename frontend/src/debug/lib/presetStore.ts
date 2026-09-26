/**
 * 预设在两种形态之间转换:
 *   TavernPreset  —— 组装器吃的形态(prompts 已规范化,orderGroups 是分好组的)
 *   StoredPreset  —— 后端存的形态(和酒馆预设 JSON 一一对应)
 *
 * 分开是有意的:后端原样存酒馆结构,所以预设能原封不动地进出;
 * 解析/规范化只发生在前端,和导入文件走同一条路。
 */

import type { StoredPreset, StoredPresetPayload } from './api';
import {
  parsePreset,
  type PresetOrderEntry,
  type TavernPreset,
} from './presetParser';

/** DB 行 → 组装器形态。复用 parsePreset,保证和「导入文件」走同一套规范化。 */
export function presetFromStored(row: StoredPreset): TavernPreset {
  return parsePreset(
    JSON.stringify({
      prompts: row.prompts,
      prompt_order: row.prompt_order,
      ...row.formats,
      ...row.params,
      squash_system_messages: row.squash_system_messages,
    }),
    row.name,
  );
}

/**
 * 组装器形态 → DB 行。
 *
 * `order` 是左栏当前的开关状态(含用户的临时改动),保存时要合并回去 ——
 * 这正是「显式保存」的落点:改开关只动内存,点保存才把它写进 prompt_order。
 */
export function presetToStored(
  preset: TavernPreset,
  activeGroupIndex: number,
  order: PresetOrderEntry[],
): StoredPresetPayload {
  const prompt_order = preset.orderGroups.map((group, i) =>
    i === activeGroupIndex
      ? {
          character_id: group.characterId,
          order: order.map((o) => ({ identifier: o.identifier, enabled: o.enabled })),
        }
      : {
          character_id: group.characterId,
          order: group.order.map((o) => ({
            identifier: o.identifier,
            enabled: o.enabled,
          })),
        },
  );

  return {
    name: preset.name,
    prompts: preset.prompts.map((p) => ({
      identifier: p.identifier,
      name: p.name,
      role: p.role,
      content: p.content,
      marker: p.marker,
      system_prompt: p.systemPrompt,
      injection_position: p.injectionPosition,
      injection_depth: p.injectionDepth,
      forbid_overrides: p.forbidOverrides,
    })),
    prompt_order,
    formats: { ...preset.formats },
    params: { ...preset.params },
    squash_system_messages: preset.squashSystemMessages,
  };
}

/** 导出成文件时用的形态 —— 摊平成酒馆预设 JSON 的样子 */
export function presetToFileJson(payload: StoredPresetPayload): string {
  const { formats, params, ...rest } = payload;
  return JSON.stringify({ ...rest, ...formats, ...params }, null, 2);
}
