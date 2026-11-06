// Priority allocator.
//
// People are seated strictly in priority order. When nobody's preferred seat is free,
// already-seated flexible passengers are shifted along an augmenting path, so a seat is
// only ever refused when no rearrangement could provide it.
//
// For single travellers the sets of people who can be seated together form a transversal
// matroid, so this greedy order is provably optimal: it seats the maximum number of people
// and the i-th highest-priority person seated is at least as senior as the i-th in any other
// feasible outcome. Each refusal comes with a Hall witness: a closed set of full pools.
//
// Groups that must travel together break the matroid property (the problem becomes a
// generalised assignment). Capacity is still never exceeded, but optimality is not claimed;
// certify.ts reports the gap against the relaxed upper bound instead.

import type { Witness } from './types.ts';

export interface PoolIn {
  id: string;
  cap: number;
}

export interface OptionIn {
  run: string;
  demand: Record<string, number>;
}

export interface UnitIn {
  id: string;
  rank: number;
  options: OptionIn[];
  /** Index-free lock: the unit already holds a commitment and may not be moved. */
  locked?: OptionIn;
}

export interface AllocationResult {
  placed: Map<string, OptionIn>;
  refused: { id: string; witness: Witness }[];
  free: Map<string, number>;
  shifts: number;
}

const units = (o: OptionIn) => Object.values(o.demand).reduce((a, b) => a + b, 0);
const single = (o: OptionIn) => Object.keys(o.demand).length === 1 && units(o) === 1;
const poolOf = (o: OptionIn) => Object.keys(o.demand)[0];

export function allocate(pools: PoolIn[], input: UnitIn[]): AllocationResult {
  const free = new Map(pools.map((p) => [p.id, p.cap]));
  const occupants = new Map<string, Map<string, Set<string>>>(pools.map((p) => [p.id, new Map()]));
  const classPools = new Map<string, string[]>();
  const byId = new Map(input.map((u) => [u.id, u]));
  const placed = new Map<string, OptionIn>();
  let shifts = 0;

  const movable = (u: UnitIn) => !u.locked && u.options.length > 0 && u.options.every(single);
  const classOf = (u: UnitIn) => u.options.map(poolOf).sort().join('|');

  const seat = (u: UnitIn, o: OptionIn) => {
    for (const [pool, n] of Object.entries(o.demand)) free.set(pool, (free.get(pool) ?? 0) - n);
    placed.set(u.id, o);
    if (movable(u)) {
      const k = classOf(u);
      if (!classPools.has(k)) classPools.set(k, u.options.map(poolOf).sort());
      const room = occupants.get(poolOf(o))!;
      if (!room.has(k)) room.set(k, new Set());
      room.get(k)!.add(u.id);
    }
  };

  const unseat = (u: UnitIn) => {
    const o = placed.get(u.id)!;
    for (const [pool, n] of Object.entries(o.demand)) free.set(pool, (free.get(pool) ?? 0) + n);
    placed.delete(u.id);
    if (movable(u)) occupants.get(poolOf(o))!.get(classOf(u))!.delete(u.id);
  };

  /** Breadth-first search for a free seat. An edge a -> b means someone in a may use b. */
  const search = (starts: string[], skipStartFree = false) => {
    const prev = new Map<string, { from: string; cls: string } | null>();
    const queue: string[] = [];
    for (const s of starts) {
      if (free.has(s) && !prev.has(s)) {
        prev.set(s, null);
        queue.push(s);
      }
    }
    for (let i = 0; i < queue.length; i++) {
      const pool = queue[i];
      const isStart = prev.get(pool) === null;
      if ((free.get(pool) ?? 0) > 0 && !(skipStartFree && isStart)) return { found: pool, prev };
      const room = occupants.get(pool)!;
      for (const cls of [...room.keys()].sort()) {
        if (room.get(cls)!.size === 0) continue;
        for (const next of classPools.get(cls)!) {
          if (!prev.has(next)) {
            prev.set(next, { from: pool, cls });
            queue.push(next);
          }
        }
      }
    }
    return { found: null as string | null, prev };
  };

  /** Walks the path backwards, moving the lowest-priority occupant of each class. */
  const shift = (found: string, prev: Map<string, { from: string; cls: string } | null>) => {
    const moves: [string, OptionIn][] = [];
    let pool = found;
    while (prev.get(pool)) {
      const { from, cls } = prev.get(pool)!;
      let pick: UnitIn | null = null;
      for (const id of occupants.get(from)!.get(cls)!) {
        const u = byId.get(id)!;
        if (!pick || u.rank > pick.rank) pick = u;
      }
      const u = pick!;
      moves.push([u.id, placed.get(u.id)!]);
      unseat(u);
      seat(u, u.options.find((o) => poolOf(o) === pool)!);
      shifts++;
      pool = from;
    }
    return { start: pool, moves };
  };

  const undo = (moves: [string, OptionIn][]) => {
    for (const [id, o] of moves.reverse()) {
      const u = byId.get(id)!;
      unseat(u);
      seat(u, o);
      shifts--;
    }
  };

  /** Tries to open enough room for one option, rolling back cleanly on failure. */
  const clear = (o: OptionIn): boolean => {
    const log: [string, OptionIn][] = [];
    for (const [pool, n] of Object.entries(o.demand)) {
      while ((free.get(pool) ?? 0) < n) {
        const r = search([pool], true);
        if (!r.found) {
          undo(log);
          return false;
        }
        log.push(...shift(r.found, r.prev).moves);
      }
    }
    return true;
  };

  const fits = (o: OptionIn) => Object.entries(o.demand).every(([pool, n]) => (free.get(pool) ?? 0) >= n);

  for (const u of input) if (u.locked) seat(u, u.locked);

  const refused: { id: string; witness: Witness }[] = [];
  const closed = new Map<string, Witness>();
  const order = input.filter((u) => !u.locked).sort((a, b) => a.rank - b.rank);

  for (const u of order) {
    if (u.options.length === 0) {
      refused.push({ id: u.id, witness: { kind: 'NO_OPTION', pools: [] } });
      continue;
    }
    const need = u.options.reduce((m, o) => Math.max(m, units(o)), 0);
    const key = `${u.options.map((o) => Object.keys(o.demand).sort().join('+')).sort().join('|')}#${need}`;
    const known = closed.get(key);
    if (known) {
      refused.push({ id: u.id, witness: known });
      continue;
    }

    let done = false;
    for (const o of u.options) {
      if (fits(o)) {
        seat(u, o);
        done = true;
        break;
      }
    }
    if (!done) {
      for (const o of u.options) {
        if (clear(o)) {
          seat(u, o);
          done = true;
          break;
        }
      }
    }
    if (!done) {
      const reach = search(u.options.flatMap((o) => Object.keys(o.demand)));
      const witness: Witness = {
        kind: reach.found ? 'FRAGMENTED' : 'HALL',
        pools: [...reach.prev.keys()].sort(),
      };
      closed.set(key, witness);
      refused.push({ id: u.id, witness });
    }
  }

  // Seats freed by shifting go back to the most senior person who would prefer them.
  for (const u of order) {
    const now = placed.get(u.id);
    if (!now || !movable(u)) continue;
    for (const o of u.options) {
      if (o === now || o.run === now.run) break;
      if (fits(o)) {
        unseat(u);
        seat(u, o);
        break;
      }
    }
  }

  return { placed, refused, free, shifts };
}
