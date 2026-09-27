from fastapi.testclient import TestClient


def make_conn(client: TestClient) -> dict:
    return client.post(
        "/api/tts/connections", json={"name": "5090", "base_url": "http://127.0.0.1:9880"}
    ).json()


def make_voice(client: TestClient, conn_id: str, **overrides) -> dict:
    payload = {
        "name": "阿米娅",
        "connection_id": conn_id,
        "gpt_weights": "D:/AnimaVoice/models/阿米娅/阿米娅-e10.ckpt",
        "sovits_weights": "D:/AnimaVoice/models/阿米娅/阿米娅_e10_s230_l32.pth",
    }
    payload.update(overrides)
    r = client.post("/api/voices", json=payload)
    assert r.status_code == 200, r.text
    return r.json()


def test_voice_profile_crud_and_unique_names(client: TestClient):
    conn = make_conn(client)
    # 资源管理器「复制文件地址」会带引号
    v = make_voice(
        client, conn["id"], aliases=["Amiya", " ", "阿米娅"], gpt_weights=' "D:\\AnimaVoice\\a.ckpt" '
    )
    assert v["aliases"] == ["Amiya"]
    assert v["gpt_weights"] == "D:\\AnimaVoice\\a.ckpt"
    assert (v["speed"], v["text_lang"]) == (1.0, "zh")
    assert (v["emotions"], v["card_count"]) == ([], 0)

    dup = client.post("/api/voices", json={"name": "阿米娅", "connection_id": conn["id"]})
    assert dup.status_code == 409
    assert client.post("/api/voices", json={"name": "琴柳", "connection_id": "nope"}).status_code == 400
    bad_name = client.post("/api/voices", json={"name": "琴【柳", "connection_id": conn["id"]})
    assert bad_name.status_code == 400

    r = client.put(f"/api/voices/{v['id']}", json={"speed": 1.2, "name": " 阿米娅 "})
    assert r.status_code == 200
    assert (r.json()["speed"], r.json()["name"]) == (1.2, "阿米娅")
    assert client.put(f"/api/voices/{v['id']}", json={"speed": 5}).status_code == 422

    # 还有声音在用的语音服务删不掉
    blocked = client.delete(f"/api/tts/connections/{conn['id']}")
    assert blocked.status_code == 400
    assert blocked.json()["detail"] == "还有 1 个声音档案在用这个连接"
    assert client.get("/api/tts/connections").json()[0]["profile_count"] == 1

    assert client.delete(f"/api/voices/{v['id']}").status_code == 204
    assert client.get("/api/voices").json() == []
    assert client.delete(f"/api/tts/connections/{conn['id']}").status_code == 204


def test_emotions_keep_order_fill_prompt_from_filename_and_reject_duplicates(client: TestClient):
    v = make_voice(client, make_conn(client)["id"])
    base = f"/api/voices/{v['id']}/emotions"

    a = client.post(
        base,
        json={"label": "平静", "ref_path": '"D:/AnimaVoice/refs/阿米娅/【平静】作为罗德岛的领导者。.wav"'},
    ).json()
    assert a["ref_path"] == "D:/AnimaVoice/refs/阿米娅/【平静】作为罗德岛的领导者。.wav"
    assert a["prompt_text"] == "作为罗德岛的领导者。"
    b = client.post(
        base,
        json={"label": "开心", "aliases": ["Happy"], "ref_path": "D:/x.wav", "prompt_text": "太好了"},
    ).json()
    assert (a["sort"], b["sort"]) == (0, 1)

    # 名字和别名在同一个声音里不能撞,不分大小写
    assert client.post(base, json={"label": "happy"}).status_code == 409
    assert client.post(base, json={"label": "平静"}).status_code == 409

    upd = client.put(f"{base}/{b['id']}", json={"prompt_text": " 太好了！ "})
    assert upd.json()["prompt_text"] == "太好了！"
    assert upd.json()["aliases"] == ["Happy"]

    reordered = client.post(f"{base}/reorder", json={"ids": [b["id"], a["id"]]})
    assert [e["label"] for e in reordered.json()] == ["开心", "平静"]
    assert [e["label"] for e in client.get("/api/voices").json()[0]["emotions"]] == ["开心", "平静"]
    assert client.post(f"{base}/reorder", json={"ids": [a["id"]]}).status_code == 400

    assert client.delete(f"{base}/{a['id']}").status_code == 204
    assert [e["label"] for e in client.get("/api/voices").json()[0]["emotions"]] == ["开心"]
    assert client.delete(f"{base}/{a['id']}").status_code == 404


