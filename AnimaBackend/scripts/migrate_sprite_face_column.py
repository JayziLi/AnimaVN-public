"""One-off dev migration: card_sprites.face_scan (where the face is, for aligning sprites).

NULL means "not scanned yet"; the sprite page fills it in through
POST /api/tavern/cards/{id}/sprites/scan-faces the first time it opens a card.
The per-card layout table (card_sprite_layouts) is new, so create_all builds it.
Safe to run twice.
"""

import sqlite3

db = sqlite3.connect("data/animabackend.db")

cols = {r[1] for r in db.execute("PRAGMA table_info(card_sprites)")}
if not cols:
    print("card_sprites missing, skipped (create_all will build it)")
elif "face_scan" in cols:
    print("card_sprites.face_scan already present")
else:
    db.execute("ALTER TABLE card_sprites ADD COLUMN face_scan JSON")
    print("added card_sprites.face_scan")
db.commit()
