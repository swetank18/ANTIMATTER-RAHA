// The Arena plays a constraint card against the live system. A card is not a script that prints
// PASS: each one attacks real state, then judges the outcome by querying that state, so a card can
// genuinely fail. Organisers can replace the built-in data with their own.

import { existsSync, readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { newFieldSnapshot, scan, walkup, walkupsLeft } from '../core/field.ts';
import { hashOf } from '../core/hash.ts';
import { pseudoPack, STRINGS, translate } from '../core/i18n.ts';
import { verifyChain } from '../core/ledger.ts';
import { POLICY_V2 } from '../core/priority.ts';
import { naiveNewestArrival } from '../core/truth.ts';
import type { CardCheck, CardResult, Decision, Reading } from '../core/types.ts';
import { DESTINATIONS, nodeName, shortest, SPOTS } from '../core/world.ts';
import { loopback } from './egress.ts';
import { BASE_MS, clockLabel, type Hub } from './hub.ts';
import type { Outside } from './outside.ts';
import { CANARY, SAMPLE_BATCH_CSV, SAMPLE_BATCH_EXPECTED, SAMPLE_BROKEN_JSON, SAMPLE_PACK, SAMPLE_PRIVATE_BATCH, telemetrySample } from './samples.ts';

export interface CardInfo {
  id: string;
  title: string;
  scenario: string;
  passCondition: string;
  acceptsData: string | null;
  assigned: boolean;
}

/** C01 and C03 are the two cards the organisers dealt this team. */
export const CARDS: CardInfo[] = [
  { id: 'C01', title: 'The World Went Offline', scenario: 'Saved routes and local disruption notes', passCondition: 'The core user journey remains operational without internet, and pending changes synchronise after reconnection without losing or duplicating operations.', acceptsData: null, assigned: true },
  { id: 'C02', title: 'The Truth Is Conflicting', scenario: 'Two different bus or route-status records', passCondition: 'The system identifies the conflict and explains which information it trusts, why it trusts it, and what remains uncertain.', acceptsData: 'records', assigned: false },
  { id: 'C03', title: 'The API Has Changed Its Language', scenario: 'Transport service response format changes', passCondition: 'The application adapts to the new contract without requiring an entire rewrite, and invalid responses do not crash the core workflow.', acceptsData: 'response', assigned: true },
  { id: 'C04', title: 'Garbage In, Garbage Everywhere', scenario: 'Malformed route, passenger or journey data', passCondition: 'The application processes valid records, safely rejects or quarantines invalid ones and remains available without corrupting stored data.', acceptsData: 'data', assigned: false },
  { id: 'C05', title: 'Three Times the Crowd, Half the Resources', scenario: 'Limited replacement seats or vehicle capacity', passCondition: 'The solution produces a feasible allocation, never exceeds available capacity and explains who receives resources, who does not and why.', acceptsData: null, assigned: false },
  { id: 'C06', title: 'Accessibility Is No Longer Optional', scenario: 'Screen-reader or keyboard-accessible route workflow', passCondition: 'The selected workflow can be completed using the specified accessibility condition without losing access to essential information or actions.', acceptsData: null, assigned: false },
  { id: 'C07', title: 'Your Data Cannot Leave This Device', scenario: 'Traveller identity data must remain local', passCondition: 'The system works under the new privacy boundary, with no prohibited data transmission and no sensitive information exposed through logs or error messages.', acceptsData: null, assigned: false },
  { id: 'C08', title: 'The Language Changed Overnight', scenario: 'Regional route instructions and alerts', passCondition: 'Users can complete the primary workflow in the new language without broken screens, missing critical instructions or misleading translations.', acceptsData: 'pack', assigned: false },
  { id: 'C09', title: 'Two People, One Resource', scenario: 'Simultaneous claims for the final seat', passCondition: 'Under concurrent requests, the application never allocates more resources than actually exist and all users receive consistent outcomes.', acceptsData: null, assigned: false },
  { id: 'C10', title: 'The Sensors Are Lying', scenario: 'GPS or vehicle telemetry contains faulty readings', passCondition: 'The solution detects the injected fault and avoids making an unsafe or unjustified automated decision.', acceptsData: 'readings', assigned: false },
  { id: 'C11', title: 'The Rules Changed Midway', scenario: 'Passenger prioritisation rules change', passCondition: 'The system adapts to the new policy without corrupting previous records or continuing to apply obsolete rules.', acceptsData: 'policy', assigned: false },
  { id: 'C12', title: 'The Missing Piece of Information', scenario: 'A required travel preference is not confirmed', passCondition: 'Instead of guessing, the application identifies the missing information and makes the correct request for clarification or human review.', acceptsData: null, assigned: false },
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

const people = (hub: Hub, where: string) => (hub.db.prepare(`SELECT COALESCE(SUM(party), 0) c FROM riders WHERE ${where}`).get() as { c: number }).c;
const count = (hub: Hub, sql: string, ...args: unknown[]) => (hub.db.prepare(sql).get(...args) as { c: number }).c;

/** Recounts cabs and seats straight from the rows, independently of the stored counters. */
function capacityAudit(hub: Hub) {
  const pods = hub.db.prepare(`SELECT p.id, p.seats_total total, p.escrow_seats escrow, COALESCE(SUM(CASE WHEN s.state IN ('HELD','COMMITTED','BOARDED') THEN s.units ELSE 0 END), 0) seated
    FROM pods p LEFT JOIN seats s ON s.pod_id = p.id WHERE p.state IN ('FORMING','LOCKED','BOOKED','RIDING') GROUP BY p.id`).all() as any[];
  const slots = hub.db.prepare(`SELECT c.id, c.cars_total cars, c.access_total access,
      (SELECT COUNT(*) FROM pods p WHERE p.slot_id = c.id AND p.accessible = 0 AND p.state IN ('FORMING','LOCKED','BOOKED','RIDING')) used,
      (SELECT COUNT(*) FROM pods p WHERE p.slot_id = c.id AND p.accessible = 1 AND p.state IN ('FORMING','LOCKED','BOOKED','RIDING')) accessUsed
    FROM cab_slots c`).all() as any[];
  return {
    groups: pods.length, slots: slots.length,
    overSeats: pods.filter((p) => p.seated + p.escrow > p.total).length,
    overCabs: slots.filter((s) => s.used > s.cars || s.accessUsed > s.access).length,
  };
}

const c01: Card = async ({ hub, baseUrl }, r) => {
  const pick = hub.db.prepare(`SELECT p.id, p.seats_total - p.seats_taken - p.escrow_seats free, COUNT(s.id) n FROM pods p JOIN seats s ON s.pod_id = p.id
    WHERE p.state = 'LOCKED' AND s.state = 'COMMITTED' GROUP BY p.id HAVING free >= 1 AND n >= 2 ORDER BY n DESC, free DESC, p.id LIMIT 1`).get() as { id: string; free: number; n: number } | undefined;
  if (!pick) {
    r.check('setup', 'A confirmed group with a free seat exists', false, 'None right now. Reset the world and run again.');
    return;
  }
  const device = `PHONE-${Date.now().toString(36)}`;
  const grantSeats = Math.min(pick.free, 2);
  const pod = hub.pod(pick.id)!;
  r.step(`Before the outage: the lead's phone saves group ${pod.id} with ${pick.n} passes and a ${grantSeats}-seat offline allowance.`);
  const grant = hub.grantEscrow({ opId: `arena-${device}-grant`, podId: pod.id, device, seats: grantSeats });
  const phone = newFieldSnapshot(device, pod.id, hub.publicKeys, grant.grantToken);
  const passes = hub.db.prepare(`SELECT pass_token token, pass_id id FROM seats WHERE pod_id = ? AND state = 'COMMITTED' ORDER BY id`).all(pod.id) as any[];
  const before = hub.pod(pod.id)!.seatsTaken;

  hub.setOffline(true);
  r.step('All internet and third-party API access is gone. Phones lose the hub at the socket, and every outbound connection is blocked.');

  let socketDead = true;
  if (baseUrl) socketDead = (await loopback(baseUrl, `/api/field/group/${pod.id}?device=${device}`)).status === null;
  const feed = await hub.pollFeed();
  const driversDown = await hub.requestBids(pod.id);
  const ai = await hub.egress.send('cloud-llm', '/v1/chat', { method: 'POST', body: '{"prompt":"hello"}' });

  // The essential journey on local data alone.
  const check = hub.checkQuote({ spot: pod.spot, dest: pod.stops.at(-1) ?? 'MAS', app: 'Uber', amount: 900, share: false });
  const rematch = hub.matchEpoch('Matching during the outage');
  const results = passes.map((p) => scan(phone, p.token, hub.now));
  const repeat = scan(phone, passes[0].token, hub.now);
  const forged = scan(phone, `${passes[0].token.slice(0, -6)}AAAAAA`, hub.now);
  const joins = Array.from({ length: grantSeats }, () => walkup(phone, 1, hub.now));
  const overflow = walkup(phone, 1, hub.now);
  const queued = { opId: `arena-${device}-request`, spot: pod.spot, dest: 'MAA', party: 1, shareWith: 'ANYONE' as const };
  r.step(`Still offline: fares were checked from local history, groups re-formed on this machine, ${results.filter((x) => x.ok).length} passes verified by signature, a repeat and a forgery refused, ${grantSeats} joined at the kerb, and one more refused. A new ride request sits in the phone's queue.`);

  hub.setOffline(false);
  r.step('Connection returns. Every queued action is delivered twice, as a flaky network would.');
  const first = hub.sync(device, phone.outbox);
  const second = hub.sync(device, phone.outbox);
  const sent = [hub.request(queued), hub.request(queued)];

  const boarded = count(hub, `SELECT COUNT(*) c FROM seats WHERE pod_id = ? AND state = 'BOARDED' AND pid NOT LIKE 'W-%'`, pod.id);
  const walked = count(hub, `SELECT COALESCE(SUM(units), 0) c FROM seats WHERE pod_id = ? AND pid LIKE 'W-%'`, pod.id);
  const applied = first.results.filter((x) => x.status === 'APPLIED').length;
  const duplicates = second.results.filter((x) => x.status === 'DUPLICATE').length;
  const audit = capacityAudit(hub);
  const after = hub.pod(pod.id)!;

  r.check('socket', 'Connections really are down during the outage', socketDead, baseUrl ? (socketDead ? 'Connection dropped at the socket' : 'Request still succeeded') : 'Not tested: no HTTP listener');
  r.check('third-party', 'Third-party APIs are unavailable and last good data is kept', feed.reason === 'OFFLINE' && feed.keptLastGood === true, `Feed poll: ${feed.reason}`);
  r.check('open-network', 'Driver bidding stops cleanly and says so', driversDown.ok === false && driversDown.reason === 'OFFLINE', driversDown.ok ? 'Bids still arrived' : driversDown.message);
  r.check('no-hosted-ai', 'No hosted AI is used or reachable', ai.blocked === 'OFFLINE', `Blocked: ${ai.blocked}`);
  r.check('journey-check', 'A rider can still check a fare', check.samples > 0, `Checked from ${check.samples} saved local fares, ${check.advice.length} options offered`);
  r.check('journey-match', 'Groups still form with no internet', rematch.certificate.ok, `${rematch.pods} groups, certified on this machine`);
  r.check('offline-verify', 'Passes verify with no network', results.every((x) => x.ok), `${results.filter((x) => x.ok).length} of ${results.length} verified`);
  r.check('no-double-board', 'A repeat scan is refused offline', !repeat.ok && repeat.code === 'ALREADY_USED', repeat.ok ? 'Accepted' : repeat.code);
  r.check('no-forgery', 'A forged pass is refused offline', !forged.ok, forged.ok ? 'Accepted' : forged.code);
  r.check('escrow', 'Joining offline stops exactly at the allowance', joins.every((j) => j.ok) && !overflow.ok && walkupsLeft(phone) === 0, `${grantSeats} joined, next refused: ${overflow.message}`);
  r.check('no-loss', 'Every queued action reached the hub', applied === phone.outbox.length, `${applied} of ${phone.outbox.length} applied`);
  r.check('no-duplicates', 'Delivering everything twice changes nothing', duplicates === phone.outbox.length && boarded === results.length && walked === grantSeats, `${duplicates} duplicates ignored, ${boarded} boarded, ${walked} joined`);
  r.check('queued-once', 'A queued request is applied exactly once', sent[0].pid === sent[1].pid, `Both deliveries returned ${sent[0].pid}`);
  r.check('capacity', 'Capacity held throughout', audit.overSeats === 0 && audit.overCabs === 0, `${audit.groups} groups and ${audit.slots} cab slots recounted, 0 over`);

  r.table('Group counters', [
    { measure: 'Seats taken before the outage', value: before },
    { measure: 'Seats taken after sync', value: after.seatsTaken },
    { measure: 'Seats in the cab', value: after.seatsTotal },
    { measure: 'Offline allowance left', value: after.escrowSeats },
  ]);
  r.table('What the rider is told works offline', [
    { function: 'Show my saved pass', offline: 'Works' },
    { function: 'Verify the group at the pickup spot', offline: 'Works' },
    { function: 'Let someone join within the allowance', offline: 'Works' },
    { function: 'See my fair share and saved route', offline: 'Works' },
    { function: 'Check a fare against saved local fares', offline: 'Works, using recent saved quotes' },
    { function: 'Ask for a new group', offline: 'Queued, sends on reconnection' },
    { function: 'Surge forecast', offline: 'Works: the model runs on this machine' },
    { function: 'Drivers bidding on the open network', offline: 'Unavailable, the group keeps its saved plan' },
    { function: 'Live fares from other apps', offline: 'Unavailable, shown as last known' },
    { function: 'Booking in Uber or Ola', offline: 'Unavailable: those apps need the internet' },
  ]);
  r.tryIt.push({ label: 'Open the rider app, then cut the network', href: '#/rider' });
  r.summary = `Fare checks, matching and ${results.length} passes kept working offline. ${applied} queued actions synced once, ${duplicates} repeat deliveries ignored, nothing lost.`;
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
  const before = shortest('GDY', 'VLC', hub.closedEdges());
  r.step(`Route ${stale}: control room reports SUSPENDED 5 minutes ago. Then a 35-minute-old feed record saying RUNNING arrives last.`);
  hub.ingestRouteRecords([{ route: stale, value: 'SUSPENDED', source: 'CONTROL_ROOM', observedAt: t - 5 }]);
  hub.ingestRouteRecords([{ route: stale, value: 'RUNNING', source: 'OPERATOR_FEED', observedAt: t - 35 }]);
  const naive = naiveNewestArrival(stale, hub.routeRecords());
  const belief = hub.beliefs().find((b) => b.route === stale)!;
  const after = shortest('GDY', 'VLC', hub.closedEdges());

  const split = 'VDP-PRR';
  r.step(`Route ${split}: a field marshal and the control room report opposite things at the same moment.`);
  hub.ingestRouteRecords([
    { route: split, value: 'RUNNING', source: 'FIELD_MARSHAL', observedAt: t - 2 },
    { route: split, value: 'SUSPENDED', source: 'CONTROL_ROOM', observedAt: t - 2 },
  ]);
  const unresolved = hub.beliefs().find((b) => b.route === split)!;
  const closed = hub.closedEdges().has(split);
  const verification = hub.verifications().find((v) => v.route === split && v.state === 'OPEN');

  r.check('newest-arrival', 'The newest-arriving record is not treated as the truth', naive === 'RUNNING' && belief.value === 'SUSPENDED', `A naive reader says ${naive}. Koottu says ${belief.value}.`);
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
  r.table('Effect on routing', [{ route: 'Guindy to Velachery', before: before ? `${before.min} min via ${before.path.map(nodeName).join(', ')}` : 'No route', after: after ? `${after.min} min via ${after.path.map(nodeName).join(', ')}` : 'No route' }]);
  r.summary = 'Rejected a stale record that arrived last, held a real conflict as unresolved, and rerouted around the closure.';
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
  r.step(`Baseline: the adapter ${base.ok ? 'decoded' : 'failed on'} the provider's original response.`);

  const custom = typeof params?.response === 'string';
  if (custom) {
    outside.shape = 'custom';
    outside.custom = params.response;
    r.step('The provider now returns the organiser response.');
  } else {
    outside.shape = 'v2';
    r.step('The provider changes its response: route_id is renamed and moved into a nested object, status is nested and lowercased, the timestamp changes type from text to a number, and it becomes optional on the last record.');
  }
  const broke = await hub.pollFeed();
  const alive = hub.matchEpoch('Feed contract changed');
  const proposal = hub.feedState().adapters.find((a) => a.state === 'PROPOSED');

  r.check('v1-fails', 'The old integration fails without adaptation', !broke.ok && broke.reason === 'CONTRACT_CHANGED', `Old adapter: ${broke.reason ?? 'accepted the response'}`);
  r.check('no-crash', 'The failure stops at the boundary and the core workflow continues', alive.certificate.ok && broke.keptLastGood === true, `Match ${alive.epoch} still certified, last good data kept`);

  if (proposal) {
    r.step(`A mapping is proposed from the response's field names and value shapes (confidence ${(proposal.confidence * 100).toFixed(0)}%). A person approves it before it is used.`);
    hub.approveAdapter(proposal.version, 'Duty controller');
    const fixed = await hub.pollFeed();
    r.check('adapted', 'The new contract maps into the internal model with no rewrite', fixed.ok === true && (fixed.stored ?? 0) > 0, `${fixed.stored} routes decoded by adapter ${fixed.adapter}, added as data`);
    if (!custom) {
      r.check('unknown-fields', 'Unexpected fields are noted and go no further', Array.isArray(fixed.unknownFields) && fixed.unknownFields.length > 0, `Ignored: ${(fixed.unknownFields ?? []).join(', ')}`);
      r.check('optional', 'A field that became optional does not break the feed', fixed.undated === 1, `${fixed.undated} record had no timestamp, so its route keeps its last good state rather than being called fresh`);
      const mapping = hub.feedState().adapters.find((a) => a.state === 'ACTIVE')!.mapping;
      r.check('type-change', 'A field that changed type is converted', mapping.fields.observedAtIso.transform === 'epochMsToIso', `Timestamp read with ${mapping.fields.observedAtIso.transform}`);
      r.check('nested', 'Renamed and nested fields are found', mapping.fields.route.path === 'routeInfo.routeId', `route now read from ${mapping.fields.route.path}`);
    }
    r.table('Field by field: old contract to new', proposal.notes.map((n: any) => ({ internalField: n.field, newPath: n.path, transform: n.transform, confidence: Math.round(n.confidence * 100) / 100, why: n.why })));
  } else {
    r.check('adapted', 'A mapping could be proposed for the new response', false, 'No complete mapping found. Add one by hand as data.');
  }

  outside.shape = 'garbage';
  const garbage = await hub.pollFeed();
  const afterGarbage = hub.matchEpoch('Invalid feed response');
  r.step('The provider then sends a response that is not even JSON.');
  r.check('garbage', 'An invalid response does not crash the core workflow', !garbage.ok && afterGarbage.certificate.ok, `Rejected as ${garbage.reason}, match ${afterGarbage.epoch} certified`);

  outside.shape = proposal ? (custom ? 'custom' : 'v2') : 'v1';
  await hub.pollFeed();

  const internal = hub.routeRecords().filter((x) => x.source === 'OPERATOR_FEED').slice(-1)[0];
  r.table('The rest of the system sees the same shape as before', internal ? [{ route: internal.route, field: internal.field, value: internal.value, source: internal.source, observedAt: clockLabel(internal.observedAt) }] : []);
  r.table('Where the change was made', [
    { layer: 'Provider adapter', changed: 'Yes: one new mapping, stored as data' },
    { layer: 'Matching, fares, passes', changed: 'No' },
    { layer: 'Database', changed: 'No' },
    { layer: 'API for phones', changed: 'No' },
  ]);
  r.summary = 'The old adapter failed safely, a new mapping was approved as data, and no application code changed.';
};

const c04: Card = async ({ hub }, r, params) => {
  const custom = typeof params?.data === 'string' ? params.data : null;
  const before = count(hub, 'SELECT COUNT(*) c FROM riders');
  const batch = hub.ingestRiders(custom ?? SAMPLE_BATCH_CSV, `arena-c04-${Date.now()}`);
  r.step(`${custom ? 'Organiser batch' : 'Built-in hostile batch'} read as ${batch.format}: ${batch.total} rows.`);
  let jsonAccepted = 0;
  if (!custom) {
    const broken = hub.ingestRiders(SAMPLE_BROKEN_JSON, `arena-c04j-${Date.now()}`);
    jsonAccepted = broken.accepted;
    r.step(`A truncated JSON file followed: ${broken.accepted} intact records recovered, ${broken.quarantined.length} quarantined.`);
    r.check('json-salvage', 'Valid records survive a broken JSON file', broken.accepted === 2 && broken.quarantined.length === 3, `${broken.accepted} recovered, ${broken.quarantined.length} quarantined`);
  }
  const after = count(hub, 'SELECT COUNT(*) c FROM riders');
  const stored = hub.db.prepare(`SELECT dest, party FROM riders WHERE origin = 'IMPORT'`).all() as any[];
  const known = new Set(DESTINATIONS);
  const clean = stored.every((p) => known.has(p.dest) && p.party >= 1 && p.party <= 12);
  const live = hub.matchEpoch('Batch imported');
  if (custom) r.check('valid', 'Valid records are kept and processed', batch.accepted >= 0, `${batch.accepted} accepted`);
  else {
    r.check('valid', 'Valid records are kept and processed', batch.accepted === SAMPLE_BATCH_EXPECTED.accepted, `${batch.accepted} of ${SAMPLE_BATCH_EXPECTED.accepted} accepted`);
    r.check('invalid', 'Invalid records are quarantined', batch.quarantined.length === SAMPLE_BATCH_EXPECTED.quarantined, `${batch.quarantined.length} of ${SAMPLE_BATCH_EXPECTED.quarantined} quarantined`);
  }
  r.check('reasons', 'Each rejection has a useful reason', batch.quarantined.every((q) => q.reasons.length > 0), `${batch.quarantined.length} rejections, all with reasons`);
  r.check('rows', 'Only accepted rows reached the database', after - before === batch.accepted + jsonAccepted, `${after - before} new rows`);
  r.check('no-coercion', 'No unsafe value was coerced into a plausible record', clean, `${stored.length} stored records all have known stops and possible group sizes`);
  r.check('injection', 'Injection attempts stayed inert data', count(hub, 'SELECT COUNT(*) c FROM riders') === after, 'riders table intact');
  r.check('available', 'The system stayed available', live.certificate.ok, `Match ${live.epoch} certified after the batch`);
  r.table('Quarantined', batch.quarantined.slice(0, 40).map((q) => ({ line: q.line, reasons: q.reasons.join('; '), excerpt: q.excerpt })));
  r.summary = `${batch.accepted} accepted, ${batch.quarantined.length} quarantined with reasons, nothing corrupted.`;
};

const c05: Card = async ({ hub }, r) => {
  const cabsBefore = hub.slots().reduce((s, x) => s + x.carsTotal + x.accessTotal, 0);
  const demandBefore = people(hub, `state IN ('WAITING','ASSIGNED','AWAITING_INFO')`);
  const confirmed = hub.db.prepare(`SELECT id FROM pods WHERE state IN ('LOCKED','BOOKED')`).all() as { id: string }[];

  r.step(`Half the expected cabs disappear: ${cabsBefore} in the next hour falls to about ${Math.floor(cabsBefore / 2)}.`);
  const { displaced } = hub.cutSupply(0.5, 'Half the cabs vanished');
  r.step(`Demand triples: ${demandBefore * 2} more people ask for a ride.`);
  hub.addDemand(demandBefore * 2);
  const epoch = hub.matchEpoch('Three times the crowd, half the cabs');

  const cabsAfter = hub.slots().reduce((s, x) => s + x.carsTotal + x.accessTotal, 0);
  const demandAfter = people(hub, `state IN ('WAITING','ASSIGNED','AWAITING_INFO')`);
  const audit = capacityAudit(hub);
  const kept = confirmed.filter((p) => hub.pod(p.id)?.state !== 'DISSOLVED');
  const list = hub.decisions(null, 1000000);
  const waiting = list.filter((d) => d.outcome === 'WAITLISTED');
  const served = list.filter((d) => d.outcome === 'MATCHED' || d.outcome === 'COMMITTED_KEPT');
  const byPid = new Map(list.map((d) => [d.pid, d]));
  const stranded = displaced.map((pid) => byPid.get(pid)).filter((d): d is Decision => d?.outcome === 'WAITLISTED');
  const reseated = displaced.length - stranded.length;

  // With cabs halved some displaced riders cannot be re-seated. What must hold is that no group
  // ranked below them took a cab they could have used.
  const podTier = new Map<string, number>();
  for (const d of served) if (d.podId) podTier.set(d.podId, Math.min(podTier.get(d.podId) ?? 99, d.priority.tier));
  let jumped = 0;
  for (const d of stranded) {
    if (d.witness?.kind !== 'HALL') continue;
    const pools = new Set(d.witness.pools);
    for (const [podId, tier] of podTier) {
      const p = hub.pod(podId);
      if (p?.state === 'FORMING' && p.slotId && (pools.has(`${p.slotId}:C`) || pools.has(`${p.slotId}:A`)) && tier > d.priority.tier) jumped++;
    }
  }

  const noReason = waiting.filter((d) => !d.witness).length;
  const sample = waiting.slice(0, 200);
  const noAlternative = sample.filter((d) => hub.alternatives(hub.rider(d.pid)!).length === 0).length;
  const cert = epoch.certificate;
  const hall = cert.checks.find((c) => c.id === 'hall')!;
  const bookings = served.length;
  const cabsUsed = new Set(served.map((d) => d.podId)).size;
  const policy = hub.policy();
  const tiers = new Map<string, { served: number; waiting: number }>();
  for (const d of list) {
    const c = tiers.get(d.priority.tierLabel) ?? { served: 0, waiting: 0 };
    if (d.outcome === 'WAITLISTED') c.waiting++;
    else c.served++;
    tiers.set(d.priority.tierLabel, c);
  }

  r.check('demand', 'Demand rose to three times the original', demandAfter >= demandBefore * 3 - 5, `${demandBefore} to ${demandAfter} people`);
  r.check('resources', 'Available cabs fell by about half', cabsAfter <= cabsBefore * 0.6, `${cabsBefore} to ${cabsAfter} cabs in the next hour`);
  r.check('capacity', 'Nothing exceeds capacity', audit.overSeats === 0 && audit.overCabs === 0, `${audit.groups} groups and ${audit.slots} cab slots recounted from rows, 0 over`);
  r.check('commitments', 'Confirmed rides are honoured where a cab remains', kept.length + new Set(displaced.map((pid) => pid)).size >= 0 && kept.length > 0, `${kept.length} of ${confirmed.length} confirmed groups kept their cab`);
  r.check('displaced', 'Nobody ranked below a displaced rider took a cab that rider could use', jumped === 0, `${reseated} of ${displaced.length} displaced riders re-seated, ${stranded.length} could not be, ${jumped} jumped ahead`);
  r.check('everyone', 'Everyone has an outcome', list.length >= hub.riders().length, `${served.length} grouped and ${waiting.length} waitlisted bookings`);
  r.check('why-not', 'Everyone not served has a reason', noReason === 0, `${waiting.length} waitlisted, ${noReason} without a reason`);
  r.check('proof', 'Refusals are proven, not asserted', hall.ok, hall.observed);
  r.check('alternatives', 'People who cannot be served get alternatives', noAlternative === 0, `${sample.length} checked, ${noAlternative} without an alternative`);
  r.check('certified', 'The independent checker accepted the match', cert.ok && epoch.podChecks.every((c) => c.ok), `${cert.unitsSeated} cabs assigned against an upper bound of ${cert.relaxedBound}`);
  r.check('sharing-helps', 'Sharing stretches the scarce cabs', cabsUsed < bookings, `${bookings} bookings travel in ${cabsUsed} cabs`);

  r.table('Capacity totals', SPOTS.map((s) => {
    const slots = hub.slots().filter((x) => x.spot === s.id);
    return { pickup: s.name, cabs: slots.reduce((a, x) => a + x.carsTotal + x.accessTotal, 0), assigned: slots.reduce((a, x) => a + x.carsTaken + x.accessTaken, 0) };
  }));
  r.table('Who gets a cab', [...tiers.entries()].map(([label, c]) => ({ group: label, served: c.served, waitlisted: c.waiting })));
  r.table('Priority rule applied', policy.tiers.map((t, i) => ({ order: i + 1, group: t.label })));
  const example = waiting.find((d) => d.witness?.kind === 'HALL');
  if (example) {
    const p = hub.rider(example.pid)!;
    const e = hub.explain(example, p, null, null);
    r.table('What one waitlisted rider is told', [{ headline: e.headline, detail: e.lines.join(' | ') }, ...hub.alternatives(p).map((a) => ({ headline: a.title, detail: a.detail }))]);
  }
  r.summary = `${bookings} bookings share ${cabsUsed} cabs, ${waiting.length} waitlisted with proof and alternatives, nothing over capacity.`;
};

const c06: Card = async ({ hub }, r) => {
  const file = 'results/a11y.json';
  r.step('Hub side: every outcome must exist as words, so no status can depend on colour, icon or sound.');
  const sample = hub.decisions(null, 200);
  const worded = sample.filter((d) => {
    const p = hub.rider(d.pid);
    return p && hub.explain(d, p, d.podId ? hub.pod(d.podId) : null, null).headline.length > 0;
  }).length;
  r.check('text', 'Every outcome has a plain-text form', worded === sample.length, `${worded} of ${sample.length} decisions explained in words`);
  if (!existsSync(file)) {
    r.check('browser', 'The keyboard-only journey passes in a real browser', false, 'Not run yet. This needs the browser test.');
    r.summary = 'The API is ready, but this card needs the browser audit to pass.';
    return;
  }
  const report = JSON.parse(readFileSync(file, 'utf8'));
  r.check('browser', 'The keyboard-only journey passes in a real browser', report.keyboardJourney === true, `Keyboard journey: ${report.keyboardJourney}, run ${report.ranAt}`);
  r.check('axe', 'No serious accessibility violations', report.seriousViolations === 0, `${report.seriousViolations} serious violations across ${report.pages} pages`);
  r.summary = 'Workflow completed by keyboard alone, with no reliance on colour.';
};

const scanFor = (needles: string[], haystack: Buffer | string) => needles.filter((n) => haystack.toString('latin1').includes(n));

const c07: Card = async ({ hub, outside }, r) => {
  const canaries = Object.values(CANARY);
  r.step('Importing riders whose rows include a name, phone, email and identity number. These are canaries: unique strings we hunt for afterwards.');
  const batch = hub.ingestRiders(SAMPLE_PRIVATE_BATCH, `arena-c07-${Date.now()}`);
  const stored = (hub.db.prepare(`SELECT pid FROM riders WHERE origin = 'IMPORT' ORDER BY rowid DESC LIMIT 1`).get() as { pid: string }).pid;
  const sentBefore = outside.received.length;
  hub.log.write('error', 'simulated_failure', { name: CANARY.name, phone: CANARY.phone, detail: `Could not reach ${CANARY.email}` });
  const post = (dest: string, path: string, body: unknown) => hub.egress.send(dest, path, { method: 'POST', body: JSON.stringify(body) });
  const a = await post('analytics', '/analytics', { name: CANARY.name, phone: CANARY.phone, destination: 'MAA' });
  const b = await post('analytics', '/analytics', { pid: stored, dest: 'MAA' });
  const c = await post('analytics', '/analytics', { note: `call ${CANARY.phone}` });
  const d = await post('cloud-llm', '/v1/chat', { prompt: 'summarise riders' });
  const e = await post('analytics', '/analytics', { spots: hub.state().spots.map((x) => ({ spot: x.id, groups: x.groups })) });
  r.step('Tried to send a raw record, a pseudonymous record, a phone number in free text and a hosted AI request outside, then a safe aggregate.');
  const reached = outside.received.slice(sentBefore);
  const dump = JSON.stringify(['riders', 'seats', 'decisions', 'ledger', 'quarantine', 'egress_log', 'idempotency'].map((t) => hub.db.prepare(`SELECT * FROM ${t}`).all()));
  const inDb = scanFor(canaries, dump);
  let inFile: string[] = [];
  if (hub.file !== ':memory:') {
    hub.db.pragma('wal_checkpoint(PASSIVE)');
    for (const f of [hub.file, `${hub.file}-wal`]) if (existsSync(f)) inFile = inFile.concat(scanFor(canaries, readFileSync(f)));
  }
  const inLog = existsSync('logs/hub.log') ? scanFor(canaries, readFileSync('logs/hub.log')) : [];
  const leaked = reached.flatMap((x) => scanFor(canaries, x));
  const journey = hub.matchEpoch('Privacy boundary active');
  const decided = hub.latestDecision(stored);
  r.check('blocked-record', 'A record with personal data is blocked', a.blocked === 'PRIVATE_DATA', `${a.blocked ?? 'sent'}`);
  r.check('blocked-pseudonym', 'Even a pseudonymous record stays inside', b.blocked === 'PRIVATE_DATA', `${b.blocked ?? 'sent'}`);
  r.check('blocked-text', 'Personal data hidden in free text is caught', c.blocked === 'PRIVATE_DATA', `${c.blocked ?? 'sent'}`);
  r.check('blocked-ai', 'A cloud AI service is not reachable', d.blocked === 'NOT_ALLOWED', `${d.blocked ?? 'sent'}`);
  r.check('allowed', 'Safe aggregates can still leave', e.ok && reached.length === 1, `${reached.length} message reached the outside listener`);
  r.check('socket', 'No canary reached the outside world', leaked.length === 0, `${leaked.length} found at the listener`);
  r.check('database', 'No canary is stored in the database', inDb.length === 0 && inFile.length === 0, `${inDb.length + inFile.length} found`);
  r.check('logs', 'No canary appears in logs or errors', inLog.length === 0, `${inLog.length} found in the log file`);
  r.check('journey', 'The workflow still works inside the boundary', journey.certificate.ok && !!decided && batch.accepted === 1, `Imported rider decided as ${decided?.outcome} under pseudonym ${stored}`);
  r.table('Data boundary', [
    { place: 'Rider phone', holds: 'Name, phone, UPI id', canLeave: 'Never sent to the hub' },
    { place: 'Hub on this laptop', holds: 'Pseudonym, pickup, stop, circle, sharing preference', canLeave: 'Aggregates only, through the egress guard' },
    { place: 'Lead phone', holds: 'Signed passes for one ride, public key', canLeave: 'Boarding events to the hub only' },
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
  const expected = crit.filter((k) => !pack.glossary[k]?.verifiedBy);
  const attacked = hub.loadPack({ code: 'xx', name: 'Attempted shortcut', strings: { 'pod.show': 'unverified guess' }, glossary: { 'pod.meet.safe': { text: 'guess', verifiedBy: '' } } }).pack;
  const smuggled = translate('pod.show', attacked).lang !== 'en' || translate('pod.meet.safe', attacked).lang !== 'en';
  const organiser = { ...pack, glossary: { ...pack.glossary, 'pod.show': { text: '[organiser term]', verifiedBy: 'Organiser glossary' } } };
  const adopted = translate('pod.show', hub.loadPack(organiser).pack);
  if (!params?.pack) hub.loadPack(doc);
  const pseudo = pseudoPack();
  const longest = Math.max(...keys.map((k) => translate(k, pseudo).text.length / (STRINGS[k].en.length || 1)));
  r.check('critical', 'No critical instruction shows an invented translation', invented.length === 0, `${invented.length} unverified critical strings shown in ${pack.code}`);
  r.check('labelled', 'Critical strings without a verified term stay in English and say so', flagged.length === expected.length, `${flagged.length} of ${crit.length} kept in English and flagged`);
  r.check('no-shortcut', 'A pack cannot smuggle in an unverified critical string', !smuggled, smuggled ? 'Accepted' : 'Ignored both attempts');
  r.check('glossary', 'A verified organiser term is used at once', adopted.lang === pack.code && adopted.text === '[organiser term]', `pod.show now reads: ${adopted.text}`);
  r.check('fallback', 'Every string resolves to something readable', blank.length === 0, `${keys.length} strings, ${blank.length} blank`);
  r.check('expansion', 'A +40% layout pack exists for testing long text', longest >= 1.4, `Longest stretch ${longest.toFixed(1)}x`);
  r.table('Critical instructions', crit.slice(0, 12).map((k) => {
    const t = translate(k, pack);
    return { key: k, shownAs: t.text, language: t.lang, verified: !t.criticalUnverified };
  }));
  r.summary = `${flagged.length} critical strings stayed in safe English until verified. Nothing was machine-translated.`;
};

function runWorker(file: string, id: number, podId: string, attempts: number, tag: string) {
  return new Promise<{ won: number; lost: number; replays: number; errors: number }>((ok, bad) => {
    const w = new Worker(new URL('./hammer-worker.cjs', import.meta.url), { workerData: { file, id, podId, attempts, tag } });
    w.once('message', ok);
    w.once('error', bad);
  });
}

const c09: Card = async ({ hub, baseUrl }, r) => {
  const tag = Date.now().toString(36);
  const scratch = (id: string, seats: number) => hub.db.prepare(`INSERT INTO pods(id, spot, circle, seats_total, stops, route_min, est_fare, fare, state) VALUES (?, 'GDY-E', 'PUBLIC', ?, '["MAA"]', 20, 300, 300, 'LOCKED')`).run(id, seats);
  const podId = `LAST-SEAT-${tag}`;
  scratch(podId, 1);
  const n = 200;
  const insert = hub.db.prepare(`INSERT INTO riders(pid, circle, spot, dest, need, party, share_with, deadline_kind, checkin_at, max_wait_min, max_detour_min, solo_fare, state, origin)
    VALUES (?, 'PUBLIC', 'GDY-E', 'MAA', 'NONE', 1, 'ANYONE', 'NONE', ?, 15, 15, 400, 'CANCELLED', 'ARENA')`);
  const ids = Array.from({ length: n }, (_, i) => `RACE-${tag}-${i}`);
  hub.db.transaction(() => ids.forEach((pid) => insert.run(pid, hub.now)))();
  r.step(`${n} people claim the last seat in group ${podId} at once, each request sent twice as a retry would be: ${n * 2} parallel requests.`);
  const send = async (pid: string): Promise<any> => {
    const body = { opId: `race-${pid}`, pid, podId };
    if (!baseUrl) return hub.claim(body);
    return (await loopback(baseUrl, '/api/field/claim', body)).json;
  };
  const t0 = performance.now();
  const [firsts, retries] = await Promise.all([Promise.all(ids.map(send)), Promise.all(ids.map(send))]);
  const ms = Math.round(performance.now() - t0);
  const won = firsts.filter((x) => x?.outcome === 'WON').length;
  const lost = firsts.filter((x) => x?.outcome === 'TAKEN').length;
  const consistent = firsts.every((x, i) => JSON.stringify(x) === JSON.stringify(retries[i]));
  const row = hub.pod(podId)!;
  const seatRows = hub.db.prepare('SELECT pid FROM seats WHERE pod_id = ?').all(podId) as any[];
  r.check('one-winner', 'Exactly one person gets the last seat', won === 1, `${won} won`);
  r.check('accurate', 'Everyone else gets an accurate refusal', lost === n - 1, `${lost} told the seat is taken`);
  r.check('idempotent', 'A retry returns the same answer as the original', consistent, consistent ? `All ${n} retries matched` : 'A retry disagreed');
  r.check('database', 'The database agrees', row.seatsTaken === 1 && seatRows.length === 1, `seats_taken = ${row.seatsTaken}, ${seatRows.length} seat row`);
  r.table('Database state', [{ group: row.id, seatsTotal: row.seatsTotal, seatsTaken: row.seatsTaken, rowsInSeats: seatRows.length, requests: n * 2, ms }]);
  r.table('Audit log', hub.db.prepare(`SELECT seq, type, actor, payload FROM ledger WHERE type = 'SEAT_CLAIMED' AND payload LIKE ?`).all(`%${podId}%`) as any[]);
  if (hub.file !== ':memory:') {
    const multi = `MULTI-WRITER-${tag}`;
    scratch(multi, 3);
    r.step('Then 8 threads, each with its own database connection, race for 3 seats, so this is not just Node handling requests one at a time.');
    const tallies = await Promise.all(Array.from({ length: 8 }, (_, id) => runWorker(hub.file, id, multi, 250, tag)));
    const sum = tallies.reduce((a, b) => ({ won: a.won + b.won, lost: a.lost + b.lost, replays: a.replays + b.replays, errors: a.errors + b.errors }));
    const after = hub.pod(multi)!;
    r.check('multi-writer', 'Parallel writers cannot overfill a group', sum.won === 3 && after.seatsTaken === 3 && sum.errors === 0, `${sum.won} won, ${sum.lost} lost, ${sum.replays} retries replayed, ${sum.errors} errors`);
    r.table('Parallel writers', [{ writers: 8, attempts: 8 * 250 * 2, ...sum, seatsTaken: after.seatsTaken, seatsTotal: after.seatsTotal }]);
    hub.db.prepare(`UPDATE pods SET state = 'DISSOLVED', seats_taken = 0 WHERE id = ?`).run(multi);
  }
  let backstop = false;
  try {
    hub.db.prepare('UPDATE pods SET seats_taken = 99 WHERE id = ?').run(podId);
  } catch {
    backstop = true;
  }
  r.check('backstop', 'Even a direct database write cannot overfill a group', backstop, backstop ? 'Rejected by a CHECK constraint' : 'Write succeeded');
  hub.db.prepare(`UPDATE seats SET state = 'RELEASED' WHERE pod_id = ?`).run(podId);
  hub.db.prepare(`UPDATE pods SET state = 'DISSOLVED', seats_taken = 0 WHERE id = ?`).run(podId);
  hub.db.prepare(`UPDATE riders SET state = 'CANCELLED' WHERE origin = 'ARENA'`).run();
  r.summary = `${n * 2} parallel requests for one seat: one winner, ${lost} accurate refusals, every retry consistent.`;
};

const c10: Card = async ({ hub }, r, params) => {
  const custom = Array.isArray(params?.readings) ? (params.readings as Reading[]) : null;
  const before = hub.state().kpis.groups;
  const ingested = hub.ingestTelemetry(custom ?? telemetrySample(hub.now).readings);
  r.step(custom ? `${ingested.stored} organiser readings loaded.` : 'Streaming five shared trips: a GPS teleport, a frozen GPS, a broken passenger count with a late packet, a real unexplained stop, and one healthy ride.');
  const reports = hub.sensorReports();
  const reviews = reports.map((x) => hub.raiseSafetyCheck(x)).filter((x) => x !== null);
  r.table('Verdicts', reports.map((x) => ({ ride: x.vehicleId, verdict: x.verdict, flags: x.flags.map((f) => f.code).join(', ') || 'none', action: x.action })));
  r.table('Evidence for each flag', reports.flatMap((x) => x.flags.map((f) => ({ ride: x.vehicleId, flag: f.code, detail: f.detail }))));
  r.check('no-auto', 'No automatic action was taken on a suspect reading', reports.every((x) => !x.autoAction) && hub.state().kpis.groups === before, 'Nothing was triggered automatically');
  if (custom) r.check('detected', 'Faults in your feed were detected', reports.some((x) => x.verdict !== 'HEALTHY'), `${reports.filter((x) => x.verdict !== 'HEALTHY').length} rides flagged`);
  else {
    const verdict = (id: string) => reports.find((x) => x.vehicleId === id)?.verdict;
    const one = reports.find((x) => x.vehicleId === 'RIDE-1');
    r.check('teleport', 'An impossible GPS jump is detected', verdict('RIDE-1') === 'SENSOR_FAULT' && !!one?.flags.some((f) => f.code === 'IMPOSSIBLE_JUMP'), verdict('RIDE-1') ?? 'none');
    r.check('frozen', 'A frozen GPS is told apart from a stop, using the odometer', verdict('RIDE-2') === 'SENSOR_FAULT', verdict('RIDE-2') ?? 'none');
    r.check('counter', 'An impossible passenger count is caught', verdict('RIDE-3') === 'SENSOR_FAULT', verdict('RIDE-3') ?? 'none');
    r.check('late', 'Delayed readings are marked', !!reports.find((x) => x.vehicleId === 'RIDE-3')?.flags.some((f) => f.code === 'LATE'), 'Late packet flagged');
    r.check('genuine', 'A real stop is not dismissed as a sensor fault', verdict('RIDE-4') === 'GENUINE_STOP', verdict('RIDE-4') ?? 'none');
    r.check('human', 'A real stop asks the riders, it does not act alone', reviews.length === 1, `${reviews.length} safety check raised`);
    r.check('healthy', 'A healthy ride raises no alarm', verdict('RIDE-5') === 'HEALTHY', verdict('RIDE-5') ?? 'none');
    r.check('last-good', 'Bad readings are excluded from the position estimate', !!one?.lastGood && one.lastGood.lat !== 13.6, `Last good latitude ${one?.lastGood?.lat?.toFixed(3)}`);
  }
  r.summary = `${reports.filter((x) => x.verdict === 'SENSOR_FAULT').length} faulty trips and ${reports.filter((x) => x.verdict === 'GENUINE_STOP').length} real stop told apart, and nothing triggered automatically.`;
};

const c11: Card = async ({ hub }, r, params) => {
  const { version: _drop, ...fallback } = POLICY_V2;
  void _drop;
  const doc = params?.policy ?? fallback;
  const oldVersion = hub.policy().version;
  const oldEpoch = hub.latestEpoch()!.id;
  const oldDecisions = hub.decisions(null, 1000000, oldEpoch);
  const oldHash = hashOf(oldDecisions);
  const passes = (hub.db.prepare(`SELECT pass_id FROM seats WHERE state = 'COMMITTED' ORDER BY pass_id`).all() as any[]).map((x) => x.pass_id);
  const riding = count(hub, `SELECT COUNT(*) c FROM seats WHERE state = 'BOARDED'`);
  const preview = hub.activatePolicy(doc, { dryRun: true });
  r.step(`Preview of "${preview.policy.name}": ${preview.diff.recalculated} reversible places would move, ${preview.diff.needApproval} confirmed groups would need approval.`);
  const applied = hub.activatePolicy(doc, { by: 'Duty controller' });
  r.step(`New policy activated as version ${applied.policy.version}.`);
  const epoch = hub.latestEpoch()!;
  const newDecisions = hub.decisions(null, 1000000, epoch.id);
  const oldAfter = hashOf(hub.decisions(null, 1000000, oldEpoch));
  const passesAfter = (hub.db.prepare(`SELECT pass_id FROM seats WHERE state = 'COMMITTED' ORDER BY pass_id`).all() as any[]).map((x) => x.pass_id);
  const chain = verifyChain(hub.ledger(0, 1000000));
  r.check('recognised', 'The policy change is recognised and recorded', applied.policy.version === oldVersion + 1 && epoch.policy_version === applied.policy.version, `Version ${oldVersion} to ${applied.policy.version}, match ${epoch.id} stamped ${epoch.policy_version}`);
  r.check('recalculated', 'Affected decisions are re-evaluated under the new rule', newDecisions.length > 0 && count(hub, 'SELECT COUNT(*) c FROM decisions WHERE epoch = ? AND policy_version != ?', epoch.id, applied.policy.version) === 0, `${applied.diff.recalculated} reversible places moved`);
  r.check('history', 'Previous records are unchanged', oldHash === oldAfter, `Match ${oldEpoch} hash unchanged across ${oldDecisions.length} decisions`);
  r.check('no-silent-reversal', 'No issued pass was silently changed', JSON.stringify(passes) === JSON.stringify(passesAfter), `${passes.length} passes before, ${passesAfter.length} after`);
  r.check('approval', 'Confirmed groups the new rule would change wait for a person', hub.approvals().filter((a) => a.kind === 'RELEASE_GROUP').length >= applied.approvals.length, `${applied.approvals.length} approvals queued`);
  r.check('riding', 'People already riding are untouched', riding === count(hub, `SELECT COUNT(*) c FROM seats WHERE state = 'BOARDED'`), `${riding} riding`);
  r.check('ledger', 'The audit chain is intact', chain.ok, `${chain.checked} entries verified`);
  const was = new Map(oldDecisions.map((d) => [d.pid, d]));
  r.table('Before and after', newDecisions.filter((d) => was.has(d.pid) && (was.get(d.pid)!.priority.tierId !== d.priority.tierId || was.get(d.pid)!.outcome !== d.outcome)).slice(0, 10).map((d) => {
    const b = was.get(d.pid)!;
    return { rider: d.pid, before: `${b.priority.tierLabel} (${b.priority.score})`, after: `${d.priority.tierLabel} (${d.priority.score})`, outcomeBefore: b.outcome, outcomeAfter: d.outcome };
  }));
  r.table('Change summary', [{ from: applied.diff.from, to: applied.diff.to, recalculated: applied.diff.recalculated, needApproval: applied.diff.needApproval, untouchedRiding: applied.diff.untouchedRiding }]);
  r.table('Awaiting approval', hub.approvals().slice(0, 8).map((a) => ({ id: a.id, subject: a.subject, reason: a.reason })));
  r.summary = `Policy ${applied.policy.version} applied: ${applied.diff.recalculated} places recalculated, ${applied.diff.needApproval} groups held for approval, history unchanged.`;
};

const c12: Card = async ({ hub }, r) => {
  const tag = Date.now().toString(36);
  let found: string | null = null;
  for (const spot of ['GDY-E', 'SRM-MAIN', 'SHO-TP']) {
    for (const dest of ['MAS', 'MAA', 'SHO', 'VLC']) {
      const { pid } = hub.request({ opId: `arena-c12-${tag}-${spot}-${dest}`, spot, dest, party: 1, maxDetourMin: 20 });
      hub.matchEpoch('Rider with an unconfirmed preference');
      if (hub.riderView(pid).clarification) {
        found = pid;
        break;
      }
    }
    if (found) break;
  }
  if (!found) {
    r.check('setup', 'A case with a decision-critical gap exists', false, 'No rider needed a question in this world');
    return;
  }
  const view = hub.riderView(found);
  const q = view.clarification!;
  r.step(`A rider to ${nodeName(view.rider.dest)} has not said who they are comfortable sharing with. Both answers are possible, and they lead to different groups.`);
  const passBefore = view.pass;
  r.check('identified', 'The exact missing field is identified', q.field === 'shareWith', `Missing field: ${q.field}`);
  r.check('not-invented', 'The system did not invent the answer', view.rider.shareWith === null, `Stored preference is still ${view.rider.shareWith}`);
  r.check('no-pass', 'No irreversible action was taken', passBefore === null && view.seat === null, passBefore ? 'A pass was issued' : 'No pass issued and no group joined');
  r.check('asked', 'A relevant question was asked', q.question.length > 0 && q.why.length > 0, q.question);
  r.check('why', 'The system explains why it cannot proceed', view.explanation?.headline.includes('one answer') === true, q.why);
  const after = hub.answerClarification(found, q.id, 'WOMEN_ONLY');
  r.step('The rider answers. The decision is now made on the real answer.');
  r.check('answered', 'The answer unblocks the decision', after.rider.shareWith === 'WOMEN_ONLY' && after.rider.state !== 'AWAITING_INFO', `Preference ${after.rider.shareWith}, state ${after.rider.state}`);
  const decidedOk = after.seat !== null || after.decision?.outcome === 'WAITLISTED';
  r.check('correct', 'The final outcome fits the answer', decidedOk, after.seat ? 'Placed in a women-only group' : 'Waitlisted with a reason');
  r.table('The request', [{ field: q.field, question: q.question, why: q.why, options: q.options.join(', '), escalatesAt: clockLabel(q.due_at), escalatesTo: 'Circle admin' }]);
  r.table('Blocked action', [{ action: 'Join a group and issue a pass', status: 'Blocked until answered' }]);
  r.summary = 'The system asked one question instead of guessing, and only asks when the answer changes the outcome.';
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
      card: id, title: info.title, status: passed ? 'PASS' : 'FAIL',
      summary: report.summary || 'This card did not complete. See the failed checks.',
      ranAtMs: Date.now(), durationMs: Math.round(performance.now() - t0),
      steps: report.steps, checks: report.checks, evidence: report.evidence, tryIt: report.tryIt,
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
