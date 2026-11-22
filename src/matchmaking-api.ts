import {
  cancelMatchmaking,
  joinMatchmaking,
  pollMatchmaking,
} from './matchmaking-service.ts';

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  },
});

const GENDERS = new Set(['male', 'female', 'other']);
const PREFERENCES = new Set(['male', 'female', 'any']);
const ROLES = new Set(['controller', 'receiver', 'any']);
const VOICE = new Set(['any', 'off', 'both', 'self', 'peer']);
const CLIENT_ID = /^[0-9a-f-]{36}$/i;

function responseFor(status: Awaited<ReturnType<typeof joinMatchmaking>>) {
  if (status.status === 'matched') {
    return json({ state: 'matched', room: status.room, role: status.role });
  }
  if (status.status === 'waiting') return json({ state: 'waiting' });
  if (status.status === 'repair_failed') {
    return json({ state: 'repair_failed', message: '匹配房间正在恢复，请稍后重试。' }, 503);
  }
  return json({ state: 'missing', message: '匹配请求已失效，请重新开始。' }, 404);
}

/**
 * One HTTP contract for the full matchmaking lifecycle.
 * All queue writes live in matchmaking-service; this module only validates
 * requests, maps service states to HTTP responses, and triggers room alarms.
 */
export async function handleMatchmakingApi(
  request: Request,
  db: D1Database,
  onMatched: () => void = () => {},
): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return json({ error: 'origin_mismatch' }, 403);
  }

  let input: any;
  try {
    input = await request.json();
  } catch {
    return json({ error: 'bad_json' }, 400);
  }

  const action = String(input?.action ?? '');
  const clientId = typeof input?.clientId === 'string' && CLIENT_ID.test(input.clientId)
    ? input.clientId
    : '';
  if (!clientId || !['join', 'poll', 'cancel'].includes(action)) {
    return json({ error: 'bad_matchmaking_request' }, 400);
  }

  if (action === 'join') {
    const nickname = String(input.nickname ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
    const gender = String(input.gender ?? '');
    const preference = String(input.preference ?? '');
    const rolePreference = String(input.rolePreference ?? 'any');
    const voicePreference = String(input.voicePreference ?? 'any');

    if (!nickname || !GENDERS.has(gender) || !PREFERENCES.has(preference)
      || !ROLES.has(rolePreference) || !VOICE.has(voicePreference)) {
      return json({
        error: 'bad_matchmaking_preferences',
        message: '请检查昵称和匹配偏好设置。',
      }, 400);
    }

    try {
      const result = await joinMatchmaking(db, {
        clientId,
        nickname,
        gender,
        preference,
        rolePreference,
        voicePreference,
      }, Date.now());
      if (result.status === 'matched') onMatched();
      return responseFor(result);
    } catch {
      return json({
        state: 'error',
        error: 'matchmaking_unavailable',
        message: '匹配服务暂时不可用，请重试。',
      }, 503);
    }
  }

  try {
    if (action === 'cancel') {
      const result = await cancelMatchmaking(db, clientId, Date.now());
      if (result.status === 'matched') {
        onMatched();
        return responseFor(result);
      }
      if (result.status === 'repair_failed') {
        return responseFor(result);
      }
      return json({ state: 'cancelled' });
    }

    const result = await pollMatchmaking(db, clientId, Date.now());
    if (result.status === 'matched') onMatched();
    return responseFor(result);
  } catch {
    return json({
      state: 'error',
      error: 'matchmaking_unavailable',
      message: '匹配服务暂时不可用，请重试。',
    }, 503);
  }
}
