# 立绘 · 每句标表情 + 模型兜底匹配 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `{{char}}` 每句台词前都写立绘标签;对不上这张卡立绘名的标签,由后端 bge-small 模型挑出列表里最像的一个;立绘、占位框、语音都用匹配后的名字。

**Architecture:** 后端新增 `app/emotion/`(encoder / matcher / service)和 `POST /api/emotion/match`、`GET /api/emotion/status`,接口无状态。前端先精确匹配,对不上的批量问后端,结果按「候选签名 + 标签」缓存在页面内存;立绘层、语音、历史页共用同一个累计函数 `spriteLabelAfter`,多传一个「标签 → 结果」的查询。

**Tech Stack:** FastAPI + onnxruntime + tokenizers + numpy(后端);React + TypeScript(前端,无测试框架,靠 `npm run build` / `npm run lint` / 浏览器)。

设计:`docs/superpowers/specs/2026-09-25-sprite-emotion-matching-design.md`

## 实现和计划的出入(2026-09-25,已实现,未提交)

| 哪里 | 计划 | 实际 | 原因 |
|---|---|---|---|
| 前端 API 对象 | `api.emotionMatch` / `api.emotionStatus` | `debugApi.…` | `lib/api.ts` 导出的对象叫 `debugApi` |
| `EmotionCandidate.aliases` | `readonly string[]` | `string[]`,内置列表拷一份 | `resolveByLabel` 的 `Labeled` 要可变数组 |
| Dockerfile | pip install 之后下载模型 | 下载放在复制代码**之前**,单独一层(先 `pip install httpx`) | 改代码重建镜像时不用重新下载 |
| `.dockerignore` | 没提 | 加了 `AnimaBackend/models` | 本机那份不用传进构建上下文 |
| Task 1 测试 | 「有点心疼」报的名字是「担心」 | 是「worried」 | 测试数据里 worried 离得更近;测的就是「报最近的那个名字」 |
| 语音页文案 | 只改 `missingEmotions` 的调用 | 「补齐」按钮的说明、「这些立绘表情…没有」那句也按有没有立绘改了措辞 | 没立绘的卡对照的是内置表情 |
| 存档缩略图(`vn/VNSaves.tsx`) | 没提 | **没改**,还是只认精确匹配 | 只是一张小预览,每个存档都去问模型不值得;现在每句都有标签,精确匹配基本都中 |

实测(2026-09-25,本机,真模型):
- 接口:Wikira 的 17 张立绘当候选,第一次 52 ms(编码 17 个名字),之后 4 ms
- 希尔维(4 张立绘)的临时对话,逐句:平静(精确)→ 旁白保持 → 小得意 ≈ 微笑 → 有点心疼 ≈ 惊讶(判偏)→ 店长的台词不切 → 吃惊 ≈ 惊讶
- 没立绘的卡:高兴 → 内置「开心」(别名精确命中),有点失落 ≈ 忧郁
- 模型目录指到空目录:插件页标红给出安装命令;控制台写「✗ 情绪识别模型没装…,保持上一张」,视觉小说照常
- 实测用的临时对话已删,两张卡的「继续」书签已恢复,`plugin.*` 没动过

## Global Constraints

- 模型:`Xenova/bge-small-zh-v1.5` 的 `onnx/model_quantized.onnx` + `tokenizer.json`;SHA-256 分别是 `15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc`、`48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26`
- 模型目录默认 `AnimaBackend/models/bge-small-zh-v1.5`,环境变量 `EMOTION_MODEL_DIR`;Docker 里是 `/app/models/bge-small-zh-v1.5`,**不能放 `/app/data`**
- 接口限制:`tags` 1–50 个,`candidates` 1–200 个,每个候选 1–20 个名字,每个字符串去空白后 1–40 字
- 模型不可用 → 503,`detail` 为「情绪识别模型没装:<目录>」或「情绪识别模型加载失败:<原因>」
- 总是返回最像的候选,不设门槛;并列取候选里排前面的
- 内置基础表情 = `app/tts/emotion_presets.py` 的 `PRESETS`(每组第一个是名字),前端 `plugins/emotions.ts` 抄一份
- 提交:用户说了再提交;提交信息里不加 Claude 署名
- 浏览器实测前先备份 `plugin.*` 设置,别点「恢复默认」

---

### Task 1: 后端匹配器(纯逻辑)

**Files:**
- Create: `AnimaBackend/app/emotion/__init__.py`(空)
- Create: `AnimaBackend/app/emotion/matcher.py`
- Test: `AnimaBackend/tests/test_emotion_matcher.py`

**Interfaces:**
- Produces: `Encoder`(协议:`name: str`、`encode(texts: Sequence[str]) -> np.ndarray`,每行已归一化)、`Candidate(key: str, names: tuple[str, ...])`、`Match(tag, key, name, score)`、`EmotionMatcher(encoder, cache_size=4096)`,方法 `match(tags: Sequence[str], candidates: Sequence[Candidate]) -> list[Match]`,属性 `model -> str`

- [ ] **Step 1: 写失败的测试**

```python
"""EmotionMatcher 的排序和缓存,用假 encoder,不加载真模型。"""

import numpy as np

from app.emotion.matcher import Candidate, EmotionMatcher


class FakeEncoder:
    """每个文本一个固定向量;记下被编码过哪些文本"""

    name = "fake"

    def __init__(self, table: dict[str, list[float]]):
        self.table = table
        self.calls: list[str] = []

    def encode(self, texts):
        self.calls.extend(texts)
        rows = np.array([self.table[t] for t in texts], dtype=np.float32)
        return rows / np.linalg.norm(rows, axis=1, keepdims=True)


TABLE = {
    "有点心疼": [1, 0.2, 0],
    "担心": [1, 0, 0],
    "worried": [0.9, 0.1, 0],
    "微笑": [0, 1, 0],
    "smile": [0, 1, 0.1],
    "生气": [0, 0, 1],
    "小得意": [0.1, 0.9, 0.2],
}


def test_picks_the_most_similar_candidate_and_reports_the_name():
    m = EmotionMatcher(FakeEncoder(TABLE))
    cands = [Candidate("s1", ("微笑", "smile")), Candidate("s2", ("担心", "worried")), Candidate("s3", ("生气",))]
    [r] = m.match(["有点心疼"], cands)
    assert (r.tag, r.key, r.name) == ("有点心疼", "s2", "担心")
    assert 0.9 < r.score <= 1.0


def test_score_is_the_best_name_of_each_candidate():
    m = EmotionMatcher(FakeEncoder(TABLE))
    # 「小得意」离 smile 比离 微笑 更近一点,但都属于 s1
    [r] = m.match(["小得意"], [Candidate("s3", ("生气",)), Candidate("s1", ("微笑", "smile"))])
    assert r.key == "s1"


def test_ties_go_to_the_earlier_candidate():
    table = {"x": [1, 0], "a": [1, 0], "b": [1, 0]}
    m = EmotionMatcher(FakeEncoder(table))
    [r] = m.match(["x"], [Candidate("first", ("a",)), Candidate("second", ("b",))])
    assert r.key == "first"


def test_results_follow_tag_order_and_each_text_is_encoded_once():
    enc = FakeEncoder(TABLE)
    m = EmotionMatcher(enc)
    cands = [Candidate("s1", ("微笑",)), Candidate("s2", ("担心",))]
    out = m.match(["有点心疼", "小得意", "有点心疼"], cands)
    assert [r.key for r in out] == ["s2", "s1", "s2"]
    m.match(["小得意"], cands)
    assert sorted(enc.calls) == sorted(["有点心疼", "小得意", "微笑", "担心"])


def test_cache_evicts_oldest_beyond_limit():
    enc = FakeEncoder({"a": [1, 0], "b": [0, 1], "c": [1, 1]})
    m = EmotionMatcher(enc, cache_size=2)
    m.match(["a"], [Candidate("k", ("b",))])
    m.match(["c"], [Candidate("k", ("b",))])  # 缓存里只剩 b、c
    m.match(["a"], [Candidate("k", ("b",))])
    assert enc.calls.count("a") == 2
    assert enc.calls.count("b") == 1
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd AnimaBackend && .venv/Scripts/python.exe -m pytest tests/test_emotion_matcher.py -q`
Expected: FAIL,`ModuleNotFoundError: No module named 'app.emotion'`

