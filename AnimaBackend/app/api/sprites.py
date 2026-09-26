"""立绘插件:角色卡的「表情名 → 立绘图」映射表。

表情名是给 AI 用的词汇表(label + aliases),图是 BLOB。列表接口只返回元数据
和 has_image,图单独按 id 取,并且带版本号走长缓存 —— 视觉小说界面切换表情时,
图片都是直接从浏览器缓存里拿的。
"""

import re

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session, undefer

from app.db import get_db
from app.models import CardSprite, TavernCard
from app.schemas import CardSpriteCreate, CardSpriteOut, CardSpriteUpdate, SpriteReorderRequest

router = APIRouter(prefix="/api/tavern/cards/{card_id}/sprites", tags=["sprites"])

# 一张立绘撑死几 MB;nginx 那边的上限是 20m,这里再收紧一点
MAX_IMAGE_BYTES = 8 * 1024 * 1024

LABEL_MAX = 40

# 表情名会被塞进用户自定义的标签模板里(比如 <sprite:{表情}>、【{表情}】),
# 名字里带这些括号,解析器就分不清标签在哪里结束了
_FORBIDDEN = re.compile(r"[\n\r<>\[\]{}【】「」]")


def _load_card(card_id: str, db: Session) -> TavernCard:
    card = db.get(TavernCard, card_id)
    if card is None:
        raise HTTPException(404, "角色卡不存在")
    return card


def _load_sprite(card_id: str, sprite_id: str, db: Session) -> CardSprite:
    sprite = db.get(CardSprite, sprite_id)
    if sprite is None or sprite.card_id != card_id:
        raise HTTPException(404, "立绘不存在")
    return sprite


def _version(sprite: CardSprite) -> int:
    return int(sprite.updated_at.timestamp() * 1000)


def _out(sprite: CardSprite) -> CardSpriteOut:
    return CardSpriteOut(
        id=sprite.id,
        card_id=sprite.card_id,
        label=sprite.label,
        aliases=list(sprite.aliases or []),
        description=sprite.description,
        has_image=sprite.mime is not None,
        image_version=_version(sprite),
        sort=sprite.sort,
    )


def clean_label(raw: str, noun: str = "表情名") -> str:
    """AI 要在标签里点名的名字:去空白,查长度和括号。场景包的素材名也走这里。"""
    name = raw.strip()
    if not name:
        raise HTTPException(400, f"{noun}不能为空")
    if len(name) > LABEL_MAX:
        raise HTTPException(400, f"{noun}最长 {LABEL_MAX} 个字")
    if _FORBIDDEN.search(name):
        raise HTTPException(400, f"{noun}「{name}」里不能有换行或 <>[]{{}}【】「」 这些括号")
    return name


def clean_aliases(raw: list[str], label: str, noun: str = "表情名") -> list[str]:
    out: list[str] = []
    seen = {label.casefold()}
    for a in raw:
        if not a.strip():
            continue
        name = clean_label(a, noun)
        if name.casefold() in seen:
            continue
        seen.add(name.casefold())
        out.append(name)
    return out


def _check_unique(card_id: str, names: list[str], db: Session, exclude_id: str | None = None):
    """同一张卡里,任何两行的表情名/别名都不能撞 —— 撞了就不知道该换哪张图。"""
    taken: dict[str, str] = {}
    for row in db.scalars(select(CardSprite).where(CardSprite.card_id == card_id)):
        if row.id == exclude_id:
            continue
        for n in [row.label, *(row.aliases or [])]:
            taken[n.casefold()] = row.label
    for n in names:
        owner = taken.get(n.casefold())
        if owner is not None:
            raise HTTPException(409, f"表情名「{n}」已经被「{owner}」占用了")


def sniff_image_mime(data: bytes) -> str | None:
    """按文件头认格式,不信任上传时声明的 content-type。

    这些图和页面同源,如果按客户端声明的类型原样返回,就有人能传一个 HTML
    当「图片」,借同源执行脚本。
    """
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


@router.get("", response_model=list[CardSpriteOut])
def list_sprites(card_id: str, db: Session = Depends(get_db)):
    _load_card(card_id, db)
    rows = db.scalars(
        select(CardSprite)
        .where(CardSprite.card_id == card_id)
        .order_by(CardSprite.sort, CardSprite.created_at)
    ).all()
    return [_out(r) for r in rows]


