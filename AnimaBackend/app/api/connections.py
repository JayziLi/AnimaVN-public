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


router = APIRouter(prefix="/api/connections", tags=["connections"])


def _load(connection_id: str, db: Session) -> ApiConnection:
    conn = db.get(ApiConnection, connection_id)
    if conn is None:
        raise HTTPException(404, "Connection not found")
    return conn


def _out(conn: ApiConnection) -> ConnectionOut:
    return ConnectionOut(
        id=conn.id,
        name=conn.name,
        api_type=conn.api_type,
        base_url=conn.base_url,
        model=conn.model,
        has_api_key=bool(conn.api_key),
        is_active=conn.is_active,
        stream=conn.stream,
        cached_models=conn.cached_models,
        cached_models_at=conn.cached_models_at,
    )


@router.get("", response_model=list[ConnectionOut])
def list_connections(db: Session = Depends(get_db)):
    conns = db.scalars(select(ApiConnection).order_by(ApiConnection.created_at)).all()
    return [_out(c) for c in conns]


@router.post("", response_model=ConnectionOut)
def create_connection(req: ConnectionCreate, db: Session = Depends(get_db)):
    conn = ApiConnection(
        name=req.name,
        api_type=req.api_type,
        base_url=req.base_url,
        api_key=req.api_key or None,
        model=req.model,
        stream=req.stream,
        # the first connection ever becomes active so chat works right away
        is_active=db.scalar(select(ApiConnection)) is None,
    )
    db.add(conn)
    db.commit()
    db.refresh(conn)
    return _out(conn)


@router.put("/{connection_id}", response_model=ConnectionOut)
def update_connection(connection_id: str, req: ConnectionUpdate, db: Session = Depends(get_db)):
    conn = _load(connection_id, db)
    updates = req.model_dump(exclude_unset=True)
    if "api_key" in updates:
        updates["api_key"] = updates["api_key"] or None
    for field, value in updates.items():
        setattr(conn, field, value)
    db.commit()
    db.refresh(conn)
    return _out(conn)


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


@router.post("/{connection_id}/activate", response_model=ConnectionOut)
def activate_connection(connection_id: str, db: Session = Depends(get_db)):
    conn = _load(connection_id, db)
    for other in db.scalars(select(ApiConnection).where(ApiConnection.is_active)):
        other.is_active = False
    conn.is_active = True
    db.commit()
    db.refresh(conn)
    return _out(conn)


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


@router.post("/models-preview", response_model=list[str])
async def preview_models(req: ModelsPreviewRequest, db: Session = Depends(get_db)):
    """Model list for an unsaved form config, so the UI works before saving."""
    api_key = (req.api_key or "").strip() or None
    if api_key is None and req.connection_id:
        stored = db.get(ApiConnection, req.connection_id)
        if stored is not None:
            api_key = stored.api_key
    temp = ApiConnection(
        name="(preview)", api_type=req.api_type, base_url=req.base_url or None, api_key=api_key
    )
    try:
        provider = provider_for(temp)
        return await provider.list_models()
    except LLMError as e:
        raise HTTPException(502, _raw_detail(e)) from e
