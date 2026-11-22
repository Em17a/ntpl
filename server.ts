// Nightplay 双人房间服务端：Render Web Service + PostgreSQL + WebSocket
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { rooms, roomMembers, messages } from "../../db/schema.js";

export const config = { path: ["/ws", "/api/*"] };

const MAX_SEATS = 2;
const ONLINE_WINDOW_S = 45; // 超过该时间无心跳视为离线
const SEAT_TTL_S = 300; // 离线超过该时间座位自动释放
const ROOM_RETENTION_DAYS = 7; // 闲置房间及其消息的保留时间
const HISTORY_LIMIT = 60;
const CODE_RE = /^[A-Z0-9]{4,12}$/;

const CHALLENGES = [
  "两位参与者各写一个故事线索，然后共同选出下一步。",
  "用三个词描述此刻故事的氛围，对方据此续写一句。",
  "为故事里的角色起一个新的代号，并说明原因。",
  "轮流提出一个“如果……会怎样”的假设，选一个推进剧情。",
  "各自给出一个想保留和一个想跳过的情节，互相尊重选择。",
  "设定一个双方都同意的暗号，任何一方说出即暂停。",
];
const SCENES = [
  "灯光渐暗，一封没有署名的信被推到门下。",
  "雨声停了，远处传来第二声敲门。",
  "地图上多出一个此前从未标注的地点。",
  "旧唱片机自己转了起来，播放着一首熟悉的曲子。",
  "窗外的霓虹拼出一个只有你们能看懂的词。",
];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

type Meta = {
  memberId: string;
  room: string;
  nickname: string;
  bucket: number;
  bucketAt: number;
  lastTypingAt: number;
};
type Client = WebSocket & { meta?: Meta };

// 每个实例只持有本实例的 socket；跨实例状态全部以数据库为准，客户端心跳时补齐缺失消息。
const local = new Map<string, Set<Client>>();

const send = (ws: Client, data: unknown) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
};
const broadcast = (room: string, data: unknown, except?: Client) => {
  for (const ws of local.get(room) ?? []) if (ws !== except) send(ws, data);
};

type Row = typeof messages.$inferSelect;
const serialize = (m: Row) => ({
  id: m.id,
  kind: m.kind,
  nickname: m.nickname,
  memberId: m.memberId,
  body: m.body,
  createdAt: m.createdAt,
});

async function addMessage(room: string, kind: string, body: string, member?: { id: string; nickname: string }) {
  const [row] = await db
    .insert(messages)
    .values({ roomCode: room, kind, body, memberId: member?.id ?? null, nickname: member?.nickname ?? "" })
    .returning();
  await db.update(rooms).set({ lastActiveAt: new Date() }).where(eq(rooms.code, room));
  const msg = serialize(row);
  broadcast(room, { type: "message", message: msg });
  return msg;
}

async function presence(room: string) {
  const rows = await db
    .select({ id: roomMembers.id, nickname: roomMembers.nickname, lastSeenAt: roomMembers.lastSeenAt })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomCode, room), isNull(roomMembers.leftAt)))
    .orderBy(asc(roomMembers.joinedAt));
  const localIds = new Set([...(local.get(room) ?? [])].map((w) => w.meta?.memberId));
  const cutoff = Date.now() - ONLINE_WINDOW_S * 1000;
  return rows.map((r) => ({
    id: r.id,
    nickname: r.nickname,
    online: localIds.has(r.id) || new Date(r.lastSeenAt).getTime() > cutoff,
  }));
}
const pushPresence = async (room: string) => broadcast(room, { type: "presence", members: await presence(room), seats: MAX_SEATS });

async function history(room: string, lastId?: number) {
  if (lastId && lastId > 0) {
    const rows = await db
      .select()
      .from(messages)
      .where(and(eq(messages.roomCode, room), gt(messages.id, lastId)))
      .orderBy(asc(messages.id))
      .limit(200);
    return rows.map(serialize);
  }
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.roomCode, room))
    .orderBy(desc(messages.id))
    .limit(HISTORY_LIMIT);
  return rows.reverse().map(serialize);
}

function detach(ws: Client) {
  const m = ws.meta;
  if (!m) return;
  const set = local.get(m.room);
  set?.delete(ws);
  if (set && set.size === 0) local.delete(m.room);
  ws.meta = undefined;
}

