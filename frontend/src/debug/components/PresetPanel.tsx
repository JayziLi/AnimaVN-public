import { useEffect, useRef, useState } from 'react';
import type { StoredPreset } from '../lib/api';
import type { MarkerSource } from '../lib/cardFields';
import type { TavernCard } from '../lib/cardParser';
import { stripComments } from '../lib/comments';
import type { MacroContext } from '../lib/macros';
import {
  MARKER_LABELS,
  orderGroupLabel,
  type PresetOrderEntry,
  type PresetPrompt,
  type TavernPreset,
} from '../lib/presetParser';
import { estimateTokens, formatTokens } from '../lib/tokens';
import { BlockEditorModal } from './BlockEditorModal';
import { AnimaIcon } from './AnimaIcon';

interface Props {
  preset: TavernPreset | null;
  order: PresetOrderEntry[];
  activeGroupIndex: number;
  collapsed: boolean;
  /** 后端存着的预设列表,下拉用 */
  saved: StoredPreset[];
  selectedId: string | null;
  /** 有未保存改动 */
  dirty: boolean;
  busy: boolean;
  onToggleCollapse: () => void;
  onPickGroup: (index: number) => void;
  onToggleBlock: (identifier: string) => void;
  onUpdateBlock: (identifier: string, patch: Partial<PresetPrompt>) => void;
  /** 拖拽改编排顺序。to = 移除源项之后的目标下标 */
  onReorder: (from: number, to: number) => void;
  /** 新建块,返回新块的 identifier(没有预设时返回 null) */
  onAddBlock: () => string | null;
  /** 删块 —— 只有用户自建的块能删,内置的只能关 */
  onDeleteBlock: (identifier: string) => void;
  /**
   * 插件块(立绘 / 场景 / 音乐指令):正文由插件的提示词模板决定,预设里不能单独改。
   * 左栏只给它们开关和排序,点开就跳到插件抽屉里对应的模板
   */
  isPluginBlock: (identifier: string) => boolean;
  onOpenPlugin: (identifier: string) => void;
  /** 正被角色卡顶替的块 identifier */
  overridden: Set<string>;
  /**
   * marker 块的内容来源。左栏不直接认识角色卡 —— 只拿一个查询函数,
   * 卡和预设的耦合留在 DebugApp 那一层
   */
  resolveMarker: (identifier: string) => MarkerSource | null;
  /** marker 块在详情弹窗里改了卡的字段 */
  onUpdateCard: (patch: Partial<TavernCard>) => void;
  /** 弹窗右侧预览展开宏用的取值 —— 和聊天区显示同一份 */
  macros: MacroContext;
  onSelectPreset: (id: string) => void;
  onSave: () => void;
  onSaveAs: () => void;
  /** 从标准骨架新建预设(库里一个都没有时也能用) */
  onNewPreset: () => void;
  onRename: () => void;
  onRestore: () => void;
  onDelete: () => void;
  onImport: () => void;
  onExport: () => void;
  /** 「绑定到当前角色卡」的快捷勾选;没选卡、没选预设时不传 */
  cardBinding?: {
    cardName: string;
    /** 这张卡绑的预设名;没绑是 null */
    boundName: string | null;
    /** 当前这套就是这张卡绑的 */
    bound: boolean;
    onToggle: (on: boolean) => void;
  };
}

function badgeFor(prompt: PresetPrompt | undefined): { cls: string; text: string } {
  if (!prompt) return { cls: 'badge-missing', text: 'MISSING' };
  if (prompt.marker) return { cls: 'badge-marker', text: 'MARKER' };
  return { cls: `badge-${prompt.role}`, text: prompt.role.toUpperCase() };
}

