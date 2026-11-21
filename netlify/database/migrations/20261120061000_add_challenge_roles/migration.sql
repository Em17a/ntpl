ALTER TABLE "room_members" ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'controller';
ALTER TABLE "matchmaking_queue" ADD COLUMN IF NOT EXISTS "role_preference" text NOT NULL DEFAULT 'any';
ALTER TABLE "matchmaking_queue" ADD COLUMN IF NOT EXISTS "matched_role" text;
