"""背景插件 + BGM 插件:场景包,以及角色卡绑定哪个场景包。

一个场景包 = 一组背景图 + 一组背景音乐,AI 在正文里用标签点名(<bg:食堂>、
<bgm:日常>),视觉小说界面按名字找到这一行的文件。和立绘的区别是素材不属于
某张卡:同一个世界观的角色共用一个包,卡只记「我用哪个包」。

文件同样存 BLOB、列表只回元数据、取文件的端点带版本号长缓存。
"""

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session, undefer

from app.api.sprites import MAX_IMAGE_BYTES, clean_aliases, clean_label, sniff_image_mime
from app.db import get_db
from app.models import CardScenePack, SceneAsset, ScenePack, TavernCard
from app.schemas import (
    CardScenePackIn,
    CardScenePackOut,
    SceneAssetCreate,
    SceneAssetOut,
    SceneAssetReorder,
    SceneAssetUpdate,
    ScenePackIn,
    ScenePackOut,
    ScenePackUpdate,
)

router = APIRouter(tags=["scenes"])

PACKS = "/api/scene-packs"

# 一首 3~5 分钟的 MP3 在 128~320kbps 下是 3~12MB;服务器 nginx 的上限是 20m,
# multipart 还要占一点,这里留足余量
MAX_AUDIO_BYTES = 16 * 1024 * 1024

NOUN = {"bg": "场景名", "bgm": "音乐名"}


def _load_pack(pack_id: str, db: Session) -> ScenePack:
    pack = db.get(ScenePack, pack_id)
    if pack is None:
        raise HTTPException(404, "场景包不存在")
    return pack


def _load_asset(pack_id: str, asset_id: str, db: Session) -> SceneAsset:
    asset = db.get(SceneAsset, asset_id)
    if asset is None or asset.pack_id != pack_id:
        raise HTTPException(404, "素材不存在")
    return asset


def _clean_pack_name(raw: str, db: Session, exclude_id: str | None = None) -> str:
    name = raw.strip()
    if not name:
        raise HTTPException(400, "场景包名字不能为空")
    if len(name) > 120:
        raise HTTPException(400, "场景包名字最长 120 个字")
    for row in db.scalars(select(ScenePack)):
        if row.id != exclude_id and row.name.casefold() == name.casefold():
            raise HTTPException(409, f"已经有叫「{name}」的场景包了")
    return name


def _pack_out(pack: ScenePack, db: Session) -> ScenePackOut:
    counts = dict(
        db.execute(
            select(SceneAsset.kind, func.count())
            .where(SceneAsset.pack_id == pack.id)
            .group_by(SceneAsset.kind)
        ).all()
    )
    cards = db.scalar(
        select(func.count()).select_from(CardScenePack).where(CardScenePack.pack_id == pack.id)
    )
    return ScenePackOut(
        id=pack.id,
        name=pack.name,
        description=pack.description,
        bg_count=counts.get("bg", 0),
        bgm_count=counts.get("bgm", 0),
        card_count=cards or 0,
    )


def _asset_out(a: SceneAsset) -> SceneAssetOut:
    return SceneAssetOut(
        id=a.id,
        pack_id=a.pack_id,
        kind=a.kind,  # type: ignore[arg-type]
        label=a.label,
        aliases=list(a.aliases or []),
        description=a.description,
        has_file=a.mime is not None,
        mime=a.mime,
        size=a.size,
        file_version=int(a.updated_at.timestamp() * 1000),
        focus_x=a.focus_x,
        bgm_id=a.bgm_id,
        sort=a.sort,
    )


def _check_unique(
    pack_id: str, kind: str, names: list[str], db: Session, exclude_id: str | None = None
):
    """同一个包里同一类素材的名字 / 别名不能撞。背景和音乐各用各的标签,可以同名。"""
    taken: dict[str, str] = {}
    rows = db.scalars(
        select(SceneAsset).where(SceneAsset.pack_id == pack_id, SceneAsset.kind == kind)
    )
    for row in rows:
        if row.id == exclude_id:
            continue
        for n in [row.label, *(row.aliases or [])]:
            taken[n.casefold()] = row.label
    for n in names:
        owner = taken.get(n.casefold())
        if owner is not None:
            raise HTTPException(409, f"{NOUN[kind]}「{n}」已经被「{owner}」占用了")


def sniff_audio_mime(data: bytes) -> str | None:
    """按文件头认音频格式(理由同 sniff_image_mime:不信任客户端声明的类型)。"""
    if data[:3] == b"ID3":
        return "audio/mpeg"
    if len(data) >= 2 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
        # 帧同步头:layer 位为 00 的是 AAC(ADTS),其余是 MP3
        return "audio/aac" if (data[1] & 0x06) == 0 else "audio/mpeg"
    if data[4:8] == b"ftyp":
        return "audio/mp4"
    if data[:4] == b"OggS":
        return "audio/ogg"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav"
    if data[:4] == b"fLaC":
        return "audio/flac"
    return None


