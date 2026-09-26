# 全局顶部通知系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把项目里散落的好几套"报错/结果提示"展示(`ErrorToast`、各个 modal 里的 `.modal-error`、`ConnectionsPanel` 刚做的 `.conn-banner`）统一成一个由 `App.tsx` 持有状态的全局通知条：固定在浏览器视口最顶部，盖在所有内容(包括弹窗)之上，3.6 秒自动消失，同时右侧有一个手动关闭的 ✕。

**Architecture:** `App.tsx` 新增 `notification` state + `notify(kind, message)` 回调，新建 `GlobalNotice.tsx` 组件负责渲染。`notify` 作为 prop 逐个传给 `CharacterSelect`（转手给 `CharacterEditModal`）、`CharacterHome`、`GameScreen`、`ConnectionsPanel`、`SaveLoadModal`，这几个组件各自的本地错误/提示 state 和展示 JSX 被删掉，改成调用 `notify(...)`。`ErrorToast.tsx` 整个删除。

**Tech Stack:** React 19 + TypeScript，纯 CSS。前端没有配置任何自动化测试框架，验证靠 `npm run build`（`tsc -b` 类型检查）+ `npm run lint`（oxlint）+ 真实浏览器操作，延续本仓库一贯做法。

## Global Constraints

- 不新增测试框架。
- `CharacterSelect` 里"PNG 角色卡导入尚未支持"用的 `.select-hint`/`showHint` **不在本次改动范围内**——那是一个"功能还没做"的静态提示，不是某次操作成功/失败的结果，继续保留组件本地状态。
- 不做通知队列/多条堆叠——同一时刻只有一条通知，新的直接顶替旧的。
- 不改动后端。

---

## 文件改动总览

| 文件 | 改动 |
|---|---|
| `frontend/src/App.tsx` | 新增 `notification` state + `notify`/`dismissNotification`；渲染 `<GlobalNotice>`；依次给 6 个子组件传 `notify` |
| `frontend/src/components/GlobalNotice.tsx` | 新建 |
| `frontend/src/App.css` | 新增 `.global-notice` 系列样式；删除 `.error-toast*`、`.conn-banner*`/`connBannerIn`、`.error-banner`、`.charhome-error`；撤销 `.modal-body` 的 `position: relative` |
| `frontend/src/components/CharacterSelect.tsx` | 接 `notify` prop，转手给 `CharacterEditModal` |
| `frontend/src/components/CharacterEditModal.tsx` | 本地 `error` state 改成调用 `notify` |
| `frontend/src/components/CharacterHome.tsx` | 本地 `error`/`hint` state 改成调用 `notify`；`handleNewGame` 去掉不再需要的人工延迟 |
| `frontend/src/components/GameScreen.tsx` | 去掉 `<ErrorToast>`，改成监听 `engine.error` 调用 `notify` |
| `frontend/src/components/ErrorToast.tsx` | 删除 |
| `frontend/src/components/ConnectionsPanel.tsx` | 本地 `banner`/`showBanner` 整个删掉，改用 `notify` prop |
| `frontend/src/components/SaveLoadModal.tsx` | 本地 `error`/`hint` state 都改成调用 `notify` |

---

### Task 1: 全局通知状态 + `GlobalNotice` 组件 + CSS

**Files:**
- Modify: `frontend/src/App.tsx`
- Create: `frontend/src/components/GlobalNotice.tsx`
- Modify: `frontend/src/App.css`

**Interfaces:**
- Produces：`App.tsx` 内部的 `notify: (kind: "ok" | "error", message: string) => void`（这一步只在 `App` 内部创建，还不会传给任何子组件——子组件在后面几个 Task 里逐个接入）；`GlobalNotice` 组件，props `{ notification: {kind: "ok"|"error"; message: string} | null; onDismiss: () => void }`；CSS class `.global-notice`/`.global-notice.ok`/`.global-notice.error`/`.global-notice-message`/`.global-notice-close`，供 `GlobalNotice.tsx` 使用。

这一步是纯增量改动，不删任何东西，build 应该从头到尾保持绿色。

- [ ] **Step 1: 新建 `GlobalNotice.tsx`**

```tsx
interface Props {
  notification: { kind: "ok" | "error"; message: string } | null;
  onDismiss: () => void;
}

export function GlobalNotice({ notification, onDismiss }: Props) {
  if (!notification) return null;
  return (
    <div className={`global-notice ${notification.kind}`} role="alert">
      <span className="global-notice-message">{notification.message}</span>
      <button className="global-notice-close" onClick={onDismiss} aria-label="关闭">
        ✕
      </button>
    </div>
  );
}
```

- [ ] **Step 2: 在 `App.css` 末尾追加全局通知样式**

```css

/* --- global notice (fixed to the very top of the viewport) --- */
@keyframes globalNoticeIn {
  from {
    opacity: 0;
    transform: translateY(-100%);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.global-notice {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 200;
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 14px clamp(18px, 2vw, 36px);
  font-size: 0.92rem;
  line-height: 1.5;
  word-break: break-word;
  white-space: pre-wrap;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.3);
  animation: globalNoticeIn 0.3s cubic-bezier(0.22, 0.8, 0.3, 1) both;
}

.global-notice.error {
  background: rgba(140, 30, 30, 0.92);
  color: #f6d8d8;
  border-bottom: 1px solid rgba(220, 120, 120, 0.5);
}

.global-notice.ok {
  background: rgba(45, 120, 75, 0.92);
  color: #d7f5e0;
  border-bottom: 1px solid rgba(120, 220, 150, 0.5);
}

.global-notice-message {
  flex: 1;
  min-width: 0;
}

.global-notice-close {
  flex: 0 0 auto;
  background: none;
  border: none;
  color: inherit;
  font-size: 1.05rem;
  line-height: 1;
  cursor: pointer;
  opacity: 0.85;
}

.global-notice-close:hover {
  opacity: 1;
}
```

