# 语音 · 接入 IndexTTS-2.5 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AnimaVN 多一个语音引擎 IndexTTS-2.5:声音填一段音色参考,每个情绪行用 8 维向量或一段情绪参考控制语气,和 GSV 并存。

**Architecture:** 后端新增 `app/tts/indextts.py`(HTTP 客户端,对面是台式机上我们自己写的小服务)和 `app/tts/emotion_presets.py`(向量校验 + 默认向量表);`voice_profiles` / `voice_emotions` 各加一列;`_voice_for` 按引擎分别组装合成配置。前端「语音」页按引擎显示不同的字段,新增向量编辑器;控制台显示每句的情绪来源。

**Tech Stack:** FastAPI + SQLAlchemy 2(SQLite)+ httpx;React 19 + TypeScript + Vite。

设计文档:`docs/superpowers/specs/2026-09-24-indextts-engine-design.md`(小服务接口以它为准)。环境:`docs/voice-server.md`。

## Global Constraints

- **不要提交**。仓库里还有别的会话没提交的改动;要提交先问用户,commit 信息里**不加** `Co-Authored-By: Claude`
- 别的会话可能同时在改 `frontend/src/debug/**`、`debug.css`:改之前重新读要改的那一段,用小范围的 Edit,不要整文件覆盖
- 后端测试:`cd AnimaBackend && .venv/Scripts/python.exe -m pytest -q`(基线 155 passed)
- 前端验证:`cd frontend && npm run build && npm run lint`(没有测试框架,规则写成 `plugins/voice.ts` 里的纯函数)
- 界面文字、报错、注释用中文,和现有代码一个口吻;标识符用英文
- 浏览器实测不能弄乱用户的真实数据:测试用的语音服务和声音测完删掉;改过卡的主声音要改回去
- 小服务:`GET /health`、`POST /tts`,端口 9890;字段见设计文档「小服务接口」
- 默认值:情绪强度 `emo_alpha` **0.6**(0–1);向量 8 维,每维 **0–1.2**,合计不超过 **1.5**,全 0 存成空;`duration_factor = 1 / speed`,限制在 **0.5–2.0**,保留 3 位小数;超时:冷启动 **90** 秒、正常 **30** 秒、测试连接 **5** 秒
- 向量顺序:**[高兴, 愤怒, 悲伤, 害怕, 厌恶, 忧郁, 惊讶, 平静]**

### 和设计文档的出入

| 设计文档 | 这里 | 原因 |
|---|---|---|
| `TTSEngine` 协议加 `check()` | 不加。`app/api/tts.py` 里 `_gsv_spec` / `_indextts_spec` 各自组装、各自检查 | 组装本来就要按引擎分开写,检查和组装放在一起更好读;报错文案不变 |
| 向量编辑器:8 格一行,窄屏(媒体查询 560px)4 格 | 标签、格子、合计各占一行;格子默认 4 列两行,编辑器本身宽于 330px 时 8 列一行(容器查询);去掉数字框的上下箭头 | 实测插件抽屉里编辑器只有 150–260px 宽,和屏幕宽度无关;原来的写法把 8 格挤进了 27px |
| (没提) | IndexTTS 连接的地址框占位提示是 `http://127.0.0.1:9890` | 原来两种引擎都显示 9880 |

### 实现时又改的(2026-09-24)

- 浏览器实测用 scratchpad 里的假服务(正弦波);测完删掉了测试用的语音服务、声音,以及 3 条假音频缓存 —— 不删的话,以后用同样的音色参考和默认试听文本试听会直接命中缓存,播出正弦波

## 文件结构

后端(`AnimaBackend/`):

| 文件 | 职责 |
|---|---|
| `app/models.py` | `VoiceProfile.ref_path`、`VoiceEmotion.emo_vector` |
| `scripts/migrate_voice_indextts_columns.py`(新) | 给旧库补上面两列 |
| `app/tts/emotion_presets.py`(新) | `EMO_DIMS`、`clean_emo_vector`、默认向量表、`preset_vector` |
| `app/tts/base.py` | `VoiceSpec` 加 `spk_ref_path`、`emo_vector` |
| `app/tts/indextts.py`(新) | `IndexTtsEngine`、`duration_factor`、`emo_mode` |
| `app/tts/registry.py` | `DEFAULT_EMO_ALPHA`、`emo_alpha_of`、`indextts` 分支 |
| `app/schemas.py` | 新字段、`VoiceFromSpritesIn` |
| `app/api/tts.py` | 连接的 `api_type` / `emo_alpha`;按引擎组装;`X-TTS-Emo-Mode` |
| `app/api/voices.py` | 新字段的增改;按立绘补齐;refs.json 新字段 |
| `app/main.py` | CORS 暴露 `X-TTS-Emo-Mode` |
| `tests/conftest.py` | `FakeIndexTts` + `index_tts` fixture |
| `tests/test_tts_indextts.py`(新)、`tests/test_emotion_presets.py`(新) | 引擎、向量表 |
| `tests/test_tts_api.py`、`tests/test_voices_api.py`、`tests/test_migration_scripts.py` | 接口、迁移 |

前端(`frontend/src/debug/`):

| 文件 | 职责 |
|---|---|
| `lib/api.ts` | 类型、`fillVoiceEmotionsFromSprites`、`speak()` 读 `X-TTS-Emo-Mode` |
| `plugins/voice.ts` | `EMO_DIMS`、`emoVectorProblem`、`EMO_MODE_TEXT` |
| `components/EmotionVectorEditor.tsx`(新) | 8 维向量编辑器 |
| `components/VoicePanel.tsx` | 按引擎显示字段;按立绘补齐 |
| `debug.css` | 向量编辑器的样式 |
| `vn/voice.ts`、`vn/VNScreen.tsx` | `ClipState.mode`;控制台「方式」一列 |

---

### Task 1: 数据列、迁移、向量校验、连接和声音接口带上新字段

**Files:**
- Modify: `AnimaBackend/app/models.py`(`VoiceProfile`、`VoiceEmotion`)
- Create: `AnimaBackend/scripts/migrate_voice_indextts_columns.py`
- Create: `AnimaBackend/app/tts/emotion_presets.py`(这一步只放校验)
- Modify: `AnimaBackend/app/tts/registry.py`(`DEFAULT_EMO_ALPHA`、`emo_alpha_of`)
- Modify: `AnimaBackend/app/schemas.py`、`AnimaBackend/app/api/tts.py`、`AnimaBackend/app/api/voices.py`
- Test: `AnimaBackend/tests/test_migration_scripts.py`、`tests/test_voices_api.py`、`tests/test_tts_api.py`

**Interfaces:**
- Produces: `clean_emo_vector(raw: list[float] | None) -> list[float] | None`(不合格抛 `ValueError`,信息可以直接给人看);`EMO_DIMS: tuple[str, ...]`;`emo_alpha_of(conn: TtsConnection) -> float`;`DEFAULT_EMO_ALPHA = 0.6`;接口字段 `voice.ref_path`、`emotion.emo_vector`、`connection.emo_alpha`、`connection.api_type ∈ {"gpt_sovits", "indextts"}`

- [ ] **Step 1: 写失败的测试**

`tests/test_migration_scripts.py` 末尾加两个测试,并把新脚本加进最后那个 `parametrize` 列表:

```python
def test_voice_indextts_migration_adds_speaker_ref_and_vector(tmp_path: Path):
    db_path = database(tmp_path)
    with sqlite3.connect(db_path) as db:
        db.execute("CREATE TABLE voice_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL)")
        db.execute("CREATE TABLE voice_emotions (id TEXT PRIMARY KEY, label TEXT NOT NULL)")
        db.execute("INSERT INTO voice_profiles (id, name) VALUES ('p1', '阿米娅')")
        db.execute("INSERT INTO voice_emotions (id, label) VALUES ('e1', '平静')")
        db.commit()

    run_twice(tmp_path, "migrate_voice_indextts_columns.py")

    assert columns(db_path, "voice_profiles") == ["id", "name", "ref_path"]
    assert columns(db_path, "voice_emotions") == ["id", "label", "emo_vector"]
    with sqlite3.connect(db_path) as db:
        assert db.execute("SELECT id, name, ref_path FROM voice_profiles").fetchall() == [
            ("p1", "阿米娅", "")
        ]
        assert db.execute("SELECT id, label, emo_vector FROM voice_emotions").fetchall() == [
            ("e1", "平静", None)
        ]


def test_voice_indextts_migration_skips_missing_tables(tmp_path: Path):
    database(tmp_path)
    result = run_script(tmp_path, "migrate_voice_indextts_columns.py")
    assert result.returncode == 0, result.stderr
```

```python
@pytest.mark.parametrize(
    "script",
    [
        "migrate_connection_cache_columns.py",
        "migrate_connection_stream_column.py",
        "migrate_chat_parent_columns.py",
        "migrate_voice_indextts_columns.py",
    ],
)
```

`tests/test_voices_api.py` 末尾:

```python
def test_indextts_fields_speaker_ref_and_emotion_vector(client: TestClient):
    v = make_voice(client, make_conn(client)["id"], ref_path=' "D:/refs/阿米娅/平静.wav" ')
    assert v["ref_path"] == "D:/refs/阿米娅/平静.wav"
    base = f"/api/voices/{v['id']}/emotions"

    happy = client.post(base, json={"label": "开心", "emo_vector": [0.8, 0, 0, 0, 0, 0, 0, 0]})
    assert happy.status_code == 200, happy.text
    assert happy.json()["emo_vector"] == [0.8, 0, 0, 0, 0, 0, 0, 0]
    # 全 0 = 不控制,存成空
    assert client.post(base, json={"label": "平静", "emo_vector": [0] * 8}).json()["emo_vector"] is None

    eid = happy.json()["id"]
    sad = [0, 0, 0.5, 0, 0, 0.3, 0, 0]
    assert client.put(f"{base}/{eid}", json={"emo_vector": sad}).json()["emo_vector"] == sad
    # 只改名字不动向量
    assert client.put(f"{base}/{eid}", json={"label": "高兴"}).json()["emo_vector"] == sad
    assert client.put(f"{base}/{eid}", json={"emo_vector": None}).json()["emo_vector"] is None

    r = client.put(f"/api/voices/{v['id']}", json={"ref_path": "D:/refs/b.wav"})
    assert r.json()["ref_path"] == "D:/refs/b.wav"


def test_emotion_vector_is_validated(client: TestClient):
    v = make_voice(client, make_conn(client)["id"])
    base = f"/api/voices/{v['id']}/emotions"
    cases = [
        ([0.5] * 7, "情绪向量要正好 8 个数(现在是 7 个)"),
        ([1.3, 0, 0, 0, 0, 0, 0, 0], "「高兴」要在 0 到 1.2 之间"),
        ([0, -0.1, 0, 0, 0, 0, 0, 0], "「愤怒」要在 0 到 1.2 之间"),
        ([0.8, 0.8, 0, 0, 0, 0, 0, 0], "情绪向量合计 1.60,不能超过 1.5"),
    ]
    for vec, detail in cases:
        r = client.post(base, json={"label": "x", "emo_vector": vec})
        assert (r.status_code, r.json()["detail"]) == (400, detail)
    assert client.get("/api/voices").json()[0]["emotions"] == []
```

