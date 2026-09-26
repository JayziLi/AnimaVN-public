"""调试台对话的持久化。

写入模型是「每个操作一条小请求」:前端对单条消息按 id upsert、按 id 删除,
聊天级别的字段(绑定哪张卡/预设、tainted、user_name)单独 PATCH。和一个
整包重写的 PUT 相比,这不会把几 KB 的历史在每次点击时重发一遍。

快照内容寻址:swipe_info 里带来的 snapshot 被抽出来按哈希存进
debug_snapshots(重复哈希直接忽略),消息里只剩 snapshotHash。
读的时候不回填 —— 前端点「看提示词」才按哈希来取,长对话加载不用
拖几 MB 的历史提示词。
"""

import io
import uuid as uuid_mod
import zipfile
from datetime import datetime, timezone
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.api.st_chat_codec import (
    chat_to_jsonl,
    parse_st_jsonl,
    sanitize_st_filename,
    strip_branch_suffix,
)
from app.db import get_db
from app.models import DebugChat, DebugChatMessage, DebugSnapshot, PromptPreset, TavernCard
from app.schemas import (
    DebugBranchRequest,
    DebugChatCreate,
    DebugChatMessageIn,
    DebugChatMessageOut,
    DebugChatOut,
    DebugChatUpdate,
)

router = APIRouter(prefix="/api/debug", tags=["debug-chats"])


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _load_chat(chat_id: str, db: Session) -> DebugChat:
    chat = db.get(DebugChat, chat_id)
    if chat is None:
        raise HTTPException(404, "对话不存在")
    return chat


def _resolve_name(preset_id: str | None, db: Session) -> str:
    if not preset_id:
        return ""
    preset = db.get(PromptPreset, preset_id)
    return preset.name if preset else ""


def _st_timestamp(dt: datetime) -> str:
    """ST 的文件名时间戳,形如 2026-06-10@17h39m53s699ms。"""
    return dt.strftime("%Y-%m-%d@%Hh%Mm%Ss") + f"{dt.microsecond // 1000:03d}ms"


_PREVIEW_LIMIT = 160


def _preview(message: DebugChatMessage) -> str:
    """列表卡片的预览行:当前 swipe 的正文,压平空白再截断。

    取 swipes[swipe_id] 而不是别的 —— 和导出/前端渲染看到的是同一个分支。
    """
    swipes = message.swipes or []
    if not swipes:
        return ""
    i = message.swipe_id if 0 <= message.swipe_id < len(swipes) else 0
    text = " ".join(str(swipes[i]).split())
    return (text[:_PREVIEW_LIMIT] + "…") if len(text) > _PREVIEW_LIMIT else text


def _auto_chat_name(card_name: str) -> str:
    """新对话默认名,对齐 ST 的 "{卡名} - {时间戳}"。"""
    base = card_name or "chat"
    return f"{base} - {_st_timestamp(_now())}"


def _unique_branch_name(chat: DebugChat, db: Session) -> str:
    """对齐 ST 的 createBranch:剥掉旧 Branch 后缀,再挂一个递增的 Branch #N。"""
    root = strip_branch_suffix(chat.name) or _auto_chat_name(chat.card_name)
    taken = set(db.scalars(select(DebugChat.name)).all())
    i = 1
    while True:
        candidate = f"{root} - Branch #{i}"
        if candidate not in taken:
            return candidate
        i += 1


def _chat_out(
    chat: DebugChat,
    db: Session,
    *,
    messages: list[DebugChatMessage] | None = None,
    message_count: int | None = None,
    last_message: str = "",
) -> DebugChatOut:
    return DebugChatOut(
        id=chat.id,
        name=chat.name,
        card_id=chat.card_id,
        preset_id=chat.preset_id,
        card_name=chat.card_name,
        preset_name=chat.preset_name,
        user_name=chat.user_name,
        tainted=chat.tainted,
        parent_chat_id=chat.parent_chat_id,
        parent_message_id=chat.parent_message_id,
        created_at=chat.created_at,
        updated_at=chat.updated_at,
        message_count=message_count,
        last_message=last_message,
        messages=(
            None
            if messages is None
            else [
                DebugChatMessageOut(
                    id=m.id,
                    idx=m.idx,
                    role=m.role,
                    swipes=m.swipes or [],
                    swipe_id=m.swipe_id,
                    swipe_info=m.swipe_info or [],
                )
                for m in messages
            ]
        ),
    )


