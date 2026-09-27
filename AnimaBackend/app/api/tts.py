"""语音插件:语音服务(连接)的增删改查和测试;合成、预热、缓存。

合成请求由视觉小说界面按句发过来:这里找声音和情绪、查缓存、转给引擎、存缓存。
"""

import dataclasses
import re
import time
from collections.abc import Callable
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.voices import list_emotions
from app.db import get_db
from app.emotion.matcher import Candidate
from app.emotion.service import EmotionUnavailable, get_matcher
from app.models import TtsConnection, VoiceEmotion, VoiceProfile
from app.schemas import (
    TtsCacheOut,
    TtsConnectionIn,
    TtsConnectionOut,
    TtsConnectionUpdate,
    TtsExplainIn,
    TtsExplainOut,
    TtsSpeakIn,
    TtsTimingOut,
    TtsWarmupIn,
    VoiceTuning,
)
from app.tts import cache as tts_cache
from app.tts.base import TTSEngine, TTSError, VoiceSpec
from app.tts.indextts import emo_mode
from app.tts.registry import emo_alpha_of, engine_for, forget_engine

router = APIRouter(prefix="/api/tts", tags=["tts"])

_URL = re.compile(r"^https?://[^\s/]+")
# 至少要有一个字或数字;只有标点时 api_v2 会报「请输入有效文本」
_SPEAKABLE = re.compile(r"\w")


def _ms(start: float) -> int:
    return int((time.perf_counter() - start) * 1000)


def _load_conn(conn_id: str, db: Session) -> TtsConnection:
    conn = db.get(TtsConnection, conn_id)
    if conn is None:
        raise HTTPException(404, "语音服务不存在")
    return conn


def _engine(conn: TtsConnection) -> TTSEngine:
    try:
        return engine_for(conn)
    except TTSError as e:
        raise HTTPException(e.status, e.message) from e


def _clean_url(raw: str) -> str:
    url = raw.strip().rstrip("/")
    if not _URL.match(url):
        raise HTTPException(400, "地址要以 http:// 或 https:// 开头,比如 http://127.0.0.1:9880")
    return url


def _clean_name(raw: str) -> str:
    name = raw.strip()
    if not name:
        raise HTTPException(400, "名字不能为空")
    return name[:120]


def _profile_count(conn_id: str, db: Session) -> int:
    return (
        db.scalar(
            select(func.count())
            .select_from(VoiceProfile)
            .where(VoiceProfile.connection_id == conn_id)
        )
        or 0
    )


def _conn_out(conn: TtsConnection, db: Session) -> TtsConnectionOut:
    return TtsConnectionOut(
        id=conn.id,
        name=conn.name,
        api_type=conn.api_type,
        base_url=conn.base_url,
        sample_steps=conn.sample_steps,
        emo_alpha=emo_alpha_of(conn),
        profile_count=_profile_count(conn.id, db),
    )


@router.get("/connections", response_model=list[TtsConnectionOut])
def list_connections(db: Session = Depends(get_db)):
    rows = db.scalars(select(TtsConnection).order_by(TtsConnection.created_at)).all()
    return [_conn_out(c, db) for c in rows]


@router.post("/connections", response_model=TtsConnectionOut)
def create_connection(req: TtsConnectionIn, db: Session = Depends(get_db)):
    conn = TtsConnection(
        name=_clean_name(req.name),
        api_type=req.api_type,
        base_url=_clean_url(req.base_url),
        sample_steps=req.sample_steps,
        options={"emo_alpha": req.emo_alpha},
    )
    db.add(conn)
    db.commit()
    db.refresh(conn)
    return _conn_out(conn, db)


@router.put("/connections/{conn_id}", response_model=TtsConnectionOut)
def update_connection(conn_id: str, req: TtsConnectionUpdate, db: Session = Depends(get_db)):
    conn = _load_conn(conn_id, db)
    if req.name is not None:
        conn.name = _clean_name(req.name)
    if req.base_url is not None:
        conn.base_url = _clean_url(req.base_url)
    if req.sample_steps is not None:
        conn.sample_steps = req.sample_steps
    if req.emo_alpha is not None:
        # JSON 列要整个换掉,原地改 SQLAlchemy 看不出变化
        conn.options = {**(conn.options or {}), "emo_alpha": req.emo_alpha}
    db.commit()
    db.refresh(conn)
    return _conn_out(conn, db)


