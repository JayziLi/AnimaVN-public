# ConnectionsPanel 重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 API 连接设置面板从"列表 + 独立编辑表单"两层结构,改造成参考 SillyTavern 的单页面板:顶部下拉选择/激活已存连接,模型列表持久化缓存到数据库(不用每次现场拉),"连接"(轻量 ping)和"发送测试消息"(真实调模型)彻底分开,所有结果/报错统一显示在面板顶部,且这三个新动作的报错不翻译成中文、直接透传 provider 原始错误。

**Architecture:** 后端给 `ApiConnection` 加两列做模型列表缓存,新增三个端点(`refresh-models`/`ping`/`test-message`)替换旧的 `/test`、`GET /models`,删除逻辑改成"删掉当前激活连接时自动把另一条设为激活"。前端 `ConnectionsPanel.tsx` 从 `list`/`form` 两个 view 合并成一个,靠 `selectedId` driving 表单内容,新增一条顶部横幅统一承载所有结果/报错。

**Tech Stack:** 后端 FastAPI + SQLAlchemy + SQLite(裸 `ALTER TABLE` 迁移脚本,和 `migrate_character_columns.py` 一个套路);前端 React 19 + TypeScript,纯 CSS。两边都没有配置自动化测试框架(无 pytest/无 vitest),验证靠 `curl`/`npm run build`+`npm run lint`/Playwright 真实浏览器操作,延续本仓库一贯的做法。

## Global Constraints

- 真实聊天发送消息那条路径(`POST /api/sessions/{id}/messages`)的中文错误提示**不变**,不要动 `backend/app/llm/errors.py` 或任何 provider 的 `_map_error`。
- 只有这次新增的三个端点(`refresh-models`/`ping`/`test-message`)透传原始报错;其余端点该中文还是中文。
- `mock` 类型连接的行为不特殊处理,走和其他类型一样的代码路径(`MockProvider.list_models()` 已经返回 `["mock"]`,`ping`/`refresh-models` 对它自然能用)。
- 不新增任何测试框架或测试文件——用 `curl`(后端)和 `npm run build`/`npm run lint`+Playwright(前端)验证,这是本仓库现有的做法。
- 后端 dev server 不带 `--reload`(`start.bat` 里是裸 `uvicorn app.main:app`),改完后端代码要手动重启进程才能生效。

---

## 文件改动总览

| 文件 | 改动 |
|---|---|
| `backend/app/models.py` | `ApiConnection` 新增 `cached_models`/`cached_models_at` 两列 |
| `backend/scripts/migrate_connection_cache_columns.py` | 新建,给现有 SQLite 库补这两列 |
| `backend/app/schemas.py` | `ConnectionOut` 加两个字段;新增 `TestMessageRequest`/`TestMessageResult` |
| `backend/app/api/connections.py` | 新增 `refresh-models`/`ping`/`test-message` 三个端点;删除旧 `/test`、`GET /models`;delete 端点改成自动转移 active |
| `frontend/src/types.ts` | `Connection` 加 `cached_models`/`cached_models_at` |
| `frontend/src/api/client.ts` | 删 `testConnection`/`listConnectionModels`,加 `refreshConnectionModels`/`pingConnection`/`testConnectionMessage` |
| `frontend/src/App.css` | 删掉不再用的 `.conn-row` 系列(列表卡片样式),新增 `.conn-banner` 顶部横幅样式 |
| `frontend/src/components/ConnectionsPanel.tsx` | 整份重写:单页 + 顶部下拉选择器 + 顶部结果横幅 |

---

### Task 1: 后端数据模型 + schema

**Files:**
- Modify: `backend/app/models.py:18-30`(`ApiConnection` 类)
- Create: `backend/scripts/migrate_connection_cache_columns.py`
- Modify: `backend/app/schemas.py:142-166`(`ConnectionOut`,新增两个 schema)

**Interfaces:**
- Produces:`ApiConnection.cached_models: list[str]`、`ApiConnection.cached_models_at: datetime | None`;Pydantic `ConnectionOut` 对应两个新字段;`TestMessageRequest{content: str}`、`TestMessageResult{reply: str}`。Task 2 的端点直接读写这些字段/用这些 schema。

- [ ] **Step 1: 给 `ApiConnection` 加两列**

