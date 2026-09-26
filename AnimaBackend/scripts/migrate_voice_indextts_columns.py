"""One-off dev migration: the two IndexTTS columns.

voice_profiles.ref_path (speaker reference) and voice_emotions.emo_vector
(8-dim emotion vector). A fresh database gets them from create_all; this only
patches databases that already have the voice tables. Safe to run twice.
"""

import sqlite3

db = sqlite3.connect("data/animabackend.db")


def add(table: str, column: str, ddl: str) -> None:
    cols = {r[1] for r in db.execute(f"PRAGMA table_info({table})")}
    if not cols:
        print(f"{table} missing, skipped (create_all will build it)")
    elif column in cols:
        print(f"{table}.{column} already present")
    else:
        db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
        print(f"added {table}.{column}")


add("voice_profiles", "ref_path", "VARCHAR(500) NOT NULL DEFAULT ''")
add("voice_emotions", "emo_vector", "JSON")
db.commit()
