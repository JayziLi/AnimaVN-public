import asyncio
from dataclasses import replace

import httpx
import pytest

from app.tts.base import TTSError, VoiceSpec
from app.tts.indextts import IndexTtsEngine, duration_factor, emo_mode

URL = "http://index.test:9890"
SPK = "D:/AnimaVoice/refs/阿米娅/【平静】作为罗德岛的领导者.wav"
HAPPY = (0.8, 0, 0, 0, 0, 0, 0, 0)


def spec(ref_path: str = "", emo_vector=None, speed: float = 1.0) -> VoiceSpec:
    return VoiceSpec(
        gpt_weights="",
        sovits_weights="",
        ref_path=ref_path,
        prompt_text="",
        text_lang="zh",
        speed=speed,
        spk_ref_path=SPK,
        emo_vector=emo_vector,
    )


def run(coro):
    return asyncio.run(coro)


def test_request_body_for_each_emotion_source(index_tts):
    engine = IndexTtsEngine(URL + "/", emo_alpha=0.6)

    async def scenario():
        await engine.synthesize("太好了！", spec(emo_vector=HAPPY))
        await engine.synthesize("对不起……", spec(ref_path="D:/emo/哭.wav", emo_vector=HAPPY))
        await engine.synthesize("博士。", spec())

    run(scenario())
    by_vector, by_ref, plain = index_tts.bodies()
    assert by_vector == {
        "text": "太好了！",
        "lang": "zh",
        "spk_audio_path": SPK,
        "emo_audio_path": None,
        "emo_vector": [0.8, 0, 0, 0, 0, 0, 0, 0],
        "emo_alpha": 0.6,
        "duration_factor": 1.0,
    }
    # 填了情绪参考就不带向量:对面两个同时给会报 400
    assert (by_ref["emo_audio_path"], by_ref["emo_vector"]) == ("D:/emo/哭.wav", None)
    assert (plain["emo_audio_path"], plain["emo_vector"]) == (None, None)
    assert [emo_mode(spec(emo_vector=HAPPY)), emo_mode(spec(ref_path="x")), emo_mode(spec())] == [
        "vector",
        "ref",
        "none",
    ]


def test_speed_maps_to_duration_factor():
    # 声音的「语速」越大越快,IndexTTS 的 duration_factor 越大越慢
    assert duration_factor(1.0) == 1.0
    assert duration_factor(1.25) == 0.8
    assert duration_factor(0.8) == 1.25
    assert duration_factor(0.4) == 2.0
    assert duration_factor(3.0) == 0.5
    assert duration_factor(1.3) == 0.769


def test_audio_and_cache_material(index_tts):
    engine = IndexTtsEngine(URL, 0.6)
    assert run(engine.synthesize("博士。", spec())) == (b"RIFF" + "博士。".encode(), "audio/wav")
    m1 = engine.cache_material("博士。", spec(emo_vector=HAPPY))
    m2 = IndexTtsEngine(URL, 0.8).cache_material("博士。", spec(emo_vector=HAPPY))
    assert m1["engine"] == "indextts"
    # 强度也进缓存键
    assert m1 != m2


def test_errors_map_to_502_503_504(index_tts):
    engine = IndexTtsEngine(URL, 0.6)
    replies = [
        httpx.Response(400, json={"detail": "音色参考不存在: D:/x.wav"}),
        httpx.Response(500, json={"detail": "CUDA out of memory"}),
        httpx.Response(500, text="oops"),
        httpx.ConnectError("refused"),
        httpx.ReadTimeout("slow"),
    ]

    async def scenario():
        out = []
        for reply in replies:
            index_tts.tts_reply = reply
            with pytest.raises(TTSError) as err:
                await engine.synthesize("一", spec())
            out.append((err.value.status, err.value.message))
        return out

    assert run(scenario()) == [
        (502, "音色参考不存在: D:/x.wav"),
        (502, "CUDA out of memory"),
        (502, "HTTP 500"),
        (503, f"连不上语音服务 {URL}(台式机没开机、IndexTTS 没启动,或者网络不通)"),
        (504, "语音合成超时"),
    ]


def test_cold_then_warm_timeouts_and_warmup_always_waits_cold(index_tts):
    engine = IndexTtsEngine(URL, 0.6)

    async def scenario():
        await engine.synthesize("一", spec())
        await engine.synthesize("二", spec())
        await engine.warmup(spec(), force=True)

    run(scenario())
    assert index_tts.timeouts == [90.0, 30.0, 90.0]
    assert index_tts.bodies()[-1]["text"] == "你好。"


def test_ping_checks_the_model_is_ready(index_tts):
    engine = IndexTtsEngine(URL, 0.6)
    run(engine.ping())
    assert index_tts.calls == [("health", None)]
    assert index_tts.timeouts == [5.0]

    index_tts.health_reply = httpx.Response(200, json={"model": "IndexTTS-2.5", "ready": False})
    with pytest.raises(TTSError) as err:
        run(engine.ping())
    assert (err.value.status, err.value.message) == (503, "IndexTTS 还在加载模型")

    index_tts.health_reply = httpx.ConnectError("refused")
    with pytest.raises(TTSError) as err:
        run(engine.ping())
    assert err.value.status == 503


def test_calls_on_one_engine_are_serialized(monkeypatch):
    active = peak = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1
        return httpx.Response(200, headers={"content-type": "audio/wav"}, content=b"RIFF")

    monkeypatch.setattr(
        "app.tts.indextts.make_tts_client",
        lambda base_url, timeout: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    engine = IndexTtsEngine(URL, 0.6)

    async def scenario():
        await asyncio.gather(engine.synthesize("一", spec()), engine.synthesize("二", spec()))

    run(scenario())
    assert peak == 1


def test_voice_can_override_emotion_strength(index_tts):
    engine = IndexTtsEngine(URL, emo_alpha=1.0)
    tuned = replace(spec(), params={"emo_alpha": 0.5, "temperature": 0.7})
    run(engine.synthesize("博士。", tuned))
    body = index_tts.bodies()[-1]
    assert body["emo_alpha"] == 0.5
    # GSV 的参数小服务不认,不发
    assert "temperature" not in body
    assert engine.cache_material("博士。", tuned) != engine.cache_material("博士。", spec())
