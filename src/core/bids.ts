// Riders as a buying bloc. A group is posted once to the open network and drivers quote for the
// whole group, so riders stop being price-takers. An Uber or Ola quote becomes one comparison point.

export interface DriverBid {
  id: string;
  driver: string;
  vehicle: string;
  seats: number;
  amount: number;
  etaMin: number;
  rating: number;
}

export interface BidResult {
  best: DriverBid | null;
  ranked: DriverBid[];
  rejected: { bid: DriverBid; why: string }[];
  because: string;
}

const MIN_RATING = 4;
const MAX_ETA_MIN = 20;

/** The lowest fare among bids that can actually carry the group safely and soon. */
export function chooseBid(bids: DriverBid[], seatsNeeded: number): BidResult {
  const rejected: BidResult['rejected'] = [];
  const ok: DriverBid[] = [];
  for (const b of bids) {
    if (!Number.isFinite(b.amount) || b.amount <= 0) rejected.push({ bid: b, why: 'Not a possible fare' });
    else if (b.seats < seatsNeeded) rejected.push({ bid: b, why: `Only ${b.seats} seats for ${seatsNeeded} people` });
    else if (b.rating < MIN_RATING) rejected.push({ bid: b, why: `Rating ${b.rating} is below ${MIN_RATING}` });
    else if (b.etaMin > MAX_ETA_MIN) rejected.push({ bid: b, why: `Arrives in ${b.etaMin} min, over ${MAX_ETA_MIN}` });
    else ok.push(b);
  }
  const ranked = ok.sort((a, b) => a.amount - b.amount || a.etaMin - b.etaMin || a.id.localeCompare(b.id));
  const best = ranked[0] ?? null;
  return {
    best, ranked, rejected,
    because: best ? `${best.driver} bid Rs ${best.amount} for the whole group, arriving in ${best.etaMin} min.` : 'No bid can carry this group yet.',
  };
}

/** Reads a Beckn-style on_search reply. Anything unexpected is dropped, never guessed at. */
export function parseOnSearch(raw: unknown): DriverBid[] {
  const r = raw as { message?: { catalog?: { providers?: unknown[] } } } | null;
  const providers = r?.message?.catalog?.providers;
  if (!Array.isArray(providers)) return [];
  const out: DriverBid[] = [];
  for (const p of providers as any[]) {
    for (const item of Array.isArray(p?.items) ? p.items : []) {
      const amount = Number(item?.price?.value);
      const seats = Number(item?.fulfillment?.vehicle?.capacity);
      const etaMin = Number(item?.fulfillment?.etaMinutes);
      const rating = Number(p?.rating);
      if (typeof item?.id !== 'string' || ![amount, seats, etaMin, rating].every(Number.isFinite)) continue;
      out.push({ id: item.id, driver: String(p?.descriptor?.name ?? 'Driver').slice(0, 40), vehicle: String(item?.fulfillment?.vehicle?.category ?? 'CAB').slice(0, 20), seats, amount, etaMin, rating });
    }
  }
  return out;
}
