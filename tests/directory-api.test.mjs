import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleDirectoryApi } from '../src/directory-api.ts';

function createD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE rooms (
      code TEXT PRIMARY KEY, room_name TEXT DEFAULT '', is_public INTEGER DEFAULT 0,
      owner_member_id TEXT, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE room_members (
      id TEXT PRIMARY KEY, room_code TEXT NOT NULL, nickname TEXT NOT NULL, role TEXT NOT NULL,
      joined_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, left_at INTEGER
    );
  `);
  const prepare = sql => {
    const statement = sqlite.prepare(sql);
    return { bind(...values) {
      return {
        first: async () => statement.get(...values),
        all: async () => ({ results: statement.all(...values) }),
        run: async () => ({ meta: { changes: statement.run(...values).changes } }),
      };
    } };
  };
  return { prepare, raw: sqlite, close: () => sqlite.close() };
}

function createStorage() {
  const values = new Map();
  return {
    async put(key, value) { values.set(key, value); },
    async get(key) { return values.get(key); },
    async list({ prefix }) {
      return new Map([...values].filter(([key]) => key.startsWith(prefix)));
    },
    async delete(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) values.delete(key);
    },
  };
}

const request = (url, method = 'GET', body) => new Request('https://nightplay.test' + url, {
  method,
  headers: body ? { 'content-type': 'application/json' } : {},
  body: body ? JSON.stringify(body) : undefined,
});

test('online heartbeat creates and counts active visitor leases', async () => {
  const db = createD1();
  const storage = createStorage();
  try {
    const id = '33333333-3333-4333-8333-333333333333';
    const response = await handleDirectoryApi(request('/api/online/heartbeat', 'POST', { visitorId: id }), db, storage, async () => [], async () => 0);
    const data = await response.json();
    assert.equal(data.online, 1);
    assert.ok(data.updatedAt > 0);
  } finally {
    db.close();
  }
});

test('room availability respects room expiry and returns current seat count', async () => {
  const db = createD1();
  const storage = createStorage();
  try {
    const now = Date.now();
    db.raw.prepare('INSERT INTO rooms(code,created_at,last_active_at,expires_at) VALUES(?,?,?,?)')
      .run('ABCD1234', now, now, now + 60_000);
    const response = await handleDirectoryApi(request('/api/rooms/ABCD1234'), db, storage,
      async () => [{ id: 'a' }], async () => 0);
    assert.deepEqual(await response.json(), { room: 'ABCD1234', seats: 2, taken: 1, full: false, expiresAt: now + 60_000 });
  } finally {
    db.close();
  }
});

test('watch directory only exposes rooms with two active consenting members', async () => {
  const db = createD1();
  const storage = createStorage();
  try {
    const now = Date.now();
    db.raw.prepare('INSERT INTO rooms(code,created_at,last_active_at,expires_at) VALUES(?,?,?,?)')
      .run('ROOM1234', now, now, now + 60_000);
    for (const [id, role] of [['one', 'controller'], ['two', 'receiver']]) {
      db.raw.prepare('INSERT INTO room_members(id,room_code,nickname,role,joined_at,last_seen_at) VALUES(?,?,?,?,?,?)')
        .run(id, 'ROOM1234', id, role, now, now);
    }
    await storage.put('watch-consent:ROOM1234', ['one', 'two']);
    const response = await handleDirectoryApi(request('/api/watchable'), db, storage, async () => [], async () => 3);
    assert.deepEqual(await response.json(), {
      rooms: [{ room: 'ROOM1234', players: [{ nickname: 'one', role: 'controller' }, { nickname: 'two', role: 'receiver' }], watchers: 3 }],
    });
  } finally {
    db.close();
  }
});

test('directory API declines unrelated routes', async () => {
  const db = createD1();
  try {
    assert.equal(await handleDirectoryApi(request('/api/history'), db, createStorage(), async () => [], async () => 0), null);
  } finally {
    db.close();
  }
});
