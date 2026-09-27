from fastapi.testclient import TestClient


def test_first_connection_is_active_and_activation_is_exclusive(
    client: TestClient, make_connection
):
    first = make_connection(name="第一条")
    second = make_connection(name="第二条")

    assert first["is_active"] is True
    assert second["is_active"] is False

    activated = client.post(f"/api/connections/{second['id']}/activate")
    listed = client.get("/api/connections").json()

    assert activated.status_code == 200
    assert activated.json()["is_active"] is True
    assert [item["name"] for item in listed if item["is_active"]] == ["第二条"]


def test_connection_never_exposes_key_and_omitted_update_preserves_it(
    client: TestClient, make_connection
):
    connection = make_connection(api_key="top-secret")

    updated = client.put(
        f"/api/connections/{connection['id']}", json={"name": "改名后"}
    )

    assert updated.status_code == 200
    assert updated.json()["has_api_key"] is True
    assert "api_key" not in updated.json()
    assert "top-secret" not in updated.text


def test_connection_key_can_be_explicitly_cleared(client: TestClient, make_connection):
    connection = make_connection(api_key="top-secret")

    updated = client.put(
        f"/api/connections/{connection['id']}", json={"api_key": ""}
    )

    assert updated.status_code == 200
    assert updated.json()["has_api_key"] is False


def test_connection_thinking_defaults_to_the_service_and_can_be_set_and_cleared(
    client: TestClient, make_connection
):
    connection = make_connection()
    url = f"/api/connections/{connection['id']}"

    low = client.put(url, json={"thinking": "low"})
    renamed = client.put(url, json={"name": "改名"})
    cleared = client.put(url, json={"thinking": None})

    assert connection["thinking"] is None
    assert low.json()["thinking"] == "low"
    assert renamed.json()["thinking"] == "low"
    assert cleared.json()["thinking"] is None
    assert make_connection(thinking="off")["thinking"] == "off"


def test_connection_thinking_rejects_unknown_levels(client: TestClient, make_connection):
    connection = make_connection()

    response = client.put(f"/api/connections/{connection['id']}", json={"thinking": "medium"})

    assert response.status_code == 422


def test_deleting_active_connection_promotes_remaining_connection(
    client: TestClient, make_connection
):
    active = make_connection(name="活动连接")
    remaining = make_connection(name="备用连接")

    response = client.delete(f"/api/connections/{active['id']}")

    assert response.status_code == 204
    listed = client.get("/api/connections").json()
    assert len(listed) == 1
    assert listed[0]["id"] == remaining["id"]
    assert listed[0]["is_active"] is True


def test_mock_connection_public_diagnostics_work_without_network(
    client: TestClient, make_connection
):
    connection = make_connection()

    ping = client.post(f"/api/connections/{connection['id']}/ping")
    models = client.post(f"/api/connections/{connection['id']}/refresh-models")
    message = client.post(
        f"/api/connections/{connection['id']}/test-message",
        json={"content": "连接测试"},
    )

    assert ping.status_code == 200
    assert "1 个可用模型" in ping.json()["message"]
    assert models.json() == ["mock"]
    assert "连接测试" in message.json()["reply"]
    refreshed = client.get("/api/connections").json()[0]
    assert refreshed["cached_models"] == ["mock"]
    assert refreshed["cached_models_at"] is not None


def test_missing_connection_diagnostics_return_not_found(client: TestClient):
    assert client.post("/api/connections/missing/ping").status_code == 404
    assert client.post("/api/connections/missing/refresh-models").status_code == 404


def test_first_persona_is_active_and_names_are_trimmed(client: TestClient):
    response = client.post(
        "/api/personas", json={"name": "  玩家  ", "description": "谨慎"}
    )

    assert response.status_code == 200
    assert response.json()["name"] == "玩家"
    assert response.json()["is_active"] is True


def test_persona_activation_is_exclusive(client: TestClient):
    first = client.post("/api/personas", json={"name": "甲"}).json()
    second = client.post("/api/personas", json={"name": "乙"}).json()

    activated = client.put(f"/api/personas/{second['id']}/activate")
    listed = client.get("/api/personas").json()

    assert activated.status_code == 200
    assert [item["name"] for item in listed if item["is_active"]] == ["乙"]
    assert next(item for item in listed if item["id"] == first["id"])["is_active"] is False


def test_deleting_active_persona_leaves_no_implicit_replacement(client: TestClient):
    active = client.post("/api/personas", json={"name": "甲"}).json()
    client.post("/api/personas", json={"name": "乙"})

    response = client.delete(f"/api/personas/{active['id']}")

    assert response.status_code == 204
    assert all(not item["is_active"] for item in client.get("/api/personas").json())


def test_persona_update_can_clear_avatar_without_clearing_other_fields(client: TestClient):
    persona = client.post(
        "/api/personas",
        json={"name": "玩家", "description": "原描述", "avatar": "data:image/png;base64,AA=="},
    ).json()

    response = client.patch(f"/api/personas/{persona['id']}", json={"avatar": None})

    assert response.status_code == 200
    assert response.json()["avatar"] is None
    assert response.json()["description"] == "原描述"


def test_blank_persona_name_is_rejected_on_create_and_update(client: TestClient):
    create = client.post("/api/personas", json={"name": "   "})
    persona = client.post("/api/personas", json={"name": "有效"}).json()
    update = client.patch(f"/api/personas/{persona['id']}", json={"name": "\t"})

    assert create.status_code == 400
    assert update.status_code == 400
