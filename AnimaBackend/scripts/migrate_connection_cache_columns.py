"""One-off dev migration: add cached_models/cached_models_at to api_connections."""

import sqlite3

db = sqlite3.connect("data/animabackend.db")
cols = {r[1] for r in db.execute("PRAGMA table_info(api_connections)")}
for name, ddl in [
    ("cached_models", "ALTER TABLE api_connections ADD COLUMN cached_models TEXT NOT NULL DEFAULT '[]'"),
    ("cached_models_at", "ALTER TABLE api_connections ADD COLUMN cached_models_at DATETIME"),
]:
    if name not in cols:
        db.execute(ddl)
        print("added", name)

db.commit()
print([r[1] for r in db.execute("PRAGMA table_info(api_connections)")])
