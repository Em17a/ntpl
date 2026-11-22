ALTER TABLE game_history ADD COLUMN opponent_guest_id TEXT;
ALTER TABLE game_history ADD COLUMN opponent_nickname TEXT;

CREATE TABLE IF NOT EXISTS guest_profiles (
  guest_id TEXT PRIMARY KEY,
  friend_code TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL,
  online_visible INTEGER NOT NULL DEFAULT 1,
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS friend_requests (
  id TEXT PRIMARY KEY,
  requester_guest_id TEXT NOT NULL,
  addressee_guest_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  created_at INTEGER NOT NULL,
  responded_at INTEGER,
  CHECK (requester_guest_id <> addressee_guest_id)
);
CREATE INDEX IF NOT EXISTS friend_requests_incoming_idx
  ON friend_requests(addressee_guest_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS friend_requests_outgoing_idx
  ON friend_requests(requester_guest_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS friendships (
  guest_a TEXT NOT NULL,
  guest_b TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guest_a, guest_b),
  CHECK (guest_a < guest_b)
);
CREATE INDEX IF NOT EXISTS friendships_guest_b_idx ON friendships(guest_b, guest_a);

CREATE TABLE IF NOT EXISTS direct_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_guest_id TEXT NOT NULL,
  recipient_guest_id TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text' CHECK (message_type IN ('text','invite')),
  body TEXT NOT NULL,
  room_code TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS direct_messages_pair_idx
  ON direct_messages(sender_guest_id, recipient_guest_id, id);
CREATE INDEX IF NOT EXISTS direct_messages_recipient_idx
  ON direct_messages(recipient_guest_id, sender_guest_id, id);
