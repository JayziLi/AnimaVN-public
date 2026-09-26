import io
import json
import zipfile

from fastapi.testclient import TestClient


def test_chat_creation_freezes_card_and_preset_names(
    client: TestClient, make_card, make_preset, make_debug_chat
):
    card = make_card(name="角色名")
    preset = make_preset(name="预设名")

    chat = make_debug_chat(card_id=card["id"], preset_id=preset["id"])

    assert chat["card_name"] == "角色名"
    assert chat["preset_name"] == "预设名"
    assert chat["message_count"] == 0


def test_chat_creation_rejects_unknown_card(client: TestClient):
    response = client.post(
        "/api/debug/chats",
        json={"name": "坏对话", "card_id": "missing", "user_name": "玩家"},
    )

    assert response.status_code == 404


def test_chat_bindings_can_be_changed_cleared_and_filtered(
    client: TestClient, make_card, make_preset, make_debug_chat
):
    first_card = make_card(name="甲")
    second_card = make_card(name="乙")
    preset = make_preset(name="新预设")
    chat = make_debug_chat(card_id=first_card["id"])

    updated = client.put(
        f"/api/debug/chats/{chat['id']}",
        json={
            "card_id": second_card["id"],
            "preset_id": preset["id"],
            "user_name": "新玩家",
            "tainted": True,
        },
    )

    assert updated.status_code == 200
    assert updated.json()["card_name"] == "乙"
    assert updated.json()["preset_name"] == "新预设"
    assert updated.json()["user_name"] == "新玩家"
    assert updated.json()["tainted"] is True
    assert [item["id"] for item in client.get(
        "/api/debug/chats", params={"card_id": second_card["id"]}
    ).json()] == [chat["id"]]
    assert client.get(
        "/api/debug/chats", params={"card_id": first_card["id"]}
    ).json() == []

    cleared = client.put(
        f"/api/debug/chats/{chat['id']}", json={"card_id": None, "preset_id": None}
    )
    assert cleared.status_code == 200
    assert cleared.json()["card_id"] is None
    assert cleared.json()["preset_id"] is None
    assert cleared.json()["card_name"] == ""
    assert cleared.json()["preset_name"] == ""


def test_chat_update_rejects_unknown_card_and_preset(client: TestClient, make_debug_chat):
    chat = make_debug_chat()

    card = client.put(f"/api/debug/chats/{chat['id']}", json={"card_id": "missing"})
    preset = client.put(
        f"/api/debug/chats/{chat['id']}", json={"preset_id": "missing"}
    )

    assert card.status_code == 404
    assert preset.status_code == 404


def test_message_upsert_is_visible_in_index_order(
    client: TestClient, make_debug_chat, put_debug_message
):
    chat = make_debug_chat()
    put_debug_message(chat["id"], "later", idx=10, swipes=["后写但序号大"])
    put_debug_message(chat["id"], "earlier", idx=2, swipes=["后写但序号小"])

    loaded = client.get(f"/api/debug/chats/{chat['id']}")

    assert loaded.status_code == 200
    assert [message["id"] for message in loaded.json()["messages"]] == ["earlier", "later"]
    assert loaded.json()["message_count"] == 2


def test_upsert_updates_existing_message_instead_of_duplicating_it(
    client: TestClient, make_debug_chat, put_debug_message
):
    chat = make_debug_chat()
    first = put_debug_message(chat["id"], "same-id", swipes=["旧内容"])
    second = put_debug_message(
        chat["id"], "same-id", role="assistant", swipes=["新内容", "另一个 swipe"], swipe_id=1
    )

    assert first.status_code == 200
    assert second.status_code == 200
    loaded = client.get(f"/api/debug/chats/{chat['id']}").json()
    assert loaded["message_count"] == 1
    assert loaded["messages"][0]["role"] == "assistant"
    assert loaded["messages"][0]["swipe_id"] == 1
    assert loaded["messages"][0]["swipes"] == ["新内容", "另一个 swipe"]


def test_same_message_id_cannot_belong_to_two_chats(
    client: TestClient, make_debug_chat, put_debug_message
):
    first = make_debug_chat(name="甲")
    second = make_debug_chat(name="乙")
    assert put_debug_message(first["id"], "shared-id").status_code == 200

    conflict = put_debug_message(second["id"], "shared-id")

    assert conflict.status_code == 409


