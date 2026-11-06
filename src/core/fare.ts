// Fares and fair splits.
//
// Surge is charged per car, not per person, so people sharing a car divide it. That arithmetic is
// the whole saving: it needs no cooperation from Uber or Ola and does not depend on surge falling.
//
// A split uses the Shapley value: each person pays their average marginal cost over every order
// the group could have formed in. On top of that sits one hard rule: nobody joins a group unless
// they pay less than going alone.

/** Demo rates only. These are not notified fares for any state. */
export const DEMO_RATE = { flag: 50, perKm: 18 };
export const KM_PER_MIN = 0.45;

export interface FareRule {
  vehicle: string;
  baseFare: number;
  perKm: number;
  capMultiplier: number;
  floorMultiplier: number;
  verified: boolean;
  source: string;
}

export function fareFor(km: number, surge = 1, rate = DEMO_RATE): number {
  return Math.round((rate.flag + rate.perKm * Math.max(1, km)) * surge);
}

export type Travel = (from: string, to: string) => number | null;

export interface Route {
  stops: string[];
  totalMin: number;
  arrival: Record<string, number>;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  items.forEach((x, i) => {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

/** The shortest visiting order. A car carries at most a few stops, so trying them all is exact. */
export function bestRoute(origin: string, dests: string[], travel: Travel): Route | null {
  const unique = [...new Set(dests)].sort();
  if (unique.length === 0) return { stops: [], totalMin: 0, arrival: {} };
  let best: Route | null = null;
  for (const order of permutations(unique)) {
    let at = origin;
    let total = 0;
    const arrival: Record<string, number> = {};
    let ok = true;
    for (const stop of order) {
      const leg = stop === at ? 0 : travel(at, stop);
      if (leg === null) {
        ok = false;
        break;
      }
      total += leg;
      arrival[stop] = total;
      at = stop;
    }
    if (ok && (!best || total < best.totalMin)) best = { stops: order, totalMin: total, arrival };
  }
  return best;
}

/** Exact Shapley value, computed from a cost for every subset of players. */
export function shapley(players: number, cost: (mask: number) => number): number[] {
  const n = players;
  const fact = [1];
  for (let i = 1; i <= n; i++) fact[i] = fact[i - 1] * i;
  const costs = new Array<number>(1 << n);
  for (let m = 0; m < 1 << n; m++) costs[m] = m === 0 ? 0 : cost(m);
  const out = new Array<number>(n).fill(0);
  for (let m = 0; m < 1 << n; m++) {
    let size = 0;
    for (let b = m; b; b &= b - 1) size++;
    for (let i = 0; i < n; i++) {
      if (m & (1 << i)) continue;
      out[i] += ((fact[size] * fact[n - size - 1]) / fact[n]) * (costs[m | (1 << i)] - costs[m]);
    }
  }
  return out;
}

/** Whole rupees that add up to the total exactly, by largest remainder. */
export function roundShares(values: number[], total: number): number[] {
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum <= 0) return values.map(() => 0);
  const scaled = values.map((v) => (v / sum) * total);
  const out = scaled.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = scaled.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k][1]]++;
  return out;
}

export interface FareCheck {
  status: 'WITHIN_CAP' | 'OVER_CAP' | 'NO_VERIFIED_BASE_FARE';
  multiple: number | null;
  maxLegal: number | null;
  message: string;
}

/**
 * Compares a quote with the legal cap. Without a verified base fare the app says it cannot judge.
 * It reports what a rider was quoted and never declares a fare illegal on a guess.
 */
