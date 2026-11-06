// C02. Records are compared by when they were observed, never by when they arrived, so a stale
// record that lands last cannot win. Unsafe claims get extra weight: if a credible source says a
// route is suspended, the system will not call it open until someone checks.

import type { Belief, RouteRecord } from './types.ts';

export interface SourceSpec {
  id: string;
  label: string;
  rank: number;
  ttlMin: number;
  halfLifeMin: number;
}

export const SOURCES: SourceSpec[] = [
  { id: 'VERIFIED', label: 'Verified by a person', rank: 5.0, ttlMin: 60, halfLifeMin: 45 },
  { id: 'FIELD_MARSHAL', label: 'Field marshal on site', rank: 1.0, ttlMin: 30, halfLifeMin: 15 },
  { id: 'CONTROL_ROOM', label: 'Control room', rank: 1.0, ttlMin: 30, halfLifeMin: 15 },
  { id: 'OPERATOR_FEED', label: 'Operator status feed', rank: 0.7, ttlMin: 20, halfLifeMin: 10 },
  { id: 'CROWD', label: 'Passenger reports', rank: 0.3, ttlMin: 15, halfLifeMin: 6 },
];

const MARGIN = 1.5;
const UNSAFE = new Set(['SUSPENDED', 'CLOSED']);
const FUTURE_SKEW_MIN = 2;

export function resolveRoute(route: string, records: RouteRecord[], now: number, sources: SourceSpec[] = SOURCES): Belief {
  const spec = new Map(sources.map((s) => [s.id, s]));
  const considered: Belief['considered'] = [];
  const latest = new Map<string, RouteRecord>();

  for (const r of records.filter((x) => x.route === route)) {
    const s = spec.get(r.source);
    const age = now - r.observedAt;
    if (!s) {
      considered.push({ source: r.source, value: r.value, ageMin: age, weight: 0, used: false, note: 'Unknown source, not trusted' });
    } else if (age < -FUTURE_SKEW_MIN) {
      considered.push({ source: s.label, value: r.value, ageMin: age, weight: 0, used: false, note: 'Timestamp is in the future' });
    } else if (age > s.ttlMin) {
      considered.push({ source: s.label, value: r.value, ageMin: age, weight: 0, used: false, note: `Stale: older than ${s.ttlMin} min` });
    } else {
      const prior = latest.get(r.source);
      if (!prior || r.observedAt > prior.observedAt) {
        if (prior) considered.push({ source: s.label, value: prior.value, ageMin: now - prior.observedAt, weight: 0, used: false, note: 'Superseded by a newer observation from this source' });
        latest.set(r.source, r);
      } else {
        considered.push({ source: s.label, value: r.value, ageMin: age, weight: 0, used: false, note: 'Superseded by a newer observation from this source' });
      }
    }
  }

  const votes = new Map<string, number>();
  for (const r of latest.values()) {
    const s = spec.get(r.source)!;
    const age = Math.max(0, now - r.observedAt);
    const weight = s.rank * 0.5 ** (age / s.halfLifeMin);
    votes.set(r.value, (votes.get(r.value) ?? 0) + weight);
    considered.push({ source: s.label, value: r.value, ageMin: age, weight: Math.round(weight * 100) / 100, used: true, note: 'Fresh enough to count' });
  }

  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const safe = 'SUSPENDED';

  if (ranked.length === 0) {
    return {
      route, state: 'UNKNOWN', value: null, safeValue: safe, considered,
      because: 'No record is fresh enough to rely on.',
      stillUncertain: 'The current state of this route. Treated as not usable until someone confirms it.',
    };
  }

  const [top, topWeight] = ranked[0];
  if (ranked.length === 1) {
    return {
      route, state: 'TRUSTED', value: top, safeValue: top, considered,
      because: `Every fresh source agrees on ${top}.`,
      stillUncertain: 'Nothing.',
    };
  }

  const [second, secondWeight] = ranked[1];
  const unsafeRunnerUp = UNSAFE.has(second) && !UNSAFE.has(top);
  const needed = unsafeRunnerUp ? MARGIN * 2 : MARGIN;
  if (topWeight >= needed * secondWeight) {
    return {
      route, state: 'TRUSTED', value: top, safeValue: top, considered,
      because: `${top} outweighs ${second} (${topWeight.toFixed(2)} against ${secondWeight.toFixed(2)}) by source rank and freshness.`,
      stillUncertain: `A lower-weighted source still reports ${second}.`,
    };
  }
  return {
    route, state: 'UNRESOLVED', value: null, safeValue: safe, considered,
    because: `Fresh sources disagree: ${top} (${topWeight.toFixed(2)}) against ${second} (${secondWeight.toFixed(2)}). Neither is strong enough to win.`,
    stillUncertain: 'Whether this route is usable. It stays closed for planning until a person verifies it.',
  };
}

/** What a naive feed consumer would do. Kept to show the difference, never used for decisions. */
export function naiveNewestArrival(route: string, records: RouteRecord[]): string | null {
  const list = records.filter((r) => r.route === route).sort((a, b) => a.receivedAt - b.receivedAt);
  return list.at(-1)?.value ?? null;
}