AMIYA_REFS = {
    "character": "阿米娅",
    "model_version": "v4",
    "gpt_weights": "D:/AnimaVoice/models/阿米娅/阿米娅-e10.ckpt",
    "sovits_weights": "D:/AnimaVoice/models/阿米娅/阿米娅_e10_s230_l32.pth",
    "refs": [
        {
            "emotion": "平静",
            "file": "D:/AnimaVoice/refs/阿米娅/【平静】作为罗德岛的领导者。.wav",
            "text": "作为罗德岛的领导者。",
            "lang": "zh",
            "seconds": 7.32,
        },
        # 只给文件时,情绪名和原文从文件名取
        {"file": "D:/AnimaVoice/refs/阿米娅/【开心】太好了，博士！.wav"},
    ],
}


def test_import_refs_json_creates_then_updates_by_name(client: TestClient):
    conn = make_conn(client)
    r = client.post("/api/voices/import", json={"connection_id": conn["id"], "refs": AMIYA_REFS})
    assert r.status_code == 200, r.text
    v = r.json()
    assert v["name"] == "阿米娅"
    assert v["gpt_weights"] == AMIYA_REFS["gpt_weights"]
    assert [(e["label"], e["prompt_text"]) for e in v["emotions"]] == [
        ("平静", "作为罗德岛的领导者。"),
        ("开心", "太好了，博士！"),
    ]

    again = dict(
        AMIYA_REFS,
        sovits_weights="D:/new.pth",
        refs=[
            {"emotion": "开心", "file": "D:/new-happy.wav", "text": "新的原文"},
            {"emotion": "担心", "file": "D:/worry.wav", "text": "博士……"},
        ],
    )
    v2 = client.post("/api/voices/import", json={"connection_id": conn["id"], "refs": again}).json()
    assert v2["id"] == v["id"]
    assert v2["sovits_weights"] == "D:/new.pth"
    assert [(e["label"], e["ref_path"]) for e in v2["emotions"]] == [
        ("平静", AMIYA_REFS["refs"][0]["file"]),
        ("开心", "D:/new-happy.wav"),
        ("担心", "D:/worry.wav"),
    ]
    assert len(client.get("/api/voices").json()) == 1

    bad = [
        {"refs": [{"file": "D:/a.wav"}]},
        {"character": "x", "refs": []},
        {"character": "x", "refs": [{"emotion": "平静"}]},
    ]
    for refs in bad:
        r = client.post("/api/voices/import", json={"connection_id": conn["id"], "refs": refs})
        assert r.status_code == 400, refs


def test_card_voice_binding_follows_card_and_profile_lifecycle(client: TestClient, make_card):
    conn = make_conn(client)
    amiya = make_voice(client, conn["id"], name="阿米娅")
    sleach = make_voice(client, conn["id"], name="琴柳")
    card = make_card(name="阿米娅")
    url = f"/api/tavern/cards/{card['id']}/voices"

    assert client.get(url).json() == {"card_id": card["id"], "main": None, "extras": []}
    # 主声音不会同时出现在其他声音里,重复的去掉
    r = client.put(url, json={"main": amiya["id"], "extras": [sleach["id"], amiya["id"], sleach["id"]]})
    assert r.json() == {"card_id": card["id"], "main": amiya["id"], "extras": [sleach["id"]]}
    assert client.put(url, json={"main": "nope"}).status_code == 404
    assert client.get("/api/tavern/cards/nope/voices").status_code == 404
    counts = {v["name"]: v["card_count"] for v in client.get("/api/voices").json()}
    assert counts == {"阿米娅": 1, "琴柳": 1}

    copy = client.post(f"/api/tavern/cards/{card['id']}/duplicate", json={}).json()
    assert client.get(f"/api/tavern/cards/{copy['id']}/voices").json()["main"] == amiya["id"]

    client.delete(f"/api/voices/{sleach['id']}")
    assert client.get(url).json()["extras"] == []

    client.delete(f"/api/tavern/cards/{card['id']}")
    # 原卡的绑定删掉了,只剩副本的
    assert {v["name"]: v["card_count"] for v in client.get("/api/voices").json()} == {"阿米娅": 1}


