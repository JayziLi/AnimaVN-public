# 角色「开始游戏」中枢屏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在角色选择网格和正式对话界面之间插入一个"开始游戏"中枢屏（角色主页），展示角色立绘 + 新游戏/继续游戏/选择模型/选择角色四个入口，并带有斜切板块 + 错峰滑入的转场动画。

**Architecture:** 新增一个 `CharacterHome` 组件承接原来分散在 `App.tsx` 的 `enterCharacter` 里的会话恢复/新建逻辑；`App.tsx` 的 `phase` 状态机从三态扩展为四态（`loading/select/hub/game`），角色网格点击变成纯本地状态切换，不再直接发网络请求。视觉与动画规格照抄 `%USERPROFILE%\Downloads\Galgame React前端设计\AnimaVN.dc.html` 里已经画好的 `isCharHome` 分支，只是把内联样式换成本仓库一贯的 CSS class + `clamp()`。

**Tech Stack:** React 19 + TypeScript（无 JSX 运行时以外的框架），纯 CSS（无 CSS-in-JS/Tailwind），Vite 8，oxlint。前端没有配置任何自动化测试框架（无 Jest/Vitest），本项目一贯靠 `npm run build`（`tsc -b` 类型检查）+ `npm run lint`（oxlint）+ 真实浏览器手动/Playwright 验证，本计划沿用这个约定，不额外引入测试框架。

## Global Constraints

- 不引入新依赖；不新建测试框架。
- CSS 一律加进 `frontend/src/App.css`（仓库现有约定：所有屏幕的样式都在这一个文件里，不拆分组件级 CSS 文件）。
- 字号/间距沿用仓库现有写法：字号用 `clamp(min, vw, max)`，纯几何/间距用直接的 `%`/`vw`（参见 `App.css` 里 `.screen-glow`、`.select-header` 等已有写法）。
- 主题变量已经在 `frontend/src/theme.ts` 里全部定义好（`--accent`、`--ink`、`--panel` 等），新代码直接用 `var(--xxx, 兜底值)`，不新增主题变量。
- 参考设计文件里角色数据带了 `en`（罗马音/英文名）字段，但本仓库真实的 `Character` 类型（`frontend/src/types.ts`）没有这个字段，也不在本次范围内新增后端字段——实现时直接省略这一行，只显示中文名。

---

## 文件改动总览

| 文件 | 改动 |
|---|---|
| `frontend/src/lib/format.ts` | 新建，提供共享的 `formatTimestamp` |
| `frontend/src/components/SaveLoadModal.tsx` | 改为从 `lib/format` 导入 `formatTimestamp`，删掉本地重复实现 |
| `frontend/src/components/CharacterSelect.tsx` | 卡片点击从"直接进游戏"改成"选中→交给上层"；删掉不再需要的 busy/error 展示 |
| `frontend/src/App.css` | 追加 `.charhome-*` 系列样式 + 4 个新 keyframes；删掉现在没用的 `.character-card.busy` |
| `frontend/src/components/CharacterHome.tsx` | 新建，"开始游戏"中枢屏组件 |
| `frontend/src/App.tsx` | `phase` 加入 `"hub"`；`enterCharacter` 拆解到 `CharacterHome`；新增 `selectCharacter`/`backToSelect`/`startGame`；`GameScreen` 的 `onExit` 从"回选角"改成"回中枢屏" |

---

### Task 1: 抽出共享的时间戳格式化函数

**Files:**
- Create: `frontend/src/lib/format.ts`
- Modify: `frontend/src/components/SaveLoadModal.tsx:1-26`

**Interfaces:**
- Produces: `formatTimestamp(iso: string): string` — 输入 ISO 时间字符串，输出 `"M/DD HH:mm"` 格式（和 `SaveLoadModal.tsx` 现有实现完全一致）。Task 4 的 `CharacterHome.tsx` 会用到它。

- [ ] **Step 1: 新建 `frontend/src/lib/format.ts`**

```ts
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
```

- [ ] **Step 2: 让 `SaveLoadModal.tsx` 改用这个共享函数**

把文件开头的 import 块：

```ts
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { splitInitial } from "../lib/history";
import { buildExportBundle, downloadExportBundle, readImportFile } from "../lib/saveTransfer";
import { sceneLabel } from "../lib/sceneLabel";
import type { Character, DialogueLine, GameSession, HistoryEntry } from "../types";
```

改成：

```ts
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { formatTimestamp } from "../lib/format";
import { splitInitial } from "../lib/history";
import { buildExportBundle, downloadExportBundle, readImportFile } from "../lib/saveTransfer";
import { sceneLabel } from "../lib/sceneLabel";
import type { Character, DialogueLine, GameSession, HistoryEntry } from "../types";
```

然后删掉文件里原有的这一段本地实现（紧跟在 import 之后、`PAGE_SIZE` 常量之前）：

```ts
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
```

