import json
from collections.abc import AsyncIterator

from fastapi.testclient import TestClient

from app.llm.base import ChatMessage, LLMProvider, StreamChunk
from app.llm.errors import LLMError


def parse_sse(body: str) -> list[tuple[str, dict]]:
    events: list[tuple[str, dict]] = []
    for frame in body.strip().split("\n\n"):
        fields = dict(line.split(": ", 1) for line in frame.splitlines())
        events.append((fields["event"], json.loads(fields["data"])))
    return events


class ScriptedProvider(LLMProvider):
    async def complete(self, messages: list[ChatMessage], model: str) -> str:
        return "脚本化回复"

    async def stream(
        self, messages: list[ChatMessage], model: str
    ) -> AsyncIterator[StreamChunk]:
        yield StreamChunk(reasoning="先分析")
        yield StreamChunk(text="第一段\n")
        yield StreamChunk(text="第二段")


class EmptyProvider(LLMProvider):
    async def complete(self, messages: list[ChatMessage], model: str) -> str:
        return ""

    async def stream(
        self, messages: list[ChatMessage], model: str
    ) -> AsyncIterator[StreamChunk]:
        if False:
            yield StreamChunk()


class FailingBeforeFirstTokenProvider(LLMProvider):
    async def complete(self, messages: list[ChatMessage], model: str) -> str:
        raise LLMError("上游不可用")

    async def stream(
        self, messages: list[ChatMessage], model: str
    ) -> AsyncIterator[StreamChunk]:
        raise LLMError("上游不可用")
        yield StreamChunk()  # pragma: no cover - keeps this an async generator


class InlineThinkProvider(LLMProvider):
    async def complete(self, messages: list[ChatMessage], model: str) -> str:
        return ""

    async def stream(
        self, messages: list[ChatMessage], model: str
    ) -> AsyncIterator[StreamChunk]:
        yield StreamChunk(text="<thi")
        yield StreamChunk(text="nk>分析")
        yield StreamChunk(text="过程</think>")
        yield StreamChunk(text="最终回答")


class FailingMidStreamProvider(LLMProvider):
    async def complete(self, messages: list[ChatMessage], model: str) -> str:
        return ""

    async def stream(
        self, messages: list[ChatMessage], model: str
    ) -> AsyncIterator[StreamChunk]:
        yield StreamChunk(text="已经生成的部分")
        raise LLMError("流中途断开")


def test_debug_complete_forwards_assembled_messages_to_active_mock_connection(
    client: TestClient, make_connection
):
    make_connection(name="调试连接")

    response = client.post(
        "/api/debug/complete",
        json={"messages": [{"role": "user", "content": "测试内容"}]},
    )

    assert response.status_code == 200
    assert response.json()["connection_name"] == "调试连接"
    assert response.json()["model"] == "mock"
    assert "测试内容" in response.json()["raw"]


def test_debug_complete_rejects_empty_messages_and_unknown_connection(
    client: TestClient, make_connection
):
    make_connection()

    empty = client.post("/api/debug/complete", json={"messages": []})
    missing = client.post(
        "/api/debug/complete",
        json={
            "connection_id": "missing",
            "messages": [{"role": "user", "content": "你好"}],
        },
    )

    assert empty.status_code == 400
    assert missing.status_code == 400


def test_stream_emits_ordered_native_reasoning_and_text_frames(
    client: TestClient, make_connection, monkeypatch
):
    connection = make_connection(name="流式连接")
    monkeypatch.setattr("app.api.debug.provider_for", lambda _connection: ScriptedProvider())

    with client.stream(
        "POST",
        "/api/debug/stream",
        json={
            "connection_id": connection["id"],
            "messages": [{"role": "user", "content": "开始"}],
        },
    ) as response:
        body = response.read().decode()

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["x-accel-buffering"] == "no"
    events = parse_sse(body)
    assert [event for event, _ in events] == ["meta", "reasoning", "delta", "delta", "done"]
    assert events[0][1]["connection_name"] == "流式连接"
    assert events[1][1] == {"text": "先分析"}
    assert events[2][1] == {"text": "第一段\n"}
    assert events[-1][1]["reasoning_type"] == "model"
    assert isinstance(events[-1][1]["total_ms"], int)


def test_empty_stream_returns_error_frame_instead_of_silent_success(
    client: TestClient, make_connection, monkeypatch
):
    connection = make_connection()
    monkeypatch.setattr("app.api.debug.provider_for", lambda _connection: EmptyProvider())

    response = client.post(
        "/api/debug/stream",
        json={
            "connection_id": connection["id"],
            "messages": [{"role": "user", "content": "开始"}],
        },
    )

    assert response.status_code == 200
    events = parse_sse(response.text)
    assert [event for event, _ in events] == ["meta", "error"]
    assert "空响应" in events[-1][1]["message"]


def test_stream_failure_before_first_token_is_normal_http_error(
    client: TestClient, make_connection, monkeypatch
):
    connection = make_connection()
    monkeypatch.setattr(
        "app.api.debug.provider_for", lambda _connection: FailingBeforeFirstTokenProvider()
    )

    response = client.post(
        "/api/debug/stream",
        json={
            "connection_id": connection["id"],
            "messages": [{"role": "user", "content": "开始"}],
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"] == "上游不可用"


def test_stream_parses_chunked_inline_think_tags_and_marks_reasoning_as_parsed(
    client: TestClient, make_connection, monkeypatch
):
    connection = make_connection()
    monkeypatch.setattr("app.api.debug.provider_for", lambda _connection: InlineThinkProvider())

    response = client.post(
        "/api/debug/stream",
        json={
            "connection_id": connection["id"],
            "messages": [{"role": "user", "content": "开始"}],
        },
    )

    assert response.status_code == 200
    events = parse_sse(response.text)
    assert "".join(data["text"] for event, data in events if event == "reasoning") == "分析过程"
    assert "".join(data["text"] for event, data in events if event == "delta") == "最终回答"
    assert events[-1][0] == "done"
    assert events[-1][1]["reasoning_type"] == "parsed"


def test_stream_failure_after_partial_text_becomes_error_frame_without_done(
    client: TestClient, make_connection, monkeypatch
):
    connection = make_connection()
    monkeypatch.setattr(
        "app.api.debug.provider_for", lambda _connection: FailingMidStreamProvider()
    )

    response = client.post(
        "/api/debug/stream",
        json={
            "connection_id": connection["id"],
            "messages": [{"role": "user", "content": "开始"}],
        },
    )

    assert response.status_code == 200
    events = parse_sse(response.text)
    assert [event for event, _ in events] == ["meta", "delta", "error"]
    assert events[1][1] == {"text": "已经生成的部分"}
    assert events[2][1] == {"message": "流中途断开"}