- [ ] **Step 3: 实现**

`AnimaBackend/app/emotion/__init__.py` 为空文件。`AnimaBackend/app/emotion/matcher.py`:

```python
"""标签 → 列表里最像的候选。

AI 写的立绘标签对不上这张卡的立绘名时,拿它的向量和每个候选名字的向量比余弦相似度,
取最大的那个。总是给出一个结果,不设门槛(准确度次要,见设计文档)。
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
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `cd AnimaBackend && .venv/Scripts/python.exe -m pytest tests/test_emotion_matcher.py -q`
Expected: 5 passed

---

### Task 2: 真模型、懒加载、接口

**Files:**
- Modify: `AnimaBackend/pyproject.toml`(dependencies 加 `onnxruntime>=1.17`、`tokenizers>=0.15`、`numpy>=1.26`)
- Modify: `AnimaBackend/app/config.py`(加 `emotion_model_dir`)
- Create: `AnimaBackend/app/emotion/encoder.py`
- Create: `AnimaBackend/app/emotion/service.py`
- Create: `AnimaBackend/app/api/emotion.py`
- Modify: `AnimaBackend/app/main.py`(`include_router(emotion.router)`)
- Test: `AnimaBackend/tests/test_emotion_api.py`

**Interfaces:**
- Consumes: Task 1 的 `EmotionMatcher`、`Candidate`
- Produces: `BgeEncoder(model_dir: Path)`、常量 `MODEL_NAME = "bge-small-zh-v1.5"`、`MODEL_FILE`、`TOKENIZER_FILE`;`service.get_matcher() -> EmotionMatcher`(不可用抛 `EmotionUnavailable`)、`service.reset()`(测试用);`api.emotion.use_matcher`(依赖,可在测试里覆盖);HTTP 接口见设计文档

- [ ] **Step 1: 装依赖**

pyproject 的 dependencies 末尾加三行:

```toml
    "onnxruntime>=1.17",
    "tokenizers>=0.15",
    "numpy>=1.26",
```

Run: `cd AnimaBackend && .venv/Scripts/python.exe -m pip install onnxruntime tokenizers numpy`
Expected: Successfully installed(或 already satisfied)

- [ ] **Step 2: 写失败的测试**

```python
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


REAL_DIR = Path(settings.emotion_model_dir)


@pytest.mark.skipif(
    not (REAL_DIR / MODEL_FILE).is_file(), reason="没下载情绪模型(scripts/download_emotion_model.py)"
)
def test_real_model_matches_synonyms(client: TestClient):
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
```

- [ ] **Step 3: 跑测试,确认失败**

Run: `cd AnimaBackend && .venv/Scripts/python.exe -m pytest tests/test_emotion_api.py -q`
Expected: FAIL,`ModuleNotFoundError: No module named 'app.api.emotion'`

- [ ] **Step 4: 实现**

`app/config.py`,`Settings` 里 `cors_origin_regex` 后面加:

```python
    # 情绪识别模型(立绘标签兜底匹配)。下载:python scripts/download_emotion_model.py。
    # Docker 里放 /app/models —— /app/data 是数据卷的挂载点,放进去会被盖住
    emotion_model_dir: str = str(_BACKEND_DIR / "models" / "bge-small-zh-v1.5")
```

`app/emotion/encoder.py`:

```python
"""bge-small-zh-v1.5(int8 ONNX,MIT)的句向量:取 CLS 向量再归一化。

立绘标签和立绘名都很短,截断到 64 个 token 足够。单线程跑:一次一批十几个短词,
CPU 上两三毫秒,多线程反而抢核。
"""

from collections.abc import Sequence
from pathlib import Path

import numpy as np

MODEL_NAME = "bge-small-zh-v1.5"
MODEL_FILE = "model_quantized.onnx"
TOKENIZER_FILE = "tokenizer.json"


class BgeEncoder:
    name = MODEL_NAME

    def __init__(self, model_dir: Path):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        tokenizer = Tokenizer.from_file(str(model_dir / TOKENIZER_FILE))
        tokenizer.enable_truncation(max_length=64)
        pad_id = tokenizer.token_to_id("[PAD]") or 0
        tokenizer.enable_padding(pad_id=pad_id, pad_token="[PAD]")
        self._tokenizer = tokenizer

        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        self._session = ort.InferenceSession(
            str(model_dir / MODEL_FILE), options, providers=["CPUExecutionProvider"]
        )
        self._input_names = {i.name for i in self._session.get_inputs()}

    def encode(self, texts: Sequence[str]) -> np.ndarray:
        batch = self._tokenizer.encode_batch(list(texts))
        ids = np.array([e.ids for e in batch], dtype=np.int64)
        feeds = {
            "input_ids": ids,
            "attention_mask": np.array([e.attention_mask for e in batch], dtype=np.int64),
        }
        if "token_type_ids" in self._input_names:
            feeds["token_type_ids"] = np.zeros_like(ids)
        hidden = self._session.run(None, feeds)[0]
        cls = hidden[:, 0]
        return cls / np.linalg.norm(cls, axis=1, keepdims=True)
```

`app/emotion/service.py`:

```python
"""进程里一个情绪匹配器:第一次用到时加载;没装或加载失败就抛 EmotionUnavailable,
下次请求再试(装好模型不用重启后端)。"""

from pathlib import Path
from threading import Lock

from app.config import settings
from app.emotion.encoder import MODEL_FILE, TOKENIZER_FILE, BgeEncoder
from app.emotion.matcher import EmotionMatcher


class EmotionUnavailable(Exception):
    pass


_lock = Lock()
_matcher: EmotionMatcher | None = None