（`z-index: 200` 要盖过 `.modal-overlay` 的 120 和 `.backlog-overlay` 的 100，保证弹窗开着的时候通知条也能显示在最上面。）

- [ ] **Step 3: 给 `App.tsx` 加全局通知 state + 渲染 `<GlobalNotice>`**

把文件顶部的 import 块：

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
```

改成：

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api/client";
import "./App.css";
import { CharacterHome } from "./components/CharacterHome";
import { CharacterSelect } from "./components/CharacterSelect";
import { ConnectionsPanel } from "./components/ConnectionsPanel";
import { GameScreen } from "./components/GameScreen";
import { GlobalNotice } from "./components/GlobalNotice";
import { SaveLoadModal } from "./components/SaveLoadModal";
import { themeVars } from "./theme";
import type { ThemeName } from "./theme";
import type { Character, DialogueLine, GameSession, HistoryEntry, ModelOption } from "./types";
```

把：

```tsx
  const [theme, setTheme] = useState<ThemeName>(
    () => (localStorage.getItem(THEME_KEY) as ThemeName | null) ?? "nocturne",
  );

  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);
```

改成：

```tsx
  const [theme, setTheme] = useState<ThemeName>(
    () => (localStorage.getItem(THEME_KEY) as ThemeName | null) ?? "nocturne",
  );
  const [notification, setNotification] = useState<
    { kind: "ok" | "error"; message: string } | null
  >(null);
  const notifyTimer = useRef<number | undefined>(undefined);

  const notify = useCallback((kind: "ok" | "error", message: string) => {
    window.clearTimeout(notifyTimer.current);
    setNotification({ kind, message });
    notifyTimer.current = window.setTimeout(() => setNotification(null), 3600);
  }, []);

  const dismissNotification = useCallback(() => {
    window.clearTimeout(notifyTimer.current);
    setNotification(null);
  }, []);

  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);
```

把返回的 JSX 开头：

```tsx
  return (
    <div style={themeVars(theme)} className="app-shell">
      {phase === "loading" && <div className="boot-loading">加载中……</div>}
```

改成：

```tsx
  return (
    <div style={themeVars(theme)} className="app-shell">
      <GlobalNotice notification={notification} onDismiss={dismissNotification} />

      {phase === "loading" && <div className="boot-loading">加载中……</div>}
```

- [ ] **Step 4: 类型检查 + lint**

Run: `cd frontend && npm run build && npm run lint`
Expected: 两条命令都 0 error。这一步 `notify`/`dismissNotification` 还没有传给任何子组件，只是在 `App` 内部定义了但暂时用不到——TypeScript 不会因为一个函数"定义了但还没传出去"而报错，所以应该是干净的绿色。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/components/GlobalNotice.tsx frontend/src/App.css
git commit -m "feat: add global top-of-viewport notification state and component"
```

---

### Task 2: 接入 `CharacterSelect` + `CharacterEditModal`

**Files:**
- Modify: `frontend/src/components/CharacterSelect.tsx`
- Modify: `frontend/src/components/CharacterEditModal.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes：Task 1 的 `notify: (kind: "ok" | "error", message: string) => void`。
- Produces：`CharacterSelect`/`CharacterEditModal` 的 `Props` 都新增 `notify` 字段，供 `App.tsx` 传入。

- [ ] **Step 1: `CharacterEditModal.tsx` 改用 `notify`**

把：

```tsx
interface Props {
  /** null = 新建模式 */
  character: Character | null;
  onClose: () => void;
  onSaved: (character: Character) => void;
  onDeleted: (id: string) => void;
}
```

改成：

```tsx
interface Props {
  /** null = 新建模式 */
  character: Character | null;
  notify: (kind: "ok" | "error", message: string) => void;
  onClose: () => void;
  onSaved: (character: Character) => void;
  onDeleted: (id: string) => void;
}
```

把：

```tsx
export function CharacterEditModal({ character, onClose, onSaved, onDeleted }: Props) {
  const [form, setForm] = useState<FormState>(() => initialForm(character));
  const [saving, setSaving] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = character !== null;

  const set = (key: keyof FormState) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    if (!form.name.trim()) {
      setError("角色名称不能为空");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (isEdit) {
        // 只提交改动过的字段
        const patch: CharacterPayload = {};
        for (const key of Object.keys(form) as (keyof FormState)[]) {
          if (form[key] !== character[key]) patch[key] = form[key];
        }
        if (Object.keys(patch).length === 0) {
          onClose();
          return;
        }
        onSaved(await api.updateCharacter(character.id, patch));
      } else {
        onSaved(await api.createCharacter({ ...form, name: form.name.trim() }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!isEdit) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.deleteCharacter(character.id);
      onDeleted(character.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };
```

改成：

```tsx
export function CharacterEditModal({ character, notify, onClose, onSaved, onDeleted }: Props) {
  const [form, setForm] = useState<FormState>(() => initialForm(character));
  const [saving, setSaving] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const isEdit = character !== null;

  const set = (key: keyof FormState) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    if (!form.name.trim()) {
      notify("error", "角色名称不能为空");
      return;
    }
    setSaving(true);
    try {
      if (isEdit) {
        // 只提交改动过的字段
        const patch: CharacterPayload = {};
        for (const key of Object.keys(form) as (keyof FormState)[]) {
          if (form[key] !== character[key]) patch[key] = form[key];
        }
        if (Object.keys(patch).length === 0) {
          onClose();
          return;
        }
        onSaved(await api.updateCharacter(character.id, patch));
      } else {
        onSaved(await api.createCharacter({ ...form, name: form.name.trim() }));
      }
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!isEdit) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setSaving(true);
    try {
      await api.deleteCharacter(character.id);
      onDeleted(character.id);
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };
```

