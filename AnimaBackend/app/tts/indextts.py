"""IndexTTS-2.5 适配器。对面是台式机上我们自己写的小服务(官方只有 Gradio 网页,没有 HTTP
接口),接口约定见 docs/superpowers/specs/2026-09-24-indextts-engine-design.md「小服务接口」。

- 音色和情绪分开给:音色 = 声音的音色参考;情绪 = 这一行的情绪参考,或者 8 维向量,或者不控制
- 小服务同一时刻只推理一个;这边也加一把锁,免得请求在对面堆着等到超时
- 第一次推理要初始化 CUDA,可能还要下载依赖模型:没合成成功过时超时放宽到 90 秒
"""

import asyncio
from typing import Any, Literal

import httpx

from app.tts.base import TTSError, VoiceSpec
from app.tts.http import make_tts_client, transport_error

COLD_TIMEOUT = 90.0
WARM_TIMEOUT = 30.0
PING_TIMEOUT = 5.0
WARMUP_TEXT = "你好。"
DURATION_MIN, DURATION_MAX = 0.5, 2.0

EmoMode = Literal["ref", "vector", "none"]


def duration_factor(speed: float) -> float:
    """声音的「语速」越大越快;IndexTTS 的 duration_factor 越大越慢,所以取倒数。"""
    if speed <= 0:
        return 1.0
    return round(min(DURATION_MAX, max(DURATION_MIN, 1 / speed)), 3)


def emo_mode(voice: VoiceSpec) -> EmoMode:
    """这一句的情绪从哪来:ref = 情绪参考音频,vector = 向量,none = 沿用音色参考的语气。"""
    if voice.ref_path:
        return "ref"
    return "vector" if voice.emo_vector else "none"


def _detail(res: httpx.Response) -> str:
    """小服务出错时回 {"detail": "<原因>"};原因原样给人看。"""
    try:
        body = res.json()
    except ValueError:
        body = None
    if isinstance(body, dict) and body.get("detail"):
        return str(body["detail"])
    return f"HTTP {res.status_code}"


class IndexTtsEngine:
    def __init__(self, base_url: str, emo_alpha: float):
        self.base_url = base_url.rstrip("/")
        self.emo_alpha = emo_alpha
        self.lock = asyncio.Lock()
        # 合成成功过一次 = CUDA 已经初始化好了,之后按正常超时等
        self.warm = False

    def request_body(self, text: str, voice: VoiceSpec) -> dict[str, Any]:
        mode = emo_mode(voice)
        return {
            "text": text,
            "lang": voice.text_lang or "zh",
            "spk_audio_path": voice.spk_ref_path,
            "emo_audio_path": voice.ref_path if mode == "ref" else None,
            "emo_vector": list(voice.emo_vector) if mode == "vector" and voice.emo_vector else None,
            # 声音上没设就跟语音服务
            "emo_alpha": voice.params.get("emo_alpha", self.emo_alpha),
            "duration_factor": duration_factor(voice.speed),
        }

    def cache_material(self, text: str, voice: VoiceSpec) -> dict[str, Any]:
        return {"engine": "indextts", "body": self.request_body(text, voice)}

    async def synthesize(self, text: str, voice: VoiceSpec) -> tuple[bytes, str]:
        async with self.lock:
            return await self._run(text, voice, WARM_TIMEOUT if self.warm else COLD_TIMEOUT)

    async def warmup(self, voice: VoiceSpec, force: bool) -> None:
        # 没有权重要切,force 用不上;服务可能刚重启过,总按冷启动的超时等
        async with self.lock:
            await self._run(WARMUP_TEXT, voice, COLD_TIMEOUT)

    async def ping(self) -> None:
        try:
            async with make_tts_client(self.base_url, PING_TIMEOUT) as client:
                res = await client.get(f"{self.base_url}/health")
        except httpx.HTTPError as e:
            raise self._transport_error(e) from e
        if res.status_code != 200:
            raise TTSError(502, _detail(res))
        try:
            body = res.json()
        except ValueError:
            body = None
        if not (isinstance(body, dict) and body.get("ready")):
            raise TTSError(503, "IndexTTS 还在加载模型")

    async def _run(self, text: str, voice: VoiceSpec, timeout: float) -> tuple[bytes, str]:
        try:
            async with make_tts_client(self.base_url, timeout) as client:
                res = await client.post(f"{self.base_url}/tts", json=self.request_body(text, voice))
        except httpx.HTTPError as e:
            raise self._transport_error(e) from e
        if res.status_code != 200:
            raise TTSError(502, _detail(res))
        self.warm = True
        mime = res.headers.get("content-type", "").split(";")[0].strip() or "audio/wav"
        return res.content, mime

    def _transport_error(self, e: httpx.HTTPError) -> TTSError:
        # 连不上或超时都可能是服务重启了:下次按冷启动的超时等
        self.warm = False
        return TTSError(*transport_error(self.base_url, "IndexTTS", e))
