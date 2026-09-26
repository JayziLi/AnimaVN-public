# 预设块编辑 —— 详情弹窗 / 注释 / 拖拽排序 —— 设计

状态：**设计已确认**，待实现
日期：2026-08-20

## 背景

左栏预设面板目前对一个 block 只能做两件事：**开关**它，和**行内改 content**。
块的其余属性（`name` / `role` / `forbidOverrides`）只能看不能改，顺序完全由导入的
`prompt_order` 决定，改不了。

调提示词时真正高频的三个动作，现在一个都做不了：

1. **改 role** —— 把一块从 system 挪到 user 试效果，是调提示词的日常
2. **改顺序** —— 「jailbreak 挪到历史前面看看」这种试验做不了
3. **写注释** —— 想在块里留一句「这段是为了压制 OOC，别删」，但写了就会发给模型

本设计补齐这三件事，外加一个顺带的可见性修复（被卡覆盖的块要标出来）。

## 已确认的决策

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| 1 | 编辑入口 | **✎ 和 ⋯ 共存**：✎ 行内改 content，⋯ 开弹窗改全部 | 改一两个字用行内快；改属性才值得开弹窗 |
| 2 | 弹窗形态 | **居中 modal**，复用 `.inspector-backdrop` 那套 | 用户明确要「中间的窗口」；和完整提示词检视器同一范式 |
| 3 | role 快捷切换 | **不做**，只在弹窗里改 | 左栏徽章保持纯展示，避免误点 |
| 4 | 注入位置/深度 | **本轮不做**，字段保持透传 | 用户不用绝对深度；组装器也没实现，做了就是假 UI |
| 5 | 注释语法 | **行首 `//` 整行剔除** | 类比代码注释，实现和心智都简单 |
| 6 | 注释作用域 | **只对预设文本块**生效 | 历史、角色卡里的 `//` 不能被吃掉 |
| 7 | 拖拽落盘 | **只改内存 + 标脏，点「存」才写回** | 和现有 enabled 开关的显式保存哲学一致 |
| 8 | 拖拽实现 | **原生 HTML5 DnD**，不引依赖 | 前端目前零运行时依赖（只有 react/react-dom），不为一个排序破例 |
| 9 | 被卡覆盖 | **行上加反相实心徽章** | 覆盖现在是静默发生的，调试台不该藏这个。主题是纯灰阶不引色相，所以用白底黑字而非橙色 |

## 一、Block 详情弹窗

新组件 `frontend/src/debug/components/BlockEditorModal.tsx`。

### 布局

```
┌────────────────────────────────────────────┐
│ 块详情                                 ✕  │
├────────────────────────────────────────────┤
│ 名称  [ 主提示词                        ]  │
│ 角色  ( system ) ( user ) ( assistant )    │
│                                            │
│ ☐ 禁止角色卡覆盖                           │
│                                            │
│ 内容                                       │
│ ┌────────────────────────────────────────┐ │
│ │ // 压制 OOC 用的，别删                  │ │
│ │ You are {{char}}...                    │ │
│ └────────────────────────────────────────┘ │
│ 2 行注释已排除 · 净 ~412 tokens            │
├────────────────────────────────────────────┤
│ main · 内置块   Ctrl+Enter 确定 · Esc 取消 │
│                            [取消] [确定]  │
└────────────────────────────────────────────┘
```

### 字段行为

| 字段 | 控件 | marker 块 | 备注 |
|---|---|---|---|
| `name` | 文本框 | **可改** | 只影响左栏显示，不进请求 |
| `role` | 三按钮分段 | 隐藏 | marker 的 role 由组装器硬定（一律 system） |
| `content` | textarea | 隐藏 | marker 块改为一句说明文字，见下 |
| `forbidOverrides` | 复选框 | 隐藏 | **仅 `main` / `jailbreak` 显示**，其余块隐藏 |
| `identifier` | 只读，页脚 mono 小字 | 只读 | 它是块库↔编排的主键，且 marker 靠它决定填什么，绝不可改 |
| `systemPrompt` | 只读，页脚「内置块」徽章 | 只读 | 我们代码里纯透传，仅作标识 |

