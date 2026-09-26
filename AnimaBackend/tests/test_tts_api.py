from urllib.parse import unquote

import httpx
from fastapi.testclient import TestClient


def make_conn(client: TestClient, **overrides) -> dict:
    payload = {"name": "5090", "base_url": "http://gsv.test:9880"}
    payload.update(overrides)
    r = client.post("/api/tts/connections", json=payload)
    assert r.status_code == 200, r.text
    return r.json()


def test_tts_connection_crud(client: TestClient):
    conn = make_conn(client, name=" 5090 ", base_url=" http://127.0.0.1:9880/ ")
    assert conn["name"] == "5090"
    assert conn["base_url"] == "http://127.0.0.1:9880"
    assert conn["api_type"] == "gpt_sovits"
    assert conn["sample_steps"] == 64
    assert conn["profile_count"] == 0

    updated = client.put(f"/api/tts/connections/{conn['id']}", json={"sample_steps": 32})
    assert updated.status_code == 200
    assert updated.json()["sample_steps"] == 32
    assert client.get("/api/tts/connections").json()[0]["sample_steps"] == 32

    bad_url = client.post("/api/tts/connections", json={"name": "x", "base_url": "127.0.0.1:9880"})
    assert bad_url.status_code == 400
    assert client.put(f"/api/tts/connections/{conn['id']}", json={"sample_steps": 999}).status_code == 422
    assert client.put("/api/tts/connections/nope", json={"name": "x"}).status_code == 404

    assert client.delete(f"/api/tts/connections/{conn['id']}").status_code == 204
    assert client.get("/api/tts/connections").json() == []


def test_tts_connection_test_reports_reachability(client: TestClient, gsv):
    conn = make_conn(client)
    ok = client.post(f"/api/tts/connections/{conn['id']}/test")
    assert ok.status_code == 200
    assert ok.json()["ms"] >= 0

    gsv.docs_reply = httpx.ConnectError("refused")
    bad = client.post(f"/api/tts/connections/{conn['id']}/test")
    assert bad.status_code == 503
    assert bad.json()["detail"] == "连不上语音服务 http://gsv.test:9880(台式机没开机、GPT-SoVITS 没启动,或者网络不通)"


def setup_voice(client: TestClient, emotions=(("平静", []), ("开心", ["Happy"]))) -> tuple[dict, dict]:
    conn = make_conn(client)
    voice = client.post(
        "/api/voices",
        json={
            "name": "阿米娅",
            "connection_id": conn["id"],
            "gpt_weights": "D:/a.ckpt",
            "sovits_weights": "D:/a.pth",
        },
    ).json()
    for label, aliases in emotions:
        client.post(
            f"/api/voices/{voice['id']}/emotions",
            json={
                "label": label,
                "aliases": aliases,
                "ref_path": f"D:/refs/{label}.wav",
                "prompt_text": f"{label}的原文",
            },
        )
    return conn, voice


def speak(client: TestClient, profile_id: str, text: str = "博士，早上好。", emotion: str | None = None, **kw):
    return client.post(
        "/api/tts/speak", json={"profile_id": profile_id, "emotion": emotion, "text": text}, **kw
    )


def test_speak_synthesizes_once_then_serves_from_cache(client: TestClient, gsv):
    _, voice = setup_voice(client)
    first = speak(client, voice["id"], emotion="开心")
    assert first.status_code == 200, first.text
    assert first.content == b"RIFF" + "博士，早上好。".encode()
    assert first.headers["content-type"] == "audio/wav"
    assert first.headers["x-tts-cache"] == "miss"
    assert unquote(first.headers["x-tts-emotion"]) == "开心"
    assert gsv.calls[-1][1]["ref_audio_path"] == "D:/refs/开心.wav"
    assert gsv.calls[-1][1]["prompt_text"] == "开心的原文"

    second = speak(client, voice["id"], emotion="开心")
    assert second.headers["x-tts-cache"] == "hit"
    assert second.content == first.content
    assert gsv.names().count("tts") == 1
    assert client.get("/api/tts/cache").json()["count"] == 1


