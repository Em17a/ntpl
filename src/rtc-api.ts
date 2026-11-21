const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  },
});

interface RtcEnv {
  NIGHTPLAY_TURN_URLS?: string;
  NIGHTPLAY_TURN_SHARED_SECRET?: string;
  NIGHTPLAY_TURN_TTL_SECONDS?: string;
}

export async function handleRtcConfig(
  request: Request,
  db: D1Database,
  env: RtcEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname !== '/api/rtc-config') return null;

  const room = String(url.searchParams.get('room') ?? '').trim().toUpperCase();
  const member = String(request.headers.get('authorization') ?? '').replace(/^Bearer\\s+/i, '').trim();
  if (!/^[A-Z0-9]{4,12}$/.test(room) || !/^[0-9a-f-]{36}$/i.test(member)) {
    return json({ error: 'bad_request' }, 400);
  }

  const found = await db.prepare('SELECT id FROM room_members WHERE id=? AND room_code=? AND left_at IS NULL')
    .bind(member, room).first();
  if (!found) return json({ error: 'not_a_room_member' }, 403);

  const iceServers: any[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  const urls = String(env.NIGHTPLAY_TURN_URLS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const secret = env.NIGHTPLAY_TURN_SHARED_SECRET ?? '';
  let turnEnabled = false;
  let expiresAt: number | null = null;

  if (urls.length && secret) {
    const requested = Number(env.NIGHTPLAY_TURN_TTL_SECONDS ?? 3600);
    const ttl = Math.min(86_400, Math.max(300, Number.isFinite(requested) ? requested : 3600));
    expiresAt = Math.floor(Date.now() / 1000) + ttl;
    const username = expiresAt + ':' + member;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username));
    const credential = btoa(String.fromCharCode(...new Uint8Array(signature)));
    iceServers.push({ urls, username, credential });
    turnEnabled = true;
  }

  return json({ iceServers, turnEnabled, expiresAt });
}
