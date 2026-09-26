# AnimaBackend 测试指南

这份文档既是运行说明，也是给后续 agent 的测试边界和设计交接。

## 目标与原则

后端测试优先保护用户可观察的行为，而不是 SQLAlchemy 查询写法或私有辅助函数。

采用三个测试缝：

1. FastAPI 公共 HTTP API：角色、会话、存档、聊天、连接、Persona、酒馆数据、调试聊天。
2. LLM/流处理公开接口：内置 Mock provider 的离线调用，以及 `ThinkTagSplitter`。
3. 稳定格式边界：Galgame 台词 JSON 和 SillyTavern JSONL。

测试不访问真实 LLM，不依赖网络，不读取或修改 `data/animabackend.db`。

## 安装

在 `AnimaBackend` 目录下执行：

```powershell
python -m pip install -e ".[test]"
```

`pyproject.toml` 的 `test` 可选依赖包含 pytest、FastAPI TestClient 所需的 httpx，
以及可选的覆盖率工具 pytest-cov。

## 运行

运行全套测试：

```powershell
pytest
```

安静模式：

```powershell
pytest -q
```

只运行一个文件或一个行为：

```powershell
pytest tests/test_debug_chats_api.py
pytest -k "branch"
```

生成终端覆盖率报告：

```powershell
pytest --cov=app --cov-report=term-missing
```

第一次运行建议不要先看覆盖率目标。先确认失败是否暴露真实行为差异，再决定修实现还是修测试契约。

## 数据隔离

`tests/conftest.py` 为每个测试创建一个全新的内存 SQLite 数据库，并通过 FastAPI
dependency override 替换 `get_db`。

有一个容易踩坑的细节：测试客户端故意不使用 `with TestClient(app)`。上下文管理器会
执行应用 lifespan，而生产 lifespan 会连接配置中的数据库并运行 seed。当前写法只发起
ASGI 请求，不启动 lifespan，因此真实数据库不会被碰到。

如果未来改成应用工厂（如 `create_app(database_url=...)`），可以重新评估这个限制，但必须
继续保证测试不会连接真实数据库。

## 测试文件和覆盖范围

### `test_reasoning.py`

- `<think>` / `<thinking>` 分流
- 标签跨任意网络 chunk
- 未闭合标签
- 正文中的字面标签
- 尾部残缺标签与首部空白

### `test_debug_completion_api.py`

- 调试台 assembled messages 的非流式转发
- 空 messages 和未知连接校验
- SSE 的 meta、reasoning、delta、done 顺序及响应头
- 空流返回 error frame
- 首 token 前失败仍返回正常 HTTP 502
- inline `<think>` 跨 chunk 解析并标记为 `parsed`
- 已输出部分正文后上游断开，返回 error frame 且不发送 done
- provider 是外部系统边界，因此这里使用实现 `LLMProvider` 的脚本化 fake

### `test_openai_provider.py`

- OpenAI 兼容端点的 message role、model、base URL 和鉴权请求映射
- 无用户 API key 的 Ollama/LM Studio 类本地端点占位密钥
- 非流式回复、空 choices、模型列表
- `reasoning_content` 与 `reasoning` 两种流式思考字段
- usage-only stream frame 忽略
- 401、403、404、429、500 的可操作错误文案

### `test_anthropic_provider.py`

- 多段 system message 移出 turns 并按 Anthropic 协议合并
- 无 system message、多个 text block、thinking block 不混入公开回复
- 模型列表
- `thinking_delta` / `text_delta` 分流及 signature delta 忽略
- 401、403、404、429、500 的可操作错误文案

### `test_llm_registry.py`

- 三种 API type 的 provider 选择
- Anthropic 缺少密钥和未知 API type 的错误
- 基类 stream fallback 与空模型列表
- Mock provider 使用最新用户消息，并保持 reasoning/body 流分离

### `test_startup.py`

- 通过真实 FastAPI lifespan 验证首次启动资源完整，测试 engine 与生产数据库完全隔离
- 重启幂等且保留用户对内置人设的编辑
- 环境变量连接只种一次，存在真实连接时优先激活真实连接
- 删除内置角色卡后重启只补回缺失卡，不覆盖仍存在的预设

### `test_migration_scripts.py`

- 通过真实 CLI 在临时文件 SQLite 上运行连接、聊天相关的 `migrate_*.py`
- 旧连接和聊天数据在加列后保持不变
- 新列默认值与 nullable 规则正确
- 同一迁移连续执行两次保持幂等
- 当前完整 schema 上运行迁移是安全 no-op

### `test_connections_personas_api.py`

