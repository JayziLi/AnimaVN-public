import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine

from app.db import Base

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"


def database(tmp_path: Path) -> Path:
    data = tmp_path / "data"
    data.mkdir()
    return data / "animabackend.db"


def run_script(tmp_path: Path, name: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT_DIR / name)],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )


def columns(db_path: Path, table: str) -> list[str]:
    with sqlite3.connect(db_path) as db:
        return [row[1] for row in db.execute(f"PRAGMA table_info({table})")]


def run_twice(tmp_path: Path, script: str) -> None:
    first = run_script(tmp_path, script)
    second = run_script(tmp_path, script)
    assert first.returncode == 0, first.stderr
    assert second.returncode == 0, second.stderr


def test_connection_migrations_preserve_profiles_and_apply_safe_defaults(tmp_path: Path):
    db_path = database(tmp_path)
    with sqlite3.connect(db_path) as db:
        db.execute(
            "CREATE TABLE api_connections (id TEXT PRIMARY KEY, name TEXT NOT NULL)"
        )
        db.execute("INSERT INTO api_connections (id, name) VALUES ('a1', '旧连接')")
        db.commit()

    run_twice(tmp_path, "migrate_connection_cache_columns.py")
    run_twice(tmp_path, "migrate_connection_stream_column.py")

    assert columns(db_path, "api_connections") == [
        "id",
        "name",
        "cached_models",
        "cached_models_at",
        "stream",
    ]
    with sqlite3.connect(db_path) as db:
        assert db.execute(
            "SELECT id, name, cached_models, cached_models_at, stream FROM api_connections"
        ).fetchall() == [("a1", "旧连接", "[]", None, 1)]


def test_chat_parent_migration_adds_nullable_links_without_changing_chat(tmp_path: Path):
    db_path = database(tmp_path)
    with sqlite3.connect(db_path) as db:
        db.execute("CREATE TABLE debug_chats (id TEXT PRIMARY KEY, name TEXT NOT NULL)")
        db.execute("INSERT INTO debug_chats (id, name) VALUES ('d1', '旧聊天')")
        db.commit()

    run_twice(tmp_path, "migrate_chat_parent_columns.py")

    assert columns(db_path, "debug_chats") == [
        "id",
        "name",
        "parent_chat_id",
        "parent_message_id",
    ]
    with sqlite3.connect(db_path) as db:
        assert db.execute(
            "SELECT id, name, parent_chat_id, parent_message_id FROM debug_chats"
        ).fetchall() == [("d1", "旧聊天", None, None)]


@pytest.mark.parametrize(
    "script",
    [
        "migrate_connection_cache_columns.py",
        "migrate_connection_stream_column.py",
        "migrate_chat_parent_columns.py",
        "migrate_voice_indextts_columns.py",
        "migrate_voice_params_column.py",
        "migrate_asset_enabled_columns.py",
        "migrate_sprite_face_column.py",
        "migrate_connection_thinking_column.py",
        "migrate_scene_pack_title_bgm_column.py",
    ],
)
def test_migration_scripts_are_noops_against_current_schema(tmp_path: Path, script: str):
    db_path = database(tmp_path)
    engine = create_engine(f"sqlite:///{db_path.as_posix()}")
    Base.metadata.create_all(bind=engine)
    engine.dispose()

    result = run_script(tmp_path, script)

    assert result.returncode == 0, result.stderr


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


def test_voice_params_migration_adds_an_empty_params_column(tmp_path: Path):
    db_path = database(tmp_path)
    with sqlite3.connect(db_path) as db:
        db.execute("CREATE TABLE voice_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL)")
        db.execute("INSERT INTO voice_profiles (id, name) VALUES ('p1', '阿米娅')")
        db.commit()

    run_twice(tmp_path, "migrate_voice_params_column.py")

    assert columns(db_path, "voice_profiles") == ["id", "name", "params"]
    with sqlite3.connect(db_path) as db:
        assert db.execute("SELECT id, params FROM voice_profiles").fetchall() == [("p1", "{}")]


def test_voice_params_migration_skips_missing_tables(tmp_path: Path):
    database(tmp_path)
    result = run_script(tmp_path, "migrate_voice_params_column.py")
    assert result.returncode == 0, result.stderr


