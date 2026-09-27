from fastapi.testclient import TestClient

# 最小的合法 PNG 文件头就够了:后端只认文件头判断格式,不解码图片
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def _sprites(card_id: str) -> str:
    return f"/api/tavern/cards/{card_id}/sprites"


def test_sprite_crud_keeps_mapping_ordered_and_list_light(client: TestClient, make_card):
    card = make_card()
    base = _sprites(card["id"])

    a = client.post(base, json={"label": "平静", "description": "默认"}).json()
    b = client.post(base, json={"label": "微笑", "aliases": ["笑", "  ", "微笑"]}).json()

    assert (a["sort"], b["sort"]) == (0, 1)
    # 空白和与主名重复的别名被丢掉
    assert b["aliases"] == ["笑"]
    assert b["has_image"] is False

    updated = client.put(f"{base}/{b['id']}", json={"description": "开心时用"})
    assert updated.status_code == 200
    assert updated.json()["label"] == "微笑"
    assert updated.json()["aliases"] == ["笑"]

    listed = client.get(base).json()
    assert [s["label"] for s in listed] == ["平静", "微笑"]

    assert client.delete(f"{base}/{a['id']}").status_code == 204
    assert [s["label"] for s in client.get(base).json()] == ["微笑"]


def test_sprite_names_must_be_unique_across_labels_and_aliases(client: TestClient, make_card):
    card = make_card()
    base = _sprites(card["id"])
    client.post(base, json={"label": "微笑", "aliases": ["笑"]})

    assert client.post(base, json={"label": "笑"}).status_code == 409
    # 大小写不敏感
    client.post(base, json={"label": "Happy"})
    assert client.post(base, json={"label": "平静", "aliases": ["happy"]}).status_code == 409


def test_sprite_names_reject_template_breaking_characters(client: TestClient, make_card):
    card = make_card()
    base = _sprites(card["id"])

    assert client.post(base, json={"label": "  "}).status_code == 400
    assert client.post(base, json={"label": "开<心"}).status_code == 400
    assert client.post(base, json={"label": "开心】"}).status_code == 400


def test_image_upload_sniffs_format_and_serves_cacheable_bytes(client: TestClient, make_card):
    card = make_card()
    base = _sprites(card["id"])
    sprite = client.post(base, json={"label": "平静"}).json()

    # 声明成 png 的 HTML 会被拒:格式看文件头,不看客户端声明
    bad = client.put(
        f"{base}/{sprite['id']}/image",
        files={"file": ("x.png", b"<html><script>alert(1)</script>", "image/png")},
    )
    assert bad.status_code == 400

    ok = client.put(
        f"{base}/{sprite['id']}/image", files={"file": ("a.bin", PNG, "text/plain")}
    )
    assert ok.status_code == 200
    assert ok.json()["has_image"] is True

    img = client.get(f"{base}/{sprite['id']}/image")
    assert img.status_code == 200
    assert img.content == PNG
    assert img.headers["content-type"] == "image/png"
    assert img.headers["x-content-type-options"] == "nosniff"
    assert "immutable" in img.headers["cache-control"]

    # 列表里只有 has_image,不带图本身
    assert "AAAA" not in client.get(base).text


def test_image_endpoint_404s_without_image_or_for_other_cards(client: TestClient, make_card):
    card = make_card()
    other = make_card(name="别的卡")
    sprite = client.post(_sprites(card["id"]), json={"label": "平静"}).json()

    assert client.get(f"{_sprites(card['id'])}/{sprite['id']}/image").status_code == 404
    client.put(
        f"{_sprites(card['id'])}/{sprite['id']}/image", files={"file": ("a.png", PNG, "image/png")}
    )
    # 换一张卡的路径去取同一个 id,不能取到
    assert client.get(f"{_sprites(other['id'])}/{sprite['id']}/image").status_code == 404
    assert client.put(f"{_sprites(other['id'])}/{sprite['id']}", json={}).status_code == 404


def test_reorder_requires_exact_id_set(client: TestClient, make_card):
    card = make_card()
    base = _sprites(card["id"])
    a = client.post(base, json={"label": "a"}).json()
    b = client.post(base, json={"label": "b"}).json()

    assert client.post(f"{base}/reorder", json={"ids": [b["id"]]}).status_code == 400

    reordered = client.post(f"{base}/reorder", json={"ids": [b["id"], a["id"]]})
    assert reordered.status_code == 200
    assert [s["label"] for s in client.get(base).json()] == ["b", "a"]


