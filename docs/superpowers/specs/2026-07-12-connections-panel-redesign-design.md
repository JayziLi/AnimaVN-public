# ConnectionsPanel 重设计:参考 SillyTavern 的单页连接配置

## 背景

当前 `frontend/src/components/ConnectionsPanel.tsx` 是"列表页 + 独立编辑表单页"两层结构:先看到所有已存连接的卡片列表,点"编辑"或"新建连接"才进入表单。模型列表要点"获取列表"才现场发一次真实网络请求去反代拉,每次打开表单都是空的,拉一次等一次。测试连接的 `/test` 端点把"连不连得上"和"模型有没有回复"合并成一次调用(发一条写死的"Hi!")。所有报错都以字段下方的小字 `.modal-error` 展示,分散在不同位置。

用户参考 SillyTavern 的连接配置面板,提出四个痛点,已经通过 brainstorming 逐条确认了具体做法(见下)。

## 一、整体结构

`ConnectionsPanel` 从"list/form 两个 view"合并成一个单一视图:

- 顶部:已保存连接的下拉选择器 + 图标按钮行(新建 / 保存 / 删除)。选中下拉里的某个连接 = 把该连接的信息填进下面的表单,同时立即把它设为 `is_active`(当前生效连接)——不再需要单独的"启用"按钮,选中即启用,和 SillyTavern 的下拉语义一致。
- 下方:和现在一样的字段(名称、类型、BASE URL、API KEY、模型名)。
- 模型名那一行保留一个独立的"刷新列表"按钮(取代现在的"获取列表",作用类似但拉到后会存进数据库缓存)。
- "可用模型"下拉的数据来源是数据库里缓存的 `cached_models`,面板打开、切换连接时立即可见,不需要现场发请求等待。
- 底部两个独立按钮:"连接"(轻量 ping,不碰模型列表/缓存)、"发送测试消息"(发一条**用户可编辑**的测试消息,拿模型真实回复,不再写死"Hi!")。
- 所有报错和动作结果(刷新列表失败、连接成功/失败、测试消息的回复或报错、保存失败……)统一显示在面板**最顶部**的一条横幅里,视觉上参照现有的绿色"连接成功"toast,不再是字段下方分散的小字。

## 二、后端改动

### 数据模型

`backend/app/models.py` 的 `ApiConnection` 新增两列:

- `cached_models: Mapped[list] = mapped_column(JSON, default=list)` —— 上一次成功拉取到的模型 id 列表
- `cached_models_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)` —— 缓存时间

写一个一次性迁移脚本 `backend/scripts/migrate_connection_cache_columns.py`,参照 `migrate_character_columns.py` 的写法,给 `api_connections` 表补这两列(SQLite `ALTER TABLE ... ADD COLUMN`,已存在则跳过)。

### 端点

`backend/app/api/connections.py`:

- **`POST /{id}/refresh-models`**(新增,取代 `GET /{id}/models`):调用 `provider.list_models()`,成功后把结果写入该连接的 `cached_models` + `cached_models_at` 并 commit,返回这个数组。失败见下方"错误处理"。
- **`POST /{id}/ping`**(新增,取代 `POST /{id}/test` 里"测连通性"的部分):同样内部调用 `provider.list_models()`(目前两个 provider 都没有比这更轻量的、专门验证鉴权的端点,`/models` 已经是最便宜的已鉴权调用),但只返回 `ConnectionTestResult{ok, message}`,**不**返回、也不写入 `cached_models`——保证"连接"这个动作绝不会顺带刷新模型列表。
- **`POST /{id}/test-message`**(新增,取代 `POST /{id}/test` 里"测模型回复"的部分):请求体 `{content: str}`,是用户在前端文本框里编辑过的测试消息;调用 `provider.complete([ChatMessage(role="user", content=content)], conn.model)`,返回模型的原始回复文本。
- 删除旧的 `POST /{id}/test` 和 `GET /{id}/models`(功能被上面三个端点替代)。
- **`DELETE /{id}` 的"不能删除当前启用连接"限制去掉,改成自动转移**:因为现在"选中下拉里的某条 = 激活它",表单里显示的永远是当前 active 的那条,如果还照搬旧的 409 限制,就等于永远删不掉表单里正在看的这条,功能锁死。改成:删除时如果这条正好是 `is_active`,且删除后还有其他连接存在,就自动把其中一条(按 `created_at` 取最新的一条)设为新的 active;如果这是最后一条连接,删除后允许 `is_active` 全部为空(对应"还没配置任何连接"的空状态,前端本来就需要处理这个状态)。
- `POST /models-preview`(未保存表单配置也能测,行为保持不变)同样改成透传原始错误。
- `GET /api/connections`(列表)和 `GET /{id}`(如果将来需要单独取)对应的 `ConnectionOut` schema 新增 `cached_models: list[str]`、`cached_models_at: datetime | None` 字段,前端切换下拉选项时不需要额外请求就能看到已缓存的模型。

