const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  },
});

const GUEST_ID = /^[0-9a-f-]{36}$/i;
const FRIEND_CODE = /^[A-F0-9]{8}$/;

export async function ensureFriendProfile(db: D1Database, guestId: string, nickname: string): Promise<void> {
  const clean = String(nickname || '访客').trim().replace(/\\s+/g, ' ').slice(0, 24) || '访客';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const existing = await db.prepare('SELECT guest_id FROM guest_profiles WHERE guest_id=?')
      .bind(guestId).first<any>();
    if (existing) {
      await db.prepare('UPDATE guest_profiles SET nickname=?,last_seen_at=?,updated_at=? WHERE guest_id=?')
        .bind(clean, Date.now(), Date.now(), guestId).run();
      return;
    }
    const code = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
    await db.prepare('INSERT OR IGNORE INTO guest_profiles(guest_id,friend_code,nickname,online_visible,last_seen_at,created_at,updated_at) VALUES(?,?,?,1,?,?,?)')
      .bind(guestId, code, clean, Date.now(), Date.now(), Date.now()).run();
  }
  const profile = await db.prepare('SELECT guest_id FROM guest_profiles WHERE guest_id=?')
    .bind(guestId).first<any>();
  if (!profile) throw new Error('无法创建好友资料');
}

export async function areFriends(db: D1Database, first: string, second: string): Promise<boolean> {
  const [left, right] = first < second ? [first, second] : [second, first];
  return !!(await db.prepare('SELECT 1 FROM friendships WHERE guest_a=? AND guest_b=?')
    .bind(left, right).first());
}

