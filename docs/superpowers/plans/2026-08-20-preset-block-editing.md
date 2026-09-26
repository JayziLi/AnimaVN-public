# 预设块编辑 Implementation Plan

> **执行状态（2026-08-20）：四个 Task 的代码改动全部完成，`tsc -b --force` 和 `oxlint`
> 干净，`npm run build` 通过，注释剔除与拖拽下标换算另跑了 22 条断言全绿。
>
> **但代码没有 commit** —— 工作区里躺着大量与本功能无关的未提交改动
> （`SettingsDrawer` / `richText` / `chatSettings` / `BudgetBar` / `CardEditorDrawer` …，
> 光 `debug.css` 一个文件就有 3000+ 行未提交 diff）。`DebugApp.tsx` / `debug.css` /
> `PresetPanel.tsx` / `assembler.ts` 四个文件我都只是增量修改，
> `git add` 它们会把那一大堆别的在建功能一起卷进一个叫「块编辑」的提交里。
> 所以改动留在工作区，等你自己决定怎么切提交。各 Task 里的 commit 步骤未执行。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给调试台左栏的预设块补上「改属性 / 写注释 / 拖排序」三种编辑能力，并把静默发生的「角色卡覆盖」显示出来。

**Architecture:** 纯前端改动，全部落在 `frontend/src/debug/`。新增一个无依赖的注释剔除库和一个居中弹窗组件；`PresetPanel` 自己持有弹窗和拖拽的瞬时状态，只通过 `onUpdateBlock` / `onReorder` 两个回调把结果交给 `DebugApp`。所有写操作沿用既有的「只改内存 + 标脏，点『存』才落盘」哲学，保存路径 (`presetToStored`) 一行不用改。

**Tech Stack:** React 19 + TypeScript 6 + Vite 8，**零运行时依赖**（`package.json` 里只有 `react` / `react-dom`）。

## Global Constraints

- **不许引入新的运行时依赖。** 拖拽用原生 HTML5 DnD，不装 dnd-kit / react-beautiful-dnd。
- **主题是纯灰阶**（`debug.css` 的 `:root` 注释：「不用色相，靠明度拉开信息层级」）。唯一的色相例外是 `--danger`。新样式一律只用既有 CSS 变量，**不引入新色相**。
- **本轮不碰 `injection_position` / `injection_depth`** —— 组装器没实现绝对深度注入，做成可编辑就是假 UI。字段保持原样透传。
- 注释语法：**只认行首**（允许前置空白）的 `//`，整行剔除。**不做行尾注释**（`https://` 会被切坏），不做块注释。
- 注释**只对预设文本块生效**，不碰对话历史、角色卡 marker 内容、以及卡覆盖进来的内容。
- 前端没有测试基建，本轮**不新建**。每个 Task 的自动化验收是 `npx tsc -b` + `npx oxlint`；行为验收走本文末尾的手动走查。
- 源码注释用中文，和周围代码的风格/密度保持一致。

---

### Task 1: `//` 注释剔除

**Files:**
- Create: `frontend/src/debug/lib/comments.ts`
- Modify: `frontend/src/debug/lib/assembler.ts`（`SkippedBlock` 类型 + 文本块分支）
- Modify: `frontend/src/debug/components/PresetPanel.tsx`（两处 token 计数）

**Interfaces:**
- Produces: `stripComments(text: string): string`、`countCommentLines(text: string): number` —— Task 2 的弹窗提示行要用。
- Produces: `SkippedBlock['reason']` 联合类型新增 `'全部被注释'`。

- [x] **Step 1: 建 `comments.ts`**