@router.get("/chats", response_model=list[DebugChatOut])
def list_chats(card_id: str | None = None, db: Session = Depends(get_db)):
    """最近更新在前。card_id 过滤是顶栏下拉的视角(当前卡的对话)。"""
    query = select(DebugChat)
    if card_id:
        query = query.where(DebugChat.card_id == card_id)
    chats = db.scalars(query.order_by(DebugChat.updated_at.desc())).all()

    counts = dict(
        db.execute(
            select(DebugChatMessage.chat_id, func.count()).group_by(DebugChatMessage.chat_id)
        ).all()
    )

    # 每条对话的最后一条消息 —— 卡片上的预览行。先用 (chat_id, max(idx)) 子查询
    # 定位行,再回连取正文,免得为了一行预览把所有历史读进内存
    last_idx = (
        select(
            DebugChatMessage.chat_id.label("chat_id"),
            func.max(DebugChatMessage.idx).label("idx"),
        )
        .group_by(DebugChatMessage.chat_id)
        .subquery()
    )
    previews = {
        m.chat_id: _preview(m)
        for m in db.scalars(
            select(DebugChatMessage).join(
                last_idx,
                (DebugChatMessage.chat_id == last_idx.c.chat_id)
                & (DebugChatMessage.idx == last_idx.c.idx),
            )
        ).all()
    }

    return [
        _chat_out(
            c,
            db,
            message_count=counts.get(c.id, 0),
            last_message=previews.get(c.id, ""),
        )
        for c in chats
    ]


@router.post("/chats", response_model=DebugChatOut)
def create_chat(req: DebugChatCreate, db: Session = Depends(get_db)):
    card_name = ""
    if req.card_id:
        card = db.get(TavernCard, req.card_id)
        if card is None:
            raise HTTPException(404, "角色卡不存在")
        card_name = card.name
    chat = DebugChat(
        name=req.name.strip() or _auto_chat_name(card_name),
        card_id=req.card_id,
        preset_id=req.preset_id,
        card_name=card_name,
        preset_name=_resolve_name(req.preset_id, db),
        user_name=req.user_name,
    )
    db.add(chat)
    db.commit()
    db.refresh(chat)
    return _chat_out(chat, db, message_count=0)


@router.get("/chats/{chat_id}", response_model=DebugChatOut)
def get_chat(chat_id: str, db: Session = Depends(get_db)):
    chat = _load_chat(chat_id, db)
    messages = db.scalars(
        select(DebugChatMessage)
        .where(DebugChatMessage.chat_id == chat_id)
        .order_by(DebugChatMessage.idx)
    ).all()
    return _chat_out(chat, db, messages=messages, message_count=len(messages))


@router.put("/chats/{chat_id}", response_model=DebugChatOut)
def update_chat(chat_id: str, req: DebugChatUpdate, db: Session = Depends(get_db)):
    chat = _load_chat(chat_id, db)
    updates = req.model_dump(exclude_unset=True)

    if "card_id" in updates:
        if updates["card_id"]:
            card = db.get(TavernCard, updates["card_id"])
            if card is None:
                raise HTTPException(404, "角色卡不存在")
            chat.card_name = card.name
        else:
            chat.card_name = ""
    if "preset_id" in updates:
        if updates["preset_id"]:
            if db.get(PromptPreset, updates["preset_id"]) is None:
                raise HTTPException(404, "预设不存在")
            chat.preset_name = _resolve_name(updates["preset_id"], db)
        else:
            chat.preset_name = ""

    for field in ("name", "card_id", "preset_id", "user_name", "tainted"):
        if field in updates:
            setattr(chat, field, updates[field])
    chat.updated_at = _now()
    db.commit()
    db.refresh(chat)
    return _chat_out(chat, db)


@router.delete("/chats/{chat_id}", status_code=204)
def delete_chat(chat_id: str, db: Session = Depends(get_db)):
    _load_chat(chat_id, db)
    # Children outlive their parent. Promote direct children to roots so the
    # public tree never contains a pointer to a chat that no longer exists.
    db.execute(
        update(DebugChat)
        .where(DebugChat.parent_chat_id == chat_id)
        .values(parent_chat_id=None, parent_message_id=None)
    )
    # 谁把这条当「上次打开」的,指针一起抹掉 —— 读取侧对悬空指针本来就有回退,
    # 但留着它意味着这个 id 被复用时会指到一条不相干的对话上
    db.execute(
        update(TavernCard).where(TavernCard.last_chat_id == chat_id).values(last_chat_id=None)
    )
    # SQLite 的 FK 级联要开 pragma 才生效,消息手动删
    db.query(DebugChatMessage).filter(DebugChatMessage.chat_id == chat_id).delete()
    db.delete(db.get(DebugChat, chat_id))
    db.commit()


