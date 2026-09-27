import json
import sqlite3
import subprocess
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
PNG = b"\x89PNG\r\n\x1a\n" + bytes(range(256))


def run_script(cwd: Path, name: str, *args: str) -> None:
    result = subprocess.run(
        [sys.executable, str(SCRIPT_DIR / name), *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stderr


@contextmanager
def opened(db_path: Path) -> Iterator[sqlite3.Connection]:
    # sqlite3 的 with 只提交不关闭；Windows 上文件被占着就没法改名
    db = sqlite3.connect(db_path)
    try:
        with db:
            yield db
    finally:
        db.close()


def rows(db_path: Path, table: str) -> list[tuple]:
    with opened(db_path) as db:
        return db.execute(f"SELECT * FROM {table} ORDER BY 1, 2").fetchall()


def make_backend(tmp_path: Path) -> Path:
    backend = tmp_path / "AnimaBackend"
    (backend / "data").mkdir(parents=True)
    with opened(backend / "data" / "animabackend.db") as db:
        db.executescript(
            """
            CREATE TABLE api_connections (id TEXT PRIMARY KEY, name TEXT, api_key TEXT);
            CREATE TABLE card_sprites (id TEXT PRIMARY KEY, card_id TEXT, image BLOB, mime TEXT, zoom FLOAT);
            CREATE INDEX ix_card_sprites_card_id ON card_sprites (card_id);
            CREATE TABLE card_scene_packs (card_id TEXT, pack_id TEXT, PRIMARY KEY (card_id, pack_id));
            CREATE TABLE tts_cache (key TEXT PRIMARY KEY, data BLOB);
            CREATE TABLE debug_chat_messages (id TEXT PRIMARY KEY, chat_id TEXT, idx INTEGER, swipes JSON);
            """
        )
        db.execute("INSERT INTO api_connections VALUES ('c1', 'deepseek', 'sk-secret')")
        db.execute("INSERT INTO card_sprites VALUES ('s2', 'k1', ?, 'image/png', 0.1)", (PNG,))
        db.execute("INSERT INTO card_sprites VALUES ('s1', 'k1', ?, 'image/png', NULL)", (PNG,))
        db.execute("INSERT INTO card_scene_packs VALUES ('k1', 'p2'), ('k1', 'p1')")
        db.execute("INSERT INTO tts_cache VALUES ('h', x'00')")
        db.execute(
            "INSERT INTO debug_chat_messages VALUES"
            " ('m1', 'chatA', 0, '[\"你好\"]'), ('m2', 'chatB', 0, '[\"hi\"]'), ('m3', 'chatA', 1, '[\"嗯\"]')"
        )
    return backend


def test_export_writes_blobs_once_and_leaves_out_keys_and_tts_cache(tmp_path: Path):
    backend = make_backend(tmp_path)
    run_script(backend, "export_userdata.py")

    out = tmp_path / "userdata"
    blobs = list((out / "blobs").glob("*/*"))
    assert [b.suffix for b in blobs] == [".png"]
    assert blobs[0].read_bytes() == PNG
    sprites = [json.loads(l) for l in (out / "tables" / "card_sprites.jsonl").read_text("utf-8").splitlines()]
    assert [s["id"] for s in sprites] == ["s1", "s2"]
    assert sprites[0]["image"] == {"$blob": f"{blobs[0].parent.name}/{blobs[0].name}"}
    assert json.loads((out / "tables" / "api_connections.jsonl").read_text("utf-8"))["api_key"] == ""
    assert not (out / "tables" / "tts_cache.jsonl").exists()
    assert "CREATE TABLE tts_cache" in (out / "schema.sql").read_text("utf-8")
    chats = out / "tables" / "debug_chat_messages"
    assert sorted(p.name for p in chats.iterdir()) == ["chatA.jsonl", "chatB.jsonl"]
    assert [json.loads(l)["id"] for l in (chats / "chatA.jsonl").read_text("utf-8").splitlines()] == ["m1", "m3"]

    before = {p: p.read_bytes() for p in out.rglob("*") if p.is_file()}
    run_script(backend, "export_userdata.py")
    assert {p: p.read_bytes() for p in out.rglob("*") if p.is_file()} == before


def test_export_drops_files_nobody_uses_any_more(tmp_path: Path):
    backend = make_backend(tmp_path)
    run_script(backend, "export_userdata.py")
    with opened(backend / "data" / "animabackend.db") as db:
        db.execute("DELETE FROM card_sprites")
        db.execute("DELETE FROM debug_chat_messages WHERE chat_id = 'chatB'")

    run_script(backend, "export_userdata.py")

    out = tmp_path / "userdata"
    assert list((out / "blobs").iterdir()) == []
    assert [p.name for p in (out / "tables" / "debug_chat_messages").iterdir()] == ["chatA.jsonl"]


def test_import_rebuilds_the_db_and_keeps_the_old_one(tmp_path: Path):
    backend = make_backend(tmp_path)
    original = backend / "data" / "animabackend.db"
    run_script(backend, "export_userdata.py")
    expected = {t: rows(original, t) for t in ["card_sprites", "card_scene_packs", "debug_chat_messages"]}

    run_script(backend, "import_userdata.py")

    assert {t: rows(original, t) for t in expected} == expected
    assert rows(original, "api_connections") == [("c1", "deepseek", "")]
    assert rows(original, "tts_cache") == []
    with opened(original) as db:
        assert db.execute("SELECT 1 FROM sqlite_master WHERE name = 'ix_card_sprites_card_id'").fetchone()
    backups = list((backend / "data").glob("animabackend.db.bak-*"))
    assert len(backups) == 1
    assert rows(backups[0], "api_connections") == [("c1", "deepseek", "sk-secret")]
