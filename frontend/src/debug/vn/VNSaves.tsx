/**
 * 菜单里的「存档」页 —— 存档就是调试台「对话历史」里的对话,一个对话一格。
 *
 * 每格的缩略图是那个对话结尾时的背景 + 立绘,再配上角色最后一句,帮人想起是哪一段。
 * 算缩略图要读整段对话:当前这个直接用内存里的,别的按需拉一次,按「id + 更新时间」缓存。
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  debugApi,
  sceneFileUrl,
  spriteImageUrl,
  type CardSprite,
  type ChatSummary,
  type SceneAsset,
  type SpriteLayout,
} from '../lib/api';
import { currentText, fromStored, type ChatEntry } from '../lib/chatEntry';
import { substituteMacros, type MacroContext } from '../lib/macros';
import { relTime } from '../lib/time';
import { parseBilingual } from '../plugins/lang';
import { sceneAtEnd } from '../plugins/scene';
import { resolveSprite } from '../plugins/sprite';
import { facesByCanvas, spriteStyle, type SpriteStage } from '../plugins/spriteLayout';
import { extractTags, type TagKind } from './script';

interface Props {
  /** 当前角色的全部对话 */
  chats: ChatSummary[];
  currentChatId: string | null;
  /** 当前对话在内存里的样子(可能比库里新) */
  currentEntries: ChatEntry[];
  sceneAssets: SceneAsset[];
  sprites: CardSprite[];
  /** 立绘和游戏里一样按脸对齐 */
  spriteStage: SpriteStage;
  spriteLayout: SpriteLayout;
  tagKinds: TagKind[];
  charName: string;
  macros: MacroContext;
  /** 分叉 / 读档等动作正在跑 */
  busy: boolean;
  canSave: boolean;
  onSaveHere: () => void;
  onLoad: (id: string) => void;
  onNewStory: () => void;
  onRename: (id: string, name: string) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}

interface Preview {
  bg: SceneAsset | null;
  sprite: CardSprite | null;
  /** 立绘没配图时,占位上写的表情名 */
  spriteLabel: string | null;
  line: string;
}

/** 别的对话拉回来的消息,按「id:更新时间」缓存 —— 对话一改,更新时间变,自然失效 */
const entryCache = new Map<string, ChatEntry[]>();

function previewOf(
  entries: ChatEntry[],
  kinds: TagKind[],
  assets: SceneAsset[],
  sprites: CardSprite[],
  charName: string,
  macros: MacroContext,
): Preview {
  const scene = sceneAtEnd(entries, kinds, assets);
  const spriteKind = kinds.filter((k) => k.kind === 'sprite');
  let sprite: CardSprite | null = sprites[0] ?? null;
  let spriteLabel: string | null = null;
  let line = '';
  for (const e of entries) {
    if (e.role !== 'assistant') continue;
    for (const t of extractTags(currentText(e), spriteKind, false).tags) {
      spriteLabel = t.label;
      sprite = resolveSprite(t.label, sprites) ?? sprite;
    }
  }
  const last = [...entries].reverse().find((e) => e.role === 'assistant');
  if (last) {
    const raw = substituteMacros(currentText(last), macros, { seed: `${last.id}:${last.swipeIndex}` });
    // 日中交替写的回复只取中文那句(日语挂在句子上,不单独成句)
    const lines = parseBilingual(raw, {
      charName,
      userName: macros.user,
      tags: kinds,
      streaming: false,
    }).lines;
    line = lines[lines.length - 1]?.text ?? '';
  }
  return { bg: scene.bg, sprite, spriteLabel: sprite ? sprite.label : spriteLabel, line };
}

function Thumb({
  preview,
  charName,
  spriteCss,
}: {
  preview: Preview | null;
  charName: string;
  spriteCss: (s: CardSprite) => CSSProperties;
}) {
  if (!preview) return <div className="vn-slot-thumb loading" />;
  const bgUrl = preview.bg ? sceneFileUrl(preview.bg) : null;
  const spriteUrl = preview.sprite ? spriteImageUrl(preview.sprite) : null;
  return (
    <div className="vn-slot-thumb">
      <img
        className="vn-slot-bg"
        src={bgUrl ?? '/vn/bg/uni.jpg'}
        alt=""
        draggable={false}
        style={{ objectPosition: `${preview.bg?.focus_x ?? 50}% 50%` }}
      />
      {spriteUrl && preview.sprite ? (
        <div className="vn-slot-stage">
          <img
            className="vn-slot-sprite"
            src={spriteUrl}
            alt=""
            draggable={false}
            style={spriteCss(preview.sprite)}
          />
        </div>
      ) : (
        <div className="vn-slot-sprite ph">
          <span>{charName || '角色'}</span>
          {preview.spriteLabel && <small>{preview.spriteLabel}</small>}
        </div>
      )}
    </div>
  );
}