`tests/test_tts_api.py` 末尾:

```python
def test_indextts_connection_keeps_emotion_strength(client: TestClient):
    conn = make_conn(client, name="IndexTTS", api_type="indextts", base_url="http://index.test:9890")
    assert (conn["api_type"], conn["emo_alpha"]) == ("indextts", 0.6)
    r = client.put(f"/api/tts/connections/{conn['id']}", json={"emo_alpha": 0.8})
    assert r.status_code == 200
    assert r.json()["emo_alpha"] == 0.8
    assert client.get("/api/tts/connections").json()[0]["emo_alpha"] == 0.8
    assert client.put(f"/api/tts/connections/{conn['id']}", json={"emo_alpha": 1.5}).status_code == 422
    # GSV 也返回这个字段,只是用不到
    assert make_conn(client)["emo_alpha"] == 0.6
    bad = client.post(
        "/api/tts/connections", json={"name": "x", "base_url": "http://a.test:1", "api_type": "edge"}
    )
    assert bad.status_code == 422
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd AnimaBackend && .venv/Scripts/python.exe -m pytest -q tests/test_migration_scripts.py tests/test_voices_api.py tests/test_tts_api.py`
Expected: 新加的几个 FAIL(脚本不存在、`ref_path` / `emo_vector` / `emo_alpha` 这些键不存在、`api_type` 不接受 `indextts`)

- [ ] **Step 3: 实现**

`app/tts/emotion_presets.py`(新文件):

```python
"""IndexTTS 的情绪向量:校验,以及「立绘表情名 → 默认向量」这张表。

向量 8 维,顺序是 IndexTTS 官方定的。每维 0–1.2,合计不超过 1.5 —— 再高会明显影响
音色相似度(见 docs/superpowers/specs/2026-09-24-indextts-engine-design.md)。
"""

EMO_DIMS = ("高兴", "愤怒", "悲伤", "害怕", "厌恶", "忧郁", "惊讶", "平静")
DIM_MAX = 1.2
SUM_MAX = 1.5


def clean_emo_vector(raw: list[float] | None) -> list[float] | None:
    """校验并规整成 3 位小数。全 0 等于不控制,存成 None。不合格抛 ValueError,说明是哪一项。"""
    if raw is None:
        return None
    if len(raw) != len(EMO_DIMS):
        raise ValueError(f"情绪向量要正好 {len(EMO_DIMS)} 个数(现在是 {len(raw)} 个)")
    out: list[float] = []
    for name, value in zip(EMO_DIMS, raw):
        v = float(value)
        # NaN 两边都不成立,也会落到这里
        if not 0 <= v <= DIM_MAX:
            raise ValueError(f"「{name}」要在 0 到 {DIM_MAX} 之间")
        out.append(round(v, 3))
    total = sum(out)
    if total > SUM_MAX + 1e-9:
        raise ValueError(f"情绪向量合计 {total:.2f},不能超过 {SUM_MAX}")
    return out if total > 0 else None
```

`app/models.py`,`VoiceProfile` 里 `sovits_weights` 下面加:

```python
    # IndexTTS 的音色参考(语音服务那台机器上的路径)。GSV 不用:音色在权重里
    ref_path: Mapped[str] = mapped_column(String(500), default="")
```

`VoiceEmotion` 的类说明末尾补一段,并在 `prompt_text` 下面加列:

```python
    """声音的一种情绪 = 一段参考音频 + 它的原文。GPT-SoVITS 的语气跟着参考音频走,
    所以换情绪就是换参考。

    IndexTTS 的声音:ref_path 是可选的情绪参考(可以是别的角色的声音),不需要原文;
    没填情绪参考时用 emo_vector,两个都没有就沿用音色参考的语气。

    label / aliases 和立绘的表情名对应:这句生效的立绘表情是「开心」,就用叫「开心」的
    这一行;对不上就用排第一的(默认)。
    """
```

```python
    # IndexTTS 的 8 维情绪向量 [高兴, 愤怒, 悲伤, 害怕, 厌恶, 忧郁, 惊讶, 平静];空 = 不用向量
    emo_vector: Mapped[list | None] = mapped_column(JSON, nullable=True, default=None)
```

`scripts/migrate_voice_indextts_columns.py`(新文件):

```python
"""One-off dev migration: the two IndexTTS columns.

voice_profiles.ref_path (speaker reference) and voice_emotions.emo_vector
(8-dim emotion vector). A fresh database gets them from create_all; this only
patches databases that already have the voice tables. Safe to run twice.
"""

import sqlite3

db = sqlite3.connect("data/animabackend.db")


def add(table: str, column: str, ddl: str) -> None:
    cols = {r[1] for r in db.execute(f"PRAGMA table_info({table})")}
    if not cols:
        print(f"{table} missing, skipped (create_all will build it)")
    elif column in cols:
        print(f"{table}.{column} already present")
    else:
        db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
        print(f"added {table}.{column}")


add("voice_profiles", "ref_path", "VARCHAR(500) NOT NULL DEFAULT ''")
add("voice_emotions", "emo_vector", "JSON")
db.commit()
```

`app/tts/registry.py`,在 `_engines` 上面加(`engine_for` 这一步先不动):

```python
DEFAULT_EMO_ALPHA = 0.6


def emo_alpha_of(conn: TtsConnection) -> float:
    """IndexTTS 的情绪强度,存在连接的 options 里;老数据没有就用默认 0.6。"""
    v = (conn.options or {}).get("emo_alpha")
    return float(v) if isinstance(v, (int, float)) else DEFAULT_EMO_ALPHA
```

`app/schemas.py` 语音那一节:

```python
TtsApiType = Literal["gpt_sovits", "indextts"]


class TtsConnectionIn(BaseModel):
    name: str
    api_type: TtsApiType = "gpt_sovits"
    base_url: str
    sample_steps: int = Field(default=64, ge=4, le=128)
    # IndexTTS 的情绪强度;GSV 不用
    emo_alpha: float = Field(default=0.6, ge=0, le=1)


class TtsConnectionUpdate(BaseModel):
    name: str | None = None
    base_url: str | None = None
    sample_steps: int | None = Field(default=None, ge=4, le=128)
    emo_alpha: float | None = Field(default=None, ge=0, le=1)


class TtsConnectionOut(BaseModel):
    id: str
    name: str
    api_type: TtsApiType
    base_url: str
    sample_steps: int
    emo_alpha: float
    # 用这个服务的声音有几个 —— 删之前心里有数
    profile_count: int
```

`VoiceEmotionIn` / `VoiceEmotionUpdate` / `VoiceEmotionOut` 各加一行(Update 里 `None` 表示清空,是否传了靠 `exclude_unset` 判断):

```python
    emo_vector: list[float] | None = None
```

```python
    emo_vector: list[float] | None
```
(后一行加在 `VoiceEmotionOut` 的 `prompt_text` 下面)

`VoiceProfileIn` 加 `ref_path: str = ""`,`VoiceProfileUpdate` 加 `ref_path: str | None = None`,`VoiceProfileOut` 在 `sovits_weights` 下面加 `ref_path: str`。

`app/api/tts.py`:`from app.tts.registry import emo_alpha_of, engine_for, forget_engine`;`_conn_out` 里 `sample_steps=...` 下面加 `emo_alpha=emo_alpha_of(conn),`;`create_connection` 的构造里加 `options={"emo_alpha": req.emo_alpha},`;`update_connection` 里 `sample_steps` 那段下面加:

```python
    if req.emo_alpha is not None:
        # JSON 列要整个换掉,原地改 SQLAlchemy 看不出变化
        conn.options = {**(conn.options or {}), "emo_alpha": req.emo_alpha}
```

`app/api/voices.py`:
- `from app.tts.emotion_presets import clean_emo_vector`
- 加一个小工具(放在 `clean_path` 下面):

```python
def clean_vector(raw: list[float] | None) -> list[float] | None:
    try:
        return clean_emo_vector(raw)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
```

- `_emotion_out` 加 `emo_vector=list(e.emo_vector) if e.emo_vector else None,`
- `_profile_out` 加 `ref_path=p.ref_path,`
- `create_profile` 的构造里加 `ref_path=clean_path(req.ref_path),`
- `update_profile` 里 `for key in ("gpt_weights", "sovits_weights"):` 改成 `for key in ("gpt_weights", "sovits_weights", "ref_path"):`
- `create_emotion` 的构造里加 `emo_vector=clean_vector(req.emo_vector),`
- `update_emotion` 里 `prompt_text` 那段下面加:

```python
    if "emo_vector" in u:
        emotion.emo_vector = clean_vector(u["emo_vector"])
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `cd AnimaBackend && .venv/Scripts/python.exe -m pytest -q`
Expected: 全部通过(155 + 7 个新的)

- [ ] **Step 5: 给本机的库跑迁移**

Run: `cd AnimaBackend && .venv/Scripts/python.exe scripts/migrate_voice_indextts_columns.py`
Expected: `added voice_profiles.ref_path`、`added voice_emotions.emo_vector`(已经跑过的话是 `already present`)。后端要是开着,跑完重启一下

---

### Task 2: 默认向量表、按立绘表情补齐情绪行

**Files:**
- Modify: `AnimaBackend/app/tts/emotion_presets.py`
- Modify: `AnimaBackend/app/schemas.py`(`VoiceFromSpritesIn`)、`AnimaBackend/app/api/voices.py`
- Test: `AnimaBackend/tests/test_emotion_presets.py`(新)、`tests/test_voices_api.py`

**Interfaces:**
- Consumes: Task 1 的 `EMO_DIMS`、`clean_emo_vector`、`connection.api_type`
- Produces: `preset_vector(names: list[str]) -> list[float] | None`;`POST /api/voices/{profile_id}/emotions/from-sprites {card_id}` → `list[VoiceEmotionOut]`

- [ ] **Step 1: 写失败的测试**

`tests/test_emotion_presets.py`(新文件):

```python
from app.tts.emotion_presets import PRESETS, clean_emo_vector, dims_to_vector, preset_vector


def test_preset_vector_by_name_then_alias():
    assert preset_vector(["开心"]) == [0.8, 0, 0, 0, 0, 0, 0, 0]
    assert preset_vector(["Happy"]) == [0.8, 0, 0, 0, 0, 0, 0, 0]
    # 立绘名不在表里,按别名:阿米娅的「红瞳」别名里有 angry
    assert preset_vector(["红瞳", "angry", "生气"]) == [0, 0.7, 0, 0, 0, 0, 0, 0]
    assert preset_vector(["慌张", "flustered", "害羞"]) == [0, 0, 0, 0.4, 0, 0, 0.4, 0]
    # 平静 / 说话 = 不控制;表里没有的(琴柳的「持旗」)也是不控制
    assert preset_vector(["平静", "normal"]) is None
    assert preset_vector(["说话", "talk"]) is None
    assert preset_vector(["持旗", "flag"]) is None