def get_matcher() -> EmotionMatcher:
    global _matcher
    if _matcher is not None:
        return _matcher
    with _lock:
        if _matcher is not None:
            return _matcher
        model_dir = Path(settings.emotion_model_dir)
        if not all((model_dir / f).is_file() for f in (MODEL_FILE, TOKENIZER_FILE)):
            raise EmotionUnavailable(f"情绪识别模型没装:{model_dir}")
        try:
            _matcher = EmotionMatcher(BgeEncoder(model_dir))
        except Exception as e:  # onnxruntime / tokenizers 的报错类型各不相同,原样带回去
            raise EmotionUnavailable(f"情绪识别模型加载失败:{e}") from e
        return _matcher


def reset() -> None:
    """测试用:丢掉已加载的模型,下次按当前配置重新加载"""
    global _matcher
    with _lock:
        _matcher = None
```

`app/api/emotion.py`:

```python
"""情绪识别:AI 写的立绘标签对不上立绘名时,挑列表里最像的一个。

接口不查库、不存状态:候选(立绘名 + 别名,或内置基础表情)由前端带过来。
两个接口都是同步函数,FastAPI 会放进线程池跑,推理不堵事件循环。
"""

from dataclasses import asdict
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, StringConstraints

from app.emotion.encoder import MODEL_NAME
from app.emotion.matcher import Candidate, EmotionMatcher
from app.emotion.service import EmotionUnavailable, get_matcher

router = APIRouter(prefix="/api/emotion", tags=["emotion"])

Word = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]


class CandidateIn(BaseModel):
    key: Annotated[str, StringConstraints(min_length=1, max_length=80)]
    names: list[Word] = Field(min_length=1, max_length=20)


class MatchIn(BaseModel):
    tags: list[Word] = Field(min_length=1, max_length=50)
    candidates: list[CandidateIn] = Field(min_length=1, max_length=200)


class MatchOut(BaseModel):
    tag: str
    key: str
    name: str
    score: float


class MatchResponse(BaseModel):
    model: str
    results: list[MatchOut]


class StatusOut(BaseModel):
    ready: bool
    model: str
    detail: str | None


def use_matcher() -> EmotionMatcher:
    try:
        return get_matcher()
    except EmotionUnavailable as e:
        raise HTTPException(503, str(e)) from e


@router.post("/match", response_model=MatchResponse)
def match(req: MatchIn, matcher: EmotionMatcher = Depends(use_matcher)):
    candidates = [Candidate(c.key, tuple(c.names)) for c in req.candidates]
    results = matcher.match(req.tags, candidates)
    return MatchResponse(model=matcher.model, results=[MatchOut(**asdict(r)) for r in results])


@router.get("/status", response_model=StatusOut)
def status():
    """顺带触发加载:装了但加载失败也能从这里看出来"""
    try:
        m = get_matcher()
    except EmotionUnavailable as e:
        return StatusOut(ready=False, model=MODEL_NAME, detail=str(e))
    return StatusOut(ready=True, model=m.model, detail=None)
```

`app/main.py`:import 列表里加 `emotion`,`app.include_router(voices.router)` 后面加 `app.include_router(emotion.router)`。

- [ ] **Step 5: 跑测试,确认通过**

Run: `cd AnimaBackend && .venv/Scripts/python.exe -m pytest tests/test_emotion_api.py tests/test_emotion_matcher.py -q`
Expected: 全部通过,真模型那条 skipped(还没下载)

---

### Task 3: 模型下载脚本、gitignore、Docker

**Files:**
- Create: `AnimaBackend/scripts/download_emotion_model.py`
- Modify: `.gitignore`(加 `AnimaBackend/models/`)
- Modify: `deploy/backend.Dockerfile`
- Test: `AnimaBackend/tests/test_download_emotion_model.py`

**Interfaces:**
- Consumes: Task 2 的 `MODEL_FILE`、`TOKENIZER_FILE` 这两个文件名(脚本里写死同样的字符串,脚本不 import app,Docker 里 pip install 之前也能单独跑)
- Produces: `python scripts/download_emotion_model.py [--dir DIR]`;模块里 `FILES`、`fetch()`、`main(argv)`

- [ ] **Step 1: 写失败的测试**

```python
"""下载脚本:已经有且哈希对就跳过;哈希不对就重下。不联网,fetch 换成假的。"""

import hashlib
import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "download_emotion_model.py"


