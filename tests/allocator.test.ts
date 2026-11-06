import { describe, expect, it } from 'vitest';
import { allocate, type OptionIn, type PoolIn, type UnitIn } from '../src/core/allocator.ts';
import { certify, relaxedBound } from '../src/core/certify.ts';
import { rng } from '../src/core/hash.ts';

const solo = (pool: string): OptionIn => ({ slot: pool, demand: { [pool]: 1 } });

function instance(r: () => number) {
  const int = (n: number) => Math.floor(r() * n);
  const nP = 1 + int(5);
  const nU = 1 + int(9);
  const pools: PoolIn[] = Array.from({ length: nP }, (_, i) => ({ id: `q${i}`, cap: int(4) }));
  const units: UnitIn[] = Array.from({ length: nU }, (_, i) => {
    const ids = pools.map((p) => p.id).filter(() => r() < 0.5);
    if (ids.length === 0) ids.push(`q${int(nP)}`);
    return { id: `p${String(i).padStart(2, '0')}`, rank: i, options: ids.map(solo) };
  });
  return { pools, units };
}

function feasibleSets(pools: PoolIn[], units: UnitIn[]) {
  const cap = Object.fromEntries(pools.map((p) => [p.id, p.cap]));
  const can = (ids: number[]) => {
    const left = { ...cap };
    const go = (i: number): boolean => {
      if (i === ids.length) return true;
      for (const o of units[ids[i]].options) {
        const q = o.slot;
        if (left[q] > 0) {
          left[q]--;
          if (go(i + 1)) {
            left[q]++;
            return true;
          }
          left[q]++;
        }
      }
      return false;
    };
    return go(0);
  };
  const out: number[][] = [];
  for (let m = 0; m < 1 << units.length; m++) {
    const ids = units.map((_, i) => i).filter((i) => (m >> i) & 1);
    if (can(ids)) out.push(ids);
  }
  return out;
}

describe('priority allocator against brute force', () => {
  it('is optimal for single travellers on 3000 random instances', () => {
    const r = rng(7);
    let refused = 0;
    for (let t = 0; t < 3000; t++) {
      const { pools, units } = instance(r);
      const res = allocate(pools, units);
      const served = units.map((u, i) => (res.placed.has(u.id) ? i : -1)).filter((i) => i >= 0);
      const all = feasibleSets(pools, units);

      expect(served.length).toBe(Math.max(...all.map((f) => f.length)));
      for (const f of all) f.forEach((v, i) => expect(served[i]).toBeLessThanOrEqual(v));

      const cert = certify({ pools, units, placed: Object.fromEntries(res.placed), refused: res.refused });
      expect(cert.ok).toBe(true);
      expect(cert.gap).toBe(0);
      refused += res.refused.length;
    }
    expect(refused).toBeGreaterThan(1000);
  });

  it('never exceeds capacity with groups, and reports the gap honestly', () => {
    const r = rng(11);
    for (let t = 0; t < 1500; t++) {
      const int = (n: number) => Math.floor(r() * n);
      const pools: PoolIn[] = Array.from({ length: 2 + int(6) }, (_, i) => ({ id: `q${i}`, cap: 2 + int(10) }));
      const units: UnitIn[] = Array.from({ length: 8 + int(25) }, (_, i) => {
        const size = r() < 0.75 ? 1 : 2 + int(3);
        const ids = pools.map((p) => p.id).filter(() => r() < 0.5);
        if (ids.length === 0) ids.push('q0');
        return { id: `p${i}`, rank: i, options: ids.map((q) => ({ slot: q, demand: { [q]: size } })) };
      });
      const res = allocate(pools, units);
      const cert = certify({ pools, units, placed: Object.fromEntries(res.placed), refused: res.refused });
      expect(cert.checks.find((c) => c.id === 'capacity')!.ok).toBe(true);
      expect(cert.checks.find((c) => c.id === 'bound')!.ok).toBe(true);
      expect(cert.ok).toBe(true);
    }
  });

  it('moves a flexible passenger rather than refuse someone with one option', () => {
    const pools = [{ id: 'a', cap: 1 }, { id: 'b', cap: 1 }];
    const units: UnitIn[] = [
      { id: 'flexible', rank: 0, options: [solo('a'), solo('b')] },
      { id: 'onlyA', rank: 1, options: [solo('a')] },
    ];
    const res = allocate(pools, units);
    expect(res.refused).toEqual([]);
    expect(res.placed.get('onlyA')!.slot).toBe('a');
    expect(res.placed.get('flexible')!.slot).toBe('b');
  });

  it('keeps a locked commitment in place', () => {
    const pools = [{ id: 'a', cap: 1 }];
    const units: UnitIn[] = [
      { id: 'urgent', rank: 0, options: [solo('a')] },
      { id: 'hasPass', rank: 9, options: [solo('a')], locked: solo('a') },
    ];
    const res = allocate(pools, units);
    expect(res.placed.get('hasPass')!.slot).toBe('a');
    expect(res.refused[0].id).toBe('urgent');
  });

  it('reports a person no vehicle can reach', () => {
    const res = allocate([{ id: 'a', cap: 5 }], [{ id: 'x', rank: 0, options: [] }]);
    expect(res.refused[0].witness.kind).toBe('NO_OPTION');
  });
});

describe('the independent checker catches a dishonest solver', () => {
  const pools = [{ id: 'a', cap: 1 }];
  const units: UnitIn[] = [
    { id: 'p1', rank: 0, options: [solo('a')] },
    { id: 'p2', rank: 1, options: [solo('a')] },
  ];

  it('rejects over-allocation', () => {
    const cert = certify({ pools, units, placed: { p1: solo('a'), p2: solo('a') }, refused: [] });
    expect(cert.ok).toBe(false);
    expect(cert.checks.find((c) => c.id === 'capacity')!.ok).toBe(false);
  });

  it('rejects a person left without an outcome', () => {
    expect(certify({ pools, units, placed: { p1: solo('a') }, refused: [] }).ok).toBe(false);
  });

  it('rejects a junior passenger seated over a senior one', () => {
    const cert = certify({ pools, units, placed: { p2: solo('a') }, refused: [{ id: 'p1', witness: { kind: 'HALL', pools: ['a'] } }] });
    expect(cert.checks.find((c) => c.id === 'hall')!.ok).toBe(false);
  });

  it('rejects a refusal proof when a seat was actually free', () => {
    const two = [{ id: 'a', cap: 2 }];
    const cert = certify({ pools: two, units, placed: { p1: solo('a') }, refused: [{ id: 'p2', witness: { kind: 'HALL', pools: ['a'] } }] });
    expect(cert.checks.find((c) => c.id === 'hall')!.ok).toBe(false);
  });

  it('computes the upper bound with its own max-flow', () => {
    expect(relaxedBound([{ id: 'a', cap: 3 }, { id: 'b', cap: 1 }], [
      { id: 'x', rank: 0, options: [{ slot: 'a', demand: { a: 2 } }] },
      { id: 'y', rank: 1, options: [{ slot: 'a', demand: { a: 4 } }, { slot: 'b', demand: { b: 4 } }] },
    ])).toBe(4);
  });
});
