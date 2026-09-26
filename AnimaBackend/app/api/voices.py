"""语音插件:声音、情绪表、角色卡用哪些声音。

声音 = 一个语音服务 + 一套模型权重;情绪 = 一段参考音频 + 它的原文。权重和参考音频
都在语音服务那台机器上,这里只存路径(api_v2 只认服务端本地路径)。

名字规则和立绘一样:情绪名要和立绘表情名对上(这句生效的表情是「开心」就用「开心」
那段参考),声音名要和台词前的「名字：」对上。
"""

import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.api.sprites import clean_aliases, clean_label
from app.db import get_db
from app.models import CardSprite, CardVoice, TavernCard, TtsConnection, VoiceEmotion, VoiceProfile
from app.schemas import (
    CardVoicesIn,
    CardVoicesOut,
    VoiceEmotionIn,
    VoiceEmotionOut,
    VoiceEmotionUpdate,
    VoiceFromSpritesIn,
    VoiceImportIn,
    VoiceProfileIn,
    VoiceProfileOut,
    VoiceProfileUpdate,
    VoiceReorder,
)
from app.tts.emotion_presets import BUILTIN_EMOTIONS, clean_emo_vector, preset_vector

router = APIRouter(tags=["voices"])

PROFILES = "/api/voices"
CARD_VOICES = "/api/tavern/cards/{card_id}/voices"

# 语音服务那台机器上参考音频的命名:【情绪】原文.wav
_REF_NAME = re.compile(r"^【([^】]+)】(.+)\.[A-Za-z0-9]+$")


def clean_path(raw: str) -> str:
    """资源管理器的「复制文件地址」会带上双引号,顺手去掉。"""
    return raw.strip().strip('"').strip()


def clean_vector(raw: list[float] | None) -> list[float] | None:
    try:
        return clean_emo_vector(raw)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


def parse_ref_name(path: str) -> tuple[str, str] | None:
    """文件名是「【情绪】原文.wav」时取出 (情绪名, 原文)。"""
    m = _REF_NAME.match(re.split(r"[\\/]", path)[-1])
    return (m.group(1).strip(), m.group(2).strip()) if m else None


def list_emotions(profile_id: str, db: Session) -> list[VoiceEmotion]:
    """排第一的是默认情绪。"""
    return list(
        db.scalars(
            select(VoiceEmotion)
            .where(VoiceEmotion.profile_id == profile_id)
            .order_by(VoiceEmotion.sort, VoiceEmotion.created_at)
        )
    )


def _load_profile(profile_id: str, db: Session) -> VoiceProfile:
    profile = db.get(VoiceProfile, profile_id)
    if profile is None:
        raise HTTPException(404, "声音不存在")
    return profile


def _load_emotion(profile_id: str, emotion_id: str, db: Session) -> VoiceEmotion:
    emotion = db.get(VoiceEmotion, emotion_id)
    if emotion is None or emotion.profile_id != profile_id:
        raise HTTPException(404, "情绪不存在")
    return emotion


def _check_connection(connection_id: str, db: Session) -> None:
    if db.get(TtsConnection, connection_id) is None:
        raise HTTPException(400, "语音服务不存在")


def _find_profile(name: str, db: Session, exclude_id: str | None = None) -> VoiceProfile | None:
    for row in db.scalars(select(VoiceProfile)):
        if row.id != exclude_id and row.name.casefold() == name.casefold():
            return row
    return None


def _check_emotion_names(
    profile_id: str, names: list[str], db: Session, exclude_id: str | None = None
) -> None:
    """同一个声音里,情绪名 / 别名不能撞 —— 撞了就不知道该用哪段参考。"""
    taken: dict[str, str] = {}
    for row in list_emotions(profile_id, db):
        if row.id == exclude_id:
            continue
        for n in [row.label, *(row.aliases or [])]:
            taken[n.casefold()] = row.label
    for n in names:
        owner = taken.get(n.casefold())
        if owner is not None:
            raise HTTPException(409, f"情绪名「{n}」已经被「{owner}」占用了")