def load_script():
    spec = importlib.util.spec_from_file_location("download_emotion_model", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_skips_files_with_matching_hash_and_fetches_the_rest(tmp_path, monkeypatch):
    mod = load_script()
    good = b"model bytes"
    monkeypatch.setattr(
        mod,
        "FILES",
        {
            "a.onnx": ("onnx/a.onnx", hashlib.sha256(good).hexdigest()),
            "b.json": ("b.json", hashlib.sha256(b"tok").hexdigest()),
        },
    )
    (tmp_path / "a.onnx").write_bytes(good)
    (tmp_path / "b.json").write_bytes(b"stale")
    fetched = []
    monkeypatch.setattr(mod, "fetch", lambda remote, dest, digest: fetched.append((remote, dest.name)))

    mod.main(["--dir", str(tmp_path)])

    assert fetched == [("b.json", "b.json")]
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd AnimaBackend && .venv/Scripts/python.exe -m pytest tests/test_download_emotion_model.py -q`
Expected: FAIL,`FileNotFoundError`(脚本还不存在)

- [ ] **Step 3: 实现脚本**

```python
"""下载情绪识别模型:bge-small-zh-v1.5 的 int8 ONNX 版(MIT,Xenova 转换)。

    python scripts/download_emotion_model.py [--dir 目录]

默认放到 AnimaBackend/models/bge-small-zh-v1.5(不进 git)。先从 Hugging Face 下,
失败换 hf-mirror.com;下完校验 SHA-256,先写 .part 再改名。已经有且哈希对的跳过。
不 import app —— Docker 构建时在装依赖之前也能跑(只用 httpx)。
"""

import argparse
import hashlib
from pathlib import Path

import httpx

REPO = "Xenova/bge-small-zh-v1.5"
HOSTS = ("https://huggingface.co", "https://hf-mirror.com")
# 本地文件名 → (仓库里的路径, SHA-256)
FILES = {
    "model_quantized.onnx": (
        "onnx/model_quantized.onnx",
        "15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc",
    ),
    "tokenizer.json": (
        "tokenizer.json",
        "48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26",
    ),
}
DEFAULT_DIR = Path(__file__).resolve().parent.parent / "models" / "bge-small-zh-v1.5"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(remote: str, dest: Path, digest: str) -> None:
    errors = []
    for host in HOSTS:
        url = f"{host}/{REPO}/resolve/main/{remote}"
        part = dest.with_name(dest.name + ".part")
        try:
            with httpx.stream("GET", url, follow_redirects=True, timeout=60) as r:
                r.raise_for_status()
                with part.open("wb") as f:
                    for chunk in r.iter_bytes(1 << 16):
                        f.write(chunk)
            if sha256(part) != digest:
                raise ValueError("SHA-256 对不上")
            part.replace(dest)
            print(f"下载好了 {dest.name}(来自 {host})")
            return
        except Exception as e:  # 网络、HTTP 状态、哈希,都换下一个源再试
            errors.append(f"  {url}: {e}")
            part.unlink(missing_ok=True)
    raise SystemExit(f"{dest.name} 下载失败:\n" + "\n".join(errors))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="下载情绪识别模型(bge-small-zh-v1.5 int8)")
    parser.add_argument("--dir", default=str(DEFAULT_DIR), help="放到哪个目录")
    args = parser.parse_args(argv)
    target = Path(args.dir)
    target.mkdir(parents=True, exist_ok=True)
    for name, (remote, digest) in FILES.items():
        dest = target / name
        if dest.is_file() and sha256(dest) == digest:
            print(f"已经有了 {name}")
            continue
        fetch(remote, dest, digest)
    print(f"情绪识别模型在 {target}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `cd AnimaBackend && .venv/Scripts/python.exe -m pytest tests/test_download_emotion_model.py -q`
Expected: 1 passed

- [ ] **Step 5: 真下载一次,再跑真模型测试**

Run: `cd AnimaBackend && .venv/Scripts/python.exe scripts/download_emotion_model.py`
Expected: 两个文件下载好了,最后一行「情绪识别模型在 …\models\bge-small-zh-v1.5」

Run: `cd AnimaBackend && .venv/Scripts/python.exe -m pytest tests/test_emotion_api.py -q`
Expected: 全部通过,**没有** skipped

- [ ] **Step 6: gitignore 和 Docker**

`.gitignore` 在 `!AnimaBackend/data/.gitkeep` 后面加:

```
# 情绪识别模型:scripts/download_emotion_model.py 下载,几十 MB,不进仓库
AnimaBackend/models/
```

`deploy/backend.Dockerfile`,`COPY AnimaBackend/app ./app` 后面加一行 `COPY AnimaBackend/scripts/download_emotion_model.py ./scripts/`;`RUN pip install --no-cache-dir .` 后面加:

```dockerfile
# 情绪识别模型烤进镜像。放 /app/models:/app/data 是数据卷的挂载点,放进去会被盖住
RUN python scripts/download_emotion_model.py --dir /app/models/bge-small-zh-v1.5
ENV EMOTION_MODEL_DIR=/app/models/bge-small-zh-v1.5
```

---

### Task 4: 内置基础表情 + 「按立绘表情补齐」兜底

**Files:**
- Modify: `AnimaBackend/app/tts/emotion_presets.py`(加 `BUILTIN_EMOTIONS`)
- Modify: `AnimaBackend/app/api/voices.py:364-398`(`emotions_from_sprites`)
- Create: `frontend/src/debug/plugins/emotions.ts`
- Test: `AnimaBackend/tests/test_emotion_presets.py`、`AnimaBackend/tests/test_voices_api.py`

**Interfaces:**
- Produces: 后端 `BUILTIN_EMOTIONS: list[tuple[str, tuple[str, ...]]]`;前端 `BUILTIN_EMOTIONS: readonly { label: string; aliases: readonly string[] }[]`

- [ ] **Step 1: 写失败的测试**

`tests/test_emotion_presets.py` 末尾加:

```python
import re
from pathlib import Path

from app.tts.emotion_presets import BUILTIN_EMOTIONS


def test_builtin_emotions_are_the_preset_groups():
    assert [label for label, _ in BUILTIN_EMOTIONS] == [names[0] for names, _ in PRESETS]
    assert BUILTIN_EMOTIONS[2] == ("开心", ("高兴", "happy"))


FRONTEND_COPY = Path(__file__).resolve().parents[2] / "frontend/src/debug/plugins/emotions.ts"


def test_frontend_copy_matches(request):
    if not FRONTEND_COPY.is_file():
        import pytest

        pytest.skip("没有前端代码(比如在 Docker 里)")
    text = FRONTEND_COPY.read_text(encoding="utf-8")
    rows = re.findall(r"\{ label: '([^']+)', aliases: \[([^\]]*)\] \}", text)
    parsed = [(label, tuple(re.findall(r"'([^']+)'", aliases))) for label, aliases in rows]
    assert parsed == BUILTIN_EMOTIONS
```

`tests/test_voices_api.py` 末尾加:

```python
def test_emotions_from_sprites_uses_builtin_list_when_card_has_no_sprites(client: TestClient, make_card):
    conn = client.post(
        "/api/tts/connections",
        json={"name": "IndexTTS", "api_type": "indextts", "base_url": "http://127.0.0.1:9890"},
    ).json()
    v = make_voice(client, conn["id"], name="酒馆导入的角色")
    card = make_card(name="没有立绘")
    r = client.post(f"/api/voices/{v['id']}/emotions/from-sprites", json={"card_id": card["id"]})
    assert r.status_code == 200, r.text
    rows = r.json()
    assert [e["label"] for e in rows][:4] == ["平静", "微笑", "开心", "温柔"]
    assert len(rows) == 16
    happy = next(e for e in rows if e["label"] == "开心")
    assert happy["aliases"] == ["高兴", "happy"]
    assert happy["emo_vector"] == [0.8, 0, 0, 0, 0, 0, 0, 0]
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd AnimaBackend && .venv/Scripts/python.exe -m pytest tests/test_emotion_presets.py tests/test_voices_api.py -q`
Expected: FAIL,`ImportError: cannot import name 'BUILTIN_EMOTIONS'`

- [ ] **Step 3: 实现**

`emotion_presets.py`,`_BY_NAME = …` 后面加:

```python
# 没配立绘的卡用的内置基础表情:{{sprites}} 展开成它们,标签也拿它们当候选。
# 每组第一个词是名字,其余是别名;默认向量正好覆盖每一项。
# 前端 frontend/src/debug/plugins/emotions.ts 抄了一份,改这里要一起改(有测试对照)
BUILTIN_EMOTIONS: list[tuple[str, tuple[str, ...]]] = [(names[0], names[1:]) for names, _ in PRESETS]
```

`voices.py`:import 加 `BUILTIN_EMOTIONS`;`emotions_from_sprites` 的 docstring 和循环改成:

```python
    """每个立绘表情一行,向量按常见表情名预填;已有的行(名字或别名对上)不动,只加缺的。
    这张卡一张立绘都没有时,按内置基础表情补(带上别名),和 {{sprites}} 的兜底是同一份"""
    ...
    if sprites:
        sources = [(s.label, [s.label, *(s.aliases or [])], []) for s in sprites]
    else:
        sources = [(label, [label, *aliases], list(aliases)) for label, aliases in BUILTIN_EMOTIONS]
    for label, names, aliases in sources:
        if any(n.casefold() in taken for n in names):
            continue
        db.add(
            VoiceEmotion(
                profile_id=profile_id,
                label=label,
                aliases=aliases,
                emo_vector=preset_vector(names),
                sort=next_sort,
            )
        )
        next_sort += 1
        taken.update(n.casefold() for n in [label, *aliases])
```

`frontend/src/debug/plugins/emotions.ts`:

```ts
/**
 * 没配立绘的卡用的内置基础表情:{{sprites}} 展开成它们,立绘标签也拿它们当候选。
 * 和后端 AnimaBackend/app/tts/emotion_presets.py 的 PRESETS 是同一张表(每组第一个是名字,
 * 其余是别名),IndexTTS 的默认向量正好覆盖每一项。改这里要一起改那边(后端有测试对照这个文件)
 */
export const BUILTIN_EMOTIONS: readonly { label: string; aliases: readonly string[] }[] = [
  { label: '平静', aliases: ['normal', 'calm', 'neutral', '说话', 'talk', '默认'] },
  { label: '微笑', aliases: ['smile'] },
  { label: '开心', aliases: ['高兴', 'happy'] },
  { label: '温柔', aliases: ['gentle'] },
  { label: '认真', aliases: ['serious'] },
  { label: '担心', aliases: ['worried'] },
  { label: '难过', aliases: ['伤心', 'sad'] },
  { label: '哭', aliases: ['cry'] },
  { label: '惊讶', aliases: ['surprised'] },
  { label: '慌张', aliases: ['flustered'] },
  { label: '害羞', aliases: ['脸红', 'shy'] },
  { label: '疑惑', aliases: ['confused'] },
  { label: '生气', aliases: ['angry'] },
  { label: '害怕', aliases: ['afraid', 'scared'] },
  { label: '厌恶', aliases: ['嫌弃', 'disgusted'] },
  { label: '忧郁', aliases: ['失落', 'melancholic'] },
];
```

- [ ] **Step 4: 跑全部后端测试**

Run: `cd AnimaBackend && .venv/Scripts/python.exe -m pytest -q`
Expected: 全部通过(原有的 `from-sprites` 测试照样过)

---

### Task 5: 前端 · 提示词模板、宏、API

**Files:**
- Modify: `frontend/src/debug/plugins/sprite.ts`
- Modify: `frontend/src/debug/lib/api.ts`

**Interfaces:**
- Consumes: Task 4 的前端 `BUILTIN_EMOTIONS`
- Produces: `DEFAULT_BLOCK_PROMPT`(新)、`spriteMacros()` 多一个 `sprite_examples`、`normalizeSpriteConfig` 自动升级旧默认;`api.emotionMatch(payload)`、`api.emotionStatus()`、类型 `EmotionMatchResult`、`EmotionStatus`

- [ ] **Step 1: sprite.ts**

把 `DEFAULT_BLOCK_PROMPT` 换成新版,旧版改名留作升级判断:

```ts
export const DEFAULT_BLOCK_PROMPT = `[立绘指令]
{{char}} 说的每一句话，都必须以 {{sprite_tag}} 开头，用来形容 {{char}} 说这句话时的心情。
从下面这些表情里选一个，作为每句话开头的表情：
{{sprites}}

表情务必简短，2~5 个字，比如「慌张」「难为情」。列表里实在没有合适的，也可以写一个别的情绪词。
绝对不要在标签里写动作或主语！只允许写表情。
旁白和其他角色说的话前面不用写。标签单独写，不要放进引号或括号里，也不要解释它。

{{sprite_examples}}`;

/** 以前的默认模板。存着的模板和它们一字不差 = 用户没改过,读取时换成新版 */
const OLD_DEFAULT_BLOCK_PROMPTS = [
  `[立绘指令]
{{char}} 有这些立绘表情可以用：
{{sprites}}

写回复时，在 {{char}} 表情发生变化的那一句前面插入 {{sprite_tag}}，把「表情名」换成上面列表里的一个名字，一字不差。
- 每条回复的第一句前必须写一次，交代 {{char}} 此刻的表情
- 表情没变就不要重复写
- 标签单独写，不要放进引号或括号里，也不要解释它`,
];
```

`normalizeSpriteConfig`:

```ts
export function normalizeSpriteConfig(raw: unknown): SpritePluginConfig {
  const config = normalizePluginConfig(raw, DEFAULT_SPRITE_CONFIG, PLACEHOLDER);
  return OLD_DEFAULT_BLOCK_PROMPTS.includes(config.blockPrompt)
    ? { ...config, blockPrompt: DEFAULT_BLOCK_PROMPT }
    : config;
}
```

`spriteMacros`:

```ts
/** {{sprite_examples}}:照 LingChat 的正误示范,标签按当前格式写 */
function spriteExamples(template: string): string {
  const tag = (word: string) => tagExampleOf(template, PLACEHOLDER, word);
  return [
    '正确的示范：',
    `${tag('高兴')}「今天要不要一起吃蛋糕呀？」`,
    `${tag('无语')}「只是今天天气有点不好呢。」`,
    '她后退了两步。',
    `${tag('慌张')}「被那种东西碰到的话，感觉浑身都不干净啦！」`,
    '错误的示范：',
    `${tag('我高兴地走过来')}「今天要不要一起吃蛋糕呀？」`,
    '错误原因：标签里不能写动作或主语，必须简短。',
  ].join('\n');
}

/** 插件提供的宏,并入自定义宏的查找表(键是小写宏名) */
export function spriteMacros(
  config: SpritePluginConfig,
  sprites: readonly CardSprite[],
): Record<string, string> {
  // 一张立绘都没配:给内置基础表情,照样每句写、照样匹配(语音靠它带语气)
  const list =
    sprites.length === 0
      ? BUILTIN_EMOTIONS.map((e) => `- ${e.label}`).join('\n')
      : sprites
          .map((s) => (s.description.trim() ? `- ${s.label}：${s.description.trim()}` : `- ${s.label}`))
          .join('\n');
  return {
    sprites: list,
    sprite_tag: tagExample(config.tagTemplate),
    sprite_examples: spriteExamples(config.tagTemplate),
  };
}
```

文件头注释里「块的内容通过 {{sprites}} / {{sprite_tag}} 两个宏」改成「{{sprites}} / {{sprite_tag}} / {{sprite_examples}} 几个宏」;import 加 `BUILTIN_EMOTIONS`(`./emotions`)。

- [ ] **Step 2: api.ts**

类型(放在 `CardSprite` 后面):

```ts
/** /api/emotion/match 的一条结果:标签 → 最像的候选 */
export interface EmotionMatchResult {
  tag: string;
  key: string;
  /** 候选里相似度最高的那个名字 */
  name: string;
  /** 余弦相似度 */
  score: number;
}

export interface EmotionStatus {
  ready: boolean;
  model: string;
  /** 没装 / 加载失败的原因 */
  detail: string | null;
}
```

`api` 对象里 `listSprites` 前面加:

```ts
  // ---- 情绪识别:对不上立绘名的标签,挑列表里最像的 ----

  emotionMatch: (payload: { tags: string[]; candidates: { key: string; names: string[] }[] }) =>
    request<{ model: string; results: EmotionMatchResult[] }>('/api/emotion/match', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  emotionStatus: () => request<EmotionStatus>('/api/emotion/status'),
```

- [ ] **Step 3: 类型检查**

Run: `cd frontend && npx tsc -b`
Expected: 没有报错

---

### Task 6: 前端 · 匹配和累计的纯函数、切句带说话人、语音接上

**Files:**
- Create: `frontend/src/debug/plugins/emotionMatch.ts`
- Create: `frontend/src/debug/vn/useEmotionMatches.ts`
- Modify: `frontend/src/debug/vn/script.ts`(`TagHit.speaker`)
- Modify: `frontend/src/debug/plugins/voice.ts`(`spriteLabelAfter`、`planVoiceLines`、`missingEmotions`)

**Interfaces:**
- Consumes: Task 5 的 `api.emotionMatch`;`resolveByLabel`(`plugins/common.ts`)
- Produces:
  - `emotionMatch.ts`:`EmotionCandidate {key, label, aliases}`、`emotionCandidates(sprites)`、`candidatesSignature(c)`、`TagMatch`、`ModelEntry`、`TagResolver = (label: string) => TagMatch`、`matchTag(label, candidates, lookup)`、`normTag(label)`、`MAX_TAG_LEN = 40`、`isNpcHit(h, charName)`、`EmotionContext {resolve, rawOnFail, charName}`、`toRequestCandidate(c)`
  - `useEmotionMatches(labels, candidates): TagResolver`
  - `TagHit.speaker?: string | null`
  - `spriteLabelAfter(hits, ctx: EmotionContext, start)`、`planVoiceLines({lines, hits, emotionBefore, ctx, cast, streaming})`、`missingEmotions(labels: readonly string[], profile)`

- [ ] **Step 1: emotionMatch.ts**

```ts
/**
 * 立绘标签 → 这张卡的哪个表情。先精确匹配(名字 / 别名,不分大小写),对不上的交给
 * 后端模型挑列表里最像的(/api/emotion/match)。立绘层、占位框、语音、控制台都用这里。
 * 规则见 docs/superpowers/specs/2026-09-25-sprite-emotion-matching-design.md
 */

import type { CardSprite } from '../lib/api';
import type { TagHit } from '../vn/script';
import { resolveByLabel } from './common';
import { BUILTIN_EMOTIONS } from './emotions';

/** 一个能被匹配到的表情:有立绘时是一张立绘,没有时是一个内置表情 */
export interface EmotionCandidate {
  key: string;
  label: string;
  aliases: readonly string[];
}

export function emotionCandidates(sprites: readonly CardSprite[]): EmotionCandidate[] {
  if (sprites.length > 0) return sprites.map((s) => ({ key: s.id, label: s.label, aliases: s.aliases }));
  return BUILTIN_EMOTIONS.map((e) => ({ key: e.label, label: e.label, aliases: e.aliases }));
}

/** 候选变了(换卡、改立绘)结果就作废:缓存键里带着它 */
export const candidatesSignature = (candidates: readonly EmotionCandidate[]) =>
  candidates.map((c) => [c.key, c.label, ...c.aliases].join('\u0001')).join('\u0002');

/** 后端一次最多收 40 字的词,更长的不问 */
export const MAX_TAG_LEN = 40;
const MAX_NAMES = 20;

export const normTag = (label: string) => label.trim();

/** 发给后端的候选:名字 + 别名,去掉太长的,最多 20 个 */
export function toRequestCandidate(c: EmotionCandidate): { key: string; names: string[] } {
  const names = [c.label, ...c.aliases]
    .map((n) => n.trim())
    .filter((n) => n && n.length <= MAX_TAG_LEN)
    .slice(0, MAX_NAMES);
  return { key: c.key, names };
}

/** 后端的结果;出错时记下原因和时间(过一会儿再试) */
export type ModelEntry = { key: string; score: number } | { error: string; at: number };

export type TagMatch =
  | { state: 'exact'; label: string }
  | { state: 'model'; label: string; score: number }
  | { state: 'pending' }
  | { state: 'failed'; reason: string };

export type TagResolver = (label: string) => TagMatch;

export function matchTag(
  label: string,
  candidates: readonly EmotionCandidate[],
  lookup: (tag: string) => ModelEntry | undefined,
): TagMatch {
  const tag = normTag(label);
  if (!tag) return { state: 'failed', reason: '标签里没写表情' };
  const exact = resolveByLabel(tag, candidates);
  if (exact) return { state: 'exact', label: exact.label };
  if (tag.length > MAX_TAG_LEN) return { state: 'failed', reason: '标签太长' };
  const r = lookup(tag);
  if (!r) return { state: 'pending' };
  if ('error' in r) return { state: 'failed', reason: r.error };
  const c = candidates.find((x) => x.key === r.key);
  return c ? { state: 'model', label: c.label, score: r.score } : { state: 'pending' };
}

/** 标签后面紧跟的是另一个有名字的角色的台词:不切主角的立绘 */
export const isNpcHit = (h: TagHit, charName: string) =>
  h.kind === 'sprite' && typeof h.speaker === 'string' && h.speaker !== charName;

/** 累计表情时要的东西:查结果、没立绘时失败用原词、认 NPC 用的角色名 */
export interface EmotionContext {
  resolve: TagResolver;
  /** 这张卡一张立绘都没有:模型不可用时占位框 / 语音用 AI 写的原词(以前的行为) */
  rawOnFail: boolean;
  charName: string;
}
```

- [ ] **Step 2: useEmotionMatches.ts**

```ts
/**
 * 对不上立绘名的标签,批量问后端模型;结果放在整个页面共用的缓存里(重新进视觉小说
 * 不用再问),键 = 候选签名 + 标签。返回一个查询函数,结果回来后换成新函数,
 * 用到它的 useMemo 会跟着重算。
 */

import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { api } from '../lib/api';
import { resolveByLabel } from '../plugins/common';
import {
  candidatesSignature,
  matchTag,
  MAX_TAG_LEN,
  normTag,
  toRequestCandidate,
  type EmotionCandidate,
  type ModelEntry,
  type TagResolver,
} from '../plugins/emotionMatch';

const cache = new Map<string, ModelEntry>();
const inflight = new Set<string>();
/** 失败过的标签过这么久再问一次(后端重启了、刚装好模型) */
const RETRY_MS = 60_000;
/** 后端一次最多收 50 个 */
const BATCH = 50;

const keyOf = (sig: string, tag: string) => `${sig}\u0000${tag}`;

export function useEmotionMatches(
  labels: readonly string[],
  candidates: readonly EmotionCandidate[],
): TagResolver {
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  const sig = useMemo(() => candidatesSignature(candidates), [candidates]);

  // 要问的:精确匹配不上、长度合法的标签,去重
  const wanted = useMemo(() => {
    const out = new Set<string>();
    for (const l of labels) {
      const tag = normTag(l);
      if (!tag || tag.length > MAX_TAG_LEN || resolveByLabel(tag, candidates)) continue;
      out.add(tag);
    }
    return [...out];
  }, [labels, candidates]);

  useEffect(() => {
    const now = Date.now();
    const todo = wanted
      .filter((t) => {
        const k = keyOf(sig, t);
        if (inflight.has(k)) return false;
        const hit = cache.get(k);
        return !hit || ('error' in hit && now - hit.at > RETRY_MS);
      })
      .slice(0, BATCH);
    const request = candidates.map(toRequestCandidate).filter((c) => c.names.length > 0);
    if (todo.length === 0 || request.length === 0) return;
    const keys = todo.map((t) => keyOf(sig, t));
    keys.forEach((k) => inflight.add(k));
    api
      .emotionMatch({ tags: todo, candidates: request })
      .then((res) => {
        res.results.forEach((r, i) => cache.set(keys[i], { key: r.key, score: r.score }));
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        keys.forEach((k) => cache.set(k, { error, at: Date.now() }));
      })
      .finally(() => {
        keys.forEach((k) => inflight.delete(k));
        bump();
      });
  }, [wanted, sig, candidates, version]);

  return useCallback(
    (label: string) => matchTag(label, candidates, (tag) => cache.get(keyOf(sig, tag))),
    // version:结果回来后换一个新函数
    [candidates, sig, version],
  );
}
```

- [ ] **Step 3: script.ts 给标签带上说话人**

`TagHit` 加字段:

```ts
  /** 生效的那一句的说话人(旁白是 null);写在回复末尾的没有 */
  speaker?: string | null;
```

`parseReply` 第 3 步改成:

```ts
  // 3. 标签落到句子上:从「结束位置在标签之后」的第一句开始生效
  const hits: TagHit[] = tags.map((t) => {
    const lineIndex = spans.findIndex((s) => s.end > t.pos);
    return {
      kind: t.kind,
      raw: t.raw,
      label: t.label,
      lineIndex,
      speaker: lineIndex === -1 ? undefined : spans[lineIndex].speaker,
    };
  });
```

- [ ] **Step 4: voice.ts**

import:`resolveSprite` 那行换成 `import { isNpcHit, type EmotionContext } from './emotionMatch';`

```ts
/**
 * 和立绘层同一套算法:从 start 开始,一串立绘标签依次生效之后是哪个表情名。
 * 匹配到的(精确或模型)就切;还在问、模型不可用的保持上一个 —— 这张卡没立绘时,
 * 模型不可用就用标签里的原词。NPC 台词前的标签不算
 */
export function spriteLabelAfter(
  hits: readonly TagHit[],
  ctx: EmotionContext,
  start: string | null,
): string | null {
  let label = start;
  for (const h of hits) {
    if (h.kind !== 'sprite' || isNpcHit(h, ctx.charName)) continue;
    const m = ctx.resolve(h.label);
    if (m.state === 'exact' || m.state === 'model') label = m.label;
    else if (m.state === 'failed' && ctx.rawOnFail) label = h.label;
  }
  return label;
}

/**
 * 当前这条回复里每一句怎么念;不念的是 null。
 * 主声音的情绪 = 这句生效的表情(匹配之后的名字);其他声音不传情绪。
 * 影响这句的标签还在问模型时先不念(和流式没写完一样),免得用错的情绪合成进缓存
 */
export function planVoiceLines(o: {
  lines: readonly VNLine[];
  /** 这条回复的标签 */
  hits: readonly TagHit[];
  /** 这条回复第一句之前生效的表情(之前各条回复的立绘标签累计下来的) */
  emotionBefore: string | null;
  ctx: EmotionContext;
  cast: VoiceCast;
  /** 流式时最后一句还在写,写完才念 */
  streaming: boolean;
}): (SpeakRequest | null)[] {
  return o.lines.map((ln, i) => {
    if (o.streaming && i === o.lines.length - 1) return null;
    const profile = voiceForSpeaker(ln.speaker, o.ctx.charName, o.cast);
    if (!profile) return null;
    const text = cleanSpeech(ln.text);
    if (!hasSpeakable(text)) return null;
    if (profile.id !== o.cast.main?.id) return { profile_id: profile.id, emotion: null, text };
    const upTo = o.hits.filter(
      (h) => h.kind === 'sprite' && h.lineIndex !== -1 && h.lineIndex <= i && !isNpcHit(h, o.ctx.charName),
    );
    if (upTo.some((h) => o.ctx.resolve(h.label).state === 'pending')) return null;
    return { profile_id: profile.id, emotion: spriteLabelAfter(upTo, o.ctx, o.emotionBefore), text };
  });
}
```

`missingEmotions`:

```ts
/** 这张卡的表情(没立绘时是内置基础表情)里,哪些在主声音的情绪表里对不上(会用默认情绪念) */
export function missingEmotions(labels: readonly string[], profile: VoiceProfile | null): string[] {
  if (!profile) return [];
  const names = new Set(
    profile.emotions.flatMap((e) => [e.label, ...e.aliases]).map((n) => n.toLowerCase()),
  );
  return labels.filter((l) => !names.has(l.toLowerCase()));
}
```

`CardSprite` 的 import 如果不再用就删掉。

- [ ] **Step 5: 类型检查(会报 VNScreen / VoicePanel 的调用处,下一个任务改)**

Run: `cd frontend && npx tsc -b`
Expected: 只剩 `VNScreen.tsx`、`VoicePanel.tsx` 里调用 `spriteLabelAfter` / `planVoiceLines` / `missingEmotions` 的报错

---

### Task 7: 前端 · 视觉小说、控制台、插件页接上

**Files:**
- Modify: `frontend/src/debug/vn/VNScreen.tsx`
- Modify: `frontend/src/debug/components/VoicePanel.tsx:719`
- Modify: `frontend/src/debug/components/PluginsDrawer.tsx`(`SpriteSection`)

**Interfaces:**
- Consumes: Task 6 全部

- [ ] **Step 1: VNScreen 的匹配和累计**

import:删掉 `resolveSprite`;加

```ts
import { emotionCandidates, isNpcHit, type EmotionContext, type TagMatch } from '../plugins/emotionMatch';
import { useEmotionMatches } from './useEmotionMatches';
```

`hitsSoFar` 之后、`spriteView` 之前加:

```ts
  // ---- 立绘标签 → 表情:先精确匹配,对不上的问后端模型 ----

  const candidates = useMemo(() => emotionCandidates(sprites), [sprites]);
  const spriteLabels = useMemo(
    () =>
      beats
        .flatMap((b) => b.parsed?.hits ?? [])
        .filter((h) => h.kind === 'sprite' && !isNpcHit(h, charName))
        .map((h) => h.label),
    [beats, charName],
  );
  const resolveTag = useEmotionMatches(spriteLabels, candidates);
  const emotionCtx: EmotionContext = useMemo(
    () => ({ resolve: resolveTag, rawOnFail: sprites.length === 0, charName }),
    [resolveTag, sprites.length, charName],
  );
```

`spriteView` 换成:

```ts
  const spriteView: SpriteView = useMemo(() => {
    // 对不上、还在问模型的标签不切图,保持上一张 —— 控制台里会写原因
    const label = spriteLabelAfter(hitsSoFar, emotionCtx, sprites[0]?.label ?? null);
    const matched = sprites.find((s) => s.label === label) ?? sprites[0] ?? null;
    if (matched) {
      return { key: matched.id + (matched.has_image ? `:${matched.image_version}` : ''), src: spriteImageUrl(matched), label: matched.label };
    }
    // 这张卡一张立绘都没配:占位长方形上写匹配到的内置表情(模型不可用时是 AI 的原词)
    return { key: `ph:${label ?? ''}`, src: null, label: label ?? '未配置立绘' };
  }, [hitsSoFar, sprites, emotionCtx]);
```

`emotionBefore`:

```ts
    return spriteLabelAfter(prior, emotionCtx, sprites[0]?.label ?? null);
  }, [beats, beatIndex, sprites, emotionCtx]);
```

`voicePlans`:

```ts
      planVoiceLines({
        lines: beatParsed?.lines ?? [],
        hits: beatParsed?.hits ?? [],
        emotionBefore,
        ctx: emotionCtx,
        cast: voiceCast,
        streaming,
      }),
    [beatParsed, emotionBefore, emotionCtx, voiceCast, streaming],
```

`backlog` 里同样:`planVoiceLines({ lines: p.lines, hits: p.hits, emotionBefore: label, ctx: emotionCtx, cast: voiceCast, streaming: Boolean(b.entry.streaming) })`,`label = spriteLabelAfter(p.hits, emotionCtx, label);`,依赖数组把 `sprites, charName` 换成 `sprites, emotionCtx`。

- [ ] **Step 2: 控制台**

`<ConsoleView` 多传 `emotion={emotionCtx}`;`ConsoleView` 的 props 加 `emotion: EmotionContext`。`resolve` 的 sprite 分支换成:

```ts
        if (kind === 'sprite') return describeMatch(emotion.resolve(label), sprites);
```

依赖数组加 `emotion`。表格里算 `r` 那行换成:

```ts
                  const r =
                    h.kind === 'sprite' && isNpcHit(h, emotion.charName)
                      ? { ok: true, text: `— 「${h.speaker}」的台词,不切立绘` }
                      : resolve(h.kind, h.label);
```

`ConsoleView` 上面加:

```ts
/** 控制台里一个立绘标签的匹配结果 */
function describeMatch(m: TagMatch, sprites: readonly CardSprite[]): { ok: boolean; text: string } {
  const noImage = (label: string) => {
    const s = sprites.find((x) => x.label === label);
    return s && !s.has_image ? '(还没传图)' : '';
  };
  const where = sprites.length === 0 ? '内置表情' : '';
  switch (m.state) {
    case 'exact':
      return { ok: true, text: `✓ ${where}${m.label}${noImage(m.label)}` };
    case 'model':
      return { ok: true, text: `≈ ${where}${m.label}(模型 ${m.score.toFixed(2)})${noImage(m.label)}` };
    case 'pending':
      return { ok: true, text: '… 识别中' };
    case 'failed':
      return {
        ok: false,
        text: `✗ ${m.reason},${sprites.length === 0 ? '占位框写原词' : '保持上一张'}`,
      };
  }
}
```

- [ ] **Step 3: VoicePanel**

import 加 `BUILTIN_EMOTIONS`(`../plugins/emotions`);719 行换成:

```ts
  const missing = missingEmotions(
    sprites.length > 0 ? sprites.map((s) => s.label) : BUILTIN_EMOTIONS.map((e) => e.label),
    cast.main,
  );
```

- [ ] **Step 4: 插件页的模型状态**

`PluginsDrawer.tsx`:import 加 `api`、`type EmotionStatus`(`../lib/api`)。`SpriteSection` 里 `<ConfigGroups … />` 后面放 `<EmotionModelStatus />`,组件:

```tsx
/** 情绪识别模型装没装:对不上立绘名的标签靠它挑最像的 */
function EmotionModelStatus() {
  const [status, setStatus] = useState<EmotionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .emotionStatus()
      .then((s) => alive && setStatus(s))
      .catch((e: unknown) => alive && setError(errText(e)));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="sp-group">
      <div className="sp-group-head">
        <span className="sp-group-title">情绪识别</span>
        <span className="sp-group-note">
          AI 写的表情对不上立绘名时,用模型挑列表里最像的一张。
        </span>
      </div>
      {error ? (
        <span className="pl-error">查不到模型状态:{error}</span>
      ) : !status ? (
        <span className="sp-group-note">检查中…</span>
      ) : status.ready ? (
        <span className="sp-group-note">模型已就绪({status.model})</span>
      ) : (
        <span className="pl-error">
          {status.detail}。在 AnimaBackend 里运行 <code className="pl-code">python scripts/download_emotion_model.py</code>。
          不装也能用,只是对不上列表的表情不会切图。
        </span>
      )}
    </div>
  );
}
```

`SpriteSection` 里 `promptNote` 的文案加上 `{{sprite_examples}}`:「{'{{sprites}}'} 会展开成当前角色卡的表情列表(没配立绘时是内置基础表情),{'{{sprite_tag}}'} 展开成标签示例,{'{{sprite_examples}}'} 展开成正误示范。」;`previews` 加 `{ name: 'sprite_examples', value: macros.sprite_examples }`。

- [ ] **Step 5: 构建和 lint**

Run: `cd frontend && npm run build && npm run lint`
Expected: build 成功;lint 没有新增的问题

---

### Task 8: 实测和收尾

- [ ] **Step 1: 后端全部测试**

Run: `cd AnimaBackend && .venv/Scripts/python.exe -m pytest -q`
Expected: 全部通过

- [ ] **Step 2: 浏览器实测**(先备份 `plugin.*`:`GET /api/settings/plugin.sprite` 等,记下原值)

1. `start.bat` 起前后端;调试台 → 插件 → 立绘:看到「模型已就绪」、`{{sprites}}` / `{{sprite_examples}}` 的预览
2. 选一张有立绘的卡(阿米娅),进视觉小说;控制台里用已有对话看标签:精确的是 ✓,对不上的变成 ≈ 加相似度,立绘跟着切
3. 选一张没立绘的卡:占位框写内置表情名
4. 把 `EMOTION_MODEL_DIR` 指到一个空目录重启后端:插件页标红提示怎么装;对不上的标签控制台写「✗ 情绪识别模型没装…,保持上一张」,视觉小说照常能用。改回来
5. 恢复 `plugin.*` 原值(只要实测时动过)

- [ ] **Step 3: 文档**

- 设计文档状态改成「已实现(2026-09-25,未提交)」,实现和设计有出入的写在本计划开头
- `docs/voice-server.md` 进度里「补情绪参考音频」那条补一句:没立绘的卡也能用内置基础表情补齐情绪行