- 唯一 active connection / persona
- API key 不出现在响应中、保留和显式清除
- 删除活动连接后的替补规则
- Mock 连接诊断
- Persona 名称清理、头像清除及删除活动 Persona 的规则

### `test_tavern_api.py`

- TavernCard / PromptPreset CRUD、部分更新和复制
- 头像从列表响应分离
- 空预设名校验
- 删除卡或预设后，历史聊天仍可读取，冻结名称仍保留

### `test_debug_chats_api.py`

- 聊天绑定名称、消息 upsert、排序、删除及预览
- 同一消息 ID 跨聊天冲突
- Prompt snapshot 抽离、按 hash 复用、懒加载
- 从指定消息分支、稀疏 idx、父聊天删除后的提升行为
- 单聊天 JSONL 和整棵分支 ZIP 导出
- 多文件 JSONL 导入、角色卡匹配和孤儿聊天

### `test_st_chat_codec.py`

- Windows 安全文件名和分支后缀
- UTC 时间格式
- 坏行容忍、swipe 选择边界
- reasoning、耗时和分支链接字段映射
- export → parse 的关键内容往返

## 外部服务与 mock 规则

- 自动测试永远不调用 OpenAI、Anthropic、中转站或本地 Ollama。
- 能用内置 `MockProvider` 的 API 路径就使用它。
- 将来测试真实 provider 适配器时，只能在 HTTP/SDK 边界使用 fake transport；不要 mock
  自己的路由、repository 或 SQLAlchemy model。
- 真实服务的 smoke test 必须单独标记且默认跳过，密钥只能从环境变量读取。

## 首次运行后的处理方式

测试是在当前公开接口和已有设计注释基础上写的。首次运行可能出现三类结果：

1. 测试代码或 fixture 错误：修测试基础设施。
2. 实现与已承诺行为不一致：保留失败测试，修后端实现。
3. 产品规则尚未定：不要偷偷迎合实现；把规则记录到设计文档后再更新测试。

目前特别值得关注的边界是：

- 删除父聊天后，子聊天是否真正提升为根节点。
- 分支源消息的 `idx` 不连续时，`message_count` 是否为实际消息数。
- SQLite 外键行为在内存测试库和部署库中是否一致。

这些测试刻意写成用户可观察的契约，目的是让首次红灯暴露问题，而不是为了让测试第一次就全绿。

## 当前验证基线

2026-08-20 在项目 `.venv`（Python 3.11.9）中完成验证：

```text
134 passed, 1 warning
TOTAL 1766 statements, 85 missed, 95% coverage
```

首次红灯发现并修复了六个后端边界问题：

- 分支源消息使用稀疏 `idx` 时，`message_count` 错把 idx 当数量。
- 删除父聊天后，子聊天仍指向已经不存在的父 ID。
- 台词解析不接受大写 `JSON` code fence。
- fallback 分句遗漏中文全角 `！` 和 `？`。
- 模型返回空 JSON 数组时显示字面量 `[]`，而不是可播放占位台词。
- JSONL 导入会在早期 swipe 没有 metadata 时把后续 reasoning 左移错位。

2026-09-24 删掉旧 galgame 后端(角色 / 存档 / 对话接口、台词解析器和 `/api/models`)
及其测试后:`155 passed, 1 warning`(含这期间新增的立绘、场景包、语音测试)。

唯一 warning 来自当前 FastAPI/Starlette TestClient：它提示未来应从 `httpx` 迁移到
`httpx2`。这是依赖层弃用提示，不影响当前 134 项结果；升级 FastAPI/Starlette 时再统一处理，
不要为消除 warning 擅自改测试客户端协议。

覆盖率不是门禁。OpenAI/Anthropic provider 使用 SDK 后面的 HTTP fake transport 覆盖请求映射、
流式事件和错误映射；它们分别达到 83% 和 82%，全程不使用真实密钥或网络。剩余未覆盖部分
主要是连接/超时异常和流中途断开，后续补测时仍应坚持相同的外部边界。

## 给后续 agent 的修改规范

- 新增后端能力时，在最接近的现有测试文件里补行为测试；只有新领域才新建文件。
- 测试名写“用户/调用方能做什么”，不要写内部函数调用次数。
- 预期值使用明确字面量，不复制实现算法计算 expected。
- API 写入后的验证优先通过 GET API，不直接查数据库。
- 每个测试应可独立运行，不依赖执行顺序或其他测试留下的数据。
- 失败信息不够清晰时，先缩小 fixture，再增加断言；避免把整份大 JSON 做快照测试。
- 交接前必须在只含已提交后端文件的分支上跑全套，不能依赖工作区未提交实现。
