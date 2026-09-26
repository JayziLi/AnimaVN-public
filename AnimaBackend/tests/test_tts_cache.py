from collections.abc import Iterator
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base
from app.models import TtsCache
from app.tts import cache


@pytest.fixture
def db() -> Iterator[Session]:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def test_cache_key_is_stable_and_order_independent():
    a = cache.cache_key({"gpt": "a", "body": {"text": "你好", "sample_steps": 64}})
    b = cache.cache_key({"body": {"sample_steps": 64, "text": "你好"}, "gpt": "a"})
    assert a == b and len(a) == 64
    assert cache.cache_key({"gpt": "b", "body": {"text": "你好", "sample_steps": 64}}) != a


def test_cache_evicts_least_recently_used_over_limit(db: Session, monkeypatch):
    monkeypatch.setattr(cache, "CACHE_LIMIT", 250)
    cache.cache_put(db, "a", b"x" * 100, "audio/wav")
    cache.cache_put(db, "b", b"y" * 100, "audio/wav")
    # a 最近用过,b 很久没用
    db.get(TtsCache, "a").last_used_at = datetime(2100, 1, 1, tzinfo=timezone.utc)
    db.get(TtsCache, "b").last_used_at = datetime(2000, 1, 1, tzinfo=timezone.utc)
    db.commit()

    cache.cache_put(db, "c", b"z" * 100, "audio/wav")

    assert cache.cache_get(db, "b") is None
    assert cache.cache_get(db, "a") == (b"x" * 100, "audio/wav")
    assert cache.cache_get(db, "c") == (b"z" * 100, "audio/wav")
    assert cache.cache_stats(db) == (2, 200)

    cache.cache_clear(db)
    assert cache.cache_stats(db) == (0, 0)
