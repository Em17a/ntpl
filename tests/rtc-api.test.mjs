import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleRtcConfig } from '../src/rtc-api.ts';

function createD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE room_members (id TEXT, room_code TEXT, left_at INTEGER)');
  const prepare = sql => {
    const statement = sqlite.prepare(sql);
    return { bind(...values) {
      return { first: async () => statement.get(...values) };
    } };
  };
  return { prepare, raw: sqlite, close: () => sqlite.close() };
}

test('RTC config rejects malformed room/member credentials', async t => {
  const db = createD1();
  t.after(() => db.close());
  const request = new Request('https://nightplay.test/api/rtc-config?room=bad', { method: 'GET' });
  const response = await handleRtcConfig(request, db, {});
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'bad_request' });
});

test('RTC config is available only to an active room member', async t => {
  const db = createD1();
  t.after(() => db.close());
  const id = '44444444-4444-4444-8444-444444444444';
  const request = new Request('https://nightplay.test/api/rtc-config?room=ROOM1234', {
    headers: { authorization: 'Bearer ' + id },
  });
  const denied = await handleRtcConfig(request, db, {});
  assert.equal(denied.status, 403);
  db.raw.prepare('INSERT INTO room_members(id,room_code,left_at) VALUES(?,?,NULL)').run(id, 'ROOM1234');
  const allowed = await handleRtcConfig(request, db, {});
  assert.equal(allowed.status, 200);
  const data = await allowed.json();
  assert.equal(data.turnEnabled, false);
  assert.equal(data.iceServers[0].urls, 'stun:stun.l.google.com:19302');
});
