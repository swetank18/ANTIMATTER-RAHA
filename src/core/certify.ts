// Independent checker. It deliberately imports nothing from allocator.ts: it recounts the
// outcome from the raw inputs and recomputes the upper bound with its own max-flow, so a bug
// in the solver cannot also hide in the proof.

import type { Certificate, CertificateCheck, Witness } from './types.ts';

export interface CertPool {
  id: string;
  cap: number;
}

export interface CertOption {
  run: string;
  demand: Record<string, number>;
}

export interface CertUnit {
  id: string;
  rank: number;
  options: CertOption[];
  locked?: CertOption;
}

export interface CertInput {
  pools: CertPool[];
  units: CertUnit[];
  placed: Record<string, CertOption>;
  refused: { id: string; witness: Witness }[];
}

/** Dinic's max-flow over class-to-pool edges. */
function maxFlow(nodes: number, edges: [number, number, number][], s: number, t: number): number {
  const head: number[][] = Array.from({ length: nodes }, () => []);
  const to: number[] = [];
  const cap: number[] = [];
  for (const [a, b, c] of edges) {
    head[a].push(to.length);
    to.push(b);
    cap.push(c);
    head[b].push(to.length);
    to.push(a);
    cap.push(0);
  }
  const level = new Array<number>(nodes);
  const it = new Array<number>(nodes);
  const bfs = () => {
    level.fill(-1);
    level[s] = 0;
    const q = [s];
    for (let i = 0; i < q.length; i++) {
      for (const e of head[q[i]]) {
        if (cap[e] > 0 && level[to[e]] < 0) {
          level[to[e]] = level[q[i]] + 1;
          q.push(to[e]);
        }
      }
    }
    return level[t] >= 0;
  };
  const dfs = (v: number, f: number): number => {
    if (v === t) return f;
    for (; it[v] < head[v].length; it[v]++) {
      const e = head[v][it[v]];
      if (cap[e] > 0 && level[to[e]] === level[v] + 1) {
        const d = dfs(to[e], Math.min(f, cap[e]));
        if (d > 0) {
          cap[e] -= d;
          cap[e ^ 1] += d;
          return d;
        }
      }
    }
    return 0;
  };
  let flow = 0;
  while (bfs()) {
    it.fill(0);
    let f: number;
    while ((f = dfs(s, Infinity)) > 0) flow += f;
  }
  return flow;
}

const unitsOf = (o: CertOption) => Object.values(o.demand).reduce((a, b) => a + b, 0);

/** The most that could be seated if every group were willing to split up. */
export function relaxedBound(pools: CertPool[], units: CertUnit[]): number {
  const poolIndex = new Map(pools.map((p, i) => [p.id, i]));
  const classes = new Map<string, { size: number; pools: Set<string> }>();
  for (const u of units) {
    const options = u.locked ? [u.locked] : u.options;
    if (options.length === 0) continue;
    const set = new Set(options.flatMap((o) => Object.keys(o.demand)));
    const key = [...set].sort().join('|');
    const size = Math.max(...options.map(unitsOf));
    const c = classes.get(key) ?? { size: 0, pools: set };
    c.size += size;
    classes.set(key, c);
  }
  const list = [...classes.values()];
  const s = 0;
  const firstPool = 1;
  const firstClass = firstPool + pools.length;
  const t = firstClass + list.length;
  const edges: [number, number, number][] = [];
  pools.forEach((p, i) => edges.push([firstPool + i, t, p.cap]));
  list.forEach((c, i) => {
    edges.push([s, firstClass + i, c.size]);
    for (const pool of c.pools) {
      const at = poolIndex.get(pool);
      if (at !== undefined) edges.push([firstClass + i, firstPool + at, c.size]);
    }
  });
  return maxFlow(t + 1, edges, s, t);
}

