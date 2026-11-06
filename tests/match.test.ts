import { describe, expect, it } from 'vitest';
import { advise, bestRoute, checkFare, fareFor, KM_PER_MIN, roundShares, shapley, type FareRule, type FareSample, type Travel } from '../src/core/fare.ts';
import { rng } from '../src/core/hash.ts';
import { evaluate, formPods, MAX_SEATS, shareable, type MatchContext, type MatchRider } from '../src/core/match.ts';
import { chooseBid, parseOnSearch, type DriverBid } from '../src/core/bids.ts';
import { resolveQuotes, type Quote } from '../src/core/quotes.ts';
import { pairedGap } from '../src/core/stats.ts';
import { backtest, forecast, type SurgeSample } from '../src/core/surge.ts';

const line: Record<string, number> = { A: 0, B: 10, C: 20, D: 30, E: 40 };
const travel: Travel = (a, b) => Math.abs(line[a] - line[b]);
const ctx: MatchContext = { travel, surge: () => 2, seats: MAX_SEATS };

const rider = (id: string, o: Partial<MatchRider> = {}): MatchRider => {
  const dest = o.dest ?? 'C';
  return {
    id, spot: 'S', node: 'A', circle: 'X', dest, party: 1, need: 'NONE', shareWith: 'ANYONE', readyAt: 0, maxWaitMin: 15, maxDetourMin: 15,
    soloFare: fareFor((line[dest] ?? 20) * KM_PER_MIN, 2), rank: 0, ...o,
  };
};

describe('the surge arithmetic', () => {
  it('four people to one place at the cap pay half the normal fare', () => {
    const group = ['a', 'b', 'c', 'd'].map((id) => rider(id, { dest: 'C' }));
    const plan = evaluate(group, ctx)!;
    const normalSolo = fareFor(20 * KM_PER_MIN, 1);
    expect(plan.fare).toBe(fareFor(20 * KM_PER_MIN, 2));
    expect(Object.values(plan.shares).every((s) => Math.abs(s - normalSolo / 2) <= 1)).toBe(true);
  });
});

describe('Shapley split', () => {
  it('matches the published two-rider example', () => {
    // Alone: 10 and 15. Together: 20. Shapley gives 7.5 and 12.5.
    const cost = (m: number) => (m === 1 ? 10 : m === 2 ? 15 : 20);
    expect(shapley(2, cost)).toEqual([7.5, 12.5]);
  });

  it('charges identical riders the same and the long-distance rider more', () => {
    const plan = evaluate([rider('near', { dest: 'B', maxDetourMin: 30 }), rider('far', { dest: 'D', maxDetourMin: 30 })], ctx)!;
    expect(plan.shares.far).toBeGreaterThan(plan.shares.near);
    const twins = evaluate([rider('x'), rider('y')], ctx)!;
    expect(Math.abs(twins.shares.x - twins.shares.y)).toBeLessThanOrEqual(1);
  });

  it('holds its guarantees across 5000 random groups', () => {
    const r = rng(5);
    const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
    let priced = 0;
    for (let t = 0; t < 5000; t++) {
      const n = 2 + Math.floor(r() * 3);
      const group = Array.from({ length: n }, (_, i) => rider(`r${i}`, { dest: pick(['B', 'C', 'D', 'E']), maxDetourMin: 60 }));
      const plan = evaluate(group, ctx);
      if (!plan) continue;
      priced++;
      const shares = Object.values(plan.shares);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(plan.fare);
      for (const g of group) expect(plan.shares[g.id]).toBeLessThan(g.soloFare);
    }
    expect(priced).toBeGreaterThan(3000);
  });

  it('rounds to whole rupees that add up exactly', () => {
    const r = rng(9);
    for (let t = 0; t < 2000; t++) {
      const v = Array.from({ length: 1 + Math.floor(r() * 5) }, () => r() * 300);
      const total = 50 + Math.floor(r() * 900);
      const out = roundShares(v, total);
      expect(out.reduce((a, b) => a + b, 0)).toBe(total);
      out.forEach((x) => expect(Number.isInteger(x)).toBe(true));
    }
  });

  it('a party pays for each of its people', () => {
    const plan = evaluate([rider('solo'), rider('trio', { party: 3 })], ctx)!;
    expect(plan.shares.trio).toBeGreaterThan(plan.shares.solo * 2);
  });
});