@router.delete("/connections/{conn_id}", status_code=204)
def delete_connection(conn_id: str, db: Session = Depends(get_db)):
    conn = _load_conn(conn_id, db)
    count = _profile_count(conn_id, db)
    if count:
        raise HTTPException(400, f"还有 {count} 个声音档案在用这个连接")
    db.delete(conn)
    db.commit()
    forget_engine(conn_id)


@router.post("/connections/{conn_id}/test", response_model=TtsTimingOut)
async def test_connection(conn_id: str, db: Session = Depends(get_db)):
    engine = _engine(_load_conn(conn_id, db))
    start = time.perf_counter()
    try:
        await engine.ping()
    except TTSError as e:
        raise HTTPException(e.status, e.message) from e
    return TtsTimingOut(ms=_ms(start))


# ── 合成 ──────────────────────────────────────────────


@dataclasses.dataclass(frozen=True)
class EmotionPick:
    """情绪表里挑中的那一行,以及怎么挑中的(/explain 给人排查语音用)"""

    row: VoiceEmotion | None
    # exact 名字对上 / alias 别名对上 / nearest 模型挑的最像的 / default 没传或对不上,用排第一的
    how: str
    # alias:对上的别名;nearest:模型认为最像的那个名字(可能是别名)
    via: str | None = None
    # nearest:相似度
    score: float | None = None


def pick_emotion(
    emotions: list[VoiceEmotion],
    wanted: str | None,
    nearest: Callable[[str, list[VoiceEmotion]], EmotionPick | None] | None = None,
) -> EmotionPick:
    """名字或别名对上(不分大小写)就用那一行;对不上时交给 nearest 挑最像的一行
    (就近回退:琴柳没有「惊讶」的参考,用最接近的一段,而不是一律念成平静);
    还是没有、或者没传情绪,用排第一的(默认)。"""
    if not emotions:
        return EmotionPick(None, "default")
    key = (wanted or "").strip().casefold()
    if key:
        for e in emotions:
            if e.label.casefold() == key:
                return EmotionPick(e, "exact")
            alias = next((a for a in e.aliases or [] if a.casefold() == key), None)
            if alias is not None:
                return EmotionPick(e, "alias", via=alias)
        if nearest is not None and (near := nearest(wanted.strip(), emotions)) is not None:
            return near
    return EmotionPick(emotions[0], "default")


# 和 /api/emotion/match 的限制一致
_MAX_WORD = 40


def nearest_emotion(wanted: str, emotions: list[VoiceEmotion]) -> EmotionPick | None:
    """情绪识别模型挑最像的一行(名字和别名都算);模型没装或出错返回 None,由调用方用默认"""
    if not wanted or len(wanted) > _MAX_WORD:
        return None
    candidates = []
    for e in emotions:
        names = tuple(n.strip() for n in (e.label, *(e.aliases or [])) if 0 < len(n.strip()) <= _MAX_WORD)
        if names:
            candidates.append(Candidate(e.id, names))
    if not candidates:
        return None
    try:
        matcher = get_matcher()
    except EmotionUnavailable:
        return None
    m = matcher.match([wanted], candidates)[0]
    row = next((e for e in emotions if e.id == m.key), None)
    return EmotionPick(row, "nearest", via=m.name, score=m.score) if row else None


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
        params=dict(profile.params or {}),
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
        params=dict(profile.params or {}),
    )
    return spec, row.label if row else "", emo_mode(spec)


@dataclasses.dataclass(frozen=True)
class VoiceChoice:
    """一句要用的声音和语音服务、合成配置、实际用的情绪名、情绪方式(ref / vector / none)、怎么挑的情绪"""

    conn: TtsConnection
    profile: VoiceProfile
    spec: VoiceSpec
    label: str
    mode: str
    pick: EmotionPick


def _voice_for(
    profile_id: str, emotion: str | None, db: Session, tuning: VoiceTuning | None = None
) -> VoiceChoice:
    """声音 + 想要的情绪 → 这句怎么念。
    tuning(试音台)整组替换声音存着的语速、语言和参数,只用于这一次"""
    profile = db.get(VoiceProfile, profile_id)
    if profile is None:
        raise HTTPException(404, "声音不存在")
    conn = db.get(TtsConnection, profile.connection_id)
    if conn is None:
        raise HTTPException(400, f"声音「{profile.name}」没有选语音服务")
    pick = pick_emotion(list_emotions(profile.id, db), emotion, nearest_emotion)
    build = _indextts_spec if conn.api_type == "indextts" else _gsv_spec
    spec, label, mode = build(profile, pick.row)
    if tuning is not None:
        params = tuning.params.model_dump(exclude_none=True)
        if tuning.seed is not None:
            params["seed"] = tuning.seed
        spec = dataclasses.replace(spec, speed=tuning.speed, text_lang=tuning.text_lang, params=params)
    return VoiceChoice(conn, profile, spec, label, mode, pick)


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