export function VNSaves({
  chats,
  currentChatId,
  currentEntries,
  sceneAssets,
  sprites,
  spriteStage,
  spriteLayout,
  tagKinds,
  charName,
  macros,
  busy,
  canSave,
  onSaveHere,
  onLoad,
  onNewStory,
  onRename,
  onDelete,
}: Props) {
  // 别的对话的消息:拉到一个放一个,拉完这一轮才会触发一次重算
  const [loaded, setLoaded] = useState<Map<string, ChatEntry[]>>(() => new Map());
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [armedDelete, setArmedDelete] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    for (const c of chats) {
      if (c.id === currentChatId) continue;
      const key = `${c.id}:${c.updated_at}`;
      const hit = entryCache.get(key);
      if (hit) {
        setLoaded((m) => (m.get(c.id) === hit ? m : new Map(m).set(c.id, hit)));
        continue;
      }
      debugApi
        .getChat(c.id)
        .then((d) => {
          const entries = d.messages.map((m, i) => fromStored(m, i));
          entryCache.set(key, entries);
          if (alive) setLoaded((m) => new Map(m).set(c.id, entries));
        })
        .catch(() => {
          // 拉不到就一直显示占位缩略图,不弹错 —— 这里是导航,不是告警通道
        });
    }
    return () => {
      alive = false;
    };
  }, [chats, currentChatId]);

  const previews = useMemo(() => {
    const out = new Map<string, Preview>();
    for (const c of chats) {
      const entries = c.id === currentChatId ? currentEntries : loaded.get(c.id);
      if (entries) out.set(c.id, previewOf(entries, tagKinds, sceneAssets, sprites, charName, macros));
    }
    return out;
  }, [chats, currentChatId, currentEntries, loaded, tagKinds, sceneAssets, sprites, charName, macros]);

  const faces = useMemo(() => facesByCanvas(sprites), [sprites]);
  const spriteCss = (s: CardSprite) =>
    spriteStyle(faces.get(s.id) ?? null, spriteLayout, spriteStage);

  const commitRename = () => {
    if (!renaming) return;
    const name = renaming.name.trim();
    setRenaming(null);
    if (name) void onRename(renaming.id, name);
  };

  return (
    <div className="vn-saves">
      <div className="vn-page-bar">
        <span className="vn-page-note">一个对话一格,点开就是读档。「重来」出的几个版本不算存档,在历史里切</span>
        <div className="vn-page-actions">
          <button className="vn-pill" onClick={onNewStory} disabled={busy}>
            新的故事
          </button>
          <button
            className="vn-pill accent"
            onClick={onSaveHere}
            disabled={busy || !canSave}
            title="把到当前这条消息为止的对话另存一份,你留在现在这个对话里接着玩"
          >
            {busy ? '处理中…' : '在当前位置存档'}
          </button>
        </div>
      </div>

      {chats.length === 0 ? (
        <p className="vn-page-empty">这个角色还没有对话</p>
      ) : (
        <div className="vn-slots">
          {chats.map((c) => {
            const current = c.id === currentChatId;
            const preview = previews.get(c.id) ?? null;
            const editing = renaming?.id === c.id;
            return (
              <div key={c.id} className={`vn-slot${current ? ' current' : ''}`}>
                <button
                  className="vn-slot-open"
                  onClick={() => (current ? undefined : onLoad(c.id))}
                  disabled={busy}
                  title={current ? '正在玩的就是这个' : '读档'}
                >
                  <Thumb preview={preview} charName={charName} spriteCss={spriteCss} />
                  {current && <span className="vn-slot-badge">当前</span>}
                  <span className="vn-slot-body">
                    <span className="vn-slot-title">
                      <span className="vn-slot-name">{c.name || '未命名'}</span>
                      <span className="vn-slot-time">{relTime(c.updated_at)}</span>
                    </span>
                    <span className="vn-slot-line">{preview?.line || c.last_message || '……'}</span>
                  </span>
                </button>
                <div className="vn-slot-actions">
                  {editing ? (
                    <input
                      className="vn-slot-rename"
                      autoFocus
                      value={renaming.name}
                      maxLength={80}
                      onChange={(e) => setRenaming({ id: c.id, name: e.target.value })}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                    />
                  ) : (
                    <>
                      {/* 当前对话以内存为准:列表里的条数是上次拉列表时的 */}
                      <span className="vn-slot-count">
                        {current ? currentEntries.length : c.message_count} 条
                      </span>
                      <button onClick={() => setRenaming({ id: c.id, name: c.name })}>重命名</button>
                      <button
                        className={armedDelete === c.id ? 'danger' : ''}
                        onClick={() => {
                          if (armedDelete !== c.id) {
                            setArmedDelete(c.id);
                            return;
                          }
                          setArmedDelete(null);
                          void onDelete(c.id);
                        }}
                        onBlur={() => setArmedDelete((a) => (a === c.id ? null : a))}
                      >
                        {armedDelete === c.id ? '再点一次删除' : '删除'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
