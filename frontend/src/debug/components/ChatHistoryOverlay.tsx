import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatSummary } from '../lib/api';
import { EMPTY_MACRO_CONTEXT, substituteMacros } from '../lib/macros';
import { parseUtc, relTime, two } from '../lib/time';

/** 头上那排耗时动作。同一时刻只会有一个在跑,所以用单值而不是一堆 boolean */
export type ChatOp = 'import' | 'export' | 'exportTree' | 'branch' | null;

interface Props {
  /** 当前卡 + 孤儿对话(card_id 为空的) */
  chats: ChatSummary[];
  currentChatId: string | null;
  /** 一张卡都没选(开始界面)。对话历史是按角色分的,这时候空是理所当然的 */
  noCharacter: boolean;
  /** 列表自己在刷新(或正在分叉)—— 标题旁转个圈就够,不挡操作 */
  busy: boolean;
  /** 哪个动作在跑:那颗按钮的图标换成转圈,同时锁住整排 */
  pending: ChatOp;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onImport: () => void;
  onExport: () => void;
  onExportTree: () => void;
  /** 行内导出:不必先切过去再导 */
  onExportOne: (id: string) => void | Promise<void>;
  onRename: (id: string, name: string) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
  onClose: () => void;
}


/**
 * 预览行里的 {{user}} / {{char}} 也得展开,否则列表上一排字面宏。
 *
 * 取值来自这一行自己(每条对话都存了 card_name / user_name),不是当前打开的那张卡 ——
 * 列表里混着孤儿对话和分叉,拿当前卡的名字去套会张冠李戴。
 * 卡的正文字段(description 之类)这行没有,真出现在预览里会展开成空;
 * 预览本来就是截断过的一行,不值得为它把整张卡拉回来。
 */
function previewOf(c: ChatSummary): string {
  if (!c.last_message) return '';
  return substituteMacros(
    c.last_message,
    { ...EMPTY_MACRO_CONTEXT, char: c.card_name || 'Character', user: c.user_name || 'User' },
    { seed: c.id },
  );
}

