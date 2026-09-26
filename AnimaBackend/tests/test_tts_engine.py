import asyncio
from dataclasses import replace

import httpx
import pytest

from app.tts.base import TTSError, VoiceSpec
from app.tts.gpt_sovits import BATCH_SIZE, GptSovitsEngine, detect_lang
from app.tts.http import is_direct_host, make_tts_client

AMIYA = VoiceSpec(
    gpt_weights="D:/AnimaVoice/models/阿米娅/阿米娅-e10.ckpt",
    sovits_weights="D:/AnimaVoice/models/阿米娅/阿米娅_e10_s230_l32.pth",
    ref_path="D:/AnimaVoice/refs/阿米娅/【平静】作为罗德岛的领导者.wav",
    prompt_text="作为罗德岛的领导者",
    text_lang="zh",
    speed=1.0,
)
SLEACH = VoiceSpec(
    gpt_weights="D:/AnimaVoice/models/琴柳/琴柳-e10.ckpt",
    sovits_weights="D:/AnimaVoice/models/琴柳/琴柳_e10_s140_l32.pth",
    ref_path="D:/AnimaVoice/refs/琴柳/【平静】如果有一天.wav",
    prompt_text="如果有一天",
    text_lang="zh",
    speed=1.0,
)
URL = "http://gsv.test:9880"
SWITCH = ["set_gpt_weights", "set_sovits_weights"]


def run(coro):
    return asyncio.run(coro)


def test_request_body_uses_connection_steps_and_detects_prompt_lang(gsv):
    engine = GptSovitsEngine(URL + "/", sample_steps=64)
    audio, mime = run(engine.synthesize("博士，早上好。", AMIYA))

    assert audio == b"RIFF" + "博士，早上好。".encode()
    assert mime == "audio/wav"
    assert gsv.calls[-1][1] == {
        "text": "博士，早上好。",
        "text_lang": "zh",
        "ref_audio_path": AMIYA.ref_path,
        "prompt_text": AMIYA.prompt_text,
        "prompt_lang": "zh",
        "media_type": "wav",
        "text_split_method": "cut5",
        "sample_steps": 64,
        "speed_factor": 1.0,
        "streaming_mode": False,
        "batch_size": BATCH_SIZE,
    }
    # 分段并行只影响快慢,不进缓存键:开之前缓存的那些照样能命中
    assert "batch_size" not in engine.cache_material("博士，早上好。", AMIYA)["body"]
    assert detect_lang("おはようございます、ドクター") == "ja"
    assert detect_lang("早上好") == "zh"


def test_weights_switch_only_when_voice_changes(gsv):
    engine = GptSovitsEngine(URL, 64)

    async def scenario():
        await engine.synthesize("一", AMIYA)
        await engine.synthesize("二", AMIYA)
        await engine.synthesize("三", SLEACH)

    run(scenario())
    assert gsv.names() == [*SWITCH, "tts", "tts", *SWITCH, "tts"]
    assert gsv.calls[4][1] == SLEACH.gpt_weights


def test_error_forgets_weights_so_next_call_switches_again(gsv):
    engine = GptSovitsEngine(URL, 64)

    async def scenario():
        await engine.synthesize("一", AMIYA)
        gsv.tts_reply = httpx.Response(
            400, json={"message": "tts failed", "Exception": "参考音频在3~10秒范围外，请更换！"}
        )
        with pytest.raises(TTSError) as err:
            await engine.synthesize("二", AMIYA)
        gsv.tts_reply = None
        await engine.synthesize("三", AMIYA)
        return err.value

    err = run(scenario())
    assert (err.status, err.message) == (502, "参考音频在3~10秒范围外，请更换！")
    assert gsv.names() == [*SWITCH, "tts", "tts", *SWITCH, "tts"]


def test_weight_switch_failure_is_reported(gsv):
    gsv.weights_reply = httpx.Response(
        400, json={"message": "change gpt weight failed", "Exception": "D:/x.ckpt not exists"}
    )
    with pytest.raises(TTSError) as err:
        run(GptSovitsEngine(URL, 64).synthesize("一", AMIYA))
    assert err.value.status == 502
    assert err.value.message == "切换 GPT 权重失败:D:/x.ckpt not exists"


def test_transport_failures_map_to_503_and_504(gsv):
    engine = GptSovitsEngine(URL, 64)

    async def scenario():
        out = []
        for reply in (httpx.ConnectError("refused"), httpx.ReadTimeout("slow")):
            gsv.tts_reply = reply
            with pytest.raises(TTSError) as err:
                await engine.synthesize("一", AMIYA)
            out.append(err.value)
        return out

    refused, slow = run(scenario())
    assert refused.status == 503
    assert refused.message == f"连不上语音服务 {URL}(台式机没开机、GPT-SoVITS 没启动,或者网络不通)"
    assert (slow.status, slow.message) == (504, "语音合成超时")