describe('who can share', () => {
  it('never crosses a circle', () => expect(shareable(rider('a'), rider('b', { circle: 'Y' }))).toBe(false));
  it('never crosses a pickup spot', () => expect(shareable(rider('a'), rider('b', { spot: 'T' }))).toBe(false));
  it('keeps women-only riders apart from others', () => {
    expect(shareable(rider('a', { shareWith: 'WOMEN_ONLY' }), rider('b'))).toBe(false);
    expect(shareable(rider('a', { shareWith: 'WOMEN_ONLY' }), rider('b', { shareWith: 'WOMEN_ONLY' }))).toBe(true);
  });
  it('never groups someone whose preference is unconfirmed', () => expect(shareable(rider('a', { shareWith: null }), rider('b'))).toBe(false));
  it('respects the time window', () => {
    expect(shareable(rider('a', { readyAt: 0, maxWaitMin: 5 }), rider('b', { readyAt: 20 }))).toBe(false);
  });
  it('refuses a detour beyond what someone agreed to', () => {
    expect(evaluate([rider('a', { dest: 'B', maxDetourMin: 0 }), rider('b', { dest: 'E' })], { ...ctx, travel: (a, b) => (a === 'A' && b === 'E' ? 10 : travel(a, b)) })).toBeNull();
  });
  it('refuses more people than seats', () => expect(evaluate([rider('a', { party: 3 }), rider('b', { party: 2 })], ctx)).toBeNull());
});

function bruteBest(riders: MatchRider[]): number {
  const n = riders.length;
  const memo = new Map<number, number>();
  const value = new Map<number, number>();
  for (let m = 1; m < 1 << n; m++) {
    const g = riders.filter((_, i) => m & (1 << i));
    const pairwise = g.every((a, i) => g.every((b, j) => i >= j || shareable(a, b)));
    const plan = pairwise ? evaluate(g, ctx) : null;
    if (plan) value.set(m, g.reduce((s, r) => s + r.soloFare, 0) - plan.fare);
  }
  const go = (left: number): number => {
    if (left === 0) return 0;
    if (memo.has(left)) return memo.get(left)!;
    const low = left & -left;
    let best = -Infinity;
    for (let sub = left; sub; sub = (sub - 1) & left) {
      if (!(sub & low) || !value.has(sub)) continue;
      best = Math.max(best, value.get(sub)! + go(left ^ sub));
    }
    memo.set(left, best);
    return best;
  };
  return go((1 << n) - 1);
}

describe('group formation against brute force', () => {
  it('stays valid and captures most of the best possible saving', () => {
    const r = rng(21);
    const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
    let got = 0;
    let best = 0;
    let exact = 0;
    const runs = 400;
    for (let t = 0; t < runs; t++) {
      const riders = Array.from({ length: 4 + Math.floor(r() * 5) }, (_, i) =>
        rider(`r${i}`, { rank: i, dest: pick(['B', 'C', 'D', 'E']), shareWith: r() < 0.25 ? 'WOMEN_ONLY' : 'ANYONE', maxDetourMin: pick([5, 15, 30]), readyAt: Math.floor(r() * 12), party: r() < 0.2 ? 2 : 1 }));
      const { pods } = formPods(riders, ctx);
      const seen = pods.flatMap((p) => p.riders);
      expect(new Set(seen).size).toBe(riders.length);
      const saved = pods.reduce((s, p) => s + p.riders.reduce((x, id) => x + riders.find((q) => q.id === id)!.soloFare, 0) - p.fare, 0);
      const top = bruteBest(riders);
      expect(saved).toBeLessThanOrEqual(top);
      got += saved;
      best += top;
      if (saved === top) exact++;
    }
    console.log(`greedy kept ${((100 * got) / best).toFixed(1)}% of the best saving, exactly optimal on ${exact}/${runs}`);
    expect(got / best).toBeGreaterThan(0.8);
  }, 120000);

  it('gives the most senior rider first choice of partners', () => {
    const { pods } = formPods([rider('junior', { rank: 5 }), rider('senior', { rank: 0 }), rider('other', { rank: 3, dest: 'C' })], ctx);
    expect(pods[0].riders[0]).toBe('senior');
  });
});

