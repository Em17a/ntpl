-- Room expiration timestamps and lookup index.
ALTER TABLE rooms ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;
-- Give rooms that already existed at rollout a fresh maximum lifetime.
UPDATE rooms SET expires_at=CAST(strftime('%s','now') AS INTEGER)*1000+120*60*1000 WHERE expires_at<=0;
CREATE INDEX IF NOT EXISTS rooms_expiry_idx ON rooms(expires_at);
