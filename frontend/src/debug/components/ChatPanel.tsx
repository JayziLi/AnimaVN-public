import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { AssemblyResult } from '../lib/assembler';
import type { DebugConnection } from '../lib/api';
import { loadVisible } from '../lib/budget';
import {
  currentInfo,
  currentText,
  overswipeOf,
  type ChatEntry,
  type SwipeInfo,
} from '../lib/chatEntry';
import { formatTokens } from '../lib/tokens';
import { DEFAULT_AVATAR } from '../lib/avatar';
import { avatarRadius, enterHint, enterShouldSend, type ChatSettings } from '../lib/chatSettings';
import { substituteMacros, type MacroContext } from '../lib/macros';
import { renderQuoted } from '../lib/richText';
import { useCoarsePointer, useIsMobile } from '../lib/useIsMobile';
import { useSwipeGesture } from '../lib/useSwipeGesture';
import { AnimaIcon } from './AnimaIcon';

interface Props {
  entries: ChatEntry[];
  /** 显示偏好:排版 / 字号 / 行距 / 引号高亮 —— 全部只影响这一栏怎么画 */
  settings: ChatSettings;
  /**
   * 显示时展开 {{user}} / {{char}} 用的取值。
   *
   * 只在渲染这一刻替换,存进库里的永远是原文 —— 换玩家人设、改角色名,
   * 历史里的开场白当场跟着变。酒馆是把替换结果写回 chat[0].mes(script.js:1761),
   * 那样一旦烘焙就固化了,改了名字也回不去。
   */
  macros: MacroContext;
  /** 换对话时重置 show more 的窗口大小。用 id 而不是引用,切卡也覆盖 */
  chatKey: string | null;
  charName: string;
  userName: string;
  /** 玩家侧头像:激活人设的,没设就是默认灰人 */
  userAvatar: string;
  /** 角色侧头像:当前卡的,没有就退回默认灰人 */
  charAvatar: string | null;
  sending: boolean;
  error: string | null;
  /** 当前(下一次请求会用的)组装结果 */
  preview: AssemblyResult;
  ready: boolean;
  /** 正在从库里读这张对话 —— 消息区先占位,免得空屏看着像没数据 */
  loading: boolean;
  /** 欢迎页信息:没有角色卡时显示 */
  version: string;
  activeConnection: DebugConnection | null;
  /** 欢迎页用:库里有几张卡,以及「选择角色开始」点了去哪 */
  cardCount: number;
  onPickCharacter: () => void;
  /** 对话被改过没有 —— 决定开场白右滑是循环还是重新生成 */
  tainted: boolean;
  onOpenConnections: () => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string, scope: 'message' | 'swipe') => void;
  onSwipe: (id: string, dir: 'left' | 'right') => void;
  onBranch: (id: string) => void;
  onInspect: (result: AssemblyResult) => void;
  /** 历史分支的「看提示词」:只有哈希时由外层去库里把快照取回来 */
  onInspectSwipe: (info: SwipeInfo) => void;
  onReset: () => void;
  /** 重跑最后一条角色消息(新对话里就是开场白),结果追加成新分支 */
  onRegenerate: () => void;
  /**
   * backlog = 视觉小说菜单里的「历史」:同一套消息列表,但没有输入框和欢迎页
   * (视觉小说自己有输入框)。默认 console,即调试台的聊天区
   */
  variant?: 'console' | 'backlog';
  /** 换掉画出来的正文。raw 是库里存的原文,shown 是展开宏之后的;不给就画 shown */
  displayText?: (raw: string, shown: string) => string;
  /** 给了就在角色消息上多一颗「跳到这里」 —— 视觉小说从这条回复的第一句接着播 */
  onJump?: (id: string) => void;
  /**
   * 换掉整个正文的画法(视觉小说的历史:按句子列、带语音按钮)。返回 null 就照常画;
   * 编辑时不用它
   */
  renderBody?: (entry: ChatEntry) => ReactNode | null;
}

