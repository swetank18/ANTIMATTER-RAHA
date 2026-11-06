import { sha256Hex } from './hash.ts';
import type { DeadlineKind, Policy, PolicyRule, Priority, Rider, ScorePart } from './types.ts';

const round1 = (n: number) => Math.round(n * 10) / 10;

export const POLICY_V1: Policy = {
  version: 1,
  name: 'Recovery baseline',
  note: 'When cabs are scarce, people who cannot wait safely go first. Waiting always raises priority, so nobody is left behind forever.',
  tiers: [
    { id: 'T0', label: 'Lost a confirmed cab', match: { displaced: true } },
    { id: 'T1', label: 'Cannot wait safely', match: { need: ['WHEELCHAIR'] } },
    { id: 'T2', label: 'Verified deadline under 90 minutes', match: { deadlineVerified: true, deadlineWithinMin: 90 } },
    { id: 'T3', label: 'Everyone else', match: {} },
  ],
  weights: {
    wheelchair: 30,
    assist: 15,
    deadline: { MEDICAL: 35, FLIGHT: 30, RAIL: 25, SHIFT: 15 },
    waitPerMin: 0.5,
    detourPerMin: 0.2,
    displaced: 20,
  },
  unverifiedDeadlineFactor: 0.5,
  deadlineHorizonMin: 120,
  commitWindowMin: 20,
};

export const POLICY_V2: Policy = {
  ...POLICY_V1,
  version: 2,
  name: 'Verified deadlines only',
  note: 'New instruction from control: unverified deadlines no longer count, and shift deadlines lose priority.',
  tiers: [
    { id: 'T0', label: 'Lost a confirmed cab', match: { displaced: true } },
    { id: 'T1', label: 'Cannot wait safely', match: { need: ['WHEELCHAIR', 'ASSIST'] } },
    { id: 'T2', label: 'Verified flight, rail or medical deadline', match: { deadlineVerified: true, deadlineKinds: ['FLIGHT', 'RAIL', 'MEDICAL'], deadlineWithinMin: 120 } },
    { id: 'T3', label: 'Everyone else', match: {} },
  ],
  weights: { ...POLICY_V1.weights, deadline: { MEDICAL: 40, FLIGHT: 30, RAIL: 25, SHIFT: 0 } },
  unverifiedDeadlineFactor: 0,
};

const DEADLINE_LABEL: Record<Exclude<DeadlineKind, 'NONE'>, string> = {
  MEDICAL: 'medical appointment',
  FLIGHT: 'flight',
  RAIL: 'train connection',
  SHIFT: 'work shift',
};

export function matches(rule: PolicyRule, p: Rider, now: number): boolean {
  if (rule.need && !rule.need.includes(p.need)) return false;
  if (rule.deadlineKinds && !rule.deadlineKinds.includes(p.deadlineKind)) return false;
  if (rule.deadlineVerified !== undefined && p.deadlineVerified !== rule.deadlineVerified) return false;
  if (rule.deadlineWithinMin !== undefined) {
    if (p.deadlineAt === null || p.deadlineAt - now > rule.deadlineWithinMin) return false;
  }
  if (rule.waitedAtLeastMin !== undefined && now - p.checkinAt < rule.waitedAtLeastMin) return false;
  if (rule.displaced !== undefined && p.displaced !== rule.displaced) return false;
  return true;
}

/** Every point shown to the rider is a part of the total, so the breakdown always adds up. */
export function prioritise(p: Rider, now: number, policy: Policy, seed: string): Priority {
  const parts: ScorePart[] = [];
  const w = policy.weights;

  if (p.need === 'WHEELCHAIR') {
    parts.push({ key: 'VULNERABILITY', label: 'Step-free access', points: w.wheelchair, detail: 'Wheelchair space needed' });
  } else if (p.need === 'ASSIST') {
    parts.push({ key: 'VULNERABILITY', label: 'Mobility support', points: w.assist, detail: 'Needs help boarding' });
  }

  if (p.deadlineKind !== 'NONE' && p.deadlineAt !== null) {
    const slack = p.deadlineAt - now;
    const urgency = Math.min(1, Math.max(0, 1 - slack / policy.deadlineHorizonMin));
    const factor = p.deadlineVerified ? 1 : policy.unverifiedDeadlineFactor;
    const points = round1(w.deadline[p.deadlineKind] * urgency * factor);
    if (points > 0) {
      parts.push({
        key: 'DEADLINE',
        label: 'Deadline',
        points,
        detail: `${DEADLINE_LABEL[p.deadlineKind]} in ${Math.max(0, Math.round(slack))} min${p.deadlineVerified ? '' : ', not yet verified'}`,
      });
    }
  }

  const waited = Math.max(0, now - p.checkinAt);
  const waitPoints = round1(waited * w.waitPerMin);
  if (waitPoints > 0) {
    parts.push({ key: 'WAIT', label: 'Time waited', points: waitPoints, detail: `Waiting ${Math.round(waited)} min` });
  }

  if (p.displaced) {
    parts.push({ key: 'DISPLACED', label: 'Cab fell through', points: w.displaced, detail: 'Your earlier cab fell through' });
  }

  const tierIndex = policy.tiers.findIndex((t) => matches(t.match, p, now));
  const tier = tierIndex < 0 ? policy.tiers.length : tierIndex;
  const def = policy.tiers[tier];
  return {
    tier,
    tierId: def?.id ?? 'T?',
    tierLabel: def?.label ?? 'Everyone else',
    score: round1(parts.reduce((s, x) => s + x.points, 0)),
    parts,
    lottery: sha256Hex(`${seed}|${p.pid}`).slice(0, 16),
  };
}

/**
 * Tier, then score, then a public lottery. The tie-break is a hash of a seed published in the
 * ledger, so ties do not reward whoever had the fastest phone and anyone can re-run the draw.
 */
export function compare(a: Priority, b: Priority): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.score !== b.score) return b.score - a.score;
  return a.lottery < b.lottery ? -1 : a.lottery > b.lottery ? 1 : 0;
}

export function validatePolicy(doc: unknown): { ok: true; policy: Omit<Policy, 'version'> } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const d = doc as Partial<Policy> | null;
  if (!d || typeof d !== 'object') return { ok: false, errors: ['Policy must be a JSON object'] };
  if (typeof d.name !== 'string' || !d.name.trim()) errors.push('name is required');
  if (!Array.isArray(d.tiers) || d.tiers.length === 0) errors.push('tiers must list at least one tier');
  const w = d.weights;
  if (!w || typeof w !== 'object') errors.push('weights are required');
  else {
    for (const k of ['wheelchair', 'assist', 'waitPerMin', 'detourPerMin', 'displaced'] as const) {
      if (typeof w[k] !== 'number' || !Number.isFinite(w[k]) || w[k] < 0) errors.push(`weights.${k} must be a non-negative number`);
    }
    if (typeof w.waitPerMin === 'number' && w.waitPerMin <= 0) errors.push('weights.waitPerMin must stay above zero or people could wait forever');
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, policy: d as Omit<Policy, 'version'> };
}