export function certify(input: CertInput): Certificate {
  const { pools, units, placed, refused } = input;
  const cap = new Map(pools.map((p) => [p.id, p.cap]));
  const byId = new Map(units.map((u) => [u.id, u]));
  const used = new Map<string, number>();
  const inPool = new Map<string, CertUnit[]>();
  const checks: CertificateCheck[] = [];

  for (const [id, o] of Object.entries(placed)) {
    for (const [pool, n] of Object.entries(o.demand)) {
      used.set(pool, (used.get(pool) ?? 0) + n);
      const list = inPool.get(pool) ?? [];
      list.push(byId.get(id)!);
      inPool.set(pool, list);
    }
  }

  const over = pools.filter((p) => (used.get(p.id) ?? 0) > p.cap);
  checks.push({
    id: 'capacity',
    label: 'No vehicle holds more people than it has room for',
    ok: over.length === 0,
    observed: over.length ? `${over.length} over capacity` : `${pools.length} seat and bay pools recounted, none over`,
  });

  let bad = 0;
  for (const [id, o] of Object.entries(placed)) {
    const u = byId.get(id);
    const allowed = u && (u.locked ? [u.locked] : u.options);
    if (!allowed || !allowed.some((a) => a.run === o.run && JSON.stringify(a.demand) === JSON.stringify(o.demand))) bad++;
  }
  checks.push({
    id: 'admissible',
    label: 'Everyone seated is on a vehicle that can actually serve them',
    ok: bad === 0,
    observed: bad ? `${bad} placed on an invalid run` : `${Object.keys(placed).length} placements checked`,
  });

  const broken = units.filter((u) => u.locked && placed[u.id]?.run !== u.locked.run);
  checks.push({
    id: 'commitments',
    label: 'Every issued pass is still honoured',
    ok: broken.length === 0,
    observed: `${units.filter((u) => u.locked).length} commitments kept, ${broken.length} broken`,
  });

  const seen = new Set(Object.keys(placed));
  const both = refused.filter((r) => seen.has(r.id));
  const missing = units.filter((u) => !seen.has(u.id) && !refused.some((r) => r.id === u.id));
  checks.push({
    id: 'complete',
    label: 'Everyone has exactly one outcome',
    ok: both.length === 0 && missing.length === 0,
    observed: `${seen.size} seated, ${refused.length} refused, ${missing.length} without an outcome`,
  });

  let hallChecked = 0;
  let hallBad = 0;
  for (const r of refused) {
    if (r.witness.kind !== 'HALL') continue;
    const me = byId.get(r.id)!;
    if (me.options.some((o) => Object.keys(o.demand).length !== 1)) continue;
    hallChecked++;
    const set = new Set(r.witness.pools);
    const myPools = me.options.flatMap((o) => Object.keys(o.demand));
    let ok = myPools.every((p) => set.has(p));
    for (const pool of set) {
      if ((used.get(pool) ?? 0) !== cap.get(pool)) ok = false;
      for (const rival of inPool.get(pool) ?? []) {
        if (rival.locked) continue;
        if (rival.rank > me.rank) ok = false;
        const solo = rival.options.every((o) => Object.keys(o.demand).length === 1 && unitsOf(o) === 1);
        if (solo && !rival.options.every((o) => set.has(Object.keys(o.demand)[0]))) ok = false;
      }
    }
    if (!ok) hallBad++;
  }
  checks.push({
    id: 'hall',
    label: 'Each refusal has a proof that no rearrangement could seat that person',
    ok: hallBad === 0,
    observed: `${hallChecked - hallBad} of ${hallChecked} refusal proofs verified`,
  });

  const unitsSeated = Object.entries(placed).reduce((s, [, o]) => s + unitsOf(o), 0);
  const unitsRefused = refused.reduce((s, r) => {
    const u = byId.get(r.id);
    return s + (u && u.options.length ? Math.max(...u.options.map(unitsOf)) : 0);
  }, 0);
  const bound = relaxedBound(pools, units);
  const gap = bound - unitsSeated;
  checks.push({
    id: 'bound',
    label: 'Seats filled are compared with the most any plan could fill',
    ok: gap >= 0,
    observed: `${unitsSeated} seated against an upper bound of ${bound}`,
  });

  return {
    ok: checks.every((c) => c.ok),
    checks,
    seatsAvailable: pools.reduce((s, p) => s + p.cap, 0),
    unitsSeated,
    unitsRefused,
    relaxedBound: bound,
    gap,
  };
}