把 `backend/app/models.py` 里的:

```python
class ApiConnection(Base):
    """A user-defined LLM API connection profile (SillyTavern-style)."""

    __tablename__ = "api_connections"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(120))
    api_type: Mapped[str] = mapped_column(String(32))  # "openai_compatible" | "anthropic" | "mock"
    base_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    api_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    model: Mapped[str] = mapped_column(String(200), default="")
    is_active: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
```

改成:

```python
class ApiConnection(Base):
    """A user-defined LLM API connection profile (SillyTavern-style)."""

    __tablename__ = "api_connections"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(120))
    api_type: Mapped[str] = mapped_column(String(32))  # "openai_compatible" | "anthropic" | "mock"
    base_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    api_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    model: Mapped[str] = mapped_column(String(200), default="")
    cached_models: Mapped[list] = mapped_column(JSON, default=list)
    cached_models_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    is_active: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
```

（`JSON` 已经在文件顶部 `from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text` 里导入过，不用再加 import。）

- [ ] **Step 2: 新建迁移脚本**

新建 `backend/scripts/migrate_connection_cache_columns.py`:

```python
"""One-off dev migration: add cached_models/cached_models_at to api_connections."""

import sqlite3

db = sqlite3.connect("data/animavn.db")
cols = {r[1] for r in db.execute("PRAGMA table_info(api_connections)")}
for name, ddl in [
    ("cached_models", "ALTER TABLE api_connections ADD COLUMN cached_models TEXT NOT NULL DEFAULT '[]'"),
    ("cached_models_at", "ALTER TABLE api_connections ADD COLUMN cached_models_at DATETIME"),
]:
    if name not in cols:
        db.execute(ddl)
        print("added", name)

db.commit()
print([r[1] for r in db.execute("PRAGMA table_info(api_connections)")])
```

- [ ] **Step 3: 跑迁移脚本**

Run: `cd backend && .venv\Scripts\python.exe scripts/migrate_connection_cache_columns.py`
Expected: 打印 `added cached_models`、`added cached_models_at`,最后打印的列名列表里包含这两个新列。如果脚本之前跑过一次,再跑一次应该什么都不打印(列已存在,幂等)。

- [ ] **Step 4: 更新 `ConnectionOut` + 新增两个 schema**

把 `backend/app/schemas.py` 里的:

```python
class ConnectionOut(BaseModel):
    id: str
    name: str
    api_type: str
    base_url: str | None
    model: str
    has_api_key: bool
    is_active: bool
```

改成:

```python
class ConnectionOut(BaseModel):
    id: str
    name: str
    api_type: str
    base_url: str | None
    model: str
    has_api_key: bool
    is_active: bool
    cached_models: list[str]
    cached_models_at: datetime | None
```

然后在文件末尾（`ModelsPreviewRequest` 之后）追加:

```python


class TestMessageRequest(BaseModel):
    content: str


class TestMessageResult(BaseModel):
    reply: str
```

- [ ] **Step 5: 语法检查**

Run: `cd backend && .venv\Scripts\python.exe -c "import app.models, app.schemas"`
Expected: 无输出、无报错(能正常 import 说明没有语法/类型标注错误)。

- [ ] **Step 6: Commit**

```bash
git add backend/app/models.py backend/app/schemas.py backend/scripts/migrate_connection_cache_columns.py
git commit -m "feat: add cached_models columns to ApiConnection + related schemas"
```

---

### Task 2: 后端端点——refresh-models / ping / test-message,delete 自动转移

**Files:**
- Modify: `backend/app/api/connections.py`(整份小文件,139 行,直接给出完整改动位置)

**Interfaces:**
- Consumes:Task 1 的 `ApiConnection.cached_models`/`cached_models_at`、`ConnectionOut`(新字段自动通过 `_out()` 带出去,见下)、`TestMessageRequest`/`TestMessageResult`。
- Produces:`POST /api/connections/{id}/refresh-models` → `list[str]`;`POST /api/connections/{id}/ping` → `ConnectionTestResult`;`POST /api/connections/{id}/test-message`(body `{content: str}`)→ `TestMessageResult`。三者失败都是 HTTP 502,`detail` 是 provider 原始报错文本(或者我们自己的校验文案,没有模型名的情况下 400)。Task 3 的前端 client 直接对接这三个端点。

