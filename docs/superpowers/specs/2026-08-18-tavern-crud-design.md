# 调试台角色卡 / 预设 CRUD —— 设计

状态：**设计讨论中**（已定三项决策，字段范围待参考酒馆实际界面后收敛）
日期：2026-08-18

## 背景

调试台（`frontend/debug.html` → `frontend/src/debug/`）目前零持久化：角色卡和预设都是「导入文件 → React state → 刷新即失」。后端对调试台只有一个 dumb pipe `/api/debug/complete`，不存任何东西。

本设计给调试台加上角色卡 / 预设的 选择 / 保存 / 创建 / 删除 / 修改，逻辑仿照酒馆。

## 已确认的决策

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| 1 | 存哪里 | **后端 SQLite** | 未来酒馆插件直连能读到同一份数据；游戏侧也要用；换浏览器不丢 |
| 2 | 和游戏 `characters` 表的关系 | **两张表分开，另做同步接口** | 字段语义几乎不重叠；符合「先按酒馆的方式安排，之后再写自己的规范」 |
| 3 | 保存语义 | **角色卡自动保存，预设显式保存** | 预设要反复试开关，试完不想要直接刷新丢掉；角色卡编辑是确定性的改动。<br>之后会上线设置项让用户改这个行为 —— 两条路径要写成可切换的形状 |

## 一、后端

### 新表

**`tavern_cards`** —— 酒馆 V2/V3 卡原样存，一个字段不丢

```
id, name, description, personality, scenario, first_mes, mes_example,
system_prompt, post_history_instructions, creator_notes,
alternate_greetings(JSON), tags(JSON), creator, character_version,
character_book(JSON), extensions(JSON), spec, avatar(base64),
created_at, updated_at
```

**`prompt_presets`** —— Chat Completion 预设原样存

```
id, name, prompts(JSON), prompt_order(JSON), formats(JSON),
params(JSON), squash_system_messages, created_at, updated_at
```

`characters`（游戏表）本轮**不动**。同步桥推迟到下一轮，那时再加 `source_card_id` 列和迁移脚本。

### API

照 `AnimaBackend/app/api/characters.py` 现有风格。

| 端点 | 作用 |
|---|---|
| `GET / POST / PUT / DELETE /api/tavern/cards` | 角色卡 CRUD |
| `POST /api/tavern/cards/{id}/duplicate` | 复制一份 |
| `GET /api/tavern/cards/{id}/avatar` | 头像单独取（列表接口只回 `has_avatar`，否则列表太沉） |
| `GET / POST / PUT / DELETE /api/tavern/presets` | 预设 CRUD |
| `POST /api/tavern/presets/{id}/duplicate` | 另存为 |

PNG 解析继续留在前端（`frontend/src/debug/lib/cardParser.ts` 已验证可用）。前端解析完把 JSON + 头像一起 POST，后端不重写 PNG chunk 解析。

### 同步桥（**本轮不做**，方向已定）

**核心原则（用户定的）**：AnimaBackend 是 AnimaVN 的调试工具，**不应过度独立于它**。所以同步是**自动发生**的，不是一个要人去点的按钮 —— 没有「→ 同步到游戏」这种入口。

落地形态（下一轮实现）：调试台保存角色卡时，后端在同一个事务里 upsert 对应的游戏 `Character`。用户在调试台调好人设，游戏侧打开角色列表就已经在那了。

需要一并想清楚的（做的时候再定）：
- 游戏侧编辑了这条角色，调试台下次保存会不会覆盖 → 倾向把同步来的角色在游戏侧标记来源，避免双向编辑打架
- 删除酒馆卡时，游戏侧那条角色如何处置

字段映射（单向，酒馆卡 → 游戏）：

| 游戏 `Character` | ← 酒馆卡 | 备注 |
|---|---|---|
| `name` | `name` | 直接 |
| `persona` | `description` + `personality` | 人设主体 |
| `world_setting` | `scenario` + `character_book` | 场景 + 世界书 |
| `greeting` | `first_mes` + `alternate_greetings` | 游戏侧支持多开场白 |
| `description` | `creator_notes` 截断 | 游戏这字段是一行简介，限 300 字 |
| `tagline` | `tags` 拼接 | 酒馆无直接对应 |
| `sprites` / `backgrounds` / `voice_id` | — | 酒馆卡没有，同步时**保持游戏侧原值不覆盖** |

**有损方向**：`mes_example`、`system_prompt`、`post_history_instructions` 在游戏侧没有对应字段，同步时会丢。等写自己的规范时再接。

## 二、酒馆实际信息架构（2026-08-18 实地考察 SillyTavern 1.18.0）

在本机 fork 实例 `http://127.0.0.1:8001/` 上逐屏确认，结论直接改写了下面的前端设计。

### 角色编辑是**两层**的，不是平铺