describe('routes', () => {
  it('finds the shortest stop order', () => {
    expect(bestRoute('A', ['D', 'B', 'C'], travel)!.stops).toEqual(['B', 'C', 'D']);
    expect(bestRoute('A', ['B', 'B'], travel)!.stops).toEqual(['B']);
  });
  it('reports an unreachable stop', () => expect(bestRoute('A', ['Z'], () => null)).toBeNull());
});

describe('fare checks', () => {
  const rule: FareRule = { vehicle: 'MINI', baseFare: 50, perKm: 18, capMultiplier: 2, floorMultiplier: 0.5, verified: true, source: 'Test' };

  it('flags a quote above the cap', () => {
    expect(checkFare(1000, 10, rule)).toMatchObject({ status: 'OVER_CAP', maxLegal: 460 });
    expect(checkFare(400, 10, rule).status).toBe('WITHIN_CAP');
  });

  it('refuses to judge without a verified base fare', () => {
    expect(checkFare(1000, 10, null).status).toBe('NO_VERIFIED_BASE_FARE');
    expect(checkFare(1000, 10, { ...rule, verified: false }).status).toBe('NO_VERIFIED_BASE_FARE');
  });

  const sample = (spot: string, app: string, amount: number, at: number): FareSample => ({ spot, app, amount, km: 10, at });
  const base = { spot: 'S', app: 'Uber', amount: 500, km: 10, now: 100, nearby: [{ spot: 'T', name: 'Gate 2', walkMin: 6 }], shareRs: null };

  it('suggests nothing when there are too few real quotes', () => {
    expect(advise({ ...base, samples: [sample('T', 'Uber', 200, 99)] })).toEqual([]);
  });

  it('suggests walking, waiting and switching only from real quotes', () => {
    const samples = [
      ...[99, 98, 97].map((t) => sample('T', 'Uber', 300, t)),
      ...[99, 98, 97].map((t) => sample('S', 'Ola', 350, t)),
      ...[60, 55, 50].map((t) => sample('S', 'Uber', 250, t)),
    ];
    const moves = advise({ ...base, samples, shareRs: 150 }).map((a) => a.move);
    expect(moves).toEqual(['SHARE', 'WAIT', 'WALK', 'SWITCH']);
  });
});

describe('four phones, four quotes', () => {
  const q = (pid: string, app: string, amount: number, observedAt = 100, device: string | null = 'Android'): Quote => ({ pid, app, amount, device, observedAt });

  it('picks the cheapest fresh quote', () => {
    const r = resolveQuotes([q('a', 'Uber', 420), q('b', 'Ola', 390), q('c', 'Uber', 410)], 100);
    expect(r.best).toMatchObject({ pid: 'b', amount: 390 });
  });

  it('drops a stale quote even if it is cheapest', () => {
    const r = resolveQuotes([q('a', 'Uber', 100, 80), q('b', 'Uber', 400)], 100);
    expect(r.best!.pid).toBe('b');
    expect(r.rejected[0].why).toMatch(/Older/);
  });

  it('records a gap between phones without accusing anyone', () => {
    const r = resolveQuotes([q('a', 'Uber', 400, 100, 'iPhone'), q('b', 'Uber', 340, 100, 'Android')], 100);
    expect(r.gaps[0]).toMatchObject({ app: 'Uber', low: 340, high: 400, pct: 18 });
  });

  it('treats an absurdly low quote as a typing mistake', () => {
    const r = resolveQuotes([q('a', 'Uber', 40), q('b', 'Uber', 400), q('c', 'Ola', 410)], 100);
    expect(r.best!.amount).toBe(400);
    expect(r.needsRecheck).toBe(true);
  });

  it('uses each rider\'s newest quote', () => {
    const r = resolveQuotes([q('a', 'Uber', 500, 97), q('a', 'Uber', 450, 99)], 100);
    expect(r.best!.amount).toBe(450);
  });

  it('asks for a quote when there are none', () => {
    expect(resolveQuotes([], 100)).toMatchObject({ best: null, needsRecheck: true });
  });
});

