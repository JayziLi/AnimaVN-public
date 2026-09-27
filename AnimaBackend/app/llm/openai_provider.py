from collections.abc import AsyncIterator
from typing import Any

import openai
from openai import AsyncOpenAI

from app.llm.base import ChatMessage, LLMProvider, StreamChunk
from app.llm.errors import LLMError
from app.llm.http_client import make_http_client
from app.llm.thinking import openai_params

# no standard exists for streamed chain-of-thought: DeepSeek uses
# reasoning_content, OpenRouter uses reasoning, and relays copy whichever they
# fronted first — so read both rather than betting on one
REASONING_FIELDS = ("reasoning_content", "reasoning")


def _reasoning_of(delta: Any) -> str:
    """Best-effort chain-of-thought from a delta, whatever the vendor named it."""
    for field in REASONING_FIELDS:
        value = getattr(delta, field, None)
        if value is None and getattr(delta, "model_extra", None):
            value = delta.model_extra.get(field)
        if isinstance(value, str) and value:
            return value
    return ""


class OpenAICompatibleProvider(LLMProvider):
    """OpenAI official API plus anything speaking its chat-completions dialect:
    relay/proxy services, OpenRouter, DeepSeek, Ollama, LM Studio, vLLM, ...
    """

    def __init__(self, api_key: str | None, base_url: str | None = None, thinking: str | None = None):
        self._base_url = base_url
        # 连接上的思考深浅,每次请求都带上(见 app/llm/thinking.py)
        self._extra = openai_params(thinking)
        # local services (Ollama, LM Studio) need no key, but the SDK requires one
        self._client = AsyncOpenAI(
            api_key=api_key or "sk-no-key", base_url=base_url, http_client=make_http_client()
        )

    def _map_error(self, e: Exception) -> LLMError:
        endpoint = self._base_url or "OpenAI 官方端点"
        # order matters: specific status errors subclass APIStatusError,
        # and APITimeoutError subclasses APIConnectionError
        if isinstance(e, openai.AuthenticationError):
            return LLMError("API 密钥无效或已过期 (401)")
        if isinstance(e, openai.PermissionDeniedError):
            return LLMError("该密钥没有权限访问此模型 (403)")
        if isinstance(e, openai.NotFoundError):
            return LLMError("模型不存在或端点路径不对 (404)——检查模型名，以及 base URL 是否需要以 /v1 结尾")
        if isinstance(e, openai.RateLimitError):
            return LLMError("请求被限流 (429)，稍后重试或检查余额")
        if isinstance(e, openai.APIStatusError):
            return LLMError(f"服务返回错误 {e.status_code}：{e.message}")
        if isinstance(e, openai.APITimeoutError):
            return LLMError(f"请求 {endpoint} 超时——服务可能过载或网络不通")
        if isinstance(e, openai.APIConnectionError):
            return LLMError(f"无法连接到 {endpoint}——检查地址拼写和网络")
        return LLMError(f"调用失败：{e}")

    async def complete(self, messages: list[ChatMessage], model: str) -> str:
        try:
            response = await self._client.chat.completions.create(
                model=model,
                messages=[{"role": m.role, "content": m.content} for m in messages],
                **self._extra,
            )
        except Exception as e:
            raise self._map_error(e) from e
        if not response.choices:
            raise LLMError("服务返回了空响应（无 choices）——中转站可能出错了")
        return response.choices[0].message.content or ""

    async def stream(
        self, messages: list[ChatMessage], model: str
    ) -> AsyncIterator[StreamChunk]:
        # split so auth/model errors surface from create() before any chunk is
        # yielded — the endpoint relies on that to still answer with a real 502
        try:
            events = await self._client.chat.completions.create(
                model=model,
                messages=[{"role": m.role, "content": m.content} for m in messages],
                stream=True,
                **self._extra,
            )
        except Exception as e:
            raise self._map_error(e) from e

        try:
            async for event in events:
                if not event.choices:
                    continue  # usage-only frames, sent by some relays at the end
                delta = event.choices[0].delta
                if delta is None:
                    continue
                text = delta.content or ""
                reasoning = _reasoning_of(delta)
                if text or reasoning:
                    yield StreamChunk(text=text, reasoning=reasoning)
        except Exception as e:
            raise self._map_error(e) from e

    async def list_models(self) -> list[str]:
        try:
            page = await self._client.models.list()
        except Exception as e:
            raise self._map_error(e) from e
        return [m.id for m in page.data]