删掉这一行（`modal-footer` 上面的错误展示）：

```tsx
          {error && <div className="modal-error">{error}</div>}
```

- [ ] **Step 2: `CharacterSelect.tsx` 接 `notify` 并转手给 `CharacterEditModal`**

把：

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

改成：

```tsx
interface Props {
  characters: Character[];
  lastCharacterId: string | null;
  theme: ThemeName;
  notify: (kind: "ok" | "error", message: string) => void;
  onThemeChange: (theme: ThemeName) => void;
  onSelect: (character: Character) => void;
  onCreated: (character: Character) => void;
  onUpdated: (character: Character) => void;
  onDeleted: (id: string) => void;
  onOpenConnections: () => void;
}
```

把：

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

改成：

```tsx
export function CharacterSelect({
  characters,
  lastCharacterId,
  theme,
  notify,
  onThemeChange,
  onSelect,
  onCreated,
  onUpdated,
  onDeleted,
  onOpenConnections,
}: Props) {
```

把：

```tsx
      {modal && (
        <CharacterEditModal
          character={modal.mode === "edit" ? modal.character : null}
          onClose={() => setModal(null)}
```

改成：

```tsx
      {modal && (
        <CharacterEditModal
          character={modal.mode === "edit" ? modal.character : null}
          notify={notify}
          onClose={() => setModal(null)}
```

- [ ] **Step 3: `App.tsx` 传 `notify` 给 `CharacterSelect`**

把：

```tsx
      {phase === "select" && (
        <CharacterSelect
          characters={characters}
          lastCharacterId={lastCharacterId}
          theme={theme}
          onThemeChange={setTheme}
          onSelect={selectCharacter}
```

改成：

```tsx
      {phase === "select" && (
        <CharacterSelect
          characters={characters}
          lastCharacterId={lastCharacterId}
          theme={theme}
          notify={notify}
          onThemeChange={setTheme}
          onSelect={selectCharacter}
```

- [ ] **Step 4: 类型检查 + lint**

Run: `cd frontend && npm run build && npm run lint`
Expected: 两条命令都 0 error。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/CharacterSelect.tsx frontend/src/components/CharacterEditModal.tsx frontend/src/App.tsx
git commit -m "feat: route CharacterSelect/CharacterEditModal errors through the global notification"
```

---

### Task 3: 接入 `CharacterHome`

**Files:**
- Modify: `frontend/src/components/CharacterHome.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.css`

**Interfaces:**
- Consumes：Task 1 的 `notify`。
- Produces：`CharacterHome` 的 `Props` 新增 `notify` 字段。

- [ ] **Step 1: `CharacterHome.tsx` 改用 `notify`，去掉本地 error/hint**

把：

```tsx
interface Props {
  character: Character;
  characters: Character[];
  theme: ThemeName;
  onThemeChange: (theme: ThemeName) => void;
  onStart: (payload: { session: GameSession; history: HistoryEntry[]; pending: DialogueLine[] }) => void;
  onBack: () => void;
  onOpenConnections: () => void;
}

