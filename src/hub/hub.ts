// The hub: the single source of truth for Koottu. Every state change happens here, inside a
// transaction, and leaves an entry in the hash-chained ledger.
//
// Koottu is a layer on top of Uber, Ola and similar apps. It never controls a cab. It forms groups,
// decides who gets a scarce cab slot, compares the quotes riders see, and splits the fare. One
// rider in each group books on their own app.

import { createHmac, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { allocate, type OptionIn, type PoolIn, type UnitIn } from '../core/allocator.ts';
import { chooseBid, parseOnSearch, type BidResult, type DriverBid } from '../core/bids.ts';
import { auditPods, certify, type PodAudit } from '../core/certify.ts';
import { adapt, MAPPING_V1, proposeMapping, type Mapping } from '../core/contract.ts';
import { advise, checkFare, fareFor, KM_PER_MIN, roundShares, type Advice, type FareCheck, type FareRule, type Travel } from '../core/fare.ts';
import type { EscrowGrant, FieldOp } from '../core/field.ts';
import { canon, hashOf, rng, sha256Hex } from '../core/hash.ts';
import { coverage, pseudoPack, validatePack, type LanguagePack } from '../core/i18n.ts';
import { entryHash, GENESIS, leafHash, merkleProof, merkleRoot, type LedgerEntry } from '../core/ledger.ts';
import { evaluate, formPods, MAX_SEATS, shareable, type MatchContext, type MatchRider, type PodPlan } from '../core/match.ts';
import { newKeyPair, signToken } from '../core/pass.ts';
import { compare, POLICY_V1, prioritise, validatePolicy } from '../core/priority.ts';
import { resolveQuotes, type Quote, type QuoteResult } from '../core/quotes.ts';
import { assess } from '../core/sensors.ts';
import { pairedGap, type GapReport } from '../core/stats.ts';
import { backtest, forecast, type Backtest, type SurgeForecast, type SurgeModel } from '../core/surge.ts';
import { resolveRoute } from '../core/truth.ts';
import type {
  Alternative, Belief, CabSlot, Certificate, CertificateCheck, Decision, Need, PassPayload, Pod, Policy, Priority, Reading, Rider, RouteRecord, SensorReport, ShareWith, Witness,
} from '../core/types.ts';
import { checkBatch, scrub } from '../core/validate.ts';
import { dbscan, DESTINATIONS, EDGES, makeRiders, nearbySpots, nodeName, NODES, shortest, spotOf, SPOTS } from '../core/world.ts';
import { openDb, wipe, type DB } from './db.ts';
import { Egress } from './egress.ts';
import { SafeLog } from './safelog.ts';

export const BASE_MS = Date.parse('2026-11-06T17:30:00+05:30');
export const toMinutes = (iso: string) => Math.round((Date.parse(iso) - BASE_MS) / 60000);
export const toIso = (t: number) => new Date(BASE_MS + t * 60000).toISOString();

export function clockLabel(t: number): string {
  const d = new Date(BASE_MS + t * 60000 + 5.5 * 3600000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

const SLOT_MIN = 5;
const HORIZON_MIN = 60;
const CLARIFY_DUE_MIN = 5;
const KEY_ID = 'hub-2026';
const UPI_RESERVE_LIMIT = 10000;
const BRIDGE_TRANSFER_MIN = 6;
const DEFAULT_SPOT = 'GDY-E';
const LIVE_POD = `('FORMING','LOCKED','BOOKED','RIDING')`;
const ACTIVE_SEAT = `('HELD','COMMITTED','BOARDED')`;

export const APPS = ['Uber', 'Ola', 'Namma Yatri'];

export class HubError extends Error {
  constructor(public code: string, message: string, public http = 400) {
    super(message);
  }
}

export interface HubOptions {
  file?: string;
  keyFile?: string | null;
  logFile?: string | null;
  seed?: number;
  riders?: number;
}

/** Everything one matching round produces, before anything is written. */
export interface Plan {
  pools: PoolIn[];
  units: UnitIn[];
  plans: Map<string, PodPlan>;
  kept: Pod[];
  priorities: Map<string, Priority>;
  people: Map<string, Rider>;
  awaiting: Set<string>;
  result: ReturnType<typeof allocate>;
  match: { pairsChecked: number; edges: number; ms: number };
  slots: Map<string, CabSlot>;
}

export class Hub extends EventEmitter {
  db: DB;
  log: SafeLog;
  egress: Egress;
  file: string;
  keys: { secretHex: string; publicHex: string };
  private lastHash = GENESIS;
  private seq = 0;

  constructor(private opts: HubOptions = {}) {
    super();
    this.setMaxListeners(100);
    this.file = opts.file ?? ':memory:';
    if (this.file !== ':memory:') mkdirSync(dirname(this.file), { recursive: true });
    this.db = openDb(this.file);
    this.log = new SafeLog(opts.logFile ?? null);
    this.keys = this.loadKeys(opts.keyFile ?? null);
    this.egress = new Egress((r) => {
      this.db.prepare('INSERT INTO egress_log(at, dest, decision, reason, bytes, payload_hash) VALUES (?, ?, ?, ?, ?, ?)')
        .run(this.now, r.dest, r.decision, r.reason, r.bytes, r.payloadHash);
    });
    if (!this.meta('clock')) this.reset(opts.seed ?? 842, opts.riders ?? 1200);
    else this.resume();
  }

  private loadKeys(file: string | null) {
    if (file && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
    const k = newKeyPair();
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(k), { mode: 0o600 });
    }
    return k;
  }

  private resume() {
    const last = this.db.prepare('SELECT seq, hash FROM ledger ORDER BY seq DESC LIMIT 1').get() as { seq: number; hash: string } | undefined;
    this.seq = last?.seq ?? 0;
    this.lastHash = last?.hash ?? GENESIS;
    this.egress.offline = this.offline;
  }

  // ---------- basics ----------

  meta(key: string): string | null {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }

  setMeta(key: string, value: string | number) {
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }

  get now(): number {
    return Number(this.meta('clock') ?? 0);
  }

  get offline(): boolean {
    return this.meta('offline') === '1';
  }

  get publicKeys(): Record<string, string> {
    return { [KEY_ID]: this.keys.publicHex };
  }

  private changed() {
    this.emit('changed');
  }

  /** Appends to the hash chain. Payloads carry pseudonyms and counts, never identity data. */
  record(type: string, actor: string, payload: unknown): LedgerEntry {
    const body = { seq: this.seq + 1, at: this.now, type, actor, payload: JSON.parse(canon(payload)), prev: this.lastHash };
    const hash = entryHash(body);
    this.db.prepare('INSERT INTO ledger(seq, at, type, actor, payload, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(body.seq, body.at, type, actor, canon(payload), body.prev, hash);
    this.seq = body.seq;
    this.lastHash = hash;
    return { ...body, hash };
  }

  ledger(after = 0, limit = 200): LedgerEntry[] {
    const rows = this.db.prepare('SELECT * FROM ledger WHERE seq > ? ORDER BY seq LIMIT ?').all(after, limit) as any[];
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }

  // ---------- world ----------

  reset(seed = 842, riders = 1200) {
    wipe(this.db);
    this.seq = 0;
    this.lastHash = GENESIS;
    this.setMeta('clock', 0);
    this.setMeta('seed', seed);
    this.setMeta('offline', 0);
    this.setMeta('feed_last_good_at', -1);
    this.egress.offline = false;

    const people = makeRiders(seed, { count: riders, startAt: -10, arrivalSpreadMin: 10 });
    this.db.transaction(() => {
      this.insertRiders(people, 'SEED');
      this.extendSlots(0);
      this.seedFareHistory(seed);
      const p = POLICY_V1;
      this.db.prepare('INSERT INTO policies(version, name, doc, hash, activated_at) VALUES (?, ?, ?, ?, ?)').run(p.version, p.name, JSON.stringify(p), hashOf(p), 0);
      this.db.prepare(`INSERT INTO adapters(version, mapping, state, confidence, approved_by) VALUES ('v1', ?, 'ACTIVE', 1, 'built-in')`).run(JSON.stringify(MAPPING_V1));
    })();
    this.record('WORLD_CREATED', 'system', { seed, records: people.length, people: people.reduce((s, p) => s + p.party, 0) });
    this.matchEpoch('Opening match');
    this.changed();
  }

  /** Synthetic quotes so the fare check has history in the demo. Real use fills this from riders. */
  private seedFareHistory(seed: number) {
    const r = rng(seed + 7);
    const stmt = this.db.prepare(`INSERT INTO fare_obs(spot, app, amount, km, at, origin) VALUES (?, ?, ?, ?, ?, 'SEED')`);
    const factor: Record<string, number> = { Uber: 1, Ola: 0.96, 'Namma Yatri': 0.82 };
    for (const s of SPOTS) {
      for (const app of APPS) {
        for (let i = 0; i < 6; i++) {
          const km = 6 + r() * 14;
          stmt.run(s.id, app, fareFor(km, s.surge * factor[app] * (0.95 + r() * 0.1)), km, -Math.round(r() * 13));
          stmt.run(s.id, app, fareFor(km, 1.1 * factor[app] * (0.95 + r() * 0.1)), km, -16 - Math.round(r() * 40));
        }
      }
    }
  }

  private extendSlots(from: number) {
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO cab_slots(id, spot, at, cars_total, access_total) VALUES (?, ?, ?, ?, ?)`);
    const scale = Number(this.meta('supply_scale') ?? 1);
    const first = Math.ceil((from + 1) / SLOT_MIN) * SLOT_MIN;
    for (const s of SPOTS) {
      for (let at = first; at <= from + HORIZON_MIN; at += SLOT_MIN) {
        stmt.run(`${s.id}@${at}`, s.id, at, Math.floor(s.carsPerSlot * scale), Math.floor(s.accessPerSlot * scale));
      }
    }
  }

  insertRiders(list: Rider[], origin: string) {
    const stmt = this.db.prepare(`INSERT INTO riders(pid, circle, spot, dest, need, party, share_with, deadline_kind, deadline_at, deadline_verified, checkin_at, max_wait_min, max_detour_min, solo_fare, state, displaced, origin, bridge_to)
      VALUES (@pid, @circle, @spot, @dest, @need, @party, @shareWith, @deadlineKind, @deadlineAt, @verified, @checkinAt, @maxWaitMin, @maxDetourMin, @soloFare, @state, 0, @origin, @bridgeTo)`);
    for (const p of list) stmt.run({ ...p, verified: p.deadlineVerified ? 1 : 0, origin, bridgeTo: p.bridgeTo ?? null });
  }

  riders(where = `state IN ('WAITING','ASSIGNED','AWAITING_INFO')`): Rider[] {
    return (this.db.prepare(`SELECT * FROM riders WHERE ${where}`).all() as any[]).map(rowToRider);
  }

  rider(pid: string): Rider | null {
    const r = this.db.prepare('SELECT * FROM riders WHERE pid = ?').get(pid);
    return r ? rowToRider(r) : null;
  }

  pods(where = `state IN ${LIVE_POD}`): Pod[] {
    return (this.db.prepare(`SELECT * FROM pods WHERE ${where} ORDER BY slot_at, id`).all() as any[]).map(rowToPod);
  }

  pod(id: string): Pod | null {
    const r = this.db.prepare('SELECT * FROM pods WHERE id = ?').get(id);
    return r ? rowToPod(r) : null;
  }

  slots(): CabSlot[] {
    // Strictly after now: a slot leaving this minute has already gone.
    return (this.db.prepare('SELECT * FROM cab_slots WHERE at > ? ORDER BY at, id').all(this.now) as any[]).map(rowToSlot);
  }

  policy(): Policy {
    const r = this.db.prepare('SELECT doc FROM policies ORDER BY version DESC LIMIT 1').get() as { doc: string };
    return JSON.parse(r.doc);
  }

  /** Road times between every pair of places, avoiding routes that cannot be trusted as open. */
  travel(): Travel {
    const closed = this.closedEdges();
    const memo = new Map<string, number | null>();
    return (a, b) => {
      const k = `${a}|${b}`;
      if (!memo.has(k)) memo.set(k, a === b ? 0 : (shortest(a, b, closed)?.min ?? null));
      return memo.get(k)!;
    };
  }

  private matchContext(): MatchContext {
    return { travel: this.travel(), surge: (s) => spotOf(s)?.surge ?? 1, seats: MAX_SEATS };
  }

  private toMatch(p: Rider, rank: number): MatchRider {
    return {
      id: p.pid, spot: p.spot, node: spotOf(p.spot)!.node, circle: p.circle, dest: p.bridgeTo ?? p.dest, party: p.party, need: p.need, shareWith: p.shareWith,
      readyAt: p.checkinAt, maxWaitMin: p.maxWaitMin, maxDetourMin: p.maxDetourMin, soloFare: p.soloFare, rank,
    };
  }

  // ---------- truth about routes (C02) ----------

  routeRecords(): RouteRecord[] {
    return (this.db.prepare('SELECT * FROM route_records').all() as any[]).map((r) => ({
      route: r.route, field: r.field, value: r.value, source: r.source, observedAt: r.observed_at, receivedAt: r.received_at,
    }));
  }

  beliefs(): Belief[] {
    const recs = this.routeRecords();
    return [...new Set(recs.map((r) => r.route))].sort().map((route) => resolveRoute(route, recs, this.now));
  }

  closedEdges(): Set<string> {
    return new Set(this.beliefs().filter((b) => b.safeValue === 'SUSPENDED').map((b) => b.route));
  }

  ingestRouteRecords(list: { route: string; value: string; source: string; observedAt: number }[]) {
    const known = new Set(EDGES.map((e) => e.id));
    const before = [...this.closedEdges()].sort().join();
    const stmt = this.db.prepare(`INSERT INTO route_records(route, field, value, source, observed_at, received_at) VALUES (?, 'status', ?, ?, ?, ?)`);
    let stored = 0;
    this.db.transaction(() => {
      for (const r of list) {
        if (typeof r?.route !== 'string' || !known.has(r.route)) continue;
        if (typeof r.observedAt !== 'number' || !Number.isFinite(r.observedAt)) continue;
        stmt.run(r.route, String(r.value).toUpperCase().slice(0, 20), String(r.source).slice(0, 30), r.observedAt, this.now);
        stored++;
      }
    })();
    for (const b of this.beliefs()) if (b.state === 'UNRESOLVED') this.openVerification(b);
    const after = [...this.closedEdges()].sort().join();
    if (before !== after) {
      this.record('ROUTES_CHANGED', 'truth', { closed: after ? after.split(',') : [] });
      this.matchEpoch('Route status changed');
    }
    this.changed();
    return { stored, rejected: list.length - stored, beliefs: this.beliefs() };
  }

  private openVerification(b: Belief) {
    if (this.db.prepare(`SELECT id FROM verifications WHERE route = ? AND state = 'OPEN'`).get(b.route)) return;
    const r = this.db.prepare('INSERT INTO verifications(route, question) VALUES (?, ?)').run(b.route, `Is ${b.route} usable right now? ${b.because}`);
    this.record('VERIFICATION_REQUESTED', 'truth', { id: r.lastInsertRowid, route: b.route, because: b.because });
  }

  verifications() {
    return this.db.prepare('SELECT * FROM verifications ORDER BY id DESC').all() as any[];
  }

  answerVerification(id: number, answer: string, by: string) {
    const v = this.db.prepare('SELECT * FROM verifications WHERE id = ?').get(id) as any;
    if (!v) throw new HubError('NOT_FOUND', 'No such verification', 404);
    if (v.state !== 'OPEN') throw new HubError('ALREADY_ANSWERED', 'This verification has been answered');
    const value = String(answer).toUpperCase();
    if (!['RUNNING', 'DELAYED', 'SUSPENDED'].includes(value)) throw new HubError('BAD_ANSWER', 'Answer must be RUNNING, DELAYED or SUSPENDED');
    this.db.prepare(`UPDATE verifications SET state = 'ANSWERED', answer = ?, answered_by = ? WHERE id = ?`).run(value, by, id);
    this.record('VERIFICATION_ANSWERED', by, { id, route: v.route, answer: value });
    return this.ingestRouteRecords([{ route: v.route, value, source: 'VERIFIED', observedAt: this.now }]);
  }

  // ---------- matching ----------

  /** The whole decision for one round, with nothing written. Used live and for previews. */
  computePlan(policy: Policy, seed: string, keepLocked: boolean): Plan {
    const t = this.now;
    const ctx = this.matchContext();
    const kept = this.pods(keepLocked ? `state IN ('LOCKED','BOOKED')` : `state = 'BOOKED'`).filter((p) => p.slotId !== null);
    const keptIds = new Set(kept.map((p) => p.id));
    const inKept = new Set<string>();
    if (kept.length) {
      for (const s of this.db.prepare(`SELECT pid, pod_id FROM seats WHERE state IN ('COMMITTED','BOARDED')`).all() as any[]) {
        if (keptIds.has(s.pod_id)) inKept.add(s.pid);
      }
    }

    const people = new Map<string, Rider>();
    const priorities = new Map<string, Priority>();
    for (const p of this.riders()) {
      people.set(p.pid, p);
      priorities.set(p.pid, prioritise(p, t, policy, seed));
    }
    const order = [...people.keys()].filter((pid) => !inKept.has(pid)).sort((a, b) => compare(priorities.get(a)!, priorities.get(b)!));
    const ranked = order.map((pid, rank) => this.toMatch(people.get(pid)!, rank));

    // C12. An unconfirmed preference only matters if the answer would change who you ride with.
    const awaiting = new Set<string>();
    for (const m of ranked) {
      if (m.shareWith !== null) continue;
      const partners = (shareWith: ShareWith) =>
        ranked.filter((o) => o.id !== m.id && o.shareWith !== null && shareable({ ...m, shareWith }, o) && evaluate([{ ...m, shareWith }, o], ctx)).map((o) => o.id).join();
      if (partners('ANYONE') !== partners('WOMEN_ONLY')) awaiting.add(m.id);
    }

    const t0 = performance.now();
    const formed = formPods(ranked.filter((m) => !awaiting.has(m.id)), ctx);
    const ms = performance.now() - t0;

    const slotList = this.slots();
    const slots = new Map(slotList.map((s) => [s.id, s]));
    const pools: PoolIn[] = [];
    for (const s of slotList) {
      pools.push({ id: `${s.id}:C`, cap: s.carsTotal });
      if (s.accessTotal > 0) pools.push({ id: `${s.id}:A`, cap: s.accessTotal });
    }
    // Accessible cabs are rare. A group that needs one may meet at a nearby spot that has one,
    // so nobody is stranded just because their gate happens to have none.
    const optionsFor = (spot: string, accessible: boolean): OptionIn[] => {
      const spots = accessible ? [spot, ...nearbySpots(spot).map((n) => n.spot)] : [spot];
      return slotList.filter((s) => spots.includes(s.spot) && (!accessible || s.accessTotal > 0))
        .map((s) => ({ slot: s.id, demand: { [`${s.id}:${accessible ? 'A' : 'C'}`]: 1 } }));
    };

    const units: UnitIn[] = [];
    for (const p of kept) {
      const lock = { slot: p.slotId!, demand: { [`${p.slotId}:${p.accessible ? 'A' : 'C'}`]: 1 } };
      units.push({ id: p.id, rank: -1, options: [lock], locked: lock });
    }
    const rankOf = new Map(ranked.map((m) => [m.id, m.rank]));
    const plans = new Map<string, PodPlan>();
    const sorted = [...formed.pods].sort((a, b) => Math.min(...a.riders.map((r) => rankOf.get(r)!)) - Math.min(...b.riders.map((r) => rankOf.get(r)!)));
    sorted.forEach((plan, i) => {
      const id = `N${i}`;
      plans.set(id, plan);
      units.push({ id, rank: i, options: optionsFor(plan.spot, plan.accessible) });
    });

    return { pools, units, plans, kept, priorities, people, awaiting, result: allocate(pools, units), match: { ...formed, ms }, slots };
  }

  private podAudit(): PodAudit[] {
    const rows = this.db.prepare(`SELECT s.pod_id, s.pid, s.units, s.share, s.solo, s.detour, r.max_detour_min, r.circle, r.share_with, p.seats_total, p.fare
      FROM seats s JOIN riders r ON r.pid = s.pid JOIN pods p ON p.id = s.pod_id
      WHERE s.state IN ${ACTIVE_SEAT} AND p.state IN ('FORMING','LOCKED','BOOKED') AND r.origin != 'WALKUP'`).all() as any[];
    const map = new Map<string, PodAudit>();
    for (const r of rows) {
      if (!map.has(r.pod_id)) map.set(r.pod_id, { id: r.pod_id, seatsTotal: r.seats_total, fare: r.fare, members: [] });
      map.get(r.pod_id)!.members.push({ pid: r.pid, party: r.units, share: r.share, solo: r.solo, detour: r.detour, maxDetour: r.max_detour_min, circle: r.circle, shareWith: r.share_with });
    }
    return [...map.values()];
  }

  matchEpoch(reason: string, actor = 'system'): { epoch: number; certificate: Certificate; podChecks: CertificateCheck[]; solveMs: number; served: number; refused: number; awaiting: number; pods: number } {
    const policy = this.policy();
    const t = this.now;
    const epoch = ((this.db.prepare('SELECT MAX(id) m FROM epochs').get() as { m: number | null }).m ?? 0) + 1;
    const seed = `${this.meta('seed')}:${epoch}`;

    const t0 = performance.now();
    const plan = this.computePlan(policy, seed, true);
    const solveMs = performance.now() - t0;
    const { result, units, pools, plans, kept, priorities, people, awaiting } = plan;

    const placed = Object.fromEntries(result.placed);
    const certificate = certify({ pools, units, placed, refused: result.refused });

    // The answer is only applied if the independent checker accepts it.
    if (!certificate.ok) {
      this.record('ALLOCATION_REJECTED', 'certifier', { epoch, failed: certificate.checks.filter((c) => !c.ok).map((c) => c.id) });
      throw new HubError('CERTIFICATE_FAILED', 'The match failed its independent check and was not applied', 500);
    }

    const decisions: Decision[] = [];
    const caps = new Map(pools.map((p) => [p.id, p.cap]));
    const refusedBy = new Map(result.refused.map((r) => [r.id, r.witness]));
    const witnessStats = (w: Witness) => {
      let capacity = 0;
      let rivals = 0;
      for (const pool of w.pools) {
        capacity += caps.get(pool) ?? 0;
        rivals += (caps.get(pool) ?? 0) - (result.free.get(pool) ?? 0);
      }
      return { rivals, capacity };
    };

    let podCount = 0;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE seats SET state = 'RELEASED' WHERE state = 'HELD'`).run();
      this.db.prepare(`UPDATE pods SET state = 'DISSOLVED', seats_taken = 0 WHERE state = 'FORMING'`).run();

      const insertPod = this.db.prepare(`INSERT INTO pods(id, spot, circle, slot_id, slot_at, accessible, seats_total, seats_taken, stops, route_min, est_fare, fare, lead, state)
        VALUES (@id, @spot, @circle, @slotId, @slotAt, @accessible, @seatsTotal, @seatsTaken, @stops, @routeMin, @fare, @fare, @lead, @state)`);
      const insertSeat = this.db.prepare(`INSERT INTO seats(pid, pod_id, units, share, solo, detour, state, epoch, policy_version, pass_id, pass_token)
        VALUES (@pid, @pod, @units, @share, @solo, @detour, @state, @epoch, @policy, @passId, @token)`);
      const setState = this.db.prepare('UPDATE riders SET state = ?, displaced = ? WHERE pid = ?');

      for (const p of kept) {
        for (const s of this.db.prepare(`SELECT pid FROM seats WHERE pod_id = ? AND state IN ('COMMITTED','BOARDED')`).all(p.id) as { pid: string }[]) {
          const pr = priorities.get(s.pid);
          if (pr) decisions.push({ pid: s.pid, epoch, outcome: 'COMMITTED_KEPT', podId: p.id, priority: pr, witness: null, rivals: 0, capacity: 0 });
        }
      }

      let n = 0;
      for (const [key, pp] of plans) {
        const o = result.placed.get(key);
        if (!o) {
          const w = refusedBy.get(key)!;
          const { rivals, capacity } = witnessStats(w);
          for (const pid of pp.riders) {
            const r = people.get(pid)!;
            setState.run('WAITING', r.displaced ? 1 : 0, pid);
            decisions.push({ pid, epoch, outcome: 'WAITLISTED', podId: null, priority: priorities.get(pid)!, witness: w, rivals, capacity });
          }
          continue;
        }
        const slot = plan.slots.get(o.slot)!;
        const commit = slot.at - t <= policy.commitWindowMin;
        const podId = `G${epoch}-${++n}`;
        insertPod.run({
          id: podId, spot: slot.spot, circle: pp.circle, slotId: slot.id, slotAt: slot.at, accessible: pp.accessible ? 1 : 0, seatsTotal: pp.seats, seatsTaken: pp.seatsUsed,
          stops: JSON.stringify(pp.stops), routeMin: pp.routeMin, fare: pp.fare, lead: pp.riders[0], state: commit ? 'LOCKED' : 'FORMING',
        });
        podCount++;
        for (const pid of pp.riders) {
          const r = people.get(pid)!;
          let passId: string | null = null;
          let token: string | null = null;
          if (commit) ({ passId, token } = this.signPass(r, podId, slot.at));
          insertSeat.run({
            pid, pod: podId, units: r.party, share: pp.shares[pid], solo: r.soloFare, detour: pp.detours[pid], state: commit ? 'COMMITTED' : 'HELD', epoch, policy: policy.version, passId, token,
          });
          setState.run('ASSIGNED', r.displaced && !commit ? 1 : 0, pid);
          decisions.push({ pid, epoch, outcome: 'MATCHED', podId, priority: priorities.get(pid)!, witness: null, rivals: 0, capacity: 0 });
        }
      }

      for (const pid of awaiting) {
        const r = people.get(pid)!;
        this.clarify(r);
        setState.run('AWAITING_INFO', r.displaced ? 1 : 0, pid);
        decisions.push({ pid, epoch, outcome: 'AWAITING_INFO', podId: null, priority: priorities.get(pid)!, witness: null, rivals: 0, capacity: 0 });
      }

      this.recountSlots();

      const insertD = this.db.prepare(`INSERT INTO decisions(pid, epoch, outcome, pod_id, priority, witness, rivals, capacity, policy_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const d of decisions) {
        insertD.run(d.pid, epoch, d.outcome, d.podId, JSON.stringify(d.priority), d.witness ? JSON.stringify(d.witness) : null, d.rivals, d.capacity, policy.version);
      }

      const root = merkleRoot(decisionLeaves(decisions));
      const inputHash = hashOf({ pools, units: units.map((u) => ({ rank: u.rank, locked: u.locked?.slot ?? null, options: u.options.length })) });
      const outputHash = hashOf(decisions.map((d) => [d.pid, d.outcome]).sort());
      this.db.prepare(`INSERT INTO epochs(id, at, reason, policy_version, seed, input_hash, output_hash, merkle_root, certificate, solve_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(epoch, t, reason, policy.version, seed, inputHash, outputHash, root, JSON.stringify(certificate), solveMs);
      this.record('MATCH', actor, {
        epoch, reason, policy: policy.version, seed, inputHash, outputHash, merkleRoot: root,
        groups: podCount + kept.length, cabsAssigned: certificate.unitsSeated, refused: result.refused.length,
      });
    })();

    const podChecks = auditPods(this.podAudit());
    if (podChecks.some((c) => !c.ok)) this.record('POD_AUDIT_FAILED', 'certifier', { epoch, failed: podChecks.filter((c) => !c.ok).map((c) => c.id) });

    this.changed();
    return { epoch, certificate, podChecks, solveMs, served: certificate.unitsSeated, refused: result.refused.length, awaiting: awaiting.size, pods: podCount + kept.length };
  }

  private recountSlots() {
    this.db.exec(`UPDATE cab_slots SET
      cars_taken = (SELECT COUNT(*) FROM pods WHERE slot_id = cab_slots.id AND accessible = 0 AND state IN ${LIVE_POD}),
      access_taken = (SELECT COUNT(*) FROM pods WHERE slot_id = cab_slots.id AND accessible = 1 AND state IN ${LIVE_POD})`);
  }

  private signPass(p: Rider, podId: string, slotAt: number) {
    const passId = randomBytes(8).toString('hex');
    const payload: PassPayload = { v: 1, k: KEY_ID, p: p.pid, r: podId, u: p.need === 'WHEELCHAIR' ? 'B' : 'S', n: p.party, nb: slotAt - 30, ex: slotAt + 15, id: passId };
    return { passId, token: signToken(payload, this.keys.secretHex) };
  }

  private clarify(p: Rider) {
    if (this.db.prepare(`SELECT id FROM clarifications WHERE pid = ? AND field = 'shareWith' AND state IN ('OPEN','ESCALATED')`).get(p.pid)) return;
    const r = this.db.prepare(`INSERT INTO clarifications(pid, field, question, why, options, due_at) VALUES (?, 'shareWith', ?, ?, ?, ?)`).run(
      p.pid,
      'Who are you comfortable sharing a cab with?',
      'Your answer changes who you can be grouped with, so we will not guess.',
      JSON.stringify(['ANYONE', 'WOMEN_ONLY']),
      this.now + CLARIFY_DUE_MIN,
    );
    this.record('CLARIFICATION_REQUESTED', 'system', { id: r.lastInsertRowid, pid: p.pid, field: 'shareWith' });
  }

  clarifications(pid?: string) {
    const rows = (pid
      ? this.db.prepare('SELECT * FROM clarifications WHERE pid = ? ORDER BY id DESC').all(pid)
      : this.db.prepare('SELECT * FROM clarifications ORDER BY id DESC').all()) as any[];
    return rows.map((r) => ({ ...r, options: JSON.parse(r.options) }));
  }

  answerClarification(pid: string, id: number, value: string) {
    const c = this.db.prepare('SELECT * FROM clarifications WHERE id = ? AND pid = ?').get(id, pid) as any;
    if (!c) throw new HubError('NOT_FOUND', 'No such question', 404);
    if (c.state === 'ANSWERED') return this.riderView(pid);
    if (!JSON.parse(c.options).includes(value)) throw new HubError('BAD_ANSWER', 'That is not one of the options');
    this.db.transaction(() => {
      this.db.prepare(`UPDATE clarifications SET state = 'ANSWERED', answer = ? WHERE id = ?`).run(value, id);
      this.db.prepare(`UPDATE riders SET share_with = ?, state = 'WAITING' WHERE pid = ?`).run(value, pid);
      this.record('CLARIFICATION_ANSWERED', 'rider', { id, pid, field: c.field });
    })();
    this.matchEpoch('Question answered');
    return this.riderView(pid);
  }

  // ---------- clock ----------

  advance(minutes: number) {
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 240) throw new HubError('BAD_MINUTES', 'minutes must be between 1 and 240');
    const to = this.now + Math.round(minutes);
    this.db.transaction(() => {
      this.setMeta('clock', to);
      const leaving = this.pods(`state IN ('LOCKED','BOOKED') AND slot_at <= ${to}`);
      for (const p of leaving) {
        this.db.prepare(`UPDATE pods SET state = 'RIDING' WHERE id = ?`).run(p.id);
        this.db.prepare(`UPDATE seats SET state = 'BOARDED' WHERE pod_id = ? AND state = 'COMMITTED'`).run(p.id);
        this.db.prepare(`UPDATE riders SET state = 'RIDING' WHERE pid IN (SELECT pid FROM seats WHERE pod_id = ? AND state = 'BOARDED')`).run(p.id);
      }
      for (const p of this.pods(`state = 'RIDING' AND slot_at + route_min <= ${to}`)) {
        this.db.prepare(`UPDATE pods SET state = 'DONE' WHERE id = ?`).run(p.id);
        this.db.prepare(`UPDATE riders SET state = 'DONE' WHERE pid IN (SELECT pid FROM seats WHERE pod_id = ? AND state = 'BOARDED')`).run(p.id);
      }
      this.extendSlots(to);
      for (const c of this.db.prepare(`SELECT * FROM clarifications WHERE state = 'OPEN' AND due_at <= ?`).all(to) as any[]) {
        this.db.prepare(`UPDATE clarifications SET state = 'ESCALATED' WHERE id = ?`).run(c.id);
        this.record('CLARIFICATION_ESCALATED', 'system', { id: c.id, pid: c.pid, field: c.field, to: 'circle admin' });
      }
      this.record('CLOCK', 'operator', { to, left: leaving.length });
    })();
    return this.matchEpoch('Clock advanced');
  }

  // ---------- scarcity (C05) ----------

  /**
   * Fewer cabs than were expected. Confirmed groups keep their cab where one remains. Booked groups
   * outrank locked ones, and anyone who loses a confirmed cab is marked displaced so they go first.
   */
  cutSupply(fraction: number, reason: string) {
    const displaced: string[] = [];
    const scale = Math.max(0, Number(this.meta('supply_scale') ?? 1) * (1 - fraction));
    this.db.transaction(() => {
      this.setMeta('supply_scale', scale);
      this.db.prepare(`UPDATE seats SET state = 'RELEASED' WHERE state = 'HELD'`).run();
      this.db.prepare(`UPDATE pods SET state = 'DISSOLVED', seats_taken = 0 WHERE state = 'FORMING'`).run();
      for (const s of this.slots()) {
        const cars = Math.floor(s.carsTotal * (1 - fraction));
        const access = Math.floor(s.accessTotal * (1 - fraction));
        for (const [accessible, limit] of [[0, cars], [1, access]] as const) {
          const pods = this.db.prepare(`SELECT id FROM pods WHERE slot_id = ? AND accessible = ? AND state IN ('LOCKED','BOOKED')
            ORDER BY CASE state WHEN 'BOOKED' THEN 0 ELSE 1 END, id`).all(s.id, accessible) as { id: string }[];
          for (const { id } of pods.slice(limit)) {
            for (const seat of this.db.prepare(`SELECT pid FROM seats WHERE pod_id = ? AND state = 'COMMITTED'`).all(id) as { pid: string }[]) {
              displaced.push(seat.pid);
              this.db.prepare(`UPDATE riders SET displaced = 1, state = 'WAITING' WHERE pid = ?`).run(seat.pid);
            }
            this.db.prepare(`UPDATE seats SET state = 'RELEASED' WHERE pod_id = ? AND state = 'COMMITTED'`).run(id);
            this.db.prepare(`UPDATE pods SET state = 'DISSOLVED', seats_taken = 0 WHERE id = ?`).run(id);
          }
        }
        this.recountSlots();
        this.db.prepare('UPDATE cab_slots SET cars_total = ?, access_total = ? WHERE id = ?').run(cars, access, s.id);
      }
      this.record('SUPPLY_REDUCED', 'operator', { reason, fraction, displaced: displaced.length });
    })();
    return { displaced };
  }

  addDemand(count: number) {
    const seed = Number(this.meta('seed')) + this.now + count;
    const tag = randomBytes(2).toString('hex').toUpperCase();
    const people = makeRiders(seed, { count, startAt: this.now, arrivalSpreadMin: 0, idPrefix: `S${tag}` });
    this.db.transaction(() => this.insertRiders(people, 'SURGE'))();
    this.record('DEMAND_SURGE', 'operator', { people: count, records: people.length });
  }

  // ---------- policy (C11) ----------

  activatePolicy(doc: unknown, opts: { dryRun?: boolean; by?: string } = {}) {
    const v = validatePolicy(doc);
    if (!v.ok) throw new HubError('BAD_POLICY', v.errors.join('; '));
    const current = this.policy();
    const next: Policy = { ...current, ...v.policy, version: current.version + 1 };

    // What would happen if locked groups did not exist? Any group that would change needs a person.
    const preview = this.computePlan(next, `${this.meta('seed')}:policy:${next.version}`, false);
    const groupOf = new Map<string, string>();
    for (const [key, plan] of preview.plans) {
      if (!preview.result.placed.has(key)) continue;
      const k = [...plan.riders].sort().join();
      for (const pid of plan.riders) groupOf.set(pid, k);
    }
    const locked = this.db.prepare(`SELECT s.pid, s.pod_id FROM seats s JOIN pods p ON p.id = s.pod_id WHERE s.state = 'COMMITTED' AND p.state = 'LOCKED'`).all() as any[];
    const lockedPods = new Map<string, string[]>();
    for (const r of locked) lockedPods.set(r.pod_id, [...(lockedPods.get(r.pod_id) ?? []), r.pid]);
    const conflicts = [...lockedPods.entries()].filter(([, ids]) => ids.some((pid) => groupOf.get(pid) !== [...ids].sort().join()));

    const heldGroups = new Map<string, string[]>();
    for (const r of this.db.prepare(`SELECT pid, pod_id FROM seats WHERE state = 'HELD'`).all() as any[]) heldGroups.set(r.pod_id, [...(heldGroups.get(r.pod_id) ?? []), r.pid]);
    let recalculated = 0;
    for (const ids of heldGroups.values()) {
      const k = [...ids].sort().join();
      for (const pid of ids) if (groupOf.get(pid) !== k) recalculated++;
    }

    const riding = (this.db.prepare(`SELECT COUNT(*) c FROM seats WHERE state = 'BOARDED'`).get() as { c: number }).c;
    const diff = {
      from: current.version, to: next.version, recalculated, needApproval: conflicts.length, untouchedRiding: riding,
      tiersBefore: current.tiers.map((x) => x.label), tiersAfter: next.tiers.map((x) => x.label),
    };
    if (opts.dryRun) return { applied: false, diff, approvals: [] as number[], policy: next };

    const approvals: number[] = [];
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO policies(version, name, doc, hash, activated_at) VALUES (?, ?, ?, ?, ?)').run(next.version, next.name, JSON.stringify(next), hashOf(next), this.now);
      this.record('POLICY_ACTIVATED', opts.by ?? 'operator', { version: next.version, name: next.name, hash: hashOf(next), diff });
      const stmt = this.db.prepare(`INSERT INTO approvals(kind, subject, reason, payload) VALUES ('RELEASE_GROUP', ?, ?, ?)`);
      for (const [podId, ids] of conflicts) {
        const r = stmt.run(podId, `Policy ${next.version} would change this group, but its passes are already issued.`, JSON.stringify({ podId, riders: ids }));
        approvals.push(Number(r.lastInsertRowid));
      }
    })();
    const epoch = this.matchEpoch(`Policy ${next.version} activated`);
    return { applied: true, diff, approvals, policy: next, epoch: epoch.epoch };
  }

  approvals(state = 'PENDING') {
    return (this.db.prepare('SELECT * FROM approvals WHERE state = ? ORDER BY id').all(state) as any[]).map((a) => ({ ...a, payload: JSON.parse(a.payload) }));
  }

  decideApproval(id: number, decision: 'APPROVE' | 'REJECT', by: string) {
    const a = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as any;
    if (!a) throw new HubError('NOT_FOUND', 'No such approval', 404);
    if (a.state !== 'PENDING') throw new HubError('ALREADY_DECIDED', 'This has already been decided');
    if (!by || !String(by).trim()) throw new HubError('NAME_REQUIRED', 'Enter who is making this decision');
    const payload = JSON.parse(a.payload);
    this.db.transaction(() => {
      this.db.prepare('UPDATE approvals SET state = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', by, this.now, id);
      if (decision === 'APPROVE' && a.kind === 'RELEASE_GROUP') {
        this.db.prepare(`UPDATE seats SET state = 'RELEASED' WHERE pod_id = ? AND state = 'COMMITTED'`).run(payload.podId);
        this.db.prepare(`UPDATE pods SET state = 'DISSOLVED', seats_taken = 0 WHERE id = ?`).run(payload.podId);
        for (const pid of payload.riders) this.db.prepare(`UPDATE riders SET state = 'WAITING' WHERE pid = ?`).run(pid);
      }
      this.record('APPROVAL_DECIDED', by, { id, kind: a.kind, subject: a.subject, decision });
    })();
    if (decision === 'APPROVE' && a.kind === 'RELEASE_GROUP') this.matchEpoch('Approval applied');
    this.changed();
    return { id, state: decision };
  }

  // ---------- idempotent field writes ----------

  /** A retried request gets the original answer back and does nothing a second time. */
  private idempotent<T>(key: string, fingerprint: unknown, work: () => T): T {
    const fp = hashOf(fingerprint);
    const run = this.db.transaction(() => {
      const seen = this.db.prepare('SELECT fingerprint, response FROM idempotency WHERE key = ?').get(key) as { fingerprint: string; response: string } | undefined;
      if (seen) {
        if (seen.fingerprint !== fp) throw new HubError('KEY_REUSED', 'This opId was already used for a different request', 409);
        return JSON.parse(seen.response) as T;
      }
      const out = work();
      this.db.prepare('INSERT INTO idempotency(key, fingerprint, status, response) VALUES (?, ?, 200, ?)').run(key, fp, JSON.stringify(out));
      return out;
    });
    return run.immediate();
  }

  request(input: {
    opId: string; spot: string; dest: string; circle?: string; party?: number; need?: Need; shareWith?: ShareWith;
    deadlineKind?: Rider['deadlineKind']; deadlineInMin?: number | null; maxWaitMin?: number; maxDetourMin?: number; soloQuote?: number;
  }) {
    const opId = requireOp(input.opId);
    const spot = spotOf(String(input.spot ?? '').toUpperCase());
    if (!spot) throw new HubError('BAD_SPOT', 'That is not a pickup spot');
    const dest = String(input.dest ?? '').toUpperCase();
    if (!DESTINATIONS.includes(dest)) throw new HubError('BAD_DESTINATION', 'That is not a stop we know');
    const party = Number(input.party ?? 1);
    if (!Number.isInteger(party) || party < 1 || party > 6) throw new HubError('BAD_PARTY', 'Group size must be between 1 and 6');
    const need = input.need ?? 'NONE';
    if (!['NONE', 'ASSIST', 'WHEELCHAIR'].includes(need)) throw new HubError('BAD_NEED', 'Unknown access need');
    const shareWith = input.shareWith === undefined ? null : input.shareWith;
    if (shareWith !== null && shareWith !== 'ANYONE' && shareWith !== 'WOMEN_ONLY') throw new HubError('BAD_SHARE', 'Unknown sharing preference');
    const kind = input.deadlineKind ?? 'NONE';
    if (!['NONE', 'FLIGHT', 'RAIL', 'SHIFT', 'MEDICAL'].includes(kind)) throw new HubError('BAD_DEADLINE', 'Unknown deadline type');
    const inMin = input.deadlineInMin ?? null;
    if (kind !== 'NONE' && (typeof inMin !== 'number' || inMin < 0 || inMin > 1440)) throw new HubError('BAD_DEADLINE', 'Enter minutes until your connection');
    const maxWaitMin = Number(input.maxWaitMin ?? 15);
    const maxDetourMin = Number(input.maxDetourMin ?? 12);
    if (!(maxWaitMin >= 0 && maxWaitMin <= 60) || !(maxDetourMin >= 0 && maxDetourMin <= 60)) throw new HubError('BAD_LIMIT', 'Limits must be between 0 and 60 minutes');
    const quote = input.soloQuote;
    if (quote !== undefined && !(Number.isFinite(quote) && quote > 0 && quote < 100000)) throw new HubError('BAD_QUOTE', 'That is not a possible fare');
    const circle = String(input.circle ?? spot.circle).toUpperCase();

    const out = this.idempotent(`request:${opId}`, { spot: spot.id, dest, party, need, shareWith, kind, inMin, circle, quote }, () => {
      const pid = `R-${randomBytes(3).toString('hex').toUpperCase()}`;
      const km = (this.travel()(spot.node, dest) ?? 20) * KM_PER_MIN;
      this.insertRiders([{
        pid, circle, spot: spot.id, dest, need, party, shareWith, deadlineKind: kind, deadlineAt: kind === 'NONE' ? null : this.now + inMin!, deadlineVerified: false,
        checkinAt: this.now, maxWaitMin, maxDetourMin, soloFare: Math.round(quote ?? fareFor(km, spot.surge)), state: 'WAITING', displaced: false,
      }], 'APP');
      this.record('RIDE_REQUEST', 'rider', { pid });
      return { pid, state: 'WAITING' };
    });
    this.changed();
    return out;
  }

  cancel(opId: string, pid: string) {
    return this.idempotent(`cancel:${requireOp(opId)}`, { pid }, () => {
      const seat = this.db.prepare(`SELECT id, state, pod_id, units FROM seats WHERE pid = ? AND state IN ${ACTIVE_SEAT}`).get(pid) as any;
      if (seat?.state === 'BOARDED') throw new HubError('ALREADY_BOARDED', 'You are already on your way');
      if (seat) {
        this.db.prepare(`UPDATE seats SET state = 'RELEASED' WHERE id = ?`).run(seat.id);
        this.db.prepare('UPDATE pods SET seats_taken = seats_taken - ? WHERE id = ?').run(seat.units, seat.pod_id);
        this.reshare(seat.pod_id);
      }
      this.db.prepare(`UPDATE riders SET state = 'CANCELLED' WHERE pid = ?`).run(pid);
      this.record('CANCELLED', 'rider', { pid });
      return { state: 'CANCELLED' };
    });
  }

  /** Reprices a group after its members or fare change, keeping the fair proportions. */
  private reshare(podId: string) {
    const pod = this.pod(podId);
    if (!pod) return;
    const rows = this.db.prepare(`SELECT s.id, s.pid, s.units FROM seats s JOIN riders r ON r.pid = s.pid WHERE s.pod_id = ? AND s.state IN ${ACTIVE_SEAT} AND r.origin != 'WALKUP' ORDER BY s.id`).all(podId) as any[];
    if (rows.length === 0) {
      this.db.prepare(`UPDATE pods SET state = 'DISSOLVED', seats_taken = 0 WHERE id = ?`).run(podId);
      this.recountSlots();
      return;
    }
    const group = rows.map((r, i) => ({ ...this.toMatch(this.rider(r.pid)!, i), maxDetourMin: 999, soloFare: 1e9 }));
    const plan = evaluate(group, { ...this.matchContext(), seats: Math.max(pod.seatsTotal, MAX_SEATS) });
    if (!plan) return;
    const total = pod.bookedApp || pod.fare !== pod.estFare ? pod.fare : plan.fare;
    const shares = roundShares(group.map((g) => plan.shares[g.id]), total);
    const stmt = this.db.prepare('UPDATE seats SET share = ? WHERE id = ?');
    rows.forEach((r, i) => stmt.run(shares[i], r.id));
    this.db.prepare('UPDATE pods SET fare = ?, est_fare = ?, stops = ?, route_min = ? WHERE id = ?').run(total, pod.fare !== pod.estFare ? pod.estFare : total, JSON.stringify(plan.stops), plan.routeMin, podId);
  }

  /** C09. The conditional UPDATE is the whole trick: only one writer can take the last seat. */
  claim(input: { opId: string; pid: string; podId: string }) {
    const opId = requireOp(input.opId);
    return this.idempotent(`claim:${opId}`, { pid: input.pid, podId: input.podId }, () => {
      const p = this.rider(input.pid);
      const pod = this.pod(input.podId);
      if (!p) return { outcome: 'NOT_ELIGIBLE', reason: 'Unknown rider' };
      if (!pod || pod.state !== 'LOCKED') return { outcome: 'NOT_ELIGIBLE', reason: 'That group is not open' };
      if (pod.circle !== p.circle || pod.spot !== p.spot) return { outcome: 'NOT_ELIGIBLE', reason: 'That group is outside your circle or pickup spot' };
      if (this.db.prepare(`SELECT 1 FROM seats WHERE pid = ? AND state IN ${ACTIVE_SEAT}`).get(p.pid)) return { outcome: 'NOT_ELIGIBLE', reason: 'You are already in a group' };
      const taken = this.db.prepare(`UPDATE pods SET seats_taken = seats_taken + @n
        WHERE id = @id AND state = 'LOCKED' AND seats_taken + escrow_seats + @n <= seats_total`).run({ id: pod.id, n: p.party });
      if (taken.changes !== 1) return { outcome: 'TAKEN', reason: 'Someone else took the last seat' };
      const { passId, token } = this.signPass(p, pod.id, pod.slotAt ?? this.now);
      this.db.prepare(`INSERT INTO seats(pid, pod_id, units, share, solo, state, policy_version, pass_id, pass_token) VALUES (?, ?, ?, 0, ?, 'COMMITTED', ?, ?, ?)`)
        .run(p.pid, pod.id, p.party, p.soloFare, this.policy().version, passId, token);
      this.db.prepare(`UPDATE riders SET state = 'ASSIGNED' WHERE pid = ?`).run(p.pid);
      this.reshare(pod.id);
      this.record('SEAT_CLAIMED', 'rider', { pid: p.pid, pod: pod.id });
      return { outcome: 'WON', passId, token, podId: pod.id };
    });
  }

  // ---------- quotes, booking, paying ----------

  /** Stores a quote a rider really saw, then lets the cheapest phone become the one that books. */
  submitQuote(input: { opId: string; pid: string; podId: string; app: string; amount: number; device?: string | null }): QuoteResult {
    const opId = requireOp(input.opId);
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) throw new HubError('BAD_QUOTE', 'That is not a possible fare');
    const app = String(input.app ?? '').slice(0, 30);
    if (!app.trim()) throw new HubError('BAD_APP', 'Say which app showed this fare');
    return this.idempotent(`quote:${opId}`, { pid: input.pid, podId: input.podId, app, amount }, () => {
      const pod = this.pod(input.podId);
      if (!pod || !['LOCKED', 'FORMING'].includes(pod.state)) throw new HubError('BAD_POD', 'That group is not taking quotes');
      if (!this.db.prepare(`SELECT 1 FROM seats WHERE pid = ? AND pod_id = ? AND state IN ${ACTIVE_SEAT}`).get(input.pid, pod.id)) throw new HubError('NOT_MEMBER', 'You are not in this group', 403);
      this.db.prepare('INSERT INTO quotes(pod_id, pid, app, amount, device, observed_at) VALUES (?, ?, ?, ?, ?, ?)').run(pod.id, input.pid, app, Math.round(amount), input.device ?? null, this.now);
      this.db.prepare('INSERT INTO fare_obs(spot, app, amount, km, at) VALUES (?, ?, ?, ?, ?)').run(pod.spot, app, Math.round(amount), Math.max(1, pod.routeMin * KM_PER_MIN), this.now);
      const res = this.quoteResult(pod.id);
      if (res.best) {
        this.db.prepare('UPDATE pods SET fare = ?, lead = ? WHERE id = ?').run(res.best.amount, res.best.pid, pod.id);
        this.reshare(pod.id);
      }
      for (const g of res.gaps) this.record('PRICE_GAP_SEEN', 'rider', { pod: pod.id, app: g.app, low: g.low, high: g.high, pct: g.pct });
      return res;
    });
  }

  quoteResult(podId: string): QuoteResult {
    const rows = this.db.prepare('SELECT * FROM quotes WHERE pod_id = ? ORDER BY id').all(podId) as any[];
    const list: Quote[] = rows.map((r) => ({ pid: r.pid, app: r.app, amount: r.amount, device: r.device, observedAt: r.observed_at }));
    return resolveQuotes(list, this.now);
  }

  book(input: { opId: string; pid: string; podId: string; app: string; amount: number }) {
    const opId = requireOp(input.opId);
    return this.idempotent(`book:${opId}`, { pid: input.pid, podId: input.podId, app: input.app, amount: input.amount }, () => {
      const pod = this.pod(input.podId);
      if (!pod || pod.state !== 'LOCKED') throw new HubError('BAD_POD', 'This group cannot be booked now');
      if (pod.lead !== input.pid) throw new HubError('NOT_LEAD', 'The phone with the lowest fare books this cab', 403);
      const amount = Math.round(Number(input.amount));
      if (!(amount > 0)) throw new HubError('BAD_QUOTE', 'That is not a possible fare');
      this.db.prepare(`UPDATE pods SET state = 'BOOKED', fare = ?, booked_app = ? WHERE id = ?`).run(amount, String(input.app).slice(0, 30), pod.id);
      this.reshare(pod.id);
      this.record('BOOKED', 'rider', { pod: pod.id, app: input.app, fare: amount });
      return { podId: pod.id, state: 'BOOKED', shares: this.db.prepare(`SELECT pid, share, solo FROM seats WHERE pod_id = ? AND state IN ${ACTIVE_SEAT}`).all(pod.id) };
    });
  }

  /** Koottu never touches money: riders pay the lead directly by UPI and just confirm it here. */
  markPaid(opId: string, pid: string, podId: string) {
    return this.idempotent(`paid:${requireOp(opId)}`, { pid, podId }, () => {
      const r = this.db.prepare(`UPDATE seats SET paid = 1 WHERE pid = ? AND pod_id = ? AND state IN ${ACTIVE_SEAT}`).run(pid, podId);
      if (r.changes !== 1) throw new HubError('NOT_MEMBER', 'You are not in this group', 403);
      this.record('SHARE_PAID', 'rider', { pid, pod: podId });
      return { paid: true };
    });
  }

  /** The Check step. Works before any group exists, so it is useful on day one. */
  checkQuote(input: { spot: string; dest: string; app: string; amount: number; share?: boolean }): { check: FareCheck; advice: Advice[]; km: number; samples: number } {
    const spot = spotOf(String(input.spot ?? '').toUpperCase());
    if (!spot) throw new HubError('BAD_SPOT', 'That is not a pickup spot');
    const dest = String(input.dest ?? '').toUpperCase();
    if (!DESTINATIONS.includes(dest)) throw new HubError('BAD_DESTINATION', 'That is not a stop we know');
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) throw new HubError('BAD_QUOTE', 'That is not a possible fare');
    const app = String(input.app ?? 'Unknown').slice(0, 30);
    const km = Math.max(1, (this.travel()(spot.node, dest) ?? 20) * KM_PER_MIN);
    const rule = this.fareRule('MINI');
    const samples = (this.db.prepare('SELECT spot, app, amount, km, at FROM fare_obs WHERE at >= ?').all(this.now - 60) as any[]);
    if (input.share !== false) this.db.prepare('INSERT INTO fare_obs(spot, app, amount, km, at) VALUES (?, ?, ?, ?, ?)').run(spot.id, app, Math.round(amount), km, this.now);

    // A rough idea of the saving: what the same trip costs split with one other person.
    const shareRs = Math.round(fareFor(km, spot.surge) / 2);
    const advice = advise({ spot: spot.id, app, amount, km, now: this.now, samples, nearby: nearbySpots(spot.id), shareRs });
    return { check: checkFare(amount, km, rule), advice, km: Math.round(km * 10) / 10, samples: samples.filter((s) => s.spot === spot.id).length };
  }

  fareRule(vehicle: string): FareRule | null {
    const r = this.db.prepare('SELECT * FROM fare_rules WHERE vehicle = ?').get(vehicle) as any;
    return r ? { vehicle: r.vehicle, baseFare: r.base_fare, perKm: r.per_km, capMultiplier: r.cap_multiplier, floorMultiplier: r.floor_multiplier, verified: !!r.verified, source: r.source } : null;
  }

  /** Only a person can mark a fare table as verified. Nothing ships pre-verified. */
  setFareRule(rule: FareRule) {
    if (!rule?.vehicle || !(rule.baseFare > 0) || !(rule.perKm >= 0) || !(rule.capMultiplier >= 1)) throw new HubError('BAD_RULE', 'A fare rule needs a vehicle, base fare, per km rate and cap');
    this.db.prepare(`INSERT INTO fare_rules(vehicle, base_fare, per_km, cap_multiplier, floor_multiplier, verified, source) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(vehicle) DO UPDATE SET base_fare = excluded.base_fare, per_km = excluded.per_km, cap_multiplier = excluded.cap_multiplier,
      floor_multiplier = excluded.floor_multiplier, verified = excluded.verified, source = excluded.source`)
      .run(rule.vehicle, rule.baseFare, rule.perKm, rule.capMultiplier, rule.floorMultiplier ?? 0.5, rule.verified ? 1 : 0, String(rule.source ?? '').slice(0, 200));
    this.record('FARE_RULE_SET', 'operator', { vehicle: rule.vehicle, verified: !!rule.verified });
    return this.fareRule(rule.vehicle);
  }

  /** What a phone saves while it has a connection, so the journey survives losing it. */
  offlinePack() {
    return {
      savedAt: this.now,
      savedAtLabel: clockLabel(this.now),
      spots: SPOTS.map((s) => ({ id: s.id, name: s.name, node: s.node, circle: s.circle })),
      places: NODES.map((n) => ({ id: n.id, name: n.name })),
      closed: [...this.closedEdges()],
      samples: this.db.prepare('SELECT spot, app, amount, km, at FROM fare_obs WHERE at >= ?').all(this.now - 60),
      notes: this.beliefs().filter((b) => b.safeValue === 'SUSPENDED').map((b) => `${b.route}: treat as closed. ${b.because}`),
      publicKeys: this.publicKeys,
    };
  }

  // ---------- the buying bloc: drivers bid for the group ----------

  /** Posts one pooled request to the open network. No rider identity is in this message. */
  async requestBids(podId: string) {
    const pod = this.pod(podId);
    if (!pod || !['LOCKED', 'FORMING'].includes(pod.state)) throw new HubError('BAD_POD', 'That group cannot ask for bids now');
    const km = Math.max(1, pod.routeMin * KM_PER_MIN);
    const body = JSON.stringify({ context: { action: 'search', domain: 'mobility' }, message: { intent: { start: pod.spot, stops: pod.stops, seats: pod.seatsTaken, km: Math.round(km * 10) / 10 } } });
    const res = await this.egress.send('open-network', '/beckn/search', { method: 'POST', body });
    if (res.blocked) {
      return { ok: false as const, reason: res.blocked, message: 'Drivers cannot be reached right now. Your group and pass still work. Use a quote from your phone instead.' };
    }
    let raw: unknown = null;
    try {
      raw = JSON.parse(res.text ?? '');
    } catch {
      /* treated as no bids below */
    }
    const bids = parseOnSearch(raw);
    const result: BidResult = chooseBid(bids, pod.seatsTaken);
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO bids(id, pod_id, driver, vehicle, seats, amount, eta_min, rating, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`);
    this.db.transaction(() => {
      for (const b of bids) stmt.run(b.id, pod.id, b.driver, b.vehicle, b.seats, b.amount, b.etaMin, b.rating);
      this.record('BIDS_RECEIVED', 'network', { pod: pod.id, bids: bids.length, best: result.best?.amount ?? null });
    })();
    return { ok: true as const, ...result, soloTotal: this.podSoloTotal(pod.id), simulated: true };
  }

  private podSoloTotal(podId: string): number {
    return (this.db.prepare(`SELECT COALESCE(SUM(solo), 0) c FROM seats WHERE pod_id = ? AND state IN ${ACTIVE_SEAT}`).get(podId) as { c: number }).c;
  }

  acceptBid(input: { opId: string; pid: string; podId: string; bidId: string }) {
    return this.idempotent(`accept:${requireOp(input.opId)}`, { pid: input.pid, podId: input.podId, bidId: input.bidId }, () => {
      const pod = this.pod(input.podId);
      if (!pod || pod.state !== 'LOCKED') throw new HubError('BAD_POD', 'This group is not ready to accept a bid');
      if (pod.lead !== input.pid) throw new HubError('NOT_LEAD', 'Only the group lead can accept a bid', 403);
      const bid = this.db.prepare(`SELECT * FROM bids WHERE id = ? AND pod_id = ? AND state = 'OPEN'`).get(input.bidId, pod.id) as any;
      if (!bid) throw new HubError('BAD_BID', 'That bid is no longer open');
      this.db.prepare(`UPDATE bids SET state = CASE WHEN id = ? THEN 'WON' ELSE 'LOST' END WHERE pod_id = ?`).run(bid.id, pod.id);
      this.db.prepare('UPDATE pods SET fare = ? WHERE id = ?').run(bid.amount, pod.id);
      this.reshare(pod.id);
      this.record('BID_ACCEPTED', 'rider', { pod: pod.id, bid: bid.id, fare: bid.amount });
      return { podId: pod.id, fare: bid.amount, driver: bid.driver, shares: this.podShares(pod.id) };
    });
  }

  podShares(podId: string) {
    return this.db.prepare(`SELECT pid, share, solo FROM seats WHERE pod_id = ? AND state IN ${ACTIVE_SEAT} ORDER BY id`).all(podId) as { pid: string; share: number; solo: number }[];
  }

  // ---------- locked shares (no-shows are why pooling fails) ----------

  /**
   * Each rider blocks their share before anyone books. This models the UPI Reserve Pay lifecycle:
   * reserve, then debit or release. The gateway here is simulated and moves no money.
   */
  lockShare(input: { opId: string; pid: string; podId: string }) {
    return this.idempotent(`lock:${requireOp(input.opId)}`, { pid: input.pid, podId: input.podId }, () => {
      const pod = this.pod(input.podId);
      if (!pod || pod.state !== 'LOCKED') throw new HubError('BAD_POD', 'This group is not taking payment now');
      const seat = this.db.prepare(`SELECT share FROM seats WHERE pid = ? AND pod_id = ? AND state = 'COMMITTED'`).get(input.pid, pod.id) as { share: number } | undefined;
      if (!seat) throw new HubError('NOT_MEMBER', 'You are not in this group', 403);
      if (seat.share > UPI_RESERVE_LIMIT) throw new HubError('OVER_LIMIT', 'This share is above the UPI Reserve Pay limit');
      this.db.prepare(`INSERT INTO reservations(id, pod_id, pid, amount, state) VALUES (?, ?, ?, ?, 'RESERVED')`).run(`SIM-${randomBytes(4).toString('hex')}`, pod.id, input.pid, seat.share);
      this.record('SHARE_LOCKED', 'rider', { pid: input.pid, pod: pod.id, amount: seat.share });
      const settled = this.trySettle(pod.id);
      return { locked: true, amount: seat.share, settled };
    });
  }

  /** When every seat is locked the cab is booked and each block is debited. */
  private trySettle(podId: string): boolean {
    const pod = this.pod(podId)!;
    const seats = (this.db.prepare(`SELECT COUNT(*) c FROM seats WHERE pod_id = ? AND state = 'COMMITTED'`).get(podId) as { c: number }).c;
    const held = (this.db.prepare(`SELECT COUNT(*) c FROM reservations WHERE pod_id = ? AND state = 'RESERVED'`).get(podId) as { c: number }).c;
    if (seats === 0 || held < seats) return false;
    const won = this.db.prepare(`SELECT driver FROM bids WHERE pod_id = ? AND state = 'WON'`).get(podId) as { driver: string } | undefined;
    this.db.prepare(`UPDATE reservations SET state = 'DEBITED' WHERE pod_id = ? AND state = 'RESERVED'`).run(podId);
    this.db.prepare(`UPDATE pods SET state = 'BOOKED', booked_app = ? WHERE id = ?`).run(won ? 'Open network' : 'App quote', podId);
    this.record('GROUP_BOOKED', 'gateway', { pod: podId, fare: pod.fare, riders: seats });
    return true;
  }

  /** Anyone who has not locked in time loses their seat. Everyone else's block is released, because their share changes. */
  dropUnlocked(podId: string) {
    const pod = this.pod(podId);
    if (!pod || pod.state !== 'LOCKED') throw new HubError('BAD_POD', 'This group is not waiting on payment');
    const dropped: string[] = [];
    this.db.transaction(() => {
      const seats = this.db.prepare(`SELECT id, pid, units FROM seats WHERE pod_id = ? AND state = 'COMMITTED'`).all(podId) as any[];
      for (const s of seats) {
        if (this.db.prepare(`SELECT 1 FROM reservations WHERE pod_id = ? AND pid = ? AND state = 'RESERVED'`).get(podId, s.pid)) continue;
        dropped.push(s.pid);
        this.db.prepare(`UPDATE seats SET state = 'RELEASED' WHERE id = ?`).run(s.id);
        this.db.prepare('UPDATE pods SET seats_taken = seats_taken - ? WHERE id = ?').run(s.units, podId);
        this.db.prepare(`UPDATE riders SET state = 'WAITING' WHERE pid = ?`).run(s.pid);
      }
      this.db.prepare(`UPDATE reservations SET state = 'RELEASED' WHERE pod_id = ? AND state = 'RESERVED'`).run(podId);
      this.reshare(podId);
      this.record('NO_SHOW', 'gateway', { pod: podId, dropped: dropped.length });
    })();
    return { dropped, shares: this.podShares(podId) };
  }

  reservationsFor(podId: string) {
    return this.db.prepare('SELECT pid, amount, state, gateway FROM reservations WHERE pod_id = ? ORDER BY rowid').all(podId) as any[];
  }

  // ---------- bridge mode ----------

  /** The best working station for one trip when rail at `node` has failed, or null if none helps. */
  bridgeFor(node: string, dest: string, failed: Set<string>): { station: string; rideMin: number; metroMin: number; totalMin: number } | null {
    const closed = new Set([...this.closedEdges(), ...failed]);
    const stations = [...new Set(EDGES.filter((e) => e.mode === 'METRO' && !failed.has(e.id)).flatMap((e) => [e.a, e.b]))].filter((n) => n !== node && n !== dest);
    const direct = shortest(node, dest, closed)?.min ?? Infinity;
    let best: { station: string; rideMin: number; metroMin: number; totalMin: number } | null = null;
    for (const station of stations) {
      const ride = shortest(node, station, closed);
      const metro = shortest(station, dest, closed, ['METRO']);
      if (!ride || !metro || ride.min >= direct) continue;
      const totalMin = ride.min + BRIDGE_TRANSFER_MIN + metro.min;
      if (!best || totalMin < best.totalMin || (totalMin === best.totalMin && ride.min < best.rideMin)) best = { station, rideMin: ride.min, metroMin: metro.min, totalMin };
    }
    return best;
  }

  /**
   * A train line fails. Instead of everyone booking the whole trip home, people are grouped for the
   * short ride to the nearest station still running.
   */
  triggerBridge(node: string, reason: string) {
    const failed = new Set(EDGES.filter((e) => e.mode === 'METRO' && (e.a === node || e.b === node)).map((e) => e.id));
    const closed = this.closedEdges();
    const spots = SPOTS.filter((s) => s.node === node).map((s) => s.id);
    const riders = this.riders().filter((r) => spots.includes(r.spot) && r.state !== 'AWAITING_INFO');
    const locked = new Set((this.db.prepare(`SELECT pid FROM seats WHERE state IN ('COMMITTED','BOARDED')`).all() as any[]).map((r) => r.pid));
    let bridged = 0;
    let fullTotal = 0;
    let hopTotal = 0;
    const byStation = new Map<string, number>();
    this.db.transaction(() => {
      this.setMeta('rail_down', node);
      for (const r of riders) {
        if (locked.has(r.pid)) continue;
        const plan = this.bridgeFor(node, r.dest, failed);
        if (!plan) continue;
        const surge = spotOf(r.spot)!.surge;
        const hop = fareFor(plan.rideMin * KM_PER_MIN, surge);
        const full = fareFor((shortest(node, r.dest, closed)?.min ?? 20) * KM_PER_MIN, surge);
        this.db.prepare('UPDATE riders SET bridge_to = ?, full_fare = ?, solo_fare = ? WHERE pid = ?').run(plan.station, full, hop, r.pid);
        bridged++;
        fullTotal += full;
        hopTotal += hop;
        byStation.set(plan.station, (byStation.get(plan.station) ?? 0) + 1);
      }
      this.record('BRIDGE_MODE', 'operator', { node, reason, bridged });
    })();
    const epoch = this.matchEpoch('Bridge mode');
    return { node, bridged, fullTotal, hopTotal, stations: [...byStation.entries()].map(([station, riders]) => ({ station: nodeName(station), riders })), epoch };
  }

  // ---------- surge forecast ----------

  private surge: { model: SurgeModel; report: Backtest } | null = null;

  surgeModel() {
    this.surge ??= backtest();
    return this.surge;
  }

  setAlert(kind: 'RAIN' | 'TRANSIT', on: boolean) {
    this.setMeta(`alert_${kind}`, on ? 1 : 0);
    if (on) this.setMeta('alert_since', this.now);
    this.record('ALERT', 'operator', { kind, on });
    this.changed();
  }

  surgeForecast(spotId: string): SurgeForecast & { spot: string; current: number; synthetic: true } {
    const spot = spotOf(String(spotId).toUpperCase());
    if (!spot) throw new HubError('BAD_SPOT', 'That is not a pickup spot');
    const n = (sql: string, ...a: unknown[]) => (this.db.prepare(sql).get(...a) as { c: number }).c;
    const waiting = n(`SELECT COALESCE(SUM(party), 0) c FROM riders WHERE spot = ? AND state IN ('WAITING','ASSIGNED','AWAITING_INFO')`, spot.id);
    const cabs = n(`SELECT COALESCE(SUM(cars_total + access_total), 0) c FROM cab_slots WHERE spot = ? AND at > ? AND at <= ?`, spot.id, this.now, this.now + 15);
    const hour = ((BASE_MS + this.now * 60000 + 5.5 * 3600000) / 3600000) % 24;
    const rain = this.meta('alert_RAIN') === '1';
    const transit = this.meta('alert_TRANSIT') === '1';
    const f = forecast(this.surgeModel().model, {
      hour, weekend: false, rain, transit, newAlert: (rain || transit) && this.now - Number(this.meta('alert_since') ?? -999) <= 15,
      ratio: waiting / Math.max(1, cabs * MAX_SEATS), trend: 0, current: spot.surge,
    });
    return { ...f, spot: spot.id, current: spot.surge, synthetic: true };
  }

  // ---------- evidence ----------

  /** Compares quotes two phone types saw at the same moment. A pattern, never a verdict on why. */
  priceGapReport(): GapReport {
    const rows = this.db.prepare(`SELECT a.amount x, b.amount y FROM quotes a JOIN quotes b ON a.pod_id = b.pod_id AND a.app = b.app AND a.observed_at = b.observed_at
      WHERE a.device = 'iPhone' AND b.device = 'Android'`).all() as { x: number; y: number }[];
    return pairedGap(rows.map((r) => [r.x, r.y]), 1, ['iPhone', 'Android']);
  }

  /** A draft a rider can review and file. Only offered when a verified fare rule shows an overcharge. */
  complaintDraft(input: { spot: string; dest: string; app: string; amount: number }) {
    const { check, km } = this.checkQuote({ ...input, share: false });
    if (check.status !== 'OVER_CAP') return { ready: false, reason: check.message, draft: null };
    const spot = spotOf(String(input.spot).toUpperCase())!;
    const rule = this.fareRule('MINI')!;
    const draft = [
      'Subject: Fare above the permitted limit',
      '',
      `On ${toIso(this.now).slice(0, 10)} at about ${clockLabel(this.now)}, ${input.app} quoted me Rs ${Math.round(input.amount)} from ${spot.name} to ${nodeName(String(input.dest).toUpperCase())}, about ${km.toFixed(1)} km.`,
      `Using the base fare from ${rule.source}, the most this trip should cost at the ${rule.capMultiplier}x cap is Rs ${check.maxLegal}. The quote was ${check.multiple}x the base fare.`,
      '',
      'I request that you review this fare.',
      '',
      '[Add your name, contact details and a screenshot of the quote before filing.]',
    ].join('\n');
    this.record('COMPLAINT_DRAFTED', 'rider', { spot: spot.id, app: input.app });
    return { ready: true, reason: check.message, draft };
  }

  // ---------- escrow and field sync (C01) ----------

  grantEscrow(input: { opId: string; podId: string; device: string; seats: number }) {
    const n = Number(input.seats);
    if (!Number.isInteger(n) || n < 1 || n > 6) throw new HubError('BAD_SEATS', 'Grant between 1 and 6 seats');
    return this.idempotent(`escrow:${requireOp(input.opId)}`, { podId: input.podId, device: input.device, n }, () => {
      const pod = this.pod(input.podId);
      if (!pod || !['LOCKED', 'BOOKED'].includes(pod.state)) throw new HubError('BAD_POD', 'That group is not open');
      const ok = this.db.prepare('UPDATE pods SET escrow_seats = escrow_seats + @n WHERE id = @id AND seats_taken + escrow_seats + @n <= seats_total').run({ id: pod.id, n });
      if (ok.changes !== 1) throw new HubError('NO_SEATS', 'Not enough free seats to set aside', 409);
      const g = randomBytes(6).toString('hex');
      const grant: EscrowGrant = { v: 1, k: KEY_ID, g, r: pod.id, d: String(input.device), n };
      const token = signToken(grant, this.keys.secretHex, 'OSG');
      this.db.prepare('INSERT INTO escrow(id, pod_id, device, seats, token) VALUES (?, ?, ?, ?, ?)').run(g, pod.id, String(input.device), n, token);
      this.record('ESCROW_GRANTED', 'hub', { grant: g, pod: pod.id, device: input.device, seats: n });
      return { grantToken: token, seats: n };
    });
  }

  deviceSnapshot(podId: string, device: string) {
    const pod = this.pod(podId);
    if (!pod) throw new HubError('NOT_FOUND', 'No such group', 404);
    const manifest = this.db.prepare(`SELECT pid, pass_id passId, state, units people FROM seats WHERE pod_id = ? AND state IN ('COMMITTED','BOARDED') ORDER BY id`).all(podId);
    const grant = this.db.prepare('SELECT token FROM escrow WHERE pod_id = ? AND device = ?').get(podId, device) as { token: string } | undefined;
    return { pod, publicKeys: this.publicKeys, manifest, grantToken: grant?.token ?? null };
  }

  sync(device: string, ops: FieldOp[]) {
    if (!Array.isArray(ops) || ops.length > 2000) throw new HubError('BAD_OPS', 'ops must be a list of up to 2000 items');
    const results: { opId: string; status: string; detail: string }[] = [];
    const apply = this.db.transaction(() => {
      for (const op of ops) {
        if (typeof op?.opId !== 'string' || !op.opId) {
          results.push({ opId: String(op?.opId), status: 'REJECTED', detail: 'Missing opId' });
          continue;
        }
        const seen = this.db.prepare('SELECT result FROM field_ops WHERE op_id = ?').get(op.opId) as { result: string } | undefined;
        if (seen) {
          results.push({ opId: op.opId, status: 'DUPLICATE', detail: `Already applied: ${seen.result}` });
          continue;
        }
        let status = 'APPLIED';
        let detail = '';
        if (op.kind === 'BOARD') {
          const seat = this.db.prepare('SELECT id, state, pid FROM seats WHERE pass_id = ?').get(op.passId ?? '') as { id: number; state: string; pid: string } | undefined;
          if (!seat) {
            status = 'REJECTED';
            detail = 'Unknown pass';
          } else if (seat.state === 'BOARDED') {
            status = 'CONFLICT';
            detail = 'This pass was already used from another phone';
          } else if (seat.state !== 'COMMITTED') {
            status = 'CONFLICT';
            detail = 'This pass was released before boarding';
          } else {
            this.db.prepare(`UPDATE seats SET state = 'BOARDED' WHERE id = ?`).run(seat.id);
            this.db.prepare(`UPDATE riders SET state = 'RIDING' WHERE pid = ?`).run(seat.pid);
            detail = 'Boarded';
          }
        } else if (op.kind === 'WALKUP') {
          const party = Number(op.party);
          const grant = this.db.prepare('SELECT * FROM escrow WHERE id = ?').get(op.grantId ?? '') as any;
          if (!grant || grant.pod_id !== op.podId || !Number.isInteger(party) || party < 1) {
            status = 'REJECTED';
            detail = 'Invalid grant';
          } else if (grant.used + party > grant.seats) {
            status = 'REJECTED';
            detail = 'Grant exhausted';
          } else {
            const pod = this.pod(grant.pod_id)!;
            const pid = `W-${randomBytes(3).toString('hex').toUpperCase()}`;
            this.db.prepare('UPDATE escrow SET used = used + ? WHERE id = ?').run(party, grant.id);
            this.db.prepare('UPDATE pods SET escrow_seats = escrow_seats - ?, seats_taken = seats_taken + ? WHERE id = ?').run(party, party, pod.id);
            this.insertRiders([{
              pid, circle: pod.circle, spot: pod.spot, dest: pod.stops.at(-1) ?? 'MAS', need: 'NONE', party, shareWith: 'ANYONE', deadlineKind: 'NONE', deadlineAt: null, deadlineVerified: false,
              checkinAt: op.at, maxWaitMin: 0, maxDetourMin: 0, soloFare: 0, state: 'RIDING', displaced: false,
            }], 'WALKUP');
            this.db.prepare(`INSERT INTO seats(pid, pod_id, units, share, solo, state) VALUES (?, ?, ?, 0, 0, 'BOARDED')`).run(pid, pod.id, party);
            detail = 'Joined at the kerb';
          }
        } else {
          status = 'REJECTED';
          detail = 'Unknown op';
        }
        if (status !== 'REJECTED') this.db.prepare('INSERT INTO field_ops(op_id, device, kind, pod_id, result) VALUES (?, ?, ?, ?, ?)').run(op.opId, device, op.kind, op.podId, status);
        results.push({ opId: op.opId, status, detail });
      }
      this.record('FIELD_SYNC', 'device', { device, ops: ops.length, applied: results.filter((r) => r.status === 'APPLIED').length, duplicates: results.filter((r) => r.status === 'DUPLICATE').length });
    });
    apply.immediate();
    this.changed();
    return { results };
  }

  setOffline(on: boolean) {
    this.setMeta('offline', on ? 1 : 0);
    this.egress.offline = on;
    this.record(on ? 'NETWORK_LOST' : 'NETWORK_RESTORED', 'operator', {});
    this.changed();
  }

  // ---------- input boundary (C04, C07) ----------

  /** The real identifier is hashed with a hub secret here and is never stored. */
  pseudonym(externalId: string): string {
    return `I-${createHmac('sha256', this.keys.secretHex).update(externalId).digest('hex').slice(0, 10).toUpperCase()}`;
  }

  ingestRiders(text: string, batch = `batch-${Date.now()}`) {
    const report = checkBatch(String(text ?? ''), new Set(DESTINATIONS), new Set(SPOTS.map((s) => s.id)));
    const insertQ = this.db.prepare('INSERT INTO quarantine(batch, line, reasons, excerpt, at) VALUES (?, ?, ?, ?, ?)');
    const existing = new Set((this.db.prepare('SELECT pid FROM riders').all() as any[]).map((r) => r.pid));
    const travel = this.travel();
    let stored = 0;
    let alreadyKnown = 0;
    this.db.transaction(() => {
      for (const q of report.quarantined) insertQ.run(batch, q.line, JSON.stringify(q.reasons.map(scrub)), q.excerpt, this.now);
      const fresh: Rider[] = [];
      for (const r of report.accepted) {
        const pid = this.pseudonym(r.externalId);
        if (existing.has(pid)) {
          alreadyKnown++;
          insertQ.run(batch, 0, JSON.stringify(['Already imported in an earlier batch']), '{}', this.now);
          continue;
        }
        existing.add(pid);
        const spot = spotOf(r.spot ?? DEFAULT_SPOT)!;
        const km = (travel(spot.node, r.dest) ?? 20) * KM_PER_MIN;
        fresh.push({
          pid, circle: spot.circle, spot: spot.id, dest: r.dest, need: r.need, party: r.party, shareWith: r.shareWith, deadlineKind: r.deadlineKind,
          deadlineAt: r.deadlineAtIso ? toMinutes(r.deadlineAtIso) : null, deadlineVerified: r.deadlineVerified, checkinAt: this.now,
          maxWaitMin: 15, maxDetourMin: 12, soloFare: fareFor(km, spot.surge), state: 'WAITING', displaced: false,
        });
      }
      this.insertRiders(fresh, 'IMPORT');
      stored = fresh.length;
      this.record('BATCH_INGESTED', 'import', { batch, format: report.format, total: report.total, accepted: stored, quarantined: report.quarantined.length + alreadyKnown });
    })();
    this.log.write('info', 'batch_ingested', { batch, accepted: stored, quarantined: report.quarantined.length });
    this.changed();
    return { batch, format: report.format, total: report.total, accepted: stored, quarantined: report.quarantined, duplicates: report.duplicates + alreadyKnown };
  }

  quarantine(batch?: string) {
    const rows = (batch ? this.db.prepare('SELECT * FROM quarantine WHERE batch = ? ORDER BY id').all(batch) : this.db.prepare('SELECT * FROM quarantine ORDER BY id DESC LIMIT 500').all()) as any[];
    return rows.map((r) => ({ ...r, reasons: JSON.parse(r.reasons) }));
  }

  // ---------- external feed (C03) ----------

  private activeMapping(): Mapping {
    const r = this.db.prepare(`SELECT mapping FROM adapters WHERE state = 'ACTIVE' ORDER BY rowid DESC LIMIT 1`).get() as { mapping: string };
    return JSON.parse(r.mapping);
  }

  feedState() {
    const adapters = (this.db.prepare('SELECT * FROM adapters ORDER BY rowid').all() as any[]).map((a) => ({ ...a, mapping: JSON.parse(a.mapping), notes: JSON.parse(a.notes) }));
    const last = Number(this.meta('feed_last_good_at'));
    return { adapters, lastGoodAt: last < 0 ? null : last, ageMin: last < 0 ? null : this.now - last, lastError: this.meta('feed_last_error') };
  }

  /** Any failure here stops at the boundary: routes keep their last good state. */
  async pollFeed(rawOverride?: string) {
    let text = rawOverride ?? null;
    if (text === null) {
      const res = await this.egress.send('transit-feed', '/transit/status');
      if (res.blocked) {
        this.setMeta('feed_last_error', res.blocked);
        return { ok: false, reason: res.blocked, stored: 0, keptLastGood: true };
      }
      text = res.text ?? '';
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.setMeta('feed_last_error', 'INVALID_JSON');
      this.record('FEED_REJECTED', 'adapter', { reason: 'Response is not valid JSON', hash: sha256Hex(text) });
      return { ok: false, reason: 'INVALID_JSON', stored: 0, keptLastGood: true };
    }
    const mapping = this.activeMapping();
    const res = adapt(raw, mapping);
    if (!res.ok) {
      this.setMeta('feed_last_error', 'CONTRACT_CHANGED');
      this.record('FEED_REJECTED', 'adapter', { adapter: mapping.version, errors: res.errors.slice(0, 5), hash: sha256Hex(text) });
      const version = `v${(this.db.prepare('SELECT COUNT(*) c FROM adapters').get() as { c: number }).c + 1}`;
      const proposal = proposeMapping(raw, version);
      const pending = this.db.prepare(`SELECT version FROM adapters WHERE state = 'PROPOSED'`).get();
      if (proposal?.complete && !pending) {
        this.db.prepare(`INSERT INTO adapters(version, mapping, state, confidence, notes) VALUES (?, ?, 'PROPOSED', ?, ?)`)
          .run(version, JSON.stringify(proposal.mapping), proposal.confidence, JSON.stringify(proposal.notes));
        this.record('ADAPTER_PROPOSED', 'adapter', { version, confidence: proposal.confidence });
      }
      this.changed();
      return { ok: false, reason: 'CONTRACT_CHANGED', errors: res.errors.slice(0, 5), stored: 0, keptLastGood: true, proposal: proposal ?? null };
    }
    this.setMeta('feed_last_error', '');
    this.setMeta('feed_last_good_at', this.now);
    // A record with no timestamp cannot be called fresh, so its route keeps its last good state.
    const dated = res.records.filter((r) => r.observedAtIso !== null);
    const undated = res.records.length - dated.length;
    const stored = this.ingestRouteRecords(dated.map((r) => ({ route: r.route, value: r.status, source: 'OPERATOR_FEED', observedAt: toMinutes(r.observedAtIso!) }))).stored;
    return { ok: true, stored, undated, rejected: res.errors, unknownFields: res.unknownFields, adapter: mapping.version, keptLastGood: undated > 0 };
  }

  approveAdapter(version: string, by: string) {
    if (!by || !String(by).trim()) throw new HubError('NAME_REQUIRED', 'Enter who is approving this mapping');
    const r = this.db.prepare(`UPDATE adapters SET state = 'ACTIVE', approved_by = ? WHERE version = ? AND state = 'PROPOSED'`).run(by, version);
    if (r.changes !== 1) throw new HubError('NOT_FOUND', 'No such proposed mapping', 404);
    this.db.prepare(`UPDATE adapters SET state = 'RETIRED' WHERE version != ? AND state = 'ACTIVE'`).run(version);
    this.record('ADAPTER_APPROVED', by, { version });
    this.changed();
    return this.feedState();
  }

  // ---------- trip telemetry (C10) ----------

  ingestTelemetry(list: Reading[]) {
    const stmt = this.db.prepare('INSERT INTO telemetry(ride_id, observed_at, received_at, lat, lng, odo_km, occupancy) VALUES (?, ?, ?, ?, ?, ?, ?)');
    let stored = 0;
    this.db.transaction(() => {
      for (const r of list) {
        if (typeof r?.vehicleId !== 'string' || !/^[\w-]{1,40}$/.test(r.vehicleId) || typeof r.observedAt !== 'number' || !Number.isFinite(r.observedAt)) continue;
        stmt.run(r.vehicleId, r.observedAt, r.receivedAt ?? this.now, r.lat ?? null, r.lng ?? null, r.odoKm ?? null, r.occupancy ?? null);
        stored++;
      }
    })();
    return { stored, rejected: list.length - stored };
  }

  sensorReport(rideId: string): SensorReport {
    const rows = this.db.prepare('SELECT * FROM telemetry WHERE ride_id = ? ORDER BY id DESC LIMIT 60').all(rideId) as any[];
    if (rows.length === 0) throw new HubError('NOT_FOUND', 'No readings for this ride', 404);
    const stream: Reading[] = rows.map((r) => ({ vehicleId: rideId, observedAt: r.observed_at, receivedAt: r.received_at, lat: r.lat, lng: r.lng, odoKm: r.odo_km, occupancy: r.occupancy })).reverse();
    const pod = this.pod(rideId);
    return assess(rideId, stream, { capacity: pod?.seatsTotal ?? MAX_SEATS, manifest: pod?.seatsTaken ?? 3, now: this.now });
  }

  sensorReports(): SensorReport[] {
    const ids = (this.db.prepare('SELECT DISTINCT ride_id v FROM telemetry ORDER BY v').all() as { v: string }[]).map((r) => r.v);
    return ids.map((id) => this.sensorReport(id));
  }

  /** A real unexplained stop asks the riders if they are safe. Nothing is triggered automatically. */
  raiseSafetyCheck(r: SensorReport) {
    if (r.verdict !== 'GENUINE_STOP') return null;
    const open = this.db.prepare(`SELECT id FROM approvals WHERE kind = 'SAFETY_CHECK' AND subject = ? AND state = 'PENDING'`).get(r.vehicleId) as { id: number } | undefined;
    if (open) return open.id;
    const a = this.db.prepare(`INSERT INTO approvals(kind, subject, reason, payload) VALUES ('SAFETY_CHECK', ?, ?, ?)`).run(r.vehicleId, 'The ride has stopped unexpectedly. Ask the riders if they are safe.', JSON.stringify({ flags: r.flags }));
    this.record('SAFETY_CHECK', 'sentinel', { ride: r.vehicleId, verdict: r.verdict });
    return Number(a.lastInsertRowid);
  }

  // ---------- language (C08) ----------

  packs(): LanguagePack[] {
    const rows = this.db.prepare('SELECT doc FROM lang_packs ORDER BY code').all() as { doc: string }[];
    return [...rows.map((r) => JSON.parse(r.doc) as LanguagePack), pseudoPack()];
  }

  loadPack(doc: unknown) {
    const v = validatePack(doc);
    if (!v.ok) throw new HubError('BAD_PACK', v.errors.join('; '));
    this.db.prepare('INSERT INTO lang_packs(code, doc) VALUES (?, ?) ON CONFLICT(code) DO UPDATE SET doc = excluded.doc').run(v.pack.code, JSON.stringify(v.pack));
    const c = coverage(v.pack);
    this.record('LANGUAGE_LOADED', 'operator', { code: v.pack.code, translated: c.translated, total: c.total, criticalVerified: c.criticalVerified, critical: c.critical });
    this.changed();
    return { pack: v.pack, coverage: c };
  }

  // ---------- reads ----------

  latestEpoch() {
    const e = this.db.prepare('SELECT * FROM epochs ORDER BY id DESC LIMIT 1').get() as any;
    return e ? { ...e, certificate: JSON.parse(e.certificate) as Certificate } : null;
  }

  latestDecision(pid: string): Decision | null {
    const r = this.db.prepare('SELECT * FROM decisions WHERE pid = ? ORDER BY epoch DESC LIMIT 1').get(pid) as any;
    return r ? rowToDecision(r) : null;
  }

  decisions(outcome: string | null, limit = 100, epoch?: number): Decision[] {
    const e = epoch ?? this.latestEpoch()?.id ?? 0;
    const rows = (outcome
      ? this.db.prepare('SELECT * FROM decisions WHERE epoch = ? AND outcome = ? ORDER BY pid LIMIT ?').all(e, outcome, limit)
      : this.db.prepare('SELECT * FROM decisions WHERE epoch = ? ORDER BY pid LIMIT ?').all(e, limit)) as any[];
    return rows.map(rowToDecision);
  }

  proof(pid: string) {
    const d = this.latestDecision(pid);
    if (!d) throw new HubError('NOT_FOUND', 'No decision recorded for this rider', 404);
    const all = (this.db.prepare('SELECT * FROM decisions WHERE epoch = ?').all(d.epoch) as any[]).map(rowToDecision).sort((a, b) => (a.pid < b.pid ? -1 : 1));
    const leaves = decisionLeaves(all);
    const index = all.findIndex((x) => x.pid === pid);
    const epoch = this.db.prepare('SELECT merkle_root FROM epochs WHERE id = ?').get(d.epoch) as { merkle_root: string };
    return { epoch: d.epoch, leaf: leaves[index], value: leafValue(all[index]), proof: merkleProof(leaves, index), root: epoch.merkle_root };
  }

  alternatives(p: Rider): Alternative[] {
    const out: Alternative[] = [];
    const free = (spot: string) => this.slots().find((s) => s.spot === spot && s.carsTaken < s.carsTotal);
    const here = free(p.spot);
    out.push({
      kind: 'NEXT_SLOT', title: 'Stay in the queue here', etaMin: here ? Math.max(1, here.at - this.now) : null, costRs: null, stepFree: true,
      detail: 'Your priority rises the longer you wait, and you are matched as soon as a cab is free.',
    });
    for (const n of nearbySpots(p.spot)) {
      const s = free(n.spot);
      if (s) out.push({ kind: 'WALK', title: `Walk ${n.walkMin} min to ${n.name}`, etaMin: Math.max(n.walkMin, s.at - this.now), costRs: null, stepFree: p.need !== 'WHEELCHAIR', detail: 'Cabs are free there sooner.' });
    }
    out.push({ kind: 'SOLO', title: 'Book alone in your app', etaMin: null, costRs: p.soloFare, stepFree: true, detail: 'You can always go alone. This is what it costs right now.' });
    const route = shortest(spotOf(p.spot)!.node, p.dest, this.closedEdges(), ['METRO', 'ROAD']);
    if (route) {
      const stepFree = route.path.every((n) => NODES.find((x) => x.id === n)!.stepFree);
      if (p.need !== 'WHEELCHAIR' || stepFree) {
        out.push({ kind: 'METRO', title: `Metro and road via ${route.path.slice(1, -1).map(nodeName).join(', ') || 'direct'}`, etaMin: route.min, costRs: null, stepFree, detail: stepFree ? 'Step-free the whole way.' : 'Includes stairs at some stations.' });
      }
    }
    return out;
  }

  explain(d: Decision, p: Rider, pod: Pod | null, share: number | null): { headline: string; lines: string[] } {
    const parts = d.priority.parts.map((x) => `${x.label}: +${x.points} (${x.detail})`);
    const spot = spotOf(p.spot)?.name ?? p.spot;
    if ((d.outcome === 'MATCHED' || d.outcome === 'COMMITTED_KEPT') && pod) {
      const cost = share !== null ? ` You pay Rs ${share} instead of Rs ${p.soloFare}.` : '';
      return { headline: `You are in a group at ${spot}, leaving at ${clockLabel(pod.slotAt ?? this.now)}.${cost}`, lines: [`Priority group: ${d.priority.tierLabel}`, ...parts, `Priority score: ${d.priority.score}`] };
    }
    if (d.outcome === 'AWAITING_INFO') {
      return { headline: 'We need one answer before we can group you.', lines: ['Your answer changes who you can ride with, so we will not guess.'] };
    }
    if (d.witness?.kind === 'NO_OPTION') {
      return { headline: `No cabs are expected at ${spot} in the next hour.`, lines: ['See your other options below.'] };
    }
    return {
      headline: `All ${d.capacity} cabs expected at ${spot} in the next hour are taken by groups ahead of you.`,
      lines: ['No rearrangement of groups could free a cab for you. This is checked, not estimated.', `Priority group: ${d.priority.tierLabel}`, ...parts, `Priority score: ${d.priority.score}`],
    };
  }

  riderView(pid: string) {
    const p = this.rider(pid);
    if (!p) throw new HubError('NOT_FOUND', 'No such rider', 404);
    const seat = this.db.prepare(`SELECT * FROM seats WHERE pid = ? AND state IN ${ACTIVE_SEAT}`).get(pid) as any;
    const pod = seat ? this.pod(seat.pod_id) : null;
    const decision = this.latestDecision(pid);
    const open = this.clarifications(pid).find((c) => c.state === 'OPEN' || c.state === 'ESCALATED') ?? null;
    const members = seat ? (this.db.prepare(`SELECT COUNT(*) c FROM seats WHERE pod_id = ? AND state IN ${ACTIVE_SEAT}`).get(seat.pod_id) as { c: number }).c : 0;
    return {
      rider: p,
      seat: seat ? { state: seat.state, units: seat.units, share: seat.share, solo: seat.solo, saved: seat.solo - seat.share, detourMin: seat.detour, paid: !!seat.paid, passId: seat.pass_id } : null,
      pod: pod ? { ...pod, spotName: spotOf(pod.spot)?.name, leavesLabel: pod.slotAt === null ? null : clockLabel(pod.slotAt), stopNames: pod.stops.map(nodeName), members, isLead: pod.lead === pid } : null,
      pass: seat?.pass_token ?? null,
      decision,
      explanation: decision ? this.explain(decision, p, pod, seat?.share ?? null) : null,
      alternatives: seat ? [] : this.alternatives(p),
      clarification: open,
      bridge: p.bridgeTo ? { station: nodeName(p.bridgeTo), fullFare: (this.db.prepare('SELECT full_fare f FROM riders WHERE pid = ?').get(pid) as { f: number | null }).f } : null,
      locked: seat ? !!this.db.prepare(`SELECT 1 FROM reservations WHERE pid = ? AND pod_id = ? AND state IN ('RESERVED','DEBITED')`).get(pid, seat.pod_id) : false,
      publicKeys: this.publicKeys,
      // Every phone keeps a copy of the head it saw, so the ledger's tail cannot quietly vanish.
      ledgerHead: { seq: this.seq, hash: this.lastHash },
    };
  }

  cohorts(): { clusters: number; ms: number; groups: { node: string; people: number; wheelchairs: number; deadlines: number }[] } {
    const list = this.riders();
    const points = list.map((p) => {
      const n = NODES.find((x) => x.id === p.dest)!;
      const h = parseInt(sha256Hex(p.pid).slice(0, 8), 16);
      return { id: p.pid, lat: n.lat + (((h & 0xfff) / 0xfff) - 0.5) * 0.012, lng: n.lng + ((((h >> 12) & 0xfff) / 0xfff) - 0.5) * 0.012 };
    });
    const t0 = performance.now();
    const { labels, clusters } = dbscan(points, 0.6, 4);
    const ms = performance.now() - t0;
    const groups = new Map<number, { nodes: Map<string, number>; people: number; wheelchairs: number; deadlines: number }>();
    labels.forEach((label, i) => {
      if (label < 0) return;
      const g = groups.get(label) ?? { nodes: new Map(), people: 0, wheelchairs: 0, deadlines: 0 };
      const p = list[i];
      g.nodes.set(p.dest, (g.nodes.get(p.dest) ?? 0) + p.party);
      g.people += p.party;
      if (p.need === 'WHEELCHAIR') g.wheelchairs++;
      if (p.deadlineKind !== 'NONE') g.deadlines++;
      groups.set(label, g);
    });
    return {
      clusters, ms: Math.round(ms * 10) / 10,
      groups: [...groups.values()].map((g) => ({ node: nodeName([...g.nodes.entries()].sort((a, b) => b[1] - a[1])[0][0]), people: g.people, wheelchairs: g.wheelchairs, deadlines: g.deadlines })).sort((a, b) => b.people - a.people),
    };
  }

  state() {
    const n = (sql: string, ...args: unknown[]) => (this.db.prepare(sql).get(...args) as { c: number }).c;
    const people = (where: string) => n(`SELECT COALESCE(SUM(party), 0) c FROM riders WHERE ${where}`);
    const pods = this.pods(`state IN ('FORMING','LOCKED','BOOKED')`);
    const seated = this.db.prepare(`SELECT COUNT(*) bookings, COALESCE(SUM(s.units), 0) people, COALESCE(SUM(s.solo), 0) solo, COALESCE(SUM(s.share), 0) paid
      FROM seats s JOIN pods p ON p.id = s.pod_id JOIN riders r ON r.pid = s.pid WHERE s.state IN ${ACTIVE_SEAT} AND p.state IN ('FORMING','LOCKED','BOOKED') AND r.origin != 'WALKUP'`).get() as any;
    const over = n('SELECT COUNT(*) c FROM pods WHERE seats_taken + escrow_seats > seats_total') + n('SELECT COUNT(*) c FROM cab_slots WHERE cars_taken > cars_total OR access_taken > access_total');
    const beliefs = this.beliefs();
    const epoch = this.latestEpoch();
    const slots = this.slots();
    return {
      clock: this.now,
      clockLabel: clockLabel(this.now),
      offline: this.offline,
      policy: { version: this.policy().version, name: this.policy().name },
      alerts: { rain: this.meta('alert_RAIN') === '1', transit: this.meta('alert_TRANSIT') === '1', railDown: this.meta('rail_down') },
      kpis: {
        waiting: people(`state IN ('WAITING','ASSIGNED','AWAITING_INFO')`),
        waitlisted: epoch ? n(`SELECT COUNT(*) c FROM decisions WHERE epoch = ? AND outcome = 'WAITLISTED'`, epoch.id) : 0,
        grouped: seated.people,
        groups: pods.length,
        riding: people(`state = 'RIDING'`),
        done: people(`state = 'DONE'`),
        awaitingInfo: people(`state = 'AWAITING_INFO'`),
        cabsAvoided: Math.max(0, seated.bookings - pods.length),
        peoplePerCab: pods.length ? Math.round((seated.people / pods.length) * 10) / 10 : 0,
        ridersSavedRs: seated.solo - seated.paid,
        soloCostRs: seated.solo,
        cabsAvailable: slots.reduce((s, x) => s + x.carsTotal + x.accessTotal, 0),
        cabsAssigned: slots.reduce((s, x) => s + x.carsTaken + x.accessTaken, 0),
        overAllocated: over,
        unresolvedRoutes: beliefs.filter((b) => b.state !== 'TRUSTED').length,
        pendingApprovals: n(`SELECT COUNT(*) c FROM approvals WHERE state = 'PENDING'`),
        quarantined: n('SELECT COUNT(*) c FROM quarantine'),
      },
      spots: SPOTS.map((s) => ({
        id: s.id, name: s.name, circle: s.circle, surge: s.surge,
        waiting: people(`spot = '${s.id}' AND state IN ('WAITING','ASSIGNED','AWAITING_INFO')`),
        groups: pods.filter((p) => p.spot === s.id).length,
        cabs: slots.filter((x) => x.spot === s.id).reduce((a, x) => a + x.carsTotal + x.accessTotal, 0),
      })),
      pods: pods.slice(0, 60).map((p) => ({ ...p, spotName: spotOf(p.spot)?.name, leavesLabel: p.slotAt === null ? null : clockLabel(p.slotAt), stopNames: p.stops.map(nodeName) })),
      closed: [...this.closedEdges()],
      epoch: epoch ? { id: epoch.id, reason: epoch.reason, solveMs: Math.round(epoch.solve_ms * 10) / 10, certificateOk: epoch.certificate.ok, root: epoch.merkle_root } : null,
      feed: { lastError: this.meta('feed_last_error') || null },
      ledgerHead: { seq: this.seq, hash: this.lastHash },
    };
  }

  close() {
    this.db.close();
  }
}

function requireOp(opId: unknown): string {
  if (typeof opId !== 'string' || opId.length < 4 || opId.length > 80) throw new HubError('OP_REQUIRED', 'Every write needs an opId so retries are safe');
  return opId;
}

function leafValue(d: Decision) {
  return { pid: d.pid, epoch: d.epoch, outcome: d.outcome, podId: d.podId, tier: d.priority.tierId, score: d.priority.score };
}

function decisionLeaves(list: Decision[]): string[] {
  return [...list].sort((a, b) => (a.pid < b.pid ? -1 : 1)).map((d) => leafHash(leafValue(d)));
}

function rowToRider(r: any): Rider {
  return {
    pid: r.pid, circle: r.circle, spot: r.spot, dest: r.dest, need: r.need, party: r.party, shareWith: r.share_with, deadlineKind: r.deadline_kind, deadlineAt: r.deadline_at,
    deadlineVerified: !!r.deadline_verified, checkinAt: r.checkin_at, maxWaitMin: r.max_wait_min, maxDetourMin: r.max_detour_min, soloFare: r.solo_fare, state: r.state, displaced: !!r.displaced, bridgeTo: r.bridge_to,
  };
}

function rowToPod(r: any): Pod {
  return {
    id: r.id, spot: r.spot, circle: r.circle, slotId: r.slot_id, slotAt: r.slot_at, accessible: !!r.accessible, seatsTotal: r.seats_total, seatsTaken: r.seats_taken, escrowSeats: r.escrow_seats,
    stops: JSON.parse(r.stops), routeMin: r.route_min, estFare: r.est_fare, fare: r.fare, lead: r.lead, bookedApp: r.booked_app, state: r.state,
  };
}

function rowToSlot(r: any): CabSlot {
  return { id: r.id, spot: r.spot, at: r.at, carsTotal: r.cars_total, carsTaken: r.cars_taken, accessTotal: r.access_total, accessTaken: r.access_taken };
}

function rowToDecision(r: any): Decision {
  return {
    pid: r.pid, epoch: r.epoch, outcome: r.outcome, podId: r.pod_id, priority: JSON.parse(r.priority),
    witness: r.witness ? JSON.parse(r.witness) : null, rivals: r.rivals, capacity: r.capacity,
  };
}