```ts
/**
 * 提示词注释 —— 行首 // 的整行不进请求。
 *
 * 只认行首(允许前置空白):`见 https://x.com` 里的 // 不是注释,不能切。
 * 因此行尾注释一律不做,块注释(/* *\/)也不做 —— 提示词里出现这些字符
 * 的概率远高于代码,规则越窄越安全。
 */

/** 行首(允许前置空白)以 // 开头 */
const COMMENT_LINE = /^\s*\/\//;

/** 剔除所有注释行(连同该行的换行符) */
export function stripComments(text: string): string {
  // 绝大多数块里没有 //,先挡一道省掉 split/join
  if (!text.includes('//')) return text;
  return text
    .split('\n')
    .filter((line) => !COMMENT_LINE.test(line))
    .join('\n');
}

/** 有几行被剔除 —— 弹窗提示行用 */
export function countCommentLines(text: string): number {
  if (!text.includes('//')) return 0;
  return text.split('\n').filter((line) => COMMENT_LINE.test(line)).length;
}
```

- [x] **Step 2: `assembler.ts` 加跳过原因**

在 `SkippedBlock` 接口里，把 `reason` 的联合类型加一项：

```ts
export interface SkippedBlock {
  identifier: string;
  name: string;
  reason: '编排里关闭' | '块内容为空' | '块不存在于预设' | '超出 token 预算' | '全部被注释';
}
```

- [x] **Step 3: `assembler.ts` 引入并接上剔除**

顶部 import 区加：

```ts
import { stripComments } from './comments';
```

把 `assemble()` 里 `if (!prompt.marker) {` 那一段整体替换为：

```ts
    if (!prompt.marker) {
      // 行首 // 的注释行不进请求。剔除放在宏替换**之前** ——
      // 注释掉的 {{char}} 不该被算进「未解析宏」
      const stripped = stripComments(prompt.content);
      // 整块被注释光:给个专属原因,别混进「块内容为空」——
      // 这两种情况用户要做的事完全不同
      if (prompt.content.trim() && !stripped.trim()) {
        skipped.push({
          identifier: prompt.identifier,
          name: prompt.name,
          reason: '全部被注释',
        });
        continue;
      }

      // 卡自带的 system_prompt / post_history_instructions 覆盖对应预设块
      let content = stripped;
      // 覆盖发生时账要算到卡头上 —— sourceKind 仍是 preset(它确实占着预设块的位置),
      // 但预算条上这几百 token 染成预设色就是骗人
      let part: PromptPart = 'preset';
      if (allowCardOverrides && !prompt.forbidOverrides) {
        if (prompt.identifier === 'main' && card.system_prompt.trim()) {
          content = card.system_prompt;
          part = 'card';
        } else if (
          prompt.identifier === 'jailbreak' &&
          card.post_history_instructions.trim()
        ) {
          content = card.post_history_instructions;
          part = 'card';
        }
      }
      emit(prompt.role, substituteMacros(content, ctx), prompt, 'preset', part);
      continue;
    }
```

注意：卡覆盖进来的 `content` **不剔注释** —— 注释是预设编辑器的功能，卡的字段归卡编辑器管，两边规则不混。

- [x] **Step 4: `PresetPanel.tsx` 两处 token 计数同步**

注释不发出去却被计入 token，数字是错的。顶部 import 加：

```ts
import { stripComments } from '../lib/comments';
```

表头合计（`totalTokens` 的 reduce 里）：

```ts
      return sum + (p && !p.marker ? estimateTokens(stripComments(p.content)) : 0);
```

行内单块（`order.map` 里的 `tokens`）：

```ts
              const tokens =
                prompt && !prompt.marker ? estimateTokens(stripComments(prompt.content)) : 0;
```

- [x] **Step 5: 编译 + lint**

```bash
cd frontend && npx tsc -b && npx oxlint
```

Expected: 两条命令都无输出、退出码 0。

- [ ] **Step 6: Commit** —— 未执行,见文首执行状态

```bash
git add frontend/src/debug/lib/comments.ts frontend/src/debug/lib/assembler.ts frontend/src/debug/components/PresetPanel.tsx
git commit -m "feat(debug): strip // comment lines from preset blocks"
```

---

### Task 2: 块详情弹窗

**Files:**
- Create: `frontend/src/debug/components/BlockEditorModal.tsx`
- Modify: `frontend/src/debug/DebugApp.tsx`（`editBlock` → `updateBlock`，改传参）
- Modify: `frontend/src/debug/components/PresetPanel.tsx`（`⋯` 按钮 + 挂弹窗 + 改 prop 名）
- Modify: `frontend/src/debug/debug.css`（`.block-modal` 一族）

**Interfaces:**
- Consumes: Task 1 的 `stripComments` / `countCommentLines`。
- Produces: `PresetPanel` 的 prop 由 `onEditBlock: (identifier: string, content: string) => void` **改名换签名**为 `onUpdateBlock: (identifier: string, patch: Partial<PresetPrompt>) => void`。行内 ✎ 也改走这个，只传 `{ content }`。
- Produces: `PresetPanel` 新增 prop `overridden: Set<string>`（Task 4 才真正填内容，本 Task 先接上，DebugApp 暂时传 `new Set()`）。

- [x] **Step 1: 建 `BlockEditorModal.tsx`**

```tsx
import { useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { countCommentLines, stripComments } from '../lib/comments';
import { MARKER_LABELS, type PresetPrompt, type PromptRole } from '../lib/presetParser';
import { estimateTokens, formatTokens } from '../lib/tokens';

/**
 * 块详情弹窗 —— 行内 ✎ 只改正文,属性要在这里改。
 *
 * 借 inspector 的背板改成居中小盒子,和裁剪弹窗同一路子。
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
  onCancel: () => void;
  onSave: (patch: Partial<PresetPrompt>) => void;
}

export function BlockEditorModal({ prompt, overridden, onCancel, onSave }: Props) {
  const [name, setName] = useState(prompt.name);
  const [role, setRole] = useState<PromptRole>(prompt.role);
  const [content, setContent] = useState(prompt.content);
  const [forbidOverrides, setForbidOverrides] = useState(prompt.forbidOverrides);

  const commentLines = countCommentLines(content);
  const netTokens = estimateTokens(stripComments(content));

  const dirty =
    name !== prompt.name ||
    role !== prompt.role ||
    content !== prompt.content ||
    forbidOverrides !== prompt.forbidOverrides;

  // marker 块只有名字能改 —— 别把 role/content 也写回去污染数据
  const commit = () =>
    onSave(prompt.marker ? { name } : { name, role, content, forbidOverrides });

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      commit();
    }
  };

  return (
    <div className="inspector-backdrop" onClick={onCancel}>
      <div
        className="inspector block-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="inspector-head">
          <span className="inspector-title">块详情 · Block</span>
          <div style={{ flex: 1 }} />
          <button className="btn small" onClick={onCancel}>
            ✕
          </button>
        </div>

        <div className="block-modal-body">
          <div className="bm-field">
            <span className="bm-label">名称</span>
            <input
              className="text-input"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {prompt.marker ? (
            <div className="bm-marker-note">
              【占位符】这一块不存文本。运行时由组装器按 identifier 填入真实内容
              {MARKER_LABELS[prompt.identifier]
                ? ` —— 这里会填「${MARKER_LABELS[prompt.identifier]}」。`
                : '(角色描述 / 对话历史 / 世界书 …)。'}
              <br />
              它的角色固定是 system,由组装器决定,改不了。这里只能改显示名。
            </div>
          ) : (
            <>
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

              {OVERRIDABLE.has(prompt.identifier) && (
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

              {overridden && (
                <div className="bm-note">
                  这一块此刻正被角色卡顶替 —— 真正发出去的是卡里的字，不是下面这段。
                  勾上「禁止角色卡覆盖」可以挡掉。
                </div>
              )}

              <div className="bm-field">
                <span className="bm-label">内容</span>
                <textarea
                  className="bm-textarea"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                />
                <span className="bm-hint">
                  {commentLines > 0 && `${commentLines} 行注释已排除 · `}
                  净 ~{formatTokens(netTokens)} tokens
                  {commentLines === 0 && ' · 行首 // 的整行不会发出去'}
                </span>
              </div>
            </>
          )}
        </div>

        <div className="block-modal-foot">
          <span className="bm-id">{prompt.identifier}</span>
          {prompt.systemPrompt && <span className="bm-builtin">内置块</span>}
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
    </div>
  );
}
```

- [x] **Step 2: `DebugApp.tsx` 把 `editBlock` 泛化成 `updateBlock`**

顶部 import 区，把 `presetParser` 的 type import 补上 `PresetPrompt`：

```ts
  type PresetOrderEntry,
  type PresetPrompt,
```

把现有的 `editBlock` 整个替换为：

```ts
  /** 改块的任意字段:只动内存,标脏,等用户点保存 */
  const updateBlock = (identifier: string, patch: Partial<PresetPrompt>) => {
    if (!preset) return;
    setPreset({
      ...preset,
      prompts: preset.prompts.map((p) => (p.identifier === identifier ? { ...p, ...patch } : p)),
    });
    setPresetDirty(true);
  };
```

JSX 里 `onEditBlock={editBlock}` 改成两行：

```tsx
            onUpdateBlock={updateBlock}
            overridden={overriddenIdentifiers}
```

**本 Task 先在 `updateBlock` 上方加一个占位常量**（Task 4 会换成真的 useMemo）：

```ts
  /** 正被角色卡顶替的块 —— Task 4 填真实内容 */
  const overriddenIdentifiers = useMemo(() => new Set<string>(), []);
```

- [x] **Step 3: `PresetPanel.tsx` 换 prop、加 `⋯` 按钮、挂弹窗**

import 区加：

```ts
import { BlockEditorModal } from './BlockEditorModal';
```

`Props` 接口里，把 `onEditBlock` 那一行替换成：

```ts
  onUpdateBlock: (identifier: string, patch: Partial<PresetPrompt>) => void;
  /** 正被角色卡顶替的块 identifier */
  overridden: Set<string>;
```

函数签名的解构参数里，把 `onEditBlock` 换成 `onUpdateBlock,` 和 `overridden,`。

组件顶部 state 加一行：

```ts
  /** 详情弹窗开在哪个块上 */
  const [detailOf, setDetailOf] = useState<string | null>(null);
```

`commitEdit` 改成走新回调：

```ts
  const commitEdit = () => {
    if (editing) onUpdateBlock(editing, { content: draft });
    setEditing(null);
  };
```

在 `block-head` 里、现有 ✎ 按钮**之后**插入 `⋯` 按钮（marker 块也要有 —— 它至少能改名）：

```tsx
                    <button
                      className="icon-btn tiny"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDetailOf(entry.identifier);
                      }}
                      title="块详情:名称 / 角色 / 内容"
                    >
                      ⋯
                    </button>
```

在组件 `return` 的最外层 `<div className="panel left">` 闭合标签**之前**挂上弹窗：

```tsx
      {detailOf !== null && byIdentifier.get(detailOf) && (
        <BlockEditorModal
          prompt={byIdentifier.get(detailOf)!}
          overridden={overridden.has(detailOf)}
          onCancel={() => setDetailOf(null)}
          onSave={(patch) => {
            onUpdateBlock(detailOf, patch);
            setDetailOf(null);
          }}
        />
      )}
```

- [x] **Step 4: `debug.css` 加弹窗样式**

追加到文件末尾：

```css
/* ══════════ 块详情弹窗 ══════════ */
/* 同裁剪弹窗:借 inspector 的背板,改成居中的小盒子 */
.block-modal {
  width: min(620px, 92vw);
  height: auto;
  max-height: 88vh;
  margin: auto;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  animation: none;
}

.block-modal-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 13px;
}

