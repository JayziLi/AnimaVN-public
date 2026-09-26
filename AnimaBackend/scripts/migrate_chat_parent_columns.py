"""One-off dev migration: branch pointers on debug_chats.

No FK on these — a deleted parent just means the child's tree root moves up,
which the frontend tree builder already handles.
"""

import sqlite3

db = sqlite3.connect("data/animabackend.db")
cols = {r[1] for r in db.execute("PRAGMA table_info(debug_chats)")}
if "parent_chat_id" not in cols:
    db.execute("ALTER TABLE debug_chats ADD COLUMN parent_chat_id VARCHAR(32)")
    print("added parent_chat_id")
else:
    print("parent_chat_id already present")
if "parent_message_id" not in cols:
    db.execute("ALTER TABLE debug_chats ADD COLUMN parent_message_id VARCHAR(36)")
    print("added parent_message_id")
else:
    print("parent_message_id already present")

db.commit()
print([r[1] for r in db.execute("PRAGMA table_info(debug_chats)")])
