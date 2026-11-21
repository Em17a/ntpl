import { assignMatchRoles, chooseMatchPartner } from './matchmaking-core.ts';

export type MatchStatus =
  | { status: 'waiting' }
  | { status: 'missing' }
  | { status: 'matched'; room: string; role: 'controller' | 'receiver' }
  | { status: 'repair_failed' }
  | { status: 'cancelled' };

const validRoomCode = /^[A-Z0-9]{8}$/;
const roomAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newRoomCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => roomAlphabet[byte & 31]).join('');
}

export interface MatchmakingJoinInput {
  clientId: string;
  nickname: string;
  gender: string;
  preference: string;
  rolePreference: string;
  voicePreference: string;
}

/**
 * The only operation allowed to create or refresh a queue entry.
 * INSERT OR IGNORE deliberately preserves a cancellation tombstone: a delayed
 * join request with the same client id can never resurrect a cancelled search.
 */
export async function joinMatchmaking(
  db: D1Database,
  input: MatchmakingJoinInput,
  timestamp: number,
): Promise<MatchStatus> {
  await db.prepare(`INSERT OR IGNORE INTO matchmaking_queue
    (client_id,nickname,gender,preference,role_preference,voice_preference,status,created_at,last_seen_at)
    VALUES(?,?,?,?,?,?,'waiting',?,?)`)
    .bind(input.clientId, input.nickname, input.gender, input.preference,
      input.rolePreference, input.voicePreference, timestamp, timestamp).run();

  await db.prepare(`UPDATE matchmaking_queue
    SET nickname=?,gender=?,preference=?,role_preference=?,voice_preference=?,last_seen_at=?
    WHERE client_id=? AND status='waiting'`)
    .bind(input.nickname, input.gender, input.preference, input.rolePreference,
      input.voicePreference, timestamp, input.clientId).run();

  return findOrCreateMatch(db, input.clientId, timestamp);
}

async function repairLegacyRoomCode(db: D1Database, oldRoom: string, timestamp: number): Promise<string | null> {
  if (validRoomCode.test(oldRoom)) return oldRoom;
  const members = await db.prepare('SELECT COUNT(*) AS count FROM room_members WHERE room_code=?')
    .bind(oldRoom).first<any>();
  const queueRows = await db.prepare("SELECT COUNT(*) AS count FROM matchmaking_queue WHERE status='matched' AND room_code=?")
    .bind(oldRoom).first<any>();
  if (Number(members?.count) > 0 || Number(queueRows?.count) !== 2) return null;

  const previous = await db.prepare('SELECT created_at,last_active_at,expires_at FROM rooms WHERE code=?')
    .bind(oldRoom).first<any>();
  const room = newRoomCode();
  const createdAt = Number(previous?.created_at) || timestamp;
  const lastActiveAt = Number(previous?.last_active_at) || timestamp;
  const expiresAt = Math.max(Number(previous?.expires_at) || 0, timestamp + 120 * 60_000);
  const results = await db.batch([
    db.prepare('INSERT INTO rooms(code,created_at,last_active_at,expires_at) VALUES(?,?,?,?)')
      .bind(room, createdAt, lastActiveAt, expiresAt),
    db.prepare("UPDATE matchmaking_queue SET room_code=? WHERE status='matched' AND room_code=?")
      .bind(room, oldRoom),
    db.prepare('UPDATE messages SET room_code=? WHERE room_code=?').bind(room, oldRoom),
    db.prepare('DELETE FROM rooms WHERE code=?').bind(oldRoom),
  ]);
  if (Number(results[1]?.meta?.changes) !== 2) {
    await db.batch([
      db.prepare('INSERT OR IGNORE INTO rooms(code,created_at,last_active_at,expires_at) VALUES(?,?,?,?)')
        .bind(oldRoom, createdAt, lastActiveAt, expiresAt),
      db.prepare("UPDATE matchmaking_queue SET room_code=? WHERE status='matched' AND room_code=?")
        .bind(oldRoom, room),
      db.prepare('DELETE FROM rooms WHERE code=?').bind(room),
    ]);
    return null;
  }
  return room;
}

