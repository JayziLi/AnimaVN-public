from fastapi.testclient import TestClient

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
# ID3 头开头的 MP3;后端只看文件头,不解码
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 64

PACKS = "/api/scene-packs"


def _assets(pack_id: str) -> str:
    return f"{PACKS}/{pack_id}/assets"


def _binding(card_id: str) -> str:
    return f"/api/tavern/cards/{card_id}/scene-pack"


def _pack(client: TestClient, name: str = "罗德岛") -> dict:
    res = client.post(PACKS, json={"name": name})
    assert res.status_code == 200
    return res.json()


def test_pack_crud_counts_and_unique_names(client: TestClient, make_card):
    pack = _pack(client)
    assert (pack["bg_count"], pack["bgm_count"], pack["card_count"]) == (0, 0, 0)

    assert client.post(PACKS, json={"name": " 罗德岛 "}).status_code == 409
    assert client.post(PACKS, json={"name": "  "}).status_code == 400

    base = _assets(pack["id"])
    client.post(base, json={"kind": "bg", "label": "食堂"})
    client.post(base, json={"kind": "bg", "label": "走廊"})
    client.post(base, json={"kind": "bgm", "label": "日常"})
    card = make_card()
    client.put(_binding(card["id"]), json={"pack_id": pack["id"]})

    listed = client.get(PACKS).json()
    assert [(p["name"], p["bg_count"], p["bgm_count"], p["card_count"]) for p in listed] == [
        ("罗德岛", 2, 1, 1)
    ]

    renamed = client.put(f"{PACKS}/{pack['id']}", json={"name": "罗德岛本舰"})
    assert renamed.json()["name"] == "罗德岛本舰"


def test_asset_names_unique_per_kind_not_across_kinds(client: TestClient):
    pack = _pack(client)
    base = _assets(pack["id"])

    assert client.post(base, json={"kind": "bg", "label": "夜晚", "aliases": ["night"]}).status_code == 200
    # 背景和音乐各用各的标签,可以同名
    assert client.post(base, json={"kind": "bgm", "label": "夜晚"}).status_code == 200
    # 同一类里撞名 / 撞别名(不分大小写)不行
    assert client.post(base, json={"kind": "bg", "label": "NIGHT"}).status_code == 409
    assert client.post(base, json={"kind": "bgm", "label": "安静", "aliases": ["夜晚"]}).status_code == 409
    # 名字规则和立绘一样
    assert client.post(base, json={"kind": "bg", "label": "食<堂"}).status_code == 400
    assert client.post(base, json={"kind": "sprite", "label": "x"}).status_code == 422


def test_default_bgm_must_be_a_bgm_in_the_same_pack_and_is_cleared_on_delete(client: TestClient):
    pack = _pack(client)
    other = _pack(client, "维多利亚")
    base = _assets(pack["id"])
    bg = client.post(base, json={"kind": "bg", "label": "食堂"}).json()
    bg2 = client.post(base, json={"kind": "bg", "label": "走廊"}).json()
    bgm = client.post(base, json={"kind": "bgm", "label": "日常"}).json()
    foreign = client.post(_assets(other["id"]), json={"kind": "bgm", "label": "日常"}).json()

    ok = client.put(f"{base}/{bg['id']}", json={"bgm_id": bgm["id"], "focus_x": 30})
    assert ok.status_code == 200
    assert (ok.json()["bgm_id"], ok.json()["focus_x"]) == (bgm["id"], 30)

    # 另一个包里的曲子、背景当曲子、给曲子设默认曲,都不行
    assert client.put(f"{base}/{bg['id']}", json={"bgm_id": foreign["id"]}).status_code == 400
    assert client.put(f"{base}/{bg['id']}", json={"bgm_id": bg2["id"]}).status_code == 400
    assert client.put(f"{base}/{bgm['id']}", json={"bgm_id": bgm["id"]}).status_code == 400
    assert client.put(f"{base}/{bg['id']}", json={"focus_x": 101}).status_code == 422

    # 只改说明时默认曲不动;显式传 null 才清掉
    client.put(f"{base}/{bg['id']}", json={"description": "午饭时间"})
    assert client.get(base).json()[0]["bgm_id"] == bgm["id"]

    assert client.delete(f"{base}/{bgm['id']}").status_code == 204
    assert all(a["bgm_id"] is None for a in client.get(base).json())


