/**
 * 标题画面:先做出来试用,设置里可以关掉。
 * 背景是当前角色的场景(虚化),菜单是 继续 / 新的故事 / 读档 / 设置 / 回调试台。
 * 「新的故事」先挑角色,挑完就开一段新对话。
 */

import { useState } from 'react';
import { Feather } from './Feather';

export interface TitleCard {
  id: string;
  name: string;
  avatar: string | null;
  /** 有上次玩到的对话 —— 卡上多一颗「接着上次」 */
  hasLastChat: boolean;
}

interface Props {
  bgSrc: string;
  charName: string;
  chatName: string;
  hasCard: boolean;
  cards: TitleCard[];
  currentCardId: string | null;
  onContinue: () => void;
  /** fresh = 新开一段对话;否则接着这个角色上次的对话 */
  onPickCard: (id: string, fresh: boolean) => void;
  onLoad: () => void;
  onSettings: () => void;
  onExit: () => void;
}

export function VNTitle({
  bgSrc,
  charName,
  chatName,
  hasCard,
  cards,
  currentCardId,
  onContinue,
  onPickCard,
  onLoad,
  onSettings,
  onExit,
}: Props) {
  const [picking, setPicking] = useState(false);

  return (
    <div className="vn-title">
      <img className="vn-title-bg" src={bgSrc} alt="" draggable={false} />
      <div className="vn-title-shade" />

      {picking ? (
        <div className="vn-title-pick">
          <div className="vn-title-pick-head">
            <h2>选择角色</h2>
            <span>点角色开一段新故事</span>
            <button className="vn-pill" onClick={() => setPicking(false)}>
              返回
            </button>
          </div>
          {cards.length === 0 ? (
            <p className="vn-page-empty">库里还没有角色卡,先回调试台导入一张</p>
          ) : (
            <div className="vn-cards">
              {cards.map((c) => (
                <div key={c.id} className={`vn-card${c.id === currentCardId ? ' current' : ''}`}>
                  <button className="vn-card-main" onClick={() => onPickCard(c.id, true)}>
                    {c.avatar ? (
                      <img src={c.avatar} alt="" draggable={false} />
                    ) : (
                      <span className="vn-card-ph">{c.name.slice(0, 1) || '?'}</span>
                    )}
                    <span className="vn-card-name">{c.name || '(无名)'}</span>
                  </button>
                  {c.hasLastChat && (
                    <button className="vn-card-resume" onClick={() => onPickCard(c.id, false)}>
                      接着上次
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="vn-title-main">
          <div className="vn-title-mark">
            <Feather size={34} />
            <h1>ANIMA</h1>
            <p>{hasCard ? `${charName}${chatName ? ` · ${chatName}` : ''}` : '选一个角色,开始你们的故事'}</p>
          </div>
          <nav className="vn-title-menu">
            <button onClick={onContinue} disabled={!hasCard}>
              继续
            </button>
            <button onClick={() => setPicking(true)}>新的故事</button>
            <button onClick={onLoad} disabled={!hasCard}>
              读档
            </button>
            <button onClick={onSettings}>设置</button>
            <button className="minor" onClick={onExit}>
              回调试台
            </button>
          </nav>
        </div>
      )}
    </div>
  );
}