describe('driver bids', () => {
  const bid = (o: Partial<DriverBid>): DriverBid => ({ id: 'b', driver: 'D', vehicle: 'CAB', seats: 4, amount: 300, etaMin: 6, rating: 4.6, ...o });

  it('takes the lowest bid that can really carry the group', () => {
    const r = chooseBid([bid({ id: 'cheap-small', amount: 100, seats: 3 }), bid({ id: 'low-rated', amount: 120, rating: 3.2 }), bid({ id: 'far', amount: 130, etaMin: 45 }), bid({ id: 'good', amount: 280 }), bid({ id: 'dear', amount: 340 })], 4);
    expect(r.best!.id).toBe('good');
    expect(r.rejected.length).toBe(3);
  });

  it('says so when nobody can take the group', () => expect(chooseBid([bid({ seats: 2 })], 4).best).toBeNull());

  it('drops malformed bids instead of guessing', () => {
    const raw = { message: { catalog: { providers: [
      { rating: 4.5, descriptor: { name: 'Good' }, items: [{ id: 'a', price: { value: '280' }, fulfillment: { etaMinutes: 5, vehicle: { capacity: 4, category: 'AUTO' } } }] },
      { rating: 4.5, items: [{ id: 'b', price: { value: 'free' }, fulfillment: { etaMinutes: 5, vehicle: { capacity: 4 } } }] },
      { rating: 'great', items: [{ id: 'c' }] },
    ] } } };
    expect(parseOnSearch(raw).map((b) => b.id)).toEqual(['a']);
    for (const g of [null, 1, {}, { message: {} }, { message: { catalog: { providers: 'x' } } }]) expect(parseOnSearch(g)).toEqual([]);
  });
});

describe('price gap statistics', () => {
  it('refuses to conclude from too little data', () => {
    expect(pairedGap([[400, 380], [410, 395]]).verdict).toBe('NOT_ENOUGH_DATA');
  });

  it('finds a consistent gap and gives an interval', () => {
    const r = rng(3);
    const pairs = Array.from({ length: 40 }, (): [number, number] => { const base = 300 + r() * 200; return [base + 20 + (r() - 0.5) * 8, base]; });
    const g = pairedGap(pairs, 1, ['iPhone', 'Android']);
    expect(g.verdict).toBe('CONSISTENT_GAP');
    expect(g.ci95![0]).toBeGreaterThan(0);
    expect(g.meanGap).toBeGreaterThan(15);
  });

  it('does not invent a gap in random noise', () => {
    let falseAlarms = 0;
    for (let s = 1; s <= 200; s++) {
      const r = rng(s);
      const pairs = Array.from({ length: 30 }, (): [number, number] => { const base = 400; return [base + (r() - 0.5) * 60, base + (r() - 0.5) * 60]; });
      if (pairedGap(pairs, s).verdict === 'CONSISTENT_GAP') falseAlarms++;
    }
    expect(falseAlarms).toBeLessThan(25);
  });
});

describe('surge forecast', () => {
  const { model, report } = backtest();
  const calm: SurgeSample = { hour: 14, weekend: false, rain: false, transit: false, newAlert: false, ratio: 0.8, trend: 0, current: 1.05 };

  it('beats the simple baselines on unseen days', () => {
    console.log('surge backtest', JSON.stringify(report));
    expect(report.maeModel).toBeLessThan(report.maeNoChange);
    expect(report.maeModel).toBeLessThan(report.maeHourAverage);
    expect(report.note).toMatch(/synthetic/);
  });

  it('never trains on the days it is tested on', () => {
    expect(report.trainDays + report.testDays).toBe(120);
  });

  it('responds to a rain and transit alert', () => {
    const storm = { ...calm, rain: true, transit: true, newAlert: true, ratio: 3, trend: 0.2 };
    expect(forecast(model, storm).multiple).toBeGreaterThan(forecast(model, calm).multiple);
    expect(forecast(model, storm).advice).toBe('FORM_GROUPS_NOW');
  });

  it('stays inside the legal range and explains itself', () => {
    const f = forecast(model, { ...calm, ratio: 50, current: 2, rain: true });
    expect(f.multiple).toBeLessThanOrEqual(2);
    expect(f.multiple).toBeGreaterThanOrEqual(1);
    expect(f.drivers.length).toBeGreaterThan(0);
  });

  it('is reproducible', () => {
    expect(backtest().report).toEqual(report);
  });
});