def test_speak_fresh_resynthesizes_and_replaces_cached_take(client: TestClient, gsv):
    _, voice = setup_voice(client)
    first = speak(client, voice["id"])
    assert first.headers["x-tts-cache"] == "miss"

    # 重新生成:不看缓存,再合成一遍(api_v2 每次随机种子不同,念法会变)
    gsv.tts_reply = httpx.Response(200, headers={"content-type": "audio/wav"}, content=b"RIFF-take2")
    again = client.post(
        "/api/tts/speak", json={"profile_id": voice["id"], "text": "博士，早上好。", "fresh": True}
    )
    assert again.status_code == 200, again.text
    assert again.headers["x-tts-cache"] == "miss"
    assert again.content == b"RIFF-take2"
    assert gsv.names().count("tts") == 2

    # 新的这版替换掉缓存里的旧版,之后重播听到的是它
    third = speak(client, voice["id"])
    assert third.headers["x-tts-cache"] == "hit"
    assert third.content == b"RIFF-take2"
    assert client.get("/api/tts/cache").json()["count"] == 1


def test_speak_resolves_emotion_by_alias_or_falls_back_to_default(client: TestClient, gsv):
    _, voice = setup_voice(client)

    def emotion_of(r):
        return unquote(r.headers["x-tts-emotion"])

    assert emotion_of(speak(client, voice["id"], text="一", emotion="happy")) == "开心"
    # 情绪识别模型没装(conftest 默认):对不上就用默认
    assert emotion_of(speak(client, voice["id"], text="二", emotion="惊讶")) == "平静"
    assert emotion_of(speak(client, voice["id"], text="三")) == "平静"


class FakeEmotionEncoder:
    """每个词一个固定向量,测「就近回退」用"""

    name = "fake"
    table = {
        "惊讶": [0.2, 1, 0],
        "平静": [1, 0, 0],
        "疑惑": [0.1, 1, 0.1],
        "害羞": [0, 0.3, 1],
        "开心": [0, 0, 1],
        "微笑": [0.5, 0.5, 0],
        "Happy": [0, 0.1, 1],
    }

    def encode(self, texts):
        import numpy as np

        rows = np.array([self.table[t] for t in texts], dtype=np.float32)
        return rows / np.linalg.norm(rows, axis=1, keepdims=True)


def test_speak_falls_back_to_the_nearest_emotion_row(client: TestClient, gsv, monkeypatch):
    from app.api import tts
    from app.emotion.matcher import EmotionMatcher

    monkeypatch.setattr(tts, "get_matcher", lambda: EmotionMatcher(FakeEmotionEncoder()))
    # 琴柳这种:没有「惊讶」的参考,有「疑惑」「害羞」
    _, voice = setup_voice(client, emotions=(("平静", []), ("疑惑", []), ("害羞", [])))

    r = speak(client, voice["id"], emotion="惊讶")
    assert r.status_code == 200, r.text
    assert unquote(r.headers["x-tts-emotion"]) == "疑惑"
    assert gsv.calls[-1][1]["ref_audio_path"] == "D:/refs/疑惑.wav"
    # 精确对得上的照旧不问模型;没传情绪用默认
    assert unquote(speak(client, voice["id"], text="二", emotion="害羞").headers["x-tts-emotion"]) == "害羞"
    assert unquote(speak(client, voice["id"], text="三").headers["x-tts-emotion"]) == "平静"


def test_nearest_emotion_counts_aliases_as_names(client: TestClient, gsv, monkeypatch):
    from app.api import tts
    from app.emotion.matcher import EmotionMatcher

    monkeypatch.setattr(tts, "get_matcher", lambda: EmotionMatcher(FakeEmotionEncoder()))
    # 「开心」离 害羞 更近,但「微笑」这一行的别名 Happy 离得最近
    _, voice = setup_voice(client, emotions=(("平静", []), ("害羞", []), ("微笑", ["Happy"])))
    r = speak(client, voice["id"], emotion="开心")
    assert unquote(r.headers["x-tts-emotion"]) == "微笑"


