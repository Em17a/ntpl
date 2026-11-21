PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS room_members (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  nickname TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'controller',
  joined_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  left_at INTEGER
);
CREATE INDEX IF NOT EXISTS room_members_room_idx ON room_members(room_code);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  member_id TEXT,
  nickname TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'chat',
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_room_id_idx ON messages(room_code, id);
CREATE TABLE IF NOT EXISTS matchmaking_queue (
  client_id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  gender TEXT NOT NULL,
  preference TEXT NOT NULL,
  role_preference TEXT NOT NULL DEFAULT 'any',
  matched_role TEXT,
  status TEXT NOT NULL DEFAULT 'waiting',
  room_code TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS matchmaking_queue_status_created_idx ON matchmaking_queue(status, created_at);