def test_indextts_fields_speaker_ref_and_emotion_vector(client: TestClient):
    v = make_voice(client, make_conn(client)["id"], ref_path=' "D:/refs/阿米娅/平静.wav" ')
    assert v["ref_path"] == "D:/refs/阿米娅/平静.wav"
    base = f"/api/voices/{v['id']}/emotions"

    happy = client.post(base, json={"label": "开心", "emo_vector": [0.8, 0, 0, 0, 0, 0, 0, 0]})
    assert happy.status_code == 200, happy.text
    assert happy.json()["emo_vector"] == [0.8, 0, 0, 0, 0, 0, 0, 0]
    # 全 0 = 不控制,存成空
    assert client.post(base, json={"label": "平静", "emo_vector": [0] * 8}).json()["emo_vector"] is None

    eid = happy.json()["id"]
    sad = [0, 0, 0.5, 0, 0, 0.3, 0, 0]
    assert client.put(f"{base}/{eid}", json={"emo_vector": sad}).json()["emo_vector"] == sad
    # 只改名字不动向量
    assert client.put(f"{base}/{eid}", json={"label": "高兴"}).json()["emo_vector"] == sad
    assert client.put(f"{base}/{eid}", json={"emo_vector": None}).json()["emo_vector"] is None

    r = client.put(f"/api/voices/{v['id']}", json={"ref_path": "D:/refs/b.wav"})
    assert r.json()["ref_path"] == "D:/refs/b.wav"


def test_emotion_vector_is_validated(client: TestClient):
    v = make_voice(client, make_conn(client)["id"])
    base = f"/api/voices/{v['id']}/emotions"
    cases = [
        ([0.5] * 7, "情绪向量要正好 8 个数(现在是 7 个)"),
        ([1.3, 0, 0, 0, 0, 0, 0, 0], "「高兴」要在 0 到 1.2 之间"),
        ([0, -0.1, 0, 0, 0, 0, 0, 0], "「愤怒」要在 0 到 1.2 之间"),
        ([0.8, 0.8, 0, 0, 0, 0, 0, 0], "情绪向量合计 1.60,不能超过 1.5"),
    ]
    for vec, detail in cases:
        r = client.post(base, json={"label": "x", "emo_vector": vec})
        assert (r.status_code, r.json()["detail"]) == (400, detail)
    assert client.get("/api/voices").json()[0]["emotions"] == []


def test_emotions_from_sprites_adds_missing_rows_with_preset_vectors(client: TestClient, make_card):
    conn = client.post(
        "/api/tts/connections",
        json={"name": "IndexTTS", "api_type": "indextts", "base_url": "http://127.0.0.1:9890"},
    ).json()
    v = make_voice(client, conn["id"], name="阿米娅·Index")
    card = make_card(name="阿米娅")
    sprites = f"/api/tavern/cards/{card['id']}/sprites"
    for label, aliases in [("平静", ["normal"]), ("开心", ["happy"]), ("红瞳", ["angry"]), ("持旗", [])]:
        assert client.post(sprites, json={"label": label, "aliases": aliases}).status_code == 200
    # 已经有的(按立绘别名也算对上)不动
    client.post(f"/api/voices/{v['id']}/emotions", json={"label": "happy", "ref_path": "D:/emo/笑.wav"})

    r = client.post(f"/api/voices/{v['id']}/emotions/from-sprites", json={"card_id": card["id"]})
    assert r.status_code == 200, r.text
    assert [(e["label"], e["emo_vector"], e["ref_path"]) for e in r.json()] == [
        ("happy", None, "D:/emo/笑.wav"),
        ("平静", None, ""),
        ("红瞳", [0, 0.7, 0, 0, 0, 0, 0, 0], ""),
        ("持旗", None, ""),
    ]
    # 再点一次什么也不加
    again = client.post(f"/api/voices/{v['id']}/emotions/from-sprites", json={"card_id": card["id"]})
    assert len(again.json()) == 4


