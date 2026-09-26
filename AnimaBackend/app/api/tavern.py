"""酒馆角色卡 / 提示词预设的 CRUD。

调试台（prompt console）用这组端点持久化它导入或编辑的卡和预设。
PNG 解析留在前端 —— 前端解析完把 JSON 和头像一起 POST 过来，
后端只负责存取，不重复实现 PNG chunk 解析。
"""

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.api.scenes import copy_card_scene_binding, delete_card_scene_binding
from app.api.sprites import copy_card_sprites, delete_card_sprites
from app.api.voices import copy_card_voices, delete_card_voices
from app.db import get_db
from app.models import DebugChat, PromptPreset, TavernCard
from app.schemas import (
    DuplicateRequest,
    PromptPresetCreate,
    PromptPresetOut,
    PromptPresetUpdate,
    TavernCardCreate,
    TavernCardOut,
    TavernCardUpdate,
)

router = APIRouter(prefix="/api/tavern", tags=["tavern"])


def _card_out(card: TavernCard) -> TavernCardOut:
    return TavernCardOut(
        id=card.id,
        name=card.name,
        description=card.description,
        personality=card.personality,
        scenario=card.scenario,
        first_mes=card.first_mes,
        mes_example=card.mes_example,
        system_prompt=card.system_prompt,
        post_history_instructions=card.post_history_instructions,
        creator_notes=card.creator_notes,
        alternate_greetings=card.alternate_greetings or [],
        tags=card.tags or [],
        creator=card.creator,
        character_version=card.character_version,
        character_book=card.character_book,
        extensions=card.extensions or {},
        spec=card.spec,
        has_avatar=bool(card.avatar),
        last_chat_id=card.last_chat_id,
        created_at=card.created_at,
        updated_at=card.updated_at,
    )


def _copy_name(original: str, requested: str | None) -> str:
    return (requested or "").strip() or f"{original} - 副本"


def _unique_preset_name(name: str, db: Session, exclude_id: str | None = None) -> str:
    """预设名不允许重复 —— 撞名就强制加 (2) / (3)... 后缀,直到不撞为止。"""
    base = name.strip() or "未命名预设"
    candidate = base
    suffix = 2
    while True:
        q = select(PromptPreset.id).where(PromptPreset.name == candidate)
        if exclude_id is not None:
            q = q.where(PromptPreset.id != exclude_id)
        if db.scalars(q).first() is None:
            return candidate
        candidate = f"{base} ({suffix})"
        suffix += 1


# ══════════════ 角色卡 ══════════════


def _load_card(card_id: str, db: Session) -> TavernCard:
    card = db.get(TavernCard, card_id)
    if card is None:
        raise HTTPException(404, "角色卡不存在")
    return card


@router.get("/cards", response_model=list[TavernCardOut])
def list_cards(db: Session = Depends(get_db)):
    cards = db.scalars(select(TavernCard).order_by(TavernCard.created_at)).all()
    return [_card_out(c) for c in cards]


@router.get("/cards/{card_id}", response_model=TavernCardOut)
def get_card(card_id: str, db: Session = Depends(get_db)):
    return _card_out(_load_card(card_id, db))


@router.post("/cards", response_model=TavernCardOut)
def create_card(req: TavernCardCreate, db: Session = Depends(get_db)):
    card = TavernCard(**req.model_dump())
    db.add(card)
    db.commit()
    db.refresh(card)
    return _card_out(card)


@router.put("/cards/{card_id}", response_model=TavernCardOut)
def update_card(card_id: str, req: TavernCardUpdate, db: Session = Depends(get_db)):
    card = _load_card(card_id, db)
    # exclude_unset: the console sends only the field the user just edited
    for field, value in req.model_dump(exclude_unset=True).items():
        setattr(card, field, value)
    db.commit()
    db.refresh(card)
    return _card_out(card)


@router.delete("/cards/{card_id}", status_code=204)
def delete_card(card_id: str, db: Session = Depends(get_db)):
    card = _load_card(card_id, db)
    # 对话比卡活得久:每条分支都存着完整提示词快照,历史照样能回看。
    # 引用置空而不是删对话(SQLAlchemy 的 FK 不带 pragma 不级联,手动来)。
    db.execute(update(DebugChat).where(DebugChat.card_id == card_id).values(card_id=None))
    delete_card_sprites(card_id, db)
    delete_card_scene_binding(card_id, db)
    delete_card_voices(card_id, db)
    db.delete(card)
    db.commit()


