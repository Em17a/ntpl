// Nightplay 双人房间服务端：WebSocket 实时通道 + Netlify Database 持久化
import { createServer } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { rooms, roomMembers, messages, matchmakingQueue } from "../../db/schema.js";

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
  role: "controller" | "receiver";
  contactViolations: number;
  recentChatText: string;
  recentChatAt: number;
  contactMutedUntil: number;
};
type Client = WebSocket & { meta?: Meta; matchmakingClientId?: string };

// 每个实例只持有本实例的 socket；跨实例状态全部以数据库为准，客户端心跳时补齐缺失消息。
const local = new Map<string, Set<Client>>();
const metronomeStates = new Map<string, { bpm: number; intensity: number; running: boolean; stopped?: boolean; nickname: string }>();

const send = (ws: Client, data: unknown) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
};
const broadcast = (room: string, data: unknown, except?: Client) => {
  for (const ws of local.get(room) ?? []) if (ws !== except) send(ws, data);
};

// 联系方式检测：只保留短时上下文，不记录被拦截的原文。
const normalizeContactText = (value: string) => {
  const raw = value.toLowerCase().normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "");
  const compact = raw.replace(/[\s·•,，。:：;；_\-—()（）[\]【】]/g, "");
  return compact
    .replace(/[零〇洞幺两]/g, (c) => ({ 零: "0", 〇: "0", 洞: "0", 幺: "1", 两: "2" }[c] ?? c))
    .replace(/[一二三四五六七八九]/g, (c) => ({ 一: "1", 二: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" }[c] ?? c));
};

function containsContactInfo(value: string): boolean {
  const t = normalizeContactText(value);
  if (!t) return false;
  const phone = /(?:\+?86)?1[3-9]\d{9}/.test(t);
  const email = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(t);
  const socialUrl = /(?:https?\/{1,2}|www\.)|(?:t\.me|telegram\.me|wa\.me|instagram\.com|facebook\.com|line\.me|discord\.gg|discord\.com)/i.test(t);
  const accountLike = /(?:微信|wechat|vx|wx|v信|w信|微x|薇信|威信|qq|扣扣|企鹅号|telegram|电报|飞机号|whatsapp|wats?app|line|instagram|ins号|discord|邮箱|电子邮件)(?:(?:号|id|账号|帐号)?(?:是|为)?|:|：)?[a-z0-9_@.-]{3,}/i.test(t);
  const longNumber = /\d{6,13}/.test(t) && /(?:qq|扣扣|联系|加我|电话|手机|号码|号|vx|wx|微信|v信|w信)/i.test(t);
  const shorthand = /(?:加我|私我|联系我)(?:v|vx|wx)[a-z0-9_-]{3,}/i.test(t);
  return phone || email || socialUrl || accountLike || longNumber || shorthand;
}

function applyContactViolation(ws: Client, source: "text" | "voice") {
  const meta = ws.meta;
  if (!meta) return;
  meta.contactViolations = (meta.contactViolations || 0) + 1;
  const count = meta.contactViolations;
  const mutedForMs = count >= 3 ? 10 * 60_000 : count === 2 ? 60_000 : 0;
  if (mutedForMs) meta.contactMutedUntil = Date.now() + mutedForMs;
  send(ws, {
    type: "contact_blocked",
    source,
    count,
    mutedUntil: mutedForMs ? Date.now() + mutedForMs : 0,
    message: mutedForMs
      ? `检测到交换站外联系方式，已暂停发送${source === "voice" ? "语音" : "消息"}${count >= 3 ? "10分钟" : "1分钟"}。`
      : "检测到疑似站外联系方式，内容已拦截，请勿交换微信、QQ、手机号、邮箱或其他社交账号。",
  });
}

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
    .select({ id: roomMembers.id, nickname: roomMembers.nickname, role: roomMembers.role, lastSeenAt: roomMembers.lastSeenAt })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomCode, room), isNull(roomMembers.leftAt)))
    .orderBy(asc(roomMembers.joinedAt));
  const localIds = new Set([...(local.get(room) ?? [])].map((w) => w.meta?.memberId));
  const cutoff = Date.now() - ONLINE_WINDOW_S * 1000;
  return rows.map((r) => ({
    id: r.id,
    nickname: r.nickname,
    role: r.role,
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

const MATCH_GENDERS = new Set(["male", "female", "other"]);
const MATCH_PREFS = new Set(["male", "female", "any"]);
const ROLE_PREFS = new Set(["controller", "receiver", "any"]);
const makeRoomCode = () => randomBytes(4).toString("hex").toUpperCase();

function compatible(a: typeof matchmakingQueue.$inferSelect, b: typeof matchmakingQueue.$inferSelect) {
  const genderOk = (a.preference === "any" || a.preference === b.gender) &&
    (b.preference === "any" || b.preference === a.gender);
  const roleOk = a.rolePreference === "any" || b.rolePreference === "any" || a.rolePreference !== b.rolePreference;
  return genderOk && roleOk;
}

async function findOrCreateMatch(clientId: string) {
  return db.transaction(async (tx) => {
    // 全局事务锁确保同一时刻只有一个匹配事务配对，避免一人被分配给两个房间。
    await tx.execute(sql`select pg_advisory_xact_lock(731942601)`);
    await tx.delete(matchmakingQueue).where(and(eq(matchmakingQueue.status, "waiting"), lt(matchmakingQueue.lastSeenAt, sql`now() - interval '45 seconds'`)));
    await tx.delete(matchmakingQueue).where(lt(matchmakingQueue.createdAt, sql`now() - interval '1 day'`));
    const [self] = await tx.select().from(matchmakingQueue)
      .where(and(eq(matchmakingQueue.clientId, clientId), eq(matchmakingQueue.status, "waiting")))
      .limit(1).for("update");
    if (!self) {
      const [existing] = await tx.select().from(matchmakingQueue)
        .where(eq(matchmakingQueue.clientId, clientId)).limit(1);
      return existing?.status === "matched" ? { status: "matched", room: existing.roomCode, role: existing.matchedRole } : { status: "missing" };
    }
    const waiting = await tx.select().from(matchmakingQueue)
      .where(and(eq(matchmakingQueue.status, "waiting"), sql`${matchmakingQueue.clientId} <> ${clientId}`))
      .orderBy(asc(matchmakingQueue.createdAt)).limit(100).for("update");
    const partner = waiting.find((candidate) => compatible(self, candidate));
    if (!partner) return { status: "waiting" };
    let room = "";
    for (let i = 0; i < 8; i++) {
      const code = makeRoomCode();
      const created = await tx.insert(rooms).values({ code }).onConflictDoNothing().returning({ code: rooms.code });
      if (created.length) { room = code; break; }
    }
    if (!room) throw new Error("无法生成匹配房间代码");
    let selfRole: "controller" | "receiver";
    let partnerRole: "controller" | "receiver";
    if (self.rolePreference === "any" && partner.rolePreference === "any") { selfRole = "controller"; partnerRole = "receiver"; }
    else if (self.rolePreference === "any") { partnerRole = partner.rolePreference as "controller" | "receiver"; selfRole = partnerRole === "controller" ? "receiver" : "controller"; }
    else if (partner.rolePreference === "any") { selfRole = self.rolePreference as "controller" | "receiver"; partnerRole = selfRole === "controller" ? "receiver" : "controller"; }
    else { selfRole = self.rolePreference as "controller" | "receiver"; partnerRole = partner.rolePreference as "controller" | "receiver"; }
    await tx.update(matchmakingQueue).set({ status: "matched", roomCode: room, matchedRole: selfRole }).where(eq(matchmakingQueue.clientId, clientId));
    await tx.update(matchmakingQueue).set({ status: "matched", roomCode: room, matchedRole: partnerRole }).where(eq(matchmakingQueue.clientId, partner.clientId));
    return { status: "matched", room, role: selfRole, partnerId: partner.clientId };
  });
}

async function handleMatchmakingJoin(ws: Client, msg: any) {
  const clientId = typeof msg.clientId === "string" && /^[0-9a-f-]{36}$/i.test(msg.clientId) ? msg.clientId : "";
  const nickname = String(msg.nickname ?? "").trim().replace(/\s+/g, " ").slice(0, 24);
  const gender = String(msg.gender ?? "");
  const preference = String(msg.preference ?? "");
  const rolePreference = String(msg.rolePreference ?? "any");
  if (!clientId || !nickname || !MATCH_GENDERS.has(gender) || !MATCH_PREFS.has(preference) || !ROLE_PREFS.has(rolePreference)) {
    return send(ws, { type: "error", code: "bad_matchmaking", message: "请检查昵称和匹配偏好设置。" });
  }
  ws.matchmakingClientId = clientId;
  await db.insert(matchmakingQueue).values({ clientId, nickname, gender, preference, rolePreference, status: "waiting" })
    .onConflictDoNothing({ target: matchmakingQueue.clientId });
  await db.update(matchmakingQueue).set({ lastSeenAt: new Date() }).where(eq(matchmakingQueue.clientId, clientId));
  const result = await findOrCreateMatch(clientId);
  if (result.status === "matched") return send(ws, { type: "match_found", room: result.room, role: result.role });
  send(ws, { type: "match_waiting", message: "正在寻找符合双方偏好的参与者…" });
}

async function pollMatchmaking(ws: Client) {
  const clientId = ws.matchmakingClientId;
  if (!clientId) return;
  const touched = await db.update(matchmakingQueue).set({ lastSeenAt: new Date() })
    .where(eq(matchmakingQueue.clientId, clientId)).returning({ clientId: matchmakingQueue.clientId });
  if (!touched.length) {
    ws.matchmakingClientId = undefined;
    send(ws, { type: "match_expired", message: "匹配等待已超时，请重新开始匹配。" });
    return;
  }
  const result = await findOrCreateMatch(clientId);
  if (result.status === "matched") send(ws, { type: "match_found", room: result.room, role: result.role });
}

async function handleJoin(ws: Client, msg: any) {
  const room = String(msg.room ?? "").trim().toUpperCase();
  const nickname = String(msg.nickname ?? "").trim().replace(/\s+/g, " ").slice(0, 24);
  const token = typeof msg.token === "string" && /^[0-9a-f-]{36}$/i.test(msg.token) ? msg.token : null;
  const requestedRole = String(msg.role ?? "any");
  if (!ROLE_PREFS.has(requestedRole)) return send(ws, { type: "error", code: "bad_role", message: "请选择有效的挑战角色。" });
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
    const [firstMember] = await tx.select().from(roomMembers)
      .where(and(eq(roomMembers.roomCode, room), isNull(roomMembers.leftAt)))
      .orderBy(asc(roomMembers.joinedAt)).limit(1);
    let assignedRole: "controller" | "receiver";
    if (!firstMember) assignedRole = requestedRole === "receiver" ? "receiver" : "controller";
    else {
      const wanted = (requestedRole === "any" ? (firstMember.role === "controller" ? "receiver" : "controller") : requestedRole) as "controller" | "receiver";
      if (wanted === firstMember.role) return { roleConflict: true as const, existingRole: firstMember.role };
      assignedRole = wanted;
    }
    const [member] = await tx.insert(roomMembers).values({ roomCode: room, nickname, role: assignedRole }).returning();
    await tx.update(rooms).set({ lastActiveAt: new Date() }).where(eq(rooms.code, room));
    return { member, isNew: true, created: created.length > 0 };
  });

  if ("full" in result) {
    return send(ws, { type: "error", code: "room_full", message: "该房间已有两位参与者，请换一个房间代码。" });
  }
  if ("roleConflict" in result) {
    return send(ws, { type: "error", code: "role_conflict", message: `该房间已有${result.existingRole === "controller" ? "控制方" : "受控方"}，请选择另一角色或让对方更改选择。` });
  }

  const { member, isNew, created } = result;
  if (created) {
    // 顺带清理长期闲置的旧房间（级联删除成员和消息）
    db.delete(rooms)
      .where(lt(rooms.lastActiveAt, sql`now() - make_interval(days => ${ROOM_RETENTION_DAYS})`))
      .catch((e) => console.error("cleanup failed", e));
  }

  ws.meta = { memberId: member.id, room, nickname: member.nickname, role: member.role as "controller" | "receiver", bucket: 8, bucketAt: Date.now(), lastTypingAt: 0, contactViolations: 0, recentChatText: "", recentChatAt: 0, contactMutedUntil: 0 };
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
  const metroState = metronomeStates.get(room);
  if (metroState) send(ws, { type: "metronome_state", ...metroState });
  // 通知已在房间内的另一位成员：对端已经上线，可重发此前等待中的 WebRTC offer。
  for (const peer of local.get(room) ?? []) {
    if (peer !== ws && peer.readyState === WebSocket.OPEN) {
      send(peer, { type: "voice_peer_ready", memberId: member.id, nickname: member.nickname });
    }
  }
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
  if (msg.type === "matchmaking_join") return handleMatchmakingJoin(ws, msg);
  if (msg.type === "matchmaking_cancel") {
    const id = typeof msg.clientId === "string" ? msg.clientId : "";
    if (id && /^[0-9a-f-]{36}$/i.test(id)) {
      const [entry] = await db.select().from(matchmakingQueue).where(eq(matchmakingQueue.clientId, id)).limit(1);
      if (entry?.status === "matched" && entry.roomCode) {
        send(ws, { type: "match_found", room: entry.roomCode, role: entry.matchedRole });
        return;
      }
      await db.delete(matchmakingQueue).where(and(eq(matchmakingQueue.clientId, id), eq(matchmakingQueue.status, "waiting")));
    }
    ws.matchmakingClientId = undefined;
    send(ws, { type: "matchmaking_cancelled" });
    return;
  }
  if (msg.type === "join") return handleJoin(ws, msg);
  const m = ws.meta;
  if (msg.type === "ping") {
    if (!m) { await pollMatchmaking(ws); return send(ws, { type: "pong" }); }
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

  if (msg.type === "metronome_emergency_stop") {
    if (!(await touch(m))) return seatLost(ws);
    const previous = metronomeStates.get(m.room) ?? { bpm: 80, intensity: 3, running: false };
    const state = { ...previous, running: false, stopped: true, nickname: m.nickname };
    metronomeStates.set(m.room, state);
    broadcast(m.room, { type: "metronome_state", ...state }, ws);
    send(ws, { type: "metronome_state", ...state });
    return;
  }
  if (msg.type === "metronome_state") {
    if (m.role !== "controller") return send(ws, { type: "error", code: "role_forbidden", message: "只有控制方可以调整节拍参数和挑战进度。受控方可使用紧急停止。" });
    if (rateLimited(m)) return send(ws, { type: "error", code: "rate_limited", message: "操作太快了，请稍等片刻。" });
    if (!(await touch(m))) return seatLost(ws);
    const bpm = Math.max(40, Math.min(220, Math.round(Number(msg.bpm) || 80)));
    const intensity = Math.max(1, Math.min(5, Math.round(Number(msg.intensity) || 3)));
    const state = { bpm, intensity, running: msg.stopped ? false : Boolean(msg.running), stopped: Boolean(msg.stopped), nickname: m.nickname };
    metronomeStates.set(m.room, state);
    broadcast(m.room, { type: "metronome_state", ...state }, ws);
    return;
  }
  if (msg.type === "chat") {
    const text = String(msg.text ?? "").trim().slice(0, 500);
    if (!text) return;
    if (m.contactMutedUntil > Date.now()) return send(ws, { type: "contact_blocked", source: "text", count: m.contactViolations, mutedUntil: m.contactMutedUntil, message: "你暂时无法发送消息，请稍后再试。" });
    if (rateLimited(m)) return send(ws, { type: "error", code: "rate_limited", message: "发送太快了，请稍等片刻。" });
    if (!(await touch(m))) return seatLost(ws);
    const now = Date.now();
    const combined = now - m.recentChatAt <= 12_000 ? `${m.recentChatText}${text}` : text;
    if (containsContactInfo(text) || containsContactInfo(combined)) {
      m.recentChatText = "";
      m.recentChatAt = 0;
      applyContactViolation(ws, "text");
      return;
    }
    m.recentChatText = text.slice(-120);
    m.recentChatAt = now;
    return addMessage(m.room, "chat", text, { id: m.memberId, nickname: m.nickname });
  }
  if (msg.type === "contact_voice_violation") {
    // 浏览器本地语音识别的提示事件；客户端可绕过，因此仅作为辅助风控信号。
    applyContactViolation(ws, "voice");
    return;
  }
  if (msg.type === "action") {
    const make = ACTIONS[msg.action];
    if (!make) return;
    if (rateLimited(m)) return send(ws, { type: "error", code: "rate_limited", message: "操作太快了，请稍等片刻。" });
    if (!(await touch(m))) return seatLost(ws);
    const message = await addMessage(m.room, "action", make(m.nickname), { id: m.memberId, nickname: m.nickname });
    if (msg.action === "stop") {
      metronomeStates.delete(m.room);
      await db.update(roomMembers).set({ leftAt: new Date() }).where(and(eq(roomMembers.roomCode, m.room), isNull(roomMembers.leftAt)));
      for (const peer of [...(local.get(m.room) ?? [])]) {
        send(peer, { type: "room_ended", message: "本轮互动已结束，房间已自动关闭。" });
        detach(peer);
      }
    }
    return message;
  }
  if (msg.type === "voice_signal") {
    // WebRTC 信令仅在同一房间的另一位已连接成员之间转发，不写入聊天历史。
    const peer = [...(local.get(m.room) ?? [])].find(
      (client) => client !== ws && client.readyState === WebSocket.OPEN && client.meta?.memberId !== m.memberId,
    );
    if (!peer) {
      return send(ws, { type: "voice_notice", message: "另一位参与者尚未在线，进入房间后即可接通语音。" });
    }
    if (msg.kind === "description") {
      const d = msg.description;
      if (!d || !["offer", "answer"].includes(d.type) || typeof d.sdp !== "string" || d.sdp.length > 24000) {
        return send(ws, { type: "error", code: "bad_voice_signal", message: "语音连接信息无效，请重试。" });
      }
      return send(peer, {
        type: "voice_signal", kind: "description", from: m.memberId, nickname: m.nickname,
        description: { type: d.type, sdp: d.sdp },
      });
    }
    if (msg.kind === "candidate") {
      const c = msg.candidate;
      if (!c || typeof c.candidate !== "string" || c.candidate.length > 4096) return;
      return send(peer, {
        type: "voice_signal", kind: "candidate", from: m.memberId,
        candidate: {
          candidate: c.candidate,
          sdpMid: typeof c.sdpMid === "string" ? c.sdpMid.slice(0, 128) : null,
          sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null,
          usernameFragment: typeof c.usernameFragment === "string" ? c.usernameFragment.slice(0, 256) : undefined,
        },
      });
    }
    if (msg.kind === "hangup") {
      return send(peer, { type: "voice_signal", kind: "hangup", from: m.memberId, nickname: m.nickname });
    }
    return;
  }

  if (msg.type === "typing") {
    const now = Date.now();
    if (now - m.lastTypingAt < 1500) return;
    m.lastTypingAt = now;
    return broadcast(m.room, { type: "typing", memberId: m.memberId, nickname: m.nickname }, ws);
  }
  if (msg.type === "leave") {
    const { room, memberId, nickname } = m;
    if (metronomeStates.get(room)?.running) {
      const previous = metronomeStates.get(room)!;
      const state = { ...previous, running: false, stopped: true, nickname };
      metronomeStates.set(room, state);
      broadcast(room, { type: "metronome_state", ...state }, ws);
    }
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
  if (req.method === "GET" && url.pathname === "/api/rtc-config") {
    const room = String(url.searchParams.get("room") ?? "").trim().toUpperCase();
    const member = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!CODE_RE.test(room) || !/^[0-9a-f-]{36}$/i.test(member)) {
      res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "bad_request" }));
      return;
    }
    db.select({ id: roomMembers.id })
      .from(roomMembers)
      .where(and(eq(roomMembers.id, member), eq(roomMembers.roomCode, room), isNull(roomMembers.leftAt)))
      .limit(1)
      .then((members) => {
        if (!members.length) {
          res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ error: "not_a_room_member" }));
          return;
        }
        const iceServers: Array<Record<string, unknown>> = [{ urls: "stun:stun.l.google.com:19302" }];
        const turnUrls = String(process.env.NIGHTPLAY_TURN_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        const sharedSecret = process.env.NIGHTPLAY_TURN_SHARED_SECRET ?? "";
        let turnEnabled = false;
        let expiresAt: number | null = null;
        if (turnUrls.length && sharedSecret) {
          const requestedTtl = Number(process.env.NIGHTPLAY_TURN_TTL_SECONDS ?? 3600);
          const ttl = Math.min(86400, Math.max(300, Number.isFinite(requestedTtl) ? requestedTtl : 3600));
          expiresAt = Math.floor(Date.now() / 1000) + ttl;
          const username = `${expiresAt}:${member}`;
          const credential = createHmac("sha1", sharedSecret).update(username).digest("base64");
          iceServers.push({ urls: turnUrls, username, credential });
          turnEnabled = true;
        }
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ iceServers, turnEnabled, expiresAt }));
      })
      .catch((e) => {
        console.error("RTC config failed", e);
        res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "server_error" }));
      });
    return;
  }
  if (url.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 32 * 1024 });

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
    // 任一方断线时立即停止正在运行的挑战；座位仍短暂保留以便重连。
    const activeMetro = metronomeStates.get(m.room);
    if (activeMetro?.running) {
      const stopped = { ...activeMetro, running: false, stopped: true, nickname: m.nickname };
      metronomeStates.set(m.room, stopped);
      broadcast(m.room, { type: "metronome_state", ...stopped });
    }
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
