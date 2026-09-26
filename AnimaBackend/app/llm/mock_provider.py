import asyncio
import json
from collections.abc import AsyncIterator

from app.llm.base import ChatMessage, LLMProvider, StreamChunk


class MockProvider(LLMProvider):
    """Deterministic stand-in for a real LLM, used for local dev without API keys."""

    async def complete(self, messages: list[ChatMessage], model: str) -> str:
        last_user = next(
            (m.content for m in reversed(messages) if m.role == "user"), ""
        )
        lines = [
            {
                "speaker": "小灵",
                "text": f"你说的是「{last_user}」吗?让我想想……",
                "expression": "neutral",
            },
            {
                "speaker": "小灵",
                "text": "嗯,我觉得这样挺有意思的!",
                "expression": "happy",
                "choices": ["继续追问", "换个话题"],
            },
        ]
        return json.dumps(lines, ensure_ascii=False)

    async def stream(
        self, messages: list[ChatMessage], model: str
    ) -> AsyncIterator[StreamChunk]:
        """Fake a slow reply so streaming and reasoning UI can be exercised offline.

        Reasoning goes out on the dedicated channel (reasoning_type "model"),
        which is what real providers do; the inline <think> path has its own
        unit tests and does not need a fixture here.
        """
        last_user = next((m.content for m in reversed(messages) if m.role == "user"), "")
        thought = (
            f"用户说的是「{last_user}」。这是 mock provider，不会走网络，"
            "所以这段思考是写死的，用来验证思维链的流式渲染。"
        )
        body = (
            f"（mock 回复）我收到了「{last_user}」。\n\n"
            f"当前共 {len(messages)} 条消息进入了提示词。"
            "换成真实连接就能看到模型的实际输出了。"
        )

        for i in range(0, len(thought), 3):
            await asyncio.sleep(0.02)
            yield StreamChunk(reasoning=thought[i : i + 3])
        for i in range(0, len(body), 2):
            await asyncio.sleep(0.02)
            yield StreamChunk(text=body[i : i + 2])

    async def list_models(self) -> list[str]:
        return ["mock"]
