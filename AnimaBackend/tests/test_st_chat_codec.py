import json
from datetime import datetime, timezone
from types import SimpleNamespace

from app.api.st_chat_codec import (
    chat_to_jsonl,
    iso_st,
    parse_st_jsonl,
    sanitize_st_filename,
    strip_branch_suffix,
)


def test_filename_sanitization_handles_windows_reserved_characters_and_empty_names():
    assert sanitize_st_filename('A/B:C*D?E"F<G>H|I.') == "A_B_C_D_E_F_G_H_I"
    assert sanitize_st_filename("...  ") == "chat"
    assert len(sanitize_st_filename("长" * 300)) == 180


def test_branch_suffix_stripping_only_removes_terminal_branch_number():
    assert strip_branch_suffix("主聊天 - Branch #31") == "主聊天"
    assert strip_branch_suffix("Branch #2 出现在正文") == "Branch #2 出现在正文"


def test_iso_timestamp_normalizes_naive_and_offset_datetimes_to_utc():
    assert iso_st(datetime(2026, 1, 2, 3, 4, 5, 678000)) == "2026-01-02T03:04:05.678Z"
    offset = datetime.fromisoformat("2026-01-02T11:04:05.678+08:00")
    assert iso_st(offset) == "2026-01-02T03:04:05.678Z"


def test_parser_skips_blank_malformed_and_non_object_lines():
    text = "\nnot-json\n[]\n" + json.dumps({"is_user": True, "mes": "仍可导入"})

    parsed = parse_st_jsonl("broken", text)

    assert len(parsed["messages"]) == 1
    assert parsed["messages"][0]["swipes"] == ["仍可导入"]


def test_parser_prefers_swipe_collection_and_clamps_invalid_selected_index():
    text = "\n".join(
        [
            json.dumps({"user_name": "玩家", "character_name": "角色", "chat_metadata": {}}),
            json.dumps(
                {
                    "is_user": False,
                    "mes": "不应覆盖 swipe",
                    "swipes": ["A", "B"],
                    "swipe_id": 99,
                }
            ),
        ]
    )

    parsed = parse_st_jsonl("chat", text)

    assert parsed["messages"][0]["swipes"] == ["A", "B"]
    assert parsed["messages"][0]["swipe_id"] == 0


def test_parser_maps_reasoning_timing_and_branch_links():
    text = "\n".join(
        [
            json.dumps(
                {
                    "user_name": "玩家",
                    "character_name": "角色",
                    "chat_metadata": {"tainted": True, "main_chat": "Root"},
                }
            ),
            json.dumps(
                {
                    "is_user": False,
                    "mes": "回答",
                    "swipes": ["回答"],
                    "swipe_id": 0,
                    "swipe_info": [
                        {
                            "gen_started": "2026-01-01T00:00:01.000Z",
                            "gen_finished": "2026-01-01T00:00:02.250Z",
                            "extra": {"model": "model-a"},
                        }
                    ],
                    "extra": {
                        "model": "model-a",
                        "reasoning": "推理",
                        "reasoning_type": "model",
                        "reasoning_duration": 400,
                        "time_to_first_token": 120,
                        "branches": ["Child A"],
                        "bookmark_link": "Child B",
                    },
                }
            ),
        ]
    )

    parsed = parse_st_jsonl("Child A", text)
    info = parsed["messages"][0]["swipe_info"][0]

    assert parsed["tainted"] is True
    assert parsed["main_chat"] == "Root"
    assert info == {
        "model": "model-a",
        "reasoning": "推理",
        "reasoningType": "model",
        "reasoningMs": 400,
        "ttftMs": 120,
        "totalMs": 1250,
    }
    assert parsed["branch_links"] == [("Child A", 0), ("Child B", 0)]


def test_export_then_parse_preserves_public_chat_content():
    now = datetime(2026, 2, 3, 4, 5, 6, tzinfo=timezone.utc)
    chat = SimpleNamespace(
        user_name="玩家", card_name="Anima", tainted=True
    )
    messages = [
        SimpleNamespace(
            role="user",
            swipes=["你好"],
            swipe_id=0,
            swipe_info=[{}],
            created_at=now,
        ),
        SimpleNamespace(
            role="assistant",
            swipes=["回答一", "回答二"],
            swipe_id=1,
            swipe_info=[{}, {"model": "mock", "reasoning": "思考", "reasoningType": "model"}],
            created_at=now,
        ),
    ]

    exported = chat_to_jsonl(chat, messages, parent_stem="Parent")
    parsed = parse_st_jsonl("Child", exported)

    assert parsed["user_name"] == "玩家"
    assert parsed["character_name"] == "Anima"
    assert parsed["tainted"] is True
    assert parsed["main_chat"] == "Parent"
    assert [message["role"] for message in parsed["messages"]] == ["user", "assistant"]
    assert parsed["messages"][1]["swipes"] == ["回答一", "回答二"]
    assert parsed["messages"][1]["swipe_id"] == 1
    assert parsed["messages"][1]["swipe_info"][1]["reasoning"] == "思考"
