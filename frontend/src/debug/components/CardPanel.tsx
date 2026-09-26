import { useState } from 'react';
import type { StoredCard } from '../lib/api';
import type { TavernCard } from '../lib/cardParser';
import { estimateTokens, formatTokens } from '../lib/tokens';
import { CharacterList } from './CharacterList';
import { AnimaIcon } from './AnimaIcon';

/**
 * 右栏角色卡 —— 两层结构,和酒馆一致:
 *   一级(这里)     头像 / 名字 / 标签 / 创作者注释(折叠) / 角色描述 / 开场白
 *   二级(高级定义)  personality / scenario / mes_example / 提示词覆盖 / 元数据
 * 一级只放这两个正文字段,是因为现代卡的内容基本都写在 description 里。
 *
 * 选角色不再是下拉框:view 为 'list' 时整块编辑器让给角色列表(酒馆首页那种
 * 头像+名字的行),点行选中后切回 'editor'。列表和编辑器共用这块面板区域。
 */

export type SaveState = 'idle' | 'saving' | 'saved';
export type CardView = 'editor' | 'list';

interface Props {
  card: TavernCard | null;
  avatarUrl: string | null;
  collapsed: boolean;
  saved: StoredCard[];
  selectedId: string | null;
  /** 编辑器还是列表 —— 由 DebugApp 持有,切卡后自动回编辑器 */
  view: CardView;
  /** 列表行的头像缓存:id → data URL */
  avatars: Map<string, string>;
  saveState: SaveState;
  busy: boolean;
  onToggleCollapse: () => void;
  onToggleView: () => void;
  onChange: (patch: Partial<TavernCard>) => void;
  onSelectCard: (id: string) => void;
  onNew: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onImport: () => void;
  onExport: () => void;
  onOpenAdvanced: () => void;
  onPickAvatar: () => void;
}

const SAVE_LABEL: Record<SaveState, string> = {
  idle: '',
  saving: '保存中…',
  saved: '已保存',
};