- [ ] **Step 3: 类型检查 + lint**

Run: `cd frontend && npm run build && npm run lint`
Expected: 两条命令都 0 error 退出；`build` 输出里能看到 `dist/` 产物构建成功。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/format.ts frontend/src/components/SaveLoadModal.tsx
git commit -m "refactor: extract shared formatTimestamp into lib/format"
```

---

### Task 2: 简化 `CharacterSelect` —— 卡片点击不再直接进游戏

**Files:**
- Modify: `frontend/src/components/CharacterSelect.tsx`
- Modify: `frontend/src/App.css:827-830`（删除 `.character-card.busy`，这个类改完之后没有任何地方会加上）

**Interfaces:**
- Produces: `CharacterSelect` 的 `Props.onSelect: (character: Character) => void`（替换掉原来的 `onEnter`），以及去掉了 `busyCharacterId`/`error` 这两个 prop。Task 6（App.tsx 改造）依赖这个新签名。

- [ ] **Step 1: 改 `Props` 接口**

把：

```tsx
interface Props {
  characters: Character[];
  lastCharacterId: string | null;
  busyCharacterId: string | null;
  error: string | null;
  theme: ThemeName;
  onThemeChange: (theme: ThemeName) => void;
  onEnter: (character: Character) => void;
  onCreated: (character: Character) => void;
  onUpdated: (character: Character) => void;
  onDeleted: (id: string) => void;
  onOpenConnections: () => void;
}
```

改成：

```tsx
interface Props {
  characters: Character[];
  lastCharacterId: string | null;
  theme: ThemeName;
  onThemeChange: (theme: ThemeName) => void;
  onSelect: (character: Character) => void;
  onCreated: (character: Character) => void;
  onUpdated: (character: Character) => void;
  onDeleted: (id: string) => void;
  onOpenConnections: () => void;
}
```

- [ ] **Step 2: 改函数参数解构**

把：

```tsx
export function CharacterSelect({
  characters,
  lastCharacterId,
  busyCharacterId,
  error,
  theme,
  onThemeChange,
  onEnter,
  onCreated,
  onUpdated,
  onDeleted,
  onOpenConnections,
}: Props) {
```

改成：

```tsx
export function CharacterSelect({
  characters,
  lastCharacterId,
  theme,
  onThemeChange,
  onSelect,
  onCreated,
  onUpdated,
  onDeleted,
  onOpenConnections,
}: Props) {
```

- [ ] **Step 3: 删掉错误横幅**

删除这一行（在 `<div className="select-divider" />` 之后）：

```tsx
{error && <div className="error-banner select-error">出错了: {error}</div>}
```

- [ ] **Step 4: 简化卡片渲染，去掉 busy 状态**

把：

```tsx
          {characters.map((c) => {
            const portrait = Object.values(c.sprites)[0] ?? null;
            const busy = busyCharacterId === c.id;
            return (
              <button
                key={c.id}
                className={`character-card${c.id === lastCharacterId ? " active" : ""}${busy ? " busy" : ""}`}
                onClick={() => !busyCharacterId && onEnter(c)}
              >
                <span className="character-portrait">
                  {portrait ? (
                    <img src={portrait} alt={c.name} className="character-portrait-img" />
                  ) : (
                    <span className="character-portrait-label">SPRITE</span>
                  )}
                  <span
                    className="character-edit-chip"
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      setModal({ mode: "edit", character: c });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        setModal({ mode: "edit", character: c });
                      }
                    }}
                  >
                    编辑
                  </span>
                </span>
                <span className="character-name">{c.name}</span>
                <span className="character-tag">{c.tagline || "未设定"}</span>
                <span className="character-desc">
                  {busy ? "进入中……" : c.description || "尚未填写简介"}
                </span>
              </button>
            );
          })}
```

改成：

```tsx
          {characters.map((c) => {
            const portrait = Object.values(c.sprites)[0] ?? null;
            return (
              <button
                key={c.id}
                className={`character-card${c.id === lastCharacterId ? " active" : ""}`}
                onClick={() => onSelect(c)}
              >
                <span className="character-portrait">
                  {portrait ? (
                    <img src={portrait} alt={c.name} className="character-portrait-img" />
                  ) : (
                    <span className="character-portrait-label">SPRITE</span>
                  )}
                  <span
                    className="character-edit-chip"
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      setModal({ mode: "edit", character: c });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        setModal({ mode: "edit", character: c });
                      }
                    }}
                  >
                    编辑
                  </span>
                </span>
                <span className="character-name">{c.name}</span>
                <span className="character-tag">{c.tagline || "未设定"}</span>
                <span className="character-desc">{c.description || "尚未填写简介"}</span>
              </button>
            );
          })}
