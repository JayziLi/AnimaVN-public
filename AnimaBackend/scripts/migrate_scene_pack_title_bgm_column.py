"""One-off dev migration: scene_packs.title_bgm_id (which BGM the title screen plays).

NULL means "play the pack's first BGM" — the default, so existing packs need no
value. Safe to run twice.
"""

import sqlite3

db = sqlite3.connect("data/animabackend.db")

cols = {r[1] for r in db.execute("PRAGMA table_info(scene_packs)")}
if not cols:
    print("scene_packs missing, skipped (create_all will build it)")
elif "title_bgm_id" in cols:
    print("scene_packs.title_bgm_id already present")
else:
    db.execute("ALTER TABLE scene_packs ADD COLUMN title_bgm_id VARCHAR(32)")
    print("added scene_packs.title_bgm_id")
db.commit()
