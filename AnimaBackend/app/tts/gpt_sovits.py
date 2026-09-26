"""GPT-SoVITS api_v2 适配器。只用三个接口:POST /tts、GET /set_gpt_weights、GET /set_sovits_weights。

服务端同一时刻只加载一套权重,所以:
- 切权重和合成必须在同一把锁里,否则两个角色的请求交错时,A 的台词会用 B 的声音念
- 切一次要 2 秒左右:记住当前加载的是哪套,只在换人时切;出过错就忘掉,下次重新切
- 启动后第一次合成要 30–40 秒(CUDA 初始化):没合成成功过时超时放宽到 90 秒
实测数据和报错格式见 docs/voice-server.md。
"""

import asyncio
import re
from typing import Any

import httpx

from app.tts.base import TTSError, VoiceSpec
from app.tts.http import make_tts_client, transport_error

COLD_TIMEOUT = 90.0
WARM_TIMEOUT = 30.0
PING_TIMEOUT = 5.0
WARMUP_TEXT = "你好。"
# 一句按标点切成的几段一起合成(api_v2 默认 1 = 一段一段来)。实测 64 步:三段的短句
# 2.8 → 1.5 秒,十几段的长句 8.4 → 2.3 秒。服务端同一时刻只处理一个请求,这是一句之内的并发
BATCH_SIZE = 20
# 声音上能调的 api_v2 参数(采样步数、断句方式另算:它们总是发)。没调过的不发,用 api_v2 的默认:
# top_k 15、top_p 1、温度 1、重复惩罚 1.35、句间停顿 0.3 秒、并行推理开、种子 -1(随机)
TUNABLE = (
    "temperature",
    "top_p",
    "top_k",
    "repetition_penalty",
    "fragment_interval",
    "parallel_infer",
    "seed",
)

_KANA = re.compile(r"[぀-ヿ]")


def detect_lang(text: str) -> str:
    """参考原文的语言:有假名就是日语,否则按中文(LingChat 的做法)。"""
    return "ja" if _KANA.search(text) else "zh"


def _api_error(res: httpx.Response) -> str:
    """api_v2 出错时回 400 + {"message": ..., "Exception": "<原因>"};原因原样给人看。"""
    try:
        body = res.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        reason = body.get("Exception") or body.get("message")
        if reason:
            return str(reason)
    return f"HTTP {res.status_code}"


class GptSovitsEngine:
    def __init__(self, base_url: str, sample_steps: int):
        self.base_url = base_url.rstrip("/")
        self.sample_steps = sample_steps
        self.lock = asyncio.Lock()
        self.loaded_gpt: str | None = None
        self.loaded_sovits: str | None = None
        # 合成成功过一次 = CUDA 已经初始化好了,之后按正常超时等
        self.warm = False

    def request_body(self, text: str, voice: VoiceSpec) -> dict[str, Any]:
        p = voice.params
        body = {
            "text": text,
            "text_lang": voice.text_lang,
            "ref_audio_path": voice.ref_path,
            "prompt_text": voice.prompt_text,
            "prompt_lang": detect_lang(voice.prompt_text),
            "media_type": "wav",
            "text_split_method": p.get("text_split_method", "cut5"),
            # 声音上没设就跟语音服务
            "sample_steps": p.get("sample_steps", self.sample_steps),
            "speed_factor": voice.speed,
            "streaming_mode": False,
        }
        # 只发调过的:加参数之前缓存的那些,缓存键不变
        body.update({k: p[k] for k in TUNABLE if k in p})
        return body

    def cache_material(self, text: str, voice: VoiceSpec) -> dict[str, Any]:
        return {
            "engine": "gpt_sovits",
            "gpt": voice.gpt_weights,
            "sovits": voice.sovits_weights,
            "body": self.request_body(text, voice),
        }

    async def synthesize(self, text: str, voice: VoiceSpec) -> tuple[bytes, str]:
        async with self.lock:
            return await self._run(text, voice, WARM_TIMEOUT if self.warm else COLD_TIMEOUT)

    async def warmup(self, voice: VoiceSpec, force: bool) -> None:
        async with self.lock:
            if force:
                self.loaded_gpt = self.loaded_sovits = None
            # 服务重启过的话这一句要等 30–40 秒,记住的 warm 可能已经过时,所以总按冷启动等
            await self._run(WARMUP_TEXT, voice, COLD_TIMEOUT)

    async def ping(self) -> None:
        try:
            async with make_tts_client(self.base_url, PING_TIMEOUT) as client:
                # api_v2 是 FastAPI,/docs 一直在;收到任何 HTTP 响应就说明连得上
                await client.get(f"{self.base_url}/docs")
        except httpx.HTTPError as e:
            raise self._transport_error(e) from e

    async def _run(self, text: str, voice: VoiceSpec, timeout: float) -> tuple[bytes, str]:
        try:
            async with make_tts_client(self.base_url, timeout) as client:
                await self._ensure_weights(client, voice)
                # batch_size 只影响快慢,不放进 request_body(那是缓存键的原料)
                body = {**self.request_body(text, voice), "batch_size": BATCH_SIZE}
                res = await client.post(f"{self.base_url}/tts", json=body)
                if res.status_code != 200:
                    raise TTSError(502, _api_error(res))
        except TTSError:
            self.loaded_gpt = self.loaded_sovits = None
            raise
        except httpx.HTTPError as e:
            self.loaded_gpt = self.loaded_sovits = None
            raise self._transport_error(e) from e
        self.warm = True
        mime = res.headers.get("content-type", "").split(";")[0].strip() or "audio/wav"
        return res.content, mime

    async def _ensure_weights(self, client: httpx.AsyncClient, voice: VoiceSpec) -> None:
        if voice.gpt_weights and voice.gpt_weights != self.loaded_gpt:
            self.loaded_gpt = None
            res = await client.get(
                f"{self.base_url}/set_gpt_weights", params={"weights_path": voice.gpt_weights}
            )
            if res.status_code != 200:
                raise TTSError(502, f"切换 GPT 权重失败:{_api_error(res)}")
            self.loaded_gpt = voice.gpt_weights
        if voice.sovits_weights and voice.sovits_weights != self.loaded_sovits:
            self.loaded_sovits = None
            res = await client.get(
                f"{self.base_url}/set_sovits_weights", params={"weights_path": voice.sovits_weights}
            )
            if res.status_code != 200:
                raise TTSError(502, f"切换 SoVITS 权重失败:{_api_error(res)}")
            self.loaded_sovits = voice.sovits_weights

    def _transport_error(self, e: httpx.HTTPError) -> TTSError:
        # 连不上或超时都可能是服务重启了:下次按冷启动的超时等
        self.warm = False
        return TTSError(*transport_error(self.base_url, "GPT-SoVITS", e))
