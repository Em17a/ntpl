const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  },
});

type PresenceReader = (room: string) => Promise<any[]>;
type WatcherCounter = (room: string) => Promise<number>;

/** Public-room, room-availability, site-presence and spectator-directory endpoints. */
export async function handleDirectoryApi(
  request: Request,
  db: D1Database,
  storage: DurableObjectStorage,
  presence: PresenceReader,
  watcherCount: WatcherCounter,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/api/public-rooms') {
    const cutoff = Date.now() - 45_000;
    const result = await db.prepare("SELECT r.code,r.room_name,r.created_at,m.nickname AS host_nickname,m.role AS host_role FROM rooms r JOIN room_members m ON m.id=r.owner_member_id AND m.room_code=r.code WHERE r.is_public=1 AND r.expires_at>? AND m.left_at IS NULL AND m.last_seen_at>? AND r.last_active_at>? AND (SELECT COUNT(*) FROM room_members p WHERE p.room_code=r.code AND p.left_at IS NULL AND p.last_seen_at>?)<2 ORDER BY r.created_at DESC LIMIT 50")
      .bind(Date.now(), cutoff, Date.now() - 7 * 86_400_000, cutoff).all<any>();
    return json({
      rooms: result.results.map((row: any) => ({
        room: row.code, name: row.room_name, hostNickname: row.host_nickname,
        hostRole: row.host_role, createdAt: row.created_at, seats: 1,
      })),
    });
  }

  const roomMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4,12})$/);
  if (request.method === 'GET' && roomMatch) {
    const room = roomMatch[1].toUpperCase();
    const record = await db.prepare('SELECT expires_at FROM rooms WHERE code=?').bind(room).first<any>();
    if (!record || Number(record.expires_at) <= Date.now()) return json({ error: 'room_expired' }, 410);
    const members = await presence(room);
    return json({
      room, seats: 2, taken: members.length, full: members.length >= 2,
      expiresAt: Number(record.expires_at) || 0,
    });
  }

  if (request.method === 'POST' && url.pathname === '/api/online/heartbeat') {
    let body: any;
    try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const visitorId = String(body?.visitorId ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(visitorId)) return json({ error: 'bad_visitor_id' }, 400);
    const timestamp = Date.now();
    await storage.put('site-online:' + visitorId, timestamp);
    const entries = await storage.list<number>({ prefix: 'site-online:' });
    let count = 0;
    const expired: string[] = [];
    for (const [key, lastSeen] of entries) {
      if (Number(lastSeen) > timestamp - 60_000) count += 1;
      else expired.push(key);
    }
    if (expired.length) await storage.delete(expired);
    return json({ online: count, updatedAt: timestamp });
  }

  if (request.method === 'GET' && url.pathname === '/api/watchable') {
    const recent = await db.prepare('SELECT code FROM rooms WHERE expires_at>? AND last_active_at>? ORDER BY last_active_at DESC LIMIT 60')
      .bind(Date.now(), Date.now() - 7 * 86_400_000).all<any>();
    const rooms: any[] = [];
    for (const item of recent.results) {
      const members = await db.prepare('SELECT id,nickname,role,last_seen_at FROM room_members WHERE room_code=? AND left_at IS NULL AND last_seen_at>? ORDER BY joined_at')
        .bind(item.code, Date.now() - 45_000).all<any>();
      if (members.results.length !== 2) continue;
      const consents = await storage.get<string[]>('watch-consent:' + item.code) ?? [];
      if (!members.results.every((member: any) => consents.includes(member.id))) continue;
      rooms.push({
        room: item.code,
        players: members.results.map((member: any) => ({ nickname: member.nickname, role: member.role })),
        watchers: await watcherCount(item.code),
      });
    }
    return json({ rooms });
  }

  return null;
}