async function ensureMatchedSeats(db: D1Database, room: string, timestamp: number): Promise<boolean> {
  const rows = await db.prepare(
    "SELECT client_id,nickname,matched_role,created_at FROM matchmaking_queue WHERE status='matched' AND room_code=? ORDER BY created_at,client_id"
  ).bind(room).all<any>();
  if (rows.results.length !== 2) return false;

  const roles = new Set(rows.results.map((row: any) => row.matched_role));
  if (roles.size !== 2 || !roles.has('controller') || !roles.has('receiver')) return false;

  const existing = await db.prepare(
    'SELECT id,role FROM room_members WHERE room_code=? AND left_at IS NULL ORDER BY joined_at'
  ).bind(room).all<any>();
  if (existing.results.length > 2) return false;
  const existingRoles = existing.results.map((seat: any) => seat.role);
  if (existingRoles.some((role: string) => !roles.has(role)) || new Set(existingRoles).size !== existingRoles.length) return false;

  const missing = rows.results.filter((row: any) => !existingRoles.includes(row.matched_role));
  if (missing.length) {
    await db.batch(missing.map((row: any) => db.prepare(
      'INSERT INTO room_members(id,room_code,nickname,role,joined_at,last_seen_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET nickname=excluded.nickname,role=excluded.role,last_seen_at=excluded.last_seen_at,left_at=NULL WHERE room_members.room_code=excluded.room_code'
    ).bind(String(row.client_id), room, String(row.nickname), row.matched_role, Number(row.created_at) || timestamp, timestamp)));
  }

  const seats = await db.prepare(
    'SELECT id,role FROM room_members WHERE room_code=? AND left_at IS NULL'
  ).bind(room).all<any>();
  return seats.results.length === 2
    && roles.has(seats.results[0].role)
    && roles.has(seats.results[1].role)
    && new Set(seats.results.map((seat: any) => seat.role)).size === 2;
}

export async function findOrCreateMatch(
  db: D1Database,
  clientId: string,
  timestamp: number,
  scheduleNextAlarm?: () => Promise<void>,
): Promise<MatchStatus> {
  await db.prepare("DELETE FROM matchmaking_queue WHERE status='waiting' AND last_seen_at<?")
    .bind(timestamp - 45_000).run();
  await db.prepare('DELETE FROM matchmaking_queue WHERE created_at<?')
    .bind(timestamp - 86_400_000).run();

  const self = await db.prepare("SELECT * FROM matchmaking_queue WHERE client_id=? AND status='waiting'")
    .bind(clientId).first<any>();
  if (!self) {
    const existing = await db.prepare('SELECT * FROM matchmaking_queue WHERE client_id=?')
      .bind(clientId).first<any>();
    if (existing?.status === 'matched' && existing.room_code &&
      ['controller', 'receiver'].includes(existing.matched_role)) {
      const originalRoom = String(existing.room_code);
      const room = await repairLegacyRoomCode(db, originalRoom, timestamp);
      if (!room) return { status: 'repair_failed' };
      const roomRecord = await db.prepare('SELECT expires_at FROM rooms WHERE code=?')
        .bind(room).first<any>();
      if (!roomRecord || Number(roomRecord.expires_at) <= timestamp) return { status: 'missing' };
      return await ensureMatchedSeats(db, room, timestamp)
        ? { status: 'matched', room, role: existing.matched_role }
        : { status: 'repair_failed' };
    }
    return { status: 'missing' };
  }

  const waiting = await db.prepare(
    "SELECT * FROM matchmaking_queue WHERE status='waiting' AND client_id<>? ORDER BY created_at LIMIT 100"
  ).bind(clientId).all<any>();
  const partner = chooseMatchPartner(self, waiting.results);
  if (!partner) return { status: 'waiting' };

  const { selfRole, partnerRole } = assignMatchRoles(self, partner);
  const room = newRoomCode();
  const results = await db.batch([
    db.prepare('INSERT INTO rooms(code,created_at,last_active_at,expires_at) VALUES(?,?,?,?)')
      .bind(room, timestamp, timestamp, timestamp + 120 * 60_000),
    db.prepare("UPDATE matchmaking_queue SET status='matched',room_code=?,matched_role=? WHERE client_id=? AND status='waiting'")
      .bind(room, selfRole, clientId),
    db.prepare("UPDATE matchmaking_queue SET status='matched',room_code=?,matched_role=? WHERE client_id=? AND status='waiting'")
      .bind(room, partnerRole, partner.client_id),
    db.prepare('INSERT INTO room_members(id,room_code,nickname,role,joined_at,last_seen_at) SELECT client_id,room_code,nickname,matched_role,?,? FROM matchmaking_queue WHERE client_id=? AND status=\'matched\' AND room_code=?')
      .bind(timestamp, timestamp, clientId, room),
    db.prepare('INSERT INTO room_members(id,room_code,nickname,role,joined_at,last_seen_at) SELECT client_id,room_code,nickname,matched_role,?,? FROM matchmaking_queue WHERE client_id=? AND status=\'matched\' AND room_code=?')
      .bind(timestamp, timestamp, partner.client_id, room),
  ]);

  const matched = await db.prepare(
    "SELECT client_id,matched_role FROM matchmaking_queue WHERE status='matched' AND room_code=?"
  ).bind(room).all<any>();
  const updatesSucceeded = Number(results[1]?.meta?.changes) === 1
    && Number(results[2]?.meta?.changes) === 1
    && Number(results[3]?.meta?.changes) === 1
    && Number(results[4]?.meta?.changes) === 1;

  if (!updatesSucceeded || matched.results.length !== 2) {
    await db.batch([
      db.prepare("UPDATE matchmaking_queue SET status='waiting',room_code=NULL,matched_role=NULL WHERE status='matched' AND room_code=?")
        .bind(room),
      db.prepare('DELETE FROM room_members WHERE room_code=?').bind(room),
      db.prepare('DELETE FROM rooms WHERE code=?').bind(room),
    ]);

    // Another poll may have won the D1 transaction while this request was
    // preparing its candidate pair. Return that committed result immediately.
    const winner = await db.prepare("SELECT room_code,matched_role FROM matchmaking_queue WHERE client_id=? AND status='matched'")
      .bind(clientId).first<any>();
    if (winner?.room_code && ['controller', 'receiver'].includes(winner.matched_role)) {
      const winnerRoom = await repairLegacyRoomCode(db, String(winner.room_code), timestamp);
      if (!winnerRoom) return { status: 'repair_failed' };
      return await ensureMatchedSeats(db, winnerRoom, timestamp)
        ? { status: 'matched', room: winnerRoom, role: winner.matched_role }
        : { status: 'repair_failed' };
    }
    return { status: 'waiting' };
  }

  await scheduleNextAlarm?.();
  return { status: 'matched', room, role: selfRole };
}