# ── 场景包 ──


@router.get(PACKS, response_model=list[ScenePackOut])
def list_packs(db: Session = Depends(get_db)):
    packs = db.scalars(select(ScenePack).order_by(ScenePack.created_at)).all()
    return [_pack_out(p, db) for p in packs]


@router.post(PACKS, response_model=ScenePackOut)
def create_pack(req: ScenePackIn, db: Session = Depends(get_db)):
    pack = ScenePack(name=_clean_pack_name(req.name, db), description=req.description.strip())
    db.add(pack)
    db.commit()
    db.refresh(pack)
    return _pack_out(pack, db)


@router.put(PACKS + "/{pack_id}", response_model=ScenePackOut)
def update_pack(pack_id: str, req: ScenePackUpdate, db: Session = Depends(get_db)):
    pack = _load_pack(pack_id, db)
    if req.name is not None:
        pack.name = _clean_pack_name(req.name, db, exclude_id=pack_id)
    if req.description is not None:
        pack.description = req.description.strip()
    db.commit()
    db.refresh(pack)
    return _pack_out(pack, db)


@router.delete(PACKS + "/{pack_id}", status_code=204)
def delete_pack(pack_id: str, db: Session = Depends(get_db)):
    pack = _load_pack(pack_id, db)
    # SQLite 没开外键约束,不会自动级联:素材和绑定手动删
    db.execute(delete(SceneAsset).where(SceneAsset.pack_id == pack_id))
    db.execute(delete(CardScenePack).where(CardScenePack.pack_id == pack_id))
    db.delete(pack)
    db.commit()


# ── 素材 ──


@router.get(PACKS + "/{pack_id}/assets", response_model=list[SceneAssetOut])
def list_assets(pack_id: str, db: Session = Depends(get_db)):
    _load_pack(pack_id, db)
    rows = db.scalars(
        select(SceneAsset)
        .where(SceneAsset.pack_id == pack_id)
        .order_by(SceneAsset.kind, SceneAsset.sort, SceneAsset.created_at)
    ).all()
    return [_asset_out(r) for r in rows]


@router.post(PACKS + "/{pack_id}/assets", response_model=SceneAssetOut)
def create_asset(pack_id: str, req: SceneAssetCreate, db: Session = Depends(get_db)):
    _load_pack(pack_id, db)
    noun = NOUN[req.kind]
    label = clean_label(req.label, noun)
    aliases = clean_aliases(req.aliases, label, noun)
    _check_unique(pack_id, req.kind, [label, *aliases], db)
    last = db.scalar(
        select(func.max(SceneAsset.sort)).where(
            SceneAsset.pack_id == pack_id, SceneAsset.kind == req.kind
        )
    )
    asset = SceneAsset(
        pack_id=pack_id,
        kind=req.kind,
        label=label,
        aliases=aliases,
        description=req.description.strip(),
        sort=(last + 1) if last is not None else 0,
    )
    db.add(asset)
    db.commit()
    db.refresh(asset)
    return _asset_out(asset)


@router.put(PACKS + "/{pack_id}/assets/{asset_id}", response_model=SceneAssetOut)
def update_asset(
    pack_id: str, asset_id: str, req: SceneAssetUpdate, db: Session = Depends(get_db)
):
    asset = _load_asset(pack_id, asset_id, db)
    noun = NOUN[asset.kind]
    updates = req.model_dump(exclude_unset=True)

    label = clean_label(updates["label"], noun) if updates.get("label") is not None else asset.label
    raw_aliases = updates.get("aliases")
    aliases = clean_aliases(
        raw_aliases if raw_aliases is not None else asset.aliases or [], label, noun
    )
    _check_unique(pack_id, asset.kind, [label, *aliases], db, exclude_id=asset_id)
    asset.label = label
    asset.aliases = aliases

    if updates.get("description") is not None:
        asset.description = updates["description"].strip()
    if updates.get("focus_x") is not None:
        asset.focus_x = updates["focus_x"]
    if "bgm_id" in updates:
        bgm_id = updates["bgm_id"]
        if bgm_id is not None:
            if asset.kind != "bg":
                raise HTTPException(400, "只有背景能设默认音乐")
            target = db.get(SceneAsset, bgm_id)
            if target is None or target.pack_id != pack_id or target.kind != "bgm":
                raise HTTPException(400, "默认音乐必须是同一个场景包里的一首 BGM")
        asset.bgm_id = bgm_id

    db.commit()
    db.refresh(asset)
    return _asset_out(asset)


