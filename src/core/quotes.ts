// Four phones, four quotes. Quotes are compared by when they were seen, stale ones are dropped,
// and an implausibly low quote is treated as a typing mistake until someone re-checks it. A gap
// between phones is recorded as what riders were shown, not as proof of wrongdoing.

export interface Quote {
  pid: string;
  app: string;
  amount: number;
  device: string | null;
  observedAt: number;
}

export interface QuoteResult {
  best: Quote | null;
  used: Quote[];
  rejected: { quote: Quote; why: string }[];
  gaps: { app: string; low: number; high: number; pct: number; devices: string }[];
  needsRecheck: boolean;
  because: string;
}

export const QUOTE_TTL_MIN = 5;
const GAP_PCT = 5;
const FUTURE_SKEW_MIN = 2;

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function resolveQuotes(quotes: Quote[], now: number): QuoteResult {
  const rejected: QuoteResult['rejected'] = [];
  const fresh: Quote[] = [];
  for (const q of quotes) {
    if (!Number.isFinite(q.amount) || q.amount <= 0) rejected.push({ quote: q, why: 'Not a possible fare' });
    else if (q.observedAt > now + FUTURE_SKEW_MIN) rejected.push({ quote: q, why: 'Timestamp is in the future' });
    else if (now - q.observedAt > QUOTE_TTL_MIN) rejected.push({ quote: q, why: `Older than ${QUOTE_TTL_MIN} minutes` });
    else fresh.push(q);
  }

  // One rider's latest quote per app is the one that counts.
  const latest = new Map<string, Quote>();
  for (const q of fresh) {
    const k = `${q.pid}|${q.app}`;
    const prior = latest.get(k);
    if (!prior || q.observedAt >= prior.observedAt) {
      if (prior) rejected.push({ quote: prior, why: 'Replaced by a newer quote from this rider' });
      latest.set(k, q);
    } else {
      rejected.push({ quote: q, why: 'Replaced by a newer quote from this rider' });
    }
  }

  const list = [...latest.values()];
  if (list.length === 0) {
    return { best: null, used: [], rejected, gaps: [], needsRecheck: true, because: 'No fresh quote yet. Ask someone in the group to check their app.' };
  }

  const mid = median(list.map((q) => q.amount));
  const used: Quote[] = [];
  let needsRecheck = false;
  for (const q of list) {
    if (list.length >= 3 && q.amount < mid * 0.5) {
      needsRecheck = true;
      rejected.push({ quote: q, why: `Far below the group's other quotes (Rs ${mid}). Check it before booking.` });
    } else {
      used.push(q);
    }
  }

  const gaps: QuoteResult['gaps'] = [];
  for (const app of [...new Set(used.map((q) => q.app))].sort()) {
    const same = used.filter((q) => q.app === app);
    if (same.length < 2) continue;
    const low = Math.min(...same.map((q) => q.amount));
    const high = Math.max(...same.map((q) => q.amount));
    const pct = Math.round(((high - low) / low) * 100);
    if (pct >= GAP_PCT) gaps.push({ app, low, high, pct, devices: [...new Set(same.map((q) => q.device ?? 'unknown'))].join(', ') });
  }

  const best = [...used].sort((a, b) => a.amount - b.amount || a.pid.localeCompare(b.pid))[0];
  return { best, used, rejected, gaps, needsRecheck, because: `Lowest fresh quote is Rs ${best.amount} on ${best.app}, so that phone books.` };
}
