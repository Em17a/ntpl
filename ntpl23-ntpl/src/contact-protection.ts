export type ContactSource = 'text' | 'voice';

export interface ContactModerationState {
  contactViolations?: number;
  contactMutedUntil?: number;
  recentChatText?: string;
  recentChatAt?: number;
}

export function normalizeContactText(value: string): string {
  const raw = String(value ?? '').toLowerCase().normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
  const compact = raw.replace(/[\s·•,，。:：;；_\-—()（）[\]【】]/g, '');
  const digits: Record<string, string> = {
    零: '0', 〇: '0', 洞: '0', 幺: '1', 两: '2',
    一: '1', 二: '2', 三: '3', 四: '4', 五: '5',
    六: '6', 七: '7', 八: '8', 九: '9',
  };
  return compact.replace(/[零〇洞幺两一二三四五六七八九]/g, char => digits[char] ?? char);
}

export function containsContactInfo(value: string): boolean {
  const text = normalizeContactText(value);
  if (!text) return false;
  const phone = /(?:\+?86)?1[3-9]\d{9}/.test(text);
  const email = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text);
  const socialUrl = /(?:https?\/{1,2}|www\.)|(?:t\.me|telegram\.me|wa\.me|instagram\.com|facebook\.com|line\.me|discord\.gg|discord\.com)/i.test(text);
  const accountLike = /(?:微信|wechat|vx|wx|v信|w信|微x|薇信|威信|qq|扣扣|企鹅号|telegram|电报|飞机号|whatsapp|wats?app|line|instagram|ins号|discord|邮箱|电子邮件)(?:(?:号|id|账号|帐号)?(?:是|为)?|:|：)?[a-z0-9_@.-]{3,}/i.test(text);
  const longNumber = /\d{6,13}/.test(text) && /(?:qq|扣扣|联系|加我|电话|手机|号码|号|vx|wx|微信|v信|w信)/i.test(text);
  const shorthand = /(?:加我|私我|联系我)(?:v|vx|wx)[a-z0-9_-]{3,}/i.test(text);
  return phone || email || socialUrl || accountLike || longNumber || shorthand;
}

/** Keeps only a short in-memory fragment to catch contact details split across messages. */
export function inspectChatForContact(
  state: ContactModerationState,
  message: string,
  timestamp: number,
): boolean {
  const previous = timestamp - Number(state.recentChatAt ?? 0) <= 12_000
    ? String(state.recentChatText ?? '')
    : '';
  if (containsContactInfo(message) || containsContactInfo(previous + message)) {
    state.recentChatText = '';
    state.recentChatAt = 0;
    return true;
  }
  state.recentChatText = message.slice(-120);
  state.recentChatAt = timestamp;
  return false;
}

export function recordContactViolation(
  state: ContactModerationState,
  source: ContactSource,
  timestamp: number,
) {
  const count = Number(state.contactViolations ?? 0) + 1;
  const mutedForMs = count >= 3 ? 10 * 60_000 : count === 2 ? 60_000 : 0;
  state.contactViolations = count;
  if (mutedForMs) state.contactMutedUntil = timestamp + mutedForMs;
  return {
    type: 'contact_blocked',
    source,
    count,
    mutedUntil: mutedForMs ? timestamp + mutedForMs : 0,
    message: mutedForMs
      ? `检测到交换站外联系方式，已暂停发送${source === 'voice' ? '语音' : '消息'}${count >= 3 ? '10分钟' : '1分钟'}。`
      : '检测到疑似站外联系方式，内容已拦截，请勿交换微信、QQ、手机号、邮箱或其他社交账号。',
  };
}

export function isContactMuted(state: ContactModerationState, timestamp: number): boolean {
  return Number(state.contactMutedUntil ?? 0) > timestamp;
}
