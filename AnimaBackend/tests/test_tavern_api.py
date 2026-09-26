from fastapi.testclient import TestClient


def test_card_crud_round_trip_and_partial_update_preserve_unmentioned_fields(
    client: TestClient, make_card
):
    card = make_card(description="原描述", personality="原性格")

    updated = client.put(
        f"/api/tavern/cards/{card['id']}", json={"description": "新描述"}
    )

    assert updated.status_code == 200
    assert updated.json()["description"] == "新描述"
    assert updated.json()["personality"] == "原性格"
    assert client.get(f"/api/tavern/cards/{card['id']}").json() == updated.json()


def test_card_list_reports_avatar_without_embedding_it(client: TestClient, make_card):
    avatar = "data:image/png;base64,iVBORw0KGgo="
    card = make_card(avatar=avatar)

    listed = client.get("/api/tavern/cards")
    fetched_avatar = client.get(f"/api/tavern/cards/{card['id']}/avatar")

    assert listed.status_code == 200
    assert listed.json()[0]["has_avatar"] is True
    assert "avatar" not in listed.json()[0]
    assert avatar not in listed.text
    assert fetched_avatar.status_code == 200
    assert fetched_avatar.text == avatar
    assert fetched_avatar.headers["content-type"].startswith("text/plain")


def test_card_without_avatar_returns_not_found_for_avatar_endpoint(
    client: TestClient, make_card
):
    card = make_card()

    response = client.get(f"/api/tavern/cards/{card['id']}/avatar")

    assert response.status_code == 404


def test_duplicate_card_copies_all_prompt_material_and_accepts_custom_name(
    client: TestClient, make_card
):
    source = make_card(
        description="描述",
        alternate_greetings=["A", "B"],
        tags=["奇幻", "测试"],
        character_book={"entries": [{"keys": ["云端镇"], "content": "设定"}]},
        extensions={"depth_prompt": {"prompt": "深度提示"}},
        avatar="data:image/png;base64,AA==",
    )

    response = client.post(
        f"/api/tavern/cards/{source['id']}/duplicate", json={"name": "Anima Copy"}
    )

    assert response.status_code == 200
    copied = response.json()
    assert copied["id"] != source["id"]
    assert copied["name"] == "Anima Copy"
    for field in (
        "description",
        "alternate_greetings",
        "tags",
        "character_book",
        "extensions",
        "has_avatar",
    ):
        assert copied[field] == source[field]


def test_duplicate_card_uses_default_copy_name_for_blank_request(
    client: TestClient, make_card
):
    source = make_card(name="原卡")

    response = client.post(
        f"/api/tavern/cards/{source['id']}/duplicate", json={"name": "  "}
    )

    assert response.status_code == 200
    assert response.json()["name"] == "原卡 - 副本"


def test_deleting_card_keeps_chat_readable_with_frozen_card_name(
    client: TestClient, make_card, make_debug_chat
):
    card = make_card(name="不会消失的名字")
    chat = make_debug_chat(card_id=card["id"])

    deleted = client.delete(f"/api/tavern/cards/{card['id']}")
    loaded_chat = client.get(f"/api/debug/chats/{chat['id']}")

    assert deleted.status_code == 204
    assert loaded_chat.status_code == 200
    assert loaded_chat.json()["card_id"] is None
    assert loaded_chat.json()["card_name"] == "不会消失的名字"


def test_card_remembers_last_opened_chat(client: TestClient, make_card, make_debug_chat):
    card = make_card()
    chat = make_debug_chat(card_id=card["id"])

    assert card["last_chat_id"] is None

    updated = client.put(
        f"/api/tavern/cards/{card['id']}", json={"last_chat_id": chat["id"]}
    )

    assert updated.status_code == 200
    assert updated.json()["last_chat_id"] == chat["id"]
    assert client.get("/api/tavern/cards").json()[0]["last_chat_id"] == chat["id"]


def test_editing_a_card_leaves_its_last_chat_pointer_alone(
    client: TestClient, make_card, make_debug_chat
):
    """自动保存发的是整张卡的正文字段,不该顺手把书签冲掉。"""
    card = make_card()
    chat = make_debug_chat(card_id=card["id"])
    client.put(f"/api/tavern/cards/{card['id']}", json={"last_chat_id": chat["id"]})

    edited = client.put(f"/api/tavern/cards/{card['id']}", json={"description": "改过的描述"})

    assert edited.status_code == 200
    assert edited.json()["last_chat_id"] == chat["id"]


