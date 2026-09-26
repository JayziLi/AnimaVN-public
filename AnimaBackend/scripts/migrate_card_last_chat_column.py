"""One-off dev migration: tavern_cards.last_chat_id.

The card remembers which chat was open last, like ST's `character.chat`.
No FK on purpose — a chat can be deleted out from under the pointer, and the
read side already falls back to the card's most recently updated chat.
"""

import sqlite3

db = sqlite3.connect("data/animabackend.db")
cols = {r[1] for r in db.execute("PRAGMA table_info(tavern_cards)")}
if "last_chat_id" not in cols:
    db.execute("ALTER TABLE tavern_cards ADD COLUMN last_chat_id VARCHAR(32)")
    print("added last_chat_id")
else:
    print("last_chat_id already present")

db.commit()
print([r[1] for r in db.execute("PRAGMA table_info(tavern_cards)")])
