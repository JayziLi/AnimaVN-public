import asyncio
import json
import logging

import httpx
import pytest

from app.llm.anthropic_provider import AnthropicProvider
from app.llm.base import ChatMessage
from app.llm.errors import LLMError

EPHEMERAL = {"type": "ephemeral"}


def run(coro):
    return asyncio.run(coro)


def sse_response(events: list[dict]) -> httpx.Response:
    body = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events)
    return httpx.Response(
        200, headers={"content-type": "text/event-stream"}, content=body.encode()
    )


def install_transport(monkeypatch, handler) -> httpx.AsyncClient:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.llm.anthropic_provider.make_http_client", lambda: client)
    return client


def message_response(text_blocks: list[str]) -> dict:
    return {
        "id": "msg_test",
        "type": "message",
        "role": "assistant",
        "model": "claude-test",
        "content": [{"type": "text", "text": text} for text in text_blocks],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {"input_tokens": 2, "output_tokens": 3},
    }


def test_complete_moves_system_messages_out_of_turn_history(monkeypatch):
    captured: dict = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["api_key"] = request.headers.get("x-api-key")
        captured["payload"] = json.loads(request.content)
        return httpx.Response(200, json=message_response(["第一段", "第二段"]))

    client = install_transport(monkeypatch, handler)

    async def scenario():
        try:
            provider = AnthropicProvider("anthropic-secret", "https://anthropic.test")
            return await provider.complete(
                [
                    ChatMessage(role="system", content="系统一"),
                    ChatMessage(role="system", content="系统二"),
                    ChatMessage(role="user", content="你好"),
                    ChatMessage(role="assistant", content="旧回复"),
                ],
                "claude-test",
            )
        finally:
            await client.aclose()

    reply = run(scenario())

    assert reply == "第一段第二段"
    assert captured["path"] == "/v1/messages"
    assert captured["api_key"] == "anthropic-secret"
    # cache breakpoints on the system prompt and the newest turn
    assert captured["payload"] == {
        "max_tokens": 1024,
        "messages": [
            {"role": "user", "content": "你好"},
            {
                "role": "assistant",
                "content": [{"type": "text", "text": "旧回复", "cache_control": EPHEMERAL}],
            },
        ],
        "model": "claude-test",
        "system": [{"type": "text", "text": "系统一\n\n系统二", "cache_control": EPHEMERAL}],
    }


def test_blank_newest_turn_gets_no_cache_breakpoint(monkeypatch):
    captured_payload = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal captured_payload
        captured_payload = json.loads(request.content)
        return httpx.Response(200, json=message_response(["回复"]))

    client = install_transport(monkeypatch, handler)

    async def scenario():
        try:
            provider = AnthropicProvider("secret", "https://anthropic.test")
            return await provider.complete(
                [
                    ChatMessage(role="user", content="你好"),
                    ChatMessage(role="assistant", content="  "),
                ],
                "claude-test",
            )
        finally:
            await client.aclose()

    run(scenario())

    # the API rejects whitespace-only text blocks, so leave such a turn as-is
    assert captured_payload["messages"][-1] == {"role": "assistant", "content": "  "}


def test_complete_logs_cache_usage(monkeypatch, caplog):
    async def handler(_request: httpx.Request) -> httpx.Response:
        response = message_response(["回复"])
        response["usage"] = {
            "input_tokens": 50,
            "cache_read_input_tokens": 900,
            "cache_creation_input_tokens": 100,
            "output_tokens": 30,
        }
        return httpx.Response(200, json=response)

    client = install_transport(monkeypatch, handler)

    async def scenario():
        try:
            provider = AnthropicProvider("secret", "https://anthropic.test")
            return await provider.complete([ChatMessage(role="user", content="你好")], "claude-test")
        finally:
            await client.aclose()

    caplog.set_level(logging.INFO, logger="app.llm.anthropic_provider")
    run(scenario())

    assert "缓存读 900 · 缓存写 100 · 未缓存 50 · 输出 30 · 命中 86%" in caplog.text


def test_complete_allows_no_system_message(monkeypatch):
    captured_payload = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal captured_payload
        captured_payload = json.loads(request.content)
        return httpx.Response(200, json=message_response(["回复"]))

    client = install_transport(monkeypatch, handler)

    async def scenario():
        try:
            provider = AnthropicProvider("secret", "https://anthropic.test")
            return await provider.complete([ChatMessage(role="user", content="你好")], "claude-test")
        finally:
            await client.aclose()

    assert run(scenario()) == "回复"
    assert captured_payload["system"] == ""


def test_complete_returns_only_text_blocks(monkeypatch):
    async def handler(_request: httpx.Request) -> httpx.Response:
        response = message_response(["公开回答"])
        response["content"].insert(
            0,
            {
                "type": "thinking",
                "thinking": "内部思考",
                "signature": "test-signature",
            },
        )
        return httpx.Response(200, json=response)

    client = install_transport(monkeypatch, handler)

    async def scenario():
        try:
            provider = AnthropicProvider("secret", "https://anthropic.test")
            return await provider.complete([ChatMessage(role="user", content="你好")], "claude-test")
        finally:
            await client.aclose()

    assert run(scenario()) == "公开回答"