`forbidOverrides` 只对 `main` / `jailbreak` 显示，对齐酒馆
（`PromptManager.js:574` 的 `overridablePrompts.includes()`）—— 其他块本来就没有对应的卡字段，
显示一个永远无效的复选框只会误导。

marker 块的弹窗正文替换为：

> 【占位符】这一块不存文本。运行时由组装器按 identifier 填入真实内容
> （角色描述 / 对话历史 / 世界书 …）。这里只能改显示名。

### 注释提示行

textarea 下方一行灰字：`N 行注释已排除 · 净 ~412 tokens`。没有注释时只显示 token 数。

### 注释着色

注释行在编辑器里灰下去 + 斜体，像代码编辑器。

原生 textarea 给不了部分行上色，所以走经典的**双层**做法：一个 `<pre>` 垫在底下
渲染着色文本，上面盖一个文字透明、只留光标的 textarea，JS 把底层的滚动位置
焊到上层。不引编辑器依赖（CodeMirror 之类几百 KB），也不用 `contentEditable`
——后者会毁掉撤销栈，中文输入法下更糟。

封装成 `components/CommentTextarea.tsx`，两个变体：`modal`（详情弹窗的大框）和
`inline`（行内 ✎ 展开的小框）。两处都换成它。

三个关键约束：

1. **着色判定必须复用 `isCommentLine()`** ——就是 `stripComments` 内部用的那个
   函数，不是另写一遍正则。两边一旦不一致，编辑器就在骗人：灰掉的行和真正被
   剔除的行对不上，而这正是它唯一要说清楚的事。
2. **两层必须像素级对齐**，否则光标会飘。字号/行高/`white-space`/`word-break`
   写在同一条 CSS 规则里，padding 走 CSS 变量——变体只能整体改，没法让两层各走各的。
3. **输入法组字期间要把 textarea 的字露出来**。候选词上屏前还不在 `value` 里，
   底层 `<pre>` 画不出来，而 textarea 的字是透明的——不特殊处理，打中文时屏幕
   一片空白。`compositionstart/end` 期间临时恢复文字颜色并隐藏底层。

**marker 块那个「卡内容」输入框不用它**，仍是普通 textarea——注释是预设块的功能，
卡的字段里 `//` 是正常文本。没有着色本身就是个正确的信号。

### 提交语义

弹窗内所有改动进本地 draft，点「确定」一次性提交。快捷键与现有行内编辑器一致：
`Ctrl/Cmd+Enter` 确定，`Esc` 取消。

`DebugApp` 里把现有 `editBlock(identifier, content)` 泛化成：

```ts
const updateBlock = (identifier: string, patch: Partial<PresetPrompt>) => {
  if (!preset) return;
  setPreset({
    ...preset,
    prompts: preset.prompts.map((p) => (p.identifier === identifier ? { ...p, ...patch } : p)),
  });
  setPresetDirty(true);
};
```

行内 ✎ 走 `updateBlock(id, { content })`，弹窗走 `updateBlock(id, patch)`。
两条路都是「只改内存 + 标脏」，落盘仍然只在点「存」时发生。

## 二、`//` 注释

新文件 `frontend/src/debug/lib/comments.ts`：

```ts
/** 行首(允许前置空白)以 // 开头的整行被剔除 */
export function stripComments(text: string): string;
/** 被剔除的行数,给提示行用 */
export function countCommentLines(text: string): number;
```

### 规则

- **只认行首**。`  // xxx` 算注释（允许缩进），`abc // xxx` **不算**。
  行尾注释一律不做——`https://` 里就有 `//`，做了会切坏 URL。
- 整行剔除，包括该行的换行符。
- 不支持块注释（`/* */`）。

### 生效位置

组装器 `assembler.ts` 的文本块分支（`!prompt.marker`），在**宏替换之前**先剔除：

```ts
const stripped = stripComments(prompt.content);
// 整块被注释掉:给一个专属跳过原因,别混进"块内容为空"
if (prompt.content.trim() && !stripped.trim()) {
  skipped.push({ identifier: prompt.identifier, name: prompt.name, reason: '全部被注释' });
  continue;
}
let content = stripped;
// ... 卡覆盖检查照旧
```

放在宏替换前，是为了让注释掉的 `{{char}}` 不被算进「未解析宏」。

`SkippedBlock['reason']` 联合类型新增 `'全部被注释'`。