.bm-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.bm-label {
  font-size: 11px;
  color: var(--text-faint);
  letter-spacing: 0.04em;
}

/* 弹窗里的输入框铺满,不受通用 220px 上限约束 */
.bm-field .text-input {
  max-width: none;
}

/* role 三选一:连成一条,选中的反白 */
.bm-roles {
  display: flex;
}

.bm-role {
  padding: 4px 15px;
  border: 1px solid var(--border-strong);
  background: var(--bg-raised);
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 11px;
  transition: background 0.12s, color 0.12s;
}
.bm-role + .bm-role {
  border-left: none;
}
.bm-role:first-child {
  border-radius: 4px 0 0 4px;
}
.bm-role:last-child {
  border-radius: 0 4px 4px 0;
}
.bm-role:hover {
  color: var(--text-dim);
}
.bm-role.on {
  background: var(--accent-dim);
  color: var(--accent);
}

.bm-check {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
}

.bm-textarea {
  width: 100%;
  min-height: 240px;
  resize: vertical;
  padding: 9px 11px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-body);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
}
.bm-textarea:focus {
  outline: none;
  border-color: var(--border-strong);
}

.bm-hint {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-faint);
}

.bm-marker-note {
  padding: 12px 14px;
  border: 1px dashed var(--border-strong);
  border-radius: 4px;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.7;
}