@router.put("/chats/{chat_id}/messages/{message_id}", response_model=DebugChatMessageOut)
def upsert_message(chat_id: str, message_id: str, req: DebugChatMessageIn, db: Session = Depends(get_db)):
    chat = _load_chat(chat_id, db)

    row = db.get(DebugChatMessage, message_id)
    if row is None:
        row = DebugChatMessage(id=message_id, chat_id=chat_id)
        db.add(row)
    elif row.chat_id != chat_id:
        raise HTTPException(409, "这条消息属于另一个对话")

    # 把快照抽出来按哈希入库,消息里只留 snapshotHash
    for info in req.swipe_info:
        snapshot = info.pop("snapshot", None)
        hash_ = info.get("snapshotHash")
        if snapshot is not None and hash_ and db.get(DebugSnapshot, hash_) is None:
            db.add(DebugSnapshot(hash=hash_, payload=snapshot))

    row.idx = req.idx
    row.role = req.role
    row.swipes = req.swipes
    row.swipe_id = req.swipe_id
    row.swipe_info = req.swipe_info
    chat.updated_at = _now()  # 列表按更新时间排,消息变了聊天也得算变过
    db.commit()
    db.refresh(row)
    return DebugChatMessageOut(
        id=row.id,
        idx=row.idx,
        role=row.role,
        swipes=row.swipes,
        swipe_id=row.swipe_id,
        swipe_info=row.swipe_info,
    )


@router.delete("/chats/{chat_id}/messages/{message_id}", status_code=204)
def delete_message(chat_id: str, message_id: str, db: Session = Depends(get_db)):
    _load_chat(chat_id, db)
    row = db.get(DebugChatMessage, message_id)
    if row is not None and row.chat_id == chat_id:
        db.delete(row)
        db.execute(
            update(DebugChat).where(DebugChat.id == chat_id).values(updated_at=_now())
        )
        db.commit()


@router.get("/snapshots/{hash_}")
def get_snapshot(hash_: str, db: Session = Depends(get_db)):
    """按哈希取一份提示词快照。点「看提示词」时才调,加载对话不用拖全部历史。"""
    snap = db.get(DebugSnapshot, hash_)
    if snap is None:
        raise HTTPException(404, "快照不存在")
    return snap.payload


def _disposition(filename: str, fallback: str) -> str:
    """RFC 6266/5987 安全的 Content-Disposition:中文这类非 ASCII 走
    filename*,ASCII 兜底 —— 否则 Starlette 用 latin-1 编码 header 会炸。"""
    ascii_name = filename.encode("ascii", "ignore").decode("ascii")
    if not ascii_name.strip(" .-_"):
        ascii_name = fallback
    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(filename, safe="")}'


def _collect_tree(root: DebugChat, db: Session) -> list[DebugChat]:
    """从根向下 BFS,收集整棵分支树(根在前,子按创建序)。"""
    result: list[DebugChat] = []
    frontier = [root]
    seen: set[str] = set()
    while frontier:
        chat = frontier.pop(0)
        if chat.id in seen:
            continue
        seen.add(chat.id)
        result.append(chat)
        children = db.scalars(
            select(DebugChat)
            .where(DebugChat.parent_chat_id == chat.id)
            .order_by(DebugChat.created_at)
        ).all()
        frontier.extend(children)
    return result


@router.post("/chats/{chat_id}/branch", response_model=DebugChatOut)
def branch_chat(chat_id: str, req: DebugBranchRequest, db: Session = Depends(get_db)):
    """「从这里开始」—— 复制 [0, message_id] 前缀到新对话。

    对齐 ST 的 createBranch:新对话是完整复制(不是引用),父指针挂在
    parent_chat_id / parent_message_id。快照哈希原样带过去 —— 内容寻址
    下不用复制 payload,debug_snapshots 天然共享。
    """
    chat = _load_chat(chat_id, db)

    messages = db.scalars(
        select(DebugChatMessage)
        .where(DebugChatMessage.chat_id == chat_id)
        .order_by(DebugChatMessage.idx)
    ).all()

    target_idx = None
    for m in messages:
        if m.id == req.message_id:
            target_idx = m.idx
            break
    if target_idx is None:
        raise HTTPException(404, "这条消息不在该对话里")

    branch = DebugChat(
        name=_unique_branch_name(chat, db),
        card_id=chat.card_id,
        preset_id=chat.preset_id,
        card_name=chat.card_name,
        preset_name=chat.preset_name,
        user_name=chat.user_name,
        tainted=chat.tainted,
        parent_chat_id=chat.id,
        parent_message_id=req.message_id,
    )
    db.add(branch)
    db.flush()  # 拿到 branch.id 才能给子消息挂外键

    copied_count = 0
    for m in messages:
        if m.idx > target_idx:
            continue
        db.add(
            DebugChatMessage(
                id=str(uuid_mod.uuid4()),
                chat_id=branch.id,
                idx=m.idx,
                role=m.role,
                swipes=list(m.swipes),
                swipe_id=m.swipe_id,
                swipe_info=m.swipe_info,
            )
        )
        copied_count += 1
    db.commit()
    db.refresh(branch)
    return _chat_out(branch, db, message_count=copied_count)


