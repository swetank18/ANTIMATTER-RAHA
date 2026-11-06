// Runs on the group lead's phone at the pickup spot, where crowds often kill the network. Two
// rules make that safe with no connection at all:
//   1. A pass names one ride, so a copied pass fails on any other ride, and a repeat scan is
//      caught by the local list of used pass ids.
//   2. Joining at the kerb spends an escrow grant: seats the hub has already set aside for this
//      phone and removed from its own pool. The phone cannot exceed its grant and the hub cannot
//      reuse those seats, so capacity holds through a partition without any coordination.

import { verifyPass, verifyToken } from './pass.ts';
import type { PassPayload } from './types.ts';

export interface EscrowGrant {
  v: 1;
  k: string;
  g: string;
  r: string;
  d: string;
  n: number;
}

export interface FieldOp {
  opId: string;
  kind: 'BOARD' | 'WALKUP';
  podId: string;
  passId?: string;
  pid?: string;
  grantId?: string;
  party: number;
  at: number;
}

export interface FieldSnapshot {
  deviceId: string;
  podId: string;
  publicKeys: Record<string, string>;
  grantToken: string | null;
  usedPassIds: string[];
  walkupsIssued: number;
  outbox: FieldOp[];
  opCounter: number;
}

export type ScanResult =
  | { ok: true; passId: string; pid: string; party: number; pool: 'S' | 'B'; message: string }
  | { ok: false; code: string; message: string };

const REASONS: Record<string, string> = {
  NOT_A_PASS: 'This is not a Koottu pass.',
  UNREADABLE: 'The pass could not be read. Ask the rider to refresh it.',
  UNKNOWN_KEY: 'This pass was signed by an unknown hub.',
  BAD_SIGNATURE: 'The signature is invalid. This pass has been altered or forged.',
};

export function newFieldSnapshot(deviceId: string, podId: string, publicKeys: Record<string, string>, grantToken: string | null): FieldSnapshot {
  return { deviceId, podId, publicKeys, grantToken, usedPassIds: [], walkupsIssued: 0, outbox: [], opCounter: 0 };
}

function nextOp(s: FieldSnapshot): string {
  s.opCounter += 1;
  return `${s.deviceId}:${s.podId}:${s.opCounter}`;
}

export function scan(s: FieldSnapshot, token: string, now: number): ScanResult {
  const v = verifyPass(token, s.publicKeys);
  if (!v.ok) return { ok: false, code: v.reason, message: REASONS[v.reason] ?? v.reason };
  const p: PassPayload = v.payload;
  if (p.r !== s.podId) return { ok: false, code: 'WRONG_RIDE', message: `This pass is for another ride (${p.r}).` };
  if (now < p.nb) return { ok: false, code: 'TOO_EARLY', message: 'This ride has not opened yet.' };
  if (now > p.ex) return { ok: false, code: 'EXPIRED', message: 'This pass has expired. Ask the rider to open the app again.' };
  if (s.usedPassIds.includes(p.id)) return { ok: false, code: 'ALREADY_USED', message: 'This pass has already boarded.' };
  s.usedPassIds.push(p.id);
  s.outbox.push({ opId: nextOp(s), kind: 'BOARD', podId: s.podId, passId: p.id, pid: p.p, party: p.n, at: now });
  return { ok: true, passId: p.id, pid: p.p, party: p.n, pool: p.u, message: `Valid pass. Board ${p.n} ${p.n === 1 ? 'person' : 'people'}.` };
}

export function grantOf(s: FieldSnapshot): EscrowGrant | null {
  if (!s.grantToken) return null;
  const v = verifyToken<EscrowGrant>(s.grantToken, s.publicKeys, 'OSG');
  return v.ok ? v.payload : null;
}

export function walkupsLeft(s: FieldSnapshot): number {
  const g = grantOf(s);
  return g && g.r === s.podId && g.d === s.deviceId ? Math.max(0, g.n - s.walkupsIssued) : 0;
}

export function walkup(s: FieldSnapshot, party: number, now: number): { ok: boolean; message: string; left: number } {
  const left = walkupsLeft(s);
  if (party < 1 || party > left) {
    return { ok: false, message: left === 0 ? 'No offline seats left on this ride.' : `Only ${left} offline ${left === 1 ? 'seat' : 'seats'} left.`, left };
  }
  s.walkupsIssued += party;
  s.outbox.push({ opId: nextOp(s), kind: 'WALKUP', podId: s.podId, grantId: grantOf(s)!.g, party, at: now });
  return { ok: true, message: `Added ${party} from this ride's offline allowance.`, left: left - party };
}