def test_speak_rejects_missing_refs_and_empty_text(client: TestClient, gsv):
    _, voice = setup_voice(client, emotions=())
    r = speak(client, voice["id"])
    assert (r.status_code, r.json()["detail"]) == (400, "声音「阿米娅」还没有参考音频")
    assert speak(client, "nope").status_code == 404
    assert gsv.calls == []


def test_speak_rejects_punctuation_only_text(client: TestClient, gsv):
    _, voice = setup_voice(client)
    r = speak(client, voice["id"], text="……！")
    assert (r.status_code, r.json()["detail"]) == (400, "没有要念的文字")


def test_speak_maps_engine_failures_and_does_not_cache_them(client: TestClient, gsv):
    _, voice = setup_voice(client)
    gsv.tts_reply = httpx.Response(400, json={"message": "tts failed", "Exception": "请输入有效文本"})
    r = speak(client, voice["id"], text="一")
    assert (r.status_code, r.json()["detail"]) == (502, "请输入有效文本")
    gsv.tts_reply = httpx.ConnectError("refused")
    r = speak(client, voice["id"], text="二")
    assert (r.status_code, r.json()["detail"]) == (503, "连不上语音服务 http://gsv.test:9880(台式机没开机、GPT-SoVITS 没启动,或者网络不通)")
    gsv.tts_reply = httpx.ReadTimeout("slow")
    r = speak(client, voice["id"], text="三")
    assert (r.status_code, r.json()["detail"]) == (504, "语音合成超时")
    assert client.get("/api/tts/cache").json()["count"] == 0


def test_warmup_loads_weights_without_caching(client: TestClient, gsv):
    _, voice = setup_voice(client)
    r = client.post("/api/tts/warmup", json={"profile_id": voice["id"]})
    assert r.status_code == 200 and r.json()["ms"] >= 0
    client.post("/api/tts/warmup", json={"profile_id": voice["id"], "force": True})
    assert gsv.names() == [
        "set_gpt_weights",
        "set_sovits_weights",
        "tts",
        "set_gpt_weights",
        "set_sovits_weights",
        "tts",
    ]
    assert client.get("/api/tts/cache").json()["count"] == 0


def test_changing_sample_steps_changes_cache_key(client: TestClient, gsv):
    conn, voice = setup_voice(client)
    speak(client, voice["id"], text="一")
    client.put(f"/api/tts/connections/{conn['id']}", json={"sample_steps": 32})
    assert speak(client, voice["id"], text="一").headers["x-tts-cache"] == "miss"
    assert gsv.calls[-1][1]["sample_steps"] == 32


def test_cache_stats_and_clear(client: TestClient, gsv):
    _, voice = setup_voice(client)
    speak(client, voice["id"], text="一")
    stats = client.get("/api/tts/cache").json()
    assert stats["count"] == 1 and stats["bytes"] > 0
    assert stats["limit_bytes"] == 500 * 1024 * 1024
    assert client.delete("/api/tts/cache").status_code == 204
    assert client.get("/api/tts/cache").json()["count"] == 0


def test_voice_headers_are_readable_cross_origin(client: TestClient, gsv):
    _, voice = setup_voice(client)
    r = speak(client, voice["id"], headers={"Origin": "http://localhost:5173"})
    exposed = r.headers["access-control-expose-headers"].lower()
    assert "x-tts-cache" in exposed and "x-tts-emotion" in exposed and "x-tts-emo-mode" in exposed
    # GSV 的情绪都来自参考音频
    assert r.headers["x-tts-emo-mode"] == "ref"


