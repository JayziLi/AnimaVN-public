import logging
from collections.abc import AsyncIterator
from typing import Any

import anthropic
from anthropic import AsyncAnthropic

from app.llm.base import ChatMessage, LLMProvider, StreamChunk
from app.llm.errors import LLMError
from app.llm.http_client import make_http_client
from app.llm.thinking import anthropic_params

logger = logging.getLogger(__name__)

# 5-minute TTL: writes cost 1.25x input, reads 0.1x — pays off from the
# second request inside the window, which a live chat easily hits
EPHEMERAL = {"type": "ephemeral"}


def _log_usage(model: str, usage: Any) -> None:
    """One line per request, so a relay that silently drops cache_control
    shows up as a hit rate stuck at 0%."""
    if usage is None:
        return
    # relays that don't cache omit these fields entirely
    read = getattr(usage, "cache_read_input_tokens", None) or 0
    write = getattr(usage, "cache_creation_input_tokens", None) or 0
    fresh = usage.input_tokens or 0
    total = read + write + fresh
    hit = f"{read / total:.0%}" if total else "-"
    logger.info(
        "Anthropic %s 用量：缓存读 %d · 缓存写 %d · 未缓存 %d · 输出 %d · 命中 %s",
        model, read, write, fresh, usage.output_tokens or 0, hit,
    )


class AnthropicProvider(LLMProvider):
    def __init__(self, api_key: str, base_url: str | None = None, thinking: str | None = None):
        self._base_url = base_url
        # 连接上的思考深浅,每次请求都带上(见 app/llm/thinking.py)
        self._extra = anthropic_params(thinking)
        self._client = AsyncAnthropic(
            api_key=api_key, base_url=base_url, http_client=make_http_client()
        )

    def _map_error(self, e: Exception) -> LLMError:
        endpoint = self._base_url or "Anthropic 官方端点"
        if isinstance(e, anthropic.AuthenticationError):
            return LLMError("API 密钥无效或已过期 (401)")
        if isinstance(e, anthropic.PermissionDeniedError):
            return LLMError("该密钥没有权限访问此模型 (403)")
        if isinstance(e, anthropic.NotFoundError):
            return LLMError("模型不存在 (404)——检查模型名拼写")
        if isinstance(e, anthropic.RateLimitError):
            return LLMError("请求被限流 (429)，稍后重试或检查余额")
        if isinstance(e, anthropic.APIStatusError):
            return LLMError(f"服务返回错误 {e.status_code}：{e.message}")
        if isinstance(e, anthropic.APITimeoutError):
            return LLMError(f"请求 {endpoint} 超时——服务可能过载或网络不通")
        if isinstance(e, anthropic.APIConnectionError):
            return LLMError(f"无法连接到 {endpoint}——检查地址拼写和网络")
        return LLMError(f"调用失败：{e}")

    @staticmethod
    def _split(messages: list[ChatMessage]) -> tuple[str | list[dict], list[dict]]:
        """Anthropic takes the system prompt out of band, not as a message role.

        Unlike OpenAI, Anthropic only caches prompts that carry explicit
        breakpoints. One goes on the system prompt so it stays cached when old
        history is trimmed off the front; one goes on the newest turn so the next
        request (or a swipe) reuses the whole history up to it.
        """
        system: str | list[dict] = "\n\n".join(m.content for m in messages if m.role == "system")
        turns = [{"role": m.role, "content": m.content} for m in messages if m.role != "system"]
        # the API rejects whitespace-only text blocks, so those stay plain strings
        if system.strip():
            system = [{"type": "text", "text": system, "cache_control": EPHEMERAL}]
        if turns and turns[-1]["content"].strip():
            text = turns[-1]["content"]
            turns[-1]["content"] = [{"type": "text", "text": text, "cache_control": EPHEMERAL}]
        return system, turns

    async def complete(self, messages: list[ChatMessage], model: str) -> str:
        system, turns = self._split(messages)
        try:
            response = await self._client.messages.create(
                model=model,
                system=system,
                messages=turns,
                max_tokens=1024,
                **self._extra,
            )
        except Exception as e:
            raise self._map_error(e) from e
        _log_usage(model, response.usage)
        return "".join(block.text for block in response.content if block.type == "text")

    async def stream(
        self, messages: list[ChatMessage], model: str
    ) -> AsyncIterator[StreamChunk]:
        system, turns = self._split(messages)
        # split so auth/model errors surface from create() before any chunk is
        # yielded — the endpoint relies on that to still answer with a real 502
        try:
            events = await self._client.messages.create(
                model=model,
                system=system,
                messages=turns,
                max_tokens=1024,
                stream=True,
                **self._extra,
            )
        except Exception as e:
            raise self._map_error(e) from e

        usage = None
        try:
            async for event in events:
                # input/cache counts arrive up front; the final output count
                # arrives in message_delta just before the stream ends
                if event.type == "message_start":
                    usage = event.message.usage
                elif event.type == "message_delta" and usage is not None:
                    usage.output_tokens = event.usage.output_tokens
                if event.type != "content_block_delta":
                    continue
                delta = event.delta
                if delta.type == "text_delta":
                    yield StreamChunk(text=delta.text)
                elif delta.type == "thinking_delta":
                    yield StreamChunk(reasoning=delta.thinking)
                # signature_delta carries the thinking signature — nothing to show
        except Exception as e:
            raise self._map_error(e) from e
        _log_usage(model, usage)

    async def list_models(self) -> list[str]:
        try:
            page = await self._client.models.list()
        except Exception as e:
            raise self._map_error(e) from e
        return [m.id for m in page.data]
