"""SillyTavern 聊天 jsonl 的编解码。

ST 端导入导出就是 jsonl 文件的原始读写 —— 文件本身即契约,两边不做任何
加工。这里把 ST 的行结构和我们 debug_chats 表的行结构互转:

ST 行结构(以真实导出为准):
  第 0 行  {user_name, character_name, chat_metadata{tainted, main_chat}}
  消息行   {name, is_user, is_system, send_date, mes, swipes, swipe_id,
            swipe_info, extra, gen_started, gen_finished}

注意 ST 的 `swipe_info` 是 `[{send_date, gen_started, gen_finished, extra}]`,
和我们前端 SwipeInfo(model/reasoning/时间戳)同名不同义 —— 思维链等生成
信息两边都放 `extra`,字段名一致(reasoning / reasoning_type /
reasoning_duration / time_to_first_token),直接平移。

分支关系:ST 不存结构化指针 —— 子文件 chat_metadata.main_chat 记父文件名,
父消息 extra.branches[] 记子文件名。导入时两条都读,回建成我们的
parent_chat_id / parent_message_id。导出时反向写出。
"""

import json
import re
from datetime import datetime, timezone
from typing import Any

_BRANCH_SUFFIX = re.compile(r" - Branch #\d+$")
_UNSAFE_FILENAME = re.compile(r'[\\/:*?"<>|]')


def sanitize_st_filename(name: str) -> str:
    """ST 的文件名即聊天名,Windows 保留字符清掉。"""
    cleaned = _UNSAFE_FILENAME.sub("_", name).strip().rstrip(".")
    return cleaned[:180] or "chat"


def strip_branch_suffix(name: str) -> str:
    """Branch #31 → 根名(ST 命名分支时先剥旧后缀再加新的)。"""
    return _BRANCH_SUFFIX.sub("", name).strip()


def iso_st(dt: datetime) -> str:
    """ST 的 send_date 形如 2026-06-10T17:39:53.260Z。"""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse_iso(value: Any) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _st_extra(info: dict) -> dict:
    """我们的 SwipeInfo → ST extra。只放两边都认识的键,缺的不写。"""
    extra: dict = {}
    if info.get("model"):
        extra["model"] = info["model"]
    if info.get("reasoning"):
        extra["reasoning"] = info["reasoning"]
    if info.get("reasoningType"):
        extra["reasoning_type"] = info["reasoningType"]
    if info.get("reasoningMs") is not None:
        extra["reasoning_duration"] = info["reasoningMs"]
    if info.get("ttftMs") is not None:
        extra["time_to_first_token"] = info["ttftMs"]
    return extra


def _our_info(extra: dict | None, st_swipe: dict | None) -> dict:
    """ST extra(+分支时间戳) → 我们的 SwipeInfo。导入方向。"""
    extra = extra or {}
    info: dict = {}
    if extra.get("model"):
        info["model"] = extra["model"]
    if extra.get("reasoning"):
        info["reasoning"] = extra["reasoning"]
    if extra.get("reasoning_type"):
        info["reasoningType"] = extra["reasoning_type"]
    if extra.get("reasoning_duration") is not None:
        info["reasoningMs"] = extra["reasoning_duration"]
    if extra.get("time_to_first_token") is not None:
        info["ttftMs"] = extra["time_to_first_token"]
    started = _parse_iso((st_swipe or {}).get("gen_started"))
    finished = _parse_iso((st_swipe or {}).get("gen_finished"))
    if started and finished and finished >= started:
        info["totalMs"] = int((finished - started).total_seconds() * 1000)
    return info


