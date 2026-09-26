# 调试台 token 预算截断 + 长对话渲染分页 —— 设计

状态：**设计已确认**，待实现
日期：2026-08-19

## 背景

调试台目前把整条对话历史无条件铺进提示词。对话一长就有两个问题：

1. **提示词无限膨胀** —— 没有任何上限，也没法观察「角色卡 + 预设吃掉了多少上下文」
2. **渲染卡顿** —— `ChatPanel` 一次性渲染全部消息，长对话下 DOM 过重

本设计解决这两件事。它们是**两件独立的事**，本设计里始终分开：

| | 管什么 | 影响提示词 |
|---|---|---|
| **截断** | 哪些消息**进提示词** | 是 |
| **show more** | 哪些消息**渲染成 DOM** | 否 |

被 show more 折叠的消息，只要在预算内照样进提示词；被截断的消息，只要在渲染窗口内照样显示（变暗）。

## 已确认的决策

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| 1 | 预算语义 | **总预算**（同酒馆 `max_context`） | 历史可用量 = 预算 − 固定开销。只有这个读法下「固定开销那条线」在轨道上才有对应位置 |
| 2 | 预算存哪 | **localStorage 全局** | 拖滑块不弄脏预设、不用按保存、后端零改动。代价：切预设不跟着变 |
| 3 | 截断可见性 | **聊天区画截断线 + 线上方变暗** | 拖滑块时线实时上下跑，这是调试台的价值所在 |
| 4 | show more 阈值 | **先常量 + localStorage，设置 UI 下一轮** | 调试台现在没有设置面板，为一个数字新开一个不划算 |
| 5 | 滑块刻度 | **线性，−/+ 换量程** | 线性才能让固定开销的填充段长度是真比例。对数会扭曲这个比例 |
| 6 | −/+ 语义 | **调量程（轨道满刻度）**，预算值不变 | 换小量程等于把固定开销那两段放大看 |
| 7 | 分段配色 | **低饱和色相** | 现有中性灰阶主题是临时的，后期统一美化 |

## 一、UI：预算条

挂在 `.left-col` 里，`PresetPanel` 和「对话历史」按钮之间。`flex: 0 0 auto` + `border-top`，跟 `.history-trigger` 同一路子。左栏收起（`leftCollapsed`）时不渲染。

### 折叠态（默认）

```
上下文预算                              [ 16384 ]  ⌄更多
├██████████▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒◆──────────────────┤
0                                            32k

■ #7a9cc6  预设     2.1k
■ #c69c7a  角色卡   2.1k
■ #4a4a4a  历史     9.1k        合计 13.3k / 16k
                                 历史截断 12 条
```

- **填充段**按 bucket 依次堆叠：预设 → 角色卡 → 历史
- **◆** 是预算把手，可拖；右上输入框是同一个值的精确入口
- 「线」= 角色卡段的右边缘，即固定开销的终点
- 两个固定段之间不画分隔竖线 —— 色相切换本身就是边界

### 展开态（点「更多」）

```
量程  [−] 32k [+]

预设      2.1k        角色卡     1.8k
玩家人设   0.2k        示例对话    0.1k
世界书     0           历史      9.1k
截断      12 条 / 5.3k
```

−/+ 在 `[8k, 16k, 32k, 64k, 128k, 200k]` 之间换挡。量程初值自动挑**最小的、≥ 当前预算的那一挡**；预算超过 200k 时钉在最高挡。

### 异常态

| 情况 | 表现 |
|---|---|
| 固定开销 > 预算 | 固定区撑满轨道并转 `--danger`，把手推到最左，提示「固定开销已超预算」 |
| 强留最后一条仍超预算 | 合计数字转 `--danger`，提示「最后一条消息单独就超预算」 |
| 固定开销 > 当前量程 | 填充段按量程截断显示，不撑破轨道 |

### 预算初值