export function PresetPanel({
  preset,
  order,
  activeGroupIndex,
  collapsed,
  saved,
  selectedId,
  dirty,
  busy,
  onToggleCollapse,
  onPickGroup,
  onToggleBlock,
  onUpdateBlock,
  onReorder,
  onAddBlock,
  onDeleteBlock,
  isPluginBlock,
  onOpenPlugin,
  overridden,
  resolveMarker,
  onUpdateCard,
  macros,
  onSelectPreset,
  onSave,
  onSaveAs,
  onNewPreset,
  onRename,
  onRestore,
  onDelete,
  onImport,
  onExport,
  cardBinding,
}: Props) {
  /** 编辑弹窗开在哪个块上 —— 点行头或 ✎ 都开它 */
  const [detailOf, setDetailOf] = useState<string | null>(null);
  /** 预设行的 ⋯ 菜单 */
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  /** 按住把手才允许拖 —— 否则会和「点行头展开」以及文本选择打架 */
  const [dragArmed, setDragArmed] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<{ index: number; before: boolean } | null>(null);

  /** —— 触屏拖拽:HTML5 draggable 手指不触发,触屏这套走 Pointer Events —— */
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 拖拽会话的真值放 ref:rAF 循环 / pointerup 里读 state 拿到的是上一帧的 */
  const dragFromRef = useRef<number | null>(null);
  const dropRef = useRef<{ index: number; before: boolean } | null>(null);
  /** 进行中的触屏拖拽(记 pointerId,第二根手指不抢) */
  const touchDrag = useRef<{ pointerId: number } | null>(null);
  const pointerY = useRef(0);
  const scrollRaf = useRef(0);

  useEffect(() => () => cancelAnimationFrame(scrollRaf.current), []);

  /** 菜单开着时:点外面或 Esc 关掉 */
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  /** 菜单项统一入口:先关菜单再干活 */
  const runMenu = (fn: () => void) => {
    setMenuOpen(false);
    fn();
  };

  if (collapsed) {
    return (
      <div className="panel left">
        <button className="panel-rail" onClick={onToggleCollapse}>
          ▸ 预设 PRESET
        </button>
      </div>
    );
  }

  const byIdentifier = new Map(preset?.prompts.map((p) => [p.identifier, p]) ?? []);
  // 换预设时 detailOf 可能指向一个已经不存在的块 —— 查不到就当没开
  const detailPrompt = detailOf ? byIdentifier.get(detailOf) ?? null : null;
  const enabledCount = order.filter((o) => o.enabled).length;
  // 只统计实际会进请求的文本块;marker 的内容来自卡和历史,这里算不出来
  const totalTokens = order
    .filter((o) => o.enabled)
    .reduce((sum, o) => {
      const p = byIdentifier.get(o.identifier);
      return sum + (p && !p.marker ? estimateTokens(stripComments(p.content)) : 0);
    }, 0);

  /** 落点的真值在 ref,state 只负责画那条指示线 —— 没变就不触发重渲染 */
  const setDrop = (next: { index: number; before: boolean } | null) => {
    dropRef.current = next;
    setDropAt((prev) =>
      prev && next && prev.index === next.index && prev.before === next.before ? prev : next,
    );
  };

  const endDrag = () => {
    setDragArmed(null);
    setDragFrom(null);
    setDrop(null);
    dragFromRef.current = null;
    touchDrag.current = null;
    cancelAnimationFrame(scrollRaf.current);
  };

  /** 落点换算 —— 这里最容易差一位:onReorder 的 to 是「移除源项之后」的下标 */
  const finishDrop = () => {
    const from = dragFromRef.current;
    const drop = dropRef.current;
    if (from === null || !drop) return endDrag();
    let insertAt = drop.before ? drop.index : drop.index + 1;
    // 源项在插入点之前,移除后整体左移一位
    if (from < insertAt) insertAt -= 1;
    if (insertAt !== from) onReorder(from, insertAt);
    endDrag();
  };

  /** 指针(或自动滚动)动一次就算一次落点 —— 和桌面 onDragOver 同一套 before/after 语义 */
  const updateTouchDrop = (clientY: number) => {
    const rows = bodyRef.current?.querySelectorAll<HTMLElement>('.block-row');
    if (!rows?.length) return;
    for (let idx = 0; idx < rows.length; idx++) {
      const r = rows[idx].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        setDrop({ index: idx, before: true });
        return;
      }
    }
    setDrop({ index: rows.length - 1, before: false });
  };

  /** 手指停在列表上/下边缘时继续滚 —— 长预设(20+ 块)不自动滚,屏外的位置永远拖不到 */
  const touchScrollLoop = () => {
    // 面板中途被收起(第二根手指点了 ◂)之类:列表没了就自己收尾,别空转
    const body = bodyRef.current;
    if (!body || !touchDrag.current) {
      if (touchDrag.current) endDrag();
      return;
    }
    const r = body.getBoundingClientRect();
    if (pointerY.current < r.top + 40) body.scrollTop -= 9;
    else if (pointerY.current > r.bottom - 40) body.scrollTop += 9;
    updateTouchDrop(pointerY.current);
    scrollRaf.current = requestAnimationFrame(touchScrollLoop);
  };

  return (
    <div className="panel left">
      {/* 标题行只留名字 —— 预设级操作全收进下面预设行的 ⋯ 菜单,
          不再单独摆一排导入/导出/删除 */}
      <div className="panel-head">
        <span className="panel-title">预设 · Preset</span>
        {dirty && <span className="dirty-dot" title="有未保存的改动">●</span>}
        <div style={{ flex: 1 }} />
        <button className="panel-collapse" onClick={onToggleCollapse} title="收起">
          <AnimaIcon name="panel-left" size={16} />
        </button>
      </div>

      {/* 下拉行:选择 / 存 / 导入 / ⋯。导入是开局必经动作,手机上也要直达;
          新建/重命名/另存/恢复/导出/删除才是低频,收进 ⋯ 菜单 —— 之前平铺两排图标,
          看到块列表之前要先过四行 chrome */}
      <div className="preset-bar">
        <select
          className="select preset-select"
          value={selectedId ?? ''}
          onChange={(e) => onSelectPreset(e.target.value)}
          disabled={busy}
        >
          {saved.length === 0 && <option value="">(还没有预设)</option>}
          {saved.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          className={`icon-btn${dirty ? ' accent' : ''}`}
          onClick={onSave}
          disabled={busy || !selectedId || !dirty}
          title="更新当前预设"
        >
          <AnimaIcon name="save" size={15} />
        </button>
        <button className="icon-btn" onClick={onImport} disabled={busy} title="导入预设">
          <AnimaIcon name="import" size={15} />
        </button>
        <div className="preset-menu" ref={menuRef}>
          <button
            className="icon-btn"
            onClick={() => setMenuOpen((v) => !v)}
            title="更多预设操作"
          >
            <AnimaIcon name="more" size={16} />
          </button>
          {menuOpen && (
            <div className="preset-menu-pop">
              <button onClick={() => runMenu(onNewPreset)} disabled={busy}>
                <AnimaIcon name="add" size={15} />
                <span>新建预设</span>
              </button>
              <button onClick={() => runMenu(onRename)} disabled={busy || !selectedId}>
                <AnimaIcon name="edit" size={15} />
                <span>重命名</span>
              </button>
              <button onClick={() => runMenu(onSaveAs)} disabled={busy || !preset}>
                <AnimaIcon name="copy" size={15} />
                <span>另存为</span>
              </button>
              <button
                onClick={() => runMenu(onRestore)}
                disabled={busy || !selectedId || !dirty}
                title="丢弃未保存的改动"
              >
                <AnimaIcon name="restore" size={15} />
                <span>恢复</span>
              </button>
              <button onClick={() => runMenu(onExport)} disabled={busy || !preset}>
                <AnimaIcon name="export" size={15} />
                <span>导出</span>
              </button>
              <div className="preset-menu-sep" />
              <button
                className="danger"
                onClick={() => runMenu(onDelete)}
                disabled={busy || !selectedId}
              >
                <AnimaIcon name="delete" size={15} />
                <span>删除预设</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {cardBinding && (
        <div className="preset-bind">
          <label className="vp-check">
            <input
              type="checkbox"
              checked={cardBinding.bound}
              disabled={busy}
              onChange={(e) => cardBinding.onToggle(e.target.checked)}
            />
            绑定到当前角色卡「{cardBinding.cardName}」
          </label>
          {cardBinding.boundName && !cardBinding.bound && (
            <span className="preset-bind-note">
              这张卡绑的是「{cardBinding.boundName}」,现在临时用的这套;勾上就改绑成这套
            </span>
          )}
        </div>
      )}

      {preset && (
        <button
          className="block-add"
          onClick={() => {
            const identifier = onAddBlock();
            if (identifier) setDetailOf(identifier);
          }}
          disabled={busy}
        >
          ＋ 新建块
        </button>
      )}

      {!preset && (
        <div className="panel-empty">
          还没有载入预设
          <br />
          <button className="btn small panel-empty-cta" onClick={onNewPreset} disabled={busy}>
            ＋ 新建预设
          </button>
          <br />
          <span style={{ fontSize: 11 }}>生成酒馆默认的 10 个标准块;⋯ 菜单里也能导入现成的</span>
        </div>
      )}

      {preset && (
        <>
          {preset.orderGroups.length > 1 && (
            <div className="order-picker">
              <span className="topbar-label">编排</span>
              <select
                className="select"
                value={activeGroupIndex}
                onChange={(e) => onPickGroup(Number(e.target.value))}
              >
                {preset.orderGroups.map((g, i) => (
                  <option key={g.characterId} value={i}>
                    {orderGroupLabel(g)} · {g.order.filter((o) => o.enabled).length} 启用
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* 表头:名称 / Token —— 酒馆提示词管理器也有这一行 */}
          <div className="block-header">
            <span className="block-header-name">
              名称 <span className="block-header-count">{enabledCount}/{order.length}</span>
            </span>
            <span className="block-header-token">
              {totalTokens ? `~${formatTokens(totalTokens)}` : 'Token'}
            </span>
          </div>

          <div className="panel-body" ref={bodyRef}>
            {order.map((entry, i) => {
              const prompt = byIdentifier.get(entry.identifier);
              const plugin = Boolean(prompt) && isPluginBlock(entry.identifier);
              const badge = plugin ? { cls: 'badge-plugin', text: '插件' } : badgeFor(prompt);
              const open = () => {
                if (!prompt) return;
                if (plugin) onOpenPlugin(entry.identifier);
                else setDetailOf(entry.identifier);
              };
              const key = `${entry.identifier}:${i}`;
              const label =
                prompt?.marker && MARKER_LABELS[entry.identifier]
                  ? MARKER_LABELS[entry.identifier]
                  : prompt?.name ?? entry.identifier;
              // 注释不发出去,自然也不该计进 token
              const tokens =
                prompt && !prompt.marker ? estimateTokens(stripComments(prompt.content)) : 0;

              return (
                <div
                  key={key}
                  className={`block-row ${entry.enabled ? 'on' : 'off'}${plugin ? ' plugin' : ''}${
                    dragFrom === i ? ' dragging' : ''
                  }${
                    dropAt?.index === i ? (dropAt.before ? ' drop-before' : ' drop-after') : ''
                  }`}
                  draggable={dragArmed === key}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    dragFromRef.current = i;
                    setDragFrom(i);
                  }}
                  onDragOver={(e) => {
                    if (dragFromRef.current === null) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    const r = e.currentTarget.getBoundingClientRect();
                    setDrop({ index: i, before: e.clientY < r.top + r.height / 2 });
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    finishDrop();
                  }}
                  onDragEnd={endDrag}
                >
                  <div
                    className="block-head"
                    onClick={open}
                    title={
                      plugin
                        ? '插件块:正文由插件的提示词模板决定,点击去插件里改'
                        : prompt
                          ? '点击打开编辑 / 预览'
                          : undefined
                    }
                  >
                    <span
                      className="block-grip"
                      title="拖动排序"
                      onMouseDown={() => setDragArmed(key)}
                      onMouseUp={endDrag}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => {
                        if (e.pointerType === 'mouse') return; // 桌面走上面的 HTML5 DnD
                        e.preventDefault(); // 挡兼容鼠标事件 —— 不然 touch 也会 arm 桌面拖拽
                        // 抓住指针:手指滑出把手后 move/up 还回到这里。
                        // 合成事件(测试)没有活动指针会抛,真机不会
                        try {
                          e.currentTarget.setPointerCapture(e.pointerId);
                        } catch {
                          /* 没有可抓的活动指针就裸跑 */
                        }
                        touchDrag.current = { pointerId: e.pointerId };
                        dragFromRef.current = i;
                        setDragFrom(i);
                        pointerY.current = e.clientY;
                        scrollRaf.current = requestAnimationFrame(touchScrollLoop);
                      }}
                      onPointerMove={(e) => {
                        if (touchDrag.current?.pointerId !== e.pointerId) return;
                        pointerY.current = e.clientY;
                        updateTouchDrop(e.clientY);
                      }}
                      onPointerUp={(e) => {
                        if (touchDrag.current?.pointerId !== e.pointerId) return;
                        finishDrop();
                      }}
                      onPointerCancel={(e) => {
                        if (touchDrag.current?.pointerId !== e.pointerId) return;
                        endDrag();
                      }}
                    >
                      ⠿
                    </span>
                    <span className="block-name" title={label}>
                      {label}
                    </span>
                    <span className={`block-badge ${badge.cls}`}>{badge.text}</span>

                    {/* 覆盖是一直开着且静默的 —— 一张带 system_prompt 的卡会直接
                        顶掉你的 main 块,不标出来根本发现不了 */}
                    {overridden.has(entry.identifier) && (
                      <span
                        className="block-badge badge-override"
                        title="角色卡自带的字顶替了这一块的正文;在块详情里勾「禁止角色卡覆盖」可挡掉"
                      >
                        被卡覆盖
                      </span>
                    )}

                    {/* 整行都能点开;✎ 只是给「这里能改」一个显眼的记号。marker 也能开 —— 至少能改显示名 */}
                    {prompt && (
                      <button
                        className="icon-btn tiny"
                        onClick={(e) => {
                          e.stopPropagation();
                          open();
                        }}
                        title={plugin ? '去插件里改这一块' : '编辑 / 预览这一块'}
                      >
                        {plugin ? <AnimaIcon name="plugin" size={12} /> : '✎'}
                      </button>
                    )}

                    <button
                      className={`block-toggle${entry.enabled ? ' on' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleBlock(entry.identifier);
                      }}
                      title={entry.enabled ? '关闭这一块' : '启用这一块'}
                    >
                      <span className="knob" />
                    </button>

                    <span className="block-tokens">{tokens ? formatTokens(tokens) : '—'}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {detailPrompt && (
        <BlockEditorModal
          prompt={detailPrompt}
          overridden={overridden.has(detailPrompt.identifier)}
          markerSource={detailPrompt.marker ? resolveMarker(detailPrompt.identifier) : null}
          macros={macros}
          onCancel={() => setDetailOf(null)}
          onSave={(patch) => {
            onUpdateBlock(detailPrompt.identifier, patch);
            setDetailOf(null);
          }}
          onSaveCard={(patch) => {
            onUpdateCard(patch);
            setDetailOf(null);
          }}
          onDelete={() => {
            onDeleteBlock(detailPrompt.identifier);
            setDetailOf(null);
          }}
        />
      )}
    </div>
  );
}
