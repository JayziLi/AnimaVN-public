"""Shared fixtures for backend behavior tests.

The application object is real, while its database dependency is replaced with
an isolated in-memory SQLite database.  TestClient is deliberately not used as
a context manager: doing so would run the production lifespan and seed the real
database configured in app.config.
"""

import json
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base, get_db
from app.main import app


@pytest.fixture(autouse=True)
def emotion_model_missing(tmp_path_factory, monkeypatch):
    """情绪识别模型默认当作没装:测试结果不能取决于本机有没有下载模型。
    要测匹配的测试自己换一个假 matcher(或者把目录指回真模型)"""
    from app.config import settings
    from app.emotion import service

    monkeypatch.setattr(settings, "emotion_model_dir", str(tmp_path_factory.mktemp("no-emotion-model")))
    service.reset()
    yield
    service.reset()


@pytest.fixture
def client() -> Iterator[TestClient]:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    testing_session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    Base.metadata.create_all(bind=engine)

    def override_get_db() -> Iterator[Session]:
        db = testing_session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    test_client = TestClient(app)
    try:
        yield test_client
    finally:
        test_client.close()
        app.dependency_overrides.clear()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


@pytest.fixture
def make_connection(client: TestClient):
    def create(**overrides):
        payload = {
            "name": "离线 Mock",
            "api_type": "mock",
            "base_url": None,
            "api_key": None,
            "model": "mock",
            "stream": True,
        }
        payload.update(overrides)
        response = client.post("/api/connections", json=payload)
        assert response.status_code == 200
        return response.json()

    return create


@pytest.fixture
def make_card(client: TestClient):
    def create(**overrides):
        payload = {
            "name": "Anima",
            "description": "数据人格",
            "personality": "好奇",
            "scenario": "调试室",
            "first_mes": "你好",
            "mes_example": "",
            "system_prompt": "",
            "post_history_instructions": "",
            "creator_notes": "测试卡",
            "alternate_greetings": ["欢迎回来"],
            "tags": ["测试"],
            "creator": "AnimaVN",
            "character_version": "1.0",
            "character_book": None,
            "extensions": {},
            "spec": "chara_card_v2",
            "avatar": None,
        }
        payload.update(overrides)
        response = client.post("/api/tavern/cards", json=payload)
        assert response.status_code == 200
        return response.json()

    return create


@pytest.fixture
def make_preset(client: TestClient):
    def create(**overrides):
        payload = {
            "name": "默认预设",
            "prompts": [{"identifier": "main", "content": "保持角色"}],
            "prompt_order": [{"order": [{"identifier": "main", "enabled": True}]}],
            "formats": {"scenario_format": "场景：{{scenario}}"},
            "params": {"temperature": 0.8},
            "squash_system_messages": False,
        }
        payload.update(overrides)
        response = client.post("/api/tavern/presets", json=payload)
        assert response.status_code == 200
        return response.json()

    return create


@pytest.fixture
def make_debug_chat(client: TestClient):
    def create(**overrides):
        payload = {
            "name": "测试对话",
            "card_id": None,
            "preset_id": None,
            "user_name": "玩家",
        }
        payload.update(overrides)
        response = client.post("/api/debug/chats", json=payload)
        assert response.status_code == 200
        return response.json()

    return create


@pytest.fixture
def put_debug_message(client: TestClient):
    def put(chat_id: str, message_id: str, **overrides):
        payload = {
            "id": message_id,
            "idx": 0,
            "role": "user",
            "swipes": ["你好"],
            "swipe_id": 0,
            "swipe_info": [{}],
        }
        payload.update(overrides)
        response = client.put(
            f"/api/debug/chats/{chat_id}/messages/{message_id}", json=payload
        )
        return response

    return put


class FakeGsv:
    """假装是 GPT-SoVITS api_v2(只有 AnimaVN 用到的三个接口,外加测试连接用的 /docs)。

    记下收到的每个请求。把 *_reply 设成 httpx.Response 就原样回它;设成异常就抛出,
    模拟连不上、超时。正常时 /tts 回 b"RIFF" + 文本,方便断言。
    """

    def __init__(self):
        self.calls: list[tuple[str, Any]] = []
        self.timeouts: list[float] = []
        self.tts_reply: httpx.Response | Exception | None = None
        self.weights_reply: httpx.Response | Exception | None = None
        self.docs_reply: httpx.Response | Exception | None = None

    @staticmethod
    def _reply(override: httpx.Response | Exception | None, default: httpx.Response) -> httpx.Response:
        if isinstance(override, Exception):
            raise override
        return override if override is not None else default

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path in ("/set_gpt_weights", "/set_sovits_weights"):
            self.calls.append((path.strip("/"), request.url.params["weights_path"]))
            return self._reply(self.weights_reply, httpx.Response(200, json={"message": "success"}))
        if path == "/tts":
            body = json.loads(request.content)
            self.calls.append(("tts", body))
            ok = httpx.Response(
                200, headers={"content-type": "audio/wav"}, content=b"RIFF" + body["text"].encode()
            )
            return self._reply(self.tts_reply, ok)
        if path == "/docs":
            self.calls.append(("docs", None))
            return self._reply(self.docs_reply, httpx.Response(200, text="docs"))
        return httpx.Response(404)

    def names(self) -> list[str]:
        return [name for name, _ in self.calls]


@pytest.fixture
def gsv(monkeypatch) -> Iterator[FakeGsv]:
    # 引擎实例按连接 id 全局缓存,前后都清掉,免得上一个测试记住的权重漏过来
    from app.tts.registry import reset_engines

    fake = FakeGsv()

    def make(base_url: str, timeout: float) -> httpx.AsyncClient:
        fake.timeouts.append(timeout)
        return httpx.AsyncClient(transport=httpx.MockTransport(fake.handler))

    monkeypatch.setattr("app.tts.gpt_sovits.make_tts_client", make)
    reset_engines()
    yield fake
    reset_engines()


class FakeIndexTts:
    """假装是台式机上的 IndexTTS 小服务(/health、/tts)。用法和 FakeGsv 一样:
    *_reply 设成 httpx.Response 就原样回它,设成异常就抛出;正常时 /tts 回 b"RIFF" + 文本。
    """

    def __init__(self):
        self.calls: list[tuple[str, Any]] = []
        self.timeouts: list[float] = []
        self.tts_reply: httpx.Response | Exception | None = None
        self.health_reply: httpx.Response | Exception | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/tts":
            body = json.loads(request.content)
            self.calls.append(("tts", body))
            ok = httpx.Response(
                200, headers={"content-type": "audio/wav"}, content=b"RIFF" + body["text"].encode()
            )
            return FakeGsv._reply(self.tts_reply, ok)
        if path == "/health":
            self.calls.append(("health", None))
            ok = httpx.Response(200, json={"model": "IndexTTS-2.5", "ready": True})
            return FakeGsv._reply(self.health_reply, ok)
        return httpx.Response(404)

    def bodies(self) -> list[dict]:
        return [body for name, body in self.calls if name == "tts"]


@pytest.fixture
def index_tts(monkeypatch) -> Iterator[FakeIndexTts]:
    from app.tts.registry import reset_engines

    fake = FakeIndexTts()

    def make(base_url: str, timeout: float) -> httpx.AsyncClient:
        fake.timeouts.append(timeout)
        return httpx.AsyncClient(transport=httpx.MockTransport(fake.handler))

    monkeypatch.setattr("app.tts.indextts.make_tts_client", make)
    reset_engines()
    yield fake
    reset_engines()