**一级（右栏常驻可见）** —— 只有两个正文字段：

| 元素 | 对应卡字段 |
|---|---|
| 头像（点击更换） | avatar |
| 名字 + Token 数 | name |
| 标签行 | tags |
| 创作者的注释（默认折叠） | creator_notes |
| **角色描述** | description |
| **开场白** + 「其他开场」按钮 | first_mes + alternate_greetings |

**二级（「高级定义」弹窗）** —— 其余全部：

| 弹窗内分组 | 对应卡字段 |
|---|---|
| 提示词覆盖（折叠） | system_prompt, post_history_instructions |
| 创作者的元数据（折叠，不与AI提示词一起发送） | creator, character_version, creator_notes |
| 角色设定摘要 | personality |
| 情景 | scenario |
| 角色备注 + @深度 + 身份 | extensions.depth_prompt |
| 发言频率 | talkativeness（群聊用，我们没群聊，跳过） |
| 对话示例 | mes_example |

**独立入口按钮**：世界书、绑定的用户设定、导出下载、复制角色、创建角色、删除角色、收藏。

**为什么是这个分法**：实测 Seraphina（酒馆官方默认卡）的 personality / scenario / mes_example **全是空的（Token 0）**，所有内容都塞在 description 里，连 `<START>` 示例对话也写在描述框内。这和之前分析 Wikira 卡的结论完全一致 —— 现代卡只用 description + first_mes 两个字段。所以酒馆把这两个放一级、其余降到二级，是跟着真实用法走的。

**对我们的影响**：现有 `CardPanel` 把 8 个字段平铺展示，比参照物还复杂且没有主次，要改成同样的两层。

### CRUD 工具条范式

酒馆的「配置文件类」对象（API 连接配置、预设）共用一套工具条：下拉框 + 一排图标按钮。实测按钮语义：

| 按钮 | 作用 |
|---|---|
| 新建 | 建一个空的 |
| **更新当前** | 保存，覆盖当前选中的 |
| **另存为** | 存成新的一份 |
| 重命名 | 改名 |
| **恢复当前** | **丢弃未保存改动，从存储重新加载** |
| 删除 | 删掉 |
| 导入 / 导出 | JSON 文件进出 |
| ~~将预设与 API 配置绑定~~ | 酒馆有，**我们不做**（已确认） |

**原方案漏掉的一个**：**「恢复」** —— 和「显式保存」是一对。试完一堆开关想放弃时，不用刷新页面。

### 预设区的两行工具条（实测 DOM，逐个按钮确认）

酒馆预设区是**两行、全图标平铺、没有任何菜单收纳**：

```
预设名                          [导入][导出][删除]      ← 标题行右侧 3 个
[预设下拉        ▾]  [保存][重命名][另存为][恢复]        ← 下拉行 4 个
```

| 按钮 | 酒馆 title | FA 图标 | 行 |
|---|---|---|---|
| 导入 | 导入预设 | `fa-file-import` | 标题行 |
| 导出 | 导出预设 | `fa-file-export` | 标题行 |
| 删除 | 删除预设 | `fa-trash-can` | 标题行 |
| 保存 | 更新当前预设 | `fa-save` | 下拉行 |
| 重命名 | 重命名当前预设 | `fa-pencil` | 下拉行 |
| 另存为 | 另存预设为 | `fa-file-circle-plus` | 下拉行 |
| 恢复 | 恢复当前预设 | `fa-recycle` | 下拉行 |

### 提示词管理器（我们左栏对标的就是它）

```
提示词                     总 Token 数量: 0
[编排下拉  ▾] [插入][删除][导入][导出][重置][新建]     ← 6 个图标
─────────────────────────────
名称                           Token      ← 表头两列
📌 Char Description      ✏️  ⬤    -
📌 Chat History              ⬤    -      ← marker 没有编辑按钮
📄 Main Prompt           ✏️  ⬤    -
📄 Enhance Definitions   ✏️  ○    -      ← 关闭：整行变灰
```

实测确认的行结构：

| 块类型 | 前缀图标 | 编辑按钮 | 开关 |
|---|---|---|---|
| marker（占位符） | `fa-thumb-tack` 图钉 | **没有** —— 占位符无内容可编辑 | `fa-toggle-on` |
| 文本块 | `fa-square-poll-horizontal` | `fa-pencil` | `fa-toggle-on` |

其他细节：
- 开关是 **toggle 滑块**，不是勾选框
- 列表有**表头**（名称 / Token 两列）
- 顶部有**总 Token 数量**
- 关闭的块整行变灰、名字变暗

**我们的取舍**：结构与交互逐项对齐（表头、总 Token、编辑按钮、marker 无编辑、toggle 开关、关闭变灰），但**视觉语言保持我们自己的黑白文字化风格** —— 继续用文字 badge（MARKER / SYSTEM）而不是彩色 emoji 图标，因为主题本来就不同（酒馆是深灰+橙强调，我们是纯黑白），硬塞图标会破坏刚定的配色。

