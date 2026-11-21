import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignMatchRoles,
  chooseMatchPartner,
  isMatchCompatible,
} from '../src/matchmaking-core.ts';

const entry = (overrides = {}) => ({
  client_id: 'client-a',
  gender: 'male',
  preference: 'any',
  role_preference: 'any',
  voice_preference: 'any',
  created_at: 1,
  ...overrides,
});

test('gender preferences must agree in both directions', () => {
  assert.equal(isMatchCompatible(entry({ gender: 'male', preference: 'female' }), entry({ gender: 'female', preference: 'male' })), true);
  assert.equal(isMatchCompatible(entry({ gender: 'male', preference: 'female' }), entry({ gender: 'other', preference: 'male' })), false);
  assert.equal(isMatchCompatible(entry({ preference: 'any' }), entry({ preference: 'male' })), true);
});

test('two fixed identical roles cannot match', () => {
  assert.equal(isMatchCompatible(entry({ role_preference: 'controller' }), entry({ role_preference: 'controller' })), false);
  assert.equal(isMatchCompatible(entry({ role_preference: 'receiver' }), entry({ role_preference: 'receiver' })), false);
});

test('any/any roles are assigned exactly one controller and one receiver', () => {
  assert.deepEqual(assignMatchRoles(entry(), entry({ client_id: 'client-b' })), {
    selfRole: 'controller',
    partnerRole: 'receiver',
  });
});

test('one fixed role forces the other participant into the opposite role', () => {
  assert.deepEqual(assignMatchRoles(entry(), entry({ role_preference: 'receiver' })), {
    selfRole: 'controller',
    partnerRole: 'receiver',
  });
  assert.deepEqual(assignMatchRoles(entry({ role_preference: 'controller' }), entry({ client_id: 'client-b' })), {
    selfRole: 'controller',
    partnerRole: 'receiver',
  });
});

test('fixed opposite roles are preserved', () => {
  assert.deepEqual(assignMatchRoles(entry({ role_preference: 'receiver' }), entry({ role_preference: 'controller' })), {
    selfRole: 'receiver',
    partnerRole: 'controller',
  });
});

test('voice preference is a ranking preference, not a hard rejection', () => {
  const self = entry({ voice_preference: 'both' });
  const exact = entry({ client_id: 'exact', voice_preference: 'both', created_at: 10 });
  const soft = entry({ client_id: 'soft', voice_preference: 'off', created_at: 1 });
  assert.equal(isMatchCompatible(self, soft), true);
  assert.equal(chooseMatchPartner(self, [soft, exact])?.client_id, 'exact');
});

test('candidate selection is deterministic for equal voice scores', () => {
  const self = entry();
  const later = entry({ client_id: 'b', created_at: 20 });
  const earlier = entry({ client_id: 'a', created_at: 10 });
  assert.equal(chooseMatchPartner(self, [later, earlier])?.client_id, 'a');
  assert.equal(chooseMatchPartner(self, [entry({ preference: 'female' })]), null);
});