```

- [ ] **Step 5: 删掉 `App.css` 里现在没用的 `.character-card.busy`**

在 `frontend/src/App.css` 里删除这一段（紧跟在 `.character-card.active` 之后）：

```css
.character-card.busy {
  opacity: 0.7;
  cursor: wait;
}
```

- [ ] **Step 6: 类型检查（这一步会先报错，是预期的——`App.tsx` 还没跟着改）**

Run: `cd frontend && npm run build`
Expected: FAIL，报错信息里应该能看到 `App.tsx` 里传给 `<CharacterSelect>` 的 `onEnter`/`busyCharacterId`/`error` 找不到对应的 prop。这是正常的，Task 6 会把 `App.tsx` 一起改掉；先确认失败原因确实只和这几个 prop 有关，不是别的语法错误。

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/CharacterSelect.tsx frontend/src/App.css
git commit -m "refactor: CharacterSelect only reports selection, no longer enters the game directly"
```

（`App.tsx` 会在 Task 6 里跟进改动，到时候 build 才会重新变绿——这一步先接受它是红的。）

---

### Task 3: 追加"开始游戏"中枢屏的 CSS

**Files:**
- Modify: `frontend/src/App.css`（追加到文件末尾，第 1387 行 `}` 之后）

**Interfaces:**
- Produces：一整套 `.charhome-*` class（供 Task 4 的 `CharacterHome.tsx` 使用）+ 4 个 keyframes：`charhomeSlideInLeft`、`charhomeSlideInRight`、`charhomeSlideOutLeft`、`charhomeSlideOutRight`。

- [ ] **Step 1: 在 `App.css` 末尾追加以下内容**