def test_indextts_connection_keeps_emotion_strength(client: TestClient):
    conn = make_conn(client, name="IndexTTS", api_type="indextts", base_url="http://index.test:9890")
    # 用户试听:情绪强度高的好,默认 1.0
    assert (conn["api_type"], conn["emo_alpha"]) == ("indextts", 1.0)
    r = client.put(f"/api/tts/connections/{conn['id']}", json={"emo_alpha": 0.8})
    assert r.status_code == 200
    assert r.json()["emo_alpha"] == 0.8
    assert client.get("/api/tts/connections").json()[0]["emo_alpha"] == 0.8
    assert client.put(f"/api/tts/connections/{conn['id']}", json={"emo_alpha": 1.5}).status_code == 422
    # GSV 也返回这个字段,只是用不到
    assert make_conn(client)["emo_alpha"] == 1.0
    bad = client.post(
        "/api/tts/connections", json={"name": "x", "base_url": "http://a.test:1", "api_type": "edge"}
    )
    assert bad.status_code == 422


INDEX_URL = "http://index.test:9890"
SPK = "D:/refs/阿米娅/平静.wav"
HAPPY = [0.8, 0, 0, 0, 0, 0, 0, 0]


def setup_index_voice(client: TestClient) -> tuple[dict, dict]:
    conn = make_conn(client, name="IndexTTS", api_type="indextts", base_url=INDEX_URL)
    voice = client.post(
        "/api/voices",
        json={"name": "阿米娅·Index", "connection_id": conn["id"], "ref_path": SPK, "speed": 1.25},
    ).json()
    for label, vec, ref in [("平静", None, ""), ("开心", HAPPY, ""), ("难过", None, "D:/emo/哭.wav")]:
        r = client.post(
            f"/api/voices/{voice['id']}/emotions",
            json={"label": label, "emo_vector": vec, "ref_path": ref},
        )
        assert r.status_code == 200, r.text
    return conn, voice


def test_indextts_speak_picks_emotion_source_per_row(client: TestClient, index_tts):
    _, voice = setup_index_voice(client)
    happy = speak(client, voice["id"], text="一", emotion="开心")
    assert happy.status_code == 200, happy.text
    assert happy.headers["x-tts-emo-mode"] == "vector"
    assert speak(client, voice["id"], text="二", emotion="难过").headers["x-tts-emo-mode"] == "ref"
    calm = speak(client, voice["id"], text="三", emotion="没有这个表情")
    assert (unquote(calm.headers["x-tts-emotion"]), calm.headers["x-tts-emo-mode"]) == ("平静", "none")

    b_happy, b_sad, b_calm = index_tts.bodies()
    assert b_happy == {
        "text": "一",
        "lang": "zh",
        "spk_audio_path": SPK,
        "emo_audio_path": None,
        "emo_vector": HAPPY,
        "emo_alpha": 1.0,
        "duration_factor": 0.8,
    }
    assert (b_sad["emo_audio_path"], b_sad["emo_vector"]) == ("D:/emo/哭.wav", None)
    assert (b_calm["emo_audio_path"], b_calm["emo_vector"]) == (None, None)


def test_indextts_needs_speaker_ref_but_no_emotion_rows(client: TestClient, index_tts):
    conn = make_conn(client, api_type="indextts", base_url=INDEX_URL)
    voice = client.post("/api/voices", json={"name": "琴柳", "connection_id": conn["id"]}).json()
    r = speak(client, voice["id"])
    assert (r.status_code, r.json()["detail"]) == (400, "声音「琴柳」还没填音色参考")
    assert index_tts.calls == []

    client.put(f"/api/voices/{voice['id']}", json={"ref_path": "D:/refs/琴柳/平静.wav"})
    # 一行情绪都没有也能念:沿用音色参考的语气
    r = speak(client, voice["id"])
    assert r.status_code == 200, r.text
    assert (r.headers["x-tts-emo-mode"], unquote(r.headers["x-tts-emotion"])) == ("none", "")