### 不生效的地方

- **对话历史 / 角色卡 marker 内容**：不剔除。用户在聊天里打 `//` 是正常文本。
- **卡覆盖进来的内容**：不剔除。注释是预设编辑器的功能，卡的 `system_prompt`
  由卡编辑器管，两边规则不混。

### token 计数要同步

左栏 [PresetPanel.tsx:218](../../../frontend/src/debug/components/PresetPanel.tsx) 现在直接
`estimateTokens(prompt.content)`，含注释——注释不发出去却被计入，数字是错的。
改为 `estimateTokens(stripComments(prompt.content))`。表头合计同理。

## 三、拖拽排序

### 交互

每行左侧加一个把手 `⠿`（`.block-grip`）。按住把手才能拖，避免和现有
「点行头展开」以及文本选择打架。

```
⠿ 主提示词    [SYSTEM]  ✎ ⋯ (●)  412
```

`draggable` 属性动态挂：只有在把手上按下鼠标后才把该行设为可拖。

```tsx
<div className="block-row" draggable={dragArmed === key}
     onDragStart={...} onDragEnd={...} onDragOver={...} onDrop={...}>
  <span className="block-grip"
        onMouseDown={() => setDragArmed(key)}
        onMouseUp={() => setDragArmed(null)}>⠿</span>
```

拖动时：`onDragOver` 按指针在目标行的上半/下半，给目标行加
`.drop-before` / `.drop-after`，CSS 画一条 2px 强调色横线做落点指示。
`onDragEnd` 清理所有临时状态。

### 数据落点

`order` 是 `useMemo` 派生的（[DebugApp.tsx:875](../../../frontend/src/debug/DebugApp.tsx)），
`overrides` 只存 enabled 覆写，装不下顺序。所以拖拽直接改
`preset.orderGroups[groupIndex].order`，和 `editBlock` 走同一条「改内存 + 标脏」的路：