```css

/* --- character home (start-game hub) --- */
@keyframes charhomeSlideInLeft {
  from {
    opacity: 0;
    transform: translateX(-6%);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

@keyframes charhomeSlideInRight {
  from {
    opacity: 0;
    transform: translateX(4%);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

@keyframes charhomeSlideOutLeft {
  from {
    opacity: 1;
    transform: translateX(0);
  }
  to {
    opacity: 0;
    transform: translateX(-6%);
  }
}

@keyframes charhomeSlideOutRight {
  from {
    opacity: 1;
    transform: translateX(0);
  }
  to {
    opacity: 0;
    transform: translateX(4%);
  }
}

.charhome-screen {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: var(--bg, #141119);
  color: var(--ink, #ece8f2);
  font-family: var(--font-ui, "Noto Sans SC", sans-serif);
}

.charhome-body {
  position: relative;
  z-index: 2;
  height: 100%;
  width: 100%;
  display: flex;
  overflow: hidden;
}

.charhome-watermark {
  position: absolute;
  right: 3%;
  bottom: -15%;
  font-family: var(--font-body, "Noto Serif SC", serif);
  font-weight: 300;
  font-size: clamp(160px, 21vw, 340px);
  line-height: 1;
  color: var(--ink, #ece8f2);
  opacity: 0.05;
  pointer-events: none;
  animation: fadeIn 1.1s ease 0.25s both;
}

.charhome-enginemark {
  position: absolute;
  right: 1.1vw;
  top: 50%;
  transform: translateY(-50%);
  writing-mode: vertical-rl;
  font-family: var(--font-display, "Josefin Sans", sans-serif);
  font-size: clamp(9px, 0.68vw, 13px);
  letter-spacing: 0.5em;
  color: var(--ink-soft, #a79fb8);
  opacity: 0.55;
  pointer-events: none;
  animation: fadeIn 1s ease 0.55s both;
}

.charhome-portrait {
  position: relative;
  width: 42%;
  height: 100%;
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background-color: var(--accent-soft, rgba(198, 164, 232, 0.14));
  background-image: repeating-linear-gradient(
    135deg,
    rgba(150, 120, 180, 0.14) 0 14px,
    transparent 14px 28px
  );
  clip-path: polygon(0 0, 100% 0, calc(100% - clamp(24px, 3.2vw, 58px)) 100%, 0 100%);
  overflow: hidden;
  animation: charhomeSlideInLeft 0.65s cubic-bezier(0.22, 0.8, 0.3, 1) both;
}

.charhome-portrait.leaving {
  animation: charhomeSlideOutLeft 0.4s cubic-bezier(0.4, 0, 1, 0.6) both;
}

.charhome-portrait-img {
  height: 96%;
  max-width: 100%;
  object-fit: contain;
  object-position: bottom;
  filter: drop-shadow(0 16px 34px rgba(0, 0, 0, 0.35));
}

.charhome-portrait-placeholder {
  font-family: var(--font-display, "Josefin Sans", sans-serif);
  font-size: clamp(12px, 1vw, 18px);
  letter-spacing: 0.14em;
  color: var(--ink-soft, #a79fb8);
  margin-bottom: 46%;
}

.charhome-portrait-index {
  position: absolute;
  top: 1.8vw;
  left: 1.8vw;
  display: flex;
  flex-direction: column;
  gap: 0.25vw;
}

.charhome-portrait-index-num {
  font-family: var(--font-display, "Josefin Sans", sans-serif);
  font-weight: 300;
  font-size: clamp(22px, 2.4vw, 40px);
  line-height: 1;
  color: var(--accent, #c6a4e8);
}

.charhome-portrait-index-label {
  font-family: var(--font-display, "Josefin Sans", sans-serif);
  font-size: clamp(8px, 0.68vw, 12px);
  letter-spacing: 0.34em;
  color: var(--ink-soft, #a79fb8);
}

.charhome-portrait-scrim {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 24%;
  background: linear-gradient(180deg, transparent, rgba(0, 0, 0, 0.16));
  pointer-events: none;
}

.charhome-seam {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 40.6%;
  width: 2px;
  background: var(--accent, #c6a4e8);
  opacity: 0.5;
  transform: skewX(-2.6deg);
  pointer-events: none;
  animation: fadeIn 0.8s ease 0.3s both;
}

.charhome-menu-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: clamp(16px, 1.5vw, 28px);
  padding: 0 8% 0 6.5%;
}

.charhome-menu-col.leaving > * {
  animation: charhomeSlideOutRight 0.35s cubic-bezier(0.4, 0, 1, 0.6) both;
}

.charhome-heading-block {
  display: flex;
  flex-direction: column;
  gap: 0.55vw;
  animation: charhomeSlideInRight 0.55s cubic-bezier(0.22, 0.8, 0.3, 1) 0.15s both;
}

.charhome-tag {
  font-family: var(--font-display, "Josefin Sans", sans-serif);
  font-weight: 300;
  font-size: clamp(11px, 0.85vw, 15px);
  letter-spacing: 0.4em;
  color: var(--accent-2, #e58ba6);
}

.charhome-name {
  font-family: var(--font-display, "Josefin Sans", sans-serif);
  font-weight: 400;
  font-size: clamp(30px, 3.6vw, 64px);
  line-height: 1.15;
  letter-spacing: 0.08em;
  color: var(--ink, #ece8f2);
}

.charhome-desc {
  font-size: clamp(12px, 0.92vw, 16px);
  color: var(--ink-soft, #a79fb8);
  line-height: 1.6;
  max-width: 30vw;
}

.charhome-quote {
  border-left: 2px solid var(--accent, #c6a4e8);
  padding: 0.4vw 0 0.4vw 1.2vw;
  max-width: 28vw;
  animation: charhomeSlideInRight 0.55s cubic-bezier(0.22, 0.8, 0.3, 1) 0.26s both;
}

.charhome-quote-text {
  font-family: var(--font-body, "Noto Serif SC", serif);
  font-weight: 300;
  font-size: clamp(13px, 1.05vw, 19px);
  line-height: 1.7;
  color: var(--ink, #ece8f2);
}

.charhome-quote-label {
  font-family: var(--font-display, "Josefin Sans", sans-serif);
  font-size: clamp(8px, 0.62vw, 11px);
  letter-spacing: 0.3em;
  color: var(--ink-soft, #a79fb8);
  margin-top: 0.5vw;
}

.charhome-menu {
  display: flex;
  flex-direction: column;
  gap: 0.9vw;
  width: min(340px, 26vw);
}

.charhome-menu-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.85vw 1.4vw;
  border-radius: var(--radius, 12px);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  background: var(--panel, rgba(22, 20, 32, 0.6));
  color: var(--ink, #ece8f2);
  font-family: var(--font-ui, "Noto Sans SC", sans-serif);
  font-size: clamp(13px, 1.1vw, 19px);
  letter-spacing: 0.1em;
  cursor: pointer;
  width: 100%;
  animation: charhomeSlideInRight 0.5s cubic-bezier(0.22, 0.8, 0.3, 1) both;
  transition:
    border-color 0.15s ease,
    transform 0.15s ease;
}

.charhome-menu > *:nth-child(1) {
  animation-delay: 0.36s;
}

.charhome-menu > *:nth-child(2) {
  animation-delay: 0.45s;
}

.charhome-menu > *:nth-child(3) {
  animation-delay: 0.54s;
}

.charhome-menu > *:nth-child(4) {
  animation-delay: 0.63s;
}

.charhome-menu-btn:hover:not(:disabled) {
  border-color: var(--accent, #c6a4e8);
  transform: translateY(-1px);
}

.charhome-menu-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.charhome-menu-btn.primary {
  border: none;
  background: var(--accent, #c6a4e8);
  color: var(--accent-ink, #17121f);
}

.charhome-menu-btn-en {
  font-family: var(--font-display, "Josefin Sans", sans-serif);
  font-size: 0.75em;
  letter-spacing: 0.22em;
  opacity: 0.75;
}

.charhome-footer {
  display: flex;
  gap: 2.2vw;
  font-family: var(--font-display, "Josefin Sans", sans-serif);
  font-size: clamp(9px, 0.7vw, 13px);
  letter-spacing: 0.16em;
  color: var(--ink-soft, #a79fb8);
  animation: charhomeSlideInRight 0.55s cubic-bezier(0.22, 0.8, 0.3, 1) 0.75s both;
}

.charhome-error {
  margin-top: 4px;
}
```