def test_indextts_cache_key_follows_vector_and_strength(client: TestClient, index_tts):
    conn, voice = setup_index_voice(client)
    assert speak(client, voice["id"], text="一", emotion="开心").headers["x-tts-cache"] == "miss"
    assert speak(client, voice["id"], text="一", emotion="开心").headers["x-tts-cache"] == "hit"

    happy = next(e for e in client.get("/api/voices").json()[0]["emotions"] if e["label"] == "开心")
    client.put(
        f"/api/voices/{voice['id']}/emotions/{happy['id']}", json={"emo_vector": [0.6, 0, 0, 0, 0, 0, 0, 0]}
    )
    assert speak(client, voice["id"], text="一", emotion="开心").headers["x-tts-cache"] == "miss"

    client.put(f"/api/tts/connections/{conn['id']}", json={"emo_alpha": 0.8})
    assert speak(client, voice["id"], text="一", emotion="开心").headers["x-tts-cache"] == "miss"
    assert index_tts.bodies()[-1]["emo_alpha"] == 0.8
    assert len(index_tts.bodies()) == 3


def test_indextts_errors_test_and_warmup(client: TestClient, index_tts):
    conn, voice = setup_index_voice(client)
    index_tts.tts_reply = httpx.Response(400, json={"detail": f"音色参考不存在: {SPK}"})
    r = speak(client, voice["id"], text="一")
    assert (r.status_code, r.json()["detail"]) == (502, f"音色参考不存在: {SPK}")
    index_tts.tts_reply = None

    index_tts.health_reply = httpx.Response(200, json={"model": "IndexTTS-2.5", "ready": False})
    r = client.post(f"/api/tts/connections/{conn['id']}/test")
    assert (r.status_code, r.json()["detail"]) == (503, "IndexTTS 还在加载模型")

    r = client.post("/api/tts/warmup", json={"profile_id": voice["id"]})
    assert r.status_code == 200, r.text
    assert index_tts.bodies()[-1]["text"] == "你好。"
    assert client.get("/api/tts/cache").json()["count"] == 0


def test_saved_voice_params_reach_gsv_and_change_the_cache_key(client: TestClient, gsv):
    _, voice = setup_voice(client)
    assert speak(client, voice["id"], text="一").headers["x-tts-cache"] == "miss"
    assert "temperature" not in gsv.calls[-1][1]

    client.put(f"/api/voices/{voice['id']}", json={"params": {"temperature": 0.7, "sample_steps": 32}})
    assert speak(client, voice["id"], text="一").headers["x-tts-cache"] == "miss"
    assert (gsv.calls[-1][1]["temperature"], gsv.calls[-1][1]["sample_steps"]) == (0.7, 32)
    assert speak(client, voice["id"], text="一").headers["x-tts-cache"] == "hit"


def test_tuning_replaces_saved_settings_for_one_request(client: TestClient, gsv):
    _, voice = setup_voice(client)
    client.put(f"/api/voices/{voice['id']}", json={"params": {"temperature": 0.7}})
    tuning = {"speed": 1.2, "text_lang": "ja", "params": {"top_k": 5}, "seed": 42}
    r = client.post(
        "/api/tts/speak", json={"profile_id": voice["id"], "text": "一", "tuning": tuning}
    )
    assert r.status_code == 200, r.text
    body = gsv.calls[-1][1]
    assert (body["speed_factor"], body["text_lang"], body["top_k"], body["seed"]) == (1.2, "ja", 5, 42)
    # 试音台的参数是一整组,存着的温度不掺进来
    assert "temperature" not in body

    # 试的那组不保存;平常念还是用存着的
    assert client.get("/api/voices").json()[0]["params"] == {"temperature": 0.7}
    assert speak(client, voice["id"], text="一").headers["x-tts-cache"] == "miss"
    assert (gsv.calls[-1][1]["temperature"], gsv.calls[-1][1]["speed_factor"]) == (0.7, 1.0)
    assert "seed" not in gsv.calls[-1][1]

    bad = dict(tuning, params={"temperature": 9})
    r = client.post("/api/tts/speak", json={"profile_id": voice["id"], "text": "一", "tuning": bad})
    assert r.status_code == 422


