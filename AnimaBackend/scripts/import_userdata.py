"""Rebuild the dev DB from an export_userdata.py snapshot (stop the backend first).

    python scripts/import_userdata.py [src] [db]     (defaults: ../userdata data/animabackend.db)

An existing DB is not overwritten: it is renamed to <db>.bak-<time> first.
API keys come back blank (the export leaves them out); fill them in again under
连接. The TTS cache starts empty and refills as lines are voiced.
"""

import json
import sqlite3
import sys
import time
from pathlib import Path


def restore(src: Path, db_path: Path) -> None:
    tmp = db_path.with_name(db_path.name + ".importing")
    tmp.unlink(missing_ok=True)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(tmp)
    db.executescript((src / "schema.sql").read_text(encoding="utf-8"))
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    counts: dict[str, int] = {}
    # tables/<表>.jsonl，或者拆开的大表 tables/<表>/<key>.jsonl
    for path in sorted((src / "tables").glob("*.jsonl")) + sorted((src / "tables").glob("*/*.jsonl")):
        table = path.stem if path.parent.name == "tables" else path.parent.name
        if table not in tables:
            raise SystemExit(f"{path}: schema.sql has no table {table}")
        with path.open(encoding="utf-8") as f:
            for line in f:
                row = json.loads(line)
                values = [
                    (src / "blobs" / v["$blob"]).read_bytes() if isinstance(v, dict) else v
                    for v in row.values()
                ]
                cols = ", ".join(f'"{c}"' for c in row)
                db.execute(f'INSERT INTO "{table}" ({cols}) VALUES ({", ".join("?" * len(row))})', values)
                counts[table] = counts.get(table, 0) + 1
    for table, n in sorted(counts.items()):
        print(f"{table}: {n} rows")
    db.commit()
    db.close()

    if db_path.exists():
        backup = db_path.with_name(f"{db_path.name}.bak-{time.strftime('%Y%m%d-%H%M%S')}")
        db_path.rename(backup)
        print(f"old DB kept as {backup}")
    tmp.rename(db_path)
    print(f"restored -> {db_path}")


if __name__ == "__main__":
    args = sys.argv[1:]
    restore(Path(args[0] if args else "../userdata"), Path(args[1] if len(args) > 1 else "data/animabackend.db"))
