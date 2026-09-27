"""Export the dev DB as plain files, so characters, chats and assets can live in git.

    python scripts/export_userdata.py [db] [out]     (defaults: data/animabackend.db ../userdata)

Layout of the output:
  schema.sql                  CREATE statements, straight from sqlite_master
  tables/<table>.jsonl        one row per line, ordered by primary key
  tables/<table>/<key>.jsonl  big tables, split by a column (one file per chat)
  blobs/ab/abcd….png          every BLOB value, named by its sha256; rows point at
                              it with {"$blob": "ab/abcd….png"}

Same content → same file name, so an unchanged sprite never becomes a new git
object and a new message only touches its own chat's file. The TTS cache is left
out (it is rebuilt on demand) and API keys are blanked. Restore with
import_userdata.py.
"""

import hashlib
import json
import re
import shutil
import sqlite3
import sys
from pathlib import Path
from urllib.parse import quote

SKIP_ROWS = {"tts_cache"}  # 表结构照导，行不导
BLANK = {("api_connections", "api_key")}  # 密钥不进仓库，恢复后在「连接」里重填
# 单个文件别过 GitHub 的 50 MB 警告线：对话按会话拆，提示词快照一条一个文件
SPLIT = {"debug_chat_messages": "chat_id", "debug_snapshots": "hash"}
EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/flac": ".flac",
    "audio/mp4": ".m4a",
}


def export(db_path: Path, out: Path) -> None:
    db = sqlite3.connect(f"file:{quote(db_path.as_posix())}?mode=ro", uri=True)
    db.execute("BEGIN")  # 一个读事务里导完，后端在写也拿到同一个时间点
    (out / "blobs").mkdir(parents=True, exist_ok=True)
    tables_dir = out / "tables"
    shutil.rmtree(tables_dir, ignore_errors=True)  # 每次重写，删掉的会话不留旧文件
    tables_dir.mkdir()

    schema = db.execute(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
        " ORDER BY type = 'table' DESC, name"
    ).fetchall()
    (out / "schema.sql").write_text("".join(f"{sql};\n\n" for (sql,) in schema), encoding="utf-8")

    tables = [r[0] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )]
    blobs: set[str] = set()
    for table in tables:
        if table in SKIP_ROWS:
            continue
        info = db.execute(f'PRAGMA table_info("{table}")').fetchall()
        cols = [c[1] for c in info]
        pk = [c[1] for c in sorted(info, key=lambda c: c[5]) if c[5]] or ["rowid"]
        order = ", ".join(f'"{c}"' for c in pk)
        files: dict[Path, list[str]] = {}
        for values in db.execute(f'SELECT * FROM "{table}" ORDER BY {order}'):
            row = dict(zip(cols, values))
            for col in cols:
                if (table, col) in BLANK and row[col]:
                    row[col] = ""
                elif isinstance(row[col], bytes):
                    row[col] = {"$blob": save_blob(out, row[col], row.get("mime"))}
                    blobs.add(row[col]["$blob"])
            path = tables_dir / f"{table}.jsonl"
            if table in SPLIT:
                key = re.sub(r"[^\w-]", "_", str(row[SPLIT[table]]))
                path = tables_dir / table / f"{key}.jsonl"
            files.setdefault(path, []).append(json.dumps(row, ensure_ascii=False) + "\n")
        for path, lines in files.items():
            path.parent.mkdir(exist_ok=True)
            path.write_text("".join(lines), encoding="utf-8", newline="\n")
        print(f"{table}: {sum(map(len, files.values()))} rows")

    # 删掉已经没人引用的旧素材（git 历史里还在）
    for f in (out / "blobs").glob("*/*"):
        if f"{f.parent.name}/{f.name}" not in blobs:
            f.unlink()
    for d in (out / "blobs").iterdir():
        if d.is_dir() and not any(d.iterdir()):
            d.rmdir()
    db.rollback()
    print(f"{len(blobs)} blobs -> {out}")


def save_blob(out: Path, data: bytes, mime: object) -> str:
    digest = hashlib.sha256(data).hexdigest()
    rel = f"{digest[:2]}/{digest}{EXT.get(mime, '.bin') if isinstance(mime, str) else '.bin'}"
    path = out / "blobs" / rel
    if not path.exists():
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(data)
    return rel


if __name__ == "__main__":
    args = sys.argv[1:]
    export(Path(args[0] if args else "data/animabackend.db"), Path(args[1] if len(args) > 1 else "../userdata"))
