/**
 * 视觉小说认的几类标签(立绘 / 背景 / 音乐 / 玩家台词的 <我>)。视觉小说界面和它菜单里的
 * 「历史」都要用 —— 历史默认把标签摘掉只给人看正文,打开「显示原文」才露出来。
 */

import { tagPrefixOf } from '../plugins/common';
import { playerTagKind } from '../plugins/player';
import { sceneTagKind } from '../plugins/scene';
import { PLACEHOLDER, tagRegExp } from '../plugins/sprite';
import { extractTags, type TagKind } from './script';

/** 顺序有讲究:位置相同的标签按这个顺序生效,背景要排在音乐前面 */
export function vnTagKinds(spriteTemplate: string, bgTemplate: string, bgmTemplate: string): TagKind[] {
  return [
    {
      kind: 'sprite',
      pattern: tagRegExp(spriteTemplate),
      prefix: tagPrefixOf(spriteTemplate, PLACEHOLDER),
    },
    sceneTagKind('bg', bgTemplate),
    sceneTagKind('bgm', bgmTemplate),
    playerTagKind(),
  ];
}

/** 摘掉标签后的正文;标签单独占一行的,摘完留下的空行也收掉 */
export function stripTags(raw: string, kinds: readonly TagKind[]): string {
  return extractTags(raw, kinds, false)
    .text.replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