- [ ] **Step 2: lint（纯 CSS 追加，`npm run build` 不会验证 CSS 语法错误之外的东西，跑一下 lint 保底）**

Run: `cd frontend && npm run lint`
Expected: 0 error（这一步 `npm run build` 预期仍然是红的，因为 Task 2 引入的 prop 改动还没有对应的 `App.tsx` 改动——这没关系，等 Task 6）。

- [ ] **Step 3: Commit**

```bash
git add frontend/src/App.css
git commit -m "style: add charhome-* styles and slide keyframes for the start-game hub"
```

---

### Task 4: 新建 `CharacterHome` 组件

**Files:**
- Create: `frontend/src/components/CharacterHome.tsx`

**Interfaces:**
- Consumes：`api.listSessions`、`api.getHistory`、`api.createSession`（`frontend/src/api/client.ts`，签名见下）；`splitInitial`（`frontend/src/lib/history.ts:18`，签名 `(messages: MessageOut[]) => {history: HistoryEntry[]; pending: DialogueLine[]}`）；`formatTimestamp`（Task 1 产出）；`ThemeSwitcher`（`frontend/src/components/ThemeSwitcher.tsx`，props `{theme, onChange}`）；Task 3 产出的 `.charhome-*` CSS class。
- Produces：`CharacterHome` 组件，props 见下方代码。Task 6 的 `App.tsx` 会引入并渲染它。

- [ ] **Step 1: 新建 `frontend/src/components/CharacterHome.tsx`**

```tsx
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { formatTimestamp } from "../lib/format";
import { splitInitial } from "../lib/history";
import type { ThemeName } from "../theme";
import type { Character, DialogueLine, GameSession, HistoryEntry, ModelOption } from "../types";
import { ThemeSwitcher } from "./ThemeSwitcher";

interface Props {
  character: Character;
  characters: Character[];
  models: ModelOption[];
  activeConnectionId: string | undefined;
  theme: ThemeName;
  onThemeChange: (theme: ThemeName) => void;
  onStart: (payload: { session: GameSession; history: HistoryEntry[]; pending: DialogueLine[] }) => void;
  onBack: () => void;
  onOpenConnections: () => void;
}

const EXIT_MS = 400;

export function CharacterHome({
  character,
  characters,
  models,
  activeConnectionId,
  theme,
  onThemeChange,
  onStart,
  onBack,
  onOpenConnections,
}: Props) {
  const [autoSession, setAutoSession] = useState<GameSession | null | undefined>(undefined);
  const [busy, setBusy] = useState<"new" | "continue" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAutoSession(undefined);
    api
      .listSessions({ character_id: character.id, is_autosave: true })
      .then((sessions) => {
        if (!cancelled) setAutoSession(sessions[0] ?? null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [character.id]);

  async function handleContinue() {
    if (!autoSession) return;
    setBusy("continue");
    setError(null);
    try {
      const messages = await api.getHistory(autoSession.id);
      const { history, pending } = splitInitial(messages);
      onStart({ session: autoSession, history, pending });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  async function handleNewGame() {
    setBusy("new");
    setError(null);
    try {
      const hadProgress = Boolean(autoSession);
      const session = await api.createSession(character.id, "Autosave");
      const messages = await api.getHistory(session.id);
      const { history, pending } = splitInitial(messages);
      if (hadProgress) {
        setHint("已开始新游戏 · 原有存档不会被删除");
        await new Promise((resolve) => window.setTimeout(resolve, 1400));
      }
      onStart({ session, history, pending });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  function handleBack() {
    if (busy) return;
    setLeaving(true);
    window.setTimeout(onBack, EXIT_MS);
  }

  const portraitSrc = Object.values(character.sprites)[0] ?? null;
  const charIndex = String(Math.max(0, characters.findIndex((c) => c.id === character.id)) + 1).padStart(
    2,
    "0",
  );
  const modelLabel = models.find((m) => m.id === activeConnectionId)?.label ?? "未设置";

  return (
    <div className="charhome-screen">
      <div className="select-topbar">
        <ThemeSwitcher theme={theme} onChange={onThemeChange} />
      </div>

      <div className="charhome-body">
        <span className="charhome-watermark">{character.name.slice(-1)}</span>
        <span className="charhome-enginemark">ANIMAVN · GALGAME AI ENGINE</span>

        <div className={`charhome-portrait${leaving ? " leaving" : ""}`}>
          {portraitSrc ? (
            <img src={portraitSrc} alt={character.name} className="charhome-portrait-img" />
          ) : (
            <span className="charhome-portrait-placeholder">SPRITE</span>
          )}
          <span className="charhome-portrait-index">
            <span className="charhome-portrait-index-num">{charIndex}</span>
            <span className="charhome-portrait-index-label">CHARACTER FILE</span>
          </span>
          <span className="charhome-portrait-scrim" />
        </div>

        <div className="charhome-seam" />

        <div className={`charhome-menu-col${leaving ? " leaving" : ""}`}>
          <div className="charhome-heading-block">
            <span className="charhome-tag">{character.tagline || "未设定"}</span>
            <span className="charhome-name">{character.name}</span>
            <span className="charhome-desc">{character.description || "尚未填写简介"}</span>
          </div>

          <div className="charhome-quote">
            <div className="charhome-quote-text">「{character.greeting || "尚未设定开场白"}」</div>
            <div className="charhome-quote-label">OPENING LINE · 开场白</div>
          </div>

          <div className="charhome-menu">
            <button className="charhome-menu-btn primary" disabled={busy !== null} onClick={handleNewGame}>
              {busy === "new" ? "创建中…" : "新游戏"}
              <span className="charhome-menu-btn-en">NEW GAME</span>
            </button>
            <button
              className="charhome-menu-btn"
              disabled={!autoSession || busy !== null}
              onClick={handleContinue}
            >
              {busy === "continue" ? "读取中…" : "继续游戏"}
              <span className="charhome-menu-btn-en">{autoSession === null ? "暂无进度" : "CONTINUE"}</span>
            </button>
            <button className="charhome-menu-btn" disabled={busy !== null} onClick={onOpenConnections}>
              选择模型
              <span className="charhome-menu-btn-en">MODEL</span>
            </button>
            <button className="charhome-menu-btn" disabled={busy !== null} onClick={handleBack}>
              选择角色
              <span className="charhome-menu-btn-en">CHARACTER</span>
            </button>
          </div>

          <div className="charhome-footer">
            <span>MODEL · {modelLabel}</span>
            <span>AUTOSAVE · {autoSession ? formatTimestamp(autoSession.updated_at) : "尚未开始"}</span>
          </div>

          {error && <div className="error-banner charhome-error">出错了: {error}</div>}
          {hint && <div className="select-hint charhome-error">{hint}</div>}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 类型检查 + lint**

Run: `cd frontend && npm run build && npm run lint`
Expected: `npm run lint` 应该 0 error（这个新文件本身没有依赖还没改完的 `App.tsx`）。`npm run build` 这一步预期仍然是红的——`App.tsx` 还没接入 `CharacterHome`，也还没跟 `CharacterSelect` 的新 props 对齐，报错信息应该集中在 `App.tsx` 里，不应该出现在 `CharacterHome.tsx` 里。如果 `CharacterHome.tsx` 本身报类型错，先修好它。

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/CharacterHome.tsx
git commit -m "feat: add CharacterHome start-game hub component"
```