@router.delete(PACKS + "/{pack_id}/assets/{asset_id}", status_code=204)
def delete_asset(pack_id: str, asset_id: str, db: Session = Depends(get_db)):
    asset = _load_asset(pack_id, asset_id, db)
    if asset.kind == "bgm":
        # 把这首当默认曲的背景改回「没有默认曲」,不然前端会拿着一个不存在的 id
        db.execute(
            update(SceneAsset)
            .where(SceneAsset.pack_id == pack_id, SceneAsset.bgm_id == asset_id)
            .values(bgm_id=None)
        )
    db.delete(asset)
    db.commit()


@router.post(PACKS + "/{pack_id}/assets/reorder", response_model=list[SceneAssetOut])
def reorder_assets(pack_id: str, req: SceneAssetReorder, db: Session = Depends(get_db)):
    _load_pack(pack_id, db)
    rows = {
        r.id: r
        for r in db.scalars(
            select(SceneAsset).where(SceneAsset.pack_id == pack_id, SceneAsset.kind == req.kind)
        )
    }
    if sorted(req.ids) != sorted(rows):
        raise HTTPException(400, "排序列表必须正好包含这一类的全部素材")
    for i, aid in enumerate(req.ids):
        rows[aid].sort = i
    db.commit()
    return [_asset_out(rows[aid]) for aid in req.ids]


@router.put(PACKS + "/{pack_id}/assets/{asset_id}/file", response_model=SceneAssetOut)
async def upload_asset_file(
    pack_id: str, asset_id: str, file: UploadFile = File(...), db: Session = Depends(get_db)
):
    asset = _load_asset(pack_id, asset_id, db)
    if asset.kind == "bg":
        limit, sniff, accepted = MAX_IMAGE_BYTES, sniff_image_mime, "PNG / JPEG / WebP / GIF 图片"
    else:
        limit, sniff, accepted = MAX_AUDIO_BYTES, sniff_audio_mime, "MP3 / M4A / AAC / OGG / WAV / FLAC 音频"
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(413, f"文件太大了,上限 {limit // 1024 // 1024} MB")
    mime = sniff(data)
    if mime is None:
        raise HTTPException(400, f"只支持 {accepted}")
    asset.data = data
    asset.mime = mime
    asset.size = len(data)
    db.commit()
    db.refresh(asset)
    return _asset_out(asset)


@router.get(PACKS + "/{pack_id}/assets/{asset_id}/file")
def get_asset_file(pack_id: str, asset_id: str, db: Session = Depends(get_db)):
    asset = db.scalar(
        select(SceneAsset)
        .options(undefer(SceneAsset.data))
        .where(SceneAsset.id == asset_id, SceneAsset.pack_id == pack_id)
    )
    if asset is None or asset.data is None or asset.mime is None:
        raise HTTPException(404, "这条素材还没有文件")
    return Response(
        content=asset.data,
        media_type=asset.mime,
        headers={
            # URL 里带 ?v=file_version,换文件后 URL 就变了,同一个 URL 的内容永远不变
            "Cache-Control": "private, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
        },
    )


# ── 角色卡绑定 ──


@router.get("/api/tavern/cards/{card_id}/scene-pack", response_model=CardScenePackOut)
def get_card_scene_pack(card_id: str, db: Session = Depends(get_db)):
    if db.get(TavernCard, card_id) is None:
        raise HTTPException(404, "角色卡不存在")
    row = db.get(CardScenePack, card_id)
    return CardScenePackOut(card_id=card_id, pack_id=row.pack_id if row else None)


@router.put("/api/tavern/cards/{card_id}/scene-pack", response_model=CardScenePackOut)
def set_card_scene_pack(card_id: str, req: CardScenePackIn, db: Session = Depends(get_db)):
    if db.get(TavernCard, card_id) is None:
        raise HTTPException(404, "角色卡不存在")
    row = db.get(CardScenePack, card_id)
    if req.pack_id is None:
        if row is not None:
            db.delete(row)
    else:
        _load_pack(req.pack_id, db)
        if row is None:
            db.add(CardScenePack(card_id=card_id, pack_id=req.pack_id))
        else:
            row.pack_id = req.pack_id
    db.commit()
    return CardScenePackOut(card_id=card_id, pack_id=req.pack_id)


def delete_card_scene_binding(card_id: str, db: Session) -> None:
    """删卡时由 tavern.delete_card 调用。场景包本身是共用的,不跟着删。"""
    db.execute(delete(CardScenePack).where(CardScenePack.card_id == card_id))


def copy_card_scene_binding(src_id: str, dst_id: str, db: Session) -> None:
    """复制卡时绑定同一个场景包(包是共用的,不复制包本身)。"""
    row = db.get(CardScenePack, src_id)
    if row is not None:
        db.add(CardScenePack(card_id=dst_id, pack_id=row.pack_id))
