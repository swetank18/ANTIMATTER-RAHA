// C10. A single sensor never triggers an action. GPS is cross-checked against the odometer
// (a separate signal), and passenger counts against the signed boarding manifest. The key
// distinction: a frozen GPS repeats exactly while the odometer climbs, which is a sensor fault;
// a real stop shows normal GPS jitter while the odometer also stands still. Koottu reads this
// from a ride's shared trip, and a real stop asks the riders if they are safe.

import type { Reading, SensorReport } from './types.ts';

const MAX_KMH = 110;
const LATE_MIN = 2;
const GAP_MIN = 3;
const FROZEN_RUN = 4;
const STOPPED_RUN = 4;

function km(a: Reading, b: Reading): number {
  if (a.lat === null || a.lng === null || b.lat === null || b.lng === null) return 0;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Hampel filter: flags points further than k scaled median deviations from the median. */
export function hampel(values: number[], k = 3): boolean[] {
  const m = median(values);
  const mad = 1.4826 * median(values.map((v) => Math.abs(v - m)));
  return values.map((v) => (mad === 0 ? false : Math.abs(v - m) > k * mad));
}

export function assess(
  vehicleId: string,
  stream: Reading[],
  ctx: { capacity: number; manifest: number; now: number },
): SensorReport {
  const flags: SensorReport['flags'] = [];
  const add = (code: string, detail: string) => {
    if (!flags.some((f) => f.code === code)) flags.push({ code, detail });
  };

  const arrived = [...stream].sort((a, b) => a.receivedAt - b.receivedAt);
  for (let i = 1; i < arrived.length; i++) {
    if (arrived[i].observedAt < arrived[i - 1].observedAt) add('OUT_OF_ORDER', 'A reading arrived after a newer one and was re-sequenced.');
  }

  const ordered = [...stream].sort((a, b) => a.observedAt - b.observedAt);
  const suspect = new Set<Reading>();

  for (const r of ordered) {
    if (r.receivedAt - r.observedAt > LATE_MIN) add('LATE', `Reading delivered ${r.receivedAt - r.observedAt} min after it was taken.`);
    if (r.lat === null || r.lng === null) {
      add('MISSING', 'A GPS reading is empty.');
      suspect.add(r);
    }
    if (r.occupancy !== null && (r.occupancy < 0 || r.occupancy > ctx.capacity * 1.1)) {
      add('IMPOSSIBLE_COUNT', `Passenger counter read ${r.occupancy} on a vehicle with ${ctx.capacity} seats.`);
      suspect.add(r);
    }
  }

  const usable = ordered.filter((r) => r.lat !== null && r.lng !== null);
  for (let i = 1; i < usable.length; i++) {
    const dt = usable[i].observedAt - usable[i - 1].observedAt;
    if (dt > GAP_MIN) add('GAP', `No GPS for ${dt} min.`);
    if (dt > 0) {
      const kmh = (km(usable[i - 1], usable[i]) / dt) * 60;
      if (kmh > MAX_KMH) {
        add('IMPOSSIBLE_JUMP', `GPS jumped at an implied ${Math.round(kmh)} km/h.`);
        suspect.add(usable[i]);
      }
    }
  }

  const recent = usable.slice(-Math.max(FROZEN_RUN, STOPPED_RUN));
  const samePlace = recent.length >= FROZEN_RUN && recent.every((r) => r.lat === recent[0].lat && r.lng === recent[0].lng);
  const odo = recent.map((r) => r.odoKm).filter((v): v is number => v !== null);
  const odoMoved = odo.length >= 2 ? odo[odo.length - 1] - odo[0] : 0;
  const hasOdo = odo.length >= 2;
  const barelyMoved = recent.length >= STOPPED_RUN && km(recent[0], recent[recent.length - 1]) < 0.05;

  const frozen = samePlace && hasOdo && odoMoved > 0.2;
  if (frozen) add('FROZEN_GPS', `GPS repeated ${recent.length} times while the odometer rose ${odoMoved.toFixed(1)} km.`);

  const counts = ordered.map((r) => r.occupancy).filter((v): v is number => v !== null && v >= 0);
  if (counts.length >= 5) {
    const spikes = hampel(counts);
    if (spikes.some(Boolean)) add('COUNT_SPIKE', 'Passenger count contains a sudden outlier.');
  }
  const lastCount = [...ordered].reverse().find((r) => r.occupancy !== null && !suspect.has(r))?.occupancy ?? null;
  if (lastCount !== null && Math.abs(lastCount - ctx.manifest) > Math.max(3, ctx.manifest * 0.2)) {
    add('COUNT_CONFLICT', `Counter reads ${lastCount} but the signed manifest says ${ctx.manifest} boarded.`);
  }

  const lastGood = [...usable].reverse().find((r) => !suspect.has(r) && !(frozen && recent.includes(r))) ?? null;

  const genuine = barelyMoved && !samePlace && hasOdo && odoMoved <= 0.05;
  if (genuine) {
    return {
      vehicleId, verdict: 'GENUINE_STOP', flags, lastGood, autoAction: false,
      action: 'GPS and odometer agree the ride has stopped. Asking the riders if they are safe before anything else happens.',
    };
  }

  const hardFault = flags.some((f) => ['IMPOSSIBLE_JUMP', 'FROZEN_GPS', 'IMPOSSIBLE_COUNT', 'MISSING'].includes(f.code));
  if (hardFault) {
    return {
      vehicleId, verdict: 'SENSOR_FAULT', flags, lastGood, autoAction: false,
      action: 'Bad readings ignored. ETA now uses the last good position and is marked uncertain. No alert is raised on this alone.',
    };
  }
  if (flags.length > 0) {
    return {
      vehicleId, verdict: 'UNCERTAIN', flags, lastGood, autoAction: false,
      action: 'Readings are marked uncertain. A person is asked to check before anyone acts on them.',
    };
  }
  return { vehicleId, verdict: 'HEALTHY', flags, lastGood, autoAction: false, action: 'No action needed.' };
}