/** Handles the guest-social HTTP surface; returns null for routes owned elsewhere. */
export async function handleSocialApi(request: Request, db: D1Database): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === 'POST' && url.pathname === '/api/friends/presence') {
    let body: any;
    try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const guestId = String(body?.guestId ?? '');
    const nickname = String(body?.nickname ?? '访客').trim().slice(0, 24) || '访客';
    if (!GUEST_ID.test(guestId)) return json({ error: 'bad_guest_id' }, 400);
    await ensureFriendProfile(db, guestId, nickname);
    return json({ ok: true });
  }

  if (request.method === 'GET' && url.pathname === '/api/friends') {
    const guestId = String(url.searchParams.get('guestId') ?? '');
    if (!GUEST_ID.test(guestId)) return json({ error: 'bad_guest_id' }, 400);
    const profile = await db.prepare('SELECT friend_code,nickname,online_visible FROM guest_profiles WHERE guest_id=?')
      .bind(guestId).first<any>();
    if (!profile) return json({ error: 'profile_not_found' }, 404);
    const friends = await db.prepare('SELECT p.friend_code,p.nickname,p.online_visible,p.last_seen_at FROM friendships f JOIN guest_profiles p ON p.guest_id=CASE WHEN f.guest_a=? THEN f.guest_b ELSE f.guest_a END WHERE f.guest_a=? OR f.guest_b=? ORDER BY p.nickname COLLATE NOCASE')
      .bind(guestId, guestId, guestId).all<any>();
    const incoming = await db.prepare("SELECT r.id,p.friend_code,p.nickname,r.created_at FROM friend_requests r JOIN guest_profiles p ON p.guest_id=r.requester_guest_id WHERE r.addressee_guest_id=? AND r.status='pending' ORDER BY r.created_at DESC LIMIT 50")
      .bind(guestId).all<any>();
    const outgoing = await db.prepare("SELECT r.id,p.friend_code,p.nickname,r.created_at FROM friend_requests r JOIN guest_profiles p ON p.guest_id=r.addressee_guest_id WHERE r.requester_guest_id=? AND r.status='pending' ORDER BY r.created_at DESC LIMIT 50")
      .bind(guestId).all<any>();
    const timestamp = Date.now();
    return json({
      profile: { friendCode: profile.friend_code, nickname: profile.nickname, onlineVisible: !!profile.online_visible },
      friends: friends.results.map((item: any) => ({
        friendCode: item.friend_code,
        nickname: item.nickname,
        online: !!item.online_visible && Number(item.last_seen_at) > timestamp - 60_000,
      })),
      incoming: incoming.results.map((item: any) => ({
        id: item.id, friendCode: item.friend_code, nickname: item.nickname, createdAt: item.created_at,
      })),
      outgoing: outgoing.results.map((item: any) => ({
        id: item.id, friendCode: item.friend_code, nickname: item.nickname, createdAt: item.created_at,
      })),
    });
  }

  if (request.method === 'PATCH' && url.pathname === '/api/friends/profile') {
    let body: any;
    try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const guestId = String(body?.guestId ?? '');
    const visible = body?.onlineVisible === true ? 1 : 0;
    const nickname = String(body?.nickname ?? '').trim().replace(/\\s+/g, ' ').slice(0, 24);
    if (!GUEST_ID.test(guestId)) return json({ error: 'bad_guest_id' }, 400);
    const profile = await db.prepare('SELECT guest_id FROM guest_profiles WHERE guest_id=?')
      .bind(guestId).first<any>();
    if (!profile) return json({ error: 'profile_not_found' }, 404);
    if (nickname) {
      await db.prepare('UPDATE guest_profiles SET nickname=?,online_visible=?,updated_at=? WHERE guest_id=?')
        .bind(nickname, visible, Date.now(), guestId).run();
    } else {
      await db.prepare('UPDATE guest_profiles SET online_visible=?,updated_at=? WHERE guest_id=?')
        .bind(visible, Date.now(), guestId).run();
    }
    return json({ ok: true });
  }

  if (request.method === 'POST' && url.pathname === '/api/friends/request') {
    let body: any;
    try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const guestId = String(body?.guestId ?? '');
    const friendCode = String(body?.friendCode ?? '').trim().toUpperCase();
    if (!GUEST_ID.test(guestId) || !FRIEND_CODE.test(friendCode)) return json({ error: 'bad_request' }, 400);
    const selfProfile = await db.prepare('SELECT guest_id FROM guest_profiles WHERE guest_id=?')
      .bind(guestId).first<any>();
    if (!selfProfile) return json({ error: 'profile_not_found', message: '请先打开好友页面初始化你的游客资料。' }, 404);
    const target = await db.prepare('SELECT guest_id FROM guest_profiles WHERE friend_code=?')
      .bind(friendCode).first<any>();
    if (!target) return json({ error: 'friend_not_found', message: '没有找到这个好友码。' }, 404);
    if (target.guest_id === guestId) return json({ error: 'self_request', message: '不能添加自己。' }, 400);
    if (await areFriends(db, guestId, target.guest_id)) {
      return json({ error: 'already_friends', message: '你们已经是好友了。' }, 409);
    }
    const reverse = await db.prepare("SELECT id FROM friend_requests WHERE requester_guest_id=? AND addressee_guest_id=? AND status='pending'")
      .bind(target.guest_id, guestId).first<any>();
    if (reverse) return json({ error: 'incoming_exists', message: '对方已经向你发送申请，请在好友申请中处理。' }, 409);
    const duplicate = await db.prepare("SELECT id FROM friend_requests WHERE requester_guest_id=? AND addressee_guest_id=? AND status='pending'")
      .bind(guestId, target.guest_id).first<any>();
    if (duplicate) return json({ ok: true, message: '好友申请已发送，请等待对方接受。' });
    await db.prepare("INSERT INTO friend_requests(id,requester_guest_id,addressee_guest_id,status,created_at) VALUES(?,?,?,'pending',?)")
      .bind(crypto.randomUUID(), guestId, target.guest_id, Date.now()).run();
    return json({ ok: true, message: '好友申请已发送。' });
  }

  if (request.method === 'POST' && url.pathname === '/api/friends/respond') {
    let body: any;
    try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const guestId = String(body?.guestId ?? '');
    const requestId = String(body?.requestId ?? '');
    const accept = body?.accept === true;
    if (!GUEST_ID.test(guestId) || !GUEST_ID.test(requestId)) return json({ error: 'bad_request' }, 400);
    const requestRow = await db.prepare("SELECT requester_guest_id,addressee_guest_id FROM friend_requests WHERE id=? AND addressee_guest_id=? AND status='pending'")
      .bind(requestId, guestId).first<any>();
    if (!requestRow) return json({ error: 'request_not_found' }, 404);
    if (accept) {
      const [a, b] = requestRow.requester_guest_id < requestRow.addressee_guest_id
        ? [requestRow.requester_guest_id, requestRow.addressee_guest_id]
        : [requestRow.addressee_guest_id, requestRow.requester_guest_id];
      await db.prepare('INSERT OR IGNORE INTO friendships(guest_a,guest_b,created_at) VALUES(?,?,?)')
        .bind(a, b, Date.now()).run();
    }
    await db.prepare("UPDATE friend_requests SET status=?,responded_at=? WHERE id=? AND status='pending'")
      .bind(accept ? 'accepted' : 'rejected', Date.now(), requestId).run();
    return json({ ok: true });
  }

  if (url.pathname === '/api/dm' && request.method === 'GET') {
    const guestId = String(url.searchParams.get('guestId') ?? '');
    const friendCode = String(url.searchParams.get('friendCode') ?? '').trim().toUpperCase();
    if (!GUEST_ID.test(guestId) || !FRIEND_CODE.test(friendCode)) return json({ error: 'bad_request' }, 400);
    const friend = await db.prepare('SELECT guest_id FROM guest_profiles WHERE friend_code=?')
      .bind(friendCode).first<any>();
    if (!friend || !(await areFriends(db, guestId, friend.guest_id))) return json({ error: 'not_friends' }, 403);
    const rows = await db.prepare('SELECT id,sender_guest_id,message_type,body,room_code,created_at FROM direct_messages WHERE (sender_guest_id=? AND recipient_guest_id=?) OR (sender_guest_id=? AND recipient_guest_id=?) ORDER BY id DESC LIMIT 100')
      .bind(guestId, friend.guest_id, friend.guest_id, guestId).all<any>();
    return json({
      messages: rows.results.reverse().map((item: any) => ({
        id: item.id, mine: item.sender_guest_id === guestId, type: item.message_type,
        body: item.body, roomCode: item.room_code, createdAt: item.created_at,
      })),
    });
  }

  if (url.pathname === '/api/dm' && request.method === 'POST') {
    let body: any;
    try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const guestId = String(body?.guestId ?? '');
    const friendCode = String(body?.friendCode ?? '').trim().toUpperCase();
    const roomCode = String(body?.roomCode ?? '').trim().toUpperCase();
    const message = String(body?.text ?? '').trim().slice(0, 1000);
    if (!GUEST_ID.test(guestId) || !FRIEND_CODE.test(friendCode)) return json({ error: 'bad_request' }, 400);
    const friend = await db.prepare('SELECT guest_id FROM guest_profiles WHERE friend_code=?')
      .bind(friendCode).first<any>();
    if (!friend || !(await areFriends(db, guestId, friend.guest_id))) return json({ error: 'not_friends' }, 403);
    const invite = !!roomCode;
    if (invite && !/^[A-Z0-9]{4,12}$/.test(roomCode)) return json({ error: 'bad_room' }, 400);
    if (!message && !invite) return json({ error: 'empty_message' }, 400);
    const kind = invite ? 'invite' : 'text';
    const bodyText = invite ? '邀请你加入房间 ' + roomCode : message;
    await db.prepare('INSERT INTO direct_messages(sender_guest_id,recipient_guest_id,message_type,body,room_code,created_at) VALUES(?,?,?,?,?,?)')
      .bind(guestId, friend.guest_id, kind, bodyText, invite ? roomCode : null, Date.now()).run();
    return json({ ok: true });
  }

  if (request.method === 'GET' && url.pathname === '/api/history') {
    const guestId = String(url.searchParams.get('guestId') ?? '');
    if (!GUEST_ID.test(guestId)) return json({ error: 'bad_guest_id' }, 400);
    const rows = await db.prepare('SELECT h.room_code,h.nickname,h.role,h.started_at,h.ended_at,h.duration_seconds,h.opponent_nickname,p.friend_code AS opponent_friend_code FROM game_history h LEFT JOIN guest_profiles p ON p.guest_id=h.opponent_guest_id WHERE h.guest_id=? ORDER BY h.ended_at DESC LIMIT 30')
      .bind(guestId).all<any>();
    return json({
      history: rows.results.map((item: any) => ({
        room: item.room_code, nickname: item.nickname, role: item.role,
        startedAt: item.started_at, endedAt: item.ended_at,
        durationSeconds: item.duration_seconds,
        opponentNickname: item.opponent_nickname || '',
        opponentFriendCode: item.opponent_friend_code || '',
      })),
    });
  }

  return null;
}
