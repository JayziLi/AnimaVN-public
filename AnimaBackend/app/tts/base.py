"""语音引擎的公共接口。

参考 SillyTavern 的 TTS 扩展:每个引擎实现同一组方法,上层不关心是哪家。
现在有 GPT-SoVITS(gpt_sovits.py)和 IndexTTS(indextts.py);以后接别的引擎,在 registry.py 里加一个分支。
"""

from dataclasses import dataclass, field
from typing import Any, Protocol


class TTSError(Exception):
    """合成失败。status 是回给前端的 HTTP 状态码,message 原样显示给人看。"""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass(frozen=True)
class VoiceSpec:
    """一次合成要用的全部配置,API 层从声音和情绪行里拼好交给引擎。

    GSV:ref_path / prompt_text 是这一行情绪的参考音频和原文。
    IndexTTS:spk_ref_path 是声音的音色参考;ref_path 是可选的情绪参考;emo_vector 是
    8 维情绪向量(ref_path 非空时不用);prompt_text 不用。
    params:声音上调过的合成参数(schemas.VoiceParams,只含调过的项),各引擎只取自己认的。
    """

    gpt_weights: str
    sovits_weights: str
    ref_path: str
    prompt_text: str
    text_lang: str
    speed: float
    spk_ref_path: str = ""
    emo_vector: tuple[float, ...] | None = None
    params: dict[str, Any] = field(default_factory=dict)


class TTSEngine(Protocol):
    def request_body(self, text: str, voice: VoiceSpec) -> dict[str, Any]:
        """发给语音服务的请求体(排查语音时原样给人看)。"""
        ...

    def cache_material(self, text: str, voice: VoiceSpec) -> dict[str, Any]:
        """决定合成结果的全部输入;缓存键就是它的哈希。"""
        ...

    async def synthesize(self, text: str, voice: VoiceSpec) -> tuple[bytes, str]:
        """返回 (音频字节, mime)。失败抛 TTSError。"""
        ...

    async def warmup(self, voice: VoiceSpec, force: bool) -> None:
        """让服务端加载好这个声音并合成一句。force:不信任记住的「当前权重」,强制重新切。"""
        ...

    async def ping(self) -> None:
        """只检查连不连得上。失败抛 TTSError。"""
        ...
