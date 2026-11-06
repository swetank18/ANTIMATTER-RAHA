// RAHA discrete-event simulation (DES).
// One engine, shared by the browser Atlas (replay) and Node experiments (statistics),
// so every number on screen is produced by exactly this code.
// Deterministic: all randomness comes from makeRng(hashSeed(...)); Math.random is never used.

export const POLICIES = ['FREE_FOR_ALL', 'FCFS', 'SURGE', 'UTILITARIAN', 'RAHA'];
export const POLICY_LABEL = {
  FREE_FOR_ALL: 'As it happened (free-for-all)',
  FCFS: 'Digital queue (first-come-first-served)',
  SURGE: 'Market pricing (highest bidder)',
  UTILITARIAN: 'Pure throughput (ignore need)',
  RAHA: 'RAHA',
};
export const WEIGHTS = { v: 35, d: 30, w: 25, c: 10 }; // Score = w_v·V + w_d·D + w_w·W − w_c·C

// ---------------------------------------------------------------- randomness
export function hashSeed(...parts) {
  let h = 2166136261 >>> 0;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
export function makeRng(seed) {
  let a = seed >>> 0;
  const r = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  r.normal = () => { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  r.pickW = (ws) => { let s = 0; for (const w of ws) s += w; let x = r() * s; for (let i = 0; i < ws.length; i++) { x -= ws[i]; if (x <= 0) return i; } return ws.length - 1; };
  return r;
}

const val = (p) => (p && typeof p === 'object' && 'v' in p ? p.v : p);

// ---------------------------------------------------------------- world
// scn: entry of data/scenarios.json ; geo: data/geo/<id>.json (real distances)
export function prepareWorld(scn, geo, ov = {}) {
  const P = {};
  for (const [k, p] of Object.entries(scn.params)) P[k] = val(p);
  Object.assign(P, ov.params || {});
  const corridors = scn.corridors.map((c, i) => {
    let oneWay = val(c.oneWayMin);
    let distKm = null;
    if (oneWay == null) {
      const pl = (geo?.places || []).find((x) => x.key === c.place);
      distKm = pl ? pl.distKm : val(c.distKm);
      if (distKm == null) throw new Error(`corridor ${c.id}: no distance`);
      oneWay = (distKm * P.detour) / P.busSpeedKmh * 60 + (c.stops || 0) * P.stopDwellMin;
    }
    return { i, id: c.id, name: c.name, share: val(c.share), oneWay, distKm, deadlineShare: val(c.deadlineShare) ?? P.deadlineShare };
  });
  const vehicles = [];
  let vid = 0;
  const fleetScale = ov.fleetScale ?? 1;
  for (const g of scn.fleet) {
    const count = Math.max(0, Math.round(val(g.count) * (g.kind === 'train' ? 1 : fleetScale)));
    for (let k = 0; k < count; k++) {
      const v = { id: vid++, group: g.id, kind: g.kind, cap: val(g.cap), wc: val(g.wcSlots) || 0, doors: val(g.doors) || 2 };
      if (g.kind === 'cab' || g.kind === 'bike') break;
      if (g.kind === 'train') {
        const delay = val(g.delayMin) || 0;
        v.fixedCorr = g.corr ?? 0; v.firstAt = val(g.platformAtMin) + delay; v.departAt = val(g.departMin) + delay; v.returns = false; v.label = g.label;
      } else if (g.kind === 'regular') {
        // regular scheduled services passing the hub: spread evenly over their window, spare seats only
        const [a, b] = g.windowMin; v.firstAt = a + ((k + 0.5) / count) * (b - a); v.fixedCorr = g.corr ?? k % corridors.length; v.returns = false;
      } else {
        const at = val(g.firstAtMin); v.firstAt = Array.isArray(at) ? at[k % at.length] : at + (g.staggerMin || 0) * k; v.returns = true;
      }
      vehicles.push(v);
    }
    if (g.kind === 'cab' || g.kind === 'bike') {
      // ride-hail cabs (Koottu pools them) and geofenced two-wheeler partners reaching the pickup gates at a steady rate
      const [a, b] = g.windowMin; const rate = val(g.ratePerMin) * fleetScale; const n = Math.round(rate * (b - a));
      for (let k = 0; k < n; k++) vehicles.push({ id: vid++, group: g.id, kind: g.kind, cap: g.kind === 'bike' ? 1 : 4, wc: 0, doors: 4, firstAt: a + ((k + 0.5) / n) * (b - a), returns: false, rate });
    }
  }
  for (const c of corridors) if (c.distKm == null) c.distKm = (c.oneWay / 60) * P.busSpeedKmh / P.detour;
  const N = Math.round(P.N * (ov.demandScale ?? 1));
  return { id: scn.id, P, N, corridors, vehicles, profile: scn.arrivalProfile, horizon: P.horizonMin, cut: scn.cut || null, drift: scn.drift || null };
}

// ---------------------------------------------------------------- passengers
export function makePassengers(world, seed) {
  const R = makeRng(hashSeed('pax', world.id, seed));
  const P = world.P;
  const segW = world.profile.map((s) => s.w);
  const shares = world.corridors.map((c) => c.share);
  const pax = [];
  for (let i = 0; i < world.N; i++) {
    const s = world.profile[R.pickW(segW)];
    const arr = s.from + R() * (s.to - s.from);
    const ci = R.pickW(shares);
    const c = world.corridors[ci];
    const wc = R() < P.wheelchair;
    const assist = !wc && R() < P.assist;
    const elderly = R() < P.elderly;
    const hasDeadline = R() < c.deadlineShare;
    const deadline = hasDeadline ? arr + c.oneWay + P.deadlineSlackMin[0] + R() * (P.deadlineSlackMin[1] - P.deadlineSlackMin[0]) : null;
    const phone = R() < P.phone;
    const wtp = Math.exp(P.wtpLogMean + P.wtpLogSd * R.normal());
    const walk = P.accessWalkMin * (0.8 + 0.4 * R());
    const appDelay = R() * 2;      // minutes to open the app and check in
    const kioskQ = R();            // position factor in the kiosk queue
    const net = R();               // compared with network reach at arrival
    const drop = 0.35 + 0.65 * R(); // where along the corridor this rider gets off (fraction of corridor length)
    const circle = Math.floor(R() * (P.circles || 1)); // trusted circle (campus, company, building): pooling only inside a circle
    const quote = 1 + (R() - 0.5) * 2 * (P.quoteSpread || 0); // what this rider's phone/app quotes vs the market fare
    pax.push({ i, arr, ci, wc, assist, elderly, deadline, phone, wtp, walk, appDelay, kioskQ, net, drop, circle, quote });
  }
  pax.sort((a, b) => a.arr + a.walk - (b.arr + b.walk));
  pax.forEach((p, k) => (p.k = k));
  return pax;
}

// ---------------------------------------------------------------- Constraint 3: provider feed, chaos, parsers
export const DRIFT_CLASSES = ['rename', 'nest', 'retype', 'optional', 'garbage', 'semantic'];

export function providerMessage(v, tNowMin, onboard) {
  // what a fleet-telemetry provider sends for a vehicle reaching the bay (schema v1)
  return { vehicle_id: `V${v.id}`, capacity: v.cap, occupied: onboard, eta_s: 0, ts: Math.round(tNowMin * 60) };
}
export function mutate(msg, cls, R) {
  const m = JSON.parse(JSON.stringify(msg));
  switch (cls) {
    case 'rename': m.seat_capacity = m.capacity; delete m.capacity; return JSON.stringify(m);
    case 'nest': m.vehicle = { capacity: { total: m.capacity } }; delete m.capacity; return JSON.stringify(m);
    case 'retype': m.capacity = `${m.capacity} seats`; return JSON.stringify(m);
    case 'optional': if (R() < 0.5) delete m.capacity; return JSON.stringify(m);
    case 'garbage': { const s = JSON.stringify(m); return R() < 0.5 ? s.slice(0, Math.floor(s.length * 0.6)) : s.replace('"capacity"', '"capacıty"'); }
    case 'semantic': // same field names and types, new meaning
      if (R() < 0.5) m.eta_s = Date.UTC(2024, 8, 25, 1, 30) + m.ts * 1000;   // ETA silently becomes epoch-ms
      else m.capacity = Math.round(m.capacity * 1.6);                         // "capacity" now means crush load, not seats
      return JSON.stringify(m);
    default: return JSON.stringify(m);
  }
}
// Naive parser: what most hand-written integrations do. Throws or yields NaN on drift.
export function naiveParse(raw) {
  const m = JSON.parse(raw);
  return { capacity: m.capacity - 0, occupied: m.occupied - 0, etaMin: m.eta_s / 60 };
}
// Tolerant reader + invariants + last-known-good. Never throws; fails safe.
const ALIASES = { capacity: ['capacity', 'seat_capacity', 'vehicle.capacity.total', 'vehicle.capacity', 'cap', 'capacıty'], occupied: ['occupied', 'onboard', 'vehicle.occupied'], eta_s: ['eta_s', 'eta', 'timing.eta_s'] };
const dig = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const toNum = (x) => { if (typeof x === 'number') return Number.isFinite(x) ? x : null; if (typeof x === 'string') { const m = x.match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; } if (x && typeof x === 'object' && 'value' in x) return toNum(x.value); return null; };
export function makeAdapter(registry = new Map()) {
  // registry: vehicle id -> seats declared when the vehicle was onboarded (kept on the local edge node)
  const lkg = new Map();
  const report = { remapped: 0, coerced: 0, lkg: 0, quarantined: 0, semanticFixed: 0 };
  function read(raw, vid) {
    let m;
    try { m = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { report.quarantined++; return fromLkg(vid); }
    const out = {};
    for (const [f, paths] of Object.entries(ALIASES)) {
      let got = null;
      for (let k = 0; k < paths.length; k++) {
        const x = dig(m, paths[k]);
        if (x === undefined || x === null) continue;
        const n = toNum(x);
        if (n === null) continue;
        if (k > 0) report.remapped++;
        if (typeof x !== 'number') report.coerced++;
        got = n; break;
      }
      out[f] = got;
    }
    // invariants (semantic drift): ETA must be a plausible relative time in seconds
    if (out.eta_s != null && (out.eta_s > 4 * 3600 || out.eta_s < -600)) { report.semanticFixed++; out.eta_s = out.eta_s > 1e11 ? 0 : null; }
    const reg = registry.get(vid);
    if (out.capacity != null && reg && Math.abs(out.capacity - reg) > 0.25 * reg) { report.semanticFixed++; out.capacity = reg; }
    if (out.capacity == null || out.capacity <= 0 || out.capacity > 6000) {
      const l = lkg.get(vid);
      if (l) { report.lkg++; out.capacity = l.capacity; }
      else if (reg) { report.registry = (report.registry || 0) + 1; out.capacity = reg; }
      else return { capacity: 0, occupied: 0, etaMin: 0, degraded: true };
    }
    lkg.set(vid, { capacity: out.capacity });
    return { capacity: out.capacity, occupied: out.occupied ?? 0, etaMin: (out.eta_s ?? 0) / 60, degraded: false };
  }
  function fromLkg(vid) {
    const l = lkg.get(vid) || (registry.has(vid) ? { capacity: registry.get(vid) } : null);
    if (!l) return { capacity: 0, occupied: 0, etaMin: 0, degraded: true };
    report.lkg++; return { capacity: l.capacity, occupied: 0, etaMin: 0, degraded: true };
  }
  return { read, report };
}

// ---------------------------------------------------------------- the simulation
const quantile = (arr, q) => { if (!arr.length) return 0; const s = Float64Array.from(arr).sort(); const i = (s.length - 1) * q; const lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
export function gini(xs) { const n = xs.length; if (!n) return 0; const s = Float64Array.from(xs).sort(); let cum = 0, tot = 0; for (let i = 0; i < n; i++) { cum += (i + 1) * s[i]; tot += s[i]; } return tot === 0 ? 0 : (2 * cum) / (n * tot) - (n + 1) / n; }
export function losOf(d) { return d < 0.31 ? 'A' : d < 0.43 ? 'B' : d < 0.72 ? 'C' : d < 1.08 ? 'D' : d < 2.17 ? 'E' : 'F'; } // Fruin walkway LOS, persons/m²

export function score(p, t, world) {
  const c = world.corridors[p.ci];
  const V = p.wc ? 1 : p.assist ? 0.7 : p.elderly ? 0.5 : 0;
  const D = p.deadline == null ? 0 : Math.min(1, Math.max(0, 1 - (p.deadline - (t + c.oneWay)) / 60));
  const W = Math.max(0, (t - p.arr) / 30); // uncapped: every rider's priority keeps rising, so nobody starves
  return { S: WEIGHTS.v * V + WEIGHTS.d * D + WEIGHTS.w * W - WEIGHTS.c * 0, V, D, W };
}

/**
 * simulate(world, policy, seed, opts)
 * opts.cutAt / opts.reachAfter : Constraint 1 (internet cut at minute cutAt; phones reach fraction afterwards)
 * opts.arch : 'local' (RAHA edge node on UPS) | 'cloud' (allocator lives in the cloud)
 * opts.drift = { cls, at } and opts.parser = 'adapter' | 'naive' : Constraint 3
 * opts.doorCrush : extra dwell fraction when boarding is a free-for-all (default world.P.doorCrush)
 * opts.log : keep the per-passenger / per-trip log for 3D replay
 */
export function simulate(world, policy, seed, opts = {}) {
  const P = world.P;
  const pax = opts.pax || makePassengers(world, seed);
  const R = makeRng(hashSeed('sim', world.id, policy, seed, opts.tag || ''));
  const RC = makeRng(hashSeed('chaos', world.id, seed));
  const nC = world.corridors.length;
  const doorCrush = opts.doorCrush ?? P.doorCrush;
  const cutAt = opts.cutAt ?? null;
  const reachAfter = opts.reachAfter ?? 1;
  const arch = opts.arch || 'local';
  const drift = opts.drift || null;
  const parser = opts.parser || 'adapter';
  const adapter = makeAdapter(new Map(world.vehicles.map((v) => [v.id, v.cap])));
  const st = pax.map(() => ({ board: -1, veh: -1, issue: -1, tries: 0 }));
  const waiting = Array.from({ length: nC }, () => []);
  let ptr = 0;
  const vehs = world.vehicles.map((v) => ({ ...v, next: v.firstAt, trips: [], rr: 0 }));
  let rr = 0;
  const M = { turnedAway: 0, overbooked: 0, emptyDepartures: 0, seatsOffered: 0, seatsUsed: 0, peakDoorCrowd: 0, allocatorDownEvents: 0, fallbackBoardings: 0, idleTrips: 0 };
  const trips = [];
  const online = (t) => cutAt == null || t < cutAt;
  const phoneOk = (p) => p.phone && (online(p.arr) || p.net < reachAfter);
  const checkin = (p) => {
    // when the system knows this passenger exists
    let t = phoneOk(p) ? p.arr + p.appDelay : p.arr + p.walk + P.kioskDelayMin * (0.5 + p.kioskQ);
    if (p.wc || p.assist) t += P.lateCheckinAccessMin;
    return t;
  };
  const digital = policy !== 'FREE_FOR_ALL';
  const allocatorUp = (t) => {
    if (!digital) return false;
    if (policy === 'RAHA' && arch === 'local') return true;   // edge node on UPS: no internet needed
    if (policy === 'UTILITARIAN') return true;                        // staff-run benchmark, not network-bound
    return online(t);                                                 // FCFS app, SURGE marketplace, cloud RAHA
  };
  let served = 0;
  const horizon = world.horizon;
  // event loop over vehicle arrivals at the bay
  for (let guard = 0; guard < 200000; guard++) {
    let vi = -1, tv = Infinity;
    for (let j = 0; j < vehs.length; j++) if (vehs[j].next < tv) { tv = vehs[j].next; vi = j; }
    if (vi < 0 || tv > horizon || served >= pax.length) break;
    const v = vehs[vi];
    let t = tv;
    while (ptr < pax.length && pax[ptr].arr + pax[ptr].walk <= t) { waiting[pax[ptr].ci].push(ptr); ptr++; }
    const anyWaiting = waiting.some((w) => w.length);
    if (!anyWaiting) {
      if (v.kind === 'cab' || v.kind === 'bike') { v.next = Infinity; continue; }
      if (v.kind === 'train' || v.kind === 'regular') { recordTrip(v, t, t + 1, v.fixedCorr ?? 0, [], 0, 0); v.next = Infinity; continue; }
      if (ptr >= pax.length) { v.next = Infinity; continue; }
      v.next = Math.max(t + 0.5, pax[ptr].arr + pax[ptr].walk); M.idleTrips++; continue;
    }
    const up = allocatorUp(t);
    if (v.kind === 'cab' || v.kind === 'bike') { cabArrival(v, t, up); continue; }
    // ---------- dispatch: which corridor does this vehicle serve?
    let ci = v.fixedCorr;
    if (ci == null) {
      if (!up || policy === 'FREE_FOR_ALL') { ci = rr % nC; rr++; }
      else if (policy === 'RAHA') {
        let best = -1, bv = -Infinity;
        for (let c = 0; c < nC; c++) {
          const L = waiting[c].filter((k) => checkin(pax[k]) <= t);
          if (!L.length) continue;
          const sc = L.map((k) => score(pax[k], t, world).S).sort((a, b) => b - a);
          let s = 0; for (let q = 0; q < Math.min(v.cap, sc.length); q++) s += 10 + sc[q];
          if (v.wc > 0) s += 400 * Math.min(v.wc, L.filter((k) => pax[k].wc).length); // send ramps where wheelchair users wait
          const val2 = s / (2 * world.corridors[c].oneWay + P.layoverMin);
          if (val2 > bv) { bv = val2; best = c; }
        }
        ci = best >= 0 ? best : waiting.findIndex((w) => w.length);
      } else {
        let best = 0; for (let c = 1; c < nC; c++) if (waiting[c].length > waiting[best].length) best = c; ci = best;
      }
    }
    const corr = world.corridors[ci];
    const present = waiting[ci];
    // ---------- what the allocator believes about capacity (Constraint 3 path)
    let perceivedCap = v.cap;
    let allocatorWorks = up;
    if (up && policy !== 'FREE_FOR_ALL') {
      const msg = providerMessage(v, t, 0);
      const raw = drift && t >= drift.at ? mutate(msg, drift.cls, RC) : JSON.stringify(msg);
      if (parser === 'naive') {
        try { const r = naiveParse(raw); perceivedCap = r.capacity - r.occupied; if (!(r.etaMin >= -10 && r.etaMin <= 240)) allocatorWorks = false; }
        catch { allocatorWorks = false; }
      } else {
        const r = adapter.read(raw, v.id); perceivedCap = r.capacity - r.occupied; if (r.degraded && r.capacity === 0) allocatorWorks = false;
      }
      if (!allocatorWorks) M.allocatorDownEvents++;
    }
    // ---------- choose boarders
    const wcOk = v.wc > 0;
    let order;
    const rush = !allocatorWorks;            // free-for-all at the door
    if (rush) {
      order = present.slice();
      for (let q = order.length - 1; q > 0; q--) { const r2 = Math.floor(R() * (q + 1)); [order[q], order[r2]] = [order[r2], order[q]]; }
    } else {
      order = present.filter((k) => checkin(pax[k]) <= t);
      const walkIns = present.filter((k) => checkin(pax[k]) > t); // unknown to the system yet: may still walk up after pass holders
      if (policy === 'FCFS') order.sort((a, b) => checkin(pax[a]) - checkin(pax[b]));
      else if (policy === 'SURGE') order.sort((a, b) => pax[b].wtp - pax[a].wtp);
      else if (policy === 'UTILITARIAN') order.sort((a, b) => (pax[a].wc - pax[b].wc) || (pax[a].arr - pax[b].arr));
      else if (policy === 'RAHA') { const s = new Map(order.map((k) => [k, score(pax[k], t, world).S])); order.sort((a, b) => s.get(b) - s.get(a) || pax[a].arr - pax[b].arr); }
      order = order.concat(walkIns);
    }
    const physCap = v.cap;
    const issueLimit = rush ? Infinity : (Number.isFinite(perceivedCap) ? Math.max(0, Math.floor(perceivedCap)) : 0);
    const boarders = [];
    let wcUsed = 0, issued = 0, doorCrowd = 0;
    for (const k of order) {
      const p = pax[k];
      if (p.wc && (!wcOk || wcUsed >= v.wc)) continue;            // needs an accessible vehicle
      if (!rush && issued >= issueLimit) break;
      if (!rush) { issued++; if (st[k].issue < 0) st[k].issue = Math.max(p.arr, t - P.passLeadMin); }
      doorCrowd++;
      if (boarders.length < physCap) { boarders.push(k); if (p.wc) wcUsed++; }
      else { st[k].tries++; if (rush) M.turnedAway++; else { M.overbooked++; M.turnedAway++; } }
    }
    if (rush) doorCrowd = present.length;   // everyone for this corridor converges on the door
    else if (policy === 'RAHA') doorCrowd = Math.min(doorCrowd, Math.floor(P.doorZoneM2 * P.stagedDensity)); // staged waves from the holding area
    M.peakDoorCrowd = Math.max(M.peakDoorCrowd, doorCrowd);
    if (rush && digital) M.fallbackBoardings += boarders.length;
    // ---------- dwell, departure, bookkeeping
    const nb = boarders.length;
    let dwell = (nb * P.boardSec + wcUsed * P.wheelchairBoardSec) / v.doors / 60;
    if (rush) dwell *= 1 + doorCrush;
    dwell = Math.max(dwell, P.minDwellMin);
    let depart = t + dwell;
    if (v.departAt != null) depart = Math.max(depart, v.departAt);
    for (const k of boarders) { st[k].board = depart; st[k].veh = v.id; }
    served += nb;
    const bs = new Set(boarders);
    waiting[ci] = present.filter((k) => !bs.has(k));
    M.seatsOffered += physCap; M.seatsUsed += nb; if (nb === 0) M.emptyDepartures++;
    recordTrip(v, t, depart, ci, boarders, doorCrowd, issued, rush);
    v.next = v.returns ? depart + 2 * corr.oneWay + P.layoverMin : Infinity;
  }
  // ---------- Koottu: shared cabs at geofenced gates (surge is charged per car, not per person)
  function standalone(p) { const c = world.corridors[p.ci]; return P.cabBaseFare + P.cabPerKm * c.distKm * P.detour * p.drop; }
  function cabArrival(v, t, up) {
    const bike = v.kind === 'bike';
    const pooled = !bike && policy === 'RAHA' && up && P.cabBaseFare > 0;
    const supply10 = Math.max(0.1, v.rate * 10);
    // who would take a cab right now (riders already waiting for a bus may switch)
    const seekers = [];
    for (let c = 0; c < nC; c++) for (const k of waiting[c]) if (phoneOk(pax[k]) || pooled) seekers.push(k);
    const requests = pooled ? Math.ceil(seekers.length / 4) : seekers.length;
    const surge = Math.min(P.surgeCap, 1 + P.surgeK * Math.max(0, requests / supply10 - 1));
    if (!bike) M.peakSurge = Math.max(M.peakSurge || 1, surge);
    const gateCrowd = policy === 'RAHA' && up ? Math.ceil(seekers.length / Math.max(1, P.gates)) : seekers.length;
    M.peakGateCrowd = Math.max(M.peakGateCrowd || 0, gateCrowd);
    const solo = (k) => standalone(pax[k]) * surge * pax[k].quote * (bike ? P.bikeFareFactor : 1);
    let riders = [], shares = [], booked = 0;
    if (bike) {
      // geofenced two-wheeler partner: one rider, no wheelchair/assistance/elderly, corridor short enough for a bike
      const ok = seekers.filter((k) => { const p = pax[k]; return !p.wc && !p.assist && !p.elderly && world.corridors[p.ci].distKm <= P.bikeMaxKm && p.wtp >= solo(k) && (phoneOk(p) || (policy === 'RAHA' && up)); });
      if (ok.length) {
        let pick;
        if (policy === 'RAHA' && up) pick = ok.reduce((a, b) => (score(pax[b], t, world).S > score(pax[a], t, world).S ? b : a));
        else if (policy === 'SURGE') pick = ok.reduce((a, b) => (pax[b].wtp > pax[a].wtp ? b : a));
        else pick = ok[Math.floor(R() * ok.length)];
        riders = [pick]; shares = [solo(pick)]; booked = shares[0];
      }
    } else if (pooled) {
      // Koottu: same corridor (delivery-style batching along one route), same trusted circle, most urgent first
      let best = -1, bc = 0;
      for (let c = 0; c < nC; c++) { const n = waiting[c].filter((k) => pax[k].wtp >= solo(k) / 3).length; if (n > bc) { bc = n; best = c; } }
      if (best >= 0) {
        const ranked = waiting[best].filter((k) => !pax[k].wc).map((k) => [k, score(pax[k], t, world).S]).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
        const lead = ranked.find((k) => phoneOk(pax[k])) ?? ranked[0];
        let cand = lead == null ? [] : ranked.filter((k) => pax[k].circle === pax[lead].circle).slice(0, 8);
        for (let iter = 0; iter < 8 && cand.length; iter++) {
          const g = cand.slice(0, 4);
          if (!g.some((k) => phoneOk(pax[k]))) { cand = cand.slice(1); continue; }          // someone in the group must be able to book
          const far = Math.max(...g.map((k) => standalone(pax[k]))) * surge;                // one car to the farthest drop
          const quotes = g.filter((k) => phoneOk(pax[k])).map((k) => far * pax[k].quote);    // four phones, four quotes
          booked = Math.min(...quotes);                                                      // the cheapest phone books
          const base = airportShapley(g.map((k) => standalone(pax[k]) * surge));
          const scale = booked / base.reduce((a, b) => a + b, 0);
          const sh = base.map((x) => x * scale);
          // the guarantee is checked directly (not left to Shapley): drop anyone paying more than alone or more than they will pay
          const bad = g.findIndex((k, j) => sh[j] > solo(k) + 1e-9 || sh[j] > pax[k].wtp);
          if (bad < 0) { riders = g; shares = sh; break; }
          M.dropsForGuarantee = (M.dropsForGuarantee || 0) + 1;
          cand.splice(bad, 1);
        }
      }
    } else {
      const ok = seekers.filter((k) => phoneOk(pax[k]) && !pax[k].wc && pax[k].wtp >= solo(k));
      if (ok.length) {
        let pick;
        if (policy === 'SURGE') pick = ok.reduce((a, b) => (pax[b].wtp > pax[a].wtp ? b : a));
        else if (policy === 'FCFS' && up) pick = ok.reduce((a, b) => (checkin(pax[b]) < checkin(pax[a]) ? b : a));
        else if (policy === 'UTILITARIAN') pick = ok.reduce((a, b) => (standalone(pax[b]) < standalone(pax[a]) ? b : a));
        else pick = ok[Math.floor(R() * ok.length)];
        riders = [pick]; shares = [solo(pick)]; booked = shares[0];
      }
    }
    const depart = t + Math.max(P.minDwellMin, 1);
    const pre = bike ? 'bike' : 'cab';
    riders.forEach((k, j) => {
      st[k].board = depart; st[k].veh = v.id; st[k].fare = shares[j]; st[k].solo = solo(k);
      M[pre + 'Riders'] = (M[pre + 'Riders'] || 0) + 1; M[pre + 'Fare'] = (M[pre + 'Fare'] || 0) + shares[j]; M[pre + 'Solo'] = (M[pre + 'Solo'] || 0) + st[k].solo;
      if (!bike) M.maxShareRatio = Math.max(M.maxShareRatio || 0, shares[j] / st[k].solo);
    });
    const rs = new Set(riders);
    for (let c = 0; c < nC; c++) if (riders.length) waiting[c] = waiting[c].filter((k) => !rs.has(k));
    served += riders.length;
    if (riders.length) M[pre + 'Trips'] = (M[pre + 'Trips'] || 0) + 1; else M[pre + 'Idle'] = (M[pre + 'Idle'] || 0) + 1;
    trips.push({ v: v.id, kind: v.kind, arr: t, dep: depart, ci: riders.length ? pax[riders[0]].ci : -1, n: riders.length, cap: bike ? 1 : 4, crowd: gateCrowd, surge, booked, riders: riders.map((k) => pax[k].i), shares, solos: riders.map((k) => st[k].solo), circle: riders.length ? pax[riders[0]].circle : -1, pooled });
    v.next = Infinity;
  }
  function recordTrip(v, t, depart, ci, boarders, doorCrowd, issued, rush = false) {
    trips.push({ v: v.id, kind: v.kind, label: v.label, arr: t, dep: depart, ci, n: boarders.length, cap: v.cap, crowd: doorCrowd, issued, rush, back: v.returns ? depart + 2 * world.corridors[ci].oneWay + P.layoverMin : null });
  }
  // ---------- metrics
  const waits = [], wcW = [], dl = [], waitsAll = [];
  let clearance = 0, unserved = 0;
  for (let k = 0; k < pax.length; k++) {
    const p = pax[k], s = st[k];
    if (s.board >= 0) {
      const w = s.board - p.arr; waits.push(w); waitsAll.push(w); if (p.wc) wcW.push(w);
      clearance = Math.max(clearance, s.board);
      if (p.deadline != null) dl.push(s.board + world.corridors[p.ci].oneWay <= p.deadline ? 1 : 0);
    } else {
      unserved++; const w = horizon - p.arr; waitsAll.push(w); if (p.wc) wcW.push(w); if (p.deadline != null) dl.push(0);
    }
  }
  const t0 = world.profile[0].from;
  const res = {
    policy, seed, N: pax.length, served, unserved,
    clearanceMin: unserved ? horizon - t0 : clearance - t0,
    meanWait: waitsAll.reduce((a, b) => a + b, 0) / Math.max(1, waitsAll.length),
    medianWait: quantile(waitsAll, 0.5), p95Wait: quantile(waitsAll, 0.95), worstWait: waitsAll.length ? Math.max(...waitsAll) : 0,
    wheelchairP95: quantile(wcW, 0.95), wheelchairN: wcW.length,
    deadlinesMet: dl.length ? dl.reduce((a, b) => a + b, 0) / dl.length : null,
    gini: gini(waitsAll), seatUtil: M.seatsOffered ? M.seatsUsed / M.seatsOffered : 0,
    turnedAway: M.turnedAway, overbooked: M.overbooked, emptyDepartures: M.emptyDepartures,
    peakDoorCrowd: M.peakDoorCrowd, peakDoorDensity: M.peakDoorCrowd / P.doorZoneM2,
    allocatorDownEvents: M.allocatorDownEvents, trips: trips.length,
    cabTrips: M.cabTrips || 0, cabRiders: M.cabRiders || 0, ridersPerCab: M.cabTrips ? M.cabRiders / M.cabTrips : 0,
    cabFarePerRider: M.cabRiders ? M.cabFare / M.cabRiders : 0, cabSoloPerRider: M.cabRiders ? M.cabSolo / M.cabRiders : 0,
    maxShareRatio: M.maxShareRatio || 0, peakSurge: M.peakSurge || 1, peakGateCrowd: M.peakGateCrowd || 0, cabIdle: M.cabIdle || 0,
    bikeRiders: M.bikeRiders || 0, bikeFarePerRider: M.bikeRiders ? M.bikeFare / M.bikeRiders : 0, dropsForGuarantee: M.dropsForGuarantee || 0,
    essentialsDrops: waitsAll.filter((w) => w > P.essentialsAfterMin).length,
    driftReport: { ...adapter.report },
  };
  res.peakDoorLOS = losOf(res.peakDoorDensity);
  if (opts.log) {
    res.log = {
      pax: pax.map((p, k) => ({ arr: p.arr, walk: p.walk, ci: p.ci, wc: p.wc, assist: p.assist, elderly: p.elderly, deadline: p.deadline, issue: st[k].issue, board: st[k].board, veh: st[k].veh, tries: st[k].tries })),
      trips,
    };
  }
  return res;
}

// Shapley value of the "airport game" (Littlechild & Owen 1973): riders dropped along one corridor,
// pooled cost = cost to the farthest drop. Each increment is shared equally by everyone who needs it.
// Guarantees share_i <= standalone_i (nobody pays more than riding alone) and shares sum to the pooled fare.
export function airportShapley(costs) {
  const idx = costs.map((c, i) => [c, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(costs.length).fill(0);
  let prev = 0, acc = 0;
  idx.forEach(([c], j) => { acc += (c - prev) / (idx.length - j); prev = c; out[idx[j][1]] = acc; });
  return out;
}

// lower bound on clearance (lead's sanity bound): (ceil(N / seats per wave) - 1) * shortest round trip
export function sanityBound(world) {
  const buses = world.vehicles.filter((v) => v.returns);
  if (!buses.length) return 0;
  const wave = buses.reduce((a, v) => a + v.cap, 0);
  const minRT = Math.min(...world.corridors.map((c) => 2 * c.oneWay + world.P.layoverMin));
  return Math.max(0, (Math.ceil(world.N / wave) - 1) * minRT);
}

export function bootstrapCI(xs, R, B = 1000) {
  const n = xs.length; if (!n) return [0, 0, 0];
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const ms = new Float64Array(B);
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < n; i++) s += xs[Math.floor(R() * n)]; ms[b] = s / n; }
  ms.sort();
  return [mean, ms[Math.floor(0.025 * B)], ms[Math.floor(0.975 * B)]];
}
