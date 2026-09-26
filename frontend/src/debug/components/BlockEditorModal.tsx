import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { MarkerSource } from '../lib/cardFields';
import type { TavernCard } from '../lib/cardParser';
import { countCommentLines, stripComments } from '../lib/comments';
import { findUnresolvedMacros, substituteMacros, type MacroContext } from '../lib/macros';
import type { PresetPrompt, PromptRole } from '../lib/presetParser';
import { estimateTokens, formatTokens } from '../lib/tokens';
import { CommentTextarea } from './CommentTextarea';

/**
 * 块编辑弹窗 —— 点预设里任意一块都开它。屏幕中间的大框:上面一行是属性,
 * 下面左右分栏,左边改原文、右边实时预览真正发出去的字(注释去掉、宏展开)。
 * 左栏窄,在里面改长提示词太憋屈,所以不再有行内编辑。
 *
 * 两类块在这里长得不一样:
 *   文本块  —— 改 name / role / content / forbid_overrides,正文就是发出去的字
 *   marker —— 块本身是空的,真正的内容在别处(卡的字段 / 人设库 / 聊天记录)。
 *             内容在卡里的那几个(角色描述、性格、场景、示例对话)直接在这儿改,
 *             确定后写回角色卡;不在卡里的只指路,不给改。
 *
 * 刻意不做的两件事:
 *   1. injection_position / injection_depth —— 组装器没实现绝对深度注入,
 *      给个能改的框就是假 UI。字段照旧透传,不在这里露面。
 *   2. 注释行语法高亮 —— 原生 textarea 无法给部分行上色,要做得换掉整个
 *      编辑器。底下那行「N 行注释已排除」已经把信息说清楚了。
 */

/** 只有这两块有对应的角色卡字段;别的块显示「禁止覆盖」纯属误导 */
const OVERRIDABLE = new Set(['main', 'jailbreak']);

const ROLES: PromptRole[] = ['system', 'user', 'assistant'];

interface Props {
  prompt: PresetPrompt;
  /** 这一块此刻正被角色卡顶替 */
  overridden: boolean;
  /** marker 块的内容来源;非 marker、或预设自定义的未知 marker 时为 null */
  markerSource: MarkerSource | null;
  onCancel: () => void;
  onSave: (patch: Partial<PresetPrompt>) => void;
  /** marker 块改了卡的字段:写回角色卡 */
  onSaveCard: (patch: Partial<TavernCard>) => void;
  onDelete: () => void;
  /** 预览展开宏用的取值 —— 和聊天区显示同一份 */
  macros: MacroContext;
}

/** 右栏:发出去的样子。随机宏用块 id 定种子,不然每敲一个字骰子就重掷一次 */
function PreviewPane({
  text,
  macros,
  seed,
  children,
}: {
  text: string;
  macros: MacroContext;
  seed: string;
  children?: ReactNode;
}) {
  const rendered = useMemo(
    () => substituteMacros(stripComments(text), macros, { seed }),
    [text, macros, seed],
  );
  const unresolved = findUnresolvedMacros(rendered);
  return (
    <section className="bm-pane">
      <div className="bm-pane-head">
        <span className="bm-label">预览 · 实际发送</span>
        <span className="bm-hint">注释已去 · 宏已展开 · ~{formatTokens(estimateTokens(rendered))} tokens</span>
      </div>
      <pre className="bm-preview">{rendered || '(空 —— 这一块不会发出任何内容)'}</pre>
      {unresolved.length > 0 && (
        <span className="bm-unresolved">没解析掉的宏:{unresolved.join(' ')}</span>
      )}
      {children}
    </section>
  );
}

