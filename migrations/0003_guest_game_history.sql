ALTER TABLE room_members ADD COLUMN guest_id TEXT;

CREATE TABLE IF NOT EXISTS game_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id TEXT NOT NULL,
  room_code TEXT NOT NULL,
  member_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  role TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  UNIQUE(guest_id, room_code, member_id)
);

CREATE INDEX IF NOT EXISTS game_history_guest_ended_idx
  ON game_history(guest_id, ended_at DESC);