def _speakable(raw: str) -> str:
    text = raw.strip()
    if not _SPEAKABLE.search(text):
        raise HTTPException(400, "没有要念的文字")
    return text


@router.post("/speak")
async def speak(req: TtsSpeakIn, db: Session = Depends(get_db)):
    text = _speakable(req.text)
    v = _voice_for(req.profile_id, req.emotion, db, req.tuning)
    engine = _engine(v.conn)
    key = tts_cache.cache_key(engine.cache_material(text, v.spec))
    # 每次合成的随机种子不同,重新生成就是换一种念法
    hit = None if req.fresh else tts_cache.cache_get(db, key)
    if hit is not None:
        return _audio(*hit, cache="hit", emotion=v.label, mode=v.mode)
    try:
        data, mime = await engine.synthesize(text, v.spec)
    except TTSError as e:
        raise HTTPException(e.status, e.message) from e
    tts_cache.cache_put(db, key, data, mime)
    return _audio(data, mime, cache="miss", emotion=v.label, mode=v.mode)


@router.post("/explain", response_model=TtsExplainOut)
def explain(req: TtsExplainIn, db: Session = Depends(get_db)):
    """这句会怎么念:和 /speak 同一套挑法,但不合成、不碰语音服务。
    挑中哪一行情绪、怎么挑中的、发给语音服务的原样请求、缓存里有没有 —— 视觉小说「历史」排查语音用"""
    text = _speakable(req.text)
    v = _voice_for(req.profile_id, req.emotion, db)
    engine = _engine(v.conn)
    return TtsExplainOut(
        profile_name=v.profile.name,
        connection_name=v.conn.name,
        api_type=v.conn.api_type,
        wanted=req.emotion,
        emotion=v.label,
        how=v.pick.how,
        via=v.pick.via,
        score=v.pick.score,
        mode=v.mode,
        gpt_weights=v.spec.gpt_weights,
        sovits_weights=v.spec.sovits_weights,
        request=engine.request_body(text, v.spec),
        cached=tts_cache.cache_has(db, tts_cache.cache_key(engine.cache_material(text, v.spec))),
    )


@router.get("/reference")
async def reference_audio(profile_id: str, path: str, db: Session = Depends(get_db)):
    """声音配的一段参考音频(音色参考,或者某一行情绪的参考),从语音服务那台机器上原样取回 ——
    「语音详情」里试听原声用。只放行这个声音自己配过的路径,不做成能读任意文件的转发"""
    profile = db.get(VoiceProfile, profile_id)
    if profile is None:
        raise HTTPException(404, "声音不存在")
    known = {profile.ref_path, *(e.ref_path for e in list_emotions(profile.id, db))}
    if not path or path not in known:
        raise HTTPException(404, "这个声音没有配这段参考音频")
    conn = db.get(TtsConnection, profile.connection_id)
    if conn is None:
        raise HTTPException(400, f"声音「{profile.name}」没有选语音服务")
    try:
        data, mime = await _engine(conn).reference_audio(path)
    except TTSError as e:
        raise HTTPException(e.status, e.message) from e
    # 同一段在一次打开里常会反复听;台式机上换了文件,最多十分钟后听到新的
    return Response(content=data, media_type=mime, headers={"Cache-Control": "private, max-age=600"})


@router.post("/warmup", response_model=TtsTimingOut)
async def warmup(req: TtsWarmupIn, db: Session = Depends(get_db)):
    """用这个声音的默认情绪合成一句,不进缓存。服务刚启动时要等 30–40 秒。"""
    v = _voice_for(req.profile_id, None, db)
    engine = _engine(v.conn)
    start = time.perf_counter()
    try:
        await engine.warmup(v.spec, req.force)
    except TTSError as e:
        raise HTTPException(e.status, e.message) from e
    return TtsTimingOut(ms=_ms(start))


@router.get("/cache", response_model=TtsCacheOut)
def cache_stats(db: Session = Depends(get_db)):
    count, total = tts_cache.cache_stats(db)
    return TtsCacheOut(count=count, bytes=total, limit_bytes=tts_cache.CACHE_LIMIT)


@router.delete("/cache", status_code=204)
def clear_cache(db: Session = Depends(get_db)):
    tts_cache.cache_clear(db)
