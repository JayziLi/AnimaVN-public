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
