import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { areFriends, ensureFriendProfile, handleSocialApi } from '../src/social-api.ts';

function createD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE guest_profiles (
      guest_id TEXT PRIMARY KEY, friend_code TEXT UNIQUE NOT NULL, nickname TEXT NOT NULL,
      online_visible INTEGER NOT NULL DEFAULT 1, last_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE friendships (
      guest_a TEXT NOT NULL, guest_b TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (guest_a, guest_b)
    );
    CREATE TABLE friend_requests (
      id TEXT PRIMARY KEY, requester_guest_id TEXT NOT NULL, addressee_guest_id TEXT NOT NULL,
      status TEXT NOT NULL, created_at INTEGER NOT NULL, responded_at INTEGER
    );
    CREATE TABLE direct_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sender_guest_id TEXT NOT NULL,
      recipient_guest_id TEXT NOT NULL, message_type TEXT NOT NULL, body TEXT NOT NULL,
      room_code TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE game_history (
      guest_id TEXT NOT NULL, room_code TEXT NOT NULL, nickname TEXT NOT NULL,
      role TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
      duration_seconds INTEGER NOT NULL, opponent_nickname TEXT, opponent_guest_id TEXT
    );
  `);
  const prepare = sql => {
    const statement = sqlite.prepare(sql);
    return {
      bind(...values) {
        return {
          first: async () => statement.get(...values),
          all: async () => ({ results: statement.all(...values) }),
          run: async () => ({ meta: { changes: statement.run(...values).changes } }),
        };
      },
    };
  };
  return { prepare, raw: sqlite, close: () => sqlite.close() };
}

const request = (url, method = 'GET', body) => new Request('https://nightplay.test' + url, {
  method,
  headers: body ? { 'content-type': 'application/json' } : {},
  body: body ? JSON.stringify(body) : undefined,
});

test('guest profile initialization is idempotent and refreshes the nickname', async t => {
  const db = createD1();
  t.after(() => db.close());
  const id = '11111111-1111-4111-8111-111111111111';
  await ensureFriendProfile(db, id, '访客甲');
  const first = db.raw.prepare('SELECT friend_code,nickname FROM guest_profiles WHERE guest_id=?').get(id);
  assert.match(first.friend_code, /^[A-F0-9]{8}$/);
  assert.equal(first.nickname, '访客甲');

  await ensureFriendProfile(db, id, '访客乙');
  const second = db.raw.prepare('SELECT friend_code,nickname FROM guest_profiles WHERE guest_id=?').get(id);
  assert.equal(second.friend_code, first.friend_code);
  assert.equal(second.nickname, '访客乙');
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS count FROM guest_profiles').get().count, 1);
});

test('friend relationship lookup is symmetric', async t => {
  const db = createD1();
  t.after(() => db.close());
  db.raw.prepare('INSERT INTO friendships(guest_a,guest_b,created_at) VALUES(?,?,?)')
    .run('a', 'b', 1);
  assert.equal(await areFriends(db, 'a', 'b'), true);
  assert.equal(await areFriends(db, 'b', 'a'), true);
  assert.equal(await areFriends(db, 'a', 'c'), false);
});

test('social API initializes profiles and returns the same public friend-code contract', async t => {
  const db = createD1();
  t.after(() => db.close());
  const id = '22222222-2222-4222-8222-222222222222';
  const created = await handleSocialApi(request('/api/friends/presence', 'POST', {
    guestId: id, nickname: '夜间访客',
  }), db);
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), { ok: true });

  const response = await handleSocialApi(request('/api/friends?guestId=' + id), db);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.match(data.profile.friendCode, /^[A-F0-9]{8}$/);
  assert.equal(data.profile.nickname, '夜间访客');
  assert.deepEqual(data.friends, []);
  assert.deepEqual(data.incoming, []);
  assert.deepEqual(data.outgoing, []);
});

test('social API returns null for routes owned by the room runtime', async t => {
  const db = createD1();
  t.after(() => db.close());
  assert.equal(await handleSocialApi(request('/api/public-rooms'), db), null);
});
