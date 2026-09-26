"""One-off dev migration: add the stream flag to api_connections.

Existing connections default to 1 — they were all working before, and a relay
that cannot stream will surface as a clear error on the first try.
"""

import sqlite3

db = sqlite3.connect("data/animabackend.db")
cols = {r[1] for r in db.execute("PRAGMA table_info(api_connections)")}
if "stream" not in cols:
    db.execute("ALTER TABLE api_connections ADD COLUMN stream BOOLEAN NOT NULL DEFAULT 1")
    print("added stream")
else:
    print("stream already present")

db.commit()
print([r[1] for r in db.execute("PRAGMA table_info(api_connections)")])