def test_emotions_from_sprites_rejects_gsv_voices_and_unknown_cards(client: TestClient, make_card):
    v = make_voice(client, make_conn(client)["id"])
    card = make_card()
    r = client.post(f"/api/voices/{v['id']}/emotions/from-sprites", json={"card_id": card["id"]})
    assert (r.status_code, r.json()["detail"]) == (400, "GSV 的情绪行要配参考音频,不能自动生成")
    conn = client.post(
        "/api/tts/connections",
        json={"name": "IndexTTS", "api_type": "indextts", "base_url": "http://127.0.0.1:9890"},
    ).json()
    iv = make_voice(client, conn["id"], name="琴柳")
    r = client.post(f"/api/voices/{iv['id']}/emotions/from-sprites", json={"card_id": "nope"})
    assert r.status_code == 404


def test_import_refs_for_indextts_takes_speaker_ref_and_vectors(client: TestClient):
    conn = client.post(
        "/api/tts/connections",
        json={"name": "IndexTTS", "api_type": "indextts", "base_url": "http://127.0.0.1:9890"},
    ).json()
    refs = {
        "character": "阿米娅",
        "speaker_ref": "D:/AnimaVoice/refs/阿米娅/【平静】作为罗德岛的领导者.wav",
        "refs": [
            {"emotion": "开心", "emo_vector": [0.8, 0, 0, 0, 0, 0, 0, 0], "file": "D:/emo/笑.wav"},
            {"emotion": "难过", "file": "D:/emo/哭.wav"},
        ],
    }
    r = client.post("/api/voices/import", json={"connection_id": conn["id"], "refs": refs})
    assert r.status_code == 200, r.text
    v = r.json()
    assert v["ref_path"] == refs["speaker_ref"]
    assert [(e["label"], e["emo_vector"], e["prompt_text"]) for e in v["emotions"]] == [
        ("开心", [0.8, 0, 0, 0, 0, 0, 0, 0], ""),
        ("难过", None, ""),
    ]

    # 没写 speaker_ref:用 refs 第一条的文件
    only = {"character": "琴柳", "refs": [{"emotion": "平静", "file": "D:/refs/琴柳/平静.wav"}]}
    r2 = client.post("/api/voices/import", json={"connection_id": conn["id"], "refs": only})
    assert r2.json()["ref_path"] == "D:/refs/琴柳/平静.wav"

    bad_vec = {
        "character": "x",
        "refs": [{"emotion": "怒", "file": "D:/a.wav", "emo_vector": [2, 0, 0, 0, 0, 0, 0, 0]}],
    }
    r3 = client.post("/api/voices/import", json={"connection_id": conn["id"], "refs": bad_vec})
    assert (r3.status_code, r3.json()["detail"]) == (400, "refs 第 1 条:「高兴」要在 0 到 1.2 之间")
    not_list = {"character": "x", "refs": [{"emotion": "怒", "file": "D:/a.wav", "emo_vector": "0.8"}]}
    r4 = client.post("/api/voices/import", json={"connection_id": conn["id"], "refs": not_list})
    assert (r4.status_code, r4.json()["detail"]) == (400, "refs 第 1 条的 emo_vector 要是 8 个数的列表")


