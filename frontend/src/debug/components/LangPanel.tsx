import type { ReactNode } from 'react';
import { DEFAULT_LANG_BLOCK_PROMPT, type LangPluginConfig } from '../plugins/lang';

/**
 * 插件抽屉的「外语」页:日语配音、中文字幕。
 *
 * 主模型按「一行日语,下一行中文」交替写,视觉小说把日语挂到中文句子上,
 * 日语声音念日语(规则见 plugins/lang.ts)。这个插件只有提示词模板和显示开关,
 * 没有标签格式、没有素材表。「提示词块」那一组和其他插件共用,由抽屉渲染好传进来。
 */

const FORMAT_SAMPLE = `<sprite:坏笑>
「エルジェイ様、さっきのドヤ顔、ぜんぜん隠せてなかったよ？」
「Lj sama 刚才那副得意的样子，一点都没藏住哦？」

彼女はくすっと笑って、指先で彼の頬をつついた。
她轻笑一声，用指尖戳了戳他的脸颊。`;

export function LangPanel({
  config,
  onChangeConfig,
  blockGroup,
}: {
  config: LangPluginConfig;
  onChangeConfig: (next: LangPluginConfig) => void;
  /** 抽屉里各插件共用的「提示词块」组(当前预设里的状态、加入 / 开关 / 移出) */
  blockGroup: ReactNode;
}) {
  return (
    <>
      <div className="sp-group">
        <div className="sp-group-head">
          <span className="sp-group-title">日语配音 · 中文字幕</span>
          <span className="sp-group-note">
            让模型每段先写一行日语、下一行写它的中文(旁白和台词都这样)。视觉小说里日语小字在上、中文在下;
            声音的语言是日语时,角色的台词念上面那行日语,缺日语的句子不念;中文声音照旧念中文。
            回复里没有日语时一切照旧。
          </span>
        </div>
        <pre className="pl-preview">{FORMAT_SAMPLE}</pre>
      </div>

      {blockGroup}

      <div className="sp-group" id="pl-prompt-lang">
        <div className="sp-group-head">
          <span className="sp-group-title">提示词模板</span>
          <span className="sp-group-note">
            「外语指令 · 插件」块的正文,所有预设共用,改完立即生效。示例里的立绘标签是写死的,改了立绘标签格式要一起改这里。
          </span>
        </div>
        <textarea
          className="text-input pl-wide pl-textarea"
          rows={12}
          value={config.blockPrompt}
          spellCheck={false}
          onChange={(e) => onChangeConfig({ ...config, blockPrompt: e.target.value })}
        />
        <div className="pl-row">
          <div style={{ flex: 1 }} />
          <button
            className="btn small"
            disabled={config.blockPrompt === DEFAULT_LANG_BLOCK_PROMPT}
            onClick={() => onChangeConfig({ ...config, blockPrompt: DEFAULT_LANG_BLOCK_PROMPT })}
          >
            恢复默认模板
          </button>
        </div>
      </div>

      <div className="sp-group">
        <div className="sp-group-head">
          <span className="sp-group-title">显示</span>
        </div>
        <label className="vp-check">
          <input
            type="checkbox"
            checked={config.showJa}
            onChange={(e) => onChangeConfig({ ...config, showJa: e.target.checked })}
          />
          视觉小说里在中文上方显示日语(对话框和历史)
        </label>
      </div>
    </>
  );
}