.bm-note {
  padding: 8px 11px;
  border-left: 2px solid var(--accent);
  background: var(--bg);
  color: var(--text-dim);
  font-size: 11.5px;
  line-height: 1.6;
}

.block-modal-foot {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

.bm-id {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-faint);
}

.bm-builtin {
  font-family: var(--mono);
  font-size: 9px;
  padding: 1px 5px;
  border: 1px solid var(--border-strong);
  border-radius: 3px;
  color: var(--text-faint);
}
```

- [x] **Step 5: 编译 + lint**

```bash
cd frontend && npx tsc -b && npx oxlint
```

Expected: 无输出、退出码 0。

- [ ] **Step 6: Commit** —— 未执行,见文首执行状态

```bash
git add frontend/src/debug/components/BlockEditorModal.tsx frontend/src/debug/components/PresetPanel.tsx frontend/src/debug/DebugApp.tsx frontend/src/debug/debug.css
git commit -m "feat(debug): add block detail modal for preset blocks"
```

---

### Task 3: 拖拽排序

**Files:**
- Modify: `frontend/src/debug/components/PresetPanel.tsx`（把手 + DnD 事件）
- Modify: `frontend/src/debug/DebugApp.tsx`（`reorderBlock`）
- Modify: `frontend/src/debug/debug.css`（`.block-grip` / `.dragging` / 落点线）

**Interfaces:**
- Produces: `PresetPanel` 新增 prop `onReorder: (from: number, to: number) => void`。
  **`to` 的口径：移除源项之后的数组里的目标下标。** 换算由 `PresetPanel` 做。

- [x] **Step 1: `DebugApp.tsx` 加 `reorderBlock`**

`order` 是 `useMemo` 派生的、`overrides` 只存 enabled 覆写，装不下顺序，所以直接改
`preset.orderGroups[groupIndex].order`。加在 `updateBlock` 后面：

```ts
  /** 拖拽改编排顺序:同样只动内存,标脏。to = 移除源项之后的目标下标 */
  const reorderBlock = (from: number, to: number) => {
    if (!preset || from === to) return;
    const group = preset.orderGroups[groupIndex];
    if (!group) return;
    const next = [...group.order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setPreset({
      ...preset,
      orderGroups: preset.orderGroups.map((g, i) => (i === groupIndex ? { ...g, order: next } : g)),
    });
    setPresetDirty(true);
  };
```

JSX 里 `onUpdateBlock={updateBlock}` 下面加：

```tsx
            onReorder={reorderBlock}
```

`overrides` 按 identifier 存，重排后自动跟着走，不用管。保存路径也不用改 ——
`presetToStored` 已经把当前 `order` 合并回 `prompt_order`。

- [x] **Step 2: `PresetPanel.tsx` Props 加回调**

```ts
  onReorder: (from: number, to: number) => void;
```

解构参数里加 `onReorder,`。

- [x] **Step 3: `PresetPanel.tsx` 加拖拽状态和落点换算**

组件顶部 state 区加：

```ts
  /** 按住把手才允许拖 —— 否则会和「点行头展开」以及文本选择打架 */
  const [dragArmed, setDragArmed] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<{ index: number; before: boolean } | null>(null);
```

`commitEdit` 后面加：

```ts
  const endDrag = () => {
    setDragArmed(null);
    setDragFrom(null);
    setDropAt(null);
  };

  /** 落点换算 —— 这里最容易差一位:onReorder 的 to 是「移除源项之后」的下标 */
  const finishDrop = () => {
    if (dragFrom === null || !dropAt) return endDrag();
    let insertAt = dropAt.before ? dropAt.index : dropAt.index + 1;
    // 源项在插入点之前,移除后整体左移一位
    if (dragFrom < insertAt) insertAt -= 1;
    if (insertAt !== dragFrom) onReorder(dragFrom, insertAt);
    endDrag();
  };
```

- [x] **Step 4: `PresetPanel.tsx` 行上挂 DnD**

把 `order.map` 里的行容器整个替换：

```tsx
                <div
                  key={key}
                  className={`block-row ${entry.enabled ? 'on' : 'off'}${
                    dragFrom === i ? ' dragging' : ''
                  }${
                    dropAt?.index === i ? (dropAt.before ? ' drop-before' : ' drop-after') : ''
                  }`}
                  draggable={dragArmed === key}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    setDragFrom(i);
                  }}
                  onDragOver={(e) => {
                    if (dragFrom === null) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    const r = e.currentTarget.getBoundingClientRect();
                    setDropAt({ index: i, before: e.clientY < r.top + r.height / 2 });
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    finishDrop();
                  }}
                  onDragEnd={endDrag}
                >