def test_indextts_voice_can_override_emotion_strength(client: TestClient, index_tts):
    conn, voice = setup_index_voice(client)
    client.put(f"/api/voices/{voice['id']}", json={"params": {"emo_alpha": 0.5}})
    assert speak(client, voice["id"], text="一", emotion="开心").status_code == 200
    assert index_tts.bodies()[-1]["emo_alpha"] == 0.5
    # 声音上没设的话,跟语音服务
    client.put(f"/api/voices/{voice['id']}", json={"params": {}})
    speak(client, voice["id"], text="一", emotion="开心")
    assert index_tts.bodies()[-1]["emo_alpha"] == 1.0


def explain(client: TestClient, profile_id: str, text: str = "博士，早上好。", emotion: str | None = None):
    return client.post("/api/tts/explain", json={"profile_id": profile_id, "emotion": emotion, "text": text})


def test_explain_reports_the_row_how_it_was_picked_and_the_exact_request(client: TestClient, gsv, monkeypatch):
    _, voice = setup_voice(client, emotions=(("平静", []), ("疑惑", []), ("开心", ["Happy"])))

    r = explain(client, voice["id"], emotion="开心")
    assert r.status_code == 200, r.text
    out = r.json()
    assert (out["profile_name"], out["connection_name"], out["api_type"]) == ("阿米娅", "5090", "gpt_sovits")
    assert (out["wanted"], out["emotion"], out["how"], out["mode"]) == ("开心", "开心", "exact", "ref")
    assert (out["gpt_weights"], out["sovits_weights"]) == ("D:/a.ckpt", "D:/a.pth")
    req = out["request"]
    assert (req["text"], req["ref_audio_path"], req["prompt_text"], req["prompt_lang"]) == (
        "博士，早上好。",
        "D:/refs/开心.wav",
        "开心的原文",
        "zh",
    )

    alias = explain(client, voice["id"], emotion="happy").json()
    assert (alias["emotion"], alias["how"], alias["via"]) == ("开心", "alias", "Happy")
    # 情绪识别模型没装(conftest 默认):对不上就用默认;没传情绪也是默认
    assert (explain(client, voice["id"], emotion="惊讶").json()["how"]) == "default"
    none = explain(client, voice["id"]).json()
    assert (none["wanted"], none["emotion"], none["how"]) == (None, "平静", "default")

    from app.api import tts
    from app.emotion.matcher import EmotionMatcher

    monkeypatch.setattr(tts, "get_matcher", lambda: EmotionMatcher(FakeEmotionEncoder()))
    near = explain(client, voice["id"], emotion="惊讶").json()
    assert (near["emotion"], near["how"], near["via"]) == ("疑惑", "nearest", "疑惑")
    assert 0 < near["score"] <= 1
    assert near["request"]["ref_audio_path"] == "D:/refs/疑惑.wav"

    # 只是说明,不碰语音服务
    assert gsv.calls == []


def test_explain_says_whether_the_line_is_already_cached(client: TestClient, gsv):
    _, voice = setup_voice(client)
    assert explain(client, voice["id"], emotion="开心").json()["cached"] is False
    speak(client, voice["id"], emotion="开心")
    assert explain(client, voice["id"], emotion="开心").json()["cached"] is True
    # 别的情绪是另一段语音
    assert explain(client, voice["id"], emotion="平静").json()["cached"] is False
    assert gsv.names().count("tts") == 1


def test_explain_fails_the_same_way_speak_would(client: TestClient, gsv):
    _, voice = setup_voice(client, emotions=())
    missing = explain(client, voice["id"])
    assert missing.status_code == 400
    assert "还没有参考音频" in missing.json()["detail"]
    assert explain(client, "nope").status_code == 404
    assert explain(client, voice["id"], text="……").json()["detail"] == "没有要念的文字"


def test_explain_shows_the_indextts_request(client: TestClient, index_tts):
    _, voice = setup_index_voice(client)
    out = explain(client, voice["id"], text="一", emotion="开心").json()
    assert (out["api_type"], out["emotion"], out["mode"]) == ("indextts", "开心", "vector")
    assert (out["request"]["spk_audio_path"], out["request"]["emo_vector"]) == (SPK, HAPPY)
    assert (out["gpt_weights"], out["sovits_weights"]) == ("", "")
    assert index_tts.bodies() == []
