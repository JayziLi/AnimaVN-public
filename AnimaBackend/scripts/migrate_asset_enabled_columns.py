"""One-off dev migration: card_sprites.enabled and scene_assets.enabled.

A disabled sprite / background / BGM stays in the table but the game treats it
as missing. Existing rows start enabled. A fresh database gets the columns from
create_all; this only patches databases that already have the tables. Safe to
run twice.
"""

import sqlite3

db = sqlite3.connect("data/animabackend.db")

for table in ("card_sprites", "scene_assets"):
    cols = {r[1] for r in db.execute(f"PRAGMA table_info({table})")}
    if not cols:
        print(f"{table} missing, skipped (create_all will build it)")
    elif "enabled" in cols:
        print(f"{table}.enabled already present")
    else:
        db.execute(f"ALTER TABLE {table} ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT 1")
        print(f"added {table}.enabled")
db.commit()