def test_asset_enabled_migration_keeps_existing_sprites_and_assets_on(tmp_path: Path):
    db_path = database(tmp_path)
    with sqlite3.connect(db_path) as db:
        db.execute("CREATE TABLE card_sprites (id TEXT PRIMARY KEY, label TEXT NOT NULL)")
        db.execute("CREATE TABLE scene_assets (id TEXT PRIMARY KEY, label TEXT NOT NULL)")
        db.execute("INSERT INTO card_sprites (id, label) VALUES ('s1', '平静')")
        db.execute("INSERT INTO scene_assets (id, label) VALUES ('a1', '食堂')")
        db.commit()

    run_twice(tmp_path, "migrate_asset_enabled_columns.py")

    assert columns(db_path, "card_sprites") == ["id", "label", "enabled"]
    assert columns(db_path, "scene_assets") == ["id", "label", "enabled"]
    with sqlite3.connect(db_path) as db:
        assert db.execute("SELECT id, enabled FROM card_sprites").fetchall() == [("s1", 1)]
        assert db.execute("SELECT id, enabled FROM scene_assets").fetchall() == [("a1", 1)]


def test_asset_enabled_migration_skips_missing_tables(tmp_path: Path):
    database(tmp_path)
    result = run_script(tmp_path, "migrate_asset_enabled_columns.py")
    assert result.returncode == 0, result.stderr


def test_sprite_face_migration_adds_an_unscanned_column(tmp_path: Path):
    db_path = database(tmp_path)
    with sqlite3.connect(db_path) as db:
        db.execute("CREATE TABLE card_sprites (id TEXT PRIMARY KEY, label TEXT NOT NULL)")
        db.execute("INSERT INTO card_sprites (id, label) VALUES ('s1', '平静')")
        db.commit()

    run_twice(tmp_path, "migrate_sprite_face_column.py")

    assert columns(db_path, "card_sprites") == ["id", "label", "face_scan"]
    with sqlite3.connect(db_path) as db:
        assert db.execute("SELECT id, face_scan FROM card_sprites").fetchall() == [("s1", None)]


def test_sprite_face_migration_skips_missing_tables(tmp_path: Path):
    database(tmp_path)
    result = run_script(tmp_path, "migrate_sprite_face_column.py")
    assert result.returncode == 0, result.stderr


def test_connection_thinking_migration_leaves_existing_connections_on_service_default(tmp_path: Path):
    db_path = database(tmp_path)
    with sqlite3.connect(db_path) as db:
        db.execute("CREATE TABLE api_connections (id TEXT PRIMARY KEY, name TEXT NOT NULL)")
        db.execute("INSERT INTO api_connections (id, name) VALUES ('a1', 'deepseek')")
        db.commit()

    run_twice(tmp_path, "migrate_connection_thinking_column.py")

    assert columns(db_path, "api_connections") == ["id", "name", "thinking"]
    with sqlite3.connect(db_path) as db:
        assert db.execute("SELECT id, thinking FROM api_connections").fetchall() == [("a1", None)]


def test_connection_thinking_migration_skips_missing_tables(tmp_path: Path):
    database(tmp_path)
    result = run_script(tmp_path, "migrate_connection_thinking_column.py")
    assert result.returncode == 0, result.stderr


def test_scene_pack_title_bgm_migration_leaves_existing_packs_on_the_default(tmp_path: Path):
    db_path = database(tmp_path)
    with sqlite3.connect(db_path) as db:
        db.execute("CREATE TABLE scene_packs (id TEXT PRIMARY KEY, name TEXT NOT NULL)")
        db.execute("INSERT INTO scene_packs (id, name) VALUES ('p1', '罗德岛')")
        db.commit()

    run_twice(tmp_path, "migrate_scene_pack_title_bgm_column.py")

    assert columns(db_path, "scene_packs") == ["id", "name", "title_bgm_id"]
    with sqlite3.connect(db_path) as db:
        assert db.execute("SELECT id, title_bgm_id FROM scene_packs").fetchall() == [("p1", None)]


def test_scene_pack_title_bgm_migration_skips_missing_tables(tmp_path: Path):
    database(tmp_path)
    result = run_script(tmp_path, "migrate_scene_pack_title_bgm_column.py")
    assert result.returncode == 0, result.stderr