```

在 `block-head` 内、`block-name` **之前**插入把手：

```tsx
                    <span
                      className="block-grip"
                      title="拖动排序"
                      onMouseDown={() => setDragArmed(key)}
                      onMouseUp={endDrag}
                      onClick={(e) => e.stopPropagation()}
                    >
                      ⠿
                    </span>
```

- [x] **Step 5: `debug.css` 加把手和落点样式**

追加到文件末尾：

```css
/* ══════════ 块拖拽排序 ══════════ */
/* 把手常隐,hover 行才浮出来 —— 左栏很窄,不值得常驻一列 */
.block-grip {
  flex-shrink: 0;
  width: 9px;
  font-size: 11px;
  line-height: 1;
  color: var(--text-faint);
  cursor: grab;
  opacity: 0;
  transition: opacity 0.12s, color 0.12s;
  user-select: none;
}
.block-row:hover .block-grip {
  opacity: 1;
}
.block-grip:hover {
  color: var(--text);
}
.block-grip:active {
  cursor: grabbing;
}

.block-row.dragging {
  opacity: 0.35;
}

/* 落点指示:2px 强调色横线。用 inset shadow 不用 border,
   免得行高跳动把下面的行推来推去 */
.block-row.drop-before {
  box-shadow: inset 0 2px 0 var(--accent);
}
.block-row.drop-after {
  box-shadow: inset 0 -2px 0 var(--accent);
}
```

- [x] **Step 6: 编译 + lint**

```bash
cd frontend && npx tsc -b && npx oxlint
```

Expected: 无输出、退出码 0。

- [ ] **Step 7: Commit** —— 未执行,见文首执行状态

```bash
git add frontend/src/debug/components/PresetPanel.tsx frontend/src/debug/DebugApp.tsx frontend/src/debug/debug.css
git commit -m "feat(debug): drag to reorder preset blocks"
```

---

### Task 4: 被卡覆盖徽章

**Files:**
- Modify: `frontend/src/debug/DebugApp.tsx`（把 Task 2 的占位 `overriddenIdentifiers` 换成真的）
- Modify: `frontend/src/debug/components/PresetPanel.tsx`（行上渲染徽章）
- Modify: `frontend/src/debug/debug.css`（`.badge-override`）

**Interfaces:**
- Consumes: Task 2 已接好的 `overridden: Set<string>` prop 和弹窗里的 `overridden` 提示。

- [x] **Step 1: `DebugApp.tsx` 算真实集合**

`allowCardOverrides` 在两处 assemble 调用点都硬编码为 `true`，所以覆盖是**一直开着**的，
左栏却完全看不出来。把 Task 2 那个占位 `useMemo` 整个替换为：

```ts
  /**
   * 正被角色卡顶替的预设块。
   *
   * 覆盖一直开着(两处 assemble 调用点的 allowCardOverrides 都是 true),
   * 而且是静默发生的 —— 一张带 system_prompt 的卡会直接顶掉你的 main 块。
   * 调试台不该藏这个。
   */
  const overriddenIdentifiers = useMemo(() => {
    const s = new Set<string>();
    if (!card || !preset) return s;
    for (const p of preset.prompts) {
      if (p.marker || p.forbidOverrides) continue;
      if (p.identifier === 'main' && card.system_prompt.trim()) s.add('main');
      if (p.identifier === 'jailbreak' && card.post_history_instructions.trim()) {
        s.add('jailbreak');
      }
    }
    return s;
  }, [card, preset]);