- [ ] **Step 1: 加 import + `_raw_detail` 辅助函数 + 更新 `_out()`**

把文件顶部的 import 块:

```python
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.llm.base import ChatMessage
from app.llm.errors import LLMError
from app.llm.registry import provider_for
from app.models import ApiConnection
from app.schemas import (
    ConnectionCreate,
    ConnectionOut,
    ConnectionTestResult,
    ConnectionUpdate,
    ModelsPreviewRequest,
)
```

改成:

```python
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.llm.base import ChatMessage
from app.llm.errors import LLMError
from app.llm.registry import provider_for
from app.models import ApiConnection
from app.schemas import (
    ConnectionCreate,
    ConnectionOut,
    ConnectionTestResult,
    ConnectionUpdate,
    ModelsPreviewRequest,
    TestMessageRequest,
    TestMessageResult,
)


def _raw_detail(e: LLMError) -> str:
    """provider 原始异常(如果有)优先,没有的话才退回到我们自己写的校验文案。"""
    return str(e.__cause__) if e.__cause__ is not None else e.message
```

把 `_out()` 函数:

```python
def _out(conn: ApiConnection) -> ConnectionOut:
    return ConnectionOut(
        id=conn.id,
        name=conn.name,
        api_type=conn.api_type,
        base_url=conn.base_url,
        model=conn.model,
        has_api_key=bool(conn.api_key),
        is_active=conn.is_active,
    )
```

改成:

```python
def _out(conn: ApiConnection) -> ConnectionOut:
    return ConnectionOut(
        id=conn.id,
        name=conn.name,
        api_type=conn.api_type,
        base_url=conn.base_url,
        model=conn.model,
        has_api_key=bool(conn.api_key),
        is_active=conn.is_active,
        cached_models=conn.cached_models,
        cached_models_at=conn.cached_models_at,
    )
```

- [ ] **Step 2: delete 端点改成自动转移 active**

把:

```python
@router.delete("/{connection_id}", status_code=204)
def delete_connection(connection_id: str, db: Session = Depends(get_db)):
    conn = _load(connection_id, db)
    if conn.is_active:
        raise HTTPException(409, "不能删除当前启用的连接，请先切换到其他连接")
    db.delete(conn)
    db.commit()
```

改成:

```python
@router.delete("/{connection_id}", status_code=204)
def delete_connection(connection_id: str, db: Session = Depends(get_db)):
    conn = _load(connection_id, db)
    was_active = conn.is_active
    db.delete(conn)
    db.flush()
    if was_active:
        remaining = db.scalar(select(ApiConnection).order_by(ApiConnection.created_at.desc()))
        if remaining is not None:
            remaining.is_active = True
    db.commit()
```

- [ ] **Step 3: 删掉旧的 `/test` 和 `GET /models`,加三个新端点**

删除整个 `test_connection` 函数（`@router.post("/{connection_id}/test", ...)` 那一段，从 `@router.post("/{connection_id}/test", response_model=ConnectionTestResult)` 到它结束的 `return ConnectionTestResult(ok=True, message=f"连接成功，模型回复：{preview}")` 那一行）。

删除整个 `list_remote_models` 函数（文件最后的 `@router.get("/{connection_id}/models", ...)` 那一段）。

在被删掉的这两段原来的位置，加上：

```python
@router.post("/{connection_id}/refresh-models", response_model=list[str])
async def refresh_models(connection_id: str, db: Session = Depends(get_db)):
    conn = _load(connection_id, db)
    try:
        provider = provider_for(conn)
        models = await provider.list_models()
    except LLMError as e:
        raise HTTPException(502, _raw_detail(e)) from e
    conn.cached_models = models
    conn.cached_models_at = datetime.now(timezone.utc)
    db.commit()
    return models


@router.post("/{connection_id}/ping", response_model=ConnectionTestResult)
async def ping_connection(connection_id: str, db: Session = Depends(get_db)):
    conn = _load(connection_id, db)
    try:
        provider = provider_for(conn)
        models = await provider.list_models()
    except LLMError as e:
        raise HTTPException(502, _raw_detail(e)) from e
    return ConnectionTestResult(ok=True, message=f"连接成功，探测到 {len(models)} 个可用模型")


@router.post("/{connection_id}/test-message", response_model=TestMessageResult)
async def test_message(
    connection_id: str, req: TestMessageRequest, db: Session = Depends(get_db)
):
    conn = _load(connection_id, db)
    if conn.api_type != "mock" and not conn.model:
        raise HTTPException(400, "请先填写模型名再测试")
    try:
        provider = provider_for(conn)
        reply = await provider.complete([ChatMessage(role="user", content=req.content)], conn.model)
    except LLMError as e:
        raise HTTPException(502, _raw_detail(e)) from e
    return TestMessageResult(reply=reply)
```