@router.post("", response_model=CardSpriteOut)
def create_sprite(card_id: str, req: CardSpriteCreate, db: Session = Depends(get_db)):
    _load_card(card_id, db)
    label = clean_label(req.label)
    aliases = clean_aliases(req.aliases, label)
    _check_unique(card_id, [label, *aliases], db)
    last = db.scalar(select(func.max(CardSprite.sort)).where(CardSprite.card_id == card_id))
    sprite = CardSprite(
        card_id=card_id,
        label=label,
        aliases=aliases,
        description=req.description.strip(),
        sort=(last + 1) if last is not None else 0,
    )
    db.add(sprite)
    db.commit()
    db.refresh(sprite)
    return _out(sprite)


@router.put("/{sprite_id}", response_model=CardSpriteOut)
def update_sprite(
    card_id: str, sprite_id: str, req: CardSpriteUpdate, db: Session = Depends(get_db)
):
    sprite = _load_sprite(card_id, sprite_id, db)
    updates = req.model_dump(exclude_unset=True)
    label = clean_label(updates["label"]) if updates.get("label") is not None else sprite.label
    raw_aliases = updates.get("aliases")
    aliases = clean_aliases(raw_aliases if raw_aliases is not None else sprite.aliases or [], label)
    _check_unique(card_id, [label, *aliases], db, exclude_id=sprite_id)
    sprite.label = label
    sprite.aliases = aliases
    if updates.get("description") is not None:
        sprite.description = updates["description"].strip()
    db.commit()
    db.refresh(sprite)
    return _out(sprite)


@router.delete("/{sprite_id}", status_code=204)
def delete_sprite(card_id: str, sprite_id: str, db: Session = Depends(get_db)):
    db.delete(_load_sprite(card_id, sprite_id, db))
    db.commit()


@router.post("/reorder", response_model=list[CardSpriteOut])
def reorder_sprites(card_id: str, req: SpriteReorderRequest, db: Session = Depends(get_db)):
    _load_card(card_id, db)
    rows = {
        r.id: r for r in db.scalars(select(CardSprite).where(CardSprite.card_id == card_id))
    }
    if sorted(req.ids) != sorted(rows):
        raise HTTPException(400, "排序列表必须正好包含这张卡的全部立绘")
    for i, sid in enumerate(req.ids):
        rows[sid].sort = i
    db.commit()
    return [_out(rows[sid]) for sid in req.ids]


@router.put("/{sprite_id}/image", response_model=CardSpriteOut)
async def upload_sprite_image(
    card_id: str, sprite_id: str, file: UploadFile = File(...), db: Session = Depends(get_db)
):
    sprite = _load_sprite(card_id, sprite_id, db)
    data = await file.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(413, f"图片太大了,上限 {MAX_IMAGE_BYTES // 1024 // 1024} MB")
    mime = sniff_image_mime(data)
    if mime is None:
        raise HTTPException(400, "只支持 PNG / JPEG / WebP / GIF 图片")
    sprite.image = data
    sprite.mime = mime
    db.commit()
    db.refresh(sprite)
    return _out(sprite)


@router.get("/{sprite_id}/image")
def get_sprite_image(card_id: str, sprite_id: str, db: Session = Depends(get_db)):
    sprite = db.scalar(
        select(CardSprite)
        .options(undefer(CardSprite.image))
        .where(CardSprite.id == sprite_id, CardSprite.card_id == card_id)
    )
    if sprite is None or sprite.image is None or sprite.mime is None:
        raise HTTPException(404, "这条立绘还没有图")
    return Response(
        content=sprite.image,
        media_type=sprite.mime,
        headers={
            # 前端请求的 URL 里带着 ?v=image_version,换图后 URL 就变了,
            # 所以同一个 URL 对应的内容永远不会变,可以放心长期缓存
            "Cache-Control": "private, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
        },
    )


def delete_card_sprites(card_id: str, db: Session) -> None:
    """删卡时由 tavern.delete_card 调用(SQLite 默认不启用外键约束,不会自动级联)。"""
    db.execute(delete(CardSprite).where(CardSprite.card_id == card_id))


def copy_card_sprites(src_id: str, dst_id: str, db: Session) -> None:
    """复制卡时连立绘映射一起复制 —— 副本本来就应该和原卡长得一样。"""
    rows = db.scalars(
        select(CardSprite).options(undefer(CardSprite.image)).where(CardSprite.card_id == src_id)
    ).all()
    for r in rows:
        db.add(
            CardSprite(
                card_id=dst_id,
                label=r.label,
                aliases=list(r.aliases or []),
                description=r.description,
                image=r.image,
                mime=r.mime,
                sort=r.sort,
            )
        )