async function handleJoin(ws: Client, msg: any) {
  const room = String(msg.room ?? "").trim().toUpperCase();
  const nickname = String(msg.nickname ?? "").trim().replace(/\s+/g, " ").slice(0, 24);
  const token = typeof msg.token === "string" && /^[0-9a-f-]{36}$/i.test(msg.token) ? msg.token : null;
  if (!CODE_RE.test(room)) return send(ws, { type: "error", code: "bad_room", message: "房间代码需为 4–12 位字母或数字。" });
  if (!nickname) return send(ws, { type: "error", code: "bad_nickname", message: "请先填写昵称。" });

  // 已在其他房间：先在本地解绑（座位保留，按超时释放）
  if (ws.meta && (ws.meta.room !== room || ws.meta.memberId !== token)) detach(ws);

  const result = await db.transaction(async (tx) => {
    const created = await tx.insert(rooms).values({ code: room }).onConflictDoNothing().returning();
    // 锁住房间行，避免两人同时抢最后一个座位
    await tx.select().from(rooms).where(eq(rooms.code, room)).for("update");
    await tx
      .update(roomMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(roomMembers.roomCode, room),
          isNull(roomMembers.leftAt),
          lt(roomMembers.lastSeenAt, sql`now() - make_interval(secs => ${SEAT_TTL_S})`),
        ),
      );
    if (token) {
      const [existing] = await tx
        .update(roomMembers)
        .set({ lastSeenAt: new Date(), nickname })
        .where(and(eq(roomMembers.id, token), eq(roomMembers.roomCode, room), isNull(roomMembers.leftAt)))
        .returning();
      if (existing) return { member: existing, isNew: false, created: created.length > 0, renamed: false };
    }
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(roomMembers)
      .where(and(eq(roomMembers.roomCode, room), isNull(roomMembers.leftAt)));
    if (count >= MAX_SEATS) return { full: true as const };
    const [member] = await tx.insert(roomMembers).values({ roomCode: room, nickname }).returning();
    await tx.update(rooms).set({ lastActiveAt: new Date() }).where(eq(rooms.code, room));
    return { member, isNew: true, created: created.length > 0 };
  });

  if ("full" in result) {
    return send(ws, { type: "error", code: "room_full", message: "该房间已有两位参与者，请换一个房间代码。" });
  }

  const { member, isNew, created } = result;
  if (created) {
    // 顺带清理长期闲置的旧房间（级联删除成员和消息）
    db.delete(rooms)
      .where(lt(rooms.lastActiveAt, sql`now() - make_interval(days => ${ROOM_RETENTION_DAYS})`))
      .catch((e) => console.error("cleanup failed", e));
  }

  ws.meta = { memberId: member.id, room, nickname: member.nickname, bucket: 8, bucketAt: Date.now(), lastTypingAt: 0 };
  if (!local.has(room)) local.set(room, new Set());
  local.get(room)!.add(ws);

  const lastId = Number(msg.lastId) || 0;
  send(ws, {
    type: "joined",
    room,
    token: member.id,
    you: { id: member.id, nickname: member.nickname },
    resumed: !isNew,
    history: await history(room, isNew ? 0 : lastId),
    members: await presence(room),
    seats: MAX_SEATS,
  });
  if (isNew) await addMessage(room, "system", `${member.nickname} 加入了房间`);
  await pushPresence(room);
}

// 校验座位仍然有效并刷新心跳
async function touch(m: Meta) {
  const rows = await db
    .update(roomMembers)
    .set({ lastSeenAt: new Date() })
    .where(and(eq(roomMembers.id, m.memberId), isNull(roomMembers.leftAt)))
    .returning({ id: roomMembers.id });
  return rows.length > 0;
}

function rateLimited(m: Meta) {
  const now = Date.now();
  m.bucket = Math.min(8, m.bucket + ((now - m.bucketAt) / 1000) * 0.8);
  m.bucketAt = now;
  if (m.bucket < 1) return true;
  m.bucket -= 1;
  return false;
}

async function seatLost(ws: Client) {
  send(ws, { type: "error", code: "seat_lost", message: "你的座位已失效，请重新加入房间。" });
  detach(ws);
}

const ACTIONS: Record<string, (n: string) => string> = {
  next_scene: (n) => `${n} 推进到下一幕：${pick(SCENES)}`,
  challenge: (n) => `${n} 发起随机挑战：${pick(CHALLENGES)}`,
  pause: (n) => `${n} 请求暂停。双方确认前请不要继续推进。`,
  resume: (n) => `${n} 表示可以继续。`,
  stop: (n) => `${n} 结束了本轮互动。`,
};