def test_every_preset_passes_validation():
    for _names, dims in PRESETS:
        if dims:
            vec = dims_to_vector(dims)
            assert clean_emo_vector(vec) == vec
```

`tests/test_voices_api.py` 末尾:

```python
def test_emotions_from_sprites_adds_missing_rows_with_preset_vectors(client: TestClient, make_card):
    conn = client.post(
        "/api/tts/connections",
        json={"name": "IndexTTS", "api_type": "indextts", "base_url": "http://127.0.0.1:9890"},
    ).json()
    v = make_voice(client, conn["id"], name="阿米娅·Index")
    card = make_card(name="阿米娅")
    sprites = f"/api/tavern/cards/{card['id']}/sprites"
    for label, aliases in [("平静", ["normal"]), ("开心", ["happy"]), ("红瞳", ["angry"]), ("持旗", [])]:
        assert client.post(sprites, json={"label": label, "aliases": aliases}).status_code == 200
    # 已经有的(按立绘别名也算对上)不动
    client.post(f"/api/voices/{v['id']}/emotions", json={"label": "happy", "ref_path": "D:/emo/笑.wav"})

    r = client.post(f"/api/voices/{v['id']}/emotions/from-sprites", json={"card_id": card["id"]})
    assert r.status_code == 200, r.text
    assert [(e["label"], e["emo_vector"], e["ref_path"]) for e in r.json()] == [
        ("happy", None, "D:/emo/笑.wav"),
        ("平静", None, ""),
        ("红瞳", [0, 0.7, 0, 0, 0, 0, 0, 0], ""),
        ("持旗", None, ""),
    ]
    # 再点一次什么也不加
    again = client.post(f"/api/voices/{v['id']}/emotions/from-sprites", json={"card_id": card["id"]})
    assert len(again.json()) == 4


def test_emotions_from_sprites_rejects_gsv_voices_and_unknown_cards(client: TestClient, make_card):
    v = make_voice(client, make_conn(client)["id"])
    card = make_card()
    r = client.post(f"/api/voices/{v['id']}/emotions/from-sprites", json={"card_id": card["id"]})
    assert (r.status_code, r.json()["detail"]) == (400, "GSV 的情绪行要配参考音频,不能自动生成")
    conn = client.post(
        "/api/tts/connections",
        json={"name": "IndexTTS", "api_type": "indextts", "base_url": "http://127.0.0.1:9890"},
    ).json()
    iv = make_voice(client, conn["id"], name="琴柳")
    r = client.post(f"/api/voices/{iv['id']}/emotions/from-sprites", json={"card_id": "nope"})
    assert r.status_code == 404
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd AnimaBackend && .venv/Scripts/python.exe -m pytest -q tests/test_emotion_presets.py tests/test_voices_api.py`
Expected: FAIL(`preset_vector` 不存在,接口 404 / 405)

- [ ] **Step 3: 实现**

`app/tts/emotion_presets.py` 末尾追加:

```python
# 表情名 / 别名 → 默认向量(没写的维度是 0;None = 不控制,沿用音色参考的语气)。
# 只是起点,要以用户试听为准
PRESETS: list[tuple[tuple[str, ...], dict[str, float] | None]] = [
    (("平静", "normal", "calm", "neutral", "说话", "talk", "默认"), None),
    (("微笑", "smile"), {"高兴": 0.4, "平静": 0.4}),
    (("开心", "高兴", "happy"), {"高兴": 0.8}),
    (("温柔", "gentle"), {"高兴": 0.3, "平静": 0.5}),
    (("认真", "serious"), {"愤怒": 0.1, "平静": 0.6}),
    (("担心", "worried"), {"害怕": 0.4, "忧郁": 0.3}),
    (("难过", "伤心", "sad"), {"悲伤": 0.8}),
    (("哭", "cry"), {"悲伤": 1.0}),
    (("惊讶", "surprised"), {"惊讶": 0.8}),
    (("慌张", "flustered"), {"害怕": 0.4, "惊讶": 0.4}),
    (("害羞", "脸红", "shy"), {"高兴": 0.3, "害怕": 0.3}),
    (("疑惑", "confused"), {"惊讶": 0.4, "平静": 0.3}),
    (("生气", "angry"), {"愤怒": 0.7}),
    (("害怕", "afraid", "scared"), {"害怕": 0.8}),
    (("厌恶", "嫌弃", "disgusted"), {"厌恶": 0.7}),
    (("忧郁", "失落", "melancholic"), {"忧郁": 0.7}),
]
_BY_NAME = {n.casefold(): dims for names, dims in PRESETS for n in names}


def dims_to_vector(dims: dict[str, float]) -> list[float]:
    return [dims.get(name, 0.0) for name in EMO_DIMS]


def preset_vector(names: list[str]) -> list[float] | None:
    """立绘表情名在前、别名在后,第一个在表里的为准;都不在表里 → None(不控制)。"""
    for n in names:
        key = n.strip().casefold()
        if key in _BY_NAME:
            dims = _BY_NAME[key]
            return dims_to_vector(dims) if dims else None
    return None
```

`app/schemas.py`,`VoiceImportIn` 下面加:

```python
class VoiceFromSpritesIn(BaseModel):
    """按这张卡的立绘表情补齐情绪行(只对 IndexTTS 的声音)。"""

    card_id: str
```

`app/api/voices.py`:
- import 里加 `CardSprite`(`from app.models import CardSprite, CardVoice, ...`)、`VoiceFromSpritesIn`、`from app.tts.emotion_presets import clean_emo_vector, preset_vector`
- 在 `reorder_emotions` 下面加:

```python
@router.post(
    PROFILES + "/{profile_id}/emotions/from-sprites", response_model=list[VoiceEmotionOut]
)
def emotions_from_sprites(profile_id: str, req: VoiceFromSpritesIn, db: Session = Depends(get_db)):
    """每个立绘表情一行,向量按常见表情名预填;已有的行(名字或别名对上)不动,只加缺的。"""
    profile = _load_profile(profile_id, db)
    conn = db.get(TtsConnection, profile.connection_id)
    if conn is None or conn.api_type != "indextts":
        raise HTTPException(400, "GSV 的情绪行要配参考音频,不能自动生成")
    _load_card(req.card_id, db)
    sprites = db.scalars(
        select(CardSprite)
        .where(CardSprite.card_id == req.card_id)
        .order_by(CardSprite.sort, CardSprite.created_at)
    ).all()
    existing = list_emotions(profile_id, db)
    taken = {n.casefold() for e in existing for n in [e.label, *(e.aliases or [])]}
    next_sort = max((e.sort for e in existing), default=-1) + 1
    for s in sprites:
        names = [s.label, *(s.aliases or [])]
        if any(n.casefold() in taken for n in names):
            continue
        db.add(
            VoiceEmotion(
                profile_id=profile_id,
                label=s.label,
                aliases=[],
                emo_vector=preset_vector(names),
                sort=next_sort,
            )
        )
        next_sort += 1
        taken.add(s.label.casefold())
    db.commit()
    return [_emotion_out(e) for e in list_emotions(profile_id, db)]
```

(`_load_card` 定义在同一个文件后面的「卡的绑定」一节,运行时调用没问题)

- [ ] **Step 4: 跑测试,确认通过**

Run: `cd AnimaBackend && .venv/Scripts/python.exe -m pytest -q`
Expected: 全部通过

---

### Task 3: IndexTTS 引擎和假服务

**Files:**
- Modify: `AnimaBackend/app/tts/base.py`
- Create: `AnimaBackend/app/tts/indextts.py`
- Modify: `AnimaBackend/tests/conftest.py`
- Test: `AnimaBackend/tests/test_tts_indextts.py`(新)

**Interfaces:**
- Consumes: `app.tts.http.make_tts_client(base_url, timeout)`、`TTSError`
- Produces: `VoiceSpec(..., spk_ref_path: str = "", emo_vector: tuple[float, ...] | None = None)`;`IndexTtsEngine(base_url: str, emo_alpha: float)`,方法 `request_body`、`cache_material`、`synthesize`、`warmup`、`ping`;`duration_factor(speed: float) -> float`;`emo_mode(voice: VoiceSpec) -> Literal["ref", "vector", "none"]`;fixture `index_tts` → `FakeIndexTts`(`.calls`、`.timeouts`、`.tts_reply`、`.health_reply`、`.bodies()`)

- [ ] **Step 1: 写失败的测试**

`tests/conftest.py`,`gsv` fixture 下面加:

```python
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
```

`tests/test_tts_indextts.py`(新文件):

```python
import asyncio

import httpx
import pytest

from app.tts.base import TTSError, VoiceSpec
from app.tts.indextts import IndexTtsEngine, duration_factor, emo_mode

URL = "http://index.test:9890"
SPK = "D:/AnimaVoice/refs/阿米娅/【平静】作为罗德岛的领导者.wav"
HAPPY = (0.8, 0, 0, 0, 0, 0, 0, 0)


def spec(ref_path: str = "", emo_vector=None, speed: float = 1.0) -> VoiceSpec:
    return VoiceSpec(
        gpt_weights="",
        sovits_weights="",
        ref_path=ref_path,
        prompt_text="",
        text_lang="zh",
        speed=speed,
        spk_ref_path=SPK,
        emo_vector=emo_vector,
    )


def run(coro):
    return asyncio.run(coro)


def test_request_body_for_each_emotion_source(index_tts):
    engine = IndexTtsEngine(URL + "/", emo_alpha=0.6)

    async def scenario():
        await engine.synthesize("太好了！", spec(emo_vector=HAPPY))
        await engine.synthesize("对不起……", spec(ref_path="D:/emo/哭.wav", emo_vector=HAPPY))
        await engine.synthesize("博士。", spec())

    run(scenario())
    by_vector, by_ref, plain = index_tts.bodies()
    assert by_vector == {
        "text": "太好了！",
        "lang": "zh",
        "spk_audio_path": SPK,
        "emo_audio_path": None,
        "emo_vector": [0.8, 0, 0, 0, 0, 0, 0, 0],
        "emo_alpha": 0.6,
        "duration_factor": 1.0,
    }
    # 填了情绪参考就不带向量:对面两个同时给会报 400
    assert (by_ref["emo_audio_path"], by_ref["emo_vector"]) == ("D:/emo/哭.wav", None)
    assert (plain["emo_audio_path"], plain["emo_vector"]) == (None, None)
    assert [emo_mode(spec(emo_vector=HAPPY)), emo_mode(spec(ref_path="x")), emo_mode(spec())] == [
        "vector",
        "ref",
        "none",
    ]