export function checkFare(quote: number, km: number, rule: FareRule | null): FareCheck {
  if (!rule || !rule.verified) {
    return { status: 'NO_VERIFIED_BASE_FARE', multiple: null, maxLegal: null, message: 'No verified base fare for this area, so this cannot be checked against the legal cap.' };
  }
  const base = rule.baseFare + rule.perKm * Math.max(1, km);
  const maxLegal = Math.round(base * rule.capMultiplier);
  const multiple = Math.round((quote / base) * 100) / 100;
  if (quote > maxLegal) {
    return { status: 'OVER_CAP', multiple, maxLegal, message: `This quote is ${multiple}x the base fare, above the ${rule.capMultiplier}x cap. Most this trip should cost: Rs ${maxLegal}.` };
  }
  return { status: 'WITHIN_CAP', multiple, maxLegal, message: `This quote is ${multiple}x the base fare, within the ${rule.capMultiplier}x cap.` };
}

export interface FareSample {
  spot: string;
  app: string;
  amount: number;
  km: number;
  at: number;
}

export interface Advice {
  move: 'SHARE' | 'WAIT' | 'WALK' | 'SWITCH';
  title: string;
  saveRs: number;
  basis: string;
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const MIN_SAMPLES = 3;

/**
 * What to do instead of paying this quote. Everything comes from quotes riders really shared,
 * normalised per km. With too few samples a move is left out rather than estimated.
 */
export function advise(input: { spot: string; app: string; amount: number; km: number; now: number; samples: FareSample[]; nearby: { spot: string; name: string; walkMin: number }[]; shareRs: number | null }): Advice[] {
  const { spot, app, amount, km, now, samples, nearby, shareRs } = input;
  const out: Advice[] = [];
  const perKm = (s: FareSample) => s.amount / Math.max(1, s.km);
  const est = (list: FareSample[]) => (list.length >= MIN_SAMPLES ? Math.round(median(list.map(perKm)) * Math.max(1, km)) : null);

  if (shareRs !== null && shareRs < amount) {
    out.push({ move: 'SHARE', title: 'Share a cab with people going your way', saveRs: amount - shareRs, basis: 'Your split of a group going your way' });
  }
  const earlier = est(samples.filter((s) => s.spot === spot && s.at < now - 15 && s.at >= now - 60));
  if (earlier !== null && earlier < amount) {
    out.push({ move: 'WAIT', title: 'Wait about 10 minutes', saveRs: amount - earlier, basis: 'Quotes here over the last hour. Surges are often short, but this is not a promise.' });
  }
  for (const n of nearby) {
    const there = est(samples.filter((s) => s.spot === n.spot && s.at >= now - 15));
    if (there !== null && there < amount) {
      out.push({ move: 'WALK', title: `Walk ${n.walkMin} min to ${n.name}`, saveRs: amount - there, basis: `Recent quotes at ${n.name}` });
    }
  }
  const apps = [...new Set(samples.filter((s) => s.app !== app).map((s) => s.app))];
  for (const a of apps) {
    const other = est(samples.filter((s) => s.spot === spot && s.app === a && s.at >= now - 15));
    if (other !== null && other < amount) {
      out.push({ move: 'SWITCH', title: `Check ${a}`, saveRs: amount - other, basis: `Recent ${a} quotes here` });
    }
  }
  return out.sort((a, b) => b.saveRs - a.saveRs);
}

/**
 * Finds the fare in text read from a screenshot. OCR often misreads the rupee sign, so a marked
 * amount wins, then the largest plausible number. It only ever fills a field the rider confirms.
 */
export function fareFromText(text: string): number | null {
  const plausible = (n: number) => n >= 20 && n <= 9999;
  const clean = (s: string) => Number(s.replace(/,/g, ''));
  const marked = [...text.matchAll(/(?:₹|rs\.?|inr|%|\?)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi)].map((m) => clean(m[1])).filter(plausible);
  if (marked.length) return Math.round(Math.max(...marked));
  const noTimes = text.replace(/\b\d{1,2}:\d{2}\b/g, ' ').replace(/\b\d+(\.\d+)?\s*(km|min|mins|m)\b/gi, ' ');
  const numbers = [...noTimes.matchAll(/(?<![\d.,])[0-9][0-9,]*(?:\.[0-9]{1,2})?(?![\d])/g)].map((m) => clean(m[0])).filter(plausible);
  return numbers.length ? Math.round(Math.max(...numbers)) : null;
}