### 错误处理:仅限这三个新端点透传原始报错

`backend/app/llm/errors.py` 的 `LLMError` 和每个 provider(`openai_provider.py`、`anthropic_provider.py`)的 `_map_error` **不改动**——真实聊天路径(`POST /sessions/{id}/messages`)继续用现在的中文友好提示,这部分已经验证过、要保留。

只在 `refresh-models` / `ping` / `test-message` 这三个新端点里,捕获 `LLMError` 后不用 `e.message`(中文),而是取 `e.__cause__`(`raise self._map_error(e) from e` 已经把原始 SDK 异常链到 `__cause__` 上了)、`str()` 化后作为报错内容返回给前端;如果 `__cause__` 是 `None`,就还是用 `e.message`,因为这类错误压根没有对应的"原始英文版本"。

这种"没有 `__cause__`"的情况目前只有一处:`test-message` 需要 `conn.model` 非空才能调用 `provider.complete(...)`,如果模型名没填,直接返回我们自己写的校验提示(不经过 provider,自然没有原始异常可言)。`refresh-models`/`ping` 都只依赖 `provider.list_models()`,不需要 `model` 字段,没有这一层校验。

## 三、前端改动

`frontend/src/components/ConnectionsPanel.tsx`:

- 去掉 `view: "list" | "form"` 这个 state,改成单一表单 + `selectedId: string | null`(对应下拉当前选中的连接;`null` = 正在新建)。
- 新增顶部结果横幅的 state:`banner: { kind: "ok" | "error"; message: string } | null`,三个动作(刷新列表 / 连接 / 发送测试消息)以及保存/删除失败都写这个 state,不再各自维护零散的 `error`/`testResults`。
- 顶部:`<select>` 下拉列出所有连接(按名称),选中触发"加载该连接到表单 + 调用 activate";图标按钮:新建(清空表单)、保存(新建或更新当前表单)、删除(带二次确认,复用现有"再点一次确认"交互)。
- 模型名那一行的"获取列表"按钮改名"刷新列表",调用新的 `refresh-models`,成功后直接更新本地这条连接的 `cached_models`(不需要重新拉整个列表)。
- 新增一个小文本框,承载"发送测试消息"的可编辑内容,默认占位文案沿用现在测试用的 "Hi! Reply with one short sentence."。
- 底部"连接"、"发送测试消息"两个按钮各自调用新端点,结果写入顶部 `banner`。

`frontend/src/api/client.ts` 对应新增/调整:`refreshConnectionModels`、`pingConnection`、`testConnectionMessage(id, content)`,删除不再使用的 `testConnection`、`listConnectionModels`。

`frontend/src/types.ts` 的 `Connection` 类型新增 `cached_models: string[]`、`cached_models_at: string | null`。

## 四、范围边界

- 不改动真实聊天发送消息路径的错误提示(仍是中文友好版)。
- 不改动 `mock` 类型连接的行为(`list_models()` 默认返回空数组,`ping`/`test-message` 对 mock 类型可以直接走现有 mock provider 的固定回复逻辑,不需要特殊处理)。
- 不新增"连接测试历史记录"之类的额外持久化,只缓存"最近一次"的模型列表。