def chat_to_jsonl(
    chat,  # DebugChat
    messages,  # list[DebugChatMessage],已按 idx 排序
    parent_stem: str | None,
) -> str:
    """导出方向:一行 header + 每条消息一行。"""
    metadata: dict = {"tainted": bool(chat.tainted)}
    if parent_stem:
        metadata["main_chat"] = parent_stem

    lines = [
        json.dumps(
            {
                "user_name": chat.user_name,
                "character_name": chat.card_name,
                "chat_metadata": metadata,
            },
            ensure_ascii=False,
        )
    ]

    for m in messages:
        swipe_id = m.swipe_id if 0 <= m.swipe_id < len(m.swipes) else 0
        mes = m.swipes[swipe_id] if m.swipes else ""
        row: dict = {
            "name": chat.user_name if m.role == "user" else (chat.card_name or "Character"),
            "is_user": m.role == "user",
            "is_system": False,
            "send_date": iso_st(m.created_at),
            "mes": mes,
        }
        # ST 只给角色消息挂 swipes 结构;用户消息就是纯文本
        if m.role != "user":
            swipe_info = m.swipe_info or [{} for _ in m.swipes]
            row["swipes"] = list(m.swipes)
            row["swipe_id"] = swipe_id
            row["swipe_info"] = [
                {
                    "send_date": iso_st(m.created_at),
                    "extra": _st_extra(swipe_info[i] if i < len(swipe_info) else {}),
                }
                for i in range(len(m.swipes))
            ]
            current = swipe_info[swipe_id] if swipe_id < len(swipe_info) else {}
            extra = _st_extra(current)
            if extra:
                row["extra"] = extra
        lines.append(json.dumps(row, ensure_ascii=False))

    return "\n".join(lines) + "\n"


def parse_st_jsonl(name: str, text: str) -> dict:
    """导入方向。返回表结构所需的原料,建库由调用方做。

    {name, user_name, character_name, tainted, main_chat,
     messages: [{role, swipes, swipe_id, swipe_info, created_at}],
     branch_links: [(子文件名, 父消息序号)]}
    """
    parsed: dict = {
        "name": name,
        "user_name": "User",
        "character_name": "",
        "tainted": False,
        "main_chat": None,
        "messages": [],
        "branch_links": [],
    }

    for lineno, line in enumerate(text.splitlines()):
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue  # 烂行跳过,ST 靠 readline 也是这种容忍姿态
        if not isinstance(obj, dict):
            continue

        if lineno == 0 and "mes" not in obj:
            parsed["user_name"] = obj.get("user_name") or "User"
            parsed["character_name"] = obj.get("character_name") or ""
            metadata = obj.get("chat_metadata") or {}
            parsed["tainted"] = bool(metadata.get("tainted"))
            parsed["main_chat"] = metadata.get("main_chat")
            continue

        is_user = bool(obj.get("is_user"))
        swipes = obj.get("swipes")
        mes = obj.get("mes") or ""
        if isinstance(swipes, list) and swipes:
            # swipes 才是分支全集;mes 只是当前分支的冗余副本,别拿它回写、
            # 免得 mes 与 swipes[swipe_id] 不一致时把别的分支盖掉
            swipes = [s if isinstance(s, str) else str(s) for s in swipes]
            swipe_id = obj.get("swipe_id")
            if not isinstance(swipe_id, int) or not 0 <= swipe_id < len(swipes):
                swipe_id = 0
        else:
            swipes = [mes]
            swipe_id = 0

        st_swipe_info = obj.get("swipe_info")
        if not isinstance(st_swipe_info, list):
            st_swipe_info = []
        message_extra = obj.get("extra") if isinstance(obj.get("extra"), dict) else {}

        # Keep one slot per swipe while mapping. Appending only non-empty info
        # would shift metadata left when an earlier swipe has no metadata.
        mapped_swipe_info = []
        for i in range(len(swipes)):
            st_swipe = st_swipe_info[i] if i < len(st_swipe_info) and isinstance(st_swipe_info[i], dict) else None
            # 消息级 extra 只描述当前分支;历史分支的信息在各自的 swipe_info 里
            extra = message_extra if i == swipe_id and message_extra else (st_swipe or {}).get("extra")
            mapped_swipe_info.append(_our_info(extra, st_swipe))

        # 全空就不占地方;只要有一项非空就保留完整位置对齐。
        swipe_info = mapped_swipe_info if any(mapped_swipe_info) else []

        created_at = _parse_iso(obj.get("send_date"))
        parsed["messages"].append(
            {
                "role": "user" if is_user else "assistant",
                "swipes": swipes,
                "swipe_id": swipe_id,
                "swipe_info": swipe_info,
                "created_at": created_at,
            }
        )

        # ST 的分支反链:extra.branches[](从这里开始)与 extra.bookmark_link(检查点)
        links: list[str] = []
        if isinstance(message_extra.get("branches"), list):
            links.extend(b for b in message_extra["branches"] if isinstance(b, str))
        if isinstance(message_extra.get("bookmark_link"), str):
            links.append(message_extra["bookmark_link"])
        idx = len(parsed["messages"]) - 1
        parsed["branch_links"].extend((b, idx) for b in links)

    return parsed