/** 列表里怎么称呼一条对话:有名用名,没名(旧数据)用更新时间 */
function chatLabel(c: ChatSummary): string {
  if (c.name) return c.name;
  const d = new Date(parseUtc(c.updated_at));
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * 对话历史:按 parent_chat_id 把对话编成森林,盖在聊天区上选。根 = 没有父指针、
 * 或父不在列表里(父被删 / 只导入了子分支)。孤儿对话是 card_id 为空的,同样挂
 * 进来,让导入后匹配不到卡的历史不至于找不到入口。
 */
export function ChatHistoryOverlay({
  chats,
  currentChatId,
  noCharacter,
  busy,
  pending,
  onSelect,
  onNewChat,
  onImport,
  onExport,
  onExportTree,
  onExportOne,
  onRename,
  onDelete,
  onClose,
}: Props) {
  const [query, setQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** 删除是两步的:先亮起再确认,和连接抽屉一致 */
  const [armedId, setArmedId] = useState<string | null>(null);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId) renameRef.current?.select();
  }, [renamingId]);

  // Esc:先撤掉行内的临时状态,都没有才关整个面板 —— 免得改名改一半被整个关掉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (renamingId) setRenamingId(null);
      else if (armedId) setArmedId(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [renamingId, armedId, onClose]);

  const { roots, children } = useMemo(() => {
    const byId = new Map(chats.map((c) => [c.id, c]));

    // 过滤:名字或预览命中即可。命中的节点要连着祖先一起留下,不然分支会从树上
    // 掉下来,看不出它挂在谁下面
    const q = query.trim().toLowerCase();
    let visible: Set<string> | null = null;
    if (q) {
      visible = new Set<string>();
      for (const c of chats) {
        if (!c.name.toLowerCase().includes(q) && !c.last_message.toLowerCase().includes(q)) {
          continue;
        }
        let node: ChatSummary | undefined = c;
        while (node && !visible.has(node.id)) {
          visible.add(node.id);
          node = node.parent_chat_id ? byId.get(node.parent_chat_id) : undefined;
        }
      }
    }
    const shown = visible ? chats.filter((c) => visible.has(c.id)) : chats;

    const kids = new Map<string, ChatSummary[]>();
    for (const c of shown) {
      const pid = c.parent_chat_id;
      if (pid && byId.has(pid)) {
        const list = kids.get(pid);
        if (list) list.push(c);
        else kids.set(pid, [c]);
      }
    }
    // 最近更新在前 —— 这个列表是拿来「回到刚才聊的那条」的
    const byUpdated = (a: ChatSummary, b: ChatSummary) =>
      parseUtc(b.updated_at) - parseUtc(a.updated_at);
    for (const list of kids.values()) list.sort(byUpdated);

    return {
      roots: shown.filter((c) => !c.parent_chat_id || !byId.has(c.parent_chat_id)).sort(byUpdated),
      children: kids,
    };
  }, [chats, query]);

  // 一个动作在跑就锁住整排 —— 导入和导出同时点会互相踩
  const locked = pending !== null;

  const commitRename = async (id: string) => {
    const name = draft.trim();
    setRenamingId(null);
    if (!name || name === chats.find((c) => c.id === id)?.name) return;
    setRowBusyId(id);
    try {
      await onRename(id, name);
    } finally {
      setRowBusyId(null);
    }
  };

  const runDelete = async (id: string) => {
    if (armedId !== id) {
      setArmedId(id);
      return;
    }
    setArmedId(null);
    setRowBusyId(id);
    try {
      await onDelete(id);
    } finally {
      setRowBusyId(null);
    }
  };

  const renderNode = (c: ChatSummary, depth: number) => {
    const kids = children.get(c.id) ?? [];
    const isBranch = Boolean(c.parent_chat_id);
    const isCurrent = c.id === currentChatId;
    const renaming = renamingId === c.id;
    const rowBusy = rowBusyId === c.id;

    return (
      <div key={c.id}>
        <div
          className={`chat-row${isCurrent ? ' current' : ''}`}
          style={{ paddingLeft: 12 + depth * 18 }}
          role="button"
          tabIndex={renaming ? -1 : 0}
          onClick={() => {
            if (!renaming) onSelect(c.id);
          }}
          onKeyDown={(e) => {
            if (renaming) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelect(c.id);
            }
          }}
        >
          <span className="chat-row-flag" aria-hidden>
            {isBranch ? '⑂' : isCurrent ? '●' : '○'}
          </span>

          <div className="chat-row-main">
            <div className="chat-row-top">
              {renaming ? (
                <input
                  ref={renameRef}
                  className="chat-row-rename"
                  value={draft}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => void commitRename(c.id)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') void commitRename(c.id);
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                />
              ) : (
                <span className="chat-row-name" title={c.name || '未命名对话'}>
                  {chatLabel(c)}
                </span>
              )}
              {c.card_id === null && <span className="chat-row-orphan">孤儿</span>}
              <span className="chat-row-meta">
                {c.message_count} 条 · {relTime(c.updated_at)}
              </span>
            </div>
            <div className="chat-row-preview">
              {previewOf(c) || <span className="chat-row-blank">还没有消息</span>}
            </div>
          </div>

          {/* 亮起的删除、正在跑的行:不 hover 也得看得见,否则鼠标一移开
              「确认?」就消失了,用户不知道自己刚才点了什么 */}
          <div
            className={`chat-row-actions${armedId === c.id || rowBusy ? ' show' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            {rowBusy ? (
              <span className="spinner bare" />
            ) : (
              <>
                <button
                  className="icon-btn"
                  title="重命名"
                  onClick={() => {
                    setArmedId(null);
                    setDraft(c.name);
                    setRenamingId(c.id);
                  }}
                >
                  ✎
                </button>
                <button
                  className="icon-btn"
                  title="导出这条对话为 jsonl"
                  disabled={locked}
                  onClick={() => void onExportOne(c.id)}
                >
                  ⇩
                </button>
                <button
                  className={`icon-btn danger${armedId === c.id ? ' armed' : ''}`}
                  title={armedId === c.id ? '再点一次就真删了' : '删除这条对话'}
                  onClick={() => void runDelete(c.id)}
                >
                  {armedId === c.id ? '确认?' : '🗑'}
                </button>
              </>
            )}
          </div>
        </div>
        {kids.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="chat-history">
      <div className="chat-history-head">
        <span className="chat-history-title">对话历史 · CHATS</span>
        {/* 列表在重建时转个圈 —— 分叉/导入之后它会变,让用户知道正在变 */}
        {busy && <span className="spinner tiny" />}
        <input
          className="chat-history-search"
          value={query}
          placeholder="搜索名字或内容…"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div style={{ flex: 1 }} />
        <button
          className="icon-btn"
          onClick={onImport}
          disabled={locked}
          title="导入酒馆 jsonl 对话(可多选)"
        >
          {pending === 'import' ? <span className="spinner bare" /> : '↓'}
        </button>
        <button
          className="icon-btn"
          onClick={onExport}
          disabled={locked || !currentChatId}
          title="导出当前对话为 jsonl"
        >
          {pending === 'export' ? <span className="spinner bare" /> : '↑'}
        </button>
        <button
          className="icon-btn"
          onClick={onExportTree}
          disabled={locked || chats.length === 0}
          title="导出整棵分支树为 zip"
        >
          {pending === 'exportTree' ? <span className="spinner bare" /> : '⇈'}
        </button>
        <button className="icon-btn" onClick={onNewChat} disabled={locked} title="另开新对话">
          ＋
        </button>
        <button className="panel-collapse" onClick={onClose} title="关闭 (Esc)">
          ×
        </button>
      </div>

      <div className="chat-history-body">
        {/* 首次加载:还没有数据又确实在拉,别显示「还没有对话」误导 */}
        {roots.length === 0 && busy && (
          <div className="panel-empty">
            <span className="spinner" /> 加载对话列表……
          </div>
        )}
        {roots.length === 0 && !busy && (
          <div className="panel-empty">
            {query
              ? '没有匹配的对话'
              : noCharacter
                ? '对话是按角色分的 —— 先选一个角色'
                : '还没有对话'}
          </div>
        )}
        {roots.map((root) => renderNode(root, 0))}
      </div>
    </div>
  );
}