async function handle(ws: Client, msg: any) {
  if (msg.type === "join") return handleJoin(ws, msg);
  const m = ws.meta;
  if (msg.type === "ping") {
    if (!m) return send(ws, { type: "pong" });
    if (!(await touch(m))) return seatLost(ws);
    const lastId = Number(msg.lastId) || 0;
    return send(ws, {
      type: "pong",
      missed: lastId ? await history(m.room, lastId) : [],
      members: await presence(m.room),
      seats: MAX_SEATS,
    });
  }
  if (!m) return send(ws, { type: "error", code: "not_joined", message: "请先加入房间。" });

  if (msg.type === "chat") {
    const text = String(msg.text ?? "").trim().slice(0, 500);
    if (!text) return;
    if (rateLimited(m)) return send(ws, { type: "error", code: "rate_limited", message: "发送太快了，请稍等片刻。" });
    if (!(await touch(m))) return seatLost(ws);
    return addMessage(m.room, "chat", text, { id: m.memberId, nickname: m.nickname });
  }
  if (msg.type === "action") {
    const make = ACTIONS[msg.action];
    if (!make) return;
    if (rateLimited(m)) return send(ws, { type: "error", code: "rate_limited", message: "操作太快了，请稍等片刻。" });
    if (!(await touch(m))) return seatLost(ws);
    return addMessage(m.room, "action", make(m.nickname), { id: m.memberId, nickname: m.nickname });
  }
  if (msg.type === "voice-signal") {
    // Only relay small WebRTC negotiation payloads to the other room participant.
    const signal = msg.signal;
    if (!signal || typeof signal !== "object" || !["ready", "offer", "answer", "ice", "hangup"].includes(signal.kind)) return;
    const encoded = JSON.stringify(signal);
    if (encoded.length > 3500) return send(ws, { type: "error", code: "signal_too_large", message: "语音连接信令过大。" });
    if (!(await touch(m))) return seatLost(ws);
    return broadcast(m.room, { type: "voice-signal", from: m.memberId, signal }, ws);
  }
  if (msg.type === "typing") {
    const now = Date.now();
    if (now - m.lastTypingAt < 1500) return;
    m.lastTypingAt = now;
    return broadcast(m.room, { type: "typing", memberId: m.memberId, nickname: m.nickname }, ws);
  }
  if (msg.type === "leave") {
    const { room, memberId, nickname } = m;
    detach(ws);
    const rows = await db
      .update(roomMembers)
      .set({ leftAt: new Date() })
      .where(and(eq(roomMembers.id, memberId), isNull(roomMembers.leftAt)))
      .returning({ id: roomMembers.id });
    send(ws, { type: "left" });
    if (rows.length) await addMessage(room, "system", `${nickname} 离开了房间`);
    return pushPresence(room);
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4,12})$/);
  if (req.method === "GET" && match) {
    const room = match[1].toUpperCase();
    presence(room)
      .then((members) => {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ room, seats: MAX_SEATS, taken: members.length, full: members.length >= MAX_SEATS }));
      })
      .catch((e) => {
        console.error(e);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "server_error" }));
      });
    return;
  }
  if (url.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  // Serve the single-page frontend from the same origin as the API and WebSocket.
  const publicRoot = resolve(process.cwd(), "public");
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = resolve(publicRoot, "." + requested);
  if (filePath === publicRoot || filePath.startsWith(publicRoot + sep)) {
    readFile(filePath).then((body) => {
      const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
      res.writeHead(200, { "content-type": types[extname(filePath)] || "application/octet-stream", "cache-control": "no-cache" });
      res.end(body);
    }).catch(() => {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4096 });

wss.on("connection", (ws: Client) => {
  // 串行处理同一连接的消息，保证顺序
  let chain: Promise<unknown> = Promise.resolve();
  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: "error", code: "bad_json", message: "无法解析的消息。" });
    }
    if (!msg || typeof msg.type !== "string") return;
    chain = chain
      .then(() => handle(ws, msg))
      .catch((e) => {
        console.error("ws handler error", e);
        send(ws, { type: "error", code: "server_error", message: "服务器暂时出错，请稍后重试。" });
      });
  });
  ws.on("close", () => {
    const m = ws.meta;
    if (!m) return;
    detach(ws);
    // 立即显示为离线，但保留座位以便刷新或断线重连
    chain
      .then(() =>
        db
          .update(roomMembers)
          .set({ lastSeenAt: sql`now() - make_interval(secs => ${ONLINE_WINDOW_S + 1})` })
          .where(and(eq(roomMembers.id, m.memberId), isNull(roomMembers.leftAt))),
      )
      .then(() => pushPresence(m.room))
      .catch((e) => console.error("close handler error", e));
  });
});

export default server;