export function BlockEditorModal({
  prompt,
  overridden,
  markerSource,
  onCancel,
  onSave,
  onSaveCard,
  onDelete,
  macros,
}: Props) {
  const [name, setName] = useState(prompt.name);
  const [role, setRole] = useState<PromptRole>(prompt.role);
  const [content, setContent] = useState(prompt.content);
  const [forbidOverrides, setForbidOverrides] = useState(prompt.forbidOverrides);
  /** 卡填的 marker 才用得上 —— 它编辑的是卡的字段,不是块 */
  const [cardValue, setCardValue] = useState(
    markerSource?.kind === 'card' ? markerSource.value : '',
  );
  /** 删除要点两下 —— 和人设面板同一套,不弹 confirm */
  const [armed, setArmed] = useState(false);

  /**
   * 只有用户自建的块能删,规则同酒馆(PromptManager.js 的 isUserPrompt):
   * marker 是组装器认 identifier 的占位符,删了就再也填不回来;
   * 内置块(main / nsfw / jailbreak / enhanceDefinitions)关掉已经等于不发了。
   */
  const canDelete = !prompt.marker && !prompt.systemPrompt;

  const commentLines = countCommentLines(content);
  const netTokens = estimateTokens(stripComments(content));

  const cardDirty = markerSource?.kind === 'card' && cardValue !== markerSource.value;
  const dirty = prompt.marker
    ? name !== prompt.name || cardDirty
    : name !== prompt.name ||
      role !== prompt.role ||
      content !== prompt.content ||
      forbidOverrides !== prompt.forbidOverrides;

  const commit = () => {
    if (prompt.marker) {
      // marker 块自己只有名字能改 —— role/content 由组装器决定,写回去只会污染数据
      if (name !== prompt.name) onSave({ name });
      if (markerSource?.kind === 'card' && cardValue !== markerSource.value) {
        onSaveCard({ [markerSource.def.key]: cardValue } as Partial<TavernCard>);
      }
      return;
    }
    onSave({ name, role, content, forbidOverrides });
  };

  // Esc 挂在 window 上:容器的 onKeyDown 只在焦点还在弹窗内时才收得到,
  // 而页脚是白纸黑字承诺了 Esc 能关的
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  }, [onCancel]);

  // Ctrl+Enter 留在容器上就够 —— 它只在正文里敲才有意义,那时焦点必然在弹窗内
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      commit();
    }
  };

  // 挂到 body 上:手机端左栏会给 fixed 元素另起包含块,留在栏里弹窗就被
  // 困在栏内、底部的确定按钮被挤出屏幕
  return createPortal(
    <div className="inspector-backdrop block-modal-backdrop" onClick={onCancel}>
      <div
        className="inspector block-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="inspector-head">
          <span className="inspector-title">编辑块 · {prompt.name || prompt.identifier}</span>
          <div style={{ flex: 1 }} />
          <button className="btn small" onClick={onCancel} title="关闭">
            ✕
          </button>
        </div>

        <div className="block-modal-body">
          <div className="bm-props">
            <div className="bm-field bm-name">
              <span className="bm-label">名称</span>
              <input
                className="text-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            {!prompt.marker && (
              <div className="bm-field">
                <span className="bm-label">角色</span>
                <div className="bm-roles">
                  {ROLES.map((r) => (
                    <button
                      key={r}
                      className={`bm-role${role === r ? ' on' : ''}`}
                      onClick={() => setRole(r)}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {!prompt.marker && OVERRIDABLE.has(prompt.identifier) && (
              <div className="bm-field">
                <label className="bm-check">
                  <input
                    type="checkbox"
                    checked={forbidOverrides}
                    onChange={(e) => setForbidOverrides(e.target.checked)}
                  />
                  禁止角色卡覆盖
                </label>
                <span className="bm-hint">
                  勾上之后,就算角色卡自带
                  {prompt.identifier === 'main' ? ' system_prompt' : ' post_history_instructions'}
                  ,也用预设这一块的原文
                </span>
              </div>
            )}
          </div>

          {prompt.marker ? (
            <MarkerBody
              prompt={prompt}
              source={markerSource}
              value={cardValue}
              onValueChange={setCardValue}
              macros={macros}
            />
          ) : (
            <>
              {overridden && (
                <div className="bm-note">
                  这一块此刻正被角色卡顶替 —— 真正发出去的是卡里的字,不是下面这段。
                  勾上「禁止角色卡覆盖」可以挡掉。
                </div>
              )}

              <div className="bm-split">
                <section className="bm-pane">
                  <div className="bm-pane-head">
                    <span className="bm-label">原文</span>
                    <span className="bm-hint">
                      {commentLines > 0 && `${commentLines} 行注释已排除 · `}
                      净 ~{formatTokens(netTokens)} tokens
                      {commentLines === 0 && ' · 行首 // 的整行不会发出去'}
                    </span>
                  </div>
                  <CommentTextarea value={content} onChange={setContent} autoFocus />
                </section>
                <PreviewPane text={content} macros={macros} seed={prompt.identifier} />
              </div>
            </>
          )}
        </div>

        <div className="block-modal-foot">
          <span className="bm-id">{prompt.identifier}</span>
          {prompt.systemPrompt && <span className="bm-builtin">内置块</span>}
          {canDelete && (
            <button
              className={`btn small danger${armed ? ' armed' : ''}`}
              onClick={() => {
                if (!armed) {
                  setArmed(true);
                  return;
                }
                onDelete();
              }}
              onBlur={() => setArmed(false)}
              title="把这个块从预设里删掉"
            >
              {armed ? '再点一次删除' : '🗑 删除'}
            </button>
          )}
          <div style={{ flex: 1 }} />
          <span className="bm-hint">Ctrl+Enter 确定 · Esc 取消</span>
          <button className="btn small" onClick={onCancel}>
            取消
          </button>
          <button className="btn small accent" onClick={commit} disabled={!dirty}>
            确定
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** marker 块的正文区 —— 三种情况长得完全不一样,拆出来免得上面那坨嵌套太深 */
function MarkerBody({
  prompt,
  source,
  value,
  onValueChange,
  macros,
}: {
  prompt: PresetPrompt;
  source: MarkerSource | null;
  value: string;
  onValueChange: (v: string) => void;
  macros: MacroContext;
}) {
  // 预设作者自定义的 marker —— 酒馆里也是空的,我们同样不认
  if (!source) {
    return (
      <div className="bm-marker-note">
        【占位符】这一块不存文本,运行时由组装器按 identifier 填入内容。
        <br />
        但 <code>{prompt.identifier}</code> 不是已知的 marker —— 组装时会被跳过,
        什么都不会填。这里只能改显示名。
      </div>
    );
  }

  // 内容不在卡里(人设 / 聊天记录 / 世界书):只指路
  if (source.kind === 'elsewhere') {
    return (
      <div className="bm-marker-note">
        <b>{source.label}</b>
        <br />
        {source.hint}
      </div>
    );
  }

  // 内容是卡的某个字段:直接在这儿改,确定后写回卡
  return (
    <>
      <div className="bm-note">
        这一块的内容来自<b>角色卡</b>的「{source.def.label}」。在这里改，确定后直接写回卡。
      </div>

      <div className="bm-split">
        <section className="bm-pane">
          <div className="bm-pane-head">
            <span className="bm-label">内容 · 角色卡 {source.def.key}</span>
            <span className="bm-hint">~{formatTokens(estimateTokens(value))} tokens</span>
          </div>
          <textarea
            className="bm-textarea"
            value={value}
            autoFocus
            onChange={(e) => onValueChange(e.target.value)}
            placeholder={source.def.hint}
          />
          <span className="bm-hint">{source.def.hint}</span>
        </section>
        <PreviewPane text={value} macros={macros} seed={prompt.identifier}>
          {source.wrapTemplate && (
            <>
              <span className="bm-label">发出去之前会套进这个模板</span>
              <pre className="bm-wrap">{source.wrapTemplate}</pre>
              <span className="bm-hint">
                模板来自预设,不是卡的一部分 —— 所以最终那条消息比上面这段字长
              </span>
            </>
          )}
        </PreviewPane>
      </div>
    </>
  );
}