依次尝试：localStorage `debug.tokenBudget` → 当前预设的 `params.openai_max_context`（`presetParser.ts` 已解析）→ `16384`。

### 关掉截断

输入框填 `0` 或清空 = 不截断，对应 `limit: null`。此时轨道只画固定段和历史段、不画把手，明细里的「截断」一行显示「关闭」。这是调试台需要的逃生门 —— 想看完整提示词长什么样时不必去猜一个足够大的数。

## 二、截断逻辑

### 位置

在 `frontend/src/debug/lib/assembler.ts` 的 `assemble()` 里，**组装循环跑完之后、`squashSystem()` 之前**加一个后处理。

**不放在 `chatHistory` marker 展开的当口**：跑到那个 marker 时，排在历史后面的块（`jailbreak` 等）还没组装，固定开销未知。循环跑完后每条消息都带 bucket，一次遍历即可得到精确的固定开销 —— 不需要组装两遍。

### 规则

1. `fixedTokens` = 所有 `bucket !== 'history'` 的消息 token 之和
2. `allowance = limit - fixedTokens`
3. 历史消息**从最新往回**留，累计超过 `allowance` 就停
4. **整条丢，绝不切半条**
5. **最后一条必留** —— 哪怕它自己就超预算，否则等于发一个没有用户输入的请求。这种情况置 `forcedLastMessage`
6. `limit === null` 时整个后处理跳过（不截断）

### 分桶

给 `AssembledMessage` 加显式字段 `bucket: 'preset' | 'card' | 'history'`，在 emit 时确定，不让消费方各自从 `sourceKind` 去猜。

| 来源 | bucket |
|---|---|
| 普通预设块 | `preset` |
| **被卡覆盖的预设块** | **`card`** |
| `charDescription` / `charPersonality` / `scenario` | `card` |
| `worldInfoBefore` / `worldInfoAfter` | `card` |
| `dialogueExamples` | `card` |
| `personaDescription` | `card`（明细里单列一行） |
| 对话历史 | `history` |

**被卡覆盖的预设块**：`allowCardOverrides` 打开时，卡的 `system_prompt` 顶掉 `main` 块内容、`post_history_instructions` 顶掉 `jailbreak`（`assembler.ts` 现有逻辑），但 `sourceKind` 仍是 `'preset'`。必须在覆盖发生的分支里把 bucket 标成 `'card'`，否则卡的文字会被算进预设段 —— 卡带长 jailbreak 时能错几百 token。

**`squashSystemMessages` 的影响**：squash 会把相邻 system 合成一条，预设块和 marker 块可能并进同一条消息，分桶随之失效。因此**明细必须在 squash 之前统计**。截断本就跑在 squash 前，顺手完成，不额外花代价。

副作用：squash 后重估会让 `totalTokens` 和明细之和相差几个 token（每次合并约 1 个：多一个换行 + `Math.ceil` 取整）。量级可忽略，**不为它加补偿逻辑**。

### 结果结构

`AssemblyResult` 增加：

```ts
budget: {
  limit: number | null;          // null = 不截断
  fixedTokens: number;           // 那条线的位置
  presetTokens: number;
  cardTokens: number;
  historyTokens: number;         // 实际进了提示词的历史
  droppedCount: number;
  droppedTokens: number;
  overflow: boolean;             // 固定开销自己就超预算
  forcedLastMessage: boolean;    // 强留的最后一条也超预算
  firstKeptHistoryIndex: number | null;  // 截断线画在哪；历史为空时为 null
}
```

`AssembledMessage` 增加：

```ts
bucket: 'preset' | 'card' | 'history';
historyIndex?: number;   // 仅历史消息有，指向 input.history 的下标
```

### 为什么需要 `historyIndex`

聊天区要知道截断线画在第几个气泡上。**不能靠数消息条数推** —— `assemble()` 会跳过空文本的 turn（`if (!text) continue`），索引会错位。

