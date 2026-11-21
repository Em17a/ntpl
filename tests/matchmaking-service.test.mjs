import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { findOrCreateMatch } from '../src/matchmaking-service.ts';

function createD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE rooms (
      code TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE room_members (
      id TEXT PRIMARY KEY, room_code TEXT NOT NULL, nickname TEXT NOT NULL,
      role TEXT NOT NULL, joined_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      left_at INTEGER
    );
    CREATE TABLE matchmaking_queue (
      client_id TEXT PRIMARY KEY, nickname TEXT NOT NULL, gender TEXT NOT NULL,
      preference TEXT NOT NULL, role_preference TEXT NOT NULL DEFAULT 'any',
      voice_preference TEXT NOT NULL DEFAULT 'any', matched_role TEXT,
      status TEXT NOT NULL DEFAULT 'waiting', room_code TEXT,
      created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
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
          _run: () => statement.run(...values),
        };
      },
    };
  };
  return {
    prepare,
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => statement._run());
        sqlite.exec('COMMIT');
        return results.map(result => ({ meta: { changes: result.changes } }));
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    raw: sqlite,
    close: () => sqlite.close(),
  };
}

function queue(db, id, overrides = {}) {
  db.raw.prepare(`INSERT INTO matchmaking_queue
    (client_id,nickname,gender,preference,role_preference,voice_preference,status,created_at,last_seen_at)
    VALUES(?,?,?,?,?,?,'waiting',?,?)`).run(
    id, overrides.nickname ?? id.slice(0, 6),
    overrides.gender ?? 'male', overrides.preference ?? 'any',
    overrides.role ?? 'any', overrides.voice ?? 'any',
    overrides.createdAt ?? 1_000, overrides.lastSeenAt ?? 1_000,
  );
}

test('matching creates both room seats atomically and repeated polls are idempotent', async t => {
  const db = createD1();
  t.after(() => db.close());
  const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  queue(db, a, { gender: 'male', preference: 'female', role: 'controller' });
  queue(db, b, { gender: 'female', preference: 'male', role: 'receiver', createdAt: 2_000 });

  const scheduled = [];
  const found = await findOrCreateMatch(db, a, 3_000, async () => scheduled.push(true));
  assert.equal(found.status, 'matched');
  assert.match(found.room, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(found.role, 'controller');
  assert.equal(scheduled.length, 1);

  const rows = db.raw.prepare('SELECT client_id,status,room_code,matched_role FROM matchmaking_queue ORDER BY client_id').all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.status === 'matched' && row.room_code === found.room));
  assert.deepEqual(rows.map(row => row.matched_role).sort(), ['controller', 'receiver']);

  const seats = db.raw.prepare('SELECT id,role FROM room_members WHERE room_code=? ORDER BY role').all(found.room);
  assert.deepEqual(seats, [
    { id: a, role: 'controller' },
    { id: b, role: 'receiver' },
  ]);

  const repeated = await findOrCreateMatch(db, b, 4_000);
  assert.deepEqual(repeated, { status: 'matched', room: found.room, role: 'receiver' });
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS count FROM room_members WHERE room_code=?').get(found.room).count, 2);
});

test('a previously matched room with missing seats is repaired from its queue records', async t => {
  const db = createD1();
  t.after(() => db.close());
  const a = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const b = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const room = 'AB234567';
  db.raw.prepare('INSERT INTO rooms(code,created_at,last_active_at,expires_at) VALUES(?,?,?,?)').run(room, 1_000, 1_000, 7_201_000);
  for (const [id, nickname, role] of [[a, '甲', 'controller'], [b, '乙', 'receiver']]) {
    db.raw.prepare(`INSERT INTO matchmaking_queue
      (client_id,nickname,gender,preference,role_preference,voice_preference,matched_role,status,room_code,created_at,last_seen_at)
      VALUES(?,?, 'other','any','any','any',?,'matched',?,?,?)`).run(id, nickname, role, room, 1_000, 1_000);
  }

  const repaired = await findOrCreateMatch(db, a, 5_000);
  assert.deepEqual(repaired, { status: 'matched', room, role: 'controller' });
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS count FROM room_members WHERE room_code=? AND left_at IS NULL').get(room).count, 2);
});

test('incompatible candidates remain waiting and do not create a phantom room', async t => {
  const db = createD1();
  t.after(() => db.close());
  const a = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const b = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  queue(db, a, { gender: 'male', preference: 'female', role: 'controller' });
  queue(db, b, { gender: 'female', preference: 'female', role: 'receiver' });

  assert.deepEqual(await findOrCreateMatch(db, a, 3_000), { status: 'waiting' });
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS count FROM rooms').get().count, 0);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS count FROM room_members').get().count, 0);
});
