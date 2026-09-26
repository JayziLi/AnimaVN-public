"""One-off dev migration: voice_profiles.params (per-voice synthesis params).

A JSON object holding only the params the user tuned (temperature, top_k, ...);
empty means engine defaults. A fresh database gets the column from create_all;
this only patches databases that already have the voice tables. Safe to run twice.
"""

import sqlite3

db = sqlite3.connect("data/animabackend.db")

cols = {r[1] for r in db.execute("PRAGMA table_info(voice_profiles)")}
if not cols:
    print("voice_profiles missing, skipped (create_all will build it)")
elif "params" in cols:
    print("voice_profiles.params already present")
else:
    db.execute("ALTER TABLE voice_profiles ADD COLUMN params JSON NOT NULL DEFAULT '{}'")
    print("added voice_profiles.params")
db.commit()
