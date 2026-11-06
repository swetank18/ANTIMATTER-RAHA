// The hub: the single source of truth. Every state change happens here, inside a transaction,
// and leaves an entry in the hash-chained ledger.

import { randomBytes, createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { allocate, type OptionIn, type PoolIn, type UnitIn } from '../core/allocator.ts';
import { certify } from '../core/certify.ts';
import { adapt, MAPPING_V1, proposeMapping, type Mapping } from '../core/contract.ts';
import type { EscrowGrant, FieldOp } from '../core/field.ts';
import { canon, hashOf, sha256Hex } from '../core/hash.ts';
import { coverage, pseudoPack, validatePack, type LanguagePack } from '../core/i18n.ts';
import { entryHash, GENESIS, leafHash, merkleProof, merkleRoot, type LedgerEntry } from '../core/ledger.ts';
import { newKeyPair, signToken } from '../core/pass.ts';
import { compare, POLICY_V1, prioritise, validatePolicy } from '../core/priority.ts';
import { assess } from '../core/sensors.ts';
import { resolveRoute } from '../core/truth.ts';
import type {
  Alternative, Belief, Certificate, Decision, Need, Passenger, PassPayload, PlanMode, Policy, Priority, Reading, RouteRecord, Run, SensorReport, Vehicle, Witness,
} from '../core/types.ts';
import { checkBatch, scrub } from '../core/validate.ts';
import {
  apportion, CORRIDORS, dbscan, DESTINATIONS, EDGES, HUB, makeFleet, makePassengers, NODES, nodeName, shortest, tripFor, type CorridorDemand, type TripPlan,
} from '../core/world.ts';
import { openDb, wipe, type DB } from './db.ts';
import { Egress } from './egress.ts';
import { SafeLog } from './safelog.ts';

export const BASE_MS = Date.parse('2026-11-06T08:30:00+05:30');
export const toMinutes = (iso: string) => Math.round((Date.parse(iso) - BASE_MS) / 60000);
export const toIso = (t: number) => new Date(BASE_MS + t * 60000).toISOString();

export function clockLabel(t: number): string {
  const d = new Date(BASE_MS + t * 60000 + 5.5 * 3600000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

const HORIZON_MIN = 120;
const DISPATCH_LEAD_MIN = 5;
const WALKUP_RESERVE = 2;
const CLARIFY_DUE_MIN = 10;
const KEY_ID = 'hub-2026';

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
  passengers?: number;
}

export interface Shadow {
  pools: PoolIn[];
  units: UnitIn[];
  priorities: Map<string, Priority>;
  people: Map<string, Passenger>;
  awaiting: Set<string>;
  seed: string;
}

const ACTIVE_SEAT = `('HELD','COMMITTED','BOARDED')`;

export class Hub extends EventEmitter {
  db: DB;
  log: SafeLog;
  egress: Egress;
  file: string;
  keys: { secretHex: string; publicHex: string };
  feedBase: string | null = null;
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
    if (!this.meta('clock')) this.reset(opts.seed ?? 842, opts.passengers ?? 1420);
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

  reset(seed = 842, passengers = 1420) {
    wipe(this.db);
    this.seq = 0;
    this.lastHash = GENESIS;
    this.setMeta('clock', 0);
    this.setMeta('seed', seed);
    this.setMeta('offline', 0);
    this.setMeta('plan', 0);
    this.setMeta('mode', 'DIRECT');
    this.setMeta('feed_last_good_at', -1);
    this.egress.offline = false;

    const insertV = this.db.prepare('INSERT INTO vehicles(id, label, kind, seats, bays, active) VALUES (@id, @label, @kind, @seats, @bays, 1)');
    const people = makePassengers(seed, { count: passengers, startAt: -30, arrivalSpreadMin: 30 });
    this.db.transaction(() => {
      for (const v of makeFleet()) insertV.run(v);
      this.insertPassengers(people, 'SEED');
      const p = POLICY_V1;
      this.db.prepare('INSERT INTO policies(version, name, doc, hash, activated_at) VALUES (?, ?, ?, ?, ?)').run(p.version, p.name, JSON.stringify(p), hashOf(p), 0);
      this.db.prepare(`INSERT INTO adapters(version, mapping, state, confidence, approved_by) VALUES ('v1', ?, 'ACTIVE', 1, 'built-in')`).run(JSON.stringify(MAPPING_V1));
    })();
    this.record('WORLD_CREATED', 'system', { seed, passengers: people.length, people: people.reduce((s, p) => s + p.party, 0) });
    this.replan('Incident opened');
    this.allocateEpoch('Initial allocation');
    this.changed();
  }

  insertPassengers(list: Passenger[], origin: string) {
    const stmt = this.db.prepare(`INSERT INTO passengers(pid, dest, need, party, deadline_kind, deadline_at, deadline_verified, checkin_at, state, displaced, origin)
      VALUES (@pid, @dest, @need, @party, @deadlineKind, @deadlineAt, @verified, @checkinAt, @state, 0, @origin)`);
    for (const p of list) stmt.run({ ...p, verified: p.deadlineVerified ? 1 : 0, origin });
  }

  passengers(where = `state IN ('WAITING','ASSIGNED','AWAITING_INFO')`): Passenger[] {
    return (this.db.prepare(`SELECT * FROM passengers WHERE ${where}`).all() as any[]).map(rowToPassenger);
  }

  passenger(pid: string): Passenger | null {
    const r = this.db.prepare('SELECT * FROM passengers WHERE pid = ?').get(pid);
    return r ? rowToPassenger(r) : null;
  }

  vehicles(): Vehicle[] {
    return (this.db.prepare('SELECT * FROM vehicles ORDER BY id').all() as any[]).map((v) => ({ ...v, active: !!v.active }));
  }

  runs(state: string | null = 'PLANNED'): Run[] {
    const rows = (state
      ? this.db.prepare('SELECT * FROM runs WHERE state = ? ORDER BY depart_at, id').all(state)
      : this.db.prepare('SELECT * FROM runs ORDER BY depart_at, id').all()) as any[];
    return rows.map(rowToRun);
  }

  run(id: string): Run | null {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return r ? rowToRun(r) : null;
  }

  policy(): Policy {
    const r = this.db.prepare('SELECT doc FROM policies ORDER BY version DESC LIMIT 1').get() as { doc: string };
    return JSON.parse(r.doc);
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
        if (typeof r.route !== 'string' || !known.has(r.route)) continue;
        if (typeof r.observedAt !== 'number' || !Number.isFinite(r.observedAt)) continue;
        stmt.run(r.route, String(r.value).toUpperCase().slice(0, 20), String(r.source).slice(0, 30), r.observedAt, this.now);
        stored++;
      }
    })();
    for (const b of this.beliefs()) {
      if (b.state === 'UNRESOLVED') this.openVerification(b);
    }
    const after = [...this.closedEdges()].sort().join();
    if (before !== after) {
      this.record('ROUTES_CHANGED', 'truth', { closed: after ? after.split(',') : [] });
      this.replan('Route status changed');
      this.allocateEpoch('Route status changed');
    }
    this.changed();
    return { stored, rejected: list.length - stored, beliefs: this.beliefs() };
  }

  private openVerification(b: Belief) {
    const open = this.db.prepare(`SELECT id FROM verifications WHERE route = ? AND state = 'OPEN'`).get(b.route);
    if (open) return;
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

  // ---------- planning ----------

  private primaryCorridor(dest: string) {
    return CORRIDORS.find((c) => c.terminal === dest) ?? CORRIDORS.find((c) => c.covers.includes(dest))!;
  }

  private demand(): CorridorDemand[] {
    const map = new Map(CORRIDORS.map((c) => [c.id, { corridor: c.id, people: 0, wheelchairs: 0 }]));
    const locked = new Set((this.db.prepare(`SELECT pid FROM seats WHERE state IN ('COMMITTED','BOARDED')`).all() as any[]).map((r) => r.pid));
    for (const p of this.passengers()) {
      if (locked.has(p.pid)) continue;
      const d = map.get(this.primaryCorridor(p.dest).id)!;
      d.people += p.party;
      if (p.need === 'WHEELCHAIR') d.wheelchairs += 1;
    }
    return [...map.values()];
  }

  private tripsFor(mode: PlanMode, closed: Set<string>) {
    const trips = new Map<string, TripPlan>();
    for (const c of CORRIDORS) {
      const t = tripFor(c, mode, closed);
      if (t) trips.set(c.id, t);
    }
    return trips;
  }

  /** Minutes until the most loaded corridor clears, used to choose between modes. */
  private projectClearance(demand: CorridorDemand[], vehicles: Vehicle[], trips: Map<string, TripPlan>): number {
    const assign = apportion(vehicles, demand, trips);
    let worst = 0;
    for (const d of demand) {
      const t = trips.get(d.corridor);
      if (!t || d.people === 0) continue;
      const rate = vehicles.filter((v) => assign.get(v.id) === d.corridor).reduce((s, v) => s + v.seats / t.rttMin, 0);
      worst = Math.max(worst, rate > 0 ? d.people / rate : Infinity);
    }
    return worst;
  }

  replan(reason: string) {
    const t = this.now;
    const closed = this.closedEdges();
    const fleet = this.vehicles().filter((v) => v.active);
    const planNo = Number(this.meta('plan')) + 1;

    this.db.transaction(() => {
      this.setMeta('plan', planNo);
      const cancelled = this.db.prepare(`SELECT r.id FROM runs r WHERE r.state = 'PLANNED'
        AND NOT EXISTS (SELECT 1 FROM seats s WHERE s.run_id = r.id AND s.state IN ('COMMITTED','BOARDED'))
        AND NOT EXISTS (SELECT 1 FROM escrow e WHERE e.run_id = r.id)`).all() as { id: string }[];
      const release = this.db.prepare(`UPDATE seats SET state = 'RELEASED' WHERE run_id = ? AND state = 'HELD'`);
      const cancel = this.db.prepare(`UPDATE runs SET state = 'CANCELLED', seats_taken = 0, bays_taken = 0, escrow_seats = 0 WHERE id = ?`);
      for (const { id } of cancelled) {
        release.run(id);
        cancel.run(id);
      }

      const demand = this.demand();
      const direct = this.tripsFor('DIRECT', closed);
      const trunk = this.tripsFor('TRUNK', closed);
      const projected = { DIRECT: this.projectClearance(demand, fleet, direct), TRUNK: this.projectClearance(demand, fleet, trunk) };
      const mode: PlanMode = projected.TRUNK < projected.DIRECT * 0.95 ? 'TRUNK' : 'DIRECT';
      if (mode !== this.meta('mode')) this.record('HUB_PIVOT', 'planner', { from: this.meta('mode'), to: mode, projected });
      this.setMeta('mode', mode);
      this.setMeta('projected', JSON.stringify(projected));
      const trips = mode === 'TRUNK' ? trunk : direct;
      const assign = apportion(fleet, demand, trips);

      const freeAt = new Map(fleet.map((v) => [v.id, t + DISPATCH_LEAD_MIN]));
      const held = this.db.prepare(`SELECT vehicle_id v, MAX(return_at) r FROM runs WHERE state IN ('PLANNED','DEPARTED') GROUP BY vehicle_id`).all() as { v: string; r: number }[];
      for (const { v, r } of held) if (freeAt.has(v)) freeAt.set(v, Math.max(freeAt.get(v)!, r));

      const insert = this.db.prepare(`INSERT INTO runs(id, vehicle_id, corridor, drop_at, mode, depart_at, arrive_at, return_at, seats_total, bays_total, escrow_seats, state)
        VALUES (@id, @vehicleId, @corridor, @dropAt, @mode, @departAt, @arriveAt, @returnAt, @seats, @bays, @escrow, 'PLANNED')`);
      let created = 0;
      for (const v of fleet) {
        const corridor = assign.get(v.id);
        if (!corridor) continue;
        const c = CORRIDORS.find((x) => x.id === corridor)!;
        let trip = trips.get(corridor)!;
        if (trip.mode === 'TRUNK' && v.bays > 0 && !c.pivot!.stepFree && direct.has(corridor)) trip = direct.get(corridor)!;
        let k = 0;
        for (let depart = freeAt.get(v.id)!; depart <= t + HORIZON_MIN; depart += trip.rttMin) {
          insert.run({
            id: `R${planNo}-${v.id}-${++k}`, vehicleId: v.id, corridor, dropAt: trip.dropAt, mode: trip.mode,
            departAt: depart, arriveAt: depart + trip.oneWayMin + trip.arriveExtraMin, returnAt: depart + trip.rttMin,
            seats: v.seats, bays: v.bays, escrow: Math.min(WALKUP_RESERVE, v.seats),
          });
          created++;
        }
      }
      this.record('PLAN', 'planner', { plan: planNo, reason, mode, vehicles: fleet.length, runs: created, closed: [...closed], projected });
    })();
  }

  /** DBSCAN over passenger drop-off points gives the cohorts shown to the operator. */
  cohorts(): { clusters: number; ms: number; groups: { node: string; people: number; wheelchairs: number; deadlines: number }[] } {
    const list = this.passengers();
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
      clusters,
      ms: Math.round(ms * 10) / 10,
      groups: [...groups.values()].map((g) => ({
        node: nodeName([...g.nodes.entries()].sort((a, b) => b[1] - a[1])[0][0]), people: g.people, wheelchairs: g.wheelchairs, deadlines: g.deadlines,
      })).sort((a, b) => b.people - a.people),
    };
  }

  // ---------- allocation ----------

  /** Builds the allocator's input. With lockCommitted false it answers "what would have happened". */
  shadow(policy: Policy, seed: string, lockCommitted: boolean): Shadow {
    const t = this.now;
    const planned = this.runs();
    const closed = this.closedEdges();
    const pools: PoolIn[] = [];
    for (const r of planned) {
      pools.push({ id: `${r.id}:S`, cap: r.seatsTotal - r.escrowSeats });
      if (r.baysTotal > 0) pools.push({ id: `${r.id}:B`, cap: r.baysTotal });
    }

    const lockedRows = this.db.prepare(`SELECT s.pid, s.run_id, s.seat_units, s.bay_units, s.state FROM seats s JOIN runs r ON r.id = s.run_id
      WHERE r.state = 'PLANNED' AND s.state IN ('COMMITTED','BOARDED')`).all() as any[];
    const locks = new Map<string, OptionIn>();
    for (const s of lockedRows) {
      if (!lockCommitted && s.state === 'COMMITTED') continue;
      const demand: Record<string, number> = {};
      if (s.seat_units > 0) demand[`${s.run_id}:S`] = s.seat_units;
      if (s.bay_units > 0) demand[`${s.run_id}:B`] = s.bay_units;
      locks.set(s.pid, { run: s.run_id, demand });
    }

    const roadMin = new Map<string, number>();
    for (const d of DESTINATIONS) {
      const p = shortest(HUB, d, closed);
      if (p) roadMin.set(d, p.min);
    }
    const arrival = (r: Run, dest: string) => (r.mode === 'TRUNK' ? r.arriveAt : r.departAt + (roadMin.get(dest) ?? r.arriveAt - r.departAt));

    const cache = new Map<string, OptionIn[]>();
    const optionsFor = (dest: string, need: Need, party: number) => {
      const key = `${dest}|${need}|${party}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const wantsBay = need === 'WHEELCHAIR' || need === 'UNKNOWN';
      const primary = this.primaryCorridor(dest).id;
      const options = planned
        .filter((r) => {
          const c = CORRIDORS.find((x) => x.id === r.corridor)!;
          if (!c.covers.includes(dest)) return false;
          if (r.departAt < t) return false;
          if (need === 'WHEELCHAIR' && r.mode === 'TRUNK' && !c.pivot?.stepFree) return false;
          return wantsBay ? r.baysTotal > 0 : true;
        })
        .map((r) => {
          const demand: Record<string, number> = wantsBay
            ? { [`${r.id}:B`]: 1, ...(party > 1 ? { [`${r.id}:S`]: party - 1 } : {}) }
            : { [`${r.id}:S`]: party };
          const detour = r.corridor === primary ? 0 : 5;
          return { option: { run: r.id, demand }, cost: arrival(r, dest) + detour * policy.weights.detourPerMin * 5 };
        })
        .sort((a, b) => a.cost - b.cost || a.option.run.localeCompare(b.option.run))
        .map((x) => x.option);
      cache.set(key, options);
      return options;
    };

    const people = new Map<string, Passenger>();
    const priorities = new Map<string, Priority>();
    for (const p of this.passengers()) {
      people.set(p.pid, p);
      priorities.set(p.pid, prioritise(p, t, policy, seed));
    }
    for (const r of lockedRows) {
      const p = this.passenger(r.pid)!;
      if (!people.has(p.pid)) {
        people.set(p.pid, p);
        priorities.set(p.pid, prioritise(p, t, policy, seed));
      }
    }

    const order = [...people.keys()].sort((a, b) => compare(priorities.get(a)!, priorities.get(b)!));
    const awaiting = new Set<string>();
    const units: UnitIn[] = order.map((pid, rank) => {
      const p = people.get(pid)!;
      const lock = locks.get(pid);
      if (p.need === 'UNKNOWN' && !lock) awaiting.add(pid);
      return { id: pid, rank, options: optionsFor(p.dest, p.need, p.party), locked: lock };
    });
    return { pools, units, priorities, people, awaiting, seed };
  }

  /**
   * C12. An answer only matters if it changes what happens. The allocation is compared under
   * each possible value; if every value leads to the same vehicle, no question is needed.
   */
  private unknownNeedMatters(p: Passenger): boolean {
    return this.firstRunFor({ ...p, need: 'NONE' }) !== this.firstRunFor({ ...p, need: 'WHEELCHAIR' });
  }

  private firstRunFor(p: Passenger): string | null {
    const c = CORRIDORS.filter((x) => x.covers.includes(p.dest));
    const runs = this.runs().filter((r) => c.some((x) => x.id === r.corridor) && r.departAt >= this.now);
    const usable = runs.filter((r) => (p.need === 'WHEELCHAIR' ? r.baysTotal > r.baysTaken : r.seatsTotal - r.escrowSeats > r.seatsTaken));
    return usable.sort((a, b) => a.departAt - b.departAt || a.id.localeCompare(b.id))[0]?.id ?? null;
  }

  allocateEpoch(reason: string, actor = 'system'): { epoch: number; certificate: Certificate; solveMs: number; seated: number; refused: number; awaiting: number } {
    const policy = this.policy();
    const t = this.now;
    const epoch = ((this.db.prepare('SELECT MAX(id) m FROM epochs').get() as { m: number | null }).m ?? 0) + 1;
    const seed = `${this.meta('seed')}:${epoch}`;
    const shadow = this.shadow(policy, seed, true);

    const t0 = performance.now();
    const result = allocate(shadow.pools, shadow.units);
    const solveMs = performance.now() - t0;

    const placed = Object.fromEntries(result.placed);
    const certificate = certify({ pools: shadow.pools, units: shadow.units, placed, refused: result.refused });

    // The solver's answer is only applied if the independent checker accepts it.
    if (!certificate.ok) {
      this.record('ALLOCATION_REJECTED', 'certifier', { epoch, failed: certificate.checks.filter((c) => !c.ok).map((c) => c.id) });
      throw new HubError('CERTIFICATE_FAILED', 'The allocation failed its independent check and was not applied', 500);
    }

    const decisions: Decision[] = [];
    let awaiting = 0;

    this.db.transaction(() => {
      this.db.prepare(`UPDATE seats SET state = 'RELEASED' WHERE state = 'HELD'`).run();
      const runMap = new Map(this.runs().map((r) => [r.id, r]));
      const insertSeat = this.db.prepare(`INSERT INTO seats(pid, run_id, seat_units, bay_units, state, epoch, policy_version, pass_id, pass_token)
        VALUES (@pid, @run, @seats, @bays, @state, @epoch, @policy, @passId, @token)`);
      const setState = this.db.prepare('UPDATE passengers SET state = ?, displaced = ? WHERE pid = ?');

      for (const u of shadow.units) {
        const p = shadow.people.get(u.id)!;
        const pr = shadow.priorities.get(u.id)!;
        const o = result.placed.get(u.id);
        if (u.locked) {
          decisions.push(makeDecision(u.id, epoch, 'COMMITTED_KEPT', u.locked, pr, null, shadow, result));
          continue;
        }
        if (!o) {
          const w = result.refused.find((r) => r.id === u.id)!.witness;
          const needsInfo = shadow.awaiting.has(u.id);
          if (needsInfo) {
            this.clarify(p);
            awaiting++;
          }
          setState.run(needsInfo ? 'AWAITING_INFO' : 'WAITING', p.displaced ? 1 : 0, u.id);
          decisions.push(makeDecision(u.id, epoch, needsInfo ? 'AWAITING_INFO' : 'WAITLISTED', null, pr, w, shadow, result));
          continue;
        }
        const run = runMap.get(o.run)!;
        const seatUnits = o.demand[`${o.run}:S`] ?? 0;
        const bayUnits = o.demand[`${o.run}:B`] ?? 0;

        // Unknown need holds a space safe under every answer, but never gets a pass while it matters.
        const blocked = shadow.awaiting.has(u.id) && this.unknownNeedMatters(p);
        const commit = !blocked && run.departAt - t <= policy.commitWindowMin;
        let passId: string | null = null;
        let token: string | null = null;
        if (commit) {
          ({ passId, token } = this.signPass(p, run, bayUnits > 0 ? 'B' : 'S'));
        }
        insertSeat.run({ pid: u.id, run: o.run, seats: seatUnits, bays: bayUnits, state: commit ? 'COMMITTED' : 'HELD', epoch, policy: policy.version, passId, token });
        if (blocked) {
          this.clarify(p);
          awaiting++;
        }
        setState.run(blocked ? 'AWAITING_INFO' : 'ASSIGNED', p.displaced && !commit ? 1 : 0, u.id);
        decisions.push(makeDecision(u.id, epoch, blocked ? 'AWAITING_INFO' : 'SEATED', o, pr, null, shadow, result));
      }

      this.recountRuns();

      const insertD = this.db.prepare(`INSERT INTO decisions(pid, epoch, outcome, run_id, pool, priority, witness, rivals, capacity, policy_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const d of decisions) {
        insertD.run(d.pid, epoch, d.outcome, d.runId, d.pool, JSON.stringify(d.priority), d.witness ? JSON.stringify(d.witness) : null, d.rivals, d.capacity, policy.version);
      }

      const leaves = decisionLeaves(decisions);
      const root = merkleRoot(leaves);
      const inputHash = hashOf({ pools: shadow.pools, units: shadow.units.map((u) => ({ id: u.id, rank: u.rank, locked: u.locked?.run ?? null })) });
      const outputHash = hashOf(decisions.map((d) => [d.pid, d.outcome, d.runId, d.pool]));
      this.db.prepare(`INSERT INTO epochs(id, at, reason, policy_version, seed, input_hash, output_hash, merkle_root, certificate, solve_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(epoch, t, reason, policy.version, seed, inputHash, outputHash, root, JSON.stringify(certificate), solveMs);
      this.record('ALLOCATION', actor, {
        epoch, reason, policy: policy.version, seed, inputHash, outputHash, merkleRoot: root,
        seated: certificate.unitsSeated, refused: result.refused.length, relaxedBound: certificate.relaxedBound,
      });
    })();

    this.changed();
    return { epoch, certificate, solveMs, seated: certificate.unitsSeated, refused: result.refused.length, awaiting };
  }

  private recountRuns() {
    this.db.exec(`UPDATE runs SET
      seats_taken = (SELECT COALESCE(SUM(seat_units), 0) FROM seats WHERE run_id = runs.id AND state IN ${ACTIVE_SEAT}),
      bays_taken = (SELECT COALESCE(SUM(bay_units), 0) FROM seats WHERE run_id = runs.id AND state IN ${ACTIVE_SEAT})
      WHERE state = 'PLANNED'`);
  }

  private signPass(p: Passenger, run: Run, pool: 'S' | 'B') {
    const passId = randomBytes(8).toString('hex');
    const payload: PassPayload = { v: 1, k: KEY_ID, p: p.pid, r: run.id, u: pool, n: p.party, nb: run.departAt - 30, ex: run.departAt + 5, id: passId };
    return { passId, token: signToken(payload, this.keys.secretHex) };
  }

  private clarify(p: Passenger) {
    const existing = this.db.prepare(`SELECT id FROM clarifications WHERE pid = ? AND field = 'need' AND state IN ('OPEN','ESCALATED')`).get(p.pid);
    if (existing) return;
    const r = this.db.prepare(`INSERT INTO clarifications(pid, field, question, why, options, due_at) VALUES (?, 'need', ?, ?, ?, ?)`).run(
      p.pid,
      'Do you need a wheelchair space?',
      'Wheelchair spaces are only on some vehicles, so your answer changes which vehicle you board.',
      JSON.stringify(['NONE', 'ASSIST', 'WHEELCHAIR']),
      this.now + CLARIFY_DUE_MIN,
    );
    this.record('CLARIFICATION_REQUESTED', 'system', { id: r.lastInsertRowid, pid: p.pid, field: 'need' });
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
    if (c.state === 'ANSWERED') return this.passengerView(pid);
    if (!JSON.parse(c.options).includes(value)) throw new HubError('BAD_ANSWER', 'That is not one of the options');
    this.db.transaction(() => {
      this.db.prepare(`UPDATE clarifications SET state = 'ANSWERED', answer = ? WHERE id = ?`).run(value, id);
      this.db.prepare(`UPDATE passengers SET need = ?, state = 'WAITING' WHERE pid = ?`).run(value, pid);
      this.record('CLARIFICATION_ANSWERED', 'passenger', { id, pid, field: c.field });
    })();
    this.allocateEpoch('Question answered');
    return this.passengerView(pid);
  }

  // ---------- clock ----------

  advance(minutes: number) {
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 240) throw new HubError('BAD_MINUTES', 'minutes must be between 1 and 240');
    const to = this.now + Math.round(minutes);
    this.db.transaction(() => {
      this.setMeta('clock', to);
      const due = this.db.prepare(`SELECT id FROM runs WHERE state = 'PLANNED' AND depart_at <= ?`).all(to) as { id: string }[];
      for (const { id } of due) {
        this.db.prepare(`UPDATE runs SET state = 'DEPARTED' WHERE id = ?`).run(id);
        const seats = this.db.prepare(`SELECT pid FROM seats WHERE run_id = ? AND state IN ('COMMITTED','BOARDED')`).all(id) as { pid: string }[];
        for (const { pid } of seats) this.db.prepare(`UPDATE passengers SET state = 'DEPARTED' WHERE pid = ?`).run(pid);
        this.db.prepare(`UPDATE seats SET state = 'BOARDED' WHERE run_id = ? AND state = 'COMMITTED'`).run(id);
        this.db.prepare(`UPDATE seats SET state = 'RELEASED' WHERE run_id = ? AND state = 'HELD'`).run(id);
      }
      const late = this.db.prepare(`SELECT * FROM clarifications WHERE state = 'OPEN' AND due_at <= ?`).all(to) as any[];
      for (const c of late) {
        this.db.prepare(`UPDATE clarifications SET state = 'ESCALATED' WHERE id = ?`).run(c.id);
        this.record('CLARIFICATION_ESCALATED', 'system', { id: c.id, pid: c.pid, field: c.field, to: 'marshal' });
      }
      this.record('CLOCK', 'operator', { to, departed: due.length });
    })();
    this.replan('Clock advanced');
    return this.allocateEpoch('Clock advanced');
  }

  // ---------- fleet changes (C05) ----------

  withdrawVehicles(ids: string[], reason: string) {
    const displaced: string[] = [];
    this.db.transaction(() => {
      for (const id of ids) {
        this.db.prepare('UPDATE vehicles SET active = 0 WHERE id = ?').run(id);
        const runs = this.db.prepare(`SELECT id FROM runs WHERE vehicle_id = ? AND state = 'PLANNED'`).all(id) as { id: string }[];
        for (const r of runs) {
          const seats = this.db.prepare(`SELECT pid, state FROM seats WHERE run_id = ? AND state IN ('HELD','COMMITTED')`).all(r.id) as { pid: string; state: string }[];
          for (const s of seats) {
            if (s.state === 'COMMITTED') {
              displaced.push(s.pid);
              this.db.prepare(`UPDATE passengers SET displaced = 1, state = 'WAITING' WHERE pid = ?`).run(s.pid);
            }
          }
          this.db.prepare(`UPDATE seats SET state = 'RELEASED' WHERE run_id = ? AND state IN ('HELD','COMMITTED')`).run(r.id);
          this.db.prepare(`UPDATE runs SET state = 'CANCELLED', seats_taken = 0, bays_taken = 0, escrow_seats = 0 WHERE id = ?`).run(r.id);
        }
      }
      this.record('FLEET_REDUCED', 'operator', { withdrawn: ids, reason, displaced: displaced.length });
    })();
    this.replan(reason);
    return { displaced };
  }

  addDemand(count: number) {
    const seed = Number(this.meta('seed')) + this.now + count;
    const tag = randomBytes(2).toString('hex').toUpperCase();
    const people = makePassengers(seed, { count, startAt: this.now, arrivalSpreadMin: 0, idPrefix: `S${tag}` });
    this.db.transaction(() => this.insertPassengers(people, 'SURGE'))();
    this.record('DEMAND_SURGE', 'operator', { people: count, records: people.length });
  }

  // ---------- policy (C11) ----------

  activatePolicy(doc: unknown, opts: { dryRun?: boolean; by?: string } = {}) {
    const v = validatePolicy(doc);
    if (!v.ok) throw new HubError('BAD_POLICY', v.errors.join('; '));
    const current = this.policy();
    const next: Policy = { ...current, ...v.policy, version: current.version + 1 };

    // Which seats would change if passes did not exist? Those are the ones needing a human.
    const seed = `${this.meta('seed')}:policy:${next.version}`;
    const shadow = this.shadow(next, seed, false);
    const preview = allocate(shadow.pools, shadow.units);
    const bySeat = new Map((this.db.prepare(`SELECT pid, run_id FROM seats WHERE state IN ${ACTIVE_SEAT}`).all() as any[]).map((r) => [r.pid, r.run_id]));
    const passes = this.db.prepare(`SELECT pid, run_id, pass_id FROM seats WHERE state = 'COMMITTED'`).all() as any[];
    const boarded = (this.db.prepare(`SELECT COUNT(*) c FROM seats WHERE state = 'BOARDED'`).get() as { c: number }).c;

    const conflicts = passes.filter((s) => preview.placed.get(s.pid)?.run !== s.run_id);
    let movedHeld = 0;
    for (const [pid, o] of preview.placed) {
      const was = bySeat.get(pid);
      if (was !== o.run && !passes.some((s) => s.pid === pid)) movedHeld++;
    }
    const diff = {
      from: current.version,
      to: next.version,
      recalculated: movedHeld,
      needApproval: conflicts.length,
      untouchedBoarded: boarded,
      tiersBefore: current.tiers.map((x) => x.label),
      tiersAfter: next.tiers.map((x) => x.label),
    };
    if (opts.dryRun) return { applied: false, diff, approvals: [] as number[], policy: next };

    const approvals: number[] = [];
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO policies(version, name, doc, hash, activated_at) VALUES (?, ?, ?, ?, ?)').run(next.version, next.name, JSON.stringify(next), hashOf(next), this.now);
      this.record('POLICY_ACTIVATED', opts.by ?? 'operator', { version: next.version, name: next.name, hash: hashOf(next), diff });
      const stmt = this.db.prepare(`INSERT INTO approvals(kind, subject, reason, payload) VALUES ('REVOKE_PASS', ?, ?, ?)`);
      for (const c of conflicts) {
        const r = stmt.run(c.pid, `Policy ${next.version} would give this seat to someone else, but a pass is already issued.`, JSON.stringify({ pid: c.pid, runId: c.run_id, passId: c.pass_id }));
        approvals.push(Number(r.lastInsertRowid));
      }
    })();
    const epoch = this.allocateEpoch(`Policy ${next.version} activated`);
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
      if (decision === 'APPROVE' && a.kind === 'REVOKE_PASS') {
        this.db.prepare(`UPDATE seats SET state = 'RELEASED' WHERE pass_id = ? AND state = 'COMMITTED'`).run(payload.passId);
        this.db.prepare(`UPDATE passengers SET state = 'WAITING' WHERE pid = ?`).run(payload.pid);
      }
      this.record('APPROVAL_DECIDED', by, { id, kind: a.kind, subject: a.subject, decision });
    })();
    if (decision === 'APPROVE') this.allocateEpoch('Approval applied');
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

  checkin(input: { opId: string; dest: string; party?: number; need?: Need; deadlineKind?: Passenger['deadlineKind']; deadlineInMin?: number | null }) {
    const opId = requireOp(input.opId);
    const dest = String(input.dest ?? '').toUpperCase();
    if (!DESTINATIONS.includes(dest)) throw new HubError('BAD_DESTINATION', 'That is not a stop we serve');
    const party = Number(input.party ?? 1);
    if (!Number.isInteger(party) || party < 1 || party > 12) throw new HubError('BAD_PARTY', 'Group size must be between 1 and 12');
    const need = input.need ?? 'UNKNOWN';
    if (!['NONE', 'ASSIST', 'WHEELCHAIR', 'UNKNOWN'].includes(need)) throw new HubError('BAD_NEED', 'Unknown access need');
    const kind = input.deadlineKind ?? 'NONE';
    if (!['NONE', 'FLIGHT', 'RAIL', 'SHIFT', 'MEDICAL'].includes(kind)) throw new HubError('BAD_DEADLINE', 'Unknown deadline type');
    const inMin = input.deadlineInMin ?? null;
    if (kind !== 'NONE' && (typeof inMin !== 'number' || inMin < 0 || inMin > 1440)) throw new HubError('BAD_DEADLINE', 'Enter minutes until your connection');

    const out = this.idempotent(`checkin:${opId}`, { dest, party, need, kind, inMin }, () => {
      const pid = `P-${randomBytes(3).toString('hex').toUpperCase()}`;
      this.insertPassengers([{
        pid, dest, need, party, deadlineKind: kind, deadlineAt: kind === 'NONE' ? null : this.now + inMin!,
        deadlineVerified: false, checkinAt: this.now, state: 'WAITING', displaced: false,
      }], 'APP');
      this.record('CHECKIN', 'passenger', { pid });
      return { pid, state: 'WAITING' };
    });
    this.changed();
    return out;
  }

  cancel(opId: string, pid: string) {
    return this.idempotent(`cancel:${requireOp(opId)}`, { pid }, () => {
      const seat = this.db.prepare(`SELECT id, state FROM seats WHERE pid = ? AND state IN ${ACTIVE_SEAT}`).get(pid) as { id: number; state: string } | undefined;
      if (seat?.state === 'BOARDED') throw new HubError('ALREADY_BOARDED', 'You have already boarded');
      if (seat) this.db.prepare(`UPDATE seats SET state = 'RELEASED' WHERE id = ?`).run(seat.id);
      this.db.prepare(`UPDATE passengers SET state = 'CANCELLED' WHERE pid = ?`).run(pid);
      this.recountRuns();
      this.record('CANCELLED', 'passenger', { pid });
      return { state: 'CANCELLED' };
    });
  }

  /** C09. The conditional UPDATE is the whole trick: only one writer can take the last seat. */
  claim(input: { opId: string; pid: string; runId: string }) {
    const opId = requireOp(input.opId);
    return this.idempotent(`claim:${opId}`, { pid: input.pid, runId: input.runId }, () => {
      const p = this.passenger(input.pid);
      if (!p) return { outcome: 'NOT_ELIGIBLE', reason: 'Unknown passenger' };
      const active = this.db.prepare(`SELECT 1 FROM seats WHERE pid = ? AND state IN ${ACTIVE_SEAT}`).get(p.pid);
      if (active) return { outcome: 'NOT_ELIGIBLE', reason: 'You already have a seat' };
      const taken = this.db.prepare(`UPDATE runs SET seats_taken = seats_taken + @n
        WHERE id = @id AND state = 'PLANNED' AND seats_taken + escrow_seats + @n <= seats_total`).run({ id: input.runId, n: p.party });
      if (taken.changes !== 1) return { outcome: 'TAKEN', reason: 'Someone else took the last seat' };
      const run = this.run(input.runId)!;
      const { passId, token } = this.signPass(p, run, 'S');
      this.db.prepare(`INSERT INTO seats(pid, run_id, seat_units, bay_units, state, policy_version, pass_id, pass_token) VALUES (?, ?, ?, 0, 'COMMITTED', ?, ?, ?)`)
        .run(p.pid, run.id, p.party, this.policy().version, passId, token);
      this.db.prepare(`UPDATE passengers SET state = 'ASSIGNED' WHERE pid = ?`).run(p.pid);
      this.record('SEAT_CLAIMED', 'passenger', { pid: p.pid, run: run.id });
      return { outcome: 'WON', passId, token, runId: run.id };
    });
  }

  // ---------- escrow and field sync (C01) ----------

  grantEscrow(input: { opId: string; runId: string; device: string; seats: number }) {
    const n = Number(input.seats);
    if (!Number.isInteger(n) || n < 1 || n > 20) throw new HubError('BAD_SEATS', 'Grant between 1 and 20 seats');
    return this.idempotent(`escrow:${requireOp(input.opId)}`, { runId: input.runId, device: input.device, n }, () => {
      const run = this.run(input.runId);
      if (!run || run.state !== 'PLANNED') throw new HubError('BAD_RUN', 'That run is not open');
      const granted = (this.db.prepare('SELECT COALESCE(SUM(seats), 0) s FROM escrow WHERE run_id = ?').get(run.id) as { s: number }).s;
      const extra = Math.max(0, granted + n - run.escrowSeats);
      if (extra > 0) {
        const ok = this.db.prepare(`UPDATE runs SET escrow_seats = escrow_seats + @x WHERE id = @id AND seats_taken + escrow_seats + @x <= seats_total`).run({ id: run.id, x: extra });
        if (ok.changes !== 1) throw new HubError('NO_SEATS', 'Not enough free seats to set aside', 409);
      }
      const g = randomBytes(6).toString('hex');
      const grant: EscrowGrant = { v: 1, k: KEY_ID, g, r: run.id, d: String(input.device), n };
      const token = signToken(grant, this.keys.secretHex, 'OSG');
      this.db.prepare('INSERT INTO escrow(id, run_id, device, seats, token) VALUES (?, ?, ?, ?, ?)').run(g, run.id, String(input.device), n, token);
      this.record('ESCROW_GRANTED', 'hub', { grant: g, run: run.id, device: input.device, seats: n });
      return { grantToken: token, seats: n };
    });
  }

  deviceSnapshot(runId: string, device: string) {
    const run = this.run(runId);
    if (!run) throw new HubError('NOT_FOUND', 'No such run', 404);
    const manifest = this.db.prepare(`SELECT s.pid, s.pass_id passId, s.state, s.seat_units + s.bay_units people FROM seats s
      WHERE s.run_id = ? AND s.state IN ('COMMITTED','BOARDED') ORDER BY s.id`).all(runId);
    const grant = this.db.prepare('SELECT token FROM escrow WHERE run_id = ? AND device = ?').get(runId, device) as { token: string } | undefined;
    return { run, publicKeys: this.publicKeys, manifest, grantToken: grant?.token ?? null };
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
          const seat = this.db.prepare(`SELECT id, state, pid FROM seats WHERE pass_id = ?`).get(op.passId ?? '') as { id: number; state: string; pid: string } | undefined;
          if (!seat) {
            status = 'REJECTED';
            detail = 'Unknown pass';
          } else if (seat.state === 'BOARDED') {
            status = 'CONFLICT';
            detail = 'This pass was already boarded from another device';
          } else if (seat.state !== 'COMMITTED') {
            status = 'CONFLICT';
            detail = 'This pass was revoked before boarding';
          } else {
            this.db.prepare(`UPDATE seats SET state = 'BOARDED' WHERE id = ?`).run(seat.id);
            this.db.prepare(`UPDATE passengers SET state = 'BOARDED' WHERE pid = ?`).run(seat.pid);
            detail = 'Boarded';
          }
        } else if (op.kind === 'WALKUP') {
          const party = Number(op.party);
          const grant = this.db.prepare('SELECT * FROM escrow WHERE id = ?').get(op.grantId ?? '') as any;
          if (!grant || grant.run_id !== op.runId || !Number.isInteger(party) || party < 1) {
            status = 'REJECTED';
            detail = 'Invalid grant';
          } else if (grant.used + party > grant.seats) {
            status = 'REJECTED';
            detail = 'Grant exhausted';
          } else {
            const pid = `W-${randomBytes(3).toString('hex').toUpperCase()}`;
            const run = this.run(grant.run_id)!;
            const dest = CORRIDORS.find((c) => c.id === run.corridor)!.terminal;
            this.db.prepare('UPDATE escrow SET used = used + ? WHERE id = ?').run(party, grant.id);
            this.db.prepare('UPDATE runs SET escrow_seats = escrow_seats - ?, seats_taken = seats_taken + ? WHERE id = ?').run(party, party, grant.run_id);
            this.insertPassengers([{ pid, dest, need: 'NONE', party, deadlineKind: 'NONE', deadlineAt: null, deadlineVerified: false, checkinAt: op.at, state: 'BOARDED', displaced: false }], 'WALKUP');
            this.db.prepare(`INSERT INTO seats(pid, run_id, seat_units, bay_units, state) VALUES (?, ?, ?, 0, 'BOARDED')`).run(pid, grant.run_id, party);
            detail = 'Walk-up seated';
          }
        } else {
          status = 'REJECTED';
          detail = 'Unknown op';
        }
        if (status !== 'REJECTED') this.db.prepare('INSERT INTO field_ops(op_id, device, kind, run_id, result) VALUES (?, ?, ?, ?, ?)').run(op.opId, device, op.kind, op.runId, status);
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

  ingestPassengers(text: string, batch = `batch-${Date.now()}`) {
    const report = checkBatch(String(text ?? ''), new Set(DESTINATIONS));
    const insertQ = this.db.prepare('INSERT INTO quarantine(batch, line, reasons, excerpt, at) VALUES (?, ?, ?, ?, ?)');
    const existing = new Set((this.db.prepare('SELECT pid FROM passengers').all() as any[]).map((r) => r.pid));
    let stored = 0;
    let alreadyKnown = 0;
    this.db.transaction(() => {
      for (const q of report.quarantined) insertQ.run(batch, q.line, JSON.stringify(q.reasons.map(scrub)), q.excerpt, this.now);
      const fresh: Passenger[] = [];
      for (const r of report.accepted) {
        const pid = this.pseudonym(r.externalId);
        if (existing.has(pid)) {
          alreadyKnown++;
          insertQ.run(batch, 0, JSON.stringify(['Already imported in an earlier batch']), '{}', this.now);
          continue;
        }
        existing.add(pid);
        fresh.push({
          pid, dest: r.dest, need: r.need, party: r.party, deadlineKind: r.deadlineKind,
          deadlineAt: r.deadlineAtIso ? toMinutes(r.deadlineAtIso) : null, deadlineVerified: r.deadlineVerified,
          checkinAt: this.now, state: 'WAITING', displaced: false,
        });
      }
      this.insertPassengers(fresh, 'IMPORT');
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
      const pending = this.db.prepare(`SELECT version FROM adapters WHERE state = 'PROPOSED'`).get() as { version: string } | undefined;
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
    const stored = this.ingestRouteRecords(res.records.map((r) => ({ route: r.route, value: r.status, source: 'OPERATOR_FEED', observedAt: toMinutes(r.observedAtIso) }))).stored;
    return { ok: true, stored, unknownFields: res.unknownFields, adapter: mapping.version, keptLastGood: false };
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

  // ---------- telemetry (C10) ----------

  ingestTelemetry(list: Reading[]) {
    const stmt = this.db.prepare('INSERT INTO telemetry(vehicle_id, observed_at, received_at, lat, lng, odo_km, occupancy) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const known = new Set(this.vehicles().map((v) => v.id));
    let stored = 0;
    this.db.transaction(() => {
      for (const r of list) {
        if (!known.has(r?.vehicleId) || typeof r.observedAt !== 'number' || !Number.isFinite(r.observedAt)) continue;
        stmt.run(r.vehicleId, r.observedAt, r.receivedAt ?? this.now, r.lat ?? null, r.lng ?? null, r.odoKm ?? null, r.occupancy ?? null);
        stored++;
      }
    })();
    return { stored, rejected: list.length - stored };
  }

  sensorReport(vehicleId: string): SensorReport {
    const v = this.vehicles().find((x) => x.id === vehicleId);
    if (!v) throw new HubError('NOT_FOUND', 'No such vehicle', 404);
    const rows = this.db.prepare('SELECT * FROM telemetry WHERE vehicle_id = ? ORDER BY id DESC LIMIT 60').all(vehicleId) as any[];
    const stream: Reading[] = rows.map((r) => ({ vehicleId, observedAt: r.observed_at, receivedAt: r.received_at, lat: r.lat, lng: r.lng, odoKm: r.odo_km, occupancy: r.occupancy })).reverse();
    const manifest = (this.db.prepare(`SELECT COALESCE(SUM(s.seat_units + s.bay_units), 0) n FROM seats s JOIN runs r ON r.id = s.run_id
      WHERE r.vehicle_id = ? AND r.state = 'DEPARTED' AND s.state = 'BOARDED'`).get(vehicleId) as { n: number }).n;
    return assess(vehicleId, stream, { capacity: v.seats, manifest, now: this.now });
  }

  sensorReports(): SensorReport[] {
    const ids = (this.db.prepare('SELECT DISTINCT vehicle_id v FROM telemetry ORDER BY v').all() as { v: string }[]).map((r) => r.v);
    return ids.map((id) => this.sensorReport(id));
  }

  /** A genuine stop becomes a request to a person. Nothing is re-dispatched automatically. */
  raiseSensorReview(r: SensorReport) {
    if (r.verdict !== 'GENUINE_STOP') return null;
    const open = this.db.prepare(`SELECT id FROM approvals WHERE kind = 'CONFIRM_BREAKDOWN' AND subject = ? AND state = 'PENDING'`).get(r.vehicleId) as { id: number } | undefined;
    if (open) return open.id;
    const a = this.db.prepare(`INSERT INTO approvals(kind, subject, reason, payload) VALUES ('CONFIRM_BREAKDOWN', ?, ?, ?)`)
      .run(r.vehicleId, r.action, JSON.stringify({ flags: r.flags }));
    this.record('SENSOR_REVIEW', 'sentinel', { vehicle: r.vehicleId, verdict: r.verdict });
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
    this.record('LANGUAGE_LOADED', 'operator', { code: v.pack.code, ...coverageSummary(v.pack) });
    this.changed();
    return { pack: v.pack, coverage: coverage(v.pack) };
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
    if (!d) throw new HubError('NOT_FOUND', 'No decision recorded for this passenger', 404);
    const all = (this.db.prepare('SELECT * FROM decisions WHERE epoch = ? ORDER BY pid').all(d.epoch) as any[]).map(rowToDecision);
    const leaves = decisionLeaves(all);
    const index = all.findIndex((x) => x.pid === pid);
    const epoch = this.db.prepare('SELECT merkle_root FROM epochs WHERE id = ?').get(d.epoch) as { merkle_root: string };
    return { epoch: d.epoch, leaf: leaves[index], value: leafValue(all[index]), proof: merkleProof(leaves, index), root: epoch.merkle_root };
  }

  alternatives(p: Passenger): Alternative[] {
    const closed = this.closedEdges();
    const out: Alternative[] = [];
    const nextBack = (this.db.prepare(`SELECT MIN(return_at) m FROM runs WHERE state IN ('PLANNED','DEPARTED') AND return_at > ?`).get(this.now) as { m: number | null }).m;
    out.push({
      kind: 'NEXT_WAVE', title: 'Stay on the waiting list', etaMin: nextBack === null ? null : Math.max(1, nextBack - this.now), stepFree: true,
      detail: 'You will be offered a seat as vehicles return. Your priority rises the longer you wait.',
    });
    out.push({ kind: 'STAGING', title: 'Wait in the covered staging area at Guindy', etaMin: 0, stepFree: true, detail: 'Staff are here and your place is kept.' });
    const route = shortest(HUB, p.dest, closed, ['METRO', 'ROAD']);
    if (route) {
      const stepFree = route.path.every((n) => NODES.find((x) => x.id === n)!.stepFree);
      if (p.need !== 'WHEELCHAIR' || stepFree) {
        out.push({
          kind: 'METRO', title: `Travel by metro via ${route.path.slice(1, -1).map(nodeName).join(', ') || 'direct'}`, etaMin: route.min, stepFree,
          detail: stepFree ? 'Step-free the whole way.' : 'Includes stairs at some stations.',
        });
      }
    }
    return out;
  }

  explain(d: Decision, p: Passenger, run: Run | null): { headline: string; lines: string[] } {
    const parts = d.priority.parts.map((x) => `${x.label}: +${x.points} (${x.detail})`);
    const where = run ? `${nodeName(run.dropAt)} at ${clockLabel(run.arriveAt)}` : '';
    if (d.outcome === 'SEATED' || d.outcome === 'COMMITTED_KEPT') {
      return { headline: `You have a seat to ${where}.`, lines: [`Priority group: ${d.priority.tierLabel}`, ...parts, `Priority score: ${d.priority.score}`] };
    }
    if (d.outcome === 'AWAITING_INFO') {
      return { headline: 'We need one answer before we can book you.', lines: ['Wheelchair spaces are only on some vehicles, so we will not guess.'] };
    }
    if (d.witness?.kind === 'NO_OPTION') {
      return { headline: `No vehicle can reach ${nodeName(p.dest)} right now.`, lines: ['Every route there is closed or unverified. See your alternatives below.'] };
    }
    if (d.witness?.kind === 'FRAGMENTED') {
      return {
        headline: 'There is no single vehicle with room for your whole group.',
        lines: ['Seats exist, but not together. Your group stays on the list so you are not separated.', ...parts],
      };
    }
    const vehicles = new Set((d.witness?.pools ?? []).map((x) => x.split(':')[0])).size;
    return {
      headline: `All ${d.capacity} seats on the ${vehicles} ${vehicles === 1 ? 'trip' : 'trips'} that can reach you are taken by people ahead of you.`,
      lines: [
        'No rearrangement of passengers could free a seat for you. This is checked, not estimated.',
        `Priority group: ${d.priority.tierLabel}`,
        ...parts,
        `Priority score: ${d.priority.score}`,
      ],
    };
  }

  passengerView(pid: string) {
    const p = this.passenger(pid);
    if (!p) throw new HubError('NOT_FOUND', 'No such passenger', 404);
    const seat = this.db.prepare(`SELECT * FROM seats WHERE pid = ? AND state IN ${ACTIVE_SEAT}`).get(pid) as any;
    const run = seat ? this.run(seat.run_id) : null;
    const decision = this.latestDecision(pid);
    const open = this.clarifications(pid).find((c) => c.state === 'OPEN' || c.state === 'ESCALATED') ?? null;
    return {
      passenger: p,
      seat: seat ? { state: seat.state, seatUnits: seat.seat_units, bayUnits: seat.bay_units, passId: seat.pass_id } : null,
      run: run ? { ...run, dropName: nodeName(run.dropAt), departLabel: clockLabel(run.departAt), arriveLabel: clockLabel(run.arriveAt) } : null,
      pass: seat?.pass_token ?? null,
      decision,
      explanation: decision ? this.explain(decision, p, run) : null,
      alternatives: seat ? [] : this.alternatives(p),
      clarification: open,
      publicKeys: this.publicKeys,
      // Every phone keeps a copy of the head it saw, so the ledger's tail cannot quietly vanish.
      ledgerHead: { seq: this.seq, hash: this.lastHash },
    };
  }

  state() {
    const n = (sql: string, ...args: unknown[]) => (this.db.prepare(sql).get(...args) as { c: number }).c;
    const people = (where: string) => n(`SELECT COALESCE(SUM(party), 0) c FROM passengers WHERE ${where}`);
    const planned = this.runs();
    const fleet = this.vehicles();
    const over = n('SELECT COUNT(*) c FROM runs WHERE seats_taken + escrow_seats > seats_total OR bays_taken > bays_total');
    const beliefs = this.beliefs();
    const epoch = this.latestEpoch();
    const refused = epoch ? n(`SELECT COUNT(*) c FROM decisions WHERE epoch = ? AND outcome = 'WAITLISTED'`, epoch.id) : 0;
    const corridors = CORRIDORS.map((c) => {
      const mine = planned.filter((r) => r.corridor === c.id);
      return {
        id: c.id, name: c.name, trips: mine.length, seatsPlanned: mine.reduce((s, r) => s + r.seatsTotal, 0), seatsTaken: mine.reduce((s, r) => s + r.seatsTaken, 0),
        vehicles: new Set(mine.map((r) => r.vehicleId)).size,
      };
    });
    return {
      clock: this.now,
      clockLabel: clockLabel(this.now),
      offline: this.offline,
      mode: this.meta('mode'),
      projected: JSON.parse(this.meta('projected') ?? '{}'),
      policy: { version: this.policy().version, name: this.policy().name },
      kpis: {
        stranded: people(`state IN ('WAITING','ASSIGNED','AWAITING_INFO')`),
        waitlistedRecords: refused,
        waitlistedPeople: people(`state = 'WAITING'`),
        assigned: people(`state = 'ASSIGNED'`),
        boarded: people(`state = 'BOARDED'`),
        departed: people(`state = 'DEPARTED'`),
        awaitingInfo: people(`state = 'AWAITING_INFO'`),
        fleetActive: fleet.filter((v) => v.active).length,
        fleetTotal: fleet.length,
        seatsPlanned: planned.reduce((s, r) => s + r.seatsTotal, 0),
        seatsTaken: planned.reduce((s, r) => s + r.seatsTaken, 0),
        overAllocated: over,
        unresolvedRoutes: beliefs.filter((b) => b.state !== 'TRUSTED').length,
        pendingApprovals: n(`SELECT COUNT(*) c FROM approvals WHERE state = 'PENDING'`),
        quarantined: n('SELECT COUNT(*) c FROM quarantine'),
      },
      corridors,
      runs: planned.slice(0, 60).map((r) => ({ ...r, dropName: nodeName(r.dropAt), departLabel: clockLabel(r.departAt), arriveLabel: clockLabel(r.arriveAt) })),
      fleet,
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

function coverageSummary(p: LanguagePack) {
  const c = coverage(p);
  return { translated: c.translated, total: c.total, criticalVerified: c.criticalVerified, critical: c.critical };
}

function makeDecision(
  pid: string, epoch: number, outcome: Decision['outcome'], o: OptionIn | null, priority: Priority, witness: Witness | null,
  shadow: Shadow, result: ReturnType<typeof allocate>,
): Decision {
  let rivals = 0;
  let capacity = 0;
  if (witness && witness.kind === 'HALL') {
    const caps = new Map(shadow.pools.map((p) => [p.id, p.cap]));
    for (const pool of witness.pools) {
      capacity += caps.get(pool) ?? 0;
      rivals += (caps.get(pool) ?? 0) - (result.free.get(pool) ?? 0);
    }
  }
  const bay = o ? Object.keys(o.demand).some((k) => k.endsWith(':B')) : false;
  return { pid, epoch, outcome, runId: o?.run ?? null, pool: o ? (bay ? 'B' : 'S') : null, priority, witness, rivals, capacity };
}

function leafValue(d: Decision) {
  return { pid: d.pid, epoch: d.epoch, outcome: d.outcome, runId: d.runId, pool: d.pool, tier: d.priority.tierId, score: d.priority.score };
}

function decisionLeaves(list: Decision[]): string[] {
  return [...list].sort((a, b) => (a.pid < b.pid ? -1 : 1)).map((d) => leafHash(leafValue(d)));
}

function rowToPassenger(r: any): Passenger {
  return {
    pid: r.pid, dest: r.dest, need: r.need, party: r.party, deadlineKind: r.deadline_kind, deadlineAt: r.deadline_at,
    deadlineVerified: !!r.deadline_verified, checkinAt: r.checkin_at, state: r.state, displaced: !!r.displaced,
  };
}

function rowToRun(r: any): Run {
  return {
    id: r.id, vehicleId: r.vehicle_id, corridor: r.corridor, dropAt: r.drop_at, mode: r.mode, departAt: r.depart_at, arriveAt: r.arrive_at,
    returnAt: r.return_at, seatsTotal: r.seats_total, seatsTaken: r.seats_taken, baysTotal: r.bays_total, baysTaken: r.bays_taken,
    escrowSeats: r.escrow_seats, state: r.state,
  };
}

function rowToDecision(r: any): Decision {
  return {
    pid: r.pid, epoch: r.epoch, outcome: r.outcome, runId: r.run_id, pool: r.pool, priority: JSON.parse(r.priority),
    witness: r.witness ? JSON.parse(r.witness) : null, rivals: r.rivals, capacity: r.capacity,
  };
}