/** Refreshes a queued player's lease and actively attempts pairing on every poll.
 * Polling is not a passive status read: it is also the matchmaking heartbeat/worker.
 */
export async function pollMatchmaking(
  db: D1Database,
  clientId: string,
  timestamp: number,
): Promise<MatchStatus> {
  await db.prepare("UPDATE matchmaking_queue SET last_seen_at=? WHERE client_id=? AND status='waiting'")
    .bind(timestamp, clientId).run();
  const row = await db.prepare('SELECT status FROM matchmaking_queue WHERE client_id=?')
    .bind(clientId).first<any>();
  if (!row) return { status: 'missing' };
  return findOrCreateMatch(db, clientId, timestamp);
}

/** Cancellation wins only while the queue row is still waiting.
 * Re-read after the conditional update so a concurrent successful match is never
 * reported as cancelled and its room is never orphaned.
 */
export async function cancelMatchmaking(
  db: D1Database,
  clientId: string,
  timestamp: number,
): Promise<MatchStatus> {
  // Keep a short-lived cancellation tombstone. This closes the race where the
  // user taps Cancel while the first Join request is still in flight: a late
  // INSERT OR IGNORE can no longer recreate a waiting queue entry.
  await db.prepare(`INSERT OR IGNORE INTO matchmaking_queue
    (client_id,nickname,gender,preference,role_preference,voice_preference,status,created_at,last_seen_at)
    VALUES(?,'','other','any','any','any','cancelled',?,?)`)
    .bind(clientId, timestamp, timestamp).run();

  const before = await db.prepare('SELECT status FROM matchmaking_queue WHERE client_id=?')
    .bind(clientId).first<any>();
  if (before?.status === 'matched') return findOrCreateMatch(db, clientId, timestamp);
  if (before?.status === 'waiting') {
    await db.prepare("UPDATE matchmaking_queue SET status='cancelled',last_seen_at=? WHERE client_id=? AND status='waiting'")
      .bind(timestamp, clientId).run();
  }

  const after = await db.prepare('SELECT status FROM matchmaking_queue WHERE client_id=?')
    .bind(clientId).first<any>();
  if (after?.status === 'matched') return findOrCreateMatch(db, clientId, timestamp);
  return { status: 'cancelled' };
}