- [ ] **Step 4: `models-preview` 也切换成原始报错**

把 `preview_models` 函数里的:

```python
    try:
        provider = provider_for(temp)
        return await provider.list_models()
    except LLMError as e:
        raise HTTPException(502, e.message) from e
```

改成:

```python
    try:
        provider = provider_for(temp)
        return await provider.list_models()
    except LLMError as e:
        raise HTTPException(502, _raw_detail(e)) from e
```

- [ ] **Step 5: 语法检查 + 启动服务器**

Run: `cd backend && .venv\Scripts\python.exe -c "import app.main"`
Expected: 无报错（FastAPI app 能正常装配路由，说明没有引用不存在的符号）。

如果本地已经有 uvicorn 进程在跑（`start.bat` 起的，没有 `--reload`），杀掉重启：
Run: 找到现有的 `uvicorn app.main:app` 进程关掉，然后 `cd backend && .venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000`（新开一个终端保持常驻）

- [ ] **Step 6: 用 curl 验证三个新端点**

先拿一个真实存在的 mock 连接 id（没有的话，先 `curl -X POST http://127.0.0.1:8000/api/connections -H "Content-Type: application/json" -d "{\"name\":\"测试Mock\",\"api_type\":\"mock\",\"model\":\"mock\"}"` 建一个，从返回的 JSON 里读 `id`）。

Run: `curl -s -X POST http://127.0.0.1:8000/api/connections/<id>/refresh-models`
Expected: `["mock"]`

Run: `curl -s -X POST http://127.0.0.1:8000/api/connections/<id>/ping`
Expected: `{"ok":true,"message":"连接成功，探测到 1 个可用模型"}`

Run: `curl -s -X POST http://127.0.0.1:8000/api/connections/<id>/test-message -H "Content-Type: application/json" -d "{\"content\":\"你好\"}"`
Expected: `{"reply":"...json 台词数组字符串..."}`（mock provider 固定返回一段 JSON 格式的台词）

Run: `curl -s http://127.0.0.1:8000/api/connections/<id>`（如果没有单条 GET 端点就用 `curl -s http://127.0.0.1:8000/api/connections`，在返回的数组里找这条）
Expected: 这条连接的 JSON 里能看到 `"cached_models":["mock"]`（refresh-models 那一步已经把它存进数据库了）

Run: `curl -s -o /dev/null -w "%{http_code}" -X DELETE http://127.0.0.1:8000/api/connections/<id>`（如果这条恰好是当前 active 的，删除应该成功而不是像以前那样报 409；如果它不是 active 的也应该正常成功）
Expected: `204`

- [ ] **Step 7: Commit**

```bash
git add backend/app/api/connections.py
git commit -m "feat: split connect/test-message, cache model lists, raw error passthrough"
```

---

### Task 3: 前端类型 + API 客户端

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api/client.ts`

**Interfaces:**
- Consumes:Task 2 的三个新端点、`ConnectionOut` 的新字段。
- Produces:`Connection.cached_models: string[]`、`Connection.cached_models_at: string | null`;`api.refreshConnectionModels(id): Promise<string[]>`、`api.pingConnection(id): Promise<ConnectionTestResult>`、`api.testConnectionMessage(id, content): Promise<{reply: string}>`。Task 5 的 `ConnectionsPanel.tsx` 直接用这些。

- [ ] **Step 1: `types.ts` 加字段**

把:

```ts
export interface Connection {
  id: string;
  name: string;
  api_type: ApiType;
  base_url: string | null;
  model: string;
  has_api_key: boolean;
  is_active: boolean;
}
```

改成:

```ts
export interface Connection {
  id: string;
  name: string;
  api_type: ApiType;
  base_url: string | null;
  model: string;
  has_api_key: boolean;
  is_active: boolean;
  cached_models: string[];
  cached_models_at: string | null;
}
```

- [ ] **Step 2: `client.ts` 替换连接相关方法**

把:

```ts
  testConnection: (id: string) =>
    request<ConnectionTestResult>(`/api/connections/${id}/test`, { method: "POST" }),

  listConnectionModels: (id: string) => request<string[]>(`/api/connections/${id}/models`),