def test_disabling_a_sprite_keeps_the_row_and_its_names(client: TestClient, make_card):
    card = make_card()
    base = _sprites(card["id"])
    sprite = client.post(base, json={"label": "平静", "aliases": ["normal"]}).json()
    assert sprite["enabled"] is True

    off = client.put(f"{base}/{sprite['id']}", json={"enabled": False})
    assert off.status_code == 200
    assert (off.json()["enabled"], off.json()["label"]) == (False, "平静")

    # 禁用不是删除:还在列表里,名字照样占着,改别的字段也不会把它打开
    client.put(f"{base}/{sprite['id']}", json={"description": "默认"})
    assert [(s["label"], s["enabled"]) for s in client.get(base).json()] == [("平静", False)]
    assert client.post(base, json={"label": "Normal"}).status_code == 409

    # 复制卡时禁用状态跟着走
    copy = client.post(f"/api/tavern/cards/{card['id']}/duplicate", json={}).json()
    assert [s["enabled"] for s in client.get(_sprites(copy["id"])).json()] == [False]

    assert client.put(f"{base}/{sprite['id']}", json={"enabled": True}).json()["enabled"] is True


def test_card_delete_removes_sprites_and_duplicate_copies_them(client: TestClient, make_card):
    card = make_card()
    base = _sprites(card["id"])
    sprite = client.post(base, json={"label": "平静", "aliases": ["normal"]}).json()
    client.put(f"{base}/{sprite['id']}/image", files={"file": ("a.png", PNG, "image/png")})

    copy = client.post(f"/api/tavern/cards/{card['id']}/duplicate", json={}).json()
    copied = client.get(_sprites(copy["id"])).json()
    assert [(s["label"], s["aliases"], s["has_image"]) for s in copied] == [
        ("平静", ["normal"], True)
    ]
    assert client.get(f"{_sprites(copy['id'])}/{copied[0]['id']}/image").content == PNG

    assert client.delete(f"/api/tavern/cards/{card['id']}").status_code == 204
    assert client.get(base).status_code == 404
    # 副本的立绘不受影响
    assert len(client.get(_sprites(copy["id"])).json()) == 1


def test_settings_round_trip_and_key_validation(client: TestClient):
    # 没存过:200 + null,由前端用默认值
    empty = client.get("/api/settings/plugin.sprite")
    assert empty.status_code == 200
    assert empty.json() == {"key": "plugin.sprite", "value": None}

    value = {"tagTemplate": "<sprite:{表情}>", "nested": [1, 2]}
    put = client.put("/api/settings/plugin.sprite", json={"value": value})
    assert put.status_code == 200
    assert client.get("/api/settings/plugin.sprite").json() == {
        "key": "plugin.sprite",
        "value": value,
    }

    client.put("/api/settings/plugin.sprite", json={"value": {"tagTemplate": "【{表情}】"}})
    assert client.get("/api/settings/plugin.sprite").json()["value"] == {"tagTemplate": "【{表情}】"}

    assert client.get("/api/settings/Bad Key").status_code == 400


def test_upload_records_the_face_and_scan_fills_sprites_that_missed_it(
    client: TestClient, make_card, monkeypatch
):
    from app.api import sprites as sprites_api
    from tests.test_sprite_faces import SYLVIE

    card = make_card()
    base = _sprites(card["id"])
    image = SYLVIE.read_bytes()

    first = client.post(base, json={"label": "平静"}).json()
    assert first["face_scan"] is None
    uploaded = client.put(f"{base}/{first['id']}/image", files={"file": ("a.png", image, "image/png")})
    scan = uploaded.json()["face_scan"]
    assert (scan["width"], scan["height"]) == (334, 700)
    assert scan["face"] is not None

    # 服务器上没装 OpenCV 时上传照样成功,只是先不记;装上之后由 scan-faces 补上
    monkeypatch.setattr(sprites_api, "scan", lambda data: None)
    second = client.post(base, json={"label": "微笑"}).json()
    missed = client.put(f"{base}/{second['id']}/image", files={"file": ("b.png", image, "image/png")})
    assert missed.status_code == 200
    assert missed.json()["face_scan"] is None
    monkeypatch.undo()

    scanned = client.post(f"{base}/scan-faces")
    assert scanned.status_code == 200
    by_label = {s["label"]: s for s in scanned.json()}
    assert by_label["微笑"]["face_scan"] == scan
    # 补识别不算改图:图的版本号不变,浏览器不用重新下载
    assert by_label["微笑"]["image_version"] == missed.json()["image_version"]