export function CharacterHome({
  character,
  characters,
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
```

改成：

```tsx
interface Props {
  character: Character;
  characters: Character[];
  theme: ThemeName;
  notify: (kind: "ok" | "error", message: string) => void;
  onThemeChange: (theme: ThemeName) => void;
  onStart: (payload: { session: GameSession; history: HistoryEntry[]; pending: DialogueLine[] }) => void;
  onBack: () => void;
  onOpenConnections: () => void;
}

export function CharacterHome({
  character,
  characters,
  theme,
  notify,
  onThemeChange,
  onStart,
  onBack,
  onOpenConnections,
}: Props) {
  const [autoSession, setAutoSession] = useState<GameSession | null | undefined>(undefined);
  const [busy, setBusy] = useState<"new" | "continue" | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAutoSession(undefined);
    api
      .listSessions({ character_id: character.id, is_autosave: true })
      .then((sessions) => {
        if (!cancelled) setAutoSession(sessions[0] ?? null);
      })
      .catch((e) => {
        if (!cancelled) notify("error", e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [character.id, notify]);

  async function handleContinue() {
    if (!autoSession) return;
    setBusy("continue");
    try {
      const messages = await api.getHistory(autoSession.id);
      const { history, pending } = splitInitial(messages);
      onStart({ session: autoSession, history, pending });
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  async function handleNewGame() {
    setBusy("new");
    try {
      const hadProgress = Boolean(autoSession);
      const session = await api.createSession(character.id, "Autosave");
      const messages = await api.getHistory(session.id);
      const { history, pending } = splitInitial(messages);
      if (hadProgress) {
        notify("ok", "已开始新游戏 · 原有存档不会被删除");
      }
      onStart({ session, history, pending });
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }
```

把：

```tsx
          {error && <div className="error-banner charhome-error">出错了: {error}</div>}
          {hint && <div className="select-hint charhome-error">{hint}</div>}
        </div>
      </div>
    </div>
  );
}
```

改成：

```tsx
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `App.tsx` 传 `notify` 给 `CharacterHome`**

把：

```tsx
      {phase === "hub" && selectedCharacter && (
        <CharacterHome
          character={selectedCharacter}
          characters={characters}
          theme={theme}
          onThemeChange={setTheme}
          onStart={startGame}
```

改成：

```tsx
      {phase === "hub" && selectedCharacter && (
        <CharacterHome
          character={selectedCharacter}
          characters={characters}
          theme={theme}
          notify={notify}
          onThemeChange={setTheme}
          onStart={startGame}
```

- [ ] **Step 3: 删掉 `App.css` 里现在没用的 `.error-banner`/`.charhome-error`**

先确认这两个 class 除了刚删掉的 `CharacterHome.tsx` 那两行，没有别的地方在用：

Run: `cd frontend/src && grep -rn "error-banner\|charhome-error" --include="*.tsx" .`
Expected: 没有任何输出（全部引用都已经在 Step 1 里删掉了）。

确认无输出后，在 `App.css` 里删除这两段：

```css
.error-banner {
  width: min(940px, 90%);
  background: rgba(140, 30, 30, 0.85);
  color: #f6e8e8;
  border-radius: var(--radius, 8px);
  padding: 8px 14px;
  font-size: 0.85rem;
}
```

```css
.charhome-error {
  margin-top: 4px;
}
```

- [ ] **Step 4: 类型检查 + lint**

Run: `cd frontend && npm run build && npm run lint`
Expected: 两条命令都 0 error。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/CharacterHome.tsx frontend/src/App.tsx frontend/src/App.css
git commit -m "feat: route CharacterHome errors/hints through the global notification"
```

---

### Task 4: 接入 `GameScreen`，删除 `ErrorToast`

**Files:**
- Modify: `frontend/src/components/GameScreen.tsx`
- Delete: `frontend/src/components/ErrorToast.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.css`

**Interfaces:**
- Consumes：Task 1 的 `notify`；`useDialogueEngine` 已有的 `error: string | null`、`clearError: () => void`（`frontend/src/hooks/useDialogueEngine.ts`，未改动）。
- Produces：`GameScreen` 的 `Props` 新增 `notify` 字段。

- [ ] **Step 1: `GameScreen.tsx` 去掉 `ErrorToast`，改成监听 `engine.error`**

把 import 块：

```tsx
import { useEffect, useRef, useState } from "react";
import { useDialogueEngine } from "../hooks/useDialogueEngine";
import { SCENE_META, sceneLabel } from "../lib/sceneLabel";
import type { ThemeName } from "../theme";
import type { Character, DialogueLine, GameSession, HistoryEntry, ModelOption } from "../types";
import { Backlog } from "./Backlog";
import { BackgroundLayer } from "./BackgroundLayer";
import { CharacterSprite } from "./CharacterSprite";
import { ChoiceList } from "./ChoiceList";
import { DialogueBox } from "./DialogueBox";
import { ErrorToast } from "./ErrorToast";
import { InputBar } from "./InputBar";
import { ModelSelector } from "./ModelSelector";
import { ThemeSwitcher } from "./ThemeSwitcher";
```

改成：

```tsx
import { useEffect, useRef, useState } from "react";
import { useDialogueEngine } from "../hooks/useDialogueEngine";
import { SCENE_META, sceneLabel } from "../lib/sceneLabel";
import type { ThemeName } from "../theme";
import type { Character, DialogueLine, GameSession, HistoryEntry, ModelOption } from "../types";
import { Backlog } from "./Backlog";
import { BackgroundLayer } from "./BackgroundLayer";
import { CharacterSprite } from "./CharacterSprite";
import { ChoiceList } from "./ChoiceList";
import { DialogueBox } from "./DialogueBox";
import { InputBar } from "./InputBar";
import { ModelSelector } from "./ModelSelector";
import { ThemeSwitcher } from "./ThemeSwitcher";
```

把：

```tsx
interface Props {
  character: Character;
  session: GameSession;
  initialHistory: HistoryEntry[];
  /** 进入会话时要逐句播放的台词(开场白) */
  initialPending: DialogueLine[];
  models: ModelOption[];
  initialModelId: string | undefined;
  theme: ThemeName;
  onThemeChange: (theme: ThemeName) => void;
  onExit: () => void;
  onOpenConnections: () => void;
  onOpenSave: () => void;
  onOpenLoad: () => void;
}

export function GameScreen({
  character,
  session,
  initialHistory,
  initialPending,
  models,
  initialModelId,
  theme,
  onThemeChange,
  onExit,
  onOpenConnections,
  onOpenSave,
  onOpenLoad,
}: Props) {
  const [modelId, setModelId] = useState<string | undefined>(initialModelId ?? models[0]?.id);
  const { current, hydrate, enqueue, ...engine } = useDialogueEngine(session.id, modelId);
  const [showBacklog, setShowBacklog] = useState(false);
  const hydratedRef = useRef(false);
```

改成：

```tsx
interface Props {
  character: Character;
  session: GameSession;
  initialHistory: HistoryEntry[];
  /** 进入会话时要逐句播放的台词(开场白) */
  initialPending: DialogueLine[];
  models: ModelOption[];
  initialModelId: string | undefined;
  theme: ThemeName;
  notify: (kind: "ok" | "error", message: string) => void;
  onThemeChange: (theme: ThemeName) => void;
  onExit: () => void;
  onOpenConnections: () => void;
  onOpenSave: () => void;
  onOpenLoad: () => void;
}

export function GameScreen({
  character,
  session,
  initialHistory,
  initialPending,
  models,
  initialModelId,
  theme,
  notify,
  onThemeChange,
  onExit,
  onOpenConnections,
  onOpenSave,
  onOpenLoad,
}: Props) {
  const [modelId, setModelId] = useState<string | undefined>(initialModelId ?? models[0]?.id);
  const { current, hydrate, enqueue, ...engine } = useDialogueEngine(session.id, modelId);
  const [showBacklog, setShowBacklog] = useState(false);
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (!engine.error) return;
    notify("error", engine.error);
    engine.clearError();
  }, [engine.error, engine.clearError, notify]);
```

把：

```tsx
        {engine.error && <ErrorToast message={engine.error} onDismiss={engine.clearError} />}
      </div>
```

改成：

```tsx
      </div>
```

- [ ] **Step 2: 删除 `ErrorToast.tsx`**

删除文件 `frontend/src/components/ErrorToast.tsx`。

- [ ] **Step 3: `App.tsx` 传 `notify` 给 `GameScreen`**

把：

```tsx
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
```

改成：

```tsx
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
          notify={notify}
          onThemeChange={setTheme}
          onExit={exitToHub}
```

- [ ] **Step 4: 删除 `App.css` 里的 `.error-toast*`**

删除这一整段（注释 `/* --- error toast (dismissible, right side) --- */` 连同它下面的 `.error-toast`、`.error-toast-message`、`.error-toast-close`、`.error-toast-close:hover` 四条规则）：

```css
/* --- error toast (dismissible, right side) --- */
.error-toast {
  position: fixed;
  top: clamp(70px, 9vh, 110px);
  right: 2%;
  z-index: 60;
  width: min(340px, 88vw);
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--radius, 10px);
  background: rgba(140, 30, 30, 0.85);
  border: 1px solid rgba(220, 120, 120, 0.5);
  color: #f6d8d8;
  font-size: 0.85rem;
  line-height: 1.5;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  animation: fadeIn 0.25s ease;
}

.error-toast-message {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}

.error-toast-close {
  flex: 0 0 auto;
  background: none;
  border: none;
  color: inherit;
  font-size: 1.05rem;
  line-height: 1;
  cursor: pointer;
  opacity: 0.85;
}

.error-toast-close:hover {
  opacity: 1;
}
```

- [ ] **Step 5: 类型检查 + lint**

Run: `cd frontend && npm run build && npm run lint`
Expected: 两条命令都 0 error。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/GameScreen.tsx frontend/src/App.tsx frontend/src/App.css
git rm frontend/src/components/ErrorToast.tsx
git commit -m "feat: route GameScreen chat errors through the global notification, delete ErrorToast"
```

---

### Task 5: 接入 `ConnectionsPanel`

**Files:**
- Modify: `frontend/src/components/ConnectionsPanel.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.css`

**Interfaces:**
- Consumes：Task 1 的 `notify`。
- Produces：`ConnectionsPanel` 的 `Props` 新增 `notify` 字段（`onClose`/`onChanged` 不变）。

- [ ] **Step 1: `ConnectionsPanel.tsx` 去掉本地 `banner`，改用 `notify`**

把：

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { ApiType, Connection, ConnectionPayload } from "../types";
```

改成：

```tsx
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { ApiType, Connection, ConnectionPayload } from "../types";
```

（`useRef` 不再需要，`bannerTimer` 这个 ref 整个删掉了。）

把：

```tsx
interface Props {
  onClose: () => void;
  /** 连接变化(增删改/启用)后通知外层刷新模型下拉 */
  onChanged: () => void;
}

interface FormState {
  name: string;
  api_type: ApiType;
  base_url: string;
  api_key: string;
  model: string;
}

type Banner = { kind: "ok" | "error"; message: string } | null;
type Busy = "save" | "delete" | "refresh" | "ping" | "test" | null;
```

改成：

```tsx
interface Props {
  notify: (kind: "ok" | "error", message: string) => void;
  onClose: () => void;
  /** 连接变化(增删改/启用)后通知外层刷新模型下拉 */
  onChanged: () => void;
}

interface FormState {
  name: string;
  api_type: ApiType;
  base_url: string;
  api_key: string;
  model: string;
}

type Busy = "save" | "delete" | "refresh" | "ping" | "test" | null;
```

把：

```tsx
export function ConnectionsPanel({ onClose, onChanged }: Props) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => formFrom(null));
  const [cachedModels, setCachedModels] = useState<string[]>([]);
  const [testMessage, setTestMessage] = useState(DEFAULT_TEST_MESSAGE);
  const [banner, setBanner] = useState<Banner>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const bannerTimer = useRef<number | undefined>(undefined);

  const selected = connections?.find((c) => c.id === selectedId) ?? null;

  const showBanner = (kind: "ok" | "error", message: string) => {
    window.clearTimeout(bannerTimer.current);
    setBanner({ kind, message });
    bannerTimer.current = window.setTimeout(() => setBanner(null), 3600);
  };

  useEffect(() => () => window.clearTimeout(bannerTimer.current), []);

  const reload = useCallback(async (keepId?: string | null) => {
```

改成：

```tsx
export function ConnectionsPanel({ notify, onClose, onChanged }: Props) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => formFrom(null));
  const [cachedModels, setCachedModels] = useState<string[]>([]);
  const [testMessage, setTestMessage] = useState(DEFAULT_TEST_MESSAGE);
  const [busy, setBusy] = useState<Busy>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const selected = connections?.find((c) => c.id === selectedId) ?? null;

  const reload = useCallback(async (keepId?: string | null) => {
```

把：

```tsx
  useEffect(() => {
    reload().catch((e) => showBanner("error", e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectConnection = async (id: string) => {
    const conn = connections?.find((c) => c.id === id);
    if (!conn) return;
    setSelectedId(id);
    setForm(formFrom(conn));
    setCachedModels(conn.cached_models);
    setDeleteArmed(false);
    setBanner(null);
    if (!conn.is_active) {
      try {
        await api.activateConnection(id);
        await reload(id);
        onChanged();
      } catch (e) {
        showBanner("error", e instanceof Error ? e.message : String(e));
      }
    }
  };

  const startNew = () => {
    setSelectedId(null);
    setForm(formFrom(null));
    setCachedModels([]);
    setDeleteArmed(false);
    setBanner(null);
  };

  const save = async () => {
    if (!form.name.trim()) {
      showBanner("error", "请填写连接名称");
      return;
    }
    setBusy("save");
    setBanner(null);
    try {
```

改成：

```tsx
  useEffect(() => {
    reload().catch((e) => notify("error", e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectConnection = async (id: string) => {
    const conn = connections?.find((c) => c.id === id);
    if (!conn) return;
    setSelectedId(id);
    setForm(formFrom(conn));
    setCachedModels(conn.cached_models);
    setDeleteArmed(false);
    if (!conn.is_active) {
      try {
        await api.activateConnection(id);
        await reload(id);
        onChanged();
      } catch (e) {
        notify("error", e instanceof Error ? e.message : String(e));
      }
    }
  };

  const startNew = () => {
    setSelectedId(null);
    setForm(formFrom(null));
    setCachedModels([]);
    setDeleteArmed(false);
  };

  const save = async () => {
    if (!form.name.trim()) {
      notify("error", "请填写连接名称");
      return;
    }
    setBusy("save");
    try {
```

把：

```tsx
      await reload(savedId);
      onChanged();
      showBanner("ok", "已保存");
    } catch (e) {
      showBanner("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!selectedId) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setBusy("delete");
    setBanner(null);
    try {
      await api.deleteConnection(selectedId);
      setDeleteArmed(false);
      await reload();
      onChanged();
    } catch (e) {
      showBanner("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const refreshModels = async () => {
    setBusy("refresh");
    setBanner(null);
    try {
```

改成：

```tsx
      await reload(savedId);
      onChanged();
      notify("ok", "已保存");
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!selectedId) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setBusy("delete");
    try {
      await api.deleteConnection(selectedId);
      setDeleteArmed(false);
      await reload();
      onChanged();
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const refreshModels = async () => {
    setBusy("refresh");
    try {
```

把：

```tsx
      showBanner("ok", "模型列表已刷新");
    } catch (e) {
      showBanner("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const ping = async () => {
    if (!selectedId) return;
    setBusy("ping");
    setBanner(null);
    try {
      const result = await api.pingConnection(selectedId);
      showBanner(result.ok ? "ok" : "error", result.message);
    } catch (e) {
      showBanner("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const sendTestMessage = async () => {
    if (!selectedId) return;
    setBusy("test");
    setBanner(null);
    try {
      const result = await api.testConnectionMessage(selectedId, testMessage);
      showBanner("ok", result.reply);
    } catch (e) {
      showBanner("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
```

改成：

```tsx
      notify("ok", "模型列表已刷新");
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const ping = async () => {
    if (!selectedId) return;
    setBusy("ping");
    try {
      const result = await api.pingConnection(selectedId);
      notify(result.ok ? "ok" : "error", result.message);
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const sendTestMessage = async () => {
    if (!selectedId) return;
    setBusy("test");
    try {
      const result = await api.testConnectionMessage(selectedId, testMessage);
      notify("ok", result.reply);
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
```

把：

```tsx
        <div className="modal-body">
          {banner && <div className={`conn-banner ${banner.kind}`}>{banner.message}</div>}

          <label className="form-field">
            <span className="field-label">已保存的连接 · SAVED</span>
```

改成：

```tsx
        <div className="modal-body">
          <label className="form-field">
            <span className="field-label">已保存的连接 · SAVED</span>
```

- [ ] **Step 2: `App.tsx` 传 `notify` 给 `ConnectionsPanel`**

把：

```tsx
      {showConnections && (
        <ConnectionsPanel onClose={() => setShowConnections(false)} onChanged={refreshModels} />
      )}
```

改成：

```tsx
      {showConnections && (
        <ConnectionsPanel
          notify={notify}
          onClose={() => setShowConnections(false)}
          onChanged={refreshModels}
        />
      )}
```

- [ ] **Step 3: 删掉 `App.css` 里现在没用的 `.conn-banner*`/`connBannerIn`，撤销 `.modal-body` 的 `position: relative`**

先确认没有遗漏引用：

Run: `cd frontend/src && grep -rn "conn-banner" --include="*.tsx" .`
Expected: 没有任何输出。

删除这一段：

```css
@keyframes connBannerIn {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.conn-banner {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 5;
  padding: 12px clamp(18px, 1.8vw, 30px);
  font-size: 0.88rem;
  line-height: 1.5;
  word-break: break-word;
  white-space: pre-wrap;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.25);
  animation: connBannerIn 0.3s cubic-bezier(0.22, 0.8, 0.3, 1) both;
}

.conn-banner.error {
  background: rgba(140, 30, 30, 0.5);
  border: 1px solid rgba(220, 120, 120, 0.5);
  color: #f6d8d8;
}

.conn-banner.ok {
  background: rgba(50, 130, 80, 0.35);
  border: 1px solid rgba(120, 220, 150, 0.5);
  color: #bdf2cc;
}
```

把：

```css
.modal-body {
  position: relative;
  padding: clamp(16px, 1.6vw, 26px) clamp(18px, 1.8vw, 30px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: clamp(12px, 1.1vw, 18px);
}
```

改成：

```css
.modal-body {
  padding: clamp(16px, 1.6vw, 26px) clamp(18px, 1.8vw, 30px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: clamp(12px, 1.1vw, 18px);
}
```

- [ ] **Step 4: 类型检查 + lint**

Run: `cd frontend && npm run build && npm run lint`
Expected: 两条命令都 0 error。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ConnectionsPanel.tsx frontend/src/App.tsx frontend/src/App.css
git commit -m "feat: route ConnectionsPanel results through the global notification"
```

---

### Task 6: 接入 `SaveLoadModal`

**Files:**
- Modify: `frontend/src/components/SaveLoadModal.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes：Task 1 的 `notify`。
- Produces：`SaveLoadModal` 的 `Props` 新增 `notify` 字段。

`SaveLoadModal` 现在有两套本地状态要迁移：`error`(报错)和 `hint`(存档/导入成功后的"已保存到 NO.xxx"提示)——两者都属于"操作结果通知"，都改成调用 `notify`(分别是 `"error"` 和 `"ok"`)。

- [ ] **Step 1: `SaveLoadModal.tsx` 改用 `notify`，去掉本地 `error`/`hint`**

把：

```tsx
interface Props {
  mode: "save" | "load";
  character: Character;
  /** save 模式下的快照来源,通常是当前正在玩的会话(game.session.id) */
  sourceSessionId: string;
  onClose: () => void;
  onLoaded: (payload: {
    session: GameSession;
    history: HistoryEntry[];
    pending: DialogueLine[];
  }) => void;
}

function chipKeyDown(e: React.KeyboardEvent, action: () => void) {
  if (e.key === "Enter" || e.key === " ") {
    e.stopPropagation();
    e.preventDefault();
    action();
  }
}

export function SaveLoadModal({ mode, character, sourceSessionId, onClose, onLoaded }: Props) {
  const [autoSession, setAutoSession] = useState<GameSession | null | undefined>(undefined);
  const [manualSaves, setManualSaves] = useState<GameSession[] | null>(null);
  const [page, setPage] = useState(1);
  const [busyKey, setBusyKey] = useState<number | null>(null);
  const [overwriteArmed, setOverwriteArmed] = useState<number | null>(null);
  const [deleteArmed, setDeleteArmed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<number | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const showHint = (text: string) => {
    window.clearTimeout(hintTimer.current);
    setHint(text);
    hintTimer.current = window.setTimeout(() => setHint(null), 3200);
  };

  const reload = async () => {
    try {
      const [autos, manuals] = await Promise.all([
        api.listSessions({ character_id: character.id, is_autosave: true }),
        api.listSessions({ character_id: character.id, is_autosave: false }),
      ]);
      setAutoSession(autos[0] ?? null);
      setManualSaves(manuals);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
```

改成：

```tsx
interface Props {
  mode: "save" | "load";
  character: Character;
  /** save 模式下的快照来源,通常是当前正在玩的会话(game.session.id) */
  sourceSessionId: string;
  notify: (kind: "ok" | "error", message: string) => void;
  onClose: () => void;
  onLoaded: (payload: {
    session: GameSession;
    history: HistoryEntry[];
    pending: DialogueLine[];
  }) => void;
}

function chipKeyDown(e: React.KeyboardEvent, action: () => void) {
  if (e.key === "Enter" || e.key === " ") {
    e.stopPropagation();
    e.preventDefault();
    action();
  }
}

export function SaveLoadModal({
  mode,
  character,
  sourceSessionId,
  notify,
  onClose,
  onLoaded,
}: Props) {
  const [autoSession, setAutoSession] = useState<GameSession | null | undefined>(undefined);
  const [manualSaves, setManualSaves] = useState<GameSession[] | null>(null);
  const [page, setPage] = useState(1);
  const [busyKey, setBusyKey] = useState<number | null>(null);
  const [overwriteArmed, setOverwriteArmed] = useState<number | null>(null);
  const [deleteArmed, setDeleteArmed] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const reload = async () => {
    try {
      const [autos, manuals] = await Promise.all([
        api.listSessions({ character_id: character.id, is_autosave: true }),
        api.listSessions({ character_id: character.id, is_autosave: false }),
      ]);
      setAutoSession(autos[0] ?? null);
      setManualSaves(manuals);
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    }
  };
```

把：

```tsx
  async function performSave(slotIndex: number) {
    setBusyKey(slotIndex);
    setError(null);
    try {
      await api.saveAs(sourceSessionId, { slot_index: slotIndex });
      setOverwriteArmed(null);
      await reload();
      showHint(`已保存到 NO.${String(slotIndex).padStart(3, "0")}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }

  async function performLoad(session: GameSession) {
    setBusyKey(session.slot_index ?? -1);
    setError(null);
    try {
      const messages = await api.getHistory(session.id);
      const { history, pending } = splitInitial(messages);
      onLoaded({ session, history, pending });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusyKey(null);
    }
  }

  async function performDelete(session: GameSession) {
    const key = session.slot_index ?? -1;
    if (deleteArmed !== key) {
      setDeleteArmed(key);
      return;
    }
    setBusyKey(key);
    setError(null);
    try {
      await api.deleteSession(session.id);
      setDeleteArmed(null);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleExport(session: GameSession) {
    setError(null);
    try {
      const messages = await api.getHistory(session.id);
      downloadExportBundle(
        buildExportBundle(character, session, messages),
        `${character.name}-${session.slot_name || "save"}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleImportFile(file: File) {
    setError(null);
    try {
      const bundle = await readImportFile(file);
      const result = await api.importSession({
        character_id: character.id,
        session: bundle.session,
        messages: bundle.messages,
      });
      await reload();
      showHint(`已导入到 NO.${String(result.slot_index).padStart(3, "0")}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
```

改成：

```tsx
  async function performSave(slotIndex: number) {
    setBusyKey(slotIndex);
    try {
      await api.saveAs(sourceSessionId, { slot_index: slotIndex });
      setOverwriteArmed(null);
      await reload();
      notify("ok", `已保存到 NO.${String(slotIndex).padStart(3, "0")}`);
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }

  async function performLoad(session: GameSession) {
    setBusyKey(session.slot_index ?? -1);
    try {
      const messages = await api.getHistory(session.id);
      const { history, pending } = splitInitial(messages);
      onLoaded({ session, history, pending });
      onClose();
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
      setBusyKey(null);
    }
  }

  async function performDelete(session: GameSession) {
    const key = session.slot_index ?? -1;
    if (deleteArmed !== key) {
      setDeleteArmed(key);
      return;
    }
    setBusyKey(key);
    try {
      await api.deleteSession(session.id);
      setDeleteArmed(null);
      await reload();
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleExport(session: GameSession) {
    try {
      const messages = await api.getHistory(session.id);
      downloadExportBundle(
        buildExportBundle(character, session, messages),
        `${character.name}-${session.slot_name || "save"}`,
      );
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    }
  }

  async function handleImportFile(file: File) {
    try {
      const bundle = await readImportFile(file);
      const result = await api.importSession({
        character_id: character.id,
        session: bundle.session,
        messages: bundle.messages,
      });
      await reload();
      notify("ok", `已导入到 NO.${String(result.slot_index).padStart(3, "0")}`);
    } catch (e) {
      notify("error", e instanceof Error ? e.message : String(e));
    }
  }
```

把：

```tsx
          {hint && <div className="select-hint">{hint}</div>}
          {error && <div className="modal-error">{error}</div>}
        </div>
```

改成：

```tsx
        </div>
```

- [ ] **Step 2: `App.tsx` 传 `notify` 给 `SaveLoadModal`**

把：

```tsx
      {saveLoadMode && game && (
        <SaveLoadModal
          mode={saveLoadMode}
          character={game.character}
          sourceSessionId={game.session.id}
          onClose={() => setSaveLoadMode(null)}
          onLoaded={handleSaveLoadLoaded}
        />
      )}
```

改成：

```tsx
      {saveLoadMode && game && (
        <SaveLoadModal
          mode={saveLoadMode}
          character={game.character}
          sourceSessionId={game.session.id}
          notify={notify}
          onClose={() => setSaveLoadMode(null)}
          onLoaded={handleSaveLoadLoaded}
        />
      )}
```

- [ ] **Step 3: 类型检查 + lint**

Run: `cd frontend && npm run build && npm run lint`
Expected: 两条命令都 0 error——这是全部 6 个组件接入完成后第一次全部走通。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/SaveLoadModal.tsx frontend/src/App.tsx
git commit -m "feat: route SaveLoadModal errors/hints through the global notification"
```

---

### Task 7: 真实浏览器端到端验证

**Files:** 无代码改动，仅验证。

**Interfaces:** 无。

- [ ] **Step 1: 确认前后端 dev server 都在跑**

后端:`cd backend && .venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000`
前端:`cd frontend && npm run dev`

- [ ] **Step 2: 验证角色编辑报错走全局通知**

打开角色网格,点"＋新建角色",什么都不填直接点"保存"。
Expected:视口最顶部弹出红色通知条"角色名称不能为空",带一个 ✕;不再是弹窗内部的小字。3.6 秒后自动消失(可以掐表看,或者故意等着看)。

- [ ] **Step 3: 验证连接面板报错/成功都走全局通知**

打开"API·连接设置",选一个连接,把 BASE URL 改成明显错误的地址(比如 `https://example.invalid`)并保存,点"连接"。
Expected:视口顶部出现红色通知(原始报错文本,不是中文翻译),盖在弹窗遮罩之上。

把 BASE URL 改回正确值,保存,点"刷新列表"。
Expected:视口顶部出现绿色通知"模型列表已刷新"。

- [ ] **Step 4: 验证手动关闭**

趁通知还没自动消失,点它右侧的 ✕。
Expected:立刻消失,不用等 3.6 秒。

- [ ] **Step 5: 验证游戏对话报错走全局通知**

进入任意角色的游戏对话界面,想办法触发一次发送失败(比如临时把当前连接的 API Key 改错,或者直接在网络层面制造失败也行——只要能让 `useDialogueEngine` 的 `send` 走到 catch 分支)。
Expected:视口顶部出现红色通知,不再是右上角的 `ErrorToast` 样式。

- [ ] **Step 6: 验证存档相关提示走全局通知**

进入游戏,点顶栏 SAVE,存到任意一个空位。
Expected:视口顶部出现绿色通知"已保存到 NO.xxx"。

- [ ] **Step 7: 确认 CharacterSelect 的 PNG 导入提示没受影响**

回到角色网格,点"＋ 导入角色卡"那张卡片。
Expected:还是原来那种局部的浅色提示条(不是全局通知),因为这个不在本次改动范围内。

- [ ] **Step 8: 记录结果**

以上步骤全部符合预期即完成,不需要额外提交(Task 7 不改代码)。任何一步不符合预期,回到对应 Task 修代码,改完从 Task 7 里失败的那一步重新开始验证。