---

### Task 5: 接入 `App.tsx` —— 打通 select → hub → game 的完整流程

**Files:**
- Modify: `frontend/src/App.tsx`（整份重写，改动点太分散，直接给出完整新文件内容）

**Interfaces:**
- Consumes：Task 2 的 `CharacterSelect` 新 props（`onSelect` 替代 `onEnter`，去掉 `busyCharacterId`/`error`）；Task 4 的 `CharacterHome` props。
- Produces：`App` 组件内部新增 `phase: "hub"`、`selectedCharacter` state、`selectCharacter`/`backToSelect`/`startGame`/`exitToHub` 四个 handler，供本文件自己的 JSX 使用（不对外暴露）。

- [ ] **Step 1: 用以下内容整份替换 `frontend/src/App.tsx`**

```tsx
import { useCallback, useEffect, useState } from "react";
import { api } from "./api/client";
import "./App.css";
import { CharacterHome } from "./components/CharacterHome";
import { CharacterSelect } from "./components/CharacterSelect";
import { ConnectionsPanel } from "./components/ConnectionsPanel";
import { GameScreen } from "./components/GameScreen";
import { SaveLoadModal } from "./components/SaveLoadModal";
import { themeVars } from "./theme";
import type { ThemeName } from "./theme";
import type { Character, DialogueLine, GameSession, HistoryEntry, ModelOption } from "./types";

const THEME_KEY = "animavn:theme";
const LAST_CHARACTER_KEY = "animavn:lastCharacter";

interface ActiveGame {
  character: Character;
  session: GameSession;
  history: HistoryEntry[];
  pending: DialogueLine[];
}

export default function App() {
  const [phase, setPhase] = useState<"loading" | "select" | "hub" | "game">("loading");
  const [characters, setCharacters] = useState<Character[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [activeConnectionId, setActiveConnectionId] = useState<string | undefined>(undefined);
  const [selectedCharacter, setSelectedCharacter] = useState<Character | null>(null);
  const [game, setGame] = useState<ActiveGame | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [showConnections, setShowConnections] = useState(false);
  const [saveLoadMode, setSaveLoadMode] = useState<"save" | "load" | null>(null);
  const [lastCharacterId, setLastCharacterId] = useState<string | null>(
    () => localStorage.getItem(LAST_CHARACTER_KEY),
  );
  const [theme, setTheme] = useState<ThemeName>(
    () => (localStorage.getItem(THEME_KEY) as ThemeName | null) ?? "nocturne",
  );

  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const refreshModels = useCallback(async () => {
    try {
      const [modelOptions, connections] = await Promise.all([
        api.listModels(),
        api.listConnections(),
      ]);
      setModels(modelOptions);
      setActiveConnectionId(connections.find((c) => c.is_active)?.id);
    } catch {
      // 面板/弹层里已有各自的错误提示,这里静默即可
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const [characterList, modelOptions, connections] = await Promise.all([
          api.listCharacters(),
          api.listModels(),
          api.listConnections(),
        ]);
        if (cancelled) return;
        setCharacters(characterList);
        setModels(modelOptions);
        setActiveConnectionId(connections.find((c) => c.is_active)?.id);
        setPhase("select");
      } catch (e) {
        if (!cancelled) setBootError(e instanceof Error ? e.message : String(e));
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectCharacter = useCallback((character: Character) => {
    localStorage.setItem(LAST_CHARACTER_KEY, character.id);
    setLastCharacterId(character.id);
    setSelectedCharacter(character);
    setPhase("hub");
  }, []);

  const backToSelect = useCallback(() => {
    setSelectedCharacter(null);
    setPhase("select");
  }, []);

  const startGame = useCallback(
    (payload: { session: GameSession; history: HistoryEntry[]; pending: DialogueLine[] }) => {
      if (!selectedCharacter) return;
      setGame({
        character: selectedCharacter,
        session: payload.session,
        history: payload.history,
        pending: payload.pending,
      });
      setPhase("game");
    },
    [selectedCharacter],
  );

  const exitToHub = useCallback(() => {
    setGame(null);
    setPhase("hub");
  }, []);

  const handleSaveLoadLoaded = useCallback(
    ({
      session,
      history,
      pending,
    }: {
      session: GameSession;
      history: HistoryEntry[];
      pending: DialogueLine[];
    }) => {
      setGame((prev) => (prev ? { character: prev.character, session, history, pending } : prev));
    },
    [],
  );

  const handleCharacterCreated = useCallback((c: Character) => {
    setCharacters((prev) => [...prev, c]);
  }, []);

  const handleCharacterUpdated = useCallback((c: Character) => {
    setCharacters((prev) => prev.map((it) => (it.id === c.id ? c : it)));
  }, []);

  const handleCharacterDeleted = useCallback((id: string) => {
    setCharacters((prev) => prev.filter((it) => it.id !== id));
    if (localStorage.getItem(LAST_CHARACTER_KEY) === id) {
      localStorage.removeItem(LAST_CHARACTER_KEY);
      setLastCharacterId(null);
    }
  }, []);

  if (bootError) {
    return (
      <div style={themeVars(theme)} className="boot-error">
        加载失败: {bootError}
      </div>
    );
  }

  return (
    <div style={themeVars(theme)} className="app-shell">
      {phase === "loading" && <div className="boot-loading">加载中……</div>}

      {phase === "select" && (
        <CharacterSelect
          characters={characters}
          lastCharacterId={lastCharacterId}
          theme={theme}
          onThemeChange={setTheme}
          onSelect={selectCharacter}
          onCreated={handleCharacterCreated}
          onUpdated={handleCharacterUpdated}
          onDeleted={handleCharacterDeleted}
          onOpenConnections={() => setShowConnections(true)}
        />
      )}

      {phase === "hub" && selectedCharacter && (
        <CharacterHome
          character={selectedCharacter}
          characters={characters}
          models={models}
          activeConnectionId={activeConnectionId}
          theme={theme}
          onThemeChange={setTheme}
          onStart={startGame}
          onBack={backToSelect}
          onOpenConnections={() => setShowConnections(true)}
        />
      )}

      {phase === "game" && game && (
        <GameScreen
          key={game.session.id}
          character={game.character}
          session={game.session}
          initialHistory={game.history}
          initialPending={game.pending}
          models={models}
          initialModelId={activeConnectionId}
          theme={theme}
          onThemeChange={setTheme}
          onExit={exitToHub}
          onOpenConnections={() => setShowConnections(true)}
          onOpenSave={() => setSaveLoadMode("save")}
          onOpenLoad={() => setSaveLoadMode("load")}
        />
      )}

      {showConnections && (
        <ConnectionsPanel onClose={() => setShowConnections(false)} onChanged={refreshModels} />
      )}

      {saveLoadMode && game && (
        <SaveLoadModal
          mode={saveLoadMode}
          character={game.character}
          sourceSessionId={game.session.id}
          onClose={() => setSaveLoadMode(null)}
          onLoaded={handleSaveLoadLoaded}
        />
      )}
    </div>
  );
}
```

