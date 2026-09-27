import asyncio
import json

import httpx
import pytest

from app.llm.base import ChatMessage
from app.llm.errors import LLMError
from app.llm.openai_provider import OpenAICompatibleProvider


def run(coro):
    return asyncio.run(coro)


def install_transport(monkeypatch, handler) -> httpx.AsyncClient:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.llm.openai_provider.make_http_client", lambda: client)
    return client


def test_complete_preserves_openai_message_roles_and_model(monkeypatch):
    captured: dict = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["authorization"] = request.headers.get("authorization")
        captured["payload"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-test",
                "object": "chat.completion",
                "created": 0,
                "model": "model-a",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "模型回复"},
                        "finish_reason": "stop",
                    }
                ],
            },
        )

    client = install_transport(monkeypatch, handler)

    async def scenario():
        try:
            provider = OpenAICompatibleProvider("secret", "https://llm.test/v1")
            return await provider.complete(
                [
                    ChatMessage(role="system", content="系统提示"),
                    ChatMessage(role="user", content="你好"),
                ],
                "model-a",
            )
        finally:
            await client.aclose()

    reply = run(scenario())

    assert reply == "模型回复"
    assert captured == {
        "path": "/v1/chat/completions",
        "authorization": "Bearer secret",
        "payload": {
            "messages": [
                {"role": "system", "content": "系统提示"},
                {"role": "user", "content": "你好"},
            ],
            "model": "model-a",
        },
    }


COMPLETION = {
    "id": "chatcmpl-test",
    "object": "chat.completion",
    "created": 0,
    "model": "model-a",
    "choices": [
        {"index": 0, "message": {"role": "assistant", "content": "好"}, "finish_reason": "stop"}
    ],
}


@pytest.mark.parametrize(
    ("thinking", "extra"),
    [
        (None, {}),
        ("off", {"thinking": {"type": "disabled"}}),
        ("low", {"reasoning_effort": "low"}),
        ("max", {"reasoning_effort": "max"}),
    ],
)
def test_thinking_level_rides_along_on_complete_and_stream(monkeypatch, thinking, extra):
    payloads: list[dict] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        payloads.append(payload)
        if payload.get("stream"):
            return httpx.Response(
                200, headers={"content-type": "text/event-stream"}, content=b"data: [DONE]\n\n"
            )
        return httpx.Response(200, json=COMPLETION)

    client = install_transport(monkeypatch, handler)

    async def scenario():
        try:
            provider = OpenAICompatibleProvider("secret", "https://llm.test/v1", thinking)
            messages = [ChatMessage(role="user", content="你好")]
            await provider.complete(messages, "model-a")
            _ = [chunk async for chunk in provider.stream(messages, "model-a")]
        finally:
            await client.aclose()

    run(scenario())

    assert len(payloads) == 2
    for payload in payloads:
        assert {k: v for k, v in payload.items() if k not in ("model", "messages", "stream")} == extra


def test_local_openai_compatible_endpoint_works_without_user_api_key(monkeypatch):
    captured_authorization = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal captured_authorization
        captured_authorization = request.headers.get("authorization")
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-local",
                "object": "chat.completion",
                "created": 0,
                "model": "local",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "本地回复"},
                        "finish_reason": "stop",
                    }
                ],
            },
        )

    client = install_transport(monkeypatch, handler)

    async def scenario():
        try:
            provider = OpenAICompatibleProvider(None, "http://127.0.0.1:11434/v1")
            return await provider.complete([ChatMessage(role="user", content="你好")], "local")
        finally:
            await client.aclose()

    assert run(scenario()) == "本地回复"
    assert captured_authorization == "Bearer sk-no-key"


def test_complete_rejects_success_response_without_choices(monkeypatch):
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-empty",
                "object": "chat.completion",
                "created": 0,
                "model": "model-a",
                "choices": [],
            },
        )

    client = install_transport(monkeypatch, handler)

    async def scenario():
        try:
            provider = OpenAICompatibleProvider("secret", "https://llm.test/v1")
            return await provider.complete([ChatMessage(role="user", content="你好")], "model-a")
        finally:
            await client.aclose()

    with pytest.raises(LLMError, match="空响应"):
        run(scenario())


def test_list_models_returns_remote_ids_in_remote_order(monkeypatch):
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/models"
        return httpx.Response(
            200,
            json={
                "object": "list",
                "data": [
                    {"id": "model-z", "object": "model", "created": 0, "owned_by": "test"},
                    {"id": "model-a", "object": "model", "created": 0, "owned_by": "test"},
                ],
            },
        )

    client = install_transport(monkeypatch, handler)

    async def scenario():
        try:
            provider = OpenAICompatibleProvider("secret", "https://llm.test/v1")
            return await provider.list_models()
        finally:
            await client.aclose()

    assert run(scenario()) == ["model-z", "model-a"]


def test_stream_separates_reasoning_and_text_and_ignores_usage_only_frames(monkeypatch):
    frames = [
        {
            "id": "chunk-1",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "model-a",
            "choices": [
                {
                    "index": 0,
                    "delta": {"reasoning_content": "先思考"},
                    "finish_reason": None,
                }
            ],
        },
        {
            "id": "chunk-2",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "model-a",
            "choices": [
                {"index": 0, "delta": {"reasoning": "，继续想"}, "finish_reason": None}
            ],
        },
        {
            "id": "chunk-3",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "model-a",
            "choices": [
                {"index": 0, "delta": {"content": "再回答"}, "finish_reason": None}
            ],
        },
        {
            "id": "chunk-4",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "model-a",
            "choices": [],
            "usage": {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3},
        },
    ]
    body = "".join(f"data: {json.dumps(frame)}\n\n" for frame in frames) + "data: [DONE]\n\n"

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
            provider = OpenAICompatibleProvider("secret", "https://llm.test/v1")
            return [
                chunk
                async for chunk in provider.stream(
                    [ChatMessage(role="user", content="你好")], "model-a"
                )
            ]
        finally:
            await client.aclose()

    chunks = run(scenario())

    assert [(chunk.reasoning, chunk.text) for chunk in chunks] == [
        ("先思考", ""),
        ("，继续想", ""),
        ("", "再回答"),
    ]


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (401, "API 密钥无效或已过期"),
        (403, "没有权限"),
        (404, "模型不存在或端点路径不对"),
        (429, "请求被限流"),
        (500, "服务返回错误 500"),
    ],
)
def test_http_errors_are_translated_to_actionable_messages(monkeypatch, status: int, expected: str):
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status,
            headers={"x-should-retry": "false"},
            json={"error": {"message": "upstream detail", "type": "test_error"}},
        )

    client = install_transport(monkeypatch, handler)

    async def scenario():
        try:
            provider = OpenAICompatibleProvider("secret", "https://llm.test/v1")
            return await provider.complete([ChatMessage(role="user", content="你好")], "model-a")
        finally:
            await client.aclose()

    with pytest.raises(LLMError, match=expected):
        run(scenario())
