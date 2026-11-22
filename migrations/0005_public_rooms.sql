-- Public room directory: room owner and display name
ALTER TABLE rooms ADD COLUMN room_name TEXT NOT NULL DEFAULT '';
ALTER TABLE rooms ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN owner_member_id TEXT;
CREATE INDEX IF NOT EXISTS rooms_public_active_idx ON rooms(is_public, last_active_at);