`historyIndex` 直接记住该消息来自 `history[i]`；而 `history` 是 `entries.map()` 产出的、与 `entries` 严格一一对应，所以 `firstKeptHistoryIndex` 能直接当作 `entries` 的下标用。

历史消息角色恒为 `user`/`assistant`，永远不会被 `squashSystem` 合并，索引不会被破坏。

### 免费的一致性

`preview` 这个 `useMemo` 是全局唯一真相 —— 输入框上方的统计、存进 swipe 的快照、`PromptInspector` 全部走它。截断做在 `assemble()` 内部，这三处自动一致，无需额外同步代码。

`snapshotHash` 也会跟着变，这是**正确行为**：改了预算 = 提示词真的不同了，两个分支的指纹本就该不同。

### 后端

**零改动。** `swipe_info` 在 `AnimaBackend/app/schemas.py` 是 `list[dict]`，不透明存储，`AssemblyResult` 加字段不会触发 422。

## 三、show more

在 `ChatPanel` 内部：`entries.slice(-visibleCount)`。

| 项 | 值 |
|---|---|
| 默认可见条数 | 50 |
| 「显示更多」每次追加 | 50 |
| Shift + 点击 | 全部展开 |
| 阈值来源 | 常量 + localStorage `debug.visibleMessages` |

- **从尾部切**，所以新消息永远可见，流式期间不需要特殊处理
- **切对话时重置**回默认值（`ChatPanel` 新增 `chatKey` prop，`useEffect` 依赖它重置）
- **滚动补偿**：点「显示更多」时记录 `scrollHeight`，插入后按差值修正 `scrollTop`，避免视野往上跳

### 与截断线的位置关系

| 情况 | 表现 |
|---|---|
| 截断线**落在渲染窗口内** | 正常画分隔线，线以上气泡降 `opacity` |
| 截断线**在窗口之外**（更老） | 窗口内全部都进了提示词；「显示更多」按钮上标注「上面还有 N 条，其中 12 条不进提示词」 |

判定方式：把 `budget.firstKeptHistoryIndex` 和当前渲染窗口起点 `entries.length - visibleCount` 比大小。

## 四、改动清单

| 文件 | 改什么 |
|---|---|
| `frontend/src/debug/lib/assembler.ts` | `tokenBudget` 入参、截断后处理、`budget` 结果、`bucket` / `historyIndex` 字段 |
| `frontend/src/debug/lib/budget.ts` **新** | 量程阶梯、localStorage 读写、初值推导、量程自动选挡 |
| `frontend/src/debug/components/BudgetBar.tsx` **新** | 滑块 + 输入框 + 分段填充 + 「更多」展开层 |
| `frontend/src/debug/components/ChatPanel.tsx` | 截断线、线上方变暗、show more、统计栏改为看预算 |
| `frontend/src/debug/DebugApp.tsx` | budget / range state、传进两处 `assemble`、渲染 `BudgetBar` |
| `frontend/src/debug/components/PromptInspector.tsx` | 摘要区增加「截断 N 条」chip |
| `frontend/src/debug/debug.css` | 预算条、截断线、变暗、show more 的样式 |
| 后端 | **无** |

`ChatPanel` 现有的硬编码告警阈值 `preview.totalTokens > 30000` 改为与预算比较。

## 五、明确不做

- **真 tokenizer**。`estimateTokens()` 是粗估（CJK 1 字 1 token、拉丁 4 字符 1 token），偏差可达 ±20%。这个预算是**调试台的相对标尺，不是防超限的保险**。要精确得引 tokenizer 或调后端 count API —— 另一件事。
- **示例对话优先于历史被挤掉**。酒馆在空间紧张时先挤示例对话再动历史；本设计把示例对话算作固定开销的一部分（归 `card` 段），不参与截断。
- **squash 造成的 token 差值补偿**（见二·分桶）。
- **show more 的设置 UI**。本轮只留常量 + localStorage 接口。
- **无限滚动**。用显式按钮，不做滚到顶自动加载。
