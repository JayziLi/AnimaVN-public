import json
import time
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.llm.base import ChatMessage, StreamChunk
from app.llm.errors import LLMError
from app.llm.reasoning import ThinkTagSplitter
from app.llm.registry import active_connection, provider_for
from app.models import ApiConnection

router = APIRouter(prefix="/api/debug", tags=["debug"])


class DebugMessage(BaseModel):
    role: str
    content: str


class CompleteRequest(BaseModel):
    messages: list[DebugMessage]
    connection_id: str | None = None
    # lets the console try another model without editing the saved connection
    model: str | None = None


class CompleteResponse(BaseModel):
    raw: str
    connection_name: str
    model: str


def _resolve(
    req: CompleteRequest, db: Session
) -> tuple[ApiConnection, str, list[ChatMessage]]:
    """Shared front half of both endpoints: pick the connection, model, history."""
    if not req.messages:
        raise HTTPException(400, "messages 不能为空")

    if req.connection_id:
        conn = db.get(ApiConnection, req.connection_id)
        if conn is None:
            raise HTTPException(400, "指定的 API 连接不存在")
    else:
        conn = active_connection(db)
        if conn is None:
            raise HTTPException(400, "没有启用的 API 连接，请先在设置里添加并启用一个")

    model = req.model or conn.model
    if conn.api_type != "mock" and not model:
        raise HTTPException(400, f"连接「{conn.name}」还没有填写模型名")

    history = [ChatMessage(role=m.role, content=m.content) for m in req.messages]
    return conn, model, history


@router.post("/complete", response_model=CompleteResponse)
async def complete(req: CompleteRequest, db: Session = Depends(get_db)):
    """Dumb pipe: forward an already-assembled message array to the provider.

    Deliberately does no prompt assembly — the caller owns that entirely. The
    prompt console assembles client-side and posts the result here, and this is
    the same request shape a SillyTavern-side plugin would post to, so both
    share one endpoint and neither has to agree with us on prompt format.
    """
    conn, model, history = _resolve(req, db)
    try:
        raw = await provider_for(conn).complete(history, model)
    except LLMError as e:
        raise HTTPException(502, e.message) from e

    return CompleteResponse(raw=raw, connection_name=conn.name, model=model)


def _sse(event: str, data: dict) -> bytes:
    """One SSE frame. The payload is JSON so newlines survive — a raw newline
    inside `data:` would end the frame."""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode()


@router.post("/stream")
async def stream(req: CompleteRequest, db: Session = Depends(get_db)):
    """Streaming twin of /complete.

    The first chunk is pulled *before* the response starts, so anything that
    fails up front — bad key, wrong model name, unreachable host — still comes
    back as a normal 502 with a readable message. Only failures after the first
    token degrade into an `error` frame, because by then the headers are gone.
    """
    conn, model, history = _resolve(req, db)

    try:
        provider = provider_for(conn)
        events = provider.stream(history, model).__aiter__()
    except LLMError as e:
        raise HTTPException(502, e.message) from e

    started = time.perf_counter()
    try:
        first: StreamChunk | None = await anext(events)
    except StopAsyncIteration:
        first = None
    except LLMError as e:
        raise HTTPException(502, e.message) from e
    ttft_ms = round((time.perf_counter() - started) * 1000)

    async def frames() -> AsyncIterator[bytes]:
        splitter = ThinkTagSplitter()
        native_reasoning = False
        reasoning_end: float | None = None
        emitted = False

        def render(chunk: StreamChunk) -> list[bytes]:
            nonlocal native_reasoning, reasoning_end, emitted
            out: list[bytes] = []
            reasoning = chunk.reasoning
            text = chunk.text
            if reasoning:
                native_reasoning = True
            if text:
                # a model that streams reasoning natively will not also wrap it
                # in tags, but running the splitter either way costs nothing
                text, extra = splitter.feed(text)
                reasoning += extra
            if reasoning:
                reasoning_end = time.perf_counter()
                emitted = True
                out.append(_sse("reasoning", {"text": reasoning}))
            if text:
                emitted = True
                out.append(_sse("delta", {"text": text}))
            return out

        try:
            yield _sse("meta", {"connection_name": conn.name, "model": model, "ttft_ms": ttft_ms})

            chunk = first
            while chunk is not None:
                for frame in render(chunk):
                    yield frame
                chunk = await anext(events, None)

            # the flush tail comes from tag parsing, never from the native
            # channel — routing it through render() would mislabel the type
            tail_text, tail_reasoning = splitter.flush()
            if tail_reasoning:
                reasoning_end = time.perf_counter()
                emitted = True
                yield _sse("reasoning", {"text": tail_reasoning})
            if tail_text:
                emitted = True
                yield _sse("delta", {"text": tail_text})

            if not emitted:
                yield _sse("error", {"message": "服务返回了空响应——中转站可能出错了"})
                return

            reasoning_type = "model" if native_reasoning else ("parsed" if splitter.used else None)
            yield _sse(
                "done",
                {
                    "total_ms": round((time.perf_counter() - started) * 1000),
                    "reasoning_type": reasoning_type,
                    "reasoning_ms": (
                        round((reasoning_end - started) * 1000) if reasoning_end else None
                    ),
                },
            )
        except LLMError as e:
            yield _sse("error", {"message": e.message})
        except Exception as e:  # noqa: BLE001 - the frame is the only channel left
            yield _sse("error", {"message": f"生成中断：{e}"})
        finally:
            await events.aclose()

    return StreamingResponse(
        frames(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # tells nginx not to sit on the chunks if this ever runs behind one
            "X-Accel-Buffering": "no",
        },
    )