export function CardPanel({
  card,
  avatarUrl,
  collapsed,
  saved,
  selectedId,
  view,
  avatars,
  saveState,
  busy,
  onToggleCollapse,
  onToggleView,
  onChange,
  onSelectCard,
  onNew,
  onDuplicate,
  onDelete,
  onImport,
  onExport,
  onOpenAdvanced,
  onPickAvatar,
}: Props) {
  const [showNotes, setShowNotes] = useState(false);
  const [greetingIndex, setGreetingIndex] = useState(0);

  if (collapsed) {
    return (
      <div className="panel right">
        <button className="panel-rail" onClick={onToggleCollapse}>
          ◂ 角色卡 CARD
        </button>
      </div>
    );
  }

  // 开场白 + 其他开场白合成一个可翻页的列表,和酒馆的「其他开场」一致
  const greetings = card ? [card.first_mes, ...card.alternate_greetings] : [];
  const activeGreeting = greetings[greetingIndex] ?? '';

  const setGreeting = (v: string) => {
    if (!card) return;
    if (greetingIndex === 0) {
      onChange({ first_mes: v });
    } else {
      const next = [...card.alternate_greetings];
      next[greetingIndex - 1] = v;
      onChange({ alternate_greetings: next });
    }
  };

  const addGreeting = () => {
    if (!card) return;
    onChange({ alternate_greetings: [...card.alternate_greetings, ''] });
    setGreetingIndex(greetings.length);
  };

  const removeGreeting = () => {
    if (!card || greetingIndex === 0) return;
    const next = card.alternate_greetings.filter((_, i) => i !== greetingIndex - 1);
    onChange({ alternate_greetings: next });
    setGreetingIndex(Math.max(0, greetingIndex - 1));
  };

  return (
    <div className="panel right">
      {/* 标题行:导入 / 导出 / 删除 —— 和左栏预设面板同一套范式 */}
      <div className="panel-head">
        <button className="panel-collapse" onClick={onToggleCollapse} title="收起">
          <AnimaIcon name="panel-right" size={16} />
        </button>
        <span className="panel-title">角色卡 · Card</span>
        {saveState !== 'idle' && (
          <span className={`save-state ${saveState}`}>{SAVE_LABEL[saveState]}</span>
        )}
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onImport} disabled={busy} title="导入角色卡">
          <AnimaIcon name="import" size={16} />
        </button>
        <button className="icon-btn" onClick={onExport} disabled={busy || !card} title="导出角色卡">
          <AnimaIcon name="export" size={16} />
        </button>
        <button
          className="icon-btn danger"
          onClick={onDelete}
          disabled={busy || !selectedId}
          title="删除角色卡"
        >
          <AnimaIcon name="delete" size={16} />
        </button>
      </div>

      {/* 工具行:列表/编辑器切换 + 新建 / 复制 / 高级定义。
          下拉选角色换成了左边那颗 ☰ —— 点开是占满整栏的头像列表 */}
      <div className="preset-bar">
        <button
          className={`icon-btn${view === 'list' ? ' accent' : ''}`}
          onClick={onToggleView}
          disabled={busy}
          title={view === 'list' ? '回到角色卡编辑器' : '角色列表 —— 选一张卡'}
        >
          <AnimaIcon name="list" size={16} />
        </button>
        {view === 'editor' && (
          <span className="bar-current-name" title={card?.name || undefined}>
            {card?.name || '(未选中角色)'}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onNew} disabled={busy} title="新建角色卡">
          <AnimaIcon name="add" size={16} />
        </button>
        <button
          className="icon-btn"
          onClick={onDuplicate}
          disabled={busy || !selectedId}
          title="复制角色卡"
        >
          <AnimaIcon name="copy" size={16} />
        </button>
        <button
          className="icon-btn"
          onClick={onOpenAdvanced}
          disabled={busy || !card || view === 'list'}
          title="高级定义（性格 / 情景 / 对话示例 / 提示词覆盖）"
        >
          <AnimaIcon name="sliders" size={16} />
        </button>
      </div>

      {view === 'list' && (
        <CharacterList
          cards={saved}
          selectedId={selectedId}
          avatars={avatars}
          busy={busy}
          onSelect={onSelectCard}
        />
      )}

      {/* 没有选中的卡。库里有卡(每次进来的常态)和一张都没有,该说的话不一样 */}
      {view === 'editor' && !card && (
        <div className="panel-empty">
          {saved.length > 0 ? '还没有选中角色' : '还没有角色卡'}
          <br />
          <span style={{ fontSize: 11 }}>
            {saved.length > 0
              ? '点上面的列表按钮挑一张卡'
              : '点列表按钮选一张卡，或用右上角导入 PNG 卡 / JSON'}
          </span>
        </div>
      )}

      {view === 'editor' && card && (
        <>
        <div className="panel-body card-fields">
          <div className="card-hero">
            <button
              className="card-avatar-btn"
              onClick={onPickAvatar}
              title="点击更换头像"
            >
              {avatarUrl ? (
                <img className="card-avatar" src={avatarUrl} alt={card.name} />
              ) : (
                <div className="card-avatar placeholder">NO IMG</div>
              )}
            </button>
            <div className="card-hero-body">
              <input
                className="card-name-input"
                value={card.name}
                placeholder="(无名)"
                onChange={(e) => onChange({ name: e.target.value })}
              />
              <div className="card-spec">
                {card.spec}
                {card.creator && ` · ${card.creator}`}
                {card.character_version && ` · v${card.character_version}`}
              </div>
              {card.tags.length > 0 && (
                <div className="card-tags">
                  {card.tags.slice(0, 6).map((t) => (
                    <span key={t} className="card-tag">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 创作者的注释:折叠,和酒馆一样默认收起 */}
          <div className="field-row">
            <div className="field-head" onClick={() => setShowNotes((v) => !v)}>
              <span className="field-name">创作者的注释</span>
              <span className="field-empty-mark">{showNotes ? '收起' : '展开'}</span>
            </div>
            {showNotes && (
              <div className="field-content">
                <textarea
                  className="card-textarea"
                  rows={3}
                  value={card.creator_notes}
                  placeholder="（给用户看的说明，不会发给 AI）"
                  onChange={(e) => onChange({ creator_notes: e.target.value })}
                />
              </div>
            )}
          </div>

          {/* 一级正文字段之一:角色描述 —— grow 让框撑满剩余空白 */}
          <div className="card-field grow">
            <div className="card-field-head">
              <span className="card-field-label">角色描述 · Description</span>
              <span className="card-field-token">
                Token: {card.description.trim() ? formatTokens(estimateTokens(card.description)) : 0}
              </span>
            </div>
            <textarea
              className="card-textarea tall"
              value={card.description}
              placeholder="（角色的人设主体。现代卡通常把性格、外貌、示例对话都写在这里）"
              onChange={(e) => onChange({ description: e.target.value })}
            />
          </div>

          {/* 一级正文字段之二:开场白(含其他开场) */}
          <div className="card-field">
            <div className="card-field-head">
              <span className="card-field-label">开场白 · First Message</span>
              {greetings.length > 1 && (
                <span className="greeting-pager">
                  <button
                    className="icon-btn tiny"
                    onClick={() => setGreetingIndex((i) => Math.max(0, i - 1))}
                    disabled={greetingIndex === 0}
                    title="上一条"
                  >
                    ‹
                  </button>
                  <span className="greeting-index">
                    {greetingIndex + 1}/{greetings.length}
                  </span>
                  <button
                    className="icon-btn tiny"
                    onClick={() => setGreetingIndex((i) => Math.min(greetings.length - 1, i + 1))}
                    disabled={greetingIndex >= greetings.length - 1}
                    title="下一条"
                  >
                    ›
                  </button>
                </span>
              )}
              <span className="card-field-token">
                Token: {activeGreeting.trim() ? formatTokens(estimateTokens(activeGreeting)) : 0}
              </span>
            </div>
            <textarea
              className="card-textarea tall"
              value={activeGreeting}
              placeholder="（角色说的第一句话）"
              onChange={(e) => setGreeting(e.target.value)}
            />
            <div className="card-field-actions">
              <span className="block-edit-hint">
                {greetingIndex === 0 ? '主开场白' : `其他开场 ${greetingIndex}`}
              </span>
              <button className="btn small" onClick={addGreeting}>
                ＋ 其他开场
              </button>
              {greetingIndex > 0 && (
                <button className="btn small danger" onClick={removeGreeting}>
                  删除这条
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 底部入口:整条「高级设置」—— 抽屉里是完整的角色卡编辑,按装配顺序排 */}
        <button className="card-adv-btn" onClick={onOpenAdvanced} disabled={busy}>
          <AnimaIcon name="sliders" size={16} />
          <span>高级设置</span>
          <span className="card-adv-sub">性格 / 情景 / 对话示例 / 提示词覆盖</span>
        </button>
        </>
      )}
    </div>
  );
}
