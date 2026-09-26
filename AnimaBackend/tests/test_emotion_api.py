"""/api/emotion/match 和 /status。匹配逻辑用假 encoder;真模型那条有模型才跑。"""

from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.api.emotion import use_matcher
from app.config import settings
from app.emotion import service
from app.emotion.encoder import MODEL_FILE, TOKENIZER_FILE
from app.emotion.matcher import EmotionMatcher
from app.main import app


class FakeEncoder:
    name = "fake"
    table = {"有点心疼": [1, 0.2], "小得意": [0.1, 1], "担心": [1, 0], "微笑": [0.3, 1], "smile": [0.1, 1]}

    def encode(self, texts):
        rows = np.array([self.table[t] for t in texts], dtype=np.float32)
        return rows / np.linalg.norm(rows, axis=1, keepdims=True)


@pytest.fixture
def fake_matcher():
    app.dependency_overrides[use_matcher] = lambda: EmotionMatcher(FakeEncoder())
    yield
    app.dependency_overrides.pop(use_matcher, None)


@pytest.fixture
def no_model(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "emotion_model_dir", str(tmp_path / "missing"))
    service.reset()
    yield tmp_path / "missing"
    service.reset()


def test_match_returns_best_candidate_per_tag(client: TestClient, fake_matcher):
    r = client.post(
        "/api/emotion/match",
        json={
            "tags": [" 有点心疼 ", "小得意"],
            "candidates": [{"key": "s1", "names": ["微笑", "smile"]}, {"key": "s2", "names": ["担心"]}],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["model"] == "fake"
    assert [(x["tag"], x["key"], x["name"]) for x in body["results"]] == [
        ("有点心疼", "s2", "担心"),
        ("小得意", "s1", "smile"),
    ]


@pytest.mark.parametrize(
    "payload",
    [
        {"tags": [], "candidates": [{"key": "s", "names": ["a"]}]},
        {"tags": ["a"], "candidates": []},
        {"tags": ["a"], "candidates": [{"key": "s", "names": []}]},
        {"tags": ["  "], "candidates": [{"key": "s", "names": ["a"]}]},
        {"tags": ["长" * 41], "candidates": [{"key": "s", "names": ["a"]}]},
        {"tags": ["a"] * 51, "candidates": [{"key": "s", "names": ["a"]}]},
    ],
)
def test_match_validates_payload(client: TestClient, fake_matcher, payload):
    assert client.post("/api/emotion/match", json=payload).status_code == 422


def test_match_is_503_when_model_missing(client: TestClient, no_model):
    r = client.post("/api/emotion/match", json={"tags": ["a"], "candidates": [{"key": "s", "names": ["b"]}]})
    assert r.status_code == 503
    assert r.json()["detail"] == f"情绪识别模型没装:{no_model}"


def test_status_reports_missing_model(client: TestClient, no_model):
    r = client.get("/api/emotion/status")
    assert r.json() == {"ready": False, "model": "bge-small-zh-v1.5", "detail": f"情绪识别模型没装:{no_model}"}


def test_status_reports_load_failure(client: TestClient, tmp_path, monkeypatch):
    broken = tmp_path / "broken"
    broken.mkdir()
    (broken / MODEL_FILE).write_bytes(b"not a model")
    (broken / TOKENIZER_FILE).write_text("{}", encoding="utf-8")
    monkeypatch.setattr(settings, "emotion_model_dir", str(broken))
    service.reset()
    try:
        body = client.get("/api/emotion/status").json()
    finally:
        service.reset()
    assert body["ready"] is False
    assert body["detail"].startswith("情绪识别模型加载失败:")


# 模块加载时读默认目录:conftest 的 autouse fixture 会在每个测试里把它改掉
REAL_DIR = Path(settings.emotion_model_dir)


@pytest.mark.skipif(
    not (REAL_DIR / MODEL_FILE).is_file(), reason="没下载情绪模型(scripts/download_emotion_model.py)"
)
def test_real_model_matches_synonyms(client: TestClient, monkeypatch):
    monkeypatch.setattr(settings, "emotion_model_dir", str(REAL_DIR))
    service.reset()
    r = client.post(
        "/api/emotion/match",
        json={
            "tags": ["开心", "发火"],
            "candidates": [
                {"key": "happy", "names": ["高兴"]},
                {"key": "angry", "names": ["生气"]},
                {"key": "scared", "names": ["害怕"]},
            ],
        },
    )
    assert r.status_code == 200, r.text
    assert [x["key"] for x in r.json()["results"]] == ["happy", "angry"]
    assert client.get("/api/emotion/status").json()["ready"] is True