注意这里有一个跟原来行为不同的地方：`GameScreen` 顶栏的「MENU」按钮（`onExit`）原来是直接回到角色网格（`phase="select"`），现在改成回到该角色的中枢屏（`phase="hub"`，`exitToHub`）。理由：中枢屏现在承担了"角色主页/菜单"的角色，从对话里点 MENU 回到菜单页、再从菜单页点「选择角色」才回网格，比直接跳回网格更符合"MENU"这个按钮名字的直觉，也让中枢屏在"选角进入"之外多一个自然的到达路径。如果实测下来觉得别扭，把 `onExit={exitToHub}` 改回 `onExit={backToSelect}` 即可，是一行改动。

- [ ] **Step 2: 类型检查 + lint**

Run: `cd frontend && npm run build && npm run lint`
Expected: 两条命令都 0 error。这一步应该是从 Task 2/3/4 开始累积的红状态第一次转绿——如果还有报错，逐条看是不是 prop 名字或类型没对上。

- [ ] **Step 3: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat: wire CharacterHome into App as a hub phase between select and game"
```

---

### Task 6: 真实浏览器端到端验证

**Files:** 无代码改动，仅验证。

**Interfaces:** 无。

- [ ] **Step 1: 启动后端**

Run（新开一个终端，保持常驻）:
```
cd backend && .venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```
Expected: 日志里出现 `Uvicorn running on http://127.0.0.1:8000`。