def test_import_refs_for_gsv_still_requires_text(client: TestClient):
    conn = make_conn(client)
    refs = {"character": "x", "refs": [{"emotion": "平静", "file": "D:/a.wav"}]}
    r = client.post("/api/voices/import", json={"connection_id": conn["id"], "refs": refs})
    assert (r.status_code, r.json()["detail"]) == (400, "refs 第 1 条没有 text(参考音频的原文)")


def test_emotions_from_sprites_uses_builtin_list_when_card_has_no_sprites(client: TestClient, make_card):
    conn = client.post(
        "/api/tts/connections",
        json={"name": "IndexTTS", "api_type": "indextts", "base_url": "http://127.0.0.1:9890"},
    ).json()
    v = make_voice(client, conn["id"], name="酒馆导入的角色")
    card = make_card(name="没有立绘")
    r = client.post(f"/api/voices/{v['id']}/emotions/from-sprites", json={"card_id": card["id"]})
    assert r.status_code == 200, r.text
    rows = r.json()
    assert [e["label"] for e in rows][:4] == ["平静", "微笑", "开心", "温柔"]
    assert len(rows) == 16
    happy = next(e for e in rows if e["label"] == "开心")
    assert happy["aliases"] == ["高兴", "happy"]
    assert happy["emo_vector"] == [0.8, 0, 0, 0, 0, 0, 0, 0]


def test_emotions_from_sprites_skips_disabled_sprites(client: TestClient, make_card):
    """规格:语音的情绪候选跟着立绘走,也不含禁用的;立绘全禁用 = 用内置基础表情"""
    conn = client.post(
        "/api/tts/connections",
        json={"name": "IndexTTS", "api_type": "indextts", "base_url": "http://127.0.0.1:9890"},
    ).json()
    card = make_card(name="有禁用立绘")
    sprites = f"/api/tavern/cards/{card['id']}/sprites"
    ids = {label: client.post(sprites, json={"label": label}).json()["id"] for label in ["平静", "哭泣"]}
    assert client.put(f"{sprites}/{ids['哭泣']}", json={"enabled": False}).status_code == 200

    v = make_voice(client, conn["id"], name="部分禁用")
    r = client.post(f"/api/voices/{v['id']}/emotions/from-sprites", json={"card_id": card["id"]})
    assert [e["label"] for e in r.json()] == ["平静"]

    assert client.put(f"{sprites}/{ids['平静']}", json={"enabled": False}).status_code == 200
    v2 = make_voice(client, conn["id"], name="全部禁用")
    r2 = client.post(f"/api/voices/{v2['id']}/emotions/from-sprites", json={"card_id": card["id"]})
    assert len(r2.json()) == 16
    assert "哭泣" not in [e["label"] for e in r2.json()]


def test_voice_params_are_validated_and_saved_whole(client: TestClient):
    v = make_voice(client, make_conn(client)["id"])
    assert v["params"] == {}
    url = f"/api/voices/{v['id']}"

    r = client.put(url, json={"params": {"temperature": 0.7, "top_k": 10, "text_split_method": "cut0"}})
    assert r.status_code == 200, r.text
    assert r.json()["params"] == {"temperature": 0.7, "top_k": 10, "text_split_method": "cut0"}
    # 整组替换:没带的就是回到默认
    assert client.put(url, json={"params": {"parallel_infer": False}}).json()["params"] == {
        "parallel_infer": False
    }
    # 不动 params 的修改不会清掉它
    assert client.put(url, json={"speed": 1.1}).json()["params"] == {"parallel_infer": False}

    for bad in (
        {"temperature": 5},
        {"top_k": 0},
        {"text_split_method": "cut9"},
        {"sample_steps": 999},
        {"emo_alpha": 1.5},
        # 固定种子只在试音台里临时用,不存
        {"seed": 1},
        {"tempreature": 0.7},
    ):
        assert client.put(url, json={"params": bad}).status_code == 422, bad
    assert client.get("/api/voices").json()[0]["params"] == {"parallel_infer": False}