def test_list_models_returns_remote_ids(monkeypatch):
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/models"
        return httpx.Response(
            200,
            json={
                "data": [
                    {
                        "type": "model",
                        "id": "claude-a",
                        "display_name": "Claude A",
                        "created_at": "2026-01-01T00:00:00Z",
                    },
                    {
                        "type": "model",
                        "id": "claude-b",
                        "display_name": "Claude B",
                        "created_at": "2026-01-02T00:00:00Z",
                    },
                ],
                "has_more": False,
                "first_id": "claude-a",
                "last_id": "claude-b",
            },
        )

    client = install_transport(monkeypatch, handler)

    async def scenario():
        try:
            provider = AnthropicProvider("secret", "https://anthropic.test")
            return await provider.list_models()
        finally:
            await client.aclose()

    assert run(scenario()) == ["claude-a", "claude-b"]


def test_stream_separates_thinking_and_text_deltas(monkeypatch):
    events = [
        (
            "message_start",
            {
                "type": "message_start",
                "message": message_response([]),
            },
        ),
        (
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "thinking_delta", "thinking": "先思考"},
            },
        ),
        (
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 1,
                "delta": {"type": "signature_delta", "signature": "signature"},
            },
        ),
        (
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 2,
                "delta": {"type": "text_delta", "text": "再回答"},
            },
        ),
        (
            "message_stop",
            {"type": "message_stop"},
        ),
    ]
    body = "".join(
        f"event: {event}\ndata: {json.dumps(data)}\n\n" for event, data in events
    )

    async def handler(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content)["stream"] is True
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=body.encode(),
        )

    client = install_transport(monkeypatch, handler)

    async def scenario():
        try:
            provider = AnthropicProvider("secret", "https://anthropic.test")
            return [
                chunk
                async for chunk in provider.stream(
                    [ChatMessage(role="user", content="你好")], "claude-test"
                )
            ]
        finally:
            await client.aclose()

    chunks = run(scenario())

    assert [(chunk.reasoning, chunk.text) for chunk in chunks] == [
        ("先思考", ""),
        ("", "再回答"),
    ]


def stream_scenario(client: httpx.AsyncClient, messages: list[ChatMessage]):
    async def scenario():
        try:
            provider = AnthropicProvider("secret", "https://anthropic.test")
            return [chunk async for chunk in provider.stream(messages, "claude-test")]
        finally:
            await client.aclose()

    return scenario()


def test_stream_sends_cache_breakpoints(monkeypatch):
    captured_payload = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal captured_payload
        captured_payload = json.loads(request.content)
        return sse_response(
            [
                {"type": "message_start", "message": message_response([])},
                {"type": "message_stop"},
            ]
        )

    client = install_transport(monkeypatch, handler)
    run(
        stream_scenario(
            client,
            [ChatMessage(role="system", content="设定"), ChatMessage(role="user", content="你好")],
        )
    )

    assert captured_payload["system"] == [
        {"type": "text", "text": "设定", "cache_control": EPHEMERAL}
    ]
    assert captured_payload["messages"] == [
        {
            "role": "user",
            "content": [{"type": "text", "text": "你好", "cache_control": EPHEMERAL}],
        }
    ]


def test_stream_logs_cache_usage(monkeypatch, caplog):
    start = message_response([])
    start["usage"] = {
        "input_tokens": 50,
        "cache_read_input_tokens": 900,
        "cache_creation_input_tokens": 100,
        "output_tokens": 1,
    }

    async def handler(_request: httpx.Request) -> httpx.Response:
        return sse_response(
            [
                {"type": "message_start", "message": start},
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": "回复"},
                },
                {
                    "type": "message_delta",
                    "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                    "usage": {"output_tokens": 30},
                },
                {"type": "message_stop"},
            ]
        )

    client = install_transport(monkeypatch, handler)
    caplog.set_level(logging.INFO, logger="app.llm.anthropic_provider")
    run(stream_scenario(client, [ChatMessage(role="user", content="你好")]))

    assert "缓存读 900 · 缓存写 100 · 未缓存 50 · 输出 30 · 命中 86%" in caplog.text


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (401, "API 密钥无效或已过期"),
        (403, "没有权限"),
        (404, "模型不存在"),
        (429, "请求被限流"),
        (500, "服务返回错误 500"),
    ],
)
def test_http_errors_are_translated_to_actionable_messages(monkeypatch, status: int, expected: str):
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status,
            headers={"x-should-retry": "false"},
            json={"type": "error", "error": {"type": "test_error", "message": "detail"}},
        )

    client = install_transport(monkeypatch, handler)

    async def scenario():
        try:
            provider = AnthropicProvider("secret", "https://anthropic.test")
            return await provider.complete([ChatMessage(role="user", content="你好")], "claude-test")
        finally:
            await client.aclose()

    with pytest.raises(LLMError, match=expected):
        run(scenario())