def test_speed_maps_to_duration_factor():
    # 声音的「语速」越大越快,IndexTTS 的 duration_factor 越大越慢
    assert duration_factor(1.0) == 1.0
    assert duration_factor(1.25) == 0.8
    assert duration_factor(0.8) == 1.25
    assert duration_factor(0.4) == 2.0
    assert duration_factor(3.0) == 0.5
    assert duration_factor(1.3) == 0.769


def test_audio_and_cache_material(index_tts):
    engine = IndexTtsEngine(URL, 0.6)
    assert run(engine.synthesize("博士。", spec())) == (b"RIFF" + "博士。".encode(), "audio/wav")
    m1 = engine.cache_material("博士。", spec(emo_vector=HAPPY))
    m2 = IndexTtsEngine(URL, 0.8).cache_material("博士。", spec(emo_vector=HAPPY))
    assert m1["engine"] == "indextts"
    # 强度也进缓存键
    assert m1 != m2


def test_errors_map_to_502_503_504(index_tts):
    engine = IndexTtsEngine(URL, 0.6)
    replies = [
        httpx.Response(400, json={"detail": "音色参考不存在: D:/x.wav"}),
        httpx.Response(500, json={"detail": "CUDA out of memory"}),
        httpx.Response(500, text="oops"),
        httpx.ConnectError("refused"),
        httpx.ReadTimeout("slow"),
    ]

    async def scenario():
        out = []
        for reply in replies:
            index_tts.tts_reply = reply
            with pytest.raises(TTSError) as err:
                await engine.synthesize("一", spec())
            out.append((err.value.status, err.value.message))
        return out

    assert run(scenario()) == [
        (502, "音色参考不存在: D:/x.wav"),
        (502, "CUDA out of memory"),
        (502, "HTTP 500"),
        (503, f"连不上语音服务 {URL}"),
        (504, "语音合成超时"),
    ]


def test_cold_then_warm_timeouts_and_warmup_always_waits_cold(index_tts):
    engine = IndexTtsEngine(URL, 0.6)

    async def scenario():
        await engine.synthesize("一", spec())
        await engine.synthesize("二", spec())
        await engine.warmup(spec(), force=True)

    run(scenario())
    assert index_tts.timeouts == [90.0, 30.0, 90.0]
    assert index_tts.bodies()[-1]["text"] == "你好。"


def test_ping_checks_the_model_is_ready(index_tts):
    engine = IndexTtsEngine(URL, 0.6)
    run(engine.ping())
    assert index_tts.calls == [("health", None)]
    assert index_tts.timeouts == [5.0]

    index_tts.health_reply = httpx.Response(200, json={"model": "IndexTTS-2.5", "ready": False})
    with pytest.raises(TTSError) as err:
        run(engine.ping())
    assert (err.value.status, err.value.message) == (503, "IndexTTS 还在加载模型")

    index_tts.health_reply = httpx.ConnectError("refused")
    with pytest.raises(TTSError) as err:
        run(engine.ping())
    assert err.value.status == 503