```ts
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

`order` 和 `group.order` 长度一致、下标一一对应，所以 UI 里的下标可直接传进来。
`overrides` 按 identifier 存，重排后自动跟着走，不用管。

**`to` 的口径**（这里最容易差一位，明确定死）：`to` 是**移除源项之后**的数组里的
目标下标。`PresetPanel` 负责换算——设指针悬停在第 `j` 行、`before` 表示落在该行上方：

```ts
let insertAt = before ? j : j + 1;   // 原数组里的插入点
if (from < insertAt) insertAt -= 1;  // 源项在插入点之前,移除后整体左移一位
onReorder(from, insertAt);
```

保存路径无需改动：`presetToStored` 已经把当前 `order` 合并回 `prompt_order`。

## 四、被卡覆盖徽章

`allowCardOverrides` 在两处 assemble 调用点都硬编码为 `true`
（[DebugApp.tsx:1127](../../../frontend/src/debug/DebugApp.tsx)），所以覆盖是**一直开着**的，
而左栏完全看不出来。一张带 `system_prompt` 的卡会静默顶掉你的 main 块。

`DebugApp` 算一个集合传给 `PresetPanel`：

```ts
const overriddenIdentifiers = useMemo(() => {
  const s = new Set<string>();
  if (!card || !preset) return s;
  for (const p of preset.prompts) {
    if (p.marker || p.forbidOverrides) continue;
    if (p.identifier === 'main' && card.system_prompt.trim()) s.add('main');
    if (p.identifier === 'jailbreak' && card.post_history_instructions.trim())
      s.add('jailbreak');
  }
  return s;
}, [card, preset]);
```

行上渲染 `<span className="block-badge badge-override">被卡覆盖</span>`
（反相实心：`background: var(--accent)` + `color: var(--bg)`——主题是纯灰阶，不引新色相）。
弹窗里同样提示一句，并说明「勾上『禁止角色卡覆盖』可以挡掉」——这让第一节那个
复选框的用途在它真正相关的时刻自解释。

**已知不精确**：被覆盖时左栏显示的 token 数仍是预设原文的。徽章已经提示了
「这里显示的不是最终内容」，本轮不额外补正——真实数字在完整提示词检视器里。

## 五、marker 块在弹窗里显示并编辑真实内容

原设计里 marker 块的弹窗是一段只读说明。实际用起来这是个死胡同 —— 你点开
「角色描述」想看看它到底会填什么，得到的是一句「运行时由组装器填入」。

改成：**marker 块的弹窗显示它真正会填进去的内容，能改的就地改，确定后写回来源。**

### 内容来源对照

| marker | 内容来自 | 弹窗里 |
|---|---|---|
| `charDescription` | `card.description` | 可编辑 → 写回卡 |
| `charPersonality` | `card.personality` | 可编辑 → 写回卡（附 `personality_format` 模板预览）|
| `scenario` | `card.scenario` | 可编辑 → 写回卡（附 `scenario_format` 模板预览）|
| `dialogueExamples` | `card.mes_example` | 可编辑 → 写回卡 |
| `personaDescription` | 人设库（不在卡里）| 只指路：顶栏「玩家」按钮 |
| `chatHistory` | 聊天区的真实对话 | 只指路：直接改聊天记录 |
| `worldInfoBefore/After` | `card.character_book.entries[]` | 只指路：是一组条目，单框装不下 |
| 预设自定义的未知 marker | 无 | 说明它会被跳过 |

### 这张表放哪

`CardEditorDrawer` 里本来就有一张 `PROMPT_FIELDS`，记的正是「卡的哪个字段 →
预设的哪个块」。marker 弹窗要的是同一张表的**反向**查询。

所以把 `PROMPT_FIELDS` 连同它的类型整体搬进新的 `lib/cardFields.ts`，
两处共用一份。`CardEditorDrawer` 只是改成 import，逻辑一行没动。
新增 `resolveMarkerSource(identifier, card, preset)` 做反向解析。

**关键约束：只有 `mode: 'marker'` 的字段可编辑。** `main` / `jailbreak` 是
`mode: 'override'` —— 它们自己有预设正文，卡的字段只是**顶替**它。把这两份字
塞进同一个输入框会分不清在改哪个，所以 `markerCardField()` 明确排除 override 类。

### 写回路径

走 `DebugApp` 已有的 `changeCard(patch)` —— 立刻更新内存 + debounce 600ms 写库。
和卡编辑抽屉是同一条路，所以**没有新的保存语义**：卡的编辑一律即时生效，
不像预设那样要点「存」。

`PresetPanel` 不直接认识角色卡，只拿一个 `resolveMarker(identifier)` 查询函数
和一个 `onUpdateCard(patch)` 回调 —— 卡与预设的耦合留在 `DebugApp` 那一层。

## 六、新建块 / 删除块

### 新建

预设行（下拉 + 存/重命名/另存/恢复）**正下方**一颗虚线的「＋ 新建块」。
虚线是为了和实心的块行区分开——**它不是一个块，是一个动作**。

放这儿是因为它和「存 / 重命名 / 另存 / 恢复」同属预设级操作，凑在一起比藏在
长列表末尾好找。新块本身仍然追加在**编排末尾**，想挪再拖。

### 必须同时写两处

预设是两层结构，一个块要真正存在，`prompts`（块库）和 `prompt_order`（编排）
都得有它：

- 只进 `prompts` → 躺在库里，永远不显示、不发送
- 只进 `order` → 悬空引用，组装时记成「块不存在于预设」

新块的字段：`identifier` 用 `crypto.randomUUID()`（项目里已有的做法），
`name: '新块'`、`role: 'system'`、`content: ''`、`marker: false`、
`systemPrompt: false`（用户自建的，不是酒馆内置那四个）、其余取默认。

### 建完立刻开详情弹窗

`addBlock()` 返回新块的 identifier，左栏拿它直接 `setDetailOf(identifier)`。
否则用户得到的是一个叫「新块」的空壳，还得自己去列表里找它在哪、再点 `⋯`。

### 边界

- 预设一组编排都没有（`prompt_order` 不是数组的畸形预设）→ 补一组
  `character_id: 100000`，否则新块进了库却没地方放
- `groupIndex` 越界 → 退回第 0 组

### 删除

删除按钮在**详情弹窗的页脚**，不在块行上——块行已经挤了六样东西
（把手/名称/徽章/✎/⋯/开关/token），再塞一个垃圾桶只会误点。

两下确认：第一下变成「再点一次删除」，失焦自动解除。沿用人设面板那套
（`.btn.danger.armed`），不弹 `window.confirm`。

**只有用户自建的块能删**，规则同酒馆（`PromptManager.js` 的 `isUserPrompt`）：

| 块 | 能删吗 | 为什么 |
|---|---|---|
| 自建块（`!marker && !system_prompt`）| ✅ | 你建的，你删 |
| marker（`charDescription` 等）| ❌ | 组装器认 identifier 填内容，删了再也填不回来 |
| 内置块（`main` / `nsfw` / `jailbreak` / `enhanceDefinitions`）| ❌ | 关掉已经等于不发了 |

不能删的块干脆不显示删除按钮——显示一个永远点不动的比不显示更糟。

**必须从所有编排组里清掉**，不只当前这组。预设可以按角色存多组编排
（`prompt_order` 按 `character_id` 分组），只清当前组的话，别的组里会留下
一个指向已删块的悬空引用。

### 落盘

沿用既有语义：只改内存 + 标脏，点「存」才写回。**不点存直接「↺ 恢复」，
新建或删除都会回退**——这是误操作之后的退路。

## 七、本轮不做

明确排除，避免实现时跑偏：

- `injection_position` / `injection_depth` 的编辑与组装器实现（决策 4）
- `injection_order` / `injection_trigger`（我们的组装器没有「生成类型」概念）
- 完整提示词检视器左侧的组成统计图（另开一轮）
- 宏（`{{char}}` 等）的语法着色——注释着色的基建已经在了，加上去很便宜，
  但本轮没要求

## 八、测试

前端目前没有测试基建，本轮不新建。验证靠手动走查：

1. 导入示例预设 → 打开 `main` 的弹窗 → 改 role 为 user → 确定 →
   左栏徽章变 USER，完整提示词里该条 role 为 user
2. 在块里写 `// 注释` → 提示行显示「1 行注释已排除」，token 数下降 →
   完整提示词里看不到这行
