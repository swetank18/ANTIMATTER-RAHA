// Built-in attack data for the Arena. Organisers can replace any of it with their own.

import type { Reading } from '../core/types.ts';

/** Six valid rows and a row for every failure the C04 card names. */
export const SAMPLE_BATCH_CSV = `rider_id,destination,need,party,deadline_kind,deadline_at,deadline_verified
OK-001,MAA,NONE,1,FLIGHT,2026-11-06T20:20:00+05:30,true
OK-002,SHO,ASSIST,2,SHIFT,2026-11-06T19:30:00+05:30,false
OK-003,TBM,NONE,1,NONE,,
OK-004,KLK,WHEELCHAIR,1,MEDICAL,2026-11-06T19:00:00+05:30,true
OK-005,MAS,NONE,3,RAIL,2026-11-06T21:00:00+05:30,true
OK-006,VLC,NONE,1,NONE,,
,MAA,NONE,1,NONE,,
OK-001,MAA,NONE,1,NONE,,
BAD-TIME,MAA,NONE,1,FLIGHT,2026-13-45T99:00:00+05:30,true
BAD-TIME2,MAA,NONE,1,FLIGHT,tomorrow morning,true
BAD-NEG,SHO,NONE,-4,NONE,,
BAD-BIG,SHO,NONE,900,NONE,,
BAD-TYPE,SHO,NONE,five,NONE,,
BAD-DEST,ATLANTIS,NONE,1,NONE,,
BAD-NEED,TBM,TELEPORT,1,NONE,,
BAD-RTL,TBM‮gnp.exe,NONE,1,NONE,,
BAD-ZW,MA​A,NONE,1,NONE,,
'; DROP TABLE riders; --,MAA,NONE,1,NONE,,
<script>alert(1)</script>,MAA,NONE,1,NONE,,
=HYPERLINK("http://x"),MAA,NONE,1,NONE,,
TOO,FEW,COLUMNS
`;

export const SAMPLE_BATCH_EXPECTED = { accepted: 6, quarantined: 15 };

export const SAMPLE_BROKEN_JSON = `[
  {"rider_id":"JS-001","destination":"MAA","need":"NONE","party":1},
  {"rider_id":"JS-002","destination":"TBM","need":"NONE","party":"2 people"},
  {"rider_id":"JS-003","destination":"SHO","need":"NONE","party":2},
  {"rider_id":"JS-004","destination":"MAA","need":["a","list"],"party":1},
  {"rider_id":"JS-005","destination":"VLC","need":"NONE","party":1
`;

export const CANARY = {
  name: 'Zzyzx Canary Kumar',
  phone: '9876543210',
  email: 'zzyzx.canary@example.com',
  idNumber: '314159265358',
};

export const SAMPLE_PRIVATE_BATCH = `rider_id,name,phone,email,id_number,destination,need,party,share_with
PRIV-${CANARY.idNumber},${CANARY.name},${CANARY.phone},${CANARY.email},${CANARY.idNumber},MAA,NONE,1,ANYONE
PRIV-BAD,${CANARY.name},${CANARY.phone},${CANARY.email},${CANARY.idNumber},ATLANTIS,NONE,1,ANYONE
`;

const walk = (vehicleId: string, now: number, steps: number, opts: Partial<Reading> = {}): Reading[] =>
  Array.from({ length: steps }, (_, i) => ({
    vehicleId, observedAt: now - steps + i, receivedAt: now - steps + i,
    lat: 13.0 + i * 0.006, lng: 80.2 + i * 0.002, odoKm: 100 + i * 0.7, occupancy: null, ...opts,
  }));

export function telemetrySample(now: number): { readings: Reading[] } {
  const teleport = walk('RIDE-1', now, 8);
  teleport[5] = { ...teleport[5], lat: 13.6, lng: 80.9 };

  const frozen = walk('RIDE-2', now, 8).map((r, i) => (i >= 3 ? { ...r, lat: 13.018, lng: 80.206 } : r));

  const counter = walk('RIDE-3', now, 7, { occupancy: 3 });
  counter[3] = { ...counter[3], occupancy: 41 };
  counter[5] = { ...counter[5], receivedAt: counter[5].observedAt + 6 };

  // A real stop: the GPS jitters as a real receiver does, and the odometer stands still.
  const stopped = Array.from({ length: 7 }, (_, i): Reading => ({
    vehicleId: 'RIDE-4', observedAt: now - 7 + i, receivedAt: now - 7 + i,
    lat: 13.02 + [0.00004, -0.00003, 0.00002, 0, -0.00002, 0.00003, -0.00001][i],
    lng: 80.21 + [-0.00002, 0.00003, 0, 0.00002, -0.00003, 0.00001, 0.00002][i],
    odoKm: 212.4, occupancy: null,
  }));

  return { readings: [...teleport, ...frozen, ...counter, ...stopped, ...walk('RIDE-5', now, 8)] };
}

/** Deliberately incomplete, as the card says it will be. No critical string is included. */
export const SAMPLE_PACK = {
  code: 'ta',
  name: 'தமிழ்',
  strings: { 'nav.settings': 'மொழி', 'request.dest': 'சேருமிடம்' },
  glossary: {},
};