def test_last_chat_pointer_can_be_cleared_explicitly(
    client: TestClient, make_card, make_debug_chat
):
    card = make_card()
    chat = make_debug_chat(card_id=card["id"])
    client.put(f"/api/tavern/cards/{card['id']}", json={"last_chat_id": chat["id"]})

    cleared = client.put(f"/api/tavern/cards/{card['id']}", json={"last_chat_id": None})

    assert cleared.status_code == 200
    assert cleared.json()["last_chat_id"] is None


def test_deleting_a_chat_clears_it_from_the_cards_that_pointed_at_it(
    client: TestClient, make_card, make_debug_chat
):
    card = make_card()
    chat = make_debug_chat(card_id=card["id"])
    client.put(f"/api/tavern/cards/{card['id']}", json={"last_chat_id": chat["id"]})

    deleted = client.delete(f"/api/debug/chats/{chat['id']}")

    assert deleted.status_code == 204
    assert client.get(f"/api/tavern/cards/{card['id']}").json()["last_chat_id"] is None


def test_duplicated_card_does_not_inherit_the_last_chat_pointer(
    client: TestClient, make_card, make_debug_chat
):
    """副本一条对话都没有,继承书签会让它一进去就打开原卡的对话。"""
    source = make_card()
    chat = make_debug_chat(card_id=source["id"])
    client.put(f"/api/tavern/cards/{source['id']}", json={"last_chat_id": chat["id"]})

    copied = client.post(f"/api/tavern/cards/{source['id']}/duplicate", json={"name": "副本"})

    assert copied.status_code == 200
    assert copied.json()["last_chat_id"] is None


def test_missing_card_operations_return_not_found(client: TestClient):
    assert client.get("/api/tavern/cards/missing").status_code == 404
    assert client.put("/api/tavern/cards/missing", json={"name": "x"}).status_code == 404
    assert client.delete("/api/tavern/cards/missing").status_code == 404


def test_preset_crud_round_trip_and_partial_update_preserve_content(
    client: TestClient, make_preset
):
    preset = make_preset(name="旧名")

    updated = client.put(
        f"/api/tavern/presets/{preset['id']}", json={"name": "新名"}
    )

    assert updated.status_code == 200
    assert updated.json()["name"] == "新名"
    assert updated.json()["prompts"] == preset["prompts"]
    assert updated.json()["params"] == {"temperature": 0.8}


def test_blank_preset_name_is_rejected_on_create_and_update(
    client: TestClient, make_preset
):
    create = client.post("/api/tavern/presets", json={"name": "   "})
    preset = make_preset()
    update = client.put(f"/api/tavern/presets/{preset['id']}", json={"name": ""})

    assert create.status_code == 400
    assert update.status_code == 400


def test_creating_preset_with_duplicate_name_gets_suffixed(
    client: TestClient, make_preset
):
    make_preset(name="撞名预设")

    response = client.post(
        "/api/tavern/presets",
        json={"name": "撞名预设", "prompts": [], "prompt_order": []},
    )
    third = client.post(
        "/api/tavern/presets",
        json={"name": "撞名预设", "prompts": [], "prompt_order": []},
    )

    assert response.status_code == 200
    assert response.json()["name"] == "撞名预设 (2)"
    assert third.status_code == 200
    assert third.json()["name"] == "撞名预设 (3)"


def test_renaming_preset_to_duplicate_name_gets_suffixed(
    client: TestClient, make_preset
):
    make_preset(name="已存在")
    other = make_preset(name="待重命名")

    renamed = client.put(
        f"/api/tavern/presets/{other['id']}", json={"name": "已存在"}
    )

    assert renamed.status_code == 200
    assert renamed.json()["name"] == "已存在 (2)"


def test_duplicate_preset_copies_configuration_but_has_independent_identity(
    client: TestClient, make_preset
):
    source = make_preset(squash_system_messages=True)

    response = client.post(
        f"/api/tavern/presets/{source['id']}/duplicate", json={}
    )

    assert response.status_code == 200
    copied = response.json()
    assert copied["id"] != source["id"]
    assert copied["name"] == "默认预设 - 副本"
    for field in (
        "prompts",
        "prompt_order",
        "formats",
        "params",
        "squash_system_messages",
    ):
        assert copied[field] == source[field]


def test_deleting_preset_keeps_chat_readable_with_frozen_preset_name(
    client: TestClient, make_preset, make_debug_chat
):
    preset = make_preset(name="历史预设")
    chat = make_debug_chat(preset_id=preset["id"])

    deleted = client.delete(f"/api/tavern/presets/{preset['id']}")
    loaded_chat = client.get(f"/api/debug/chats/{chat['id']}")

    assert deleted.status_code == 204
    assert loaded_chat.status_code == 200
    assert loaded_chat.json()["preset_id"] is None
    assert loaded_chat.json()["preset_name"] == "历史预设"