def _emotion_out(e: VoiceEmotion) -> VoiceEmotionOut:
    return VoiceEmotionOut(
        id=e.id,
        profile_id=e.profile_id,
        label=e.label,
        aliases=list(e.aliases or []),
        ref_path=e.ref_path,
        prompt_text=e.prompt_text,
        emo_vector=list(e.emo_vector) if e.emo_vector else None,
        sort=e.sort,
    )


def _profile_out(p: VoiceProfile, db: Session) -> VoiceProfileOut:
    cards = (
        db.scalar(select(func.count()).select_from(CardVoice).where(CardVoice.profile_id == p.id))
        or 0
    )
    return VoiceProfileOut(
        id=p.id,
        name=p.name,
        aliases=list(p.aliases or []),
        connection_id=p.connection_id,
        gpt_weights=p.gpt_weights,
        sovits_weights=p.sovits_weights,
        ref_path=p.ref_path,
        text_lang=p.text_lang,
        speed=p.speed,
        params=dict(p.params or {}),
        emotions=[_emotion_out(e) for e in list_emotions(p.id, db)],
        card_count=cards,
    )


# ── 声音 ──────────────────────────────────────────────


@router.post(PROFILES + "/import", response_model=VoiceProfileOut)
def import_refs(req: VoiceImportIn, db: Session = Depends(get_db)):
    """导入一份 refs.json。同名的声音更新权重路径和同名情绪,新情绪加在最后,不会重复添加。"""
    conn = db.get(TtsConnection, req.connection_id)
    if conn is None:
        raise HTTPException(400, "语音服务不存在")
    # IndexTTS 不需要参考音频的原文;音色参考单独给(没给就用第一条)
    is_index = conn.api_type == "indextts"
    data = req.refs
    raw_name = data.get("character")
    if not isinstance(raw_name, str) or not raw_name.strip():
        raise HTTPException(400, "refs.json 里没有 character(角色名)")
    name = clean_label(raw_name, "声音名")
    refs = data.get("refs")
    if not isinstance(refs, list) or not refs:
        raise HTTPException(400, "refs.json 里没有 refs(参考音频列表)")

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

    profile = _find_profile(name, db)
    if profile is None:
        profile = VoiceProfile(name=name, aliases=[], connection_id=req.connection_id)
        db.add(profile)
        db.flush()
    profile.connection_id = req.connection_id
    for key in ("gpt_weights", "sovits_weights"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            setattr(profile, key, clean_path(value))
    speaker = data.get("speaker_ref")
    if isinstance(speaker, str) and speaker.strip():
        profile.ref_path = clean_path(speaker)
    elif is_index and not profile.ref_path:
        profile.ref_path = rows[0][1]

    existing = list_emotions(profile.id, db)
    by_name = {n.casefold(): e for e in existing for n in [e.label, *(e.aliases or [])]}
    next_sort = max((e.sort for e in existing), default=-1) + 1
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
    db.commit()
    db.refresh(profile)
    return _profile_out(profile, db)


@router.get(PROFILES, response_model=list[VoiceProfileOut])
def list_profiles(db: Session = Depends(get_db)):
    rows = db.scalars(select(VoiceProfile).order_by(VoiceProfile.created_at)).all()
    return [_profile_out(p, db) for p in rows]


@router.post(PROFILES, response_model=VoiceProfileOut)
def create_profile(req: VoiceProfileIn, db: Session = Depends(get_db)):
    name = clean_label(req.name, "声音名")
    if _find_profile(name, db):
        raise HTTPException(409, f"已经有叫「{name}」的声音了")
    _check_connection(req.connection_id, db)
    profile = VoiceProfile(
        name=name,
        aliases=clean_aliases(req.aliases, name, "声音名"),
        connection_id=req.connection_id,
        gpt_weights=clean_path(req.gpt_weights),
        sovits_weights=clean_path(req.sovits_weights),
        ref_path=clean_path(req.ref_path),
        text_lang=req.text_lang.strip() or "zh",
        speed=req.speed,
        params=req.params.model_dump(exclude_none=True),
    )
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return _profile_out(profile, db)


@router.put(PROFILES + "/{profile_id}", response_model=VoiceProfileOut)
def update_profile(profile_id: str, req: VoiceProfileUpdate, db: Session = Depends(get_db)):
    profile = _load_profile(profile_id, db)
    u = req.model_dump(exclude_unset=True)
    if u.get("name") is not None:
        name = clean_label(u["name"], "声音名")
        if _find_profile(name, db, exclude_id=profile_id):
            raise HTTPException(409, f"已经有叫「{name}」的声音了")
        profile.name = name
    if u.get("aliases") is not None:
        profile.aliases = clean_aliases(u["aliases"], profile.name, "声音名")
    if u.get("connection_id") is not None:
        _check_connection(u["connection_id"], db)
        profile.connection_id = u["connection_id"]
    for key in ("gpt_weights", "sovits_weights", "ref_path"):
        if u.get(key) is not None:
            setattr(profile, key, clean_path(u[key]))
    if u.get("text_lang") is not None:
        profile.text_lang = u["text_lang"].strip() or "zh"
    if u.get("speed") is not None:
        profile.speed = u["speed"]
    if req.params is not None:
        profile.params = req.params.model_dump(exclude_none=True)
    db.commit()
    db.refresh(profile)
    return _profile_out(profile, db)


@router.delete(PROFILES + "/{profile_id}", status_code=204)
def delete_profile(profile_id: str, db: Session = Depends(get_db)):
    profile = _load_profile(profile_id, db)
    # SQLite 默认不开外键约束,不会自动级联,手动删情绪行和卡的绑定
    db.execute(delete(VoiceEmotion).where(VoiceEmotion.profile_id == profile_id))
    db.execute(delete(CardVoice).where(CardVoice.profile_id == profile_id))
    db.delete(profile)
    db.commit()


# ── 情绪 ──────────────────────────────────────────────


@router.post(PROFILES + "/{profile_id}/emotions", response_model=VoiceEmotionOut)
def create_emotion(profile_id: str, req: VoiceEmotionIn, db: Session = Depends(get_db)):
    _load_profile(profile_id, db)
    label = clean_label(req.label, "情绪名")
    aliases = clean_aliases(req.aliases, label, "情绪名")
    _check_emotion_names(profile_id, [label, *aliases], db)
    ref_path = clean_path(req.ref_path)
    prompt_text = req.prompt_text.strip()
    parsed = parse_ref_name(ref_path)
    if not prompt_text and parsed:
        prompt_text = parsed[1]
    last = db.scalar(
        select(func.max(VoiceEmotion.sort)).where(VoiceEmotion.profile_id == profile_id)
    )
    emotion = VoiceEmotion(
        profile_id=profile_id,
        label=label,
        aliases=aliases,
        ref_path=ref_path,
        prompt_text=prompt_text,
        emo_vector=clean_vector(req.emo_vector),
        sort=(last + 1) if last is not None else 0,
    )
    db.add(emotion)
    db.commit()
    db.refresh(emotion)
    return _emotion_out(emotion)


@router.put(PROFILES + "/{profile_id}/emotions/{emotion_id}", response_model=VoiceEmotionOut)
def update_emotion(
    profile_id: str, emotion_id: str, req: VoiceEmotionUpdate, db: Session = Depends(get_db)
):
    emotion = _load_emotion(profile_id, emotion_id, db)
    u = req.model_dump(exclude_unset=True)
    label = clean_label(u["label"], "情绪名") if u.get("label") is not None else emotion.label
    raw_aliases = u.get("aliases")
    aliases = clean_aliases(
        raw_aliases if raw_aliases is not None else emotion.aliases or [], label, "情绪名"
    )
    _check_emotion_names(profile_id, [label, *aliases], db, exclude_id=emotion_id)
    emotion.label = label
    emotion.aliases = aliases
    if u.get("ref_path") is not None:
        emotion.ref_path = clean_path(u["ref_path"])
    if u.get("prompt_text") is not None:
        emotion.prompt_text = u["prompt_text"].strip()
    if "emo_vector" in u:
        emotion.emo_vector = clean_vector(u["emo_vector"])
    db.commit()
    db.refresh(emotion)
    return _emotion_out(emotion)


@router.delete(PROFILES + "/{profile_id}/emotions/{emotion_id}", status_code=204)
def delete_emotion(profile_id: str, emotion_id: str, db: Session = Depends(get_db)):
    db.delete(_load_emotion(profile_id, emotion_id, db))
    db.commit()


@router.post(PROFILES + "/{profile_id}/emotions/reorder", response_model=list[VoiceEmotionOut])
def reorder_emotions(profile_id: str, req: VoiceReorder, db: Session = Depends(get_db)):
    _load_profile(profile_id, db)
    rows = {e.id: e for e in list_emotions(profile_id, db)}
    if sorted(req.ids) != sorted(rows):
        raise HTTPException(400, "排序列表必须正好包含这个声音的全部情绪")
    for i, eid in enumerate(req.ids):
        rows[eid].sort = i
    db.commit()
    return [_emotion_out(rows[eid]) for eid in req.ids]


@router.post(
    PROFILES + "/{profile_id}/emotions/from-sprites", response_model=list[VoiceEmotionOut]
)
def emotions_from_sprites(profile_id: str, req: VoiceFromSpritesIn, db: Session = Depends(get_db)):
    """每个立绘表情一行,向量按常见表情名预填;已有的行(名字或别名对上)不动,只加缺的。
    这张卡一张立绘都没有时,按内置基础表情补(带上别名),和 {{sprites}} 的兜底是同一份"""
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
    db.commit()
    return [_emotion_out(e) for e in list_emotions(profile_id, db)]


# ── 卡的绑定 ──────────────────────────────────────────────


def _card_voices(card_id: str, db: Session) -> CardVoicesOut:
    rows = db.scalars(select(CardVoice).where(CardVoice.card_id == card_id)).all()
    return CardVoicesOut(
        card_id=card_id,
        main=next((r.profile_id for r in rows if r.is_main), None),
        extras=[r.profile_id for r in rows if not r.is_main],
    )


def _load_card(card_id: str, db: Session) -> None:
    if db.get(TavernCard, card_id) is None:
        raise HTTPException(404, "角色卡不存在")


@router.get(CARD_VOICES, response_model=CardVoicesOut)
def get_card_voices(card_id: str, db: Session = Depends(get_db)):
    _load_card(card_id, db)
    return _card_voices(card_id, db)


@router.put(CARD_VOICES, response_model=CardVoicesOut)
def set_card_voices(card_id: str, req: CardVoicesIn, db: Session = Depends(get_db)):
    _load_card(card_id, db)
    extras = [pid for pid in dict.fromkeys(req.extras) if pid != req.main]
    ids = ([req.main] if req.main else []) + extras
    for pid in ids:
        _load_profile(pid, db)
    db.execute(delete(CardVoice).where(CardVoice.card_id == card_id))
    for pid in ids:
        db.add(CardVoice(card_id=card_id, profile_id=pid, is_main=pid == req.main))
    db.commit()
    return _card_voices(card_id, db)


def delete_card_voices(card_id: str, db: Session) -> None:
    """删卡时由 tavern.delete_card 调用。声音本身是共用的,不跟着删。"""
    db.execute(delete(CardVoice).where(CardVoice.card_id == card_id))


def copy_card_voices(src_id: str, dst_id: str, db: Session) -> None:
    """复制卡时用同样的声音(声音是共用的,不复制声音本身)。"""
    for r in db.scalars(select(CardVoice).where(CardVoice.card_id == src_id)).all():
        db.add(CardVoice(card_id=dst_id, profile_id=r.profile_id, is_main=r.is_main))