```

改成:

```ts
  refreshConnectionModels: (id: string) =>
    request<string[]>(`/api/connections/${id}/refresh-models`, { method: "POST" }),

  pingConnection: (id: string) =>
    request<ConnectionTestResult>(`/api/connections/${id}/ping`, { method: "POST" }),

  testConnectionMessage: (id: string, content: string) =>
    request<{ reply: string }>(`/api/connections/${id}/test-message`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
```

- [ ] **Step 3: 类型检查**

Run: `cd frontend && npm run build`
Expected: 这一步预期会失败——`ConnectionsPanel.tsx` 还在用刚删掉的 `api.testConnection`/`api.listConnectionModels`，Task 5 才会修它。确认报错信息只集中在 `ConnectionsPanel.tsx` 里，不是别的地方。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/types.ts frontend/src/api/client.ts
git commit -m "feat: add cached_models to Connection type, swap client methods for the new endpoints"
```

（`ConnectionsPanel.tsx` 会在 Task 5 里跟进，build 到时候才会重新变绿。）

---

### Task 4: 前端 CSS——删列表卡片样式，加顶部结果横幅

**Files:**
- Modify: `frontend/src/App.css`

**Interfaces:**
- Produces:`.conn-banner`、`.conn-banner.ok`、`.conn-banner.error` 三个 class，供 Task 5 使用。

- [ ] **Step 1: 删掉不再使用的 `.conn-row` 系列**

在 `frontend/src/App.css` 里找到从 `/* --- connections panel --- */` 开始、到 `.conn-actions { ... }` 结束的整段（大致是 `.conn-row`、`.conn-row.active`、`.conn-main`、`.conn-title`、`.conn-dot`、`.conn-dot.on`、`.conn-name`、`.conn-chip`、`.conn-chip.accent`、`.conn-meta`、`.conn-test-result`、`.conn-test-result.ok`、`.conn-actions` 这些规则），整段删除。

- [ ] **Step 2: 加顶部结果横幅样式**

在刚才删除的位置，加上:

```css
/* --- connections panel: top result banner --- */
.conn-banner {
  margin-bottom: 14px;
  padding: 10px 14px;
  border-radius: var(--radius, 10px);
  font-size: 0.88rem;
  line-height: 1.5;
  word-break: break-word;
  white-space: pre-wrap;
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

（`white-space: pre-wrap` 是因为原始报错文本可能带换行，直接透传的时候不希望被压成一行。）

- [ ] **Step 3: lint**

Run: `cd frontend && npm run lint`
Expected: 0 error（纯 CSS 改动，`npm run build` 这一步这时候预期还是红的，Task 3 遗留的，Task 5 才会修）

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.css
git commit -m "style: replace connection list-card styles with a single top result banner"
```

---

### Task 5: 重写 `ConnectionsPanel.tsx`——单页 + 顶部选择器

**Files:**
- Modify: `frontend/src/components/ConnectionsPanel.tsx`(整份重写)

**Interfaces:**
- Consumes:Task 3 的 `api.refreshConnectionModels`/`api.pingConnection`/`api.testConnectionMessage`/`api.listConnections`/`api.createConnection`/`api.updateConnection`/`api.deleteConnection`/`api.activateConnection`/`api.previewConnectionModels`；Task 4 的 `.conn-banner` 系列 class；`Connection`/`ConnectionPayload`/`ApiType` 类型（`frontend/src/types.ts`，未改动的部分）。
- Produces:`ConnectionsPanel` 组件本身，props 不变（`{onClose, onChanged}`），供 `App.tsx`/`CharacterSelect.tsx`/`CharacterHome.tsx`/`GameScreen.tsx` 继续按原样引用——这次改动不涉及它们，因为组件对外接口没变。

- [ ] **Step 1: 用以下内容整份替换 `frontend/src/components/ConnectionsPanel.tsx`**

```tsx
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { ApiType, Connection, ConnectionPayload } from "../types";

const API_TYPE_LABELS: Record<ApiType, string> = {
  openai_compatible: "OpenAI 兼容",
  anthropic: "Anthropic",
  mock: "Mock",
};

const BASE_URL_HINTS: Record<ApiType, string> = {
  openai_compatible: "https://api.openai.com/v1 · OpenRouter / Ollama 等兼容地址",
  anthropic: "留空使用官方 API",
  mock: "无需填写",
};

const DEFAULT_TEST_MESSAGE = "Hi! Reply with one short sentence.";

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

function formFrom(conn: Connection | null): FormState {
  return {
    name: conn?.name ?? "",
    api_type: conn?.api_type ?? "openai_compatible",
    base_url: conn?.base_url ?? "",
    api_key: "",
    model: conn?.model ?? "",
  };
}

export function ConnectionsPanel({ onClose, onChanged }: Props) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => formFrom(null));
  const [cachedModels, setCachedModels] = useState<string[]>([]);
  const [testMessage, setTestMessage] = useState(DEFAULT_TEST_MESSAGE);
  const [banner, setBanner] = useState<Banner>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const selected = connections?.find((c) => c.id === selectedId) ?? null;

  const reload = useCallback(async (keepId?: string | null) => {
    const list = await api.listConnections();
    setConnections(list);
    const target =
      (keepId && list.find((c) => c.id === keepId)) ?? list.find((c) => c.is_active) ?? list[0];
    if (target) {
      setSelectedId(target.id);
      setForm(formFrom(target));
      setCachedModels(target.cached_models);
    } else {
      setSelectedId(null);
      setForm(formFrom(null));
      setCachedModels([]);
    }
  }, []);

  useEffect(() => {
    reload().catch((e) => setBanner({ kind: "error", message: e instanceof Error ? e.message : String(e) }));
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
        setBanner({ kind: "error", message: e instanceof Error ? e.message : String(e) });
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
      setBanner({ kind: "error", message: "请填写连接名称" });
      return;
    }
    setBusy("save");
    setBanner(null);
    try {
      let savedId = selectedId;
      if (selectedId && selected) {
        const patch: ConnectionPayload = {};
        if (form.name !== selected.name) patch.name = form.name;
        if (form.api_type !== selected.api_type) patch.api_type = form.api_type;
        if (form.base_url !== (selected.base_url ?? "")) patch.base_url = form.base_url || null;
        if (form.model !== selected.model) patch.model = form.model;
        // 密钥留空 = 保持已保存的不变
        if (form.api_key.trim()) patch.api_key = form.api_key.trim();
        if (Object.keys(patch).length > 0) {
          await api.updateConnection(selectedId, patch);
        }
      } else {
        const created = await api.createConnection({
          name: form.name.trim(),
          api_type: form.api_type,
          base_url: form.base_url || null,
          api_key: form.api_key.trim() || null,
          model: form.model,
        });
        savedId = created.id;
        await api.activateConnection(created.id);
      }
      await reload(savedId);
      onChanged();
      setBanner({ kind: "ok", message: "已保存" });
    } catch (e) {
      setBanner({ kind: "error", message: e instanceof Error ? e.message : String(e) });
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
      setBanner({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const refreshModels = async () => {
    setBusy("refresh");
    setBanner(null);
    try {
      if (selectedId) {
        const models = await api.refreshConnectionModels(selectedId);
        setCachedModels(models);
        setConnections((prev) =>
          prev
            ? prev.map((c) => (c.id === selectedId ? { ...c, cached_models: models } : c))
            : prev,
        );
      } else {
        const models = await api.previewConnectionModels({
          api_type: form.api_type,
          base_url: form.base_url || null,
          api_key: form.api_key.trim() || null,
          connection_id: null,
        });
        setCachedModels(models);
      }
      setBanner({ kind: "ok", message: "模型列表已刷新" });
    } catch (e) {
      setBanner({ kind: "error", message: e instanceof Error ? e.message : String(e) });
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
      setBanner({ kind: result.ok ? "ok" : "error", message: result.message });
    } catch (e) {
      setBanner({ kind: "error", message: e instanceof Error ? e.message : String(e) });
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
      setBanner({ kind: "ok", message: result.reply });
    } catch (e) {
      setBanner({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>API · 连接设置</span>
          <button className="backlog-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          {banner && <div className={`conn-banner ${banner.kind}`}>{banner.message}</div>}

          <label className="form-field">
            <span className="field-label">已保存的连接 · SAVED</span>
            <div className="field-inline">
              <select
                className="field-input"
                value={selectedId ?? ""}
                onChange={(e) => (e.target.value ? selectConnection(e.target.value) : startNew())}
                disabled={busy !== null}
              >
                <option value="">＋ 新建连接…</option>
                {connections?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.is_active ? "（当前启用）" : ""}
                  </option>
                ))}
              </select>
              <button className="btn btn-ghost small" onClick={startNew} disabled={busy !== null}>
                新建
              </button>
              <button className="btn btn-ghost small" onClick={save} disabled={busy !== null}>
                {busy === "save" ? "保存中…" : "保存"}
              </button>
              {selectedId && (
                <button
                  className={`btn btn-danger small${deleteArmed ? " armed" : ""}`}
                  onClick={remove}
                  disabled={busy !== null}
                >
                  {deleteArmed ? "确认?" : "删除"}
                </button>
              )}
            </div>
          </label>

          <div className="field-row">
            <label className="form-field">
              <span className="field-label">名称 · NAME</span>
              <input
                className="field-input"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="例:OpenRouter / 本地 Ollama"
              />
            </label>
            <label className="form-field">
              <span className="field-label">类型 · API TYPE</span>
              <select
                className="field-input"
                value={form.api_type}
                onChange={(e) => setForm((f) => ({ ...f, api_type: e.target.value as ApiType }))}
              >
                <option value="openai_compatible">OpenAI 兼容</option>
                <option value="anthropic">Anthropic</option>
                <option value="mock">Mock(本地测试)</option>
              </select>
            </label>
          </div>

          {form.api_type !== "mock" && (
            <>
              <label className="form-field">
                <span className="field-label">BASE URL</span>
                <input
                  className="field-input"
                  value={form.base_url}
                  onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
                  placeholder={BASE_URL_HINTS[form.api_type]}
                />
              </label>
              <label className="form-field">
                <span className="field-label">API KEY</span>
                <input
                  className="field-input"
                  type="password"
                  value={form.api_key}
                  onChange={(e) => setForm((f) => ({ ...f, api_key: e.target.value }))}
                  placeholder={selected?.has_api_key ? "已保存密钥(留空保持不变)" : "sk-…"}
                  autoComplete="new-password"
                />
              </label>
            </>
          )}

          <label className="form-field">
            <span className="field-label">模型名 · MODEL</span>
            <div className="field-inline">
              <input
                className="field-input"
                value={form.model}
                onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                placeholder="例:claude-sonnet-5 / gpt-4o / llama3"
              />
              {form.api_type !== "mock" && (
                <button className="btn btn-ghost small" onClick={refreshModels} disabled={busy !== null}>
                  {busy === "refresh" ? "刷新中…" : "刷新列表"}
                </button>
              )}
            </div>
          </label>

          {cachedModels.length > 0 && (
            <label className="form-field">
              <span className="field-label">可用模型 · {cachedModels.length} 个</span>
              <select
                className="field-input"
                value=""
                onChange={(e) => {
                  if (e.target.value) setForm((f) => ({ ...f, model: e.target.value }));
                }}
              >
                <option value="">从列表选择填入…</option>
                {cachedModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          )}

          {selected && form.api_key === "" && selected.has_api_key && (
            <div className="panel-note">密钥已保存在后端,不会回传明文;留空则继续使用。</div>
          )}

          <label className="form-field">
            <span className="field-label">测试消息 · TEST MESSAGE</span>
            <textarea
              className="field-textarea"
              value={testMessage}
              onChange={(e) => setTestMessage(e.target.value)}
              rows={2}
            />
          </label>
        </div>

        <div className="modal-footer">
          <button
            className="btn btn-ghost"
            onClick={ping}
            disabled={!selectedId || busy !== null}
          >
            {busy === "ping" ? "连接中…" : "连接"}
          </button>
          <button
            className="btn btn-ghost"
            onClick={sendTestMessage}
            disabled={!selectedId || busy !== null || !testMessage.trim()}
          >
            {busy === "test" ? "发送中…" : "发送测试消息"}
          </button>
          <div className="modal-footer-spacer" />
          <button className="btn btn-accent" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 类型检查 + lint**

Run: `cd frontend && npm run build && npm run lint`
Expected: 两条命令都 0 error——这是从 Task 3 开始累积的红状态第一次转绿。如果还有报错,大概率是 prop/字段名没对齐,逐条核对。

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/ConnectionsPanel.tsx
git commit -m "feat: rebuild ConnectionsPanel as a single-page SillyTavern-style profile selector"
```

---

### Task 6: 真实浏览器端到端验证

**Files:** 无代码改动，仅验证。

**Interfaces:** 无。

- [ ] **Step 1: 确认后端(带 Task 2 的改动)和前端 dev server 都在跑**

后端:`cd backend && .venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000`（如果 Task 2 时已经手动重启过，确认还是最新代码——如果不确定就再重启一次）
前端:`cd frontend && npm run dev`

- [ ] **Step 2: 打开面板,确认单页布局 + 已有连接自动选中**

用 Playwright 打开 `http://localhost:5173`，点角色网格右上角"API · 连接设置"（或从中枢屏"选择模型"进去）。
Expected:一个单页面板，顶部是"已保存的连接"下拉（能看到之前测试建的连接，比如"芥兰中转"），选中的正是当前 `is_active` 的那条，下面表单字段已经填好它的信息，"可用模型"下拉如果这条连接之前缓存过模型会立刻显示（不需要点任何按钮、不需要等待）。

- [ ] **Step 3: 验证"刷新列表"把结果存进数据库**

对一个 mock 或 openai_compatible 连接点"刷新列表"。
Expected:顶部出现绿色"模型列表已刷新"横幅，"可用模型"下拉更新。刷新页面重新打开面板，选中同一条连接，模型列表应该还在（不用重新点刷新）——这一步验证的是数据库缓存真的生效了，不是纯前端内存态。

- [ ] **Step 4: 验证"连接"不影响模型列表**

记下当前"可用模型"下拉的选项数量，点底部"连接"按钮。
Expected:顶部出现连接结果横幅（成功是绿色"连接成功，探测到 N 个可用模型”，失败是红色原始报错），"可用模型"下拉的选项**不变**（连接动作不应该更新它）。

- [ ] **Step 5: 验证"发送测试消息"**

把"测试消息"文本框内容改成别的文字（比如"你好，测试一下"），点"发送测试消息"。
Expected:顶部横幅显示模型的真实回复原文（如果是 mock 类型，会看到那段固定的 JSON 格式台词文本）。

- [ ] **Step 6: 验证原始报错透传**

临时把 BASE URL 改成一个明显错误的地址（比如 `https://example.invalid`），点"保存"，再点"连接"。
Expected:顶部横幅显示的是英文/原始的网络错误文本（类似 `Connection error` 或底层 httpx/openai SDK 抛出的原文），**不是**中文的"无法连接到…检查地址拼写和网络"这种翻译过的提示。改完测试记得把 BASE URL 改回正确值再保存一次，避免影响后续使用。

- [ ] **Step 7: 验证新建 + 删除流程**

点"新建"，填一个临时的 mock 连接（名称随便填，类型选 Mock），点"保存"。
Expected:下拉里出现新连接，且自动变成当前启用的那条(下拉选项文字带"（当前启用）")。

点"删除"两次(第一次武装确认状态,第二次真正删除)。
Expected:被删除后自动切换回另一条连接(如果还有其他连接的话),且新选中的这条变成 `is_active`——不会出现 409 报错或者面板卡死在已删除的连接上。

- [ ] **Step 8: 记录结果**

以上步骤全部符合预期即完成，不需要额外提交(Task 6 不改代码)。任何一步不符合预期，回到对应 Task 修代码，改完从 Task 6 里失败的那一步重新开始验证。