def test_title_bgm_must_be_a_bgm_in_the_same_pack_and_is_cleared_on_delete(client: TestClient):
    pack = _pack(client)
    other = _pack(client, "千年")
    base = _assets(pack["id"])
    bg = client.post(base, json={"kind": "bg", "label": "食堂"}).json()
    bgm = client.post(base, json={"kind": "bgm", "label": "日常"}).json()
    foreign = client.post(_assets(other["id"]), json={"kind": "bgm", "label": "日常"}).json()
    url = f"{PACKS}/{pack['id']}"

    # 没设 = 封面放排第一的那首(前端决定)
    assert pack["title_bgm_id"] is None
    ok = client.put(url, json={"title_bgm_id": bgm["id"]})
    assert ok.status_code == 200
    assert ok.json()["title_bgm_id"] == bgm["id"]
    # 只改名字不碰封面音乐
    assert client.put(url, json={"name": "罗德岛本舰"}).json()["title_bgm_id"] == bgm["id"]
    assert client.get(PACKS).json()[0]["title_bgm_id"] == bgm["id"]

    assert client.put(url, json={"title_bgm_id": foreign["id"]}).status_code == 400
    assert client.put(url, json={"title_bgm_id": bg["id"]}).status_code == 400
    assert client.put(url, json={"title_bgm_id": "nope"}).status_code == 400

    # 显式传 null = 回到默认
    assert client.put(url, json={"title_bgm_id": None}).json()["title_bgm_id"] is None

    # 删掉这首,封面音乐也回到默认
    client.put(url, json={"title_bgm_id": bgm["id"]})
    assert client.delete(f"{base}/{bgm['id']}").status_code == 204
    assert client.get(PACKS).json()[0]["title_bgm_id"] is None


def test_disabling_an_asset_keeps_the_row_names_and_default_bgm_link(client: TestClient):
    pack = _pack(client)
    base = _assets(pack["id"])
    bg = client.post(base, json={"kind": "bg", "label": "食堂"}).json()
    bgm = client.post(base, json={"kind": "bgm", "label": "日常"}).json()
    client.put(f"{base}/{bg['id']}", json={"bgm_id": bgm["id"]})
    assert (bg["enabled"], bgm["enabled"]) == (True, True)

    off = client.put(f"{base}/{bgm['id']}", json={"enabled": False})
    assert off.status_code == 200
    assert off.json()["enabled"] is False

    # 禁用不是删除:背景的默认曲还指着它(重新启用就接着用),名字照样占着,包里照样算数
    listed = {a["label"]: a for a in client.get(base).json()}
    assert (listed["食堂"]["bgm_id"], listed["日常"]["enabled"]) == (bgm["id"], False)
    assert client.post(base, json={"kind": "bgm", "label": "日常"}).status_code == 409
    assert client.get(PACKS).json()[0]["bgm_count"] == 1

    client.put(f"{base}/{bg['id']}", json={"enabled": False, "focus_x": 20})
    back = client.put(f"{base}/{bg['id']}", json={"enabled": True}).json()
    assert (back["enabled"], back["focus_x"], back["bgm_id"]) == (True, 20, bgm["id"])


def test_upload_checks_format_by_kind_and_serves_cacheable_bytes(client: TestClient):
    pack = _pack(client)
    base = _assets(pack["id"])
    bg = client.post(base, json={"kind": "bg", "label": "食堂"}).json()
    bgm = client.post(base, json={"kind": "bgm", "label": "日常"}).json()

    # 背景只收图,音乐只收音频;都按文件头认
    assert client.put(f"{base}/{bg['id']}/file", files={"file": ("a.mp3", MP3, "audio/mpeg")}).status_code == 400
    assert client.put(f"{base}/{bgm['id']}/file", files={"file": ("a.png", PNG, "image/png")}).status_code == 400
    assert (
        client.put(
            f"{base}/{bgm['id']}/file", files={"file": ("a.mp3", b"<html></html>", "audio/mpeg")}
        ).status_code
        == 400
    )

    up = client.put(f"{base}/{bgm['id']}/file", files={"file": ("x.bin", MP3, "text/plain")})
    assert up.status_code == 200
    assert (up.json()["has_file"], up.json()["mime"], up.json()["size"]) == (True, "audio/mpeg", len(MP3))

    got = client.get(f"{base}/{bgm['id']}/file")
    assert got.content == MP3
    assert got.headers["content-type"] == "audio/mpeg"
    assert got.headers["x-content-type-options"] == "nosniff"
    assert "immutable" in got.headers["cache-control"]

    # 没传文件的 404;换一个包的路径取同一个 id 也 404
    assert client.get(f"{base}/{bg['id']}/file").status_code == 404
    other = _pack(client, "别的包")
    assert client.get(f"{_assets(other['id'])}/{bgm['id']}/file").status_code == 404


