# 角色「开始游戏」中枢屏设计

## 背景

当前流程：在角色选择网格点击一张角色卡 → `App.tsx` 的 `enterCharacter` 立即发请求恢复/新建会话 → 直接进入 `GameScreen` 对话界面。中间没有任何过渡或确认步骤。

目标：在选角和正式进入对话之间插入一个「开始游戏」中枢屏（角色主页），展示角色立绘与新游戏/继续游戏/选择模型/选择角色四个入口，并带有具设计感的转场动画。视觉与转场细节已经在参考文件
`%USERPROFILE%\Downloads\Galgame React前端设计\AnimaVN.dc.html`（`isCharHome` 分支，约 219–272 行及对应的 `charHome`/`charHomeMenu` 数据构造，约 553–577 行）中完整定义，本设计文档是把该参考适配进本仓库真实数据模型和代码约定后的实现规格。

## 一、流程与状态

### `App.tsx`

- `phase` 从 `"loading" | "select" | "game"` 扩展为 `"loading" | "select" | "hub" | "game"`。
- 新增 `selectedCharacter: Character | null` state。
- `CharacterSelect` 的卡片点击行为改变：不再触发任何网络请求，只是同步地 `setSelectedCharacter(character); setPhase("hub")`，同时把 `LAST_CHARACTER_KEY`/`lastCharacterId` 的写入从原来的 `enterCharacter` 挪到这里——选中即记为"上次打开的角色"，不必等到真正开局。原来做会话恢复/创建的逻辑从 `enterCharacter` 中整体搬到新组件 `CharacterHome` 里，按「继续游戏」/「新游戏」两个按钮分别触发。
- `CharacterSelect` 的 prop `onEnter` 改名为 `onSelect`，语义从"进入游戏"变为"选中角色，进入中枢屏"。
- 清理：`enterCharacter` 整个删除；它原本对 `animavn:lastSession:<id>` 这个 key 的读写也一并去掉（见下方"不再使用 localStorage 的会话指针"），包括 `handleSaveLoadLoaded` 里那句现在已经没有任何地方会读取的 `localStorage.setItem(sessionKey(...))`。

### `CharacterHome.tsx`（新文件）

Props：`character`、`characters`（用于算左上角序号）、`models`、`activeConnectionId`、`theme`、`onThemeChange`、`onStart(payload: {session, history, pending})`、`onBack()`、`onOpenConnections()`。

挂载时：调用 `api.listSessions({character_id: character.id, is_autosave: true})`，取返回数组第一个作为当前自动存档（后端 `list_sessions` 已按 `updated_at desc` 排序，`[0]` 就是最新的那份，见 `backend/app/api/sessions.py:35`）。

- 若存在 → 「继续游戏」可点，footer 显示其 `updated_at` 格式化时间。
- 若不存在 → 「继续游戏」置灰并显示"暂无进度"，footer 显示"AUTOSAVE · 尚未开始"。
- 拉取过程中两个按钮都禁用（沿用 `busyCharacterId` 那种忙态样式）。

**继续游戏**：用已取到的自动存档 session，调 `getHistory` + `splitInitial`，通过 `onStart` 交给 `App`。

**新游戏**：始终调用 `api.createSession(character.id, "Autosave")` 创建一个新会话并立即进入，不弹二次确认框。若挂载时已经查到旧的自动存档，点击后展示一条 3 秒左右自动消失的轻量提示（复用 `CharacterSelect` 里 `select-hint` 的样式），文案为「已开始新游戏 · 原有存档不会被删除」——不承诺旧存档仍可通过"继续游戏"找回，因为新会话创建后会立刻成为 `updated_at` 最新的那条，之后所有查询 `autos[0]` 的地方（包括这个中枢屏自己、以及 `SaveLoadModal` 的 AUTO 那一行）都会转而显示新会话。旧会话数据不删除，只是不再被任何界面呈现。

