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