function Welcome({
  version,
  activeConnection,
  onOpenConnections,
  cardCount,
  onPickCharacter,
}: {
  version: string;
  activeConnection: DebugConnection | null;
  onOpenConnections: () => void;
  /** 库里有几张卡 —— 决定下半页是上手三步还是「挑个角色」 */
  cardCount: number;
  onPickCharacter: () => void;
}) {
  return (
    <div className="welcome">
      <div className="welcome-mark">◆</div>
      <div className="welcome-title">ANIMABACKEND</div>
      <div className="welcome-sub">提示词调试台 · PROMPT CONSOLE</div>

      <div className="welcome-hello">你好，欢迎使用 AnimaBackend。</div>
      <div className="welcome-tag">故事，从这里开始。</div>

      <div className="welcome-cards">
        <div className="welcome-card">
          <span className="wc-label">API</span>
          {activeConnection ? (
            <span className="wc-value">
              <span className="dot on" />
              {activeConnection.name} · {activeConnection.model || '未设模型'}
              {activeConnection.stream && <span className="wc-flag">流式</span>}
            </span>
          ) : (
            <button className="wc-action" onClick={onOpenConnections}>
              ⚠ 尚未配置 —— 点此添加
            </button>
          )}
        </div>
        <div className="welcome-card">
          <span className="wc-label">版本</span>
          <span className="wc-value">{version ? `v${version}` : '—'}</span>
        </div>
        <div className="welcome-card">
          <span className="wc-label">数据</span>
          <span className="wc-value">本机 SQLite · 只存在你的电脑上</span>
        </div>
      </div>

      {/* 一张卡都没有 = 第一次用,给上手三步;有卡 = 每次进来都会看到这一页,
          那三步早就不需要了,换成直接开聊的入口 */}
      {cardCount === 0 ? (
        <div className="welcome-steps">
          <div className="wstep">
            <span className="wstep-n">1</span>
            <span>打开角色卡面板，用右上角导入酒馆 PNG 卡（V2/V3）或 JSON</span>
          </div>
          <div className="wstep">
            <span className="wstep-n">2</span>
            <span>打开预设面板，使用选择框右侧的导入按钮载入酒馆 Chat Completion 预设</span>
          </div>
          <div className="wstep">
            <span className="wstep-n">3</span>
            <span>发出第一条消息 —— 每条回复都能回看当时发出去的完整提示词</span>
          </div>
        </div>
      ) : (
        <div className="welcome-start">
          <button className="welcome-start-btn" onClick={onPickCharacter}>
            选择角色开始
          </button>
          <div className="welcome-start-note">
            库里有 {cardCount} 张角色卡 · 选中后会接着上次的对话
          </div>
        </div>
      )}

      <div className="welcome-foot">提示词在你的浏览器里组装 · AnimaBackend 只做转发管道</div>
    </div>
  );
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * 思维链 —— 和正文分开渲染,因为它本来就是分开存的
 * (酒馆把它放在 extra.reasoning,从不混进 mes)。
 * 生成时展开好看着它想,生成完自动收起,不占地方。
 */
function ReasoningBlock({
  text,
  info,
  streaming,
}: {
  text: string;
  info: SwipeInfo | undefined;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(streaming);
  const wasStreaming = useRef(streaming);

  useEffect(() => {
    if (wasStreaming.current && !streaming) setOpen(false);
    wasStreaming.current = streaming;
  }, [streaming]);

  const label = streaming
    ? '思考中…'
    : info?.reasoningMs
      ? `已思考 ${seconds(info.reasoningMs)}`
      : '思维链';

  return (
    <div className={`reasoning${open ? ' open' : ''}`}>
      <button className="reasoning-head" onClick={() => setOpen((v) => !v)}>
        <span className="reasoning-caret">{open ? '▾' : '▸'}</span>
        <span className="reasoning-label">{label}</span>
        {/* 从正文的 <think> 标签里扒出来的,标一下 —— 调试时这个区别很重要 */}
        {info?.reasoningType === 'parsed' && <span className="reasoning-tag">&lt;think&gt;</span>}
        {!open && <span className="reasoning-peek">{text.slice(0, 40)}…</span>}
      </button>
      {open && <div className="reasoning-body">{text}</div>}
    </div>
  );
}

function MessageRow({
  entry,
  index,
  total,
  charName,
  userName,
  avatar,
  tainted,
  sending,
  dimmed,
  quotes,
  macros,
  onEdit,
  onDelete,
  onSwipe,
  onBranch,
  onInspectSwipe,
  displayText,
  onJump,
  renderBody,
}: {
  entry: ChatEntry;
  index: number;
  total: number;
  charName: string;
  userName: string;
  /** 这条消息该配哪张脸 */
  avatar: string;
  tainted: boolean;
  /** 引号里的内容要不要单独上色 */
  quotes: boolean;
  macros: MacroContext;
  sending: boolean;
  /** 不进提示词的历史 —— 线上方,降透明度 */
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string, scope: 'message' | 'swipe') => void;
  onSwipe: (id: string, dir: 'left' | 'right') => void;
  onBranch: (id: string) => void;
  onInspectSwipe: (info: SwipeInfo) => void;
  dimmed?: boolean;
  displayText?: (raw: string, shown: string) => string;
  onJump?: (id: string) => void;
  renderBody?: (entry: ChatEntry) => ReactNode | null;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [armed, setArmed] = useState(false);
  const editRef = useRef<HTMLTextAreaElement | null>(null);

  /**
   * 编辑框高度贴着内容长 —— 进编辑态时它顶替的是气泡,就该和气泡一样高,
   * 而不是一个要在里面滚的小窗口。先归零再读 scrollHeight,否则内容变短时
   * 高度只增不减(scrollHeight 永远认当前这个更高的框)。
   */
  useLayoutEffect(() => {
    const el = editRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // 全局是 border-box:height 含边框而 scrollHeight 不含,不补这 2px 会常年差出一条滚动条
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [editing, draft]);

  const info = currentInfo(entry);
  const text = currentText(entry);
  // 只有画出来的这一份展开宏;text 仍是原文,编辑框、保存、导出走的都是它
  const expanded = substituteMacros(text, macros, { seed: `${entry.id}:${entry.swipeIndex}` });
  const shown = displayText ? displayText(text, expanded) : expanded;
  const streaming = Boolean(entry.streaming);
  const behavior = overswipeOf(entry, index, total, tainted);
  const many = entry.swipes.length > 1;
  // behavior 为 none 就是「这条不可滑」(不是最后一条,或者是用户消息)——
  // 酒馆里非末尾的消息即使存着多个分支也不给箭头,历史一旦往下走就定型了
  const showSwipes =
    !streaming && !editing && behavior !== 'none' && (many || behavior === 'regenerate');

  // 酒馆的规则:最后一条角色消息且有多个分支时,删的是当前分支;其余情况删整条
  const deleteScope: 'message' | 'swipe' = many && behavior !== 'none' ? 'swipe' : 'message';

  // 相邻两个分支的提示词指纹一样,说明差异纯粹来自模型;不一样说明你中途动过预设或卡
  const prevHash = entry.swipeInfo[entry.swipeIndex - 1]?.snapshotHash;
  const promptChanged =
    entry.swipeIndex > 0 && prevHash && info?.snapshotHash ? prevHash !== info.snapshotHash : null;

  // 手机上横滑翻分支 —— 和 ‹ › 两颗按钮走同一个 onSwipe,越界重生成之类的
  // 边界规则全在 DebugApp.swipe() 里,这里只负责把手势翻译成方向。
  // 条件跟 showSwipes 一致:编辑中、流式中、非末尾消息都不接手势
  const swipeable = showSwipes && !sending;
  const swipeGesture = useSwipeGesture({
    enabled: swipeable,
    onLeft: () => onSwipe(entry.id, 'right'),
    onRight: () => onSwipe(entry.id, 'left'),
  });

  const startEdit = () => {
    setDraft(text);
    setArmed(false);
    setEditing(true);
  };

  const commit = () => {
    onEdit(entry.id, draft);
    setEditing(false);
    setArmed(false);
  };

  const remove = () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    onDelete(entry.id, deleteScope);
    setEditing(false);
    setArmed(false);
  };

  return (
    <div
      className={`chat-msg ${entry.role}${editing ? ' editing' : ''}${dimmed ? ' dimmed' : ''}${
        swipeable ? ' swipeable' : ''
      }`}
      {...swipeGesture.handlers}
    >
      <img className="chat-avatar" src={avatar} alt="" />
      {/* 跟手位移只给正文,头像钉在原地 —— 动的是「这一条回复」,不是整行 */}
      <div
        className={`chat-msg-body${swipeGesture.active ? ' swiping' : ''}`}
        style={
          swipeGesture.offset ? { transform: `translateX(${swipeGesture.offset}px)` } : undefined
        }
      >
      <div className="chat-msg-head">
        <span className="chat-who">
          {entry.role === 'user' ? userName || 'User' : charName || 'Character'}
        </span>
        {info?.model && (
          <span className="chat-meta">
            {info.model}
            {info.ttftMs !== undefined && ` · 首字 ${seconds(info.ttftMs)}`}
            {info.totalMs !== undefined && ` · 共 ${seconds(info.totalMs)}`}
          </span>
        )}
        <div className="chat-msg-actions">
          {onJump && entry.role === 'assistant' && !editing && (
            <button
              className="icon-btn tiny"
              onClick={() => onJump(entry.id)}
              title="跳到这里 —— 回到画面上,从这条回复的第一句接着看"
            >
              <AnimaIcon name="vn" size={12} />
            </button>
          )}
          {!editing && !streaming && (
            <button className="icon-btn tiny" onClick={startEdit} title="编辑这条消息">
              <AnimaIcon name="edit" size={12} />
            </button>
          )}
          {!editing && !streaming && (
            <button
              className="icon-btn tiny"
              onClick={() => onBranch(entry.id)}
              title="从这里开始 —— 复制此前历史到新分支"
            >
              <AnimaIcon name="branch" size={12} />
            </button>
          )}
          {(info?.snapshot || info?.snapshotHash) && (
            <button
              className="btn small"
              onClick={() => onInspectSwipe(info!)}
              title="查看产生这条回复时实际发出去的完整提示词"
            >
              看提示词
            </button>
          )}
        </div>
      </div>

      {info?.reasoning && (
        <ReasoningBlock text={info.reasoning} info={info} streaming={streaming} />
      )}

      {editing ? (
        <>
          <textarea
            className="chat-edit"
            ref={editRef}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setEditing(false);
                setArmed(false);
              }
            }}
          />
          <div className="chat-edit-actions">
            <button className="btn small accent" onClick={commit} title="保存到当前分支">
              ✓ 确认
            </button>
            <button
              className={`btn small danger${armed ? ' armed' : ''}`}
              onClick={remove}
              onBlur={() => setArmed(false)}
              title={deleteScope === 'swipe' ? '删除当前分支' : '删除这条消息'}
            >
              {armed
                ? deleteScope === 'swipe'
                  ? '再点一次删分支'
                  : '再点一次删除'
                : deleteScope === 'swipe'
                  ? `🗑 删除分支 ${entry.swipeIndex + 1}`
                  : '🗑 删除'}
            </button>
            <button
              className="btn small"
              onClick={() => {
                setEditing(false);
                setArmed(false);
              }}
            >
              ✗ 取消
            </button>
            <span className="chat-edit-hint">Esc 取消 · 改动只写进当前分支</span>
          </div>
        </>
      ) : (
        <div className="chat-text">
          {renderBody?.(entry) ?? renderQuoted(shown, quotes)}
          {streaming && <span className="stream-caret" />}
        </div>
      )}

      {/* 一个字都还没来:先给点反馈,免得看起来像卡住了 */}
      {streaming && !text && !info?.reasoning && (
        <div className="chat-pending">
          <span className="spinner" /> 等待首字……
        </div>
      )}

      {showSwipes && (
        <div className="swipe-row">
          {many && (
            <button
              className="swipe-btn"
              onClick={() => onSwipe(entry.id, 'left')}
              disabled={sending}
              title="上一个分支"
            >
              ‹
            </button>
          )}
          {many && (
            <span className="swipe-count">
              {entry.swipeIndex + 1}/{entry.swipes.length}
            </span>
          )}
          <button
            className={`swipe-btn${behavior === 'regenerate' && entry.swipeIndex === entry.swipes.length - 1 ? ' generates' : ''}`}
            onClick={() => onSwipe(entry.id, 'right')}
            disabled={sending}
            title={
              entry.swipeIndex < entry.swipes.length - 1
                ? '下一个分支'
                : behavior === 'loop'
                  ? '回到第一个开场白'
                  : '重新生成一次（当前这次会保留）'
            }
          >
            ›
          </button>
          {promptChanged !== null && (
            <span className={`swipe-diff${promptChanged ? ' changed' : ''}`}>
              {promptChanged ? '提示词与上一分支不同' : '同一提示词的不同结果'}
            </span>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

export function ChatPanel({
  entries,
  settings,
  macros,
  chatKey,
  charName,
  userName,
  userAvatar,
  charAvatar,
  sending,
  error,
  preview,
  ready,
  loading,
  version,
  activeConnection,
  cardCount,
  onPickCharacter,
  tainted,
  onOpenConnections,
  onSend,
  onStop,
  onEdit,
  onDelete,
  onSwipe,
  onBranch,
  onInspect,
  onInspectSwipe,
  onReset,
  onRegenerate,
  variant = 'console',
  displayText,
  onJump,
  renderBody,
}: Props) {
  const backlog = variant === 'backlog';
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // 手机上「Enter 发送」这条提示没意义(软键盘的回车各家行为不一),
  // 而且这一长串占位符在 16px 字号下会折成两行,把单行高的输入框撑破
  const isMobile = useIsMobile();
  // 软键盘上没有 Shift,Enter 只能当换行使 —— 发送交给旁边那颗按钮
  const softKeyboard = useCoarsePointer();

  // ---- 贴底跟随:滚离底部就不再硬拉回底部,模型输出时也能往回翻 ----
  // atBottom 只喂「回到最新」按钮的显隐;跟随滚动读 ref 而不进 effect 依赖 ——
  // 不然点一下按钮置真就立刻触发一次瞬移,把平滑滚动掐断
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);

  // ---- composer:自动长高之上允许手动拉高 ----
  // 拖过一次原生 resize 把手,高度就归用户管:此后自动长高跳过、发送后也不收回
  const manualResizeRef = useRef(false);
  // 最近一次已知的输入框高度 —— resize 事件里对不上账(且不是自动长高刚写的)才是用户在拖
  const knownHeightRef = useRef<number | null>(null);

  // ---- show more:渲染窗口。只管渲染,不管提示词 ----
  const [visibleCount, setVisibleCount] = useState(() => loadVisible());
  // 展开前的 scrollHeight:渲染完把差值补回 scrollTop,视野不往上跳
  const scrollComp = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (scrollComp.current === null) return;
    const el = scrollRef.current;
    if (el) el.scrollTop += el.scrollHeight - scrollComp.current;
    scrollComp.current = null;
  }, [visibleCount]);

  // 切对话重置窗口 —— 新对话不该继承上一个对话展开到一半的状态
  useEffect(() => {
    setVisibleCount(loadVisible());
    // 顺便瞬移到底、恢复贴底跟随;此时屏上还是旧消息,平滑滚动没有意义
    atBottomRef.current = true;
    setAtBottom(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatKey]);

  const windowStart = Math.max(0, entries.length - visibleCount);
  const windowEntries = entries.slice(windowStart);
  const showMore = (all: boolean) => {
    const el = scrollRef.current;
    scrollComp.current = el ? el.scrollHeight : 0;
    setVisibleCount(all ? entries.length : visibleCount + loadVisible());
  };

  // ---- 截断线:它以上(更老)的消息不进提示词 ----
  const budget = preview.budget;
  const firstKept = budget.firstKeptHistoryIndex;
  const lineInWindow = firstKept !== null && firstKept >= windowStart;

  const streamedChars = entries.reduce((n, e) => n + (e.streaming ? currentText(e).length : 0), 0);

  // 监听滚动,维护贴底状态:距底 40px 内都算贴底,留点余量免得最后一段流式来回抖
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const stuck = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (atBottomRef.current === stuck) return;
      atBottomRef.current = stuck;
      setAtBottom(stuck);
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    // 贴底时新内容(新消息 / 流式新段落)到达仍要跟着滚;翻上去了就撒手,交给「回到最新」
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [entries.length, streamedChars, sending]);

  // 平滑滚回底部。ref 先不置真,等滚动事件确认到底再置 ——
  // 这样途中有流式段落到达,也不会把平滑滚动打断成瞬移;state 先置真只是把按钮收掉
  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setAtBottom(true);
  };

  // 用户拖原生把手会触发 textarea 的 resize 事件;窗口缩放只动宽度时也会派发,
  // 所以拿高度对账:高度变了、且不是自动长高刚写进去的,才算手动调过
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    knownHeightRef.current = ta.clientHeight; // 先记下初始单行高度,第一次拖就能对出差值
    const onResize = () => {
      const prev = knownHeightRef.current;
      const h = ta.clientHeight;
      knownHeightRef.current = h;
      if (prev !== null && Math.abs(h - prev) > 1) manualResizeRef.current = true;
    };
    ta.addEventListener('resize', onResize);
    return () => ta.removeEventListener('resize', onResize);
  }, []);

  /**
   * 输入框上方那颗生成按钮,按最后一条是谁换活儿:
   *   角色消息 → 重跑它(结果是新分支)
   *   用户发言 → 生成缺掉的那条回复
   *
   * 后一种不能不给 —— 回复断线/报错/被删掉之后,对话就停在用户发言上,
   * 没有这颗按钮就再也生成不出下一条了。
   */
  const lastEntry = entries[entries.length - 1];
  const canGenerate = entries.length > 0;
  const awaitingReply = lastEntry?.role === 'user';
  /** 只有一条开场白 = 全新对话,说明文案不一样 */
  const isGreetingOnly = entries.length === 1 && lastEntry?.role === 'assistant';

  const submit = () => {
    const text = draft.trim();
    if (!text || sending || !ready) return;
    setDraft('');
    onSend(text);
    // 手动拉过:高度保留给用户;没拉过才收回单行
    if (manualResizeRef.current) return;
    if (taRef.current) {
      taRef.current.style.height = 'auto';
      knownHeightRef.current = taRef.current.clientHeight;
    }
  };

  const noCharacter = !charName;

  return (
    <div
      className="panel chat"
      // 排版方案走 data 属性选 CSS 分支;字号/行距/引号色是三个变量,
      // 下面所有规则都读它们 —— 组件本身不因为换了排版而改一行渲染逻辑
      data-layout={settings.layout}
      style={
        {
          '--chat-scale': settings.fontScale,
          '--chat-line': settings.lineHeight,
          // 满宽档存的是 0;用 100% 而不是 none,下面 duo 的气泡上限还要拿它做 calc
          '--chat-width': settings.chatWidth === 0 ? '100%' : `${settings.chatWidth}px`,
          '--avatar-size': `${settings.avatarSize}px`,
          '--avatar-radius': avatarRadius(settings.avatarShape),
          '--quote': settings.quoteColor,
        } as React.CSSProperties
      }
    >
      <div className="chat-scroll" ref={scrollRef}>
        {/* 切对话/切卡时旧消息还在屏上,顶上飘一条,说明正在换 */}
        {loading && entries.length > 0 && (
          <div className="chat-loading-pill">
            <span className="spinner" /> 读取对话……
          </div>
        )}

        {/* 空屏 + 在读:占位优先于「还没有对话」这类结论性文案 */}
        {loading && entries.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-mark">
              <span className="spinner" /> 读取对话……
            </div>
          </div>
        )}

        {!backlog && !loading && entries.length === 0 && !sending && noCharacter && (
          <Welcome
            version={version}
            activeConnection={activeConnection}
            onOpenConnections={onOpenConnections}
            cardCount={cardCount}
            onPickCharacter={onPickCharacter}
          />
        )}

        {!backlog && !loading && entries.length === 0 && !sending && !noCharacter && (
          <div className="chat-empty">
            <div className="chat-empty-mark">PROMPT CONSOLE</div>
            <div>
              {ready
                ? '载入完毕 —— 发一条消息看看完整提示词长什么样'
                : '还差一步 —— 载入预设后就可以开始对话'}
            </div>
          </div>
        )}

        {/* 渲染窗口之上还有消息:折叠成一颗按钮,免得长对话一次性全进 DOM */}
        {windowStart > 0 && (
          <div className="chat-more">
            <button className="btn small" onClick={(e) => showMore(e.shiftKey)}>
              ▲ 显示更多(还有 {windowStart} 条)
            </button>
            {/* 截断线在窗口之外(更老):窗口内全都进提示词,把截断情况标在按钮旁 */}
            {budget.droppedCount > 0 && firstKept !== null && !lineInWindow && (
              <span className="chat-more-note">
                其中 {budget.droppedCount} 条不进提示词
              </span>
            )}
          </div>
        )}

        {windowEntries.map((entry, wi) => {
          const i = windowStart + wi;
          return (
            <div key={entry.id} className="chat-msg-wrap">
              {lineInWindow && i === firstKept && budget.droppedCount > 0 && (
                <div className="chat-truncate-line">
                  ↑ 以上 {budget.droppedCount} 条不进提示词 · 约{' '}
                  {formatTokens(budget.droppedTokens)}
                </div>
              )}
              <MessageRow
                entry={entry}
                index={i}
                total={entries.length}
                charName={charName}
                userName={userName}
                avatar={entry.role === 'user' ? userAvatar : (charAvatar ?? DEFAULT_AVATAR)}
                tainted={tainted}
                sending={sending}
                dimmed={firstKept !== null && i < firstKept}
                quotes={settings.highlightQuotes}
                macros={macros}
                onEdit={onEdit}
                onDelete={onDelete}
                onSwipe={onSwipe}
                onBranch={onBranch}
                onInspectSwipe={onInspectSwipe}
                displayText={displayText}
                onJump={onJump}
                renderBody={renderBody}
              />
            </div>
          );
        })}

        {backlog && !loading && entries.length === 0 && (
          <div className="chat-empty">还没有对话</div>
        )}

        {error && <div className="chat-error">{error}</div>}
      </div>

      {!backlog && (
      <div className="composer">
        <div className="composer-inner">
          {/* 离开底部(且屏上有消息)时浮出:悬在输入区上方、盖住聊天区右下角 */}
          {!atBottom && entries.length > 0 && (
            <button className="jump-latest" onClick={jumpToLatest} title="回到最新" aria-label="回到最新">
              <AnimaIcon name="jump-latest" size={16} />
            </button>
          )}
          {/* 常驻的「N 条消息 / ~N tokens」拿掉了 —— 那两个数说的是提示词里的
              消息数,和屏幕上看到的对话条数对不上,看着只会让人算错。
              真出问题时才冒头的两个警告留着(截断 / 悬空引用),它们不是噪音。
              要看细账走「查看完整提示词」和左下角的预算条。 */}
          <div className="composer-bar">
            {budget.droppedCount > 0 && (
              <span className="composer-stat" title="超出 token 预算,没进提示词的旧历史">
                截断 {budget.droppedCount} 条
              </span>
            )}
            {preview.danglingIdentifiers.length > 0 && (
              <span className="composer-stat warn">
                {preview.danglingIdentifiers.length} 悬空引用
              </span>
            )}
            <div style={{ flex: 1 }} />
            {/* 重新生成:重跑最后一条角色消息,结果追加成新分支(左滑能滑回旧的)。
                新对话里最后一条就是开场白 —— 这里直接生成,不像右滑那样在
                「其他开场白」之间循环,那是这颗按钮存在的意义之一 */}
            {canGenerate && (
              <button
                className="btn small"
                onClick={onRegenerate}
                disabled={sending || !ready}
                title={
                  awaitingReply
                    ? '生成回复 —— 最后一条是你发的,这里把缺掉的回复补上'
                    : isGreetingOnly
                      ? '重新生成开场白 —— 生成一条新的,原来的左滑还能滑回去'
                      : '重新生成最后一条角色消息 —— 结果是新分支,旧的留着'
                }
              >
                <AnimaIcon name="refresh" size={14} />
                <span>{awaitingReply ? '生成回复' : '重新生成'}</span>
              </button>
            )}
            {entries.length > 0 && (
              <button
                className="btn small"
                onClick={onReset}
                disabled={sending}
                title="保留当前对话,另开一张新的"
              >
                <AnimaIcon name="new-chat" size={14} />
                <span>新对话</span>
              </button>
            )}
            <button className="btn small accent" onClick={() => onInspect(preview)}>
              查看完整提示词
            </button>
          </div>

          <div className="composer-row">
            <textarea
              ref={taRef}
              className="composer-input"
              rows={1}
              value={draft}
              placeholder={
                ready
                  ? isMobile || !enterHint(settings.enterKey, softKeyboard)
                    ? '说点什么……'
                    : `说点什么…… (${enterHint(settings.enterKey, softKeyboard)})`
                  : '先载入角色卡和预设'
              }
              disabled={!ready}
              onChange={(e) => {
                setDraft(e.target.value);
                // 手动调过高度就交给用户,自动长高退场
                if (manualResizeRef.current) return;
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
                knownHeightRef.current = e.target.clientHeight;
              }}
              onKeyDown={(e) => {
                // 回车是发送还是换行看设置里的「回车键」;自动模式下软键盘(手机/平板)
                // 没有 Shift,回车只能当换行,抢过来当发送就再也打不出第二段话了。
                // 输入法选词时的回车在 enterShouldSend 里也挡掉了
                if (!enterShouldSend(e, settings.enterKey, softKeyboard)) return;
                e.preventDefault();
                submit();
              }}
            />
            {/* 中断靠 AbortController,已经吐出来的字会留下 */}
            {sending ? (
              <button className="btn danger" style={{ height: 40 }} onClick={onStop}>
                停止
              </button>
            ) : (
              <button
                className="btn accent"
                style={{ height: 40 }}
                onClick={submit}
                disabled={!draft.trim() || !ready}
              >
                发送
              </button>
            )}
          </div>
        </div>
      </div>
      )}
      {/* 历史里没有输入框,「回到最新」挂在消息区右下角 */}
      {backlog && !atBottom && entries.length > 0 && (
        <button className="jump-latest backlog" onClick={jumpToLatest} title="回到最新" aria-label="回到最新">
          <AnimaIcon name="jump-latest" size={16} />
        </button>
      )}
    </div>
  );
}