3. 整块写成注释 → 「被跳过」标签页出现该块，原因「全部被注释」
4. 写 `见 https://example.com` → **不被剔除**
5. 拖动 jailbreak 到 chatHistory 之前 → 完整提示词里顺序改变 → 面板标脏 →
   点「存」→ 刷新页面顺序保持
6. 拖拽后不点「存」，点「↺ 恢复」→ 顺序回到保存前
7. 载入带 `system_prompt` 的卡 → main 行出现「被卡覆盖」→
   弹窗勾上「禁止角色卡覆盖」→ 徽章消失，完整提示词里恢复预设原文
8. 点「角色描述」的 `⋯` → 弹窗里显示卡的真实描述文本 → 改几个字 → 确定 →
   完整提示词里跟着变；打开卡编辑抽屉，描述字段也是改后的内容
9. 点「角色性格」的 `⋯` → 除了正文，还显示 `personality_format` 模板预览
10. 点「对话历史」的 `⋯` → 不给编辑框，只说明内容来自聊天区
11. 注释着色：块里混写注释和正文 → 注释行灰下去且斜体，正文正常 →
    **光标在两种行之间移动都不飘**，滚动时着色跟着走
12. 注释着色 · 中文输入：在编辑框里用输入法打中文 → **组字期间字是可见的**，
    上屏后正常着色
13. 行内 ✎ 展开的小框同样有着色；marker 块的「卡内容」框**没有**着色（符合预期）
14. 新建块：点预设行下方的「＋ 新建块」→ 详情弹窗**立刻打开** → 填名字和内容 →
    确定 → 新块出现在**列表末尾**且默认启用 → 完整提示词里能看到它
15. 新建块 · 落盘：新建后点「存」→ 刷新页面，新块还在；
    换一次：新建后**不点存**直接「↺ 恢复」→ 新块消失
16. 删除块：打开自建块的 `⋯` → 页脚有「🗑 删除」→ 点一下变「再点一次删除」→
    点别处失焦，恢复原样（没删掉）→ 再来一次连点两下 → 块从列表消失
17. 删除限制：打开 `main` 或「角色描述」的 `⋯` → 页脚**没有**删除按钮
18. 删除 · 落盘：删完点「存」→ 刷新页面，块确实没了；
    换一次：删完**不点存**直接「↺ 恢复」→ 块回来了
