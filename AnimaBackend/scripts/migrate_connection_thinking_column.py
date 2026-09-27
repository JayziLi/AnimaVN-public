"""One-off dev migration: api_connections.thinking (how hard the model thinks).

NULL means "send nothing, use the service default" — exactly what every
existing connection did before, so old profiles behave the same.
Safe to run twice.
"""

import sqlite3

db = sqlite3.connect("data/animabackend.db")

cols = {r[1] for r in db.execute("PRAGMA table_info(api_connections)")}
if not cols:
    print("api_connections missing, skipped (create_all will build it)")
elif "thinking" in cols:
    print("api_connections.thinking already present")
else:
    db.execute("ALTER TABLE api_connections ADD COLUMN thinking VARCHAR(16)")
    print("added api_connections.thinking")
db.commit()
