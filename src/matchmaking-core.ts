export type MatchRole = 'controller' | 'receiver';

export interface MatchCandidate {
  client_id: string;
  gender: string;
  preference: string;
  role_preference: string;
  voice_preference?: string;
  created_at: number | string;
}

export function isMatchCompatible(a: MatchCandidate, b: MatchCandidate): boolean {
  const genderOk = (a.preference === 'any' || a.preference === b.gender)
    && (b.preference === 'any' || b.preference === a.gender);
  const roleOk = a.role_preference === 'any'
    || b.role_preference === 'any'
    || a.role_preference !== b.role_preference;
  return genderOk && roleOk;
}

export function voiceMatchScore(a: MatchCandidate, b: MatchCandidate): number {
  const av = a.voice_preference || 'any';
  const bv = b.voice_preference || 'any';
  if (av === 'any' || bv === 'any') return 1;
  if ((av === 'off' && bv === 'off')
    || (av === 'both' && bv === 'both')
    || (av === 'self' && bv === 'peer')
    || (av === 'peer' && bv === 'self')) return 2;
  return 0;
}

export function chooseMatchPartner(
  self: MatchCandidate,
  candidates: MatchCandidate[],
): MatchCandidate | null {
  const compatible = candidates
    .filter((candidate) => isMatchCompatible(self, candidate))
    .sort((a, b) =>
      voiceMatchScore(self, b) - voiceMatchScore(self, a)
      || Number(a.created_at) - Number(b.created_at)
      || String(a.client_id).localeCompare(String(b.client_id)));
  return compatible[0] ?? null;
}

export function assignMatchRoles(
  self: MatchCandidate,
  partner: MatchCandidate,
): { selfRole: MatchRole; partnerRole: MatchRole } {
  const a = self.role_preference;
  const b = partner.role_preference;
  if (a === 'any' && b === 'any') return { selfRole: 'controller', partnerRole: 'receiver' };
  if (a === 'any' && (b === 'controller' || b === 'receiver')) {
    return { selfRole: b === 'controller' ? 'receiver' : 'controller', partnerRole: b };
  }
  if (b === 'any' && (a === 'controller' || a === 'receiver')) {
    return { selfRole: a, partnerRole: a === 'controller' ? 'receiver' : 'controller' };
  }
  if ((a === 'controller' || a === 'receiver')
    && (b === 'controller' || b === 'receiver') && a !== b) {
    return { selfRole: a, partnerRole: b };
  }
  throw new Error('Cannot assign distinct roles to an incompatible pair');
}