def test_calls_on_one_engine_are_serialized(monkeypatch):
    active = peak = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1
        return httpx.Response(200, headers={"content-type": "audio/wav"}, content=b"RIFF")

    monkeypatch.setattr(
        "app.tts.indextts.make_tts_client",
        lambda base_url, timeout: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    engine = IndexTtsEngine(URL, 0.6)

    async def scenario():
        await asyncio.gather(engine.synthesize("一", spec()), engine.synthesize("二", spec()))

    run(scenario())
    assert peak == 1
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd AnimaBackend && .venv/Scripts/python.exe -m pytest -q tests/test_tts_indextts.py`
Expected: FAIL,`ModuleNotFoundError: app.tts.indextts`

- [ ] **Step 3: 实现**

`app/tts/base.py`,`VoiceSpec` 改成:

```python
@dataclass(frozen=True)
class VoiceSpec:
    """一次合成要用的全部配置,API 层从声音和情绪行里拼好交给引擎。

    GSV:ref_path / prompt_text 是这一行情绪的参考音频和原文。
    IndexTTS:spk_ref_path 是声音的音色参考;ref_path 是可选的情绪参考;emo_vector 是
    8 维情绪向量(ref_path 非空时不用);prompt_text 不用。
    """

    gpt_weights: str
    sovits_weights: str
    ref_path: str
    prompt_text: str
    text_lang: str
    speed: float
    spk_ref_path: str = ""
    emo_vector: tuple[float, ...] | None = None
```

模块说明里「目前只有 GPT-SoVITS(gpt_sovits.py)」改成「现在有 GPT-SoVITS(gpt_sovits.py)和 IndexTTS(indextts.py)」。

`app/tts/indextts.py`(新文件):

```python
"""IndexTTS-2.5 适配器。对面是台式机上我们自己写的小服务(官方只有 Gradio 网页,没有 HTTP
接口),接口约定见 docs/superpowers/specs/2026-09-24-indextts-engine-design.md「小服务接口」。

- 音色和情绪分开给:音色 = 声音的音色参考;情绪 = 这一行的情绪参考,或者 8 维向量,或者不控制
- 小服务同一时刻只推理一个;这边也加一把锁,免得请求在对面堆着等到超时
- 第一次推理要初始化 CUDA,可能还要下载依赖模型:没合成成功过时超时放宽到 90 秒
"""

import asyncio
from typing import Any, Literal

import httpx

from app.tts.base import TTSError, VoiceSpec
from app.tts.http import make_tts_client

COLD_TIMEOUT = 90.0
WARM_TIMEOUT = 30.0
PING_TIMEOUT = 5.0
WARMUP_TEXT = "你好。"
DURATION_MIN, DURATION_MAX = 0.5, 2.0

EmoMode = Literal["ref", "vector", "none"]


def duration_factor(speed: float) -> float:
    """声音的「语速」越大越快;IndexTTS 的 duration_factor 越大越慢,所以取倒数。"""
    if speed <= 0:
        return 1.0
    return round(min(DURATION_MAX, max(DURATION_MIN, 1 / speed)), 3)


def emo_mode(voice: VoiceSpec) -> EmoMode:
    """这一句的情绪从哪来:ref = 情绪参考音频,vector = 向量,none = 沿用音色参考的语气。"""
    if voice.ref_path:
        return "ref"
    return "vector" if voice.emo_vector else "none"


def _detail(res: httpx.Response) -> str:
    """小服务出错时回 {"detail": "<原因>"};原因原样给人看。"""
    try:
        body = res.json()
    except ValueError:
        body = None
    if isinstance(body, dict) and body.get("detail"):
        return str(body["detail"])
    return f"HTTP {res.status_code}"


class IndexTtsEngine:
    def __init__(self, base_url: str, emo_alpha: float):
        self.base_url = base_url.rstrip("/")
        self.emo_alpha = emo_alpha
        self.lock = asyncio.Lock()
        # 合成成功过一次 = CUDA 已经初始化好了,之后按正常超时等
        self.warm = False

    def request_body(self, text: str, voice: VoiceSpec) -> dict[str, Any]:
        mode = emo_mode(voice)
        return {
            "text": text,
            "lang": voice.text_lang or "zh",
            "spk_audio_path": voice.spk_ref_path,
            "emo_audio_path": voice.ref_path if mode == "ref" else None,
            "emo_vector": list(voice.emo_vector) if mode == "vector" and voice.emo_vector else None,
            "emo_alpha": self.emo_alpha,
            "duration_factor": duration_factor(voice.speed),
        }

    def cache_material(self, text: str, voice: VoiceSpec) -> dict[str, Any]:
        return {"engine": "indextts", "body": self.request_body(text, voice)}

    async def synthesize(self, text: str, voice: VoiceSpec) -> tuple[bytes, str]:
        async with self.lock:
            return await self._run(text, voice, WARM_TIMEOUT if self.warm else COLD_TIMEOUT)

    async def warmup(self, voice: VoiceSpec, force: bool) -> None:
        # 没有权重要切,force 用不上;服务可能刚重启过,总按冷启动的超时等
        async with self.lock:
            await self._run(WARMUP_TEXT, voice, COLD_TIMEOUT)

    async def ping(self) -> None:
        try:
            async with make_tts_client(self.base_url, PING_TIMEOUT) as client:
                res = await client.get(f"{self.base_url}/health")
        except httpx.HTTPError as e:
            raise self._transport_error(e) from e
        if res.status_code != 200:
            raise TTSError(502, _detail(res))
        try:
            body = res.json()
        except ValueError:
            body = None
        if not (isinstance(body, dict) and body.get("ready")):
            raise TTSError(503, "IndexTTS 还在加载模型")

    async def _run(self, text: str, voice: VoiceSpec, timeout: float) -> tuple[bytes, str]:
        try:
            async with make_tts_client(self.base_url, timeout) as client:
                res = await client.post(f"{self.base_url}/tts", json=self.request_body(text, voice))
        except httpx.HTTPError as e:
            raise self._transport_error(e) from e
        if res.status_code != 200:
            raise TTSError(502, _detail(res))
        self.warm = True
        mime = res.headers.get("content-type", "").split(";")[0].strip() or "audio/wav"
        return res.content, mime

    def _transport_error(self, e: httpx.HTTPError) -> TTSError:
        # 连不上或超时都可能是服务重启了:下次按冷启动的超时等
        self.warm = False
        if isinstance(e, httpx.TimeoutException) and not isinstance(e, httpx.ConnectTimeout):
            return TTSError(504, "语音合成超时")
        return TTSError(503, f"连不上语音服务 {self.base_url}")
```

- [ ] **Step 4: 跑测试,确认通过**

Run: `cd AnimaBackend && .venv/Scripts/python.exe -m pytest -q`
Expected: 全部通过(GSV 的测试不受影响:`VoiceSpec` 新字段都有默认值)

---

### Task 4: 接上引擎:注册、按引擎组装、响应头

**Files:**
- Modify: `AnimaBackend/app/tts/registry.py`、`AnimaBackend/app/api/tts.py`、`AnimaBackend/app/main.py`
- Test: `AnimaBackend/tests/test_tts_api.py`

**Interfaces:**
- Consumes: Task 1 的 `emo_alpha_of`、`profile.ref_path`、`emotion.emo_vector`;Task 3 的 `IndexTtsEngine`、`emo_mode`
- Produces: `_voice_for(profile_id, emotion, db) -> (conn, VoiceSpec, label, mode)`;合成响应头 `X-TTS-Emo-Mode: ref | vector | none`

- [ ] **Step 1: 写失败的测试**

`tests/test_tts_api.py`,把最后一个测试的断言补上新头:

```python
def test_voice_headers_are_readable_cross_origin(client: TestClient, gsv):
    _, voice = setup_voice(client)
    r = speak(client, voice["id"], headers={"Origin": "http://localhost:5173"})
    exposed = r.headers["access-control-expose-headers"].lower()
    assert "x-tts-cache" in exposed and "x-tts-emotion" in exposed and "x-tts-emo-mode" in exposed
    # GSV 的情绪都来自参考音频
    assert r.headers["x-tts-emo-mode"] == "ref"
```

末尾加:

```python
INDEX_URL = "http://index.test:9890"
SPK = "D:/refs/阿米娅/平静.wav"
HAPPY = [0.8, 0, 0, 0, 0, 0, 0, 0]


def setup_index_voice(client: TestClient) -> tuple[dict, dict]:
    conn = make_conn(client, name="IndexTTS", api_type="indextts", base_url=INDEX_URL)
    voice = client.post(
        "/api/voices",
        json={"name": "阿米娅·Index", "connection_id": conn["id"], "ref_path": SPK, "speed": 1.25},
    ).json()
    for label, vec, ref in [("平静", None, ""), ("开心", HAPPY, ""), ("难过", None, "D:/emo/哭.wav")]:
        r = client.post(
            f"/api/voices/{voice['id']}/emotions",
            json={"label": label, "emo_vector": vec, "ref_path": ref},
        )
        assert r.status_code == 200, r.text
    return conn, voice


def test_indextts_speak_picks_emotion_source_per_row(client: TestClient, index_tts):
    _, voice = setup_index_voice(client)
    happy = speak(client, voice["id"], text="一", emotion="开心")
    assert happy.status_code == 200, happy.text
    assert happy.headers["x-tts-emo-mode"] == "vector"
    assert speak(client, voice["id"], text="二", emotion="难过").headers["x-tts-emo-mode"] == "ref"
    calm = speak(client, voice["id"], text="三", emotion="没有这个表情")
    assert (unquote(calm.headers["x-tts-emotion"]), calm.headers["x-tts-emo-mode"]) == ("平静", "none")

    b_happy, b_sad, b_calm = index_tts.bodies()
    assert b_happy == {
        "text": "一",
        "lang": "zh",
        "spk_audio_path": SPK,
        "emo_audio_path": None,
        "emo_vector": HAPPY,
        "emo_alpha": 0.6,
        "duration_factor": 0.8,
    }
    assert (b_sad["emo_audio_path"], b_sad["emo_vector"]) == ("D:/emo/哭.wav", None)
    assert (b_calm["emo_audio_path"], b_calm["emo_vector"]) == (None, None)


def test_indextts_needs_speaker_ref_but_no_emotion_rows(client: TestClient, index_tts):
    conn = make_conn(client, api_type="indextts", base_url=INDEX_URL)
    voice = client.post("/api/voices", json={"name": "琴柳", "connection_id": conn["id"]}).json()
    r = speak(client, voice["id"])
    assert (r.status_code, r.json()["detail"]) == (400, "声音「琴柳」还没填音色参考")
    assert index_tts.calls == []

    client.put(f"/api/voices/{voice['id']}", json={"ref_path": "D:/refs/琴柳/平静.wav"})
    # 一行情绪都没有也能念:沿用音色参考的语气
    r = speak(client, voice["id"])
    assert r.status_code == 200, r.text
    assert (r.headers["x-tts-emo-mode"], unquote(r.headers["x-tts-emotion"])) == ("none", "")


def test_indextts_cache_key_follows_vector_and_strength(client: TestClient, index_tts):
    conn, voice = setup_index_voice(client)
    assert speak(client, voice["id"], text="一", emotion="开心").headers["x-tts-cache"] == "miss"
    assert speak(client, voice["id"], text="一", emotion="开心").headers["x-tts-cache"] == "hit"

    happy = next(e for e in client.get("/api/voices").json()[0]["emotions"] if e["label"] == "开心")
    client.put(
        f"/api/voices/{voice['id']}/emotions/{happy['id']}", json={"emo_vector": [0.6, 0, 0, 0, 0, 0, 0, 0]}
    )
    assert speak(client, voice["id"], text="一", emotion="开心").headers["x-tts-cache"] == "miss"

    client.put(f"/api/tts/connections/{conn['id']}", json={"emo_alpha": 0.8})
    assert speak(client, voice["id"], text="一", emotion="开心").headers["x-tts-cache"] == "miss"
    assert index_tts.bodies()[-1]["emo_alpha"] == 0.8
    assert len(index_tts.bodies()) == 3


def test_indextts_errors_test_and_warmup(client: TestClient, index_tts):
    conn, voice = setup_index_voice(client)
    index_tts.tts_reply = httpx.Response(400, json={"detail": f"音色参考不存在: {SPK}"})
    r = speak(client, voice["id"], text="一")
    assert (r.status_code, r.json()["detail"]) == (502, f"音色参考不存在: {SPK}")
    index_tts.tts_reply = None

    index_tts.health_reply = httpx.Response(200, json={"model": "IndexTTS-2.5", "ready": False})
    r = client.post(f"/api/tts/connections/{conn['id']}/test")
    assert (r.status_code, r.json()["detail"]) == (503, "IndexTTS 还在加载模型")

    r = client.post("/api/tts/warmup", json={"profile_id": voice["id"]})
    assert r.status_code == 200, r.text
    assert index_tts.bodies()[-1]["text"] == "你好。"
    assert client.get("/api/tts/cache").json()["count"] == 0
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd AnimaBackend && .venv/Scripts/python.exe -m pytest -q tests/test_tts_api.py`
Expected: 新测试 FAIL(`不支持的语音引擎:indextts`、没有 `x-tts-emo-mode` 头)

- [ ] **Step 3: 实现**

`app/tts/registry.py`:

```python
"""按连接取引擎实例。实例要跨请求保留:锁、当前加载的权重、是否预热过都记在它身上。

地址、采样步数或情绪强度改了就换一个新实例(旧实例记住的状态对新配置没有意义)。
"""

from app.models import TtsConnection
from app.tts.base import TTSEngine, TTSError
from app.tts.gpt_sovits import GptSovitsEngine
from app.tts.indextts import IndexTtsEngine

DEFAULT_EMO_ALPHA = 0.6

_engines: dict[str, tuple[tuple, TTSEngine]] = {}


def emo_alpha_of(conn: TtsConnection) -> float:
    """IndexTTS 的情绪强度,存在连接的 options 里;老数据没有就用默认 0.6。"""
    v = (conn.options or {}).get("emo_alpha")
    return float(v) if isinstance(v, (int, float)) else DEFAULT_EMO_ALPHA


def engine_for(conn: TtsConnection) -> TTSEngine:
    sig = (conn.api_type, conn.base_url, conn.sample_steps, emo_alpha_of(conn))
    hit = _engines.get(conn.id)
    if hit is not None and hit[0] == sig:
        return hit[1]
    if conn.api_type == "gpt_sovits":
        engine: TTSEngine = GptSovitsEngine(conn.base_url, conn.sample_steps)
    elif conn.api_type == "indextts":
        engine = IndexTtsEngine(conn.base_url, emo_alpha_of(conn))
    else:
        raise TTSError(400, f"不支持的语音引擎:{conn.api_type}")
    _engines[conn.id] = (sig, engine)
    return engine
```

(`forget_engine`、`reset_engines` 保持不变)

`app/api/tts.py`:
- import:`from app.models import TtsConnection, VoiceEmotion, VoiceProfile` 不变;加 `from app.tts.indextts import emo_mode`
- 把 `_voice_for` 换成下面三个函数:

```python
def _gsv_spec(profile: VoiceProfile, row: VoiceEmotion | None) -> tuple[VoiceSpec, str, str]:
    """GSV 的情绪就是参考音频:这一行必须有参考和原文。"""
    if row is None:
        raise HTTPException(400, f"声音「{profile.name}」还没有参考音频")
    if not row.ref_path:
        raise HTTPException(400, f"情绪「{row.label}」还没填参考音频路径")
    if not row.prompt_text:
        raise HTTPException(400, f"情绪「{row.label}」还没填参考音频的原文")
    spec = VoiceSpec(
        gpt_weights=profile.gpt_weights,
        sovits_weights=profile.sovits_weights,
        ref_path=row.ref_path,
        prompt_text=row.prompt_text,
        text_lang=profile.text_lang or "zh",
        speed=profile.speed,
    )
    return spec, row.label, "ref"


def _indextts_spec(profile: VoiceProfile, row: VoiceEmotion | None) -> tuple[VoiceSpec, str, str]:
    """IndexTTS:音色参考必填;情绪行可以没有(沿用音色参考的语气),不需要原文。"""
    if not profile.ref_path:
        raise HTTPException(400, f"声音「{profile.name}」还没填音色参考")
    spec = VoiceSpec(
        gpt_weights="",
        sovits_weights="",
        ref_path=row.ref_path if row else "",
        prompt_text="",
        text_lang=profile.text_lang or "zh",
        speed=profile.speed,
        spk_ref_path=profile.ref_path,
        emo_vector=tuple(row.emo_vector) if row and row.emo_vector else None,
    )
    return spec, row.label if row else "", emo_mode(spec)


def _voice_for(
    profile_id: str, emotion: str | None, db: Session
) -> tuple[TtsConnection, VoiceSpec, str, str]:
    """声音 + 想要的情绪 → (语音服务, 合成配置, 实际用的情绪名, 情绪方式 ref / vector / none)"""
    profile = db.get(VoiceProfile, profile_id)
    if profile is None:
        raise HTTPException(404, "声音不存在")
    conn = db.get(TtsConnection, profile.connection_id)
    if conn is None:
        raise HTTPException(400, f"声音「{profile.name}」没有选语音服务")
    row = pick_emotion(list_emotions(profile.id, db), emotion)
    build = _indextts_spec if conn.api_type == "indextts" else _gsv_spec
    spec, label, mode = build(profile, row)
    return conn, spec, label, mode
```

- `_audio` 加参数 `mode: str`,headers 里加 `"X-TTS-Emo-Mode": mode,`:

```python
def _audio(data: bytes, mime: str, cache: str, emotion: str, mode: str) -> Response:
    return Response(
        content=data,
        media_type=mime,
        headers={
            "X-TTS-Cache": cache,
            # 响应头只能是 latin-1,中文情绪名要编码
            "X-TTS-Emotion": quote(emotion),
            # 这句的情绪从哪来:ref = 参考音频,vector = 向量,none = 不控制
            "X-TTS-Emo-Mode": mode,
            "Cache-Control": "no-store",
        },
    )
```

- `speak`:`conn, voice, label, mode = _voice_for(...)`;两处 `_audio(...)` 都加 `mode=mode`
- `warmup`:`conn, voice, _, _ = _voice_for(req.profile_id, None, db)`

`app/main.py`:`expose_headers=["X-TTS-Cache", "X-TTS-Emotion", "X-TTS-Emo-Mode"],`

- [ ] **Step 4: 跑测试,确认通过**

Run: `cd AnimaBackend && .venv/Scripts/python.exe -m pytest -q`
Expected: 全部通过,GSV 原有测试的报错文案不变

---

### Task 5: refs.json 的新字段

**Files:**
- Modify: `AnimaBackend/app/api/voices.py`(`import_refs`)
- Test: `AnimaBackend/tests/test_voices_api.py`

**Interfaces:**
- Consumes: Task 1 的 `clean_vector`、`connection.api_type`
- Produces: refs.json 可选字段 `speaker_ref`(顶层)、`emo_vector`(每条);导入到 IndexTTS 连接时 `text` 可以不写

- [ ] **Step 1: 写失败的测试**

`tests/test_voices_api.py` 末尾:

```python
def test_import_refs_for_indextts_takes_speaker_ref_and_vectors(client: TestClient):
    conn = client.post(
        "/api/tts/connections",
        json={"name": "IndexTTS", "api_type": "indextts", "base_url": "http://127.0.0.1:9890"},
    ).json()
    refs = {
        "character": "阿米娅",
        "speaker_ref": "D:/AnimaVoice/refs/阿米娅/【平静】作为罗德岛的领导者.wav",
        "refs": [
            {"emotion": "开心", "emo_vector": [0.8, 0, 0, 0, 0, 0, 0, 0], "file": "D:/emo/笑.wav"},
            {"emotion": "难过", "file": "D:/emo/哭.wav"},
        ],
    }
    r = client.post("/api/voices/import", json={"connection_id": conn["id"], "refs": refs})
    assert r.status_code == 200, r.text
    v = r.json()
    assert v["ref_path"] == refs["speaker_ref"]
    assert [(e["label"], e["emo_vector"], e["prompt_text"]) for e in v["emotions"]] == [
        ("开心", [0.8, 0, 0, 0, 0, 0, 0, 0], ""),
        ("难过", None, ""),
    ]

    # 没写 speaker_ref:用 refs 第一条的文件
    only = {"character": "琴柳", "refs": [{"emotion": "平静", "file": "D:/refs/琴柳/平静.wav"}]}
    r2 = client.post("/api/voices/import", json={"connection_id": conn["id"], "refs": only})
    assert r2.json()["ref_path"] == "D:/refs/琴柳/平静.wav"

    bad_vec = {"character": "x", "refs": [{"emotion": "怒", "file": "D:/a.wav", "emo_vector": [2, 0, 0, 0, 0, 0, 0, 0]}]}
    r3 = client.post("/api/voices/import", json={"connection_id": conn["id"], "refs": bad_vec})
    assert (r3.status_code, r3.json()["detail"]) == (400, "refs 第 1 条:「高兴」要在 0 到 1.2 之间")
    not_list = {"character": "x", "refs": [{"emotion": "怒", "file": "D:/a.wav", "emo_vector": "0.8"}]}
    r4 = client.post("/api/voices/import", json={"connection_id": conn["id"], "refs": not_list})
    assert (r4.status_code, r4.json()["detail"]) == (400, "refs 第 1 条的 emo_vector 要是 8 个数的列表")


def test_import_refs_for_gsv_still_requires_text(client: TestClient):
    conn = make_conn(client)
    refs = {"character": "x", "refs": [{"emotion": "平静", "file": "D:/a.wav"}]}
    r = client.post("/api/voices/import", json={"connection_id": conn["id"], "refs": refs})
    assert (r.status_code, r.json()["detail"]) == (400, "refs 第 1 条没有 text(参考音频的原文)")
```

- [ ] **Step 2: 跑测试,确认失败**

Run: `cd AnimaBackend && .venv/Scripts/python.exe -m pytest -q tests/test_voices_api.py`
Expected: 第一个新测试 FAIL(「refs 第 1 条没有 text」);第二个本来就通过(保护现有行为)

- [ ] **Step 3: 实现**

`import_refs` 开头的 `_check_connection(req.connection_id, db)` 换成:

```python
    conn = db.get(TtsConnection, req.connection_id)
    if conn is None:
        raise HTTPException(400, "语音服务不存在")
    # IndexTTS 不需要参考音频的原文;音色参考单独给(没给就用第一条)
    is_index = conn.api_type == "indextts"
```

`rows` 的类型和循环改成:

```python
    rows: list[tuple[str, str, str, bool, list[float] | None]] = []
    for i, r in enumerate(refs, start=1):
        if not isinstance(r, dict):
            raise HTTPException(400, f"refs 第 {i} 条格式不对")
        path = clean_path(str(r.get("file") or ""))
        if not path:
            raise HTTPException(400, f"refs 第 {i} 条没有 file(参考音频路径)")
        parsed = parse_ref_name(path)
        label = str(r.get("emotion") or (parsed[0] if parsed else "")).strip()
        text = str(r.get("text") or (parsed[1] if parsed else "")).strip()
        if not label:
            raise HTTPException(400, f"refs 第 {i} 条没有 emotion(情绪名)")
        if not text and not is_index:
            raise HTTPException(400, f"refs 第 {i} 条没有 text(参考音频的原文)")
        raw_vec = r.get("emo_vector")
        if raw_vec is not None and not isinstance(raw_vec, list):
            raise HTTPException(400, f"refs 第 {i} 条的 emo_vector 要是 8 个数的列表")
        try:
            vector = clean_emo_vector(raw_vec)
        except (TypeError, ValueError) as e:
            raise HTTPException(400, f"refs 第 {i} 条:{e}") from e
        rows.append((clean_label(label, "情绪名"), path, text, "emo_vector" in r, vector))
```

权重路径那段下面加音色参考:

```python
    speaker = data.get("speaker_ref")
    if isinstance(speaker, str) and speaker.strip():
        profile.ref_path = clean_path(speaker)
    elif is_index and not profile.ref_path:
        profile.ref_path = rows[0][1]
```

最后那个 `for label, path, text in rows:` 改成:

```python
    for label, path, text, has_vector, vector in rows:
        row = by_name.get(label.casefold())
        if row is None:
            row = VoiceEmotion(profile_id=profile.id, label=label, aliases=[], sort=next_sort)
            next_sort += 1
            db.add(row)
            by_name[label.casefold()] = row
        row.ref_path = path
        row.prompt_text = text
        if has_vector:
            row.emo_vector = vector
```

(`clean_emo_vector` 里 `float("abc")` 会抛 `ValueError`、`float(None)` 会抛 `TypeError`,都转成 400)

- [ ] **Step 4: 跑测试,确认通过**

Run: `cd AnimaBackend && .venv/Scripts/python.exe -m pytest -q`
Expected: 全部通过

---

### Task 6: 前端类型和纯函数

**Files:**
- Modify: `frontend/src/debug/lib/api.ts`
- Modify: `frontend/src/debug/plugins/voice.ts`

**Interfaces:**
- Consumes: 后端 Task 1–5 的字段和接口
- Produces:`TtsApiType`、`TtsConnectionPatch`、`EmoMode`;`TtsConnection.emo_alpha`、`VoiceProfile.ref_path`、`VoiceEmotion.emo_vector`;`SpeakResult.mode`;`debugApi.fillVoiceEmotionsFromSprites(profileId, cardId): Promise<VoiceEmotion[]>`;`plugins/voice.ts` 的 `EMO_DIMS`、`EMO_DIM_MAX`、`EMO_SUM_MAX`、`emoVectorProblem(v)`、`EMO_MODE_TEXT`

- [ ] **Step 1: 改 `lib/api.ts`**

类型那一节:

```ts
export type TtsApiType = 'gpt_sovits' | 'indextts';

export interface TtsConnection {
  id: string;
  name: string;
  api_type: TtsApiType;
  base_url: string;
  /** GSV 的采样步数;IndexTTS 不用 */
  sample_steps: number;
  /** IndexTTS 的情绪强度 0–1;GSV 不用 */
  emo_alpha: number;
  /** 用这个服务的声音有几个 */
  profile_count: number;
}

export type TtsConnectionPatch = Partial<Pick<TtsConnection, 'name' | 'base_url' | 'sample_steps' | 'emo_alpha'>>;
```

`VoiceEmotion` 在 `prompt_text` 下面加:

```ts
  /** IndexTTS 的 8 维情绪向量(顺序见 plugins/voice.ts 的 EMO_DIMS);null = 不用向量 */
  emo_vector: number[] | null;
```

`VoiceProfile` 在 `sovits_weights` 下面加:

```ts
  /** IndexTTS 的音色参考(语音服务那台机器上的路径);GSV 不用 */
  ref_path: string;
```

```ts
export type VoiceProfilePatch = Partial<
  Pick<
    VoiceProfile,
    'name' | 'aliases' | 'connection_id' | 'gpt_weights' | 'sovits_weights' | 'ref_path' | 'text_lang' | 'speed'
  >
>;

export type VoiceEmotionPatch = Partial<Pick<VoiceEmotion, 'label' | 'aliases' | 'ref_path' | 'prompt_text' | 'emo_vector'>>;
```

`SpeakResult` 加一个字段,并在它上面加类型:

```ts
/** 这句的情绪从哪来:ref = 参考音频,vector = 向量,none = 沿用音色参考的语气 */
export type EmoMode = 'ref' | 'vector' | 'none';
```

```ts
  /** 后端实际用的情绪方式 */
  mode: EmoMode;
```

`debugApi` 里:

```ts
  createTtsConnection: (
    payload: { name: string; api_type?: TtsApiType; base_url: string } & TtsConnectionPatch,
  ) =>
    request<TtsConnection>('/api/tts/connections', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateTtsConnection: (id: string, patch: TtsConnectionPatch) =>
    request<TtsConnection>(`/api/tts/connections/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
```

`reorderVoiceEmotions` 下面加:

```ts
  /** 按这张卡的立绘表情补齐情绪行(只对 IndexTTS 的声音);返回这个声音全部的情绪行 */
  fillVoiceEmotionsFromSprites: (profileId: string, cardId: string) =>
    request<VoiceEmotion[]>(`/api/voices/${profileId}/emotions/from-sprites`, {
      method: 'POST',
      body: JSON.stringify({ card_id: cardId }),
    }),
```

`speak` 的返回值加一行:

```ts
      mode: parseEmoMode(res.headers.get('X-TTS-Emo-Mode')),
```

文件里(`debugApi` 上面)加:

```ts
function parseEmoMode(v: string | null): EmoMode {
  return v === 'vector' || v === 'none' ? v : 'ref';
}
```

- [ ] **Step 2: 改 `plugins/voice.ts`**

import 里加 `type EmoMode`(和已有的 `from '../lib/api'` 合在一起);文件末尾追加:

```ts
// ---- IndexTTS 的情绪向量 ----

/** 8 维的顺序是 IndexTTS 官方定的;short 用在编辑器的小标签上 */
export const EMO_DIMS = [
  { short: '喜', name: '高兴' },
  { short: '怒', name: '愤怒' },
  { short: '哀', name: '悲伤' },
  { short: '惧', name: '害怕' },
  { short: '厌', name: '厌恶' },
  { short: '郁', name: '忧郁' },
  { short: '惊', name: '惊讶' },
  { short: '平', name: '平静' },
] as const;
export const EMO_DIM_MAX = 1.2;
export const EMO_SUM_MAX = 1.5;

/** 和后端 clean_emo_vector 同一套规则;没问题返回 null */
export function emoVectorProblem(v: readonly number[]): string | null {
  if (v.length !== EMO_DIMS.length) return `要正好 ${EMO_DIMS.length} 个数`;
  for (let i = 0; i < v.length; i++) {
    if (!(v[i] >= 0 && v[i] <= EMO_DIM_MAX)) return `「${EMO_DIMS[i].name}」要在 0 到 ${EMO_DIM_MAX} 之间`;
  }
  const total = v.reduce((a, b) => a + b, 0);
  if (total > EMO_SUM_MAX + 1e-9) return `合计 ${total.toFixed(2)},不能超过 ${EMO_SUM_MAX}`;
  return null;
}

export const EMO_MODE_TEXT: Record<EmoMode, string> = { ref: '参考', vector: '向量', none: '不控制' };
```

- [ ] **Step 3: 编译检查**

Run: `cd frontend && npm run build`
Expected: 报 `vn/voice.ts` 里 `ClipState` 缺 `mode` 之类的错的话,留到 Task 8 修;除此之外不应该有别的错误。有别的就在这一步修掉

---

### Task 7: 语音页按引擎显示字段、向量编辑器、按立绘补齐

**Files:**
- Create: `frontend/src/debug/components/EmotionVectorEditor.tsx`
- Modify: `frontend/src/debug/components/VoicePanel.tsx`
- Modify: `frontend/src/debug/debug.css`(`.vp-json` 那一块后面追加)

**Interfaces:**
- Consumes: Task 6 的类型、`fillVoiceEmotionsFromSprites`、`EMO_DIMS`、`EMO_DIM_MAX`、`EMO_SUM_MAX`、`emoVectorProblem`、`EMO_MODE_TEXT`
- Produces: `<EmotionVectorEditor value disabled onCommit />`

- [ ] **Step 1: 写 `EmotionVectorEditor.tsx`**

```tsx
/**
 * IndexTTS 的 8 维情绪向量:8 个小数字框,旁边是合计。焦点离开整个编辑器(或按回车)时
 * 整条保存;超出范围就标红、不保存。全 0 等于不控制,存成空。
 */

import { useState } from 'react';
import { EMO_DIM_MAX, EMO_DIMS, EMO_SUM_MAX, emoVectorProblem } from '../plugins/voice';

const ZERO: number[] = EMO_DIMS.map(() => 0);

export function EmotionVectorEditor({
  value,
  disabled,
  onCommit,
}: {
  value: number[] | null;
  /** 这一行填了情绪参考:向量不生效,变灰但还能改 */
  disabled?: boolean;
  onCommit: (v: number[] | null) => Promise<boolean>;
}) {
  const saved = value ?? ZERO;
  const [draft, setDraft] = useState<string[] | null>(null);
  const shown = draft ?? saved.map((n) => String(n));
  const nums = shown.map((s) => (s.trim() === '' ? 0 : Number(s)));
  const problem = emoVectorProblem(nums);
  const total = nums.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

  const commit = async () => {
    if (draft === null || problem) return;
    if (nums.some((n, i) => n !== saved[i])) {
      if (!(await onCommit(nums.some((n) => n > 0) ? nums : null))) return;
    }
    setDraft(null);
  };

  return (
    <div
      className={`vp-vector${disabled ? ' off' : ''}`}
      onBlur={(e) => {
        // 在 8 个框之间切换不算离开
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) void commit();
      }}
    >
      <span className="conn-label">情绪向量</span>
      <div className="vp-vector-cells">
        {EMO_DIMS.map((d, i) => (
          <label key={d.name} className="vp-vector-cell" title={d.name}>
            <span>{d.short}</span>
            <input
              className="text-input"
              type="number"
              inputMode="decimal"
              min={0}
              max={EMO_DIM_MAX}
              step={0.1}
              value={shown[i]}
              onChange={(e) => {
                const next = [...shown];
                next[i] = e.target.value;
                setDraft(next);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void commit();
                if (e.key === 'Escape') setDraft(null);
              }}
            />
          </label>
        ))}
      </div>
      <span className={`sp-group-note${problem ? ' vp-bad' : ''}`}>
        {problem ?? `合计 ${total.toFixed(1)} / ${EMO_SUM_MAX}`}
        {disabled && ' · 已填情绪参考,向量不生效'}
      </span>
    </div>
  );
}
```

- [ ] **Step 2: 加样式**

`debug.css` 里 `.vp-json { … }` 那一块后面追加(颜色变量先 `grep -n "pl-error" debug.css` 看报错红用的是哪个,`.vp-bad` 用同一个):

```css
.vp-vector {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}
.vp-vector.off .vp-vector-cells {
  opacity: 0.45;
}
.vp-vector-cells {
  display: grid;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  gap: 4px;
  flex: 1;
  min-width: 0;
}
.vp-vector-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  color: var(--text-dim);
}
.vp-vector-cell .text-input {
  width: 100%;
  min-width: 0;
  padding: 3px 2px;
  text-align: center;
}
@media (max-width: 560px) {
  .vp-vector-cells {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
```

- [ ] **Step 3: 改 `VoicePanel.tsx`**

import:

```tsx
import {
  debugApi,
  type CardSprite,
  type TtsApiType,
  type TtsConnection,
  type TtsConnectionPatch,
  type VoiceEmotion,
  type VoiceEmotionPatch,
  type VoiceProfile,
  type VoiceProfilePatch,
} from '../lib/api';
import type { VoicePluginState } from '../plugins/useVoicePlugin';
import {
  EMO_MODE_TEXT,
  MAX_WAIT_MAX,
  MAX_WAIT_MIN,
  missingEmotions,
  normalizeVoiceConfig,
  parseRefFileName,
} from '../plugins/voice';
import { bgmPlayer } from '../vn/bgm';
import { voicePlayer } from '../vn/voice';
import { EmotionVectorEditor } from './EmotionVectorEditor';
import { CommitField, DeleteButton } from './pluginFields';
import { errText, formatSize, useRunner, type Notify, type Runner } from './pluginRunner';
```

`secs` 下面加:

```tsx
const ENGINE_NAME: Record<TtsApiType, string> = { gpt_sovits: 'GPT-SoVITS', indextts: 'IndexTTS-2.5' };

type CardRef = { id: string; name: string } | null;
```

`Props` 里 `card: CardRef;`;`VoicePanel` 里 `<ProfilesGroup voice={voice} card={card} notify={notify} />`。

`ConnectionsGroup` 里:
- `add` 换成:

```tsx
  const add = (api_type: TtsApiType) =>
    run('添加中', async () => {
      await debugApi.createTtsConnection(
        api_type === 'indextts'
          ? { name: 'IndexTTS', api_type, base_url: 'http://127.0.0.1:9890', emo_alpha: 0.6 }
          : { name: 'GPT-SoVITS', api_type, base_url: 'http://127.0.0.1:9880', sample_steps: 64 },
      );
    });
```

- `save` 的 `patch` 类型改成 `TtsConnectionPatch`
- `setSteps` 下面加:

```tsx
  const setAlpha = (c: TtsConnection, v: string) => {
    const n = Number(v);
    if (!(n >= 0 && n <= 1)) {
      notify('error', '情绪强度在 0 到 1 之间');
      return Promise.resolve(false);
    }
    return save(c, { emo_alpha: n });
  };
```

- 组头说明改成:`跑语音合成的机器:GPT-SoVITS api_v2(默认 9880),或者台式机上的 IndexTTS 小服务(默认 9890)。开发时经 SSH 隧道,地址就是 http://127.0.0.1:端口。`
- 「+ 添加语音服务」按钮换成两个:

```tsx
        <button className="btn small" disabled={!!busy} onClick={() => void add('gpt_sovits')}>
          + GPT-SoVITS
        </button>
        <button className="btn small" disabled={!!busy} onClick={() => void add('indextts')}>
          + IndexTTS-2.5
        </button>
```

- 每个连接的「采样步数」字段和下面的说明换成:

```tsx
                {c.api_type === 'indextts' ? (
                  <CommitField
                    label="情绪强度"
                    value={String(c.emo_alpha)}
                    placeholder="0.6"
                    onCommit={(v) => setAlpha(c, v)}
                  />
                ) : (
                  <CommitField
                    label="采样步数"
                    value={String(c.sample_steps)}
                    placeholder="64"
                    onCommit={(v) => setSteps(c, v)}
                  />
                )}
                <div className="sp-group-note">
                  {ENGINE_NAME[c.api_type]} · {c.profile_count} 个声音在用 ·{' '}
                  {c.api_type === 'indextts'
                    ? '情绪强度 0.6 左右最自然,太高会影响音色'
                    : '步数越多越慢,64 步一句约 1.7 秒'}
                  {tested[c.id] && ` · ${tested[c.id]}`}
                </div>
```

`ProfilesGroup`:签名改成 `function ProfilesGroup({ voice, card, notify }: { voice: VoicePluginState; card: CardRef; notify: Notify })`;组头说明改成:`一个声音 = 一个语音服务 + 它要的素材(GSV:一套权重 + 每种情绪一段参考;IndexTTS:一段音色参考 + 每种情绪一组向量或一段情绪参考),路径都是语音服务那台机器上的。情绪名和这句的立绘表情名对上就用那一行,对不上用排第一的。`;`<ProfileCard … card={card} />`。

`ProfileCard`:props 加 `card: CardRef`;`const conn = …` 下面加 `const isIndex = conn?.api_type === 'indextts';`;GPT / SoVITS 两个字段换成:

```tsx
            {isIndex ? (
              <CommitField
                label="音色参考"
                placeholder="D:/AnimaVoice/refs/角色/【平静】原文.wav(5–10 秒、干净的一段)"
                value={p.ref_path}
                onCommit={(v) => save({ ref_path: v })}
              />
            ) : (
              <>
                <CommitField
                  label="GPT 权重(.ckpt)"
                  placeholder="D:/AnimaVoice/models/角色/角色-e10.ckpt"
                  value={p.gpt_weights}
                  onCommit={(v) => save({ gpt_weights: v })}
                />
                <CommitField
                  label="SoVITS 权重(.pth)"
                  placeholder="D:/AnimaVoice/models/角色/角色_e10_s230_l32.pth"
                  value={p.sovits_weights}
                  onCommit={(v) => save({ sovits_weights: v })}
                />
              </>
            )}
```

`<EmotionTable p={p} isIndex={isIndex} card={card} busy={busy} run={run} sample={sample} />`;预热旁边的说明改成:

```tsx
              {warm ||
                (isIndex
                  ? '合成一句,让服务把模型和这段音色参考准备好。服务刚启动时用'
                  : '强制重新加载这个声音的权重,再合成一句。服务刚重启、或者手动切过那边的权重之后用')}
```

`EmotionTable`:props 加 `isIndex: boolean; card: CardRef;`;加一个状态 `const [filled, setFilled] = useState('');`;

- `add` 换成:

```tsx
  const add = () =>
    run('添加中', async () => {
      if (isIndex) {
        // 名字要和立绘表情名一致,撞名就让后端报出来,不偷偷改名
        await debugApi.createVoiceEmotion(p.id, { label: adding.trim() });
      } else {
        const path = adding.trim().replace(/^"|"$/g, '');
        const parsed = parseRefFileName(path);
        const taken = new Set(
          p.emotions.flatMap((e) => [e.label, ...e.aliases]).map((n) => n.toLowerCase()),
        );
        await debugApi.createVoiceEmotion(p.id, {
          label: uniqueName(parsed?.label || '情绪', taken),
          ref_path: path,
          prompt_text: parsed?.text ?? '',
        });
      }
      setAdding('');
    });

  const fill = () =>
    run('补齐中', async () => {
      if (!card) return;
      const rows = await debugApi.fillVoiceEmotionsFromSprites(p.id, card.id);
      const added = rows.length - p.emotions.length;
      setFilled(added > 0 ? `补了 ${added} 行,向量按常见表情名预填了,听一下再调` : '立绘表情都已经有对应的行了');
    });
```

- `listen` 里试听结果那行改成:

```tsx
        [e.id]: `${r.cache === 'hit' ? '缓存命中' : '新合成'}${isIndex ? ` · ${EMO_MODE_TEXT[r.mode]}` : ''} · ${secs(r.ms)}`,
```

- 表头说明换成:

```tsx
      <div className="sp-group-note">
        {isIndex
          ? '情绪,排第一的是默认。有情绪参考就照参考的语气念,没有就用向量,都没有就沿用音色参考的语气。向量顺序:喜 怒 哀 惧 厌 郁 惊 平,每项 0–1.2,合计不超过 1.5。'
          : '情绪,排第一的是默认。参考音频必须 3–10 秒,5–10 秒最好;3 秒左右的短参考会有电子音。'}
      </div>
      {isIndex && card && (
        <div className="pl-row">
          <button className="btn small" disabled={!!busy} onClick={() => void fill()}>
            按「{card.name}」的立绘表情补齐
          </button>
          <span className="sp-group-note">{filled || '每个立绘表情一行,向量按常见表情名预填,已有的行不动'}</span>
        </div>
      )}
```

- 每一行里「参考音频」「原文」两个字段换成:

```tsx
            {isIndex ? (
              <>
                <CommitField
                  label="情绪参考"
                  placeholder="可选。填了就照这段的语气念,向量不生效;可以是别的角色的声音"
                  value={e.ref_path}
                  onCommit={(v) => save(e, { ref_path: v })}
                />
                <EmotionVectorEditor
                  value={e.emo_vector}
                  disabled={!!e.ref_path}
                  onCommit={(v) => save(e, { emo_vector: v })}
                />
              </>
            ) : (
              <>
                <CommitField
                  label="参考音频"
                  placeholder="D:/AnimaVoice/refs/角色/【平静】原文.wav"
                  value={e.ref_path}
                  onCommit={(v) => setRef(e, v)}
                />
                <CommitField
                  label="原文"
                  placeholder="参考音频里说的话,一字不差"
                  value={e.prompt_text}
                  onCommit={(v) => save(e, { prompt_text: v })}
                />
              </>
            )}
```

- 最下面的添加框:

```tsx
        <input
          className="text-input pl-wide"
          value={adding}
          placeholder={
            isIndex
              ? '情绪名,和立绘表情名一致,比如 开心'
              : '贴参考音频的路径;文件名是「【情绪】原文.wav」就自动填情绪名和原文'
          }
          onChange={(e) => setAdding(e.target.value)}
        />
```

`CardGroup`:`const { binding, profiles, bind, cast, connections } = voice;`;`const missing = …` 下面加:

```tsx
  const main = cast.main;
  const mainIsIndex = connections.find((c) => c.id === main?.connection_id)?.api_type === 'indextts';
```

最后三段提示换成:

```tsx
      {main && mainIsIndex && !main.ref_path && (
        <span className="pl-error">「{main.name}」还没填音色参考,念不了</span>
      )}
      {main && !mainIsIndex && main.emotions.length === 0 && (
        <span className="pl-error">「{main.name}」还没有情绪(参考音频),念不了</span>
      )}
      {main && mainIsIndex && main.ref_path && main.emotions.length === 0 && (
        <div className="sp-group-note">
          「{main.name}」还没有情绪行,每句都沿用音色参考的语气。可以在上面展开这个声音,点「按立绘表情补齐」。
        </div>
      )}
      {main && main.emotions.length > 0 && missing.length > 0 && (
        <div className="sp-group-note">
          这些立绘表情在「{main.name}」的情绪表里没有,会用默认情绪「{main.emotions[0].label}」念:
          {missing.join('、')}
        </div>
      )}
```

`CacheGroup` 的说明改成:`合成过的台词存在后端,回看、重播直接用,不重新合成。换了权重、参考、原文、步数、向量或情绪强度,旧的就不会再被用到。`

- [ ] **Step 4: 编译检查**

Run: `cd frontend && npm run build && npm run lint`
Expected: 除了 Task 8 要修的 `ClipState` 那处,没有别的错误和 lint 报警

---

### Task 8: 控制台显示情绪方式

**Files:**
- Modify: `frontend/src/debug/vn/voice.ts`、`frontend/src/debug/vn/VNScreen.tsx`

**Interfaces:**
- Consumes: Task 6 的 `SpeakResult.mode`、`EMO_MODE_TEXT`
- Produces: `ClipState` 的 `ready` 多一个 `mode: EmoMode`

- [ ] **Step 1: `vn/voice.ts`**

import 改成 `import { debugApi, type EmoMode, type SpeakRequest } from '../lib/api';`;

```ts
  | { state: 'ready'; cache: 'hit' | 'miss'; emotion: string; mode: EmoMode; ms: number }
```

`pump()` 里:

```ts
      clip.status = { state: 'ready', cache: r.cache, emotion: r.emotion, mode: r.mode, ms: r.ms };
```

- [ ] **Step 2: `vn/VNScreen.tsx` 控制台的语音表**

先重新读控制台那一段(`grep -n "情绪(要的 → 实际)" vn/VNScreen.tsx`),再改:
- import 里加 `EMO_MODE_TEXT`(和已有的 `from '../plugins/voice'` 合在一起)
- 表头在「情绪(要的 → 实际)」后面加 `<th>方式</th>`
- 情绪那一格后面加:

```tsx
                      <td>{st?.state === 'ready' ? EMO_MODE_TEXT[st.mode] : '—'}</td>
```

- [ ] **Step 3: 编译检查**

Run: `cd frontend && npm run build && npm run lint`
Expected: 没有错误、没有新的 lint 报警

---

### Task 9: 文档、全量验证、浏览器里过一遍

**Files:**
- Modify: `docs/voice-server.md`
- Modify: `docs/superpowers/specs/2026-09-24-indextts-engine-design.md`(状态)

- [ ] **Step 1: `docs/voice-server.md`**

`## 坑` 前面加一节:

```markdown
### IndexTTS-2.5(2026-09-24 开始部署)

- 第二个引擎,和 GSV 并存。设计 `docs/superpowers/specs/2026-09-24-indextts-engine-design.md`,计划 `docs/superpowers/plans/2026-09-24-indextts-engine.md`
- 台式机:代码在 `D:\IndexTTS`(官方仓库,uv 环境);我们的小服务在 `D:\AnimaVoice\indextts-server\`(`server.py`、`start.bat`、部署说明 `DEPLOY.md`),端口 **9890**,先只监听 127.0.0.1
- 由台式机的「Index-tts 部署」会话负责部署和维护;AnimaVN 这边只依赖设计文档里的「小服务接口」
- 试听对比放在台式机 `D:\AnimaVoice\checks\indextts-ab\`
- AnimaVN 里:语音服务选「IndexTTS-2.5」;声音填音色参考;情绪行填向量或情绪参考,可以用「按立绘表情补齐」一键生成
- 老库要先跑 `AnimaBackend/scripts/migrate_voice_indextts_columns.py`
```

`## 进度` 里加一条:`- [ ] IndexTTS-2.5:台式机部署 + 试听对比(进行中);AnimaVN 引擎、接口、界面已完成,等真服务联调`

- [ ] **Step 2: 全量验证**

Run: `cd AnimaBackend && .venv/Scripts/python.exe -m pytest -q`
Expected: 全部通过(155 + 本计划新加的约 20 个)

Run: `cd frontend && npm run build && npm run lint`
Expected: 通过

- [ ] **Step 3: 浏览器里对着假服务过一遍**

真服务还没好,用一个临时的假服务(放 scratchpad,不进仓库),用 AnimaBackend 的 venv 跑:

```python
# fake_indextts.py —— 假的 IndexTTS 小服务,只用来点界面。回一段正弦波,音高跟着「高兴」那一维变
import io
import math
import struct
import wave

import uvicorn
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response

app = FastAPI()


@app.get("/health")
def health():
    return {"model": "IndexTTS-2.5", "ready": True}


@app.post("/tts")
def tts(body: dict):
    print(body, flush=True)
    if body.get("emo_audio_path") and body.get("emo_vector"):
        return JSONResponse({"detail": "情绪来源最多给一个"}, status_code=400)
    freq = 300 + 400 * ((body.get("emo_vector") or [0])[0])
    rate = 24000
    n = int(rate * min(3.0, 0.3 + 0.1 * len(body["text"])))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(
            b"".join(struct.pack("<h", int(6000 * math.sin(2 * math.pi * freq * i / rate))) for i in range(n))
        )
    return Response(buf.getvalue(), media_type="audio/wav", headers={"X-Elapsed-Ms": "5"})


uvicorn.run(app, host="127.0.0.1", port=9890)
```

步骤(不动用户已有的语音服务、声音和卡的绑定):
1. 跑迁移脚本,重启后端;后台起假服务;前端用 `start.bat` 起来的那套
2. 调试台 → 插件 → 语音:点「+ IndexTTS-2.5」,点「测试」应该显示连得上
3. 添加声音「测试·Index」,语音服务选刚才那个,音色参考随便填一个路径
4. 选中阿米娅的卡,展开这个声音,点「按「阿米娅」的立绘表情补齐」:应该补出 10 行,「开心」「红瞳」等有预填向量,「平静」「说话」为空
5. 改一行的向量:改到合计超过 1.5 应该标红、不保存;改回合法值,失焦后保存
6. 试听几行:假服务的日志里能看到 `emo_vector` / `emo_audio_path`,界面显示「向量 / 参考 / 不控制」
7. 窄屏(比如 390 宽)看一下向量编辑器变成 4 列
8. 收尾:删掉「测试·Index」和这个语音服务,关掉假服务

- [ ] **Step 4: 改设计文档的状态**

`状态:` 那一行改成:`**AnimaVN 这边已实现(2026-09-24,未提交)**,等台式机的小服务联调。实现和本文的出入见实施计划开头的表`