@router.post("/cards/{card_id}/duplicate", response_model=TavernCardOut)
def duplicate_card(card_id: str, req: DuplicateRequest, db: Session = Depends(get_db)):
    src = _load_card(card_id, db)
    copy = TavernCard(
        name=_copy_name(src.name, req.name),
        description=src.description,
        personality=src.personality,
        scenario=src.scenario,
        first_mes=src.first_mes,
        mes_example=src.mes_example,
        system_prompt=src.system_prompt,
        post_history_instructions=src.post_history_instructions,
        creator_notes=src.creator_notes,
        alternate_greetings=list(src.alternate_greetings or []),
        tags=list(src.tags or []),
        creator=src.creator,
        character_version=src.character_version,
        character_book=src.character_book,
        extensions=dict(src.extensions or {}),
        spec=src.spec,
        avatar=src.avatar,
        # last_chat_id 故意不复制:副本还一条对话都没有,继承过来会让它一进去
        # 就打开原卡的对话
    )
    db.add(copy)
    db.flush()  # 先拿到副本的 id,立绘行要挂在它下面
    copy_card_sprites(src.id, copy.id, db)
    copy_card_scene_binding(src.id, copy.id, db)
    copy_card_voices(src.id, copy.id, db)
    db.commit()
    db.refresh(copy)
    return _card_out(copy)


@router.get("/cards/{card_id}/avatar")
def get_card_avatar(card_id: str, db: Session = Depends(get_db)):
    """头像单独取,列表接口只回 has_avatar,免得列一堆卡时把图全拖下来。"""
    card = _load_card(card_id, db)
    if not card.avatar:
        raise HTTPException(404, "这张卡没有头像")
    return Response(content=card.avatar, media_type="text/plain")


# ══════════════ 预设 ══════════════


def _load_preset(preset_id: str, db: Session) -> PromptPreset:
    preset = db.get(PromptPreset, preset_id)
    if preset is None:
        raise HTTPException(404, "预设不存在")
    return preset


@router.get("/presets", response_model=list[PromptPresetOut])
def list_presets(db: Session = Depends(get_db)):
    return db.scalars(select(PromptPreset).order_by(PromptPreset.created_at)).all()


@router.get("/presets/{preset_id}", response_model=PromptPresetOut)
def get_preset(preset_id: str, db: Session = Depends(get_db)):
    return _load_preset(preset_id, db)


@router.post("/presets", response_model=PromptPresetOut)
def create_preset(req: PromptPresetCreate, db: Session = Depends(get_db)):
    if not req.name.strip():
        raise HTTPException(400, "预设名不能为空")
    data = req.model_dump()
    data["name"] = _unique_preset_name(req.name, db)
    preset = PromptPreset(**data)
    db.add(preset)
    db.commit()
    db.refresh(preset)
    return preset


@router.put("/presets/{preset_id}", response_model=PromptPresetOut)
def update_preset(preset_id: str, req: PromptPresetUpdate, db: Session = Depends(get_db)):
    preset = _load_preset(preset_id, db)
    updates = req.model_dump(exclude_unset=True)
    if "name" in updates and not (updates["name"] or "").strip():
        raise HTTPException(400, "预设名不能为空")
    if "name" in updates:
        updates["name"] = _unique_preset_name(updates["name"], db, exclude_id=preset_id)
    for field, value in updates.items():
        setattr(preset, field, value)
    db.commit()
    db.refresh(preset)
    return preset


@router.delete("/presets/{preset_id}", status_code=204)
def delete_preset(preset_id: str, db: Session = Depends(get_db)):
    # 同上:预设删了只影响「继续聊」时的组装,历史快照自包含
    db.execute(update(DebugChat).where(DebugChat.preset_id == preset_id).values(preset_id=None))
    db.delete(_load_preset(preset_id, db))
    db.commit()


@router.post("/presets/{preset_id}/duplicate", response_model=PromptPresetOut)
def duplicate_preset(preset_id: str, req: DuplicateRequest, db: Session = Depends(get_db)):
    src = _load_preset(preset_id, db)
    copy = PromptPreset(
        name=_unique_preset_name(_copy_name(src.name, req.name), db),
        prompts=list(src.prompts or []),
        prompt_order=list(src.prompt_order or []),
        formats=dict(src.formats or {}),
        params=dict(src.params or {}),
        squash_system_messages=src.squash_system_messages,
    )
    db.add(copy)
    db.commit()
    db.refresh(copy)
    return copy