@router.get("/chats/{chat_id}/export")
def export_chat(chat_id: str, tree: bool = False, db: Session = Depends(get_db)):
    """导出当前对话为 ST jsonl;?tree=true 导出整棵分支树为 zip。"""
    chat = _load_chat(chat_id, db)

    def render(c: DebugChat) -> tuple[str, str]:
        msgs = db.scalars(
            select(DebugChatMessage)
            .where(DebugChatMessage.chat_id == c.id)
            .order_by(DebugChatMessage.idx)
        ).all()
        parent = db.get(DebugChat, c.parent_chat_id) if c.parent_chat_id else None
        return sanitize_st_filename(c.name) + ".jsonl", chat_to_jsonl(c, msgs, parent.name if parent else None)

    if not tree:
        filename, body = render(chat)
        return Response(
            content=body,
            media_type="application/jsonl",
            headers={"Content-Disposition": _disposition(filename, "chat.jsonl")},
        )

    # 树:先爬到根(主聊天),再从根向下收集所有分支
    root = chat
    while root.parent_chat_id:
        parent = db.get(DebugChat, root.parent_chat_id)
        if parent is None:
            break
        root = parent
    all_chats = _collect_tree(root, db)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for c in all_chats:
            filename, body = render(c)
            zf.writestr(filename, body)
    buf.seek(0)
    zip_name = sanitize_st_filename(root.name) + "-tree.zip"
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": _disposition(zip_name, "chat-tree.zip")},
    )


@router.post("/chats/import", response_model=list[DebugChatOut])
def import_chats(files: list[UploadFile] = File(...), db: Session = Depends(get_db)):
    """导入 ST jsonl。卡按 character_name 匹配现有角色卡,匹配不到 = 孤儿
    对话(card_id 置空,正好用上 Batch 3 的可空引用)。分支关系从两个方向
    回建:子文件 chat_metadata.main_chat 与父消息 extra.branches[]。
    """
    card_by_name = {c.name: c.id for c in db.scalars(select(TavernCard)).all()}
    imported: list[tuple[dict, DebugChat, list[str]]] = []

    for f in files:
        raw = f.file.read().decode("utf-8", errors="replace")
        stem = f.filename.rsplit(".", 1)[0] if f.filename else "imported"
        parsed = parse_st_jsonl(stem, raw)

        chat = DebugChat(
            name=stem,
            card_id=card_by_name.get(parsed["character_name"]),
            preset_id=None,
            card_name=parsed["character_name"],
            preset_name="",
            user_name=parsed["user_name"],
            tainted=parsed["tainted"],
        )
        db.add(chat)
        db.flush()

        msg_ids: list[str] = []
        for i, m in enumerate(parsed["messages"]):
            mid = str(uuid_mod.uuid4())
            msg_ids.append(mid)
            kwargs: dict = {}
            if m["created_at"] is not None:
                kwargs["created_at"] = m["created_at"]
            db.add(
                DebugChatMessage(
                    id=mid,
                    chat_id=chat.id,
                    idx=i,
                    role=m["role"],
                    swipes=m["swipes"],
                    swipe_id=m["swipe_id"],
                    swipe_info=m["swipe_info"],
                    **kwargs,
                )
            )
        imported.append((parsed, chat, msg_ids))

    # 回建父指针:main_chat(子 → 父)优先,extra.branches 反链补 parent_message_id
    by_name = {parsed["name"]: chat for parsed, chat, _ in imported}
    for parsed, chat, _ in imported:
        main = parsed["main_chat"]
        if not main:
            continue
        parent = by_name.get(main)
        if parent is None:
            parent = db.scalars(select(DebugChat).where(DebugChat.name == main)).first()
        if parent is not None:
            chat.parent_chat_id = parent.id

    for parsed, parent_chat, parent_msg_ids in imported:
        for child_name, parent_idx in parsed["branch_links"]:
            child = by_name.get(child_name)
            if child is None or not 0 <= parent_idx < len(parent_msg_ids):
                continue
            child.parent_chat_id = parent_chat.id
            child.parent_message_id = parent_msg_ids[parent_idx]

    db.commit()
    return [_chat_out(chat, db, message_count=len(ids)) for _, chat, ids in imported]