```

- [x] **Step 2: `PresetPanel.tsx` 行上渲染徽章**

在 `block-head` 里、现有 `block-badge` 那一行**之后**插入：

```tsx
                    {overridden.has(entry.identifier) && (
                      <span
                        className="block-badge badge-override"
                        title="角色卡自带的字顶替了这一块的正文;在块详情里勾「禁止角色卡覆盖」可挡掉"
                      >
                        被卡覆盖
                      </span>
                    )}
```

- [x] **Step 3: `debug.css` 加徽章样式**

紧跟在现有 `.badge-missing` 规则后面插入：

```css
/* 被角色卡顶替:主题是纯灰阶不引色相,改用反相实心块抓注意力 */
.badge-override {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--bg);
  opacity: 1;
}
```

- [x] **Step 4: 编译 + lint**

```bash
cd frontend && npx tsc -b && npx oxlint
```

Expected: 无输出、退出码 0。

- [ ] **Step 5: Commit** —— 未执行,见文首执行状态

```bash
git add frontend/src/debug/DebugApp.tsx frontend/src/debug/components/PresetPanel.tsx frontend/src/debug/debug.css
git commit -m "feat(debug): flag preset blocks overridden by the character card"
```

---

## 手动走查（全部 Task 完成后）

前端没有测试基建，行为验收靠这 7 条。跑 `cd frontend && npm run dev`，开调试台。

- [ ] **1. 改 role** —— 导入示例预设 → `main` 行点 `⋯` → 角色切到 `user` → 确定 →
      左栏徽章变 `USER`；开「完整提示词」，该条 role 是 user。
- [ ] **2. 行注释** —— `main` 块开头加一行 `// 测试注释` → 弹窗底部显示
      「1 行注释已排除」且 token 数下降 → 确定 → 完整提示词里**看不到**这行。
- [ ] **3. 整块注释** —— 把某块每一行都加 `//` 前缀 → 「被跳过」标签页出现该块，
      原因是「全部被注释」。
- [ ] **4. URL 不被切** —— 块里写 `见 https://example.com` → 完整提示词里**原样保留**。
- [ ] **5. 拖拽 + 落盘** —— 拖 `jailbreak` 到 `chatHistory` 之前 → 完整提示词里顺序变了 →
      面板出现脏点 → 点「存」→ 刷新页面，顺序保持。
- [ ] **6. 拖拽可回滚** —— 再拖一次但**不点存** → 点「↺ 恢复」→ 顺序回到保存时的样子。
- [ ] **7. 卡覆盖** —— 给当前卡的 `system_prompt` 填几个字（卡编辑抽屉里）→
      `main` 行出现「被卡覆盖」白底徽章 → 点 `⋯` 里勾上「禁止角色卡覆盖」→ 确定 →
      徽章消失，完整提示词里恢复成预设原文。