def test_audio_sniffing_recognises_common_formats():
    from app.api.scenes import sniff_audio_mime

    assert sniff_audio_mime(b"\xff\xfb\x90\x00") == "audio/mpeg"
    assert sniff_audio_mime(b"\xff\xf1\x50\x80") == "audio/aac"
    assert sniff_audio_mime(b"\x00\x00\x00\x20ftypM4A ") == "audio/mp4"
    assert sniff_audio_mime(b"OggS\x00\x02") == "audio/ogg"
    assert sniff_audio_mime(b"RIFF\x00\x00\x00\x00WAVEfmt ") == "audio/wav"
    assert sniff_audio_mime(b"fLaC\x00\x00") == "audio/flac"
    assert sniff_audio_mime(b"<html>") is None


def test_reorder_is_per_kind(client: TestClient):
    pack = _pack(client)
    base = _assets(pack["id"])
    a = client.post(base, json={"kind": "bg", "label": "a"}).json()
    b = client.post(base, json={"kind": "bg", "label": "b"}).json()
    m = client.post(base, json={"kind": "bgm", "label": "m"}).json()

    # 混进另一类的 id、或者少一个,都拒绝
    assert client.post(f"{base}/reorder", json={"kind": "bg", "ids": [b["id"], a["id"], m["id"]]}).status_code == 400
    assert client.post(f"{base}/reorder", json={"kind": "bg", "ids": [b["id"]]}).status_code == 400

    assert client.post(f"{base}/reorder", json={"kind": "bg", "ids": [b["id"], a["id"]]}).status_code == 200
    assert [x["label"] for x in client.get(base).json() if x["kind"] == "bg"] == ["b", "a"]


def test_card_binding_lifecycle(client: TestClient, make_card):
    pack = _pack(client)
    card = make_card()

    assert client.get(_binding(card["id"])).json() == {"card_id": card["id"], "pack_id": None}
    assert client.put(_binding(card["id"]), json={"pack_id": "nope"}).status_code == 404
    assert client.put(_binding("nope"), json={"pack_id": pack["id"]}).status_code == 404

    client.put(_binding(card["id"]), json={"pack_id": pack["id"]})
    assert client.get(_binding(card["id"])).json()["pack_id"] == pack["id"]

    # 复制卡:副本绑同一个包(包是共用的,不复制)
    copy = client.post(f"/api/tavern/cards/{card['id']}/duplicate", json={}).json()
    assert client.get(_binding(copy["id"])).json()["pack_id"] == pack["id"]
    assert len(client.get(PACKS).json()) == 1

    # 删卡只删绑定,包还在
    client.delete(f"/api/tavern/cards/{card['id']}")
    assert client.get(PACKS).json()[0]["card_count"] == 1

    # 解绑
    client.put(_binding(copy["id"]), json={"pack_id": None})
    assert client.get(_binding(copy["id"])).json()["pack_id"] is None


def test_deleting_pack_removes_assets_and_bindings(client: TestClient, make_card):
    pack = _pack(client)
    base = _assets(pack["id"])
    bg = client.post(base, json={"kind": "bg", "label": "食堂"}).json()
    client.put(f"{base}/{bg['id']}/file", files={"file": ("a.png", PNG, "image/png")})
    card = make_card()
    client.put(_binding(card["id"]), json={"pack_id": pack["id"]})

    assert client.delete(f"{PACKS}/{pack['id']}").status_code == 204
    assert client.get(base).status_code == 404
    assert client.get(_binding(card["id"])).json()["pack_id"] is None
    # 重新建一个同名包不会撞上残留的素材
    again = _pack(client)
    assert client.get(_assets(again["id"])).json() == []


def test_background_file_serves_a_shrunk_copy_but_audio_ignores_width(client: TestClient):
    import cv2
    import numpy as np

    pack = _pack(client)
    base = _assets(pack["id"])
    bg = client.post(base, json={"kind": "bg", "label": "食堂"}).json()
    bgm = client.post(base, json={"kind": "bgm", "label": "日常"}).json()
    jpg = cv2.imencode(".jpg", np.full((180, 320, 3), 90, np.uint8))[1].tobytes()
    client.put(f"{base}/{bg['id']}/file", files={"file": ("a.jpg", jpg, "image/jpeg")})
    client.put(f"{base}/{bgm['id']}/file", files={"file": ("a.mp3", MP3, "audio/mpeg")})

    small = client.get(f"{base}/{bg['id']}/file?w=64")
    assert small.headers["content-type"] == "image/webp"
    img = cv2.imdecode(np.frombuffer(small.content, np.uint8), cv2.IMREAD_UNCHANGED)
    assert img.shape[:2] == (36, 64)
    assert client.get(f"{base}/{bgm['id']}/file?w=64").content == MP3
