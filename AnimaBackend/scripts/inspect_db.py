"""Dev helper: dump a quick overview of the dev DB."""

import io
import sqlite3
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

db = sqlite3.connect("data/animabackend.db")
print("connections:", db.execute("select name, api_type, model, is_active from api_connections").fetchall())
print("characters:", db.execute("select name, tagline, length(greeting) from characters").fetchall())
print("sessions:", db.execute("select count(*) from game_sessions").fetchone()[0])
print("messages:", db.execute("select count(*) from messages").fetchone()[0])
