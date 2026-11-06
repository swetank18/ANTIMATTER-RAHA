// Forming ride groups.
//
// Built on a shareability network (Santi, Resta, Szell, Sobolevsky, Strogatz, Ratti, PNAS 2014):
// riders are nodes, and an edge means two riders could share a cab within everyone's limits. A
// group is a clique in that graph. Trust follows Zimride, which began at Cornell in 2007: riders
// only match inside their own circle.
//
// Riders are taken in priority order, so urgent people get the best partners. Group formation is
// a heuristic, so the result is not claimed to be optimal; tests measure it against brute force.

import { bestRoute, fareFor, KM_PER_MIN, roundShares, shapley, type Travel } from './fare.ts';
import type { Need, ShareWith } from './types.ts';

export interface MatchRider {
  id: string;
  spot: string;
  node: string;
  circle: string;
  dest: string;
  party: number;
  need: Need;
  shareWith: ShareWith;
  readyAt: number;
  maxWaitMin: number;
  maxDetourMin: number;
  soloFare: number;
  rank: number;
}

export interface PodPlan {
  spot: string;
  circle: string;
  riders: string[];
  seatsUsed: number;
  seats: number;
  accessible: boolean;
  stops: string[];
  routeMin: number;
  fare: number;
  shares: Record<string, number>;
  detours: Record<string, number>;
  arrivalMin: Record<string, number>;
}

export interface MatchContext {
  travel: Travel;
  surge: (spot: string) => number;
  seats: number;
}

export const MAX_SEATS = 4;

/** The pairwise test: an edge in the shareability network. */
export function shareable(a: MatchRider, b: MatchRider): boolean {
  if (a.spot !== b.spot || a.circle !== b.circle) return false;
  if (a.shareWith === null || b.shareWith === null) return false;
  if (a.shareWith !== b.shareWith) return false;
  if (a.need === 'WHEELCHAIR' && b.need === 'WHEELCHAIR') return false;
  return Math.abs(a.readyAt - b.readyAt) <= Math.min(a.maxWaitMin, b.maxWaitMin);
}

const direct = (r: MatchRider, travel: Travel) => (r.dest === r.node ? 0 : travel(r.node, r.dest));

/**
 * Prices a candidate group, or returns null if it breaks anyone's limits. Each person in a party
 * is a player, so a party of three pays for three people's share of the route.
 */
export function evaluate(group: MatchRider[], ctx: MatchContext): PodPlan | null {
  const seatsUsed = group.reduce((s, r) => s + r.party, 0);
  const seats = Math.max(ctx.seats, group.length === 1 ? group[0].party : 0);
  if (seatsUsed > seats) return null;
  const { spot, node, circle } = group[0];
  const route = bestRoute(node, group.map((r) => r.dest), ctx.travel);
  if (!route) return null;

  const detours: Record<string, number> = {};
  const arrivalMin: Record<string, number> = {};
  for (const r of group) {
    const d = direct(r, ctx.travel);
    if (d === null) return null;
    const detour = (route.arrival[r.dest] ?? 0) - d;
    if (group.length > 1 && detour > r.maxDetourMin) return null;
    detours[r.id] = detour;
    arrivalMin[r.id] = route.arrival[r.dest] ?? 0;
  }

  const surge = ctx.surge(spot);
  const fare = fareFor(route.totalMin * KM_PER_MIN, surge);
  const people = group.flatMap((r) => Array.from({ length: r.party }, () => r));
  const memo = new Map<string, number>();
  const cost = (mask: number) => {
    const dests: string[] = [];
    people.forEach((r, i) => {
      if (mask & (1 << i)) dests.push(r.dest);
    });
    const key = [...new Set(dests)].sort().join('|');
    if (!memo.has(key)) {
      const sub = bestRoute(node, dests, ctx.travel);
      memo.set(key, fareFor((sub?.totalMin ?? 0) * KM_PER_MIN, surge));
    }
    return memo.get(key)!;
  };
  const values = shapley(people.length, cost);
  const perRider = group.map((r) => people.reduce((s, p, i) => (p.id === r.id ? s + values[i] : s), 0));
  const rounded = roundShares(perRider, fare);

  const shares: Record<string, number> = {};
  for (let i = 0; i < group.length; i++) {
    if (group.length > 1 && rounded[i] >= group[i].soloFare) return null;
    shares[group[i].id] = rounded[i];
  }
  return {
    spot, circle, seatsUsed, seats,
    riders: group.map((r) => r.id),
    accessible: group.some((r) => r.need === 'WHEELCHAIR'),
    stops: route.stops, routeMin: route.totalMin, fare, shares, detours, arrivalMin,
  };
}

const saving = (group: MatchRider[], plan: PodPlan) => group.reduce((s, r) => s + r.soloFare, 0) - plan.fare;

export function formPods(riders: MatchRider[], ctx: MatchContext): { pods: PodPlan[]; pairsChecked: number; edges: number } {
  const buckets = new Map<string, MatchRider[]>();
  for (const r of riders) {
    const k = `${r.spot}|${r.circle}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(r);
  }

  const pods: PodPlan[] = [];
  let pairsChecked = 0;
  let edges = 0;

  for (const k of [...buckets.keys()].sort()) {
    const list = buckets.get(k)!.sort((a, b) => a.rank - b.rank);
    const free = new Set(list.map((r) => r.id));
    const byId = new Map(list.map((r) => [r.id, r]));

    for (const seed of list) {
      if (!free.has(seed.id)) continue;
      free.delete(seed.id);
      const group = [seed];
      let plan = evaluate(group, ctx);
      if (!plan) {
        // Nobody can serve this trip by road: the allocator reports that as no option.
        continue;
      }

      for (;;) {
        // Riders alike in every way that matters are interchangeable, so only the most senior of
        // each kind is tried. This keeps the search small without changing who can be chosen.
        const tried = new Set<string>();
        let best: { r: MatchRider; plan: PodPlan; gain: number } | null = null;
        for (const id of free) {
          const c = byId.get(id)!;
          const kind = `${c.dest}|${c.party}|${c.shareWith}|${c.need}`;
          if (tried.has(kind)) continue;
          pairsChecked++;
          if (!group.every((g) => shareable(g, c))) continue;
          tried.add(kind);
          edges++;
          const next = evaluate([...group, c], ctx);
          if (!next) continue;
          const gain = saving([...group, c], next);
          if (!best || gain > best.gain) best = { r: c, plan: next, gain };
        }
        if (!best) break;
        group.push(best.r);
        free.delete(best.r.id);
        plan = best.plan;
      }
      pods.push(plan);
    }
  }
  return { pods, pairsChecked, edges };
}
