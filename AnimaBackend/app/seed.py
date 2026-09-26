import json
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import ApiConnection, Persona, PromptPreset, TavernCard

_SEED_DATA = Path(__file__).resolve().parent / "seed_data"


def seed_default_persona(db: Session) -> None:
    """First run only: a default player persona so {{user}} has a name."""
    if db.scalars(select(Persona)).first() is not None:
        return
    db.add(
        Persona(
            name="旅行者",
            description="一位远道而来的旅行者,对这片土地上的新鲜事物充满好奇。",
            is_active=True,
        )
    )
    db.commit()


def seed_default_connections(db: Session) -> None:
    """First run only: a mock connection, plus real ones for any keys in .env."""
    if db.scalars(select(ApiConnection)).first() is not None:
        return
    conns = [ApiConnection(name="Mock（本地测试）", api_type="mock", model="mock")]
    if settings.anthropic_api_key:
        conns.append(
            ApiConnection(
                name="Anthropic（来自 .env）",
                api_type="anthropic",
                api_key=settings.anthropic_api_key,
                model="claude-sonnet-5",
            )
        )
    if settings.openai_api_key:
        conns.append(
            ApiConnection(
                name="OpenAI（来自 .env）",
                api_type="openai_compatible",
                api_key=settings.openai_api_key,
                base_url=settings.openai_base_url,
                model="gpt-4o",
            )
        )
    # prefer a real connection as the active one; mock only if that's all there is
    conns[-1].is_active = True
    db.add_all(conns)
    db.commit()


def seed_default_tavern_data(db: Session) -> None:
    """First run only: the bundled Anima card + default Chat Completion preset,
    so the prompt console has something selectable before any import."""
    if db.scalars(select(TavernCard)).first() is None:
        raw = json.loads((_SEED_DATA / "anima-character.json").read_text(encoding="utf-8"))
        # V2/V3 keep the real fields under `data`; V1 is flat
        d = raw.get("data", raw)
        db.add(
            TavernCard(
                name=d.get("name", ""),
                description=d.get("description", ""),
                personality=d.get("personality", ""),
                scenario=d.get("scenario", ""),
                first_mes=d.get("first_mes", ""),
                mes_example=d.get("mes_example", ""),
                system_prompt=d.get("system_prompt", ""),
                post_history_instructions=d.get("post_history_instructions", ""),
                creator_notes=d.get("creator_notes", ""),
                alternate_greetings=d.get("alternate_greetings", []),
                tags=d.get("tags", []),
                creator=d.get("creator", ""),
                character_version=d.get("character_version", ""),
                character_book=d.get("character_book"),
                extensions=d.get("extensions", {}),
                spec=raw.get("spec", "chara_card_v2"),
            )
        )

    if db.scalars(select(PromptPreset)).first() is None:
        raw = json.loads((_SEED_DATA / "default-preset.json").read_text(encoding="utf-8"))
        db.add(
            PromptPreset(
                name="默认预设",
                prompts=raw.get("prompts", []),
                prompt_order=raw.get("prompt_order", []),
                formats={
                    k: raw[k]
                    for k in (
                        "wi_format",
                        "scenario_format",
                        "personality_format",
                        "group_nudge_prompt",
                        "new_chat_prompt",
                        "new_example_chat_prompt",
                    )
                    if k in raw
                },
                params={
                    k: raw[k]
                    for k in ("temperature", "top_p", "openai_max_context", "openai_max_tokens")
                    if k in raw
                },
                squash_system_messages=raw.get("squash_system_messages", False),
            )
        )

    db.commit()