不再使用 `localStorage` 的 `animavn:lastSession:<id>` 指针做"记住上次会话"这件事——现在每次进入中枢屏都会对后端做一次实时查询，这个本地缓存只是在重复同一个查询、还可能读到过期数据，直接去掉。`LAST_CHARACTER_KEY`（记住上次玩的角色，用于角色网格里的高亮）保留不变。

**选择模型**：调用 `onOpenConnections()`，行为与现有"API · 连接设置"按钮完全一致，复用同一个 `ConnectionsPanel`。

**选择角色**：点击后组件进入本地"离场"状态（`leaving = true`），触发反向划出动画（左侧立绘板块向左划出、右侧内容整体向右划出，不做错峰），约 400ms 后调用 `onBack()`，由 `App` 把 `phase` 切回 `"select"`（`CharacterSelect` 按原有的 `fadeIn` 出现，不做镜像动画）。

## 二、视觉与动画规格

直接照抄参考文件里 `isCharHome` 分支的结构和数值，只是把内联样式 + `vw` 单位换成本仓库一贯的 CSS class + `clamp()` 写法（对照 `App.css` 里 `.select-*` 系列的做法），并接入真实主题变量（`--accent`、`--ink`、`--panel` 等，`theme.ts` 已提供，无需新增）。

布局（`.charhome-screen`，100vw/100vh，全屏替换当前 `.select-screen`/`.game-screen` 同级）：

- **左侧立绘板块**（`.charhome-portrait`，宽 42%、高 100%）
  - 背景：`--accent-soft` 底色 + 45° 条纹图案（与 `.character-portrait` 现有的斜纹 token 一致，放大到整块面板）
  - 右边缘用 `clip-path: polygon(0 0, 100% 0, calc(100% - Xpx) 100%, 0 100%)` 做斜切
  - 有立绘（`Object.values(character.sprites)[0]`）则底部对齐、`object-fit: contain`、加投影；没有则显示"SPRITE"占位文字，样式复用 `.character-portrait-label`
  - 左上角：角色在 `characters` 数组里的序号（`findIndex + 1`，两位数补零，如"01"）+ "CHARACTER FILE" 竖排小字说明
  - 入场动画：从左侧滑入 + 淡入，约 650ms ease-out（对应参考文件的 `avnSlideL`）
- **缝线**：一条 2px 的 `--accent` 竖线，位置对齐斜切边，做同角度 skew，营造"缝合"两个板块的视觉
- **右侧菜单板块**
  - 右边缘竖排小字"ANIMAVN · GALGAME AI ENGINE"
  - 角色名最后一个字，超大号衬线字体、约 5% 透明度，右下角做背景水印
  - 内容自上而下：tag（角色小传/世界观标签）→ 姓名 + 罗马音/英文名 → 简介 → 开场白引用块（`character.greeting`，衬线字体 + 左侧强调竖线 + "OPENING LINE · 开场白"小字说明)→ 四个菜单按钮（新游戏为强调色实心，其余为描边）→ footer 信息行（"MODEL · {当前模型 label}" / "AUTOSAVE · {时间戳或"尚未开始"}"）
  - 入场动画：各区块从右侧滑入 + 淡入，依次错峰（大致对应参考文件的 0.15s / 0.26s / 菜单每项 +0.09s / 0.75s 延迟节奏）

新增文件：`frontend/src/components/CharacterHome.tsx`。样式追加进 `frontend/src/App.css`（沿用现有"所有屏幕样式放一个文件"的约定，不新开 CSS 文件）。

## 三、边界情况

- 角色没有立绘：立绘板块显示占位文字，视觉上与角色网格卡片的占位保持一致。
- 会话创建/加载失败：用 `CharacterSelect` 里同款的 `.select-error` 横幅样式展示错误信息。
- 「新游戏」「继续游戏」点击后到真正跳转前，两个按钮都进入忙态（disabled + 视觉变化），防止重复点击。
- 时间戳格式化：`SaveLoadModal.tsx` 里已有 `formatTimestamp`，把它挪到 `frontend/src/lib/format.ts` 供两处复用，避免复制一份同样的函数。