def test_prompt_snapshot_is_extracted_and_loaded_lazily(
    client: TestClient, make_debug_chat, put_debug_message
):
    chat = make_debug_chat()
    snapshot = {"messages": [{"role": "system", "content": "完整提示词"}], "tokens": 12}

    response = put_debug_message(
        chat["id"],
        "with-snapshot",
        role="assistant",
        swipes=["回复"],
        swipe_info=[
            {
                "model": "mock",
                "snapshotHash": "abc123",
                "snapshot": snapshot,
            }
        ],
    )

    assert response.status_code == 200
    info = response.json()["swipe_info"][0]
    assert info["snapshotHash"] == "abc123"
    assert "snapshot" not in info
    fetched = client.get("/api/debug/snapshots/abc123")
    assert fetched.status_code == 200
    assert fetched.json() == snapshot


def test_reusing_snapshot_hash_keeps_original_content(
    client: TestClient, make_debug_chat, put_debug_message
):
    chat = make_debug_chat()
    put_debug_message(
        chat["id"],
        "one",
        swipe_info=[{"snapshotHash": "same-hash", "snapshot": {"version": 1}}],
    )
    put_debug_message(
        chat["id"],
        "two",
        idx=1,
        swipe_info=[{"snapshotHash": "same-hash", "snapshot": {"version": 2}}],
    )

    fetched = client.get("/api/debug/snapshots/same-hash")

    assert fetched.status_code == 200
    assert fetched.json() == {"version": 1}


def test_missing_snapshot_returns_not_found(client: TestClient):
    assert client.get("/api/debug/snapshots/missing").status_code == 404


def test_chat_list_preview_uses_selected_swipe_and_flattens_whitespace(
    client: TestClient, make_debug_chat, put_debug_message
):
    chat = make_debug_chat()
    put_debug_message(
        chat["id"],
        "assistant",
        role="assistant",
        swipes=["错误分支", "  当前\n\n  分支   内容  "],
        swipe_id=1,
    )

    listed = client.get("/api/debug/chats").json()

    assert listed[0]["last_message"] == "当前 分支 内容"
    assert listed[0]["message_count"] == 1


def test_chat_list_preview_is_bounded(client: TestClient, make_debug_chat, put_debug_message):
    chat = make_debug_chat()
    put_debug_message(chat["id"], "long", swipes=["长" * 200])

    preview = client.get("/api/debug/chats").json()[0]["last_message"]

    assert len(preview) == 161
    assert preview.endswith("…")


def test_deleting_message_is_idempotent_and_updates_public_history(
    client: TestClient, make_debug_chat, put_debug_message
):
    chat = make_debug_chat()
    put_debug_message(chat["id"], "gone")

    first = client.delete(f"/api/debug/chats/{chat['id']}/messages/gone")
    second = client.delete(f"/api/debug/chats/{chat['id']}/messages/gone")

    assert first.status_code == 204
    assert second.status_code == 204
    assert client.get(f"/api/debug/chats/{chat['id']}").json()["messages"] == []


def test_branch_copies_only_prefix_and_uses_independent_message_ids(
    client: TestClient, make_debug_chat, put_debug_message
):
    parent = make_debug_chat(name="主聊天")
    for idx, message_id in enumerate(("m0", "m1", "m2")):
        put_debug_message(parent["id"], message_id, idx=idx, swipes=[f"消息 {idx}"])

    response = client.post(
        f"/api/debug/chats/{parent['id']}/branch", json={"message_id": "m1"}
    )

    assert response.status_code == 200
    branch = response.json()
    assert branch["parent_chat_id"] == parent["id"]
    assert branch["parent_message_id"] == "m1"
    assert branch["name"] == "主聊天 - Branch #1"
    loaded = client.get(f"/api/debug/chats/{branch['id']}").json()
    assert [m["swipes"][0] for m in loaded["messages"]] == ["消息 0", "消息 1"]
    assert not {m["id"] for m in loaded["messages"]} & {"m0", "m1", "m2"}


def test_branch_message_count_reports_actual_rows_for_sparse_indices(
    client: TestClient, make_debug_chat, put_debug_message
):
    parent = make_debug_chat(name="稀疏序号")
    put_debug_message(parent["id"], "m10", idx=10, swipes=["唯一消息"])

    response = client.post(
        f"/api/debug/chats/{parent['id']}/branch", json={"message_id": "m10"}
    )

    assert response.status_code == 200
    assert response.json()["message_count"] == 1


def test_branch_rejects_message_from_another_chat(
    client: TestClient, make_debug_chat, put_debug_message
):
    first = make_debug_chat(name="甲")
    second = make_debug_chat(name="乙")
    put_debug_message(second["id"], "foreign")

    response = client.post(
        f"/api/debug/chats/{first['id']}/branch", json={"message_id": "foreign"}
    )

    assert response.status_code == 404


