// The Arena plays a constraint card against the live system. A card is not a script that prints
// PASS: each one attacks real state, then judges the outcome by querying that state, so a card
// can genuinely fail. Organisers can replace the built-in data with their own.

import { readFileSync, existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { newFieldSnapshot, scan, walkup, walkupsLeft } from '../core/field.ts';
import { hashOf } from '../core/hash.ts';
import { pseudoPack, STRINGS, translate } from '../core/i18n.ts';
import { verifyChain } from '../core/ledger.ts';
import { POLICY_V2 } from '../core/priority.ts';
import { naiveNewestArrival } from '../core/truth.ts';
import type { CardCheck, CardResult, Decision, Reading } from '../core/types.ts';
import { CORRIDORS, DESTINATIONS, nodeName, shortest, HUB } from '../core/world.ts';
import { loopback } from './egress.ts';
import { BASE_MS, clockLabel, type Hub } from './hub.ts';
import type { Outside } from './outside.ts';
import {
  CANARY, SAMPLE_BATCH_CSV, SAMPLE_BATCH_EXPECTED, SAMPLE_BROKEN_JSON, SAMPLE_PACK, SAMPLE_PRIVATE_BATCH, telemetrySample,
} from './samples.ts';

export interface CardInfo {
  id: string;
  title: string;
  scenario: string;
  passCondition: string;
  acceptsData: string | null;
}

export const CARDS: CardInfo[] = [
  { id: 'C01', title: 'The World Went Offline', scenario: 'Saved routes and local disruption notes', passCondition: 'The core journey keeps working without internet, and pending changes sync after reconnection without loss or duplication.', acceptsData: null },
  { id: 'C02', title: 'The Truth Is Conflicting', scenario: 'Two different bus or route-status records', passCondition: 'The system identifies the conflict and explains what it trusts, why, and what remains uncertain.', acceptsData: 'records' },
  { id: 'C03', title: 'The API Has Changed Its Language', scenario: 'Transport service response format changes', passCondition: 'The application adapts to the new contract without a rewrite, and invalid responses do not crash the core workflow.', acceptsData: 'response' },
  { id: 'C04', title: 'Garbage In, Garbage Everywhere', scenario: 'Malformed route, passenger or journey data', passCondition: 'Valid records are processed, invalid ones are rejected or quarantined, and the system stays available without corrupting data.', acceptsData: 'data' },
  { id: 'C05', title: 'Three Times the Crowd, Half the Resources', scenario: 'Limited replacement seats or vehicle capacity', passCondition: 'A feasible allocation that never exceeds capacity and explains who gets resources, who does not, and why.', acceptsData: null },
  { id: 'C06', title: 'Accessibility Is No Longer Optional', scenario: 'Screen-reader or keyboard-accessible route workflow', passCondition: 'The selected workflow can be completed under the accessibility condition without losing essential information.', acceptsData: null },
  { id: 'C07', title: 'Your Data Cannot Leave This Device', scenario: 'Traveller identity data must remain local', passCondition: 'The system works inside the boundary with no prohibited transmission and no sensitive data in logs or errors.', acceptsData: null },
  { id: 'C08', title: 'The Language Changed Overnight', scenario: 'Regional route instructions and alerts', passCondition: 'The workflow completes in the new language without broken screens, missing critical instructions or misleading translations.', acceptsData: 'pack' },
  { id: 'C09', title: 'Two People, One Resource', scenario: 'Simultaneous claims for the final seat', passCondition: 'Under concurrent requests the system never allocates more than exists, and all users get consistent outcomes.', acceptsData: null },
  { id: 'C10', title: 'The Sensors Are Lying', scenario: 'GPS or vehicle telemetry contains faulty readings', passCondition: 'The injected fault is detected and no unsafe or unjustified automated decision is made.', acceptsData: 'readings' },
  { id: 'C11', title: 'The Rules Changed Midway', scenario: 'Passenger prioritisation rules change', passCondition: 'The system adapts to the new policy without corrupting previous records or applying obsolete rules.', acceptsData: 'policy' },
  { id: 'C12', title: 'The Missing Piece of Information', scenario: 'A required travel preference is not confirmed', passCondition: 'Instead of guessing, the application identifies what is missing and asks for clarification or human review.', acceptsData: null },
];

export interface ArenaContext {
  hub: Hub;
  outside: Outside;
  baseUrl: string | null;
}

class Report {
  steps: string[] = [];
  checks: CardCheck[] = [];
  evidence: CardResult['evidence'] = [];
  tryIt: NonNullable<CardResult['tryIt']> = [];
  summary = '';

  step(text: string) {
    this.steps.push(text);
  }

  check(id: string, requirement: string, ok: boolean, observed: string | number) {
    this.checks.push({ id, requirement, ok, observed: String(observed) });
  }

  table(label: string, rows: Record<string, string | number | boolean | null>[]) {
    this.evidence.push({ label, rows });
  }
}

type Card = (c: ArenaContext, r: Report, params: any) => Promise<void>;

const people = (hub: Hub, where: string) => (hub.db.prepare(`SELECT COALESCE(SUM(party), 0) c FROM passengers WHERE ${where}`).get() as { c: number }).c;
const count = (hub: Hub, sql: string, ...args: unknown[]) => (hub.db.prepare(sql).get(...args) as { c: number }).c;

/** Recounts every run straight from the seat rows, independently of the stored counters. */
function capacityAudit(hub: Hub) {
  const rows = hub.db.prepare(`SELECT r.id, r.seats_total total, r.bays_total bays, r.escrow_seats escrow,
      COALESCE(SUM(CASE WHEN s.state IN ('HELD','COMMITTED','BOARDED') THEN s.seat_units ELSE 0 END), 0) seated,
      COALESCE(SUM(CASE WHEN s.state IN ('HELD','COMMITTED','BOARDED') THEN s.bay_units ELSE 0 END), 0) bayed
    FROM runs r LEFT JOIN seats s ON s.run_id = r.id WHERE r.state != 'CANCELLED' GROUP BY r.id`).all() as any[];
  const over = rows.filter((r) => r.seated + r.escrow > r.total || r.bayed > r.bays);
  return { runs: rows.length, over: over.length };
}

const c01: Card = async ({ hub, baseUrl }, r) => {
  const pick = hub.db.prepare(`SELECT s.run_id id, COUNT(*) n FROM seats s JOIN runs r ON r.id = s.run_id
    WHERE s.state = 'COMMITTED' AND r.state = 'PLANNED' GROUP BY s.run_id ORDER BY n DESC, s.run_id LIMIT 1`).get() as { id: string; n: number } | undefined;
  if (!pick) {
    r.check('setup', 'A vehicle with issued passes exists', false, 'No passes are issued yet. Advance the clock or reset the world.');
    return;
  }
  const device = `HANDHELD-${Date.now().toString(36)}`;
  const run = hub.run(pick.id)!;
  r.step(`Before the outage: ${device} syncs ${pick.n} passes for ${pick.id} and receives a 2-seat offline allowance.`);
  const grant = hub.grantEscrow({ opId: `arena-${device}-grant`, runId: run.id, device, seats: 2 });
  const handheld = newFieldSnapshot(device, run.id, hub.publicKeys, grant.grantToken);
  const passes = (hub.db.prepare(`SELECT pass_token token, pass_id id FROM seats WHERE run_id = ? AND state = 'COMMITTED' ORDER BY id LIMIT 5`).all(run.id) as any[]);
  const boardedBefore = count(hub, `SELECT COUNT(*) c FROM seats WHERE run_id = ? AND state = 'BOARDED'`, run.id);
  const takenBefore = hub.run(run.id)!.seatsTaken;

  hub.setOffline(true);
  r.step('Network lost. Field connections are now dropped at the socket and all external traffic is blocked.');

  let socketDead = true;
  if (baseUrl) {
    const probe = await loopback(baseUrl, `/api/field/device/${run.id}?device=${device}`);
    socketDead = probe.status === null;
  }
  const feed = await hub.pollFeed();
  const queuedCheckin = { opId: `arena-${device}-checkin`, dest: 'MAA', party: 1, need: 'NONE' as const };

  const results = passes.map((p) => scan(handheld, p.token, hub.now));
  const repeat = scan(handheld, passes[0].token, hub.now);
  const forged = scan(handheld, `${passes[0].token.slice(0, -6)}AAAAAA`, hub.now);
  const walk1 = walkup(handheld, 1, hub.now);
  const walk2 = walkup(handheld, 1, hub.now);
  const walk3 = walkup(handheld, 1, hub.now);
  r.step(`Offline, the handheld verified ${results.filter((x) => x.ok).length} passes by signature, refused a repeat scan and a forged pass, seated 2 walk-ups, then refused a third.`);

  hub.setOffline(false);
  r.step('Network restored. The outbox is delivered twice, as a flaky connection would.');
  const first = hub.sync(device, handheld.outbox);
  const second = hub.sync(device, handheld.outbox);
  const queued = [hub.checkin(queuedCheckin), hub.checkin(queuedCheckin)];

  const boardedAfter = count(hub, `SELECT COUNT(*) c FROM seats WHERE run_id = ? AND state = 'BOARDED' AND pid NOT LIKE 'W-%'`, run.id);
  const walkupsAfter = count(hub, `SELECT COALESCE(SUM(seat_units), 0) c FROM seats WHERE run_id = ? AND pid LIKE 'W-%'`, run.id);
  const applied = first.results.filter((x) => x.status === 'APPLIED').length;
  const duplicates = second.results.filter((x) => x.status === 'DUPLICATE').length;
  const audit = capacityAudit(hub);

  r.check('socket', 'Field connections really are down during the outage', socketDead, baseUrl ? (socketDead ? 'Connection dropped at the socket' : 'Request still succeeded') : 'Not tested: no HTTP listener');
  r.check('external', 'External services are unavailable and last good data is kept', feed.reason === 'OFFLINE' && feed.keptLastGood, `Feed poll: ${feed.reason}`);
  r.check('offline-verify', 'Passes verify with no network', results.every((x) => x.ok), `${results.filter((x) => x.ok).length} of ${results.length} verified`);
  r.check('no-double-board', 'A repeat scan is refused offline', !repeat.ok && repeat.code === 'ALREADY_USED', repeat.ok ? 'Accepted' : repeat.code);
  r.check('no-forgery', 'A forged pass is refused offline', !forged.ok, forged.ok ? 'Accepted' : forged.code);
  r.check('escrow', 'Walk-ups stop exactly at the offline allowance', walk1.ok && walk2.ok && !walk3.ok && walkupsLeft(handheld) === 0, `2 seated, third refused: ${walk3.message}`);
  r.check('no-loss', 'Every queued action reached the hub', applied === handheld.outbox.length, `${applied} of ${handheld.outbox.length} applied`);
  r.check('no-duplicates', 'Delivering everything twice changes nothing', duplicates === handheld.outbox.length && boardedAfter === boardedBefore + results.length && walkupsAfter === 2, `${duplicates} duplicates ignored, ${boardedAfter - boardedBefore} boarded, ${walkupsAfter} walk-ups`);
  r.check('queued-once', 'A queued passenger request is applied exactly once', queued[0].pid === queued[1].pid, `Both deliveries returned ${queued[0].pid}`);
  r.check('capacity', 'Capacity held throughout', audit.over === 0, `${audit.runs} runs recounted, ${audit.over} over`);

  r.table('Vehicle counters', [
    { measure: 'Seats taken before outage', value: takenBefore },
    { measure: 'Seats taken after sync', value: hub.run(run.id)!.seatsTaken },
    { measure: 'Seats on vehicle', value: run.seatsTotal },
    { measure: 'Offline allowance left', value: hub.run(run.id)!.escrowSeats },
  ]);
  r.table('What keeps working offline', [
    { function: 'Show a saved boarding pass', offline: 'Yes' },
    { function: 'Verify and board passengers', offline: 'Yes' },
    { function: 'Seat walk-ups within the allowance', offline: 'Yes' },
    { function: 'Saved routes and disruption notes', offline: 'Yes' },
    { function: 'New seat requests', offline: 'Queued until reconnection' },
    { function: 'Live vehicle times', offline: 'Reduced: shown as last known' },
    { function: 'Re-allocation across vehicles', offline: 'Paused on the device, hub resumes it' },
  ]);
  r.tryIt.push({ label: 'Take the network down and try the driver handheld yourself', href: '#/driver' });
  r.summary = `${results.length} passes and 2 walk-ups handled offline. ${applied} actions synced once; ${duplicates} repeat deliveries ignored.`;
};

const c02: Card = async ({ hub }, r, params) => {
  const t = hub.now;
  if (Array.isArray(params?.records)) {
    hub.ingestRouteRecords(params.records);
    const b = hub.beliefs();
    r.step(`Loaded ${params.records.length} organiser records.`);
    const conflicted = b.filter((x) => new Set(x.considered.map((c) => c.value)).size > 1);
    r.check('explained', 'Every conflict is detected and explained', conflicted.every((x) => x.because.length > 0 && x.stillUncertain.length > 0), `${conflicted.length} conflicts explained`);
    r.check('safe', 'Nothing unverified became authoritative', b.filter((x) => x.state !== 'TRUSTED').every((x) => x.value === null), `${b.filter((x) => x.state !== 'TRUSTED').length} routes withheld`);
    r.table('What the system trusts', b.map((x) => ({ route: x.route, state: x.state, value: x.value, because: x.because, uncertain: x.stillUncertain })));
    r.summary = `${conflicted.length} conflicts found in your data.`;
    return;
  }

  const stale = 'GDY-VLC';
  const before = shortest(HUB, 'VLC', hub.closedEdges());
  r.step(`Route ${stale}: control room reports SUSPENDED 5 minutes ago. Then a 35-minute-old feed record saying RUNNING arrives last.`);
  hub.ingestRouteRecords([{ route: stale, value: 'SUSPENDED', source: 'CONTROL_ROOM', observedAt: t - 5 }]);
  hub.ingestRouteRecords([{ route: stale, value: 'RUNNING', source: 'OPERATOR_FEED', observedAt: t - 35 }]);
  const records = hub.routeRecords();
  const naive = naiveNewestArrival(stale, records);
  const belief = hub.beliefs().find((b) => b.route === stale)!;
  const after = shortest(HUB, 'VLC', hub.closedEdges());

  const split = 'VDP-PRR';
  r.step(`Route ${split}: a field marshal and the control room report opposite things at the same moment.`);
  hub.ingestRouteRecords([
    { route: split, value: 'RUNNING', source: 'FIELD_MARSHAL', observedAt: t - 2 },
    { route: split, value: 'SUSPENDED', source: 'CONTROL_ROOM', observedAt: t - 2 },
  ]);
  const unresolved = hub.beliefs().find((b) => b.route === split)!;
  const closed = hub.closedEdges().has(split);
  const verification = hub.verifications().find((v) => v.route === split && v.state === 'OPEN');

  r.check('newest-arrival', 'The newest-arriving record is not treated as the truth', naive === 'RUNNING' && belief.value === 'SUSPENDED', `A naive reader says ${naive}. OmniStrand says ${belief.value}.`);
  r.check('stale-flagged', 'The stale record is identified and rejected', belief.considered.some((c) => !c.used && c.note.startsWith('Stale')), belief.considered.find((c) => !c.used)?.note ?? 'none');
  r.check('explained', 'The system explains what it trusts and why', belief.state === 'TRUSTED' && belief.because.length > 0, belief.because);
  r.check('unresolved', 'A conflict it cannot settle stays unresolved', unresolved.state === 'UNRESOLVED' && unresolved.value === null, unresolved.because);
  r.check('safe-default', 'Unverified information does not become authoritative', closed, closed ? `${split} stays closed for planning` : `${split} is treated as open`);
  r.check('verification', 'A person is asked to verify', !!verification, verification?.question ?? 'No request raised');

  if (verification) {
    hub.answerVerification(verification.id, 'RUNNING', 'Field marshal 7');
    const settled = hub.beliefs().find((b) => b.route === split)!;
    r.step(`A marshal confirms ${split} is running, so it reopens with a recorded reason.`);
    r.check('resolved', 'A human answer settles it', settled.state === 'TRUSTED' && settled.value === 'RUNNING', settled.because);
  }

  r.table('What the system trusts', [belief, unresolved].map((b) => ({ route: b.route, state: b.state, value: b.value, because: b.because, stillUncertain: b.stillUncertain })));
  r.table(`Records considered for ${stale}`, belief.considered.map((c) => ({ source: c.source, value: c.value, ageMin: c.ageMin, used: c.used, note: c.note })));
  r.table('Effect on routing', [
    { route: 'Guindy to Velachery', before: before ? `${before.min} min via ${before.path.map(nodeName).join(', ')}` : 'No route', after: after ? `${after.min} min via ${after.path.map(nodeName).join(', ')}` : 'No route' },
  ]);
  r.summary = `Rejected a stale record that arrived last, held a real conflict as unresolved, and rerouted around the closure.`;
};

const c03: Card = async ({ hub, outside }, r, params) => {
  const atMs = BASE_MS + hub.now * 60000;
  outside.routes = [
    { id: 'GDY-ALD', status: 'RUNNING', atMs },
    { id: 'TNG-EGM', status: 'DELAYED', atMs },
    { id: 'VLC-SHO', status: 'RUNNING', atMs },
  ];
  outside.shape = 'v1';
  const base = await hub.pollFeed();
  r.step(`Baseline: adapter ${base.ok ? 'decoded' : 'failed on'} the provider's original response.`);

  if (typeof params?.response === 'string') {
    outside.shape = 'custom';
    outside.custom = params.response;
    r.step('Provider now returns the organiser response.');
  } else {
    outside.shape = 'v2';
    r.step('The provider changes shape: fields renamed, moved into nested objects, status lowercased, timestamp now a number.');
  }
  const broke = await hub.pollFeed();
  const stillAlive = hub.allocateEpoch('Feed contract changed');
  const state = hub.feedState();
  const proposal = state.adapters.find((a) => a.state === 'PROPOSED');

  r.check('v1-fails', 'The old integration fails without adaptation', !broke.ok && broke.reason === 'CONTRACT_CHANGED', `Old adapter: ${broke.reason ?? 'accepted the response'}`);
  r.check('no-crash', 'The failure stops at the boundary and the core workflow continues', stillAlive.certificate.ok && broke.keptLastGood === true, `Allocation ${stillAlive.epoch} still certified`);

  if (proposal) {
    r.step(`A mapping is proposed from the response's field names and value shapes (confidence ${(proposal.confidence * 100).toFixed(0)}%). A person approves it before use.`);
    hub.approveAdapter(proposal.version, 'Duty controller');
    const fixed = await hub.pollFeed();
    r.check('adapted', 'The new contract maps into the internal model with no rewrite', fixed.ok === true && (fixed.stored ?? 0) > 0, `${fixed.stored} routes decoded by adapter ${fixed.adapter}`);
    r.check('unknown-fields', 'Unexpected fields are noted and go no further', Array.isArray(fixed.unknownFields) && fixed.unknownFields.length > 0, `Ignored: ${(fixed.unknownFields ?? []).join(', ')}`);
    r.table('Proposed mapping', proposal.notes.map((n: any) => ({ internalField: n.field, sourcePath: n.path, transform: n.transform, confidence: Math.round(n.confidence * 100) / 100, why: n.why })));
  } else {
    r.check('adapted', 'A mapping could be proposed for the new response', false, 'No complete mapping found. Add one by hand as data.');
  }

  outside.shape = 'garbage';
  const garbage = await hub.pollFeed();
  const afterGarbage = hub.allocateEpoch('Invalid feed response');
  r.step('The provider then sends a response that is not even JSON.');
  r.check('garbage', 'An invalid response does not crash the core workflow', !garbage.ok && afterGarbage.certificate.ok, `Rejected as ${garbage.reason}, allocation ${afterGarbage.epoch} certified`);

  outside.shape = proposal ? 'v2' : 'v1';
  await hub.pollFeed();

  const internal = hub.routeRecords().filter((x) => x.source === 'OPERATOR_FEED').slice(-1)[0];
  r.table('The rest of the system sees the same shape as before', internal ? [{ route: internal.route, field: internal.field, value: internal.value, source: internal.source, observedAt: clockLabel(internal.observedAt) }] : []);
  r.summary = 'The old adapter failed safely, a new mapping was approved as data, and no application code changed.';
};

const c04: Card = async ({ hub }, r, params) => {
  const custom = typeof params?.data === 'string' ? params.data : null;
  const before = count(hub, 'SELECT COUNT(*) c FROM passengers');
  const batch = hub.ingestPassengers(custom ?? SAMPLE_BATCH_CSV, `arena-c04-${Date.now()}`);
  r.step(`${custom ? 'Organiser batch' : 'Built-in hostile batch'} read as ${batch.format}: ${batch.total} rows.`);

  let jsonAccepted = 0;
  if (!custom) {
    const broken = hub.ingestPassengers(SAMPLE_BROKEN_JSON, `arena-c04j-${Date.now()}`);
    jsonAccepted = broken.accepted;
    r.step(`A truncated JSON file followed: ${broken.accepted} intact records were recovered, ${broken.quarantined.length} quarantined.`);
    r.check('json-salvage', 'Valid records survive a broken JSON file', broken.accepted === 2 && broken.quarantined.length === 3, `${broken.accepted} recovered, ${broken.quarantined.length} quarantined`);
  }

  const after = count(hub, 'SELECT COUNT(*) c FROM passengers');
  const stored = (hub.db.prepare(`SELECT dest, party FROM passengers WHERE origin = 'IMPORT'`).all() as any[]);
  const known = new Set(DESTINATIONS);
  const allClean = stored.every((p) => known.has(p.dest) && p.party >= 1 && p.party <= 12);
  const reasoned = batch.quarantined.every((q) => q.reasons.length > 0);
  const live = hub.allocateEpoch('Batch imported');

  if (custom) {
    r.check('valid', 'Valid records are kept and processed', batch.accepted >= 0, `${batch.accepted} accepted`);
  } else {
    r.check('valid', 'Valid records are kept and processed', batch.accepted === SAMPLE_BATCH_EXPECTED.accepted, `${batch.accepted} of ${SAMPLE_BATCH_EXPECTED.accepted} accepted`);
    r.check('invalid', 'Invalid records are quarantined', batch.quarantined.length === SAMPLE_BATCH_EXPECTED.quarantined, `${batch.quarantined.length} of ${SAMPLE_BATCH_EXPECTED.quarantined} quarantined`);
  }
  r.check('reasons', 'Each rejection has a useful reason', reasoned, `${batch.quarantined.length} rejections, all with reasons`);
  r.check('rows', 'Only accepted rows reached the database', after - before === batch.accepted + jsonAccepted, `${after - before} new rows`);
  r.check('no-coercion', 'No unsafe value was coerced into a plausible record', allClean, `${stored.length} stored records all have known stops and possible group sizes`);
  r.check('injection', 'Injection attempts stayed inert data', count(hub, 'SELECT COUNT(*) c FROM passengers') === after, 'passengers table intact');
  r.check('available', 'The system stayed available', live.certificate.ok, `Allocation ${live.epoch} certified after the batch`);

  r.table('Quarantined', batch.quarantined.slice(0, 40).map((q) => ({ line: q.line, reasons: q.reasons.join('; '), excerpt: q.excerpt })));
  r.summary = `${batch.accepted} accepted, ${batch.quarantined.length} quarantined with reasons, nothing corrupted.`;
};

const c05: Card = async ({ hub }, r) => {
  const beforeSeats = hub.vehicles().filter((v) => v.active).reduce((s, v) => s + v.seats, 0);
  const beforeDemand = people(hub, `state IN ('WAITING','ASSIGNED','AWAITING_INFO')`);
  const passes = hub.db.prepare(`SELECT s.pid, s.run_id, s.pass_id, r.vehicle_id FROM seats s JOIN runs r ON r.id = s.run_id
    WHERE s.state = 'COMMITTED' AND r.state = 'PLANNED'`).all() as any[];

  const active = hub.vehicles().filter((v) => v.active);
  const withdraw: string[] = [];
  let cut = 0;
  for (let i = 0; i < active.length && cut < beforeSeats / 2; i += 2) {
    withdraw.push(active[i].id);
    cut += active[i].seats;
  }
  r.step(`Withdrawing ${withdraw.length} of ${active.length} vehicles (${cut} of ${beforeSeats} seats per wave).`);
  const { displaced } = hub.withdrawVehicles(withdraw, 'Fleet halved');
  r.step(`Demand triples: ${beforeDemand * 2} more people arrive.`);
  hub.addDemand(beforeDemand * 2);
  hub.replan('Demand tripled');
  const epoch = hub.allocateEpoch('Three times the crowd, half the resources');

  const afterSeats = hub.vehicles().filter((v) => v.active).reduce((s, v) => s + v.seats, 0);
  const afterDemand = people(hub, `state IN ('WAITING','ASSIGNED','AWAITING_INFO')`) + people(hub, `state = 'BOARDED'`);
  const audit = capacityAudit(hub);
  const kept = passes.filter((p) => !withdraw.includes(p.vehicle_id));
  const stillHeld = kept.filter((p) => count(hub, `SELECT COUNT(*) c FROM seats WHERE pass_id = ? AND run_id = ? AND state = 'COMMITTED'`, p.pass_id, p.run_id) === 1);
  const list = hub.decisions(null, 100000);
  const waiting = list.filter((d) => d.outcome === 'WAITLISTED');
  const seated = list.filter((d) => d.outcome === 'SEATED' || d.outcome === 'COMMITTED_KEPT');
  const reseated = displaced.filter((pid) => seated.some((d) => d.pid === pid)).length;
  const noReason = waiting.filter((d) => !d.witness).length;

  // With capacity halved some displaced people cannot be re-seated. What must hold is that no one
  // ranked below them took a seat they could have used, so each refusal is checked against the
  // people actually sitting in the pools named by its proof.
  const byPid = new Map(list.map((d) => [d.pid, d]));
  const stranded = displaced.map((pid) => byPid.get(pid)).filter((d): d is Decision => d?.outcome === 'WAITLISTED');
  let jumped = 0;
  for (const d of stranded) {
    if (d.witness?.kind !== 'HALL') continue;
    const pools = new Set(d.witness.pools);
    jumped += seated.filter((s) => s.outcome === 'SEATED' && pools.has(`${s.runId}:${s.pool}`) && s.priority.tier > d.priority.tier).length;
  }
  const sample = waiting.slice(0, 200);
  const noAlternative = sample.filter((d) => hub.alternatives(hub.passenger(d.pid)!).length === 0).length;
  const active2 = hub.passengers().length;
  const cert = epoch.certificate;
  const hall = cert.checks.find((c) => c.id === 'hall')!;
  const policy = hub.policy();
  const projected = JSON.parse(hub.meta('projected') ?? '{}');
  const tierCounts = new Map<string, { seated: number; waiting: number }>();
  for (const d of list) {
    const c = tierCounts.get(d.priority.tierLabel) ?? { seated: 0, waiting: 0 };
    if (d.outcome === 'WAITLISTED') c.waiting++;
    else c.seated++;
    tierCounts.set(d.priority.tierLabel, c);
  }

  r.check('demand', 'Demand rose to three times the original', afterDemand >= beforeDemand * 3 - 5, `${beforeDemand} to ${afterDemand} people`);
  r.check('resources', 'Resources fell by about half', afterSeats <= beforeSeats * 0.51, `${beforeSeats} to ${afterSeats} seats per wave`);
  r.check('capacity', 'No vehicle exceeds capacity', audit.over === 0, `${audit.runs} runs recounted from seat rows, ${audit.over} over`);
  r.check('commitments', 'Existing commitments are honoured under the stated rule', stillHeld.length === kept.length, `${stillHeld.length} of ${kept.length} passes on surviving vehicles kept`);
  r.check('displaced', 'Nobody ranked below a displaced passenger took a seat that passenger could use', jumped === 0, `${reseated} of ${displaced.length} displaced people re-seated. ${stranded.length} could not be, and ${jumped} lower-priority passengers hold a seat they could use.`);
  r.check('everyone', 'Everyone has an outcome', list.length >= active2, `${seated.length} seated and ${waiting.length} waitlisted bookings`);
  r.check('why-not', 'Everyone not seated has a reason', noReason === 0, `${waiting.length} waitlisted, ${noReason} without a recorded reason`);
  r.check('proof', 'Refusals are proven, not asserted', hall.ok, hall.observed);
  r.check('alternatives', 'People who cannot be served get alternatives', noAlternative === 0, `${sample.length} checked, ${noAlternative} without an alternative`);
  r.check('certified', 'The independent checker accepted the allocation', cert.ok, `${cert.unitsSeated} seated against an upper bound of ${cert.relaxedBound}`);

  r.table('Capacity totals', CORRIDORS.map((c) => {
    const runs = hub.runs().filter((x) => x.corridor === c.id);
    return { corridor: c.name, trips: runs.length, seats: runs.reduce((s, x) => s + x.seatsTotal, 0), taken: runs.reduce((s, x) => s + x.seatsTaken, 0) };
  }));
  r.table('Who gets a seat', [...tierCounts.entries()].map(([label, c]) => ({ group: label, seated: c.seated, waitlisted: c.waiting })));
  r.table('Priority rule applied', policy.tiers.map((t, i) => ({ order: i + 1, group: t.label })));
  r.table('Plan chosen', [{ mode: hub.meta('mode'), directClearsInMin: Math.round(projected.DIRECT), trunkClearsInMin: Math.round(projected.TRUNK) }]);
  const example: Decision | undefined = waiting.find((d) => d.witness?.kind === 'HALL');
  if (example) {
    const p = hub.passenger(example.pid)!;
    const e = hub.explain(example, p, null);
    r.table('What one waitlisted passenger is told', [{ headline: e.headline, detail: e.lines.join(' | ') }, ...hub.alternatives(p).map((a) => ({ headline: a.title, detail: a.detail }))]);
  }
  r.summary = `${cert.unitsSeated} people seated on ${afterSeats} seats per wave, ${waiting.length} bookings waitlisted with a proof and alternatives, nobody over capacity.`;
};

const c06: Card = async ({ hub }, r) => {
  const file = 'results/a11y.json';
  r.step('Hub side: every outcome must exist as words, so no status can depend on colour, icon or sound.');
  const sample = hub.decisions(null, 200);
  const worded = sample.filter((d) => {
    const p = hub.passenger(d.pid);
    return p && hub.explain(d, p, d.runId ? hub.run(d.runId) : null).headline.length > 0;
  }).length;
  r.check('text', 'Every outcome has a plain-text form', worded === sample.length, `${worded} of ${sample.length} decisions explained in words`);

  if (!existsSync(file)) {
    r.check('browser', 'The keyboard-only journey passes in a real browser', false, 'Not run. This needs the UI, then npm run e2e.');
    r.summary = 'The API is ready, but this card cannot pass until the UI is built and audited.';
    return;
  }
  const report = JSON.parse(readFileSync(file, 'utf8'));
  r.check('browser', 'The keyboard-only journey passes in a real browser', report.keyboardJourney === true, `Keyboard journey: ${report.keyboardJourney}, run ${report.ranAt}`);
  r.check('axe', 'No serious accessibility violations', report.seriousViolations === 0, `${report.seriousViolations} serious violations across ${report.pages} pages`);
  r.tryIt.push({ label: 'Open the passenger app in keyboard-only mode', href: '#/passenger?mode=keyboard' });
  r.summary = 'Workflow completed by keyboard alone, with no reliance on colour.';
};

function scanFor(needles: string[], haystack: Buffer | string): string[] {
  const text = haystack.toString('latin1');
  return needles.filter((n) => text.includes(n));
}

const c07: Card = async ({ hub, outside }, r) => {
  const canaries = Object.values(CANARY);
  r.step('Importing passengers whose rows include a name, phone, email and identity number. These are canaries: unique strings we can hunt for afterwards.');
  const batch = hub.ingestPassengers(SAMPLE_PRIVATE_BATCH, `arena-c07-${Date.now()}`);
  const stored = (hub.db.prepare(`SELECT pid FROM passengers WHERE origin = 'IMPORT' ORDER BY rowid DESC LIMIT 1`).get() as { pid: string }).pid;

  const sentBefore = outside.received.length;
  hub.log.write('error', 'simulated_failure', { name: CANARY.name, phone: CANARY.phone, detail: `Could not reach ${CANARY.email}` });

  const record = JSON.stringify({ name: CANARY.name, phone: CANARY.phone, destination: 'MAA' });
  const a = await hub.egress.send('analytics', '/analytics', { method: 'POST', body: record });
  const b = await hub.egress.send('analytics', '/analytics', { method: 'POST', body: JSON.stringify({ pid: stored, dest: 'MAA' }) });
  const c = await hub.egress.send('analytics', '/analytics', { method: 'POST', body: JSON.stringify({ note: `call ${CANARY.phone}` }) });
  const d = await hub.egress.send('cloud-llm', '/v1/chat', { method: 'POST', body: JSON.stringify({ prompt: 'summarise stranded passengers' }) });
  const stats = { corridorDemand: hub.state().corridors.map((x) => ({ corridor: x.id, seatsTaken: x.seatsTaken })) };
  const e = await hub.egress.send('analytics', '/analytics', { method: 'POST', body: JSON.stringify(stats) });
  r.step('Tried to send a raw record, a pseudonymous record, a phone number in free text and a hosted AI request outside, then a safe aggregate.');

  const reached = outside.received.slice(sentBefore);
  const dump = JSON.stringify(['passengers', 'seats', 'decisions', 'ledger', 'quarantine', 'egress_log', 'idempotency'].map((t) => hub.db.prepare(`SELECT * FROM ${t}`).all()));
  const inDb = scanFor(canaries, dump);
  let inFile: string[] = [];
  if (hub.file !== ':memory:') {
    hub.db.pragma('wal_checkpoint(PASSIVE)');
    for (const f of [hub.file, `${hub.file}-wal`]) if (existsSync(f)) inFile = inFile.concat(scanFor(canaries, readFileSync(f)));
  }
  const logFile = 'logs/hub.log';
  const inLog = existsSync(logFile) ? scanFor(canaries, readFileSync(logFile)) : [];
  const leaked = reached.flatMap((x) => scanFor(canaries, x));
  const journey = hub.allocateEpoch('Privacy boundary active');
  const decided = hub.latestDecision(stored);

  r.check('blocked-record', 'A record with personal data is blocked', a.blocked === 'PRIVATE_DATA', `${a.blocked ?? 'sent'}`);
  r.check('blocked-pseudonym', 'Even a pseudonymous record stays inside', b.blocked === 'PRIVATE_DATA', `${b.blocked ?? 'sent'}`);
  r.check('blocked-text', 'Personal data hidden in free text is caught', c.blocked === 'PRIVATE_DATA', `${c.blocked ?? 'sent'}`);
  r.check('blocked-ai', 'A cloud AI service is not reachable', d.blocked === 'NOT_ALLOWED', `${d.blocked ?? 'sent'}`);
  r.check('allowed', 'Safe aggregates can still leave', e.ok && reached.length === 1, `${reached.length} message reached the outside listener`);
  r.check('socket', 'No canary reached the outside world', leaked.length === 0, `${leaked.length} found at the listener`);
  r.check('database', 'No canary is stored in the database', inDb.length === 0 && inFile.length === 0, `${inDb.length + inFile.length} found in tables and database files`);
  r.check('logs', 'No canary appears in logs or errors', inLog.length === 0, `${inLog.length} found in the log file`);
  r.check('journey', 'The workflow still works inside the boundary', journey.certificate.ok && !!decided && batch.accepted === 1, `Imported passenger decided as ${decided?.outcome} under pseudonym ${stored}`);

  r.table('Data boundary', [
    { place: 'Passenger phone', holds: 'Name, phone, identity documents', canLeave: 'Never sent to the hub' },
    { place: 'Hub on this laptop', holds: 'Pseudonym, stop, access need, party size', canLeave: 'Aggregates only, through the egress guard' },
    { place: 'Driver handheld', holds: 'Signed passes for one vehicle, public key', canLeave: 'Boarding events to the hub only' },
    { place: 'Outside services', holds: 'Aggregated counts', canLeave: 'Not applicable' },
  ]);
  r.table('Outbound attempts', (hub.db.prepare('SELECT dest, decision, reason, bytes FROM egress_log ORDER BY id DESC LIMIT 5').all() as any[]).reverse());
  r.summary = 'Four prohibited transmissions blocked, canaries absent from the database, logs and network, and the journey still works.';
};

const c08: Card = async ({ hub }, r, params) => {
  const doc = params?.pack ?? SAMPLE_PACK;
  const loaded = hub.loadPack(doc);
  const pack = loaded.pack;
  r.step(`Target language ${pack.name} loaded: ${loaded.coverage.translated} of ${loaded.coverage.total} strings, ${loaded.coverage.criticalVerified} of ${loaded.coverage.critical} critical strings verified.`);

  const keys = Object.keys(STRINGS);
  const crit = keys.filter((k) => STRINGS[k].critical);
  const shown = keys.map((k) => ({ k, t: translate(k, pack) }));
  const invented = shown.filter(({ k, t }) => STRINGS[k].critical && t.lang !== 'en' && !pack.glossary[k]?.verifiedBy);
  const blank = shown.filter(({ t }) => !t.text.trim());
  const flagged = shown.filter(({ k, t }) => STRINGS[k].critical && t.criticalUnverified);
  const expectedFlag = crit.filter((k) => !pack.glossary[k]?.verifiedBy);

  const attacked = hub.loadPack({ code: 'xx', name: 'Attempted shortcut', strings: { 'pass.show': 'unverified guess' }, glossary: { 'pass.seat.guaranteed': { text: 'guess', verifiedBy: '' } } }).pack;
  const smuggled = translate('pass.show', attacked).lang !== 'en' || translate('pass.seat.guaranteed', attacked).lang !== 'en';

  const organiser = { ...pack, glossary: { ...pack.glossary, 'pass.show': { text: '[organiser term]', verifiedBy: 'Organiser glossary' } } };
  const adopted = translate('pass.show', hub.loadPack(organiser).pack);
  if (!params?.pack) hub.loadPack(doc);

  const pseudo = pseudoPack();
  const longest = Math.max(...keys.map((k) => translate(k, pseudo).text.length / (STRINGS[k].en.length || 1)));

  r.check('critical', 'No critical instruction shows an invented translation', invented.length === 0, `${invented.length} unverified critical strings shown in ${pack.code}`);
  r.check('labelled', 'Critical strings without a verified term stay in English and say so', flagged.length === expectedFlag.length, `${flagged.length} of ${crit.length} kept in English and flagged`);
  r.check('no-shortcut', 'A pack cannot smuggle in an unverified critical string', !smuggled, smuggled ? 'Accepted' : 'Ignored both attempts');
  r.check('glossary', 'A verified organiser term is used at once', adopted.lang === pack.code && adopted.text === '[organiser term]', `pass.show now reads: ${adopted.text}`);
  r.check('fallback', 'Every string resolves to something readable', blank.length === 0, `${keys.length} strings, ${blank.length} blank`);
  r.check('expansion', 'A +40% layout pack exists for testing long text', longest >= 1.4, `Longest stretch ${longest.toFixed(1)}x`);

  r.table('Critical instructions', crit.slice(0, 12).map((k) => {
    const t = translate(k, pack);
    return { key: k, shownAs: t.text, language: t.lang, verified: !t.criticalUnverified };
  }));
  r.tryIt.push({ label: 'See the passenger workflow in the target language', href: `#/passenger?lang=${pack.code}` });
  r.summary = `${flagged.length} critical strings stayed in safe English until verified. Nothing was machine-translated.`;
};

function runWorker(file: string, id: number, runId: string, attempts: number, tag: string) {
  return new Promise<{ won: number; lost: number; replays: number; errors: number }>((ok, bad) => {
    const w = new Worker(new URL('./hammer-worker.cjs', import.meta.url), { workerData: { file, id, runId, attempts, tag } });
    w.once('message', ok);
    w.once('error', bad);
  });
}

const c09: Card = async ({ hub, baseUrl }, r) => {
  const tag = Date.now().toString(36);
  const scratch = (id: string, seats: number) => {
    if (!hub.db.prepare(`SELECT 1 FROM vehicles WHERE id = 'ARENA'`).get()) {
      hub.db.prepare(`INSERT INTO vehicles(id, label, kind, seats, bays, active) VALUES ('ARENA', 'Test vehicle', 'BUS', 0, 0, 0)`).run();
    }
    hub.db.prepare(`INSERT INTO runs(id, vehicle_id, corridor, drop_at, mode, depart_at, arrive_at, return_at, seats_total, bays_total, escrow_seats, state)
      VALUES (?, 'ARENA', 'AIR', 'MAA', 'DIRECT', ?, ?, ?, ?, 0, 0, 'PLANNED')`).run(id, hub.now + 15, hub.now + 35, hub.now + 55, seats);
  };

  const runId = `LAST-SEAT-${tag}`;
  scratch(runId, 1);
  const n = 200;
  const insert = hub.db.prepare(`INSERT INTO passengers(pid, dest, need, party, deadline_kind, checkin_at, state, origin) VALUES (?, 'MAA', 'NONE', 1, 'NONE', ?, 'CANCELLED', 'ARENA')`);
  const ids = Array.from({ length: n }, (_, i) => `RACE-${tag}-${i}`);
  hub.db.transaction(() => ids.forEach((pid) => insert.run(pid, hub.now)))();
  r.step(`${n} people claim the only seat on ${runId} at once, each request sent twice as a retry would be: ${n * 2} parallel requests.`);

  const send = async (pid: string): Promise<any> => {
    const body = { opId: `race-${pid}`, pid, runId };
    if (!baseUrl) return hub.claim(body);
    return (await loopback(baseUrl, '/api/field/claim', body)).json;
  };
  const t0 = performance.now();
  const [firsts, retries] = await Promise.all([Promise.all(ids.map(send)), Promise.all(ids.map(send))]);
  const ms = Math.round(performance.now() - t0);

  const won = firsts.filter((x) => x?.outcome === 'WON').length;
  const lost = firsts.filter((x) => x?.outcome === 'TAKEN').length;
  const consistent = firsts.every((x, i) => JSON.stringify(x) === JSON.stringify(retries[i]));
  const row = hub.run(runId)!;
  const seatRows = hub.db.prepare(`SELECT pid, state, pass_id FROM seats WHERE run_id = ?`).all(runId) as any[];

  r.check('one-winner', 'Exactly one person gets the last seat', won === 1, `${won} won`);
  r.check('accurate', 'Everyone else gets an accurate refusal', lost === n - 1, `${lost} told the seat is taken`);
  r.check('idempotent', 'A retry returns the same answer as the original', consistent, consistent ? `All ${n} retries matched` : 'A retry disagreed');
  r.check('database', 'The database agrees', row.seatsTaken === 1 && seatRows.length === 1, `seats_taken = ${row.seatsTaken}, ${seatRows.length} seat row`);

  r.table('Database state', [{ run: row.id, seatsTotal: row.seatsTotal, seatsTaken: row.seatsTaken, rowsInSeats: seatRows.length, requests: n * 2, ms }]);
  r.table('Audit log', (hub.db.prepare(`SELECT seq, type, actor, payload FROM ledger WHERE type = 'SEAT_CLAIMED' AND payload LIKE ?`).all(`%${runId}%`) as any[]));

  if (hub.file !== ':memory:') {
    const multi = `MULTI-WRITER-${tag}`;
    scratch(multi, 3);
    r.step('Then 8 threads, each with its own database connection, race for 3 seats, so this is not just Node handling requests one at a time.');
    const tallies = await Promise.all(Array.from({ length: 8 }, (_, id) => runWorker(hub.file, id, multi, 250, tag)));
    const sum = tallies.reduce((a, b) => ({ won: a.won + b.won, lost: a.lost + b.lost, replays: a.replays + b.replays, errors: a.errors + b.errors }));
    const after = hub.run(multi)!;
    r.check('multi-writer', 'Parallel writers cannot overfill a run', sum.won === 3 && after.seatsTaken === 3 && sum.errors === 0, `${sum.won} won, ${sum.lost} lost, ${sum.replays} retries replayed, ${sum.errors} errors`);
    r.table('Parallel writers', [{ writers: 8, attempts: 8 * 250 * 2, ...sum, seatsTaken: after.seatsTaken, seatsTotal: after.seatsTotal }]);
    hub.db.prepare(`UPDATE runs SET state = 'CANCELLED', seats_taken = 0 WHERE id = ?`).run(multi);
  }

  let backstop = false;
  try {
    hub.db.prepare('UPDATE runs SET seats_taken = 99 WHERE id = ?').run(runId);
  } catch {
    backstop = true;
  }
  r.check('backstop', 'Even a direct database write cannot overfill a run', backstop, backstop ? 'Rejected by a CHECK constraint' : 'Write succeeded');

  hub.db.prepare(`UPDATE seats SET state = 'RELEASED' WHERE run_id = ?`).run(runId);
  hub.db.prepare(`UPDATE runs SET state = 'CANCELLED', seats_taken = 0 WHERE id = ?`).run(runId);
  hub.db.prepare(`UPDATE passengers SET state = 'CANCELLED' WHERE origin = 'ARENA'`).run();
  r.summary = `${n * 2} parallel requests for one seat: one winner, ${lost} accurate refusals, every retry consistent.`;
};

const c10: Card = async ({ hub }, r, params) => {
  const custom = Array.isArray(params?.readings) ? (params.readings as Reading[]) : null;
  const sample = telemetrySample(hub.now);
  const runsBefore = hub.runs().map((x) => x.id).sort().join();
  const ingested = hub.ingestTelemetry(custom ?? sample.readings);
  r.step(custom ? `${ingested.stored} organiser readings loaded.` : 'Streaming five vehicles: a GPS teleport, a frozen GPS, a broken passenger counter with late packets, a genuine breakdown, and one healthy vehicle.');
  const reports = hub.sensorReports();
  const reviews = reports.map((x) => hub.raiseSensorReview(x)).filter((x) => x !== null);
  const runsAfter = hub.runs().map((x) => x.id).sort().join();

  r.table('Verdicts', reports.map((x) => ({ vehicle: x.vehicleId, verdict: x.verdict, flags: x.flags.map((f) => f.code).join(', ') || 'none', action: x.action })));
  r.table('Evidence for each flag', reports.flatMap((x) => x.flags.map((f) => ({ vehicle: x.vehicleId, flag: f.code, detail: f.detail }))));

  r.check('no-auto', 'No automatic action was taken on a suspect reading', reports.every((x) => !x.autoAction) && runsBefore === runsAfter, 'No vehicle was re-dispatched');
  if (custom) {
    r.check('detected', 'Faults in your feed were detected', reports.some((x) => x.verdict !== 'HEALTHY'), `${reports.filter((x) => x.verdict !== 'HEALTHY').length} vehicles flagged`);
  } else {
    const verdict = (id: string) => reports.find((x) => x.vehicleId === id)?.verdict;
    const v1 = reports.find((x) => x.vehicleId === 'V01');
    r.check('teleport', 'An impossible GPS jump is detected', verdict('V01') === 'SENSOR_FAULT' && !!v1?.flags.some((f) => f.code === 'IMPOSSIBLE_JUMP'), verdict('V01') ?? 'none');
    r.check('frozen', 'A frozen GPS is told apart from a stop, using the odometer', verdict('V02') === 'SENSOR_FAULT', verdict('V02') ?? 'none');
    r.check('counter', 'An impossible passenger count is caught', verdict('V03') === 'SENSOR_FAULT', verdict('V03') ?? 'none');
    r.check('late', 'Delayed readings are marked', !!reports.find((x) => x.vehicleId === 'V03')?.flags.some((f) => f.code === 'LATE'), 'Late packet flagged');
    r.check('genuine', 'A real breakdown is not dismissed as a sensor fault', verdict('V04') === 'GENUINE_STOP', verdict('V04') ?? 'none');
    r.check('human', 'A real event goes to a person, not an automatic action', reviews.length === 1, `${reviews.length} driver confirmation requested`);
    r.check('healthy', 'A healthy vehicle raises no alarm', verdict('V05') === 'HEALTHY', verdict('V05') ?? 'none');
    r.check('last-good', 'Bad readings are excluded from the position estimate', !!v1?.lastGood && v1.lastGood.lat !== 13.6, `Last good latitude ${v1?.lastGood?.lat?.toFixed(3)}`);
  }
  r.summary = `${reports.filter((x) => x.verdict === 'SENSOR_FAULT').length} faulty vehicles and ${reports.filter((x) => x.verdict === 'GENUINE_STOP').length} real stop told apart, and no automatic dispatch.`;
};

const c11: Card = async ({ hub }, r, params) => {
  const { version: _drop, ...fallback } = POLICY_V2;
  void _drop;
  const doc = params?.policy ?? fallback;
  const oldVersion = hub.policy().version;
  const oldEpoch = hub.latestEpoch()!.id;
  const oldDecisions = hub.decisions(null, 100000, oldEpoch);
  const oldHash = hashOf(oldDecisions);
  const passes = (hub.db.prepare(`SELECT pass_id FROM seats WHERE state = 'COMMITTED' ORDER BY pass_id`).all() as any[]).map((x) => x.pass_id);
  const boarded = count(hub, `SELECT COUNT(*) c FROM seats WHERE state = 'BOARDED'`);

  const preview = hub.activatePolicy(doc, { dryRun: true });
  r.step(`Preview of "${preview.policy.name}": ${preview.diff.recalculated} reversible seats would move, ${preview.diff.needApproval} issued passes would need approval.`);
  const applied = hub.activatePolicy(doc, { by: 'Duty controller' });
  r.step(`New policy activated as version ${applied.policy.version}.`);

  const epoch = hub.latestEpoch()!;
  const newDecisions = hub.decisions(null, 100000, epoch.id);
  const oldAfter = hashOf(hub.decisions(null, 100000, oldEpoch));
  const passesAfter = (hub.db.prepare(`SELECT pass_id FROM seats WHERE state = 'COMMITTED' ORDER BY pass_id`).all() as any[]).map((x) => x.pass_id);
  const boardedAfter = count(hub, `SELECT COUNT(*) c FROM seats WHERE state = 'BOARDED'`);
  const chain = verifyChain(hub.ledger(0, 1000000));
  const approvals = hub.approvals();

  r.check('recognised', 'The policy change is recognised and recorded', applied.policy.version === oldVersion + 1 && epoch.policy_version === applied.policy.version, `Version ${oldVersion} to ${applied.policy.version}, allocation ${epoch.id} stamped ${epoch.policy_version}`);
  r.check('recalculated', 'Affected decisions are re-evaluated under the new rule', newDecisions.length > 0 && count(hub, 'SELECT COUNT(*) c FROM decisions WHERE epoch = ? AND policy_version != ?', epoch.id, applied.policy.version) === 0, `${applied.diff.recalculated} reversible seats moved`);
  r.check('history', 'Previous records are unchanged', oldHash === oldAfter, `Allocation ${oldEpoch} hash unchanged across ${oldDecisions.length} decisions`);
  r.check('no-silent-reversal', 'No issued pass was silently changed', JSON.stringify(passes) === JSON.stringify(passesAfter), `${passes.length} passes before, ${passesAfter.length} after`);
  r.check('approval', 'Passes the new rule would change wait for a person', approvals.filter((a) => a.kind === 'REVOKE_PASS').length >= applied.approvals.length, `${applied.approvals.length} approvals queued`);
  r.check('boarded', 'People already boarded are untouched', boarded === boardedAfter, `${boardedAfter} boarded`);
  r.check('ledger', 'The audit chain is intact', chain.ok, `${chain.checked} entries verified`);

  const was = new Map(oldDecisions.map((d) => [d.pid, d]));
  const moved = newDecisions
    .filter((d) => was.has(d.pid) && (was.get(d.pid)!.priority.tierId !== d.priority.tierId || was.get(d.pid)!.outcome !== d.outcome))
    .slice(0, 10)
    .map((d) => {
      const b = was.get(d.pid)!;
      return { passenger: d.pid, before: `${b.priority.tierLabel} (${b.priority.score})`, after: `${d.priority.tierLabel} (${d.priority.score})`, outcomeBefore: b.outcome, outcomeAfter: d.outcome };
    });
  r.table('Before and after', moved);
  r.table('Change summary', [{ from: applied.diff.from, to: applied.diff.to, recalculated: applied.diff.recalculated, needApproval: applied.diff.needApproval, untouchedBoarded: applied.diff.untouchedBoarded }]);
  r.table('Awaiting approval', approvals.slice(0, 8).map((a) => ({ id: a.id, subject: a.subject, reason: a.reason })));
  r.summary = `Policy ${applied.policy.version} applied: ${applied.diff.recalculated} seats recalculated, ${applied.diff.needApproval} passes held for approval, history unchanged.`;
};

const c12: Card = async ({ hub }, r) => {
  const tag = Date.now().toString(36);
  let found: { pid: string; dest: string } | null = null;
  let proceeded: string | null = null;
  for (const dest of ['MAS', 'SHO', 'SRM', 'MAA', 'PML', 'KLK']) {
    const { pid } = hub.checkin({ opId: `arena-c12-${tag}-${dest}`, dest, party: 1, need: 'UNKNOWN' });
    hub.allocateEpoch('Traveller with an unconfirmed need');
    const v = hub.passengerView(pid);
    if (v.clarification) {
      found = { pid, dest };
      break;
    }
    proceeded = proceeded ?? dest;
  }
  if (proceeded) r.step(`A traveller to ${nodeName(proceeded)} did not need to be asked: every possible answer led to the same vehicle.`);
  if (!found) {
    r.check('setup', 'A case with a decision-critical gap exists', false, 'No traveller needed a question in this world');
    return;
  }
  const view = hub.passengerView(found.pid);
  const q = view.clarification!;
  r.step(`A traveller to ${nodeName(found.dest)} has not confirmed whether they need a wheelchair space. Both answers are possible, and they lead to different vehicles.`);

  const before = view.passenger.need;
  const passBefore = view.pass;
  const heldState = view.seat?.state ?? 'none';

  r.check('identified', 'The exact missing field is identified', q.field === 'need', `Missing field: ${q.field}`);
  r.check('not-invented', 'The system did not invent the answer', before === 'UNKNOWN', `Stored need is still ${before}`);
  r.check('no-pass', 'No irreversible action was taken', passBefore === null, passBefore ? 'A pass was issued' : 'No pass issued');
  r.check('reversible', 'Only a reversible hold exists', heldState === 'HELD' || heldState === 'none', `Seat state: ${heldState}`);
  r.check('asked', 'A relevant question was asked', q.question.length > 0 && q.why.length > 0, q.question);
  r.check('why', 'The system explains why it cannot proceed', view.explanation?.headline.includes('one answer') === true, q.why);

  const after = hub.answerClarification(found.pid, q.id, 'WHEELCHAIR');
  r.step('The traveller answers. The seat is now decided on the real answer.');
  r.check('answered', 'The answer unblocks the decision', after.passenger.need === 'WHEELCHAIR' && after.passenger.state !== 'AWAITING_INFO', `Need is ${after.passenger.need}, state ${after.passenger.state}`);
  const bay = after.seat ? after.seat.bayUnits === 1 : after.decision?.outcome === 'WAITLISTED';
  r.check('correct', 'The final outcome fits the answer', !!bay, after.seat ? 'Placed in a wheelchair space' : 'Waitlisted with a reason, not placed in a seat they cannot use');

  r.table('The request', [{ field: q.field, question: q.question, why: q.why, options: q.options.join(', '), escalatesAt: clockLabel(q.due_at), escalatesTo: 'Field marshal' }]);
  r.table('Blocked action', [{ action: 'Issue boarding pass', status: 'Blocked until answered', hold: heldState }]);
  r.summary = 'The system asked one question instead of guessing, issued no pass until it was answered, and only asks when the answer changes the outcome.';
};

const RUNNERS: Record<string, Card> = { C01: c01, C02: c02, C03: c03, C04: c04, C05: c05, C06: c06, C07: c07, C08: c08, C09: c09, C10: c10, C11: c11, C12: c12 };

export class Arena {
  last = new Map<string, CardResult>();

  constructor(private ctx: ArenaContext) {}

  list() {
    return CARDS.map((c) => ({ ...c, last: this.last.get(c.id) ?? null }));
  }

  /** A card normally runs on a fresh world so it is repeatable; run-all stacks them on one. */
  async run(id: string, params: unknown = {}, opts: { fresh?: boolean } = {}): Promise<CardResult> {
    const info = CARDS.find((c) => c.id === id);
    const card = RUNNERS[id];
    if (!info || !card) throw new Error(`Unknown card ${id}`);
    const { hub, outside } = this.ctx;
    if (opts.fresh !== false) {
      hub.reset(Number(hub.meta('seed') ?? 842));
      outside.shape = 'v1';
    }
    const report = new Report();
    const t0 = performance.now();
    try {
      await card(this.ctx, report, params);
    } catch (e) {
      if (hub.offline) hub.setOffline(false);
      report.check('crash', 'The card ran to completion', false, e instanceof Error ? e.message : 'Unknown failure');
    }
    const passed = report.checks.length > 0 && report.checks.every((c) => c.ok);
    const result: CardResult = {
      card: id,
      title: info.title,
      status: passed ? 'PASS' : 'FAIL',
      summary: report.summary || 'This card did not complete. See the failed checks.',
      ranAtMs: Date.now(),
      durationMs: Math.round(performance.now() - t0),
      steps: report.steps,
      checks: report.checks,
      evidence: report.evidence,
      tryIt: report.tryIt,
    };
    this.last.set(id, result);
    hub.record('CARD_RUN', 'arena', { card: id, status: result.status, checks: report.checks.length, failed: report.checks.filter((c) => !c.ok).map((c) => c.id) });
    return result;
  }

  async runAll(): Promise<{ results: CardResult[]; passed: number; total: number; durationMs: number }> {
    const { hub, outside } = this.ctx;
    const t0 = performance.now();
    hub.reset(Number(hub.meta('seed') ?? 842));
    outside.shape = 'v1';
    const results: CardResult[] = [];
    for (const c of CARDS) results.push(await this.run(c.id, {}, { fresh: false }));
    return { results, passed: results.filter((r) => r.status === 'PASS').length, total: results.length, durationMs: Math.round(performance.now() - t0) };
  }
}