- [ ] **Step 2: 启动前端**

Run（再开一个终端，保持常驻）:
```
cd frontend && npm run dev
```
Expected: 输出里出现 `Local: http://localhost:5173/`。

- [ ] **Step 3: 用 Playwright 打开首页，确认角色网格正常**

用 `mcp__playwright__browser_navigate` 打开 `http://localhost:5173`，然后 `mcp__playwright__browser_snapshot` 看一下页面结构。
Expected: 能看到 `CHARACTER` 标题和角色卡片网格（如果之前测试留下过角色数据）；如果列表是空的，先用页面上的"＋ NEW · 新建角色"建一个测试角色（至少填 name，greeting 留空也行）。

- [ ] **Step 4: 点击一张角色卡，验证转场到中枢屏**

用 `mcp__playwright__browser_click` 点某张角色卡片，然后 `browser_snapshot` + `browser_take_screenshot`。
Expected:
- 立刻跳转到中枢屏（不再是直接进对话）。
- 左侧能看到立绘板块（有斜切边），右侧能看到角色名、简介、开场白引用、四个菜单按钮（新游戏 / 继续游戏 / 选择模型 / 选择角色）。
- 如果这个角色还没有任何存档，「继续游戏」按钮应该是禁用状态，右下角 footer 显示"AUTOSAVE · 尚未开始"。

- [ ] **Step 5: 验证"新游戏"能正常进入对话**

点击"新游戏"按钮，等待跳转。
Expected: 进入 `GameScreen`（能看到对话框、输入框、顶栏的 LOG/SAVE/LOAD/MODEL/MENU 按钮），开场白台词开始逐句播放。

- [ ] **Step 6: 验证"MENU"回到中枢屏，"继续游戏"能读回刚才的对话**

点顶栏"MENU"按钮。
Expected: 回到该角色的中枢屏，这次「继续游戏」应该已经可点（因为上一步创建了自动存档），footer 的 AUTOSAVE 时间戳更新为刚才的时间。

点击"继续游戏"。
Expected: 重新进入 `GameScreen`，能看到刚才的开场白台词（走的是历史记录路径，不是重新播放待播队列）。

- [ ] **Step 7: 验证"选择模型"和"选择角色"两个出口**

从中枢屏（重复 Step 6 回到中枢屏）点击"选择模型"。
Expected: 弹出连接设置面板（`ConnectionsPanel`），和从角色网格点"API · 连接设置"弹出的是同一个面板。关掉它。

点击"选择角色"。
Expected: 立绘板块向左划出、右侧菜单板块向右划出（和进入时方向相反），大约 400ms 后回到角色网格页面。

- [ ] **Step 8: 验证"新游戏"在已有存档时的非阻断提示**

再次点击刚才那张角色卡进入中枢屏（这时已经有自动存档），点击"新游戏"。
Expected: 短暂出现"已开始新游戏 · 原有存档不会被删除"提示，不需要任何二次确认点击，随后自动进入一局新的对话（开场白重新从头播放）。

- [ ] **Step 9: 记录结果**

如果以上步骤全部符合预期，任务完成，不需要额外提交（Task 6 不改代码）。如果某一步不符合预期，回到对应 Task 修代码，改完重新跑 Task 6 里失败的那一步开始的步骤。