### 选中角色 = 直接开聊

点角色列表里的角色不是进编辑界面，是**选中并开始对话**；编辑要另外从右栏面板进。我们调试台点下拉切角色应同理：切换即生效，编辑在下方面板做。

## 三、前端（按上面考察结果修订）

### 左栏预设 —— 显式保存

```
预设 · PRESET  [默认预设 ▾]  ●未保存
[保存][另存为][重命名][恢复][删除][导入][导出]
```

勾选块开关只改内存（沿用现有 `overrides` 机制），点保存才合并进 `prompt_order` 写库。切换预设时若有未保存改动会拦一下。「恢复」丢弃内存改动重新拉库。

### 右栏角色卡 —— 自动保存 + 两层结构

**一级（面板常驻）**：
```
角色卡 · CARD  [Anima ▾]  已保存
[新建][复制][删除][导入][导出][高级定义…]

头像 / 名字 / 标签
创作者注释（折叠）
角色描述     ← textarea，自动保存
开场白       ← textarea，自动保存
  └ 其他开场（alternate_greetings）
```

**二级（点「高级定义…」开弹窗）**：
```
提示词覆盖（折叠）：system_prompt / post_history_instructions
创作者元数据（折叠）：creator / character_version
角色设定摘要：personality
情景：scenario
对话示例：mes_example
```

字段全部 `<textarea>`，停止输入 600ms 后自动 PUT，头部显示「保存中… / 已保存」。

## 四、附带

- `frontend/src/debug/samples/` 里的 Anima + 默认预设，后端首次启动时 seed 进库（照 `seed_default_connections` 写法），新装打开就有东西可选
- 迁移脚本给已有库补 `source_card_id`

## 五、实施顺序

**本轮范围 = 1~3 步**，每步独立可验证：

1. ~~**后端**：建表 + CRUD API + seed~~ ✅ **已完成**（18 项端到端测试全通过）
   - `app/models.py`：`TavernCard` + `PromptPreset`
   - `app/schemas.py`：对应的 Create / Update（全可选，支持单字段 PUT）/ Out
   - `app/api/tavern.py`：CRUD + duplicate + avatar 端点
   - `app/seed_data/`：Anima 卡 + 默认预设，`seed_default_tavern_data()` 首启注入
2. ~~**前端预设**：下拉 + 显式保存 + 脏标记 + 恢复~~ ✅ **已完成**（浏览器实测通过）
   - `lib/api.ts`：预设 / 角色卡两组端点的客户端方法 + 类型
   - `lib/presetStore.ts`：DB 形态 ↔ 组装器形态互转，`presetToStored` 负责把临时开关合并回 `prompt_order`
   - `components/PresetPanel.tsx`：两行工具条、表头、toggle 开关、块内容编辑（marker 无编辑按钮）
   - `DebugApp.tsx`：保存 / 另存为 / 重命名 / 恢复 / 删除 / 导入 / 导出 + 脏标记联动
   - 实测：改开关 → 脏点亮起 + 保存按钮高亮 → 保存 → **刷新后改动仍在**；恢复正确回滚；另存为自动切到新预设；删除后回落到剩余预设
3. ~~**前端角色卡**：两层结构 + 字段可编辑 + 自动保存~~ ✅ **已完成**（浏览器实测通过）
   - `lib/cardStore.ts`：DB 形态 ↔ 组装器形态互转、导出 V2 卡 JSON、PNG → data URL
   - `components/CardPanel.tsx`：一级只放描述 + 开场白（可编辑）、头像可点击更换、开场白翻页（含其他开场增删）
   - `components/AdvancedDefinitions.tsx`：二级弹窗，分组照抄酒馆（提示词覆盖 / 角色定义 / 创作者元数据）
   - `DebugApp.tsx`：自动保存（debounce 600ms + 保存中/已保存状态）、新建 / 复制 / 删除 / 导入 / 导出 / 换头像
   - 实测：改描述 → 「保存中…」→ 落库（curl 确认）；新建自动切过去；删除后回落到剩余卡

**本轮 1~3 步全部完成。**

**下一轮**：

4. **自动同步桥**：保存角色卡时后端自动 upsert 游戏 `Character`

## 记一笔（本轮不做）

- **`extensions.depth_prompt`**：酒馆「高级定义」里的「角色备注 + @深度 + 身份」，现有 `cardParser.ts` 只把 `extensions` 整体存下来没解析它，`assembler.ts` 也没用。属于组装逻辑增强。
- **`talkativeness`**：酒馆群聊用，我们没群聊。
- 保存行为（自动/显式）之后要做成设置项可切换。
