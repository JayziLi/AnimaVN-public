"""合成结果的缓存(SQLite BLOB)。

GPT-SoVITS 每次请求的随机种子不同,同一句重新合成语气会变;回看、重播要听到同一段,
所以必须缓存。键是「权重路径 + 发给引擎的请求体」的哈希:声音、情绪、采样步数一改,
键自然就变了,旧的不会被误用。超过上限按最后使用时间删最旧的。
"""

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session, undefer

from app.models import TtsCache

CACHE_LIMIT = 500 * 1024 * 1024


def _now() -> datetime:
    return datetime.now(timezone.utc)


def cache_key(material: dict[str, Any]) -> str:
    raw = json.dumps(material, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def cache_get(db: Session, key: str) -> tuple[bytes, str] | None:
    row = db.scalar(select(TtsCache).options(undefer(TtsCache.data)).where(TtsCache.key == key))
    if row is None:
        return None
    data, mime = row.data, row.mime
    row.last_used_at = _now()
    db.commit()
    return data, mime


def cache_has(db: Session, key: str) -> bool:
    """在不在缓存里。不读音频,也不算用了一次(不影响淘汰顺序)"""
    return db.scalar(select(TtsCache.key).where(TtsCache.key == key)) is not None


def cache_put(db: Session, key: str, data: bytes, mime: str) -> None:
    now = _now()
    row = db.get(TtsCache, key)
    if row is None:
        db.add(
            TtsCache(key=key, data=data, mime=mime, size=len(data), created_at=now, last_used_at=now)
        )
    else:
        # 重新生成的新版替换旧版;同一句同时有两个请求没命中时也是后到的覆盖先到的
        row.data, row.mime, row.size, row.last_used_at = data, mime, len(data), now
    db.flush()
    _evict(db)
    db.commit()


def _evict(db: Session) -> None:
    total = db.scalar(select(func.coalesce(func.sum(TtsCache.size), 0))) or 0
    if total <= CACHE_LIMIT:
        return
    oldest_first = db.execute(
        select(TtsCache.key, TtsCache.size).order_by(TtsCache.last_used_at)
    ).all()
    for key, size in oldest_first:
        if total <= CACHE_LIMIT:
            break
        db.execute(delete(TtsCache).where(TtsCache.key == key))
        total -= size


def cache_stats(db: Session) -> tuple[int, int]:
    count, total = db.execute(
        select(func.count(), func.coalesce(func.sum(TtsCache.size), 0)).select_from(TtsCache)
    ).one()
    return int(count), int(total)


def cache_clear(db: Session) -> None:
    db.execute(delete(TtsCache))
    db.commit()
