import type { StoredCard } from '../lib/api';

/**
 * 角色列表 —— 酒馆首页的角色列表的对应物,占满右栏、盖住角色卡编辑器:
 * 每行一个角色(头像 / 名字 / 创作者注释),点行选中并切回编辑器。
 * 名字搜索是本地过滤;头像由 DebugApp 按需懒加载(data URL 走 id → url 缓存)。
 */

interface Props {
  cards: StoredCard[];
  selectedId: string | null;
  /** id → 头像 data URL;没头像的行不一定会出现(还没拉到) */
  avatars: Map<string, string>;
  busy: boolean;
  onSelect: (id: string) => void;
}

/** 列表里每行头像的默认位图,和聊天消息里人设的兜底是同一个 */
const DEFAULT_AVATAR = '/assets/default-avatar.jpg';

export function CharacterList({ cards, selectedId, avatars, busy, onSelect }: Props) {
  return (
    <div className="panel-body">
      {cards.length === 0 && (
        <div className="panel-empty">
          还没有角色卡
          <br />
          <span style={{ fontSize: 11 }}>用 ↓ 导入 PNG 卡 / JSON,或 ＋ 新建一张</span>
        </div>
      )}
      {cards.map((c) => (
        <button
          key={c.id}
          className={`char-row${c.id === selectedId ? ' active' : ''}`}
          onClick={() => onSelect(c.id)}
          disabled={busy}
          title={c.name || '(无名)'}
        >
          <img className="char-row-avatar" src={avatars.get(c.id) ?? DEFAULT_AVATAR} alt="" />
          <div className="char-row-body">
            <div className="char-row-name">{c.name || '(无名)'}</div>
            {c.creator_notes && <div className="char-row-notes">{c.creator_notes}</div>}
          </div>
        </button>
      ))}
    </div>
  );
}