def test_transport_error_tells_tunnel_service_and_network_apart():
    from app.tts.http import transport_error

    tunnel = "http://127.0.0.1:9880"
    # 本机地址连接被拒:语音隧道没开
    assert transport_error(tunnel, "GPT-SoVITS", httpx.ConnectError("refused")) == (
        503,
        f"连不上语音服务 {tunnel}(本机地址要靠 SSH 隧道转到台式机,隧道没开。"
        "建议把地址换成台式机的 Tailscale 地址,见 docs/voice-server.md)",
    )
    # 连得上但对方一个字没回就断开:隧道通了,台式机上的服务没启动
    assert transport_error(tunnel, "GPT-SoVITS", httpx.RemoteProtocolError("disconnected")) == (
        503,
        f"语音服务没回应 {tunnel}(连接是通的,但台式机上的 GPT-SoVITS 没启动,用台式机桌面上的快捷方式启动它)",
    )
    # 直连台式机时连接超时:多半没开机或者不在一个网络
    assert transport_error("http://100.64.1.2:9880", "IndexTTS", httpx.ConnectTimeout("slow")) == (
        503,
        "连不上语音服务 http://100.64.1.2:9880(台式机没响应:没开机,或者不在同一个网络)",
    )
    assert transport_error(tunnel, "GPT-SoVITS", httpx.ReadTimeout("slow")) == (504, "语音合成超时")


def test_cold_timeout_until_first_success(gsv):
    engine = GptSovitsEngine(URL, 64)

    async def scenario():
        await engine.synthesize("一", AMIYA)
        await engine.synthesize("二", AMIYA)

    run(scenario())
    assert gsv.timeouts == [90.0, 30.0]


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
        "app.tts.gpt_sovits.make_tts_client",
        lambda base_url, timeout: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    engine = GptSovitsEngine(URL, 64)

    async def scenario():
        await asyncio.gather(engine.synthesize("一", AMIYA), engine.synthesize("二", SLEACH))

    run(scenario())
    # 没有锁的话,两个请求的切权重会交错,阿米娅的台词可能用琴柳的声音念
    assert peak == 1


def test_warmup_forced_reloads_weights_and_always_waits_cold(gsv):
    engine = GptSovitsEngine(URL, 64)

    async def scenario():
        await engine.synthesize("一", AMIYA)
        await engine.warmup(AMIYA, force=False)
        await engine.warmup(AMIYA, force=True)

    run(scenario())
    assert gsv.names() == [*SWITCH, "tts", "tts", *SWITCH, "tts"]
    assert gsv.calls[3][1]["text"] == "你好。"
    # 服务可能刚重启过,预热总是按冷启动的超时等
    assert gsv.timeouts == [90.0, 90.0, 90.0]


def test_ping(gsv):
    engine = GptSovitsEngine(URL, 64)
    run(engine.ping())
    assert gsv.names() == ["docs"]
    assert gsv.timeouts == [5.0]

    gsv.docs_reply = httpx.ConnectError("refused")
    with pytest.raises(TTSError) as err:
        run(engine.ping())
    assert err.value.status == 503


def test_private_and_tailscale_hosts_skip_proxy():
    direct = [
        "127.0.0.1",
        "localhost",
        "::1",
        "[::1]",
        "192.168.1.50",
        "192.168.1.5",
        "10.0.0.8",
        "100.101.102.103",
        "gpu-box",
        "gpu-box.tail1234.ts.net",
    ]
    for host in direct:
        assert is_direct_host(host), host
    for host in ["api.example.com", "8.8.8.8", ""]:
        assert not is_direct_host(host), host
    assert make_tts_client("http://192.168.1.50:9880", 5).trust_env is False
    assert make_tts_client("https://tts.example.com", 5).trust_env is True


def test_tts_clients_share_one_ssl_context(monkeypatch):
    # 每次合成都新建客户端;证书加载一次要 0.3–4 秒,不能每次都来
    from app.tts import http as tts_http

    made = []
    real = httpx.create_ssl_context
    monkeypatch.setattr(httpx, "create_ssl_context", lambda: made.append(1) or real())
    tts_http._ssl_context.cache_clear()
    try:
        for _ in range(3):
            make_tts_client("http://127.0.0.1:9880", 5)
        make_tts_client("https://tts.example.com", 5)
        assert len(made) == 1
    finally:
        tts_http._ssl_context.cache_clear()


def test_voice_params_reach_the_request_and_the_cache_key(gsv):
    engine = GptSovitsEngine(URL, sample_steps=64)
    tuned = replace(
        AMIYA,
        params={
            "sample_steps": 32,
            "temperature": 0.7,
            "top_p": 0.8,
            "top_k": 10,
            "repetition_penalty": 1.2,
            "text_split_method": "cut0",
            "fragment_interval": 0.2,
            "parallel_infer": False,
            "seed": 1234,
        },
    )
    run(engine.synthesize("博士。", tuned))

    body = gsv.calls[-1][1]
    assert (body["sample_steps"], body["text_split_method"]) == (32, "cut0")
    assert {k: body[k] for k in ("temperature", "top_p", "top_k", "repetition_penalty")} == {
        "temperature": 0.7,
        "top_p": 0.8,
        "top_k": 10,
        "repetition_penalty": 1.2,
    }
    assert (body["fragment_interval"], body["parallel_infer"], body["seed"]) == (0.2, False, 1234)
    assert engine.cache_material("博士。", tuned) != engine.cache_material("博士。", AMIYA)
    # 没调过的参数不发,用 api_v2 自己的默认 —— 加这个功能之前缓存的那些照样能命中
    plain = engine.request_body("博士。", AMIYA)
    assert "temperature" not in plain and "seed" not in plain
    # IndexTTS 的参数混进来也不发给 GSV
    odd = replace(AMIYA, params={"emo_alpha": 0.5})
    assert engine.request_body("博士。", odd) == plain
