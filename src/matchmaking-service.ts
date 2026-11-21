import { assignMatchRoles, chooseMatchPartner } from './matchmaking-core.ts';

export type MatchStatus =
  | { status: 'waiting' }
  | { status: 'missing' }
  | { status: 'matched'; room: string; role: 'controller' | 'receiver' }
  | { status: 'repair_failed' };

async function ensureMatchedSeats(db: D1Database, room: string, timestamp: number): Promise<boolean> {
  const rows = await db.prepare(
    "SELECT client_id,nickname,matched_role,created_at FROM matchmaking_queue WHERE status='matched' AND room_code=? ORDER BY created_at,client_id"
  ).bind(room).all<any>();
  if (rows.results.length !== 2) return false;

  await db.batch(rows.results.map((row: any) => db.prepare(
    'INSERT OR IGNORE INTO room_members(id,room_code,nickname,role,joined_at,last_seen_at) VALUES(?,?,?,?,?,?)'
  ).bind(String(row.client_id), room, String(row.nickname), row.matched_role, Number(row.created_at) || timestamp, timestamp)));

  const seats = await db.prepare(
    'SELECT id,role FROM room_members WHERE room_code=? AND left_at IS NULL'
  ).bind(room).all<any>();
  return rows.results.every((row: any) =>
    seats.results.some((seat: any) => seat.id === row.client_id && seat.role === row.matched_role)
  );
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
      const room = String(existing.room_code);
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
  const room = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
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
    return { status: 'waiting' };
  }

  await scheduleNextAlarm?.();
  return { status: 'matched', room, role: selfRole };
}
