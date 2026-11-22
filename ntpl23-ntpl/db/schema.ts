import { pgTable, serial, text, timestamp, uuid, index } from "drizzle-orm/pg-core";

// 双人房间：房间代码即主键
export const rooms = pgTable("rooms", {
  code: text().primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
});

// 房间座位（每个房间最多 2 个有效座位）。id 同时作为客户端重连凭证。
export const roomMembers = pgTable(
  "room_members",
  {
    id: uuid().primaryKey().defaultRandom(),
    roomCode: text("room_code").notNull().references(() => rooms.code, { onDelete: "cascade" }),
    nickname: text().notNull(),
    role: text().notNull().default("controller"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
  },
  (t) => [index("room_members_room_idx").on(t.roomCode)],
);

// 消息记录：kind = chat | system | action
export const messages = pgTable(
  "messages",
  {
    id: serial().primaryKey(),
    roomCode: text("room_code").notNull().references(() => rooms.code, { onDelete: "cascade" }),
    memberId: uuid("member_id"),
    nickname: text().notNull().default(""),
    kind: text().notNull().default("chat"),
    body: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_room_id_idx").on(t.roomCode, t.id)],
);



// 匿名匹配队列：仅保存昵称与匹配偏好，等待记录会定期清理。
export const matchmakingQueue = pgTable(
  "matchmaking_queue",
  {
    clientId: uuid("client_id").primaryKey(),
    nickname: text().notNull(),
    gender: text().notNull(),
    preference: text().notNull(),
    rolePreference: text("role_preference").notNull().default("any"),
    matchedRole: text("matched_role"),
    status: text().notNull().default("waiting"),
    roomCode: text("room_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("matchmaking_queue_status_created_idx").on(t.status, t.createdAt)],
);
