import test from 'node:test';
import assert from 'node:assert/strict';
import {
  containsContactInfo,
  inspectChatForContact,
  isContactMuted,
  normalizeContactText,
  recordContactViolation,
} from '../src/contact-protection.ts';

test('normalization handles full-width text, separators and spoken Chinese digits', () => {
  assert.equal(normalizeContactText('＋８６ 一三八 · 〇〇〇〇 · 幺二三四'), '+8613800001234');
});

test('contact detection catches phone numbers, email, social links and account patterns', () => {
  for (const value of [
    '我的手机号是13800138000',
    '请发到test@example.com',
    'https://t.me/example_user',
    '微信号abc_123',
    '加我vxabc123',
    'QQ号12345678',
    '一三八〇〇〇〇幺二三四',
  ]) assert.equal(containsContactInfo(value), true, value);
  assert.equal(containsContactInfo('今晚八点开始挑战，可以吗？'), false);
});

test('chat filter detects contact information split across adjacent messages for 12 seconds', () => {
  const state = {};
  assert.equal(inspectChatForContact(state, '我的微信是', 10_000), false);
  assert.equal(inspectChatForContact(state, 'wxabc123', 15_000), true);
  assert.equal(state.recentChatText, '');
  assert.equal(inspectChatForContact(state, '普通聊天内容', 30_000), false);
});

test('violations escalate from warning to one-minute and ten-minute restrictions', () => {
  const state = {};
  const first = recordContactViolation(state, 'text', 100_000);
  assert.equal(first.count, 1);
  assert.equal(first.mutedUntil, 0);
  assert.equal(isContactMuted(state, 100_001), false);

  const second = recordContactViolation(state, 'voice', 110_000);
  assert.equal(second.count, 2);
  assert.equal(second.mutedUntil, 170_000);
  assert.equal(isContactMuted(state, 169_999), true);
  assert.equal(isContactMuted(state, 170_000), false);

  const third = recordContactViolation(state, 'text', 180_000);
  assert.equal(third.count, 3);
  assert.equal(third.mutedUntil, 780_000);
  assert.equal(isContactMuted(state, 779_999), true);
});
