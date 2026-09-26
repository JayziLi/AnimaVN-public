from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass


@dataclass
class ChatMessage:
    role: str  # "system" | "user" | "assistant"
    content: str


@dataclass
class StreamChunk:
    """One increment of a streamed reply.

    text and reasoning are separate channels on purpose: the chain of thought
    is stored apart from the body (SillyTavern keeps it in extra.reasoning and
    never in mes), so mixing them here would only force a split downstream.
    """

    text: str = ""
    reasoning: str = ""


class LLMProvider(ABC):
    @abstractmethod
    async def complete(self, messages: list[ChatMessage], model: str) -> str:
        """Return the raw text completion for the given message history."""

    async def stream(
        self, messages: list[ChatMessage], model: str
    ) -> AsyncIterator[StreamChunk]:
        """Incremental version of complete().

        The default yields the whole reply in one chunk, so a provider that
        cannot stream still works through the streaming endpoint and callers
        never have to branch on capability.
        """
        yield StreamChunk(text=await self.complete(messages, model))

    async def list_models(self) -> list[str]:
        """Model ids reported by the remote endpoint; empty if unsupported."""
        return []
