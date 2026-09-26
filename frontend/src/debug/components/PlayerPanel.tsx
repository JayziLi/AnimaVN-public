import type { ReactNode } from 'react';
import { DEFAULT_PLAYER_BLOCK_PROMPT, type PlayerPluginConfig } from '../plugins/player';

/**
 * 插件抽屉的「玩家台词」页:模型替玩家写的台词,在视觉小说里弹成选项。
 *
 * 模型在玩家说的每一句前面写 <我>,视觉小说翻到这句先弹选项,选中了才以玩家的名义
 * 打进对话框(规则见 plugins/player.ts)。这个插件只有提示词模板,没有标签格式、没有素材表。
 * 「提示词块」那一组和其他插件共用,由抽屉渲染好传进来。
 */

const FORMAT_SAMPLE = `<sprite:微笑>
「欢迎回来。今天也辛苦啦。」

<我>「今天就到这里吧，我送你回去。」`;

export function PlayerPanel({
  config,
  onChangeConfig,
  blockGroup,
}: {
  config: PlayerPluginConfig;
  onChangeConfig: (next: PlayerPluginConfig) => void;
  /** 抽屉里各插件共用的「提示词块」组(当前预设里的状态、加入 / 开关 / 移出) */
  blockGroup: ReactNode;
}) {
  return (
    <>
      <div className="sp-group">
        <div className="sp-group-head">
          <span className="sp-group-title">玩家台词弹成选项</span>
          <span className="sp-group-note">
            让模型在玩家说的每一句前面写 &lt;我&gt;。视觉小说翻到这句先弹一个选项,选中后以玩家的名义显示;
            玩家台词不念、不切立绘。
            关掉这一块时,模型替玩家写的台词没带立绘标签,照常显示成旁白的样子,名牌留空、不念。
          </span>
        </div>
        <pre className="pl-preview">{FORMAT_SAMPLE}</pre>
      </div>

      {blockGroup}

      <div className="sp-group" id="pl-prompt-player">
        <div className="sp-group-head">
          <span className="sp-group-title">提示词模板</span>
          <span className="sp-group-note">
            「玩家台词 · 插件」块的正文,所有预设共用,改完立即生效。&lt;我&gt; 是写死的,只认这一个标签。
          </span>
        </div>
        <textarea
          className="text-input pl-wide pl-textarea"
          rows={10}
          value={config.blockPrompt}
          spellCheck={false}
          onChange={(e) => onChangeConfig({ ...config, blockPrompt: e.target.value })}
        />
        <div className="pl-row">
          <div style={{ flex: 1 }} />
          <button
            className="btn small"
            disabled={config.blockPrompt === DEFAULT_PLAYER_BLOCK_PROMPT}
            onClick={() => onChangeConfig({ ...config, blockPrompt: DEFAULT_PLAYER_BLOCK_PROMPT })}
          >
            恢复默认模板
          </button>
        </div>
      </div>
    </>
  );
}
