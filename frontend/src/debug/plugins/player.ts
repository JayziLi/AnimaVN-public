/**
 * 玩家台词插件 —— 模型替玩家({{user}})写的台词,在视觉小说里弹成 galgame 式的选项。
 *
 * 模型在 {{user}} 说的每一句前面写一个 <我>(半角、全角尖括号都认,里面可以夹空格)。
 * 切句时这句标成 player、说话人换成玩家名字:不念、不切立绘,翻到时弹选项,
 * 选中后以玩家的名义打进对话框(规则在 vn/script.ts 的 parseReply 里)。
 *
 * 标签不叫 <user>:酒馆的老宏 <USER> 会被换成玩家名字,很多卡也用它指代玩家。
 *
 * 插件本身只有提示词模板,全局一份,存在后端 app_settings(键 plugin.player)。
 * 提示词块写进预设,identifier 固定为 anima_player,正文跟着插件模板同步(和立绘插件一样)。
 * 玩家在预设里开关这一块来选:开着弹选项;关着,玩家台词没带立绘标签,照常显示、不念。
 */

import type { PresetOrderEntry, TavernPreset } from '../lib/presetParser';
import type { TagKind } from '../vn/script';
import { insertPluginBlock, pluginBlockState, type BlockState } from './common';

export const PLAYER_SETTING_KEY = 'plugin.player';
export const PLAYER_BLOCK_ID = 'anima_player';

export const DEFAULT_PLAYER_BLOCK_PROMPT = `[玩家台词]
{{user}} 说的每一句话，都必须以 <我> 开头。
<我> 只写在 {{user}} 说的话前面：{{char}} 和其他角色的台词不写，旁白也不写。{{user}} 的话前面不要写立绘标签。
标签单独写，不要放进引号或括号里；要求日中对照时，<我> 和其他标签一样写在这一对（日语 + 中文）的前面。

示例：
<我>「今天就到这里吧，我送你回去。」`;

export interface PlayerPluginConfig {
  /** 「加入当前预设」时写进块里的内容;预设里的这块始终跟着它 */
  blockPrompt: string;
}

export const DEFAULT_PLAYER_CONFIG: PlayerPluginConfig = {
  blockPrompt: DEFAULT_PLAYER_BLOCK_PROMPT,
};

/** 后端存的是任意 JSON —— 缺字段或类型不对的就退回默认值 */
export function normalizePlayerConfig(raw: unknown): PlayerPluginConfig {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    blockPrompt:
      typeof r.blockPrompt === 'string' ? r.blockPrompt : DEFAULT_PLAYER_CONFIG.blockPrompt,
  };
}

export const playerBlockState = (
  preset: TavernPreset | null,
  order: readonly PresetOrderEntry[],
): BlockState => pluginBlockState(preset, order, PLAYER_BLOCK_ID);

/** 把玩家台词块加进预设(插在哪见 insertPluginBlock) */
export const insertPlayerBlock = (preset: TavernPreset, groupIndex: number, content: string) =>
  insertPluginBlock(preset, groupIndex, {
    identifier: PLAYER_BLOCK_ID,
    name: '玩家台词 · 插件',
    content,
  });

/** <我> 标签。模板写死,不给改;带捕获组是因为 extractTags 取 m[1] 当标签名 */
export const playerTagKind = (): TagKind => ({
  kind: 'player',
  pattern: /[<＜]\s*(我)\s*[>＞]/g,
  prefix: '<我',
});