def test_scan_faces_reports_when_opencv_is_missing(client: TestClient, make_card, monkeypatch):
    from app.api import sprites as sprites_api

    card = make_card()
    monkeypatch.setattr(sprites_api, "scan", lambda data: None)
    base = _sprites(card["id"])
    sprite = client.post(base, json={"label": "平静"}).json()
    client.put(f"{base}/{sprite['id']}/image", files={"file": ("a.png", PNG, "image/png")})

    res = client.post(f"{base}/scan-faces")
    assert res.status_code == 503
    assert "OpenCV" in res.json()["detail"]


def test_sprite_layout_defaults_saves_and_follows_the_card(client: TestClient, make_card):
    card = make_card()
    base = _sprites(card["id"])
    default = {"auto": True, "zoom": 1.0, "dx": 0.0, "dy": 0.0}
    assert client.get(f"{base}/layout").json() == default

    saved = client.put(f"{base}/layout", json={"auto": False, "zoom": 1.25, "dx": -0.1})
    assert saved.status_code == 200
    assert saved.json() == {"auto": False, "zoom": 1.25, "dx": -0.1, "dy": 0.0}
    # 只传一项时其他的不动
    client.put(f"{base}/layout", json={"dy": 0.05})
    assert client.get(f"{base}/layout").json() == {"auto": False, "zoom": 1.25, "dx": -0.1, "dy": 0.05}

    assert client.put(f"{base}/layout", json={"zoom": 9}).status_code == 422
    assert client.put(f"{base}/layout", json={"dx": 5}).status_code == 422
    assert client.get(f"{_sprites('nope')}/layout").status_code == 404

    copy = client.post(f"/api/tavern/cards/{card['id']}/duplicate", json={}).json()
    assert client.get(f"{_sprites(copy['id'])}/layout").json()["zoom"] == 1.25

    assert client.delete(f"/api/tavern/cards/{card['id']}").status_code == 204
    assert client.get(f"{_sprites(copy['id'])}/layout").json()["dy"] == 0.05


def test_card_face_crops_the_default_sprite_and_revalidates(
    client: TestClient, make_card, monkeypatch
):
    from app.api import sprites as sprites_api
    from tests.test_sprite_faces import SYLVIE

    card = make_card()
    base = _sprites(card["id"])
    # 还没有带图的立绘:404,前端退回卡面头像
    assert client.get(f"{base}/face").status_code == 404
    assert client.get(f"{_sprites('nope')}/face").status_code == 404

    first = client.post(base, json={"label": "平静"}).json()
    second = client.post(base, json={"label": "微笑"}).json()
    for s in (first, second):
        client.put(f"{base}/{s['id']}/image", files={"file": ("a.png", SYLVIE.read_bytes(), "image/png")})

    res = client.get(f"{base}/face?size=64")
    assert res.status_code == 200
    assert res.headers["content-type"] == "image/webp"
    assert res.headers["cache-control"] == "private, no-cache"
    etag = res.headers["etag"]
    assert first["id"] in etag

    # 没变就回 304,不重新裁
    again = client.get(f"{base}/face?size=64", headers={"If-None-Match": etag})
    assert again.status_code == 304
    # 默认表情关掉了:换成下一张,ETag 跟着变
    client.put(f"{base}/{first['id']}", json={"enabled": False})
    switched = client.get(f"{base}/face?size=64", headers={"If-None-Match": etag})
    assert switched.status_code == 200
    assert second["id"] in switched.headers["etag"]

    assert client.get(f"{base}/face?size=8").status_code == 422
    assert client.get(f"{base}/face?size=4096").status_code == 422

    monkeypatch.setattr(sprites_api, "face_thumbnail", lambda data, face, size: None)
    missing = client.get(f"{base}/face?size=65")
    assert missing.status_code == 503


def test_image_endpoint_serves_a_shrunk_copy_on_request(client: TestClient, make_card):
    from tests.test_sprite_faces import SYLVIE

    card = make_card()
    base = _sprites(card["id"])
    sprite = client.post(base, json={"label": "平静"}).json()
    client.put(f"{base}/{sprite['id']}/image", files={"file": ("a.png", SYLVIE.read_bytes(), "image/png")})

    # ?w= 给取色、缩略图用:缩到这个宽度的 WebP,地址不同,缓存也分开
    small = client.get(f"{base}/{sprite['id']}/image?w=96")
    assert small.status_code == 200
    assert small.headers["content-type"] == "image/webp"
    assert "immutable" in small.headers["cache-control"]
    assert len(small.content) < len(SYLVIE.read_bytes())
    # 原图没那么宽:发原图
    assert client.get(f"{base}/{sprite['id']}/image?w=1000").content == SYLVIE.read_bytes()
    assert client.get(f"{base}/{sprite['id']}/image?w=4").status_code == 422
