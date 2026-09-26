import asyncio

import pytest

from app.llm.anthropic_provider import AnthropicProvider
from app.llm.base import ChatMessage, LLMProvider
from app.llm.errors import LLMError
from app.llm.mock_provider import MockProvider
from app.llm.openai_provider import OpenAICompatibleProvider
from app.llm.registry import provider_for
from app.models import ApiConnection


def connection(api_type: str, *, api_key: str | None = None) -> ApiConnection:
    return ApiConnection(
        name="测试连接",
        api_type=api_type,
        api_key=api_key,
        base_url="https://example.test/v1",
        model="test-model",
    )


def test_registry_selects_provider_for_each_supported_api_type(monkeypatch):
    # Construction must not create a real transport in this selection test.
    monkeypatch.setattr("app.llm.openai_provider.make_http_client", lambda: None)
    monkeypatch.setattr("app.llm.anthropic_provider.make_http_client", lambda: None)

    mock = provider_for(connection("mock"))
    openai = provider_for(connection("openai_compatible"))
    anthropic = provider_for(connection("anthropic", api_key="secret"))

    assert isinstance(mock, MockProvider)
    assert isinstance(openai, OpenAICompatibleProvider)
    assert isinstance(anthropic, AnthropicProvider)


def test_anthropic_connection_requires_api_key():
    with pytest.raises(LLMError, match="还没有配置 API 密钥"):
        provider_for(connection("anthropic", api_key=None))


def test_registry_rejects_unknown_api_type():
    with pytest.raises(LLMError, match="未知的 API 类型"):
        provider_for(connection("future-provider"))


class CompleteOnlyProvider(LLMProvider):
    async def complete(self, messages: list[ChatMessage], model: str) -> str:
        return f"{model}:{messages[-1].content}"


def test_base_provider_stream_falls_back_to_one_complete_chunk():
    async def scenario():
        provider = CompleteOnlyProvider()
        chunks = [
            chunk
            async for chunk in provider.stream(
                [ChatMessage(role="user", content="你好")], "fallback-model"
            )
        ]
        return chunks, await provider.list_models()

    chunks, models = asyncio.run(scenario())

    assert [(chunk.text, chunk.reasoning) for chunk in chunks] == [
        ("fallback-model:你好", "")
    ]
    assert models == []


def test_mock_provider_complete_uses_latest_user_message():
    async def scenario():
        provider = MockProvider()
        return await provider.complete(
            [
                ChatMessage(role="user", content="旧问题"),
                ChatMessage(role="assistant", content="旧回复"),
                ChatMessage(role="user", content="最新问题"),
            ],
            "mock",
        )

    reply = asyncio.run(scenario())

    assert "最新问题" in reply
    assert "旧问题" not in reply


def test_mock_provider_stream_keeps_reasoning_and_body_separate(monkeypatch):
    async def no_wait(_seconds: float):
        return None

    monkeypatch.setattr("app.llm.mock_provider.asyncio.sleep", no_wait)

    async def scenario():
        provider = MockProvider()
        return [
            chunk
            async for chunk in provider.stream(
                [ChatMessage(role="user", content="流式问题")], "mock"
            )
        ]

    chunks = asyncio.run(scenario())
    reasoning = "".join(chunk.reasoning for chunk in chunks)
    text = "".join(chunk.text for chunk in chunks)

    assert "流式问题" in reasoning
    assert "mock provider" in reasoning
    assert "流式问题" in text
    assert all(not (chunk.reasoning and chunk.text) for chunk in chunks)