def test_deleting_parent_promotes_child_to_root(
    client: TestClient, make_debug_chat, put_debug_message
):
    parent = make_debug_chat(name="主聊天")
    put_debug_message(parent["id"], "fork-here")
    child = client.post(
        f"/api/debug/chats/{parent['id']}/branch", json={"message_id": "fork-here"}
    ).json()

    deleted = client.delete(f"/api/debug/chats/{parent['id']}")
    loaded_child = client.get(f"/api/debug/chats/{child['id']}")

    assert deleted.status_code == 204
    assert loaded_child.status_code == 200
    assert loaded_child.json()["parent_chat_id"] is None
    assert loaded_child.json()["parent_message_id"] is None


def test_single_chat_export_is_valid_sillytavern_jsonl(
    client: TestClient, make_card, make_debug_chat, put_debug_message
):
    card = make_card(name="Anima")
    chat = make_debug_chat(name="导出/测试", card_id=card["id"])
    put_debug_message(chat["id"], "u", role="user", swipes=["你好"])
    put_debug_message(
        chat["id"],
        "a",
        idx=1,
        role="assistant",
        swipes=["回复 A", "回复 B"],
        swipe_id=1,
        swipe_info=[{}, {"model": "mock", "reasoning": "思考"}],
    )

    response = client.get(f"/api/debug/chats/{chat['id']}/export")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/jsonl")
    rows = [json.loads(line) for line in response.text.splitlines()]
    assert rows[0]["character_name"] == "Anima"
    assert rows[1]["is_user"] is True
    assert rows[2]["mes"] == "回复 B"
    assert rows[2]["swipes"] == ["回复 A", "回复 B"]
    assert rows[2]["extra"]["reasoning"] == "思考"


def test_tree_export_contains_root_and_descendant_files(
    client: TestClient, make_debug_chat, put_debug_message
):
    parent = make_debug_chat(name="Root")
    put_debug_message(parent["id"], "fork")
    child = client.post(
        f"/api/debug/chats/{parent['id']}/branch", json={"message_id": "fork"}
    ).json()

    response = client.get(f"/api/debug/chats/{child['id']}/export", params={"tree": "true"})

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/zip")
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert sorted(archive.namelist()) == ["Root - Branch #1.jsonl", "Root.jsonl"]


def test_jsonl_import_matches_existing_card_and_tolerates_orphan_card(
    client: TestClient, make_card
):
    matching = make_card(name="Known")
    known = (
        '{"user_name":"玩家","character_name":"Known","chat_metadata":{"tainted":true}}\n'
        '{"is_user":true,"mes":"你好","send_date":"2026-01-01T00:00:00.000Z"}\n'
    )
    orphan = (
        '{"user_name":"User","character_name":"Missing","chat_metadata":{}}\n'
        '{"is_user":false,"mes":"回复"}\n'
    )

    response = client.post(
        "/api/debug/chats/import",
        files=[
            ("files", ("known.jsonl", known.encode(), "application/jsonl")),
            ("files", ("orphan.jsonl", orphan.encode(), "application/jsonl")),
        ],
    )

    assert response.status_code == 200
    by_name = {chat["name"]: chat for chat in response.json()}
    assert by_name["known"]["card_id"] == matching["id"]
    assert by_name["known"]["tainted"] is True
    assert by_name["orphan"]["card_id"] is None
    assert by_name["orphan"]["card_name"] == "Missing"
    known_detail = client.get(f"/api/debug/chats/{by_name['known']['id']}").json()
    assert known_detail["messages"][0]["swipes"] == ["你好"]


def test_jsonl_import_rebuilds_parent_and_branch_point_from_multiple_files(
    client: TestClient,
):
    root = (
        '{"user_name":"User","character_name":"Anima","chat_metadata":{}}\n'
        '{"is_user":true,"mes":"分支点","extra":{"branches":["Child"]}}\n'
        '{"is_user":false,"mes":"主线回复"}\n'
    )
    child = (
        '{"user_name":"User","character_name":"Anima",'
        '"chat_metadata":{"main_chat":"Root"}}\n'
        '{"is_user":true,"mes":"分支点"}\n'
    )

    response = client.post(
        "/api/debug/chats/import",
        files=[
            ("files", ("Root.jsonl", root.encode(), "application/jsonl")),
            ("files", ("Child.jsonl", child.encode(), "application/jsonl")),
        ],
    )

    assert response.status_code == 200
    by_name = {chat["name"]: chat for chat in response.json()}
    root_detail = client.get(f"/api/debug/chats/{by_name['Root']['id']}").json()
    child_detail = client.get(f"/api/debug/chats/{by_name['Child']['id']}").json()
    assert child_detail["parent_chat_id"] == root_detail["id"]
    assert child_detail["parent_message_id"] == root_detail["messages"][0]["id"]
