CREATE TABLE IF NOT EXISTS "matchmaking_queue" (
  "client_id" uuid PRIMARY KEY NOT NULL,
  "nickname" text NOT NULL,
  "gender" text NOT NULL,
  "preference" text NOT NULL,
  "status" text DEFAULT 'waiting' NOT NULL,
  "room_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "matchmaking_queue_status_created_idx"
  ON "matchmaking_queue" ("status", "created_at");
