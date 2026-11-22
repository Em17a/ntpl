CREATE TABLE "messages" (
	"id" serial PRIMARY KEY,
	"room_code" text NOT NULL,
	"member_id" uuid,
	"nickname" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'chat' NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"room_code" text NOT NULL,
	"nickname" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"code" text PRIMARY KEY,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "messages_room_id_idx" ON "messages" ("room_code","id");--> statement-breakpoint
CREATE INDEX "room_members_room_idx" ON "room_members" ("room_code");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_room_code_rooms_code_fkey" FOREIGN KEY ("room_code") REFERENCES "rooms"("code") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_room_code_rooms_code_fkey" FOREIGN KEY ("room_code") REFERENCES "rooms"("code") ON DELETE CASCADE;