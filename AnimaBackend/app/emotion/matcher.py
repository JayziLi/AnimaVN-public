"""标签 → 列表里最像的候选。

AI 写的立绘标签对不上这张卡的立绘名时,拿它的向量和每个候选名字的向量比余弦相似度,
取最大的那个。总是给出一个结果,不设门槛(准确度次要,见
docs/superpowers/specs/2026-09-25-sprite-emotion-matching-design.md)。
encoder 是协议:真模型在 encoder.py,测试用假的。
"""

from collections import OrderedDict
from collections.abc import Sequence
from dataclasses import dataclass
from threading import Lock
from typing import Protocol

import numpy as np


class Encoder(Protocol):
    name: str

    def encode(self, texts: Sequence[str]) -> np.ndarray:
        """(len(texts), 维数),每行已经归一化"""
        ...


@dataclass(frozen=True)
class Candidate:
    key: str
    names: tuple[str, ...]


@dataclass(frozen=True)
class Match:
    tag: str
    key: str
    name: str
    score: float


class EmotionMatcher:
    def __init__(self, encoder: Encoder, cache_size: int = 4096):
        self.encoder = encoder
        # 文本 → 向量。同一张卡的立绘名每次都会发过来,只算一次
        self._cache: OrderedDict[str, np.ndarray] = OrderedDict()
        self._cache_size = cache_size
        self._lock = Lock()

    @property
    def model(self) -> str:
        return self.encoder.name

    def _vectors(self, texts: Sequence[str]) -> dict[str, np.ndarray]:
        unique = list(dict.fromkeys(texts))
        out: dict[str, np.ndarray] = {}
        with self._lock:
            for t in unique:
                v = self._cache.get(t)
                if v is not None:
                    self._cache.move_to_end(t)
                    out[t] = v
        missing = [t for t in unique if t not in out]
        if missing:
            vectors = self.encoder.encode(missing)
            with self._lock:
                for t, v in zip(missing, vectors):
                    out[t] = v
                    self._cache[t] = v
                    self._cache.move_to_end(t)
                while len(self._cache) > self._cache_size:
                    self._cache.popitem(last=False)
        return out

    def match(self, tags: Sequence[str], candidates: Sequence[Candidate]) -> list[Match]:
        names = [n for c in candidates for n in c.names]
        owner = [i for i, c in enumerate(candidates) for _ in c.names]
        vec = self._vectors([*tags, *names])
        name_matrix = np.stack([vec[n] for n in names])
        results: list[Match] = []
        for tag in tags:
            sims = name_matrix @ vec[tag]
            # argmax 取第一个最大值:名字按候选顺序排开,并列时自然落在排前面的候选上
            best = int(np.argmax(sims))
            c = candidates[owner[best]]
            results.append(Match(tag=tag, key=c.key, name=names[best], score=round(float(sims[best]), 3)))
        return results
