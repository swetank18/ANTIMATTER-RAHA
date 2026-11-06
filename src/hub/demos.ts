// The product story, run live. Like the Arena cards, each demo acts on the real hub and judges
// the outcome from stored data. Everything marked simulated is simulated, and each demo says so.

import type { CardCheck, CardResult } from '../core/types.ts';
import { fareFor, KM_PER_MIN } from '../core/fare.ts';
import { NODES, nodeName, SPOTS } from '../core/world.ts';
import type { ArenaContext } from './arena.ts';
import type { Hub } from './hub.ts';

export const DEMOS = [
  { id: 'bloc', title: 'A crowd becomes one buyer', blurb: 'Four riders post one request. Drivers bid for the group, each rider locks their share, and a no-show loses their seat.' },
  { id: 'bridge', title: 'Bridge mode when a train fails', blurb: 'Rail fails at Guindy. Riders are grouped for a short ride to the nearest working station instead of the whole trip home.' },
  { id: 'surge', title: 'Surge forecast', blurb: 'A rain and transit alert arrive. The model forecasts the next 15 minutes and groups start forming before surge climbs.' },
  { id: 'evidence', title: 'Fares become evidence', blurb: 'Paired quotes get a real statistical test, and an over-cap fare produces a complaint draft.' },
];

interface Out {
  steps: string[];
  checks: CardCheck[];
  evidence: CardResult['evidence'];
  summary: string;
  facts?: Record<string, unknown>;
}

const check = (o: Out, id: string, requirement: string, ok: boolean, observed: string | number) => o.checks.push({ id, requirement, ok, observed: String(observed) });

function freshGroup(hub: Hub, tag: string, size: number) {
  const ids: string[] = [];
  for (let i = 0; i < size; i++) ids.push(hub.request({ opId: `demo-${tag}-${i}`, spot: 'GDY-E', dest: 'TBM', party: 1, shareWith: 'ANYONE', maxWaitMin: 30, maxDetourMin: 15 }).pid);
  hub.matchEpoch('Demo group');
  const pod = hub.riderView(ids[0]).pod;
  return { ids, podId: pod?.id ?? null };
}

async function bloc({ hub }: ArenaContext, o: Out) {
  hub.reset(Number(hub.meta('seed') ?? 842), 200);
  const tag = Date.now().toString(36);
  let { ids, podId } = freshGroup(hub, tag, 4);
  if (!podId || hub.pod(podId)?.state !== 'LOCKED') {
    hub.advance(5);
    podId = hub.riderView(ids[0]).pod?.id ?? null;
  }
  const pod = podId ? hub.pod(podId) : null;
  if (!pod) {
    check(o, 'setup', 'A group formed', false, 'No group formed in this world');
    return;
  }
  const members = hub.podShares(pod.id);
  const soloEach = members[0].solo;
  const soloTotal = members.reduce((s, m) => s + m.solo, 0);
  o.steps.push(`${members.length} riders at ${SPOTS.find((s) => s.id === pod.spot)?.name} are going towards ${pod.stops.map(nodeName).join(', ')}. Alone, each sees about Rs ${soloEach} in their app.`);

  const res = await hub.requestBids(pod.id);
  if (!res.ok) {
    check(o, 'bids', 'Drivers bid for the group', false, res.message);
    return;
  }
  o.steps.push(`One pooled request goes to the open network sandbox. ${res.ranked.length + res.rejected.length} simulated drivers quote, and ${res.rejected.length} ${res.rejected.length === 1 ? 'is' : 'are'} filtered out.`);
  check(o, 'bids', 'Drivers compete for the group', res.ranked.length >= 2, `${res.ranked.length} usable bids`);
  if (!res.best) return;
  const lead = hub.pod(pod.id)!.lead!;
  const accepted = hub.acceptBid({ opId: `demo-accept-${tag}`, pid: lead, podId: pod.id, bidId: res.best.id });
  o.steps.push(`${res.best.driver} wins at Rs ${res.best.amount} for everyone. Each rider's fair share is worked out.`);
  check(o, 'cheaper', 'The whole group pays less than one solo fare would suggest', res.best.amount < soloTotal, `Rs ${res.best.amount} for the group against Rs ${soloTotal} if each booked alone`);
  check(o, 'everyone', 'Everyone pays less than going alone', accepted.shares.every((m) => m.share < m.solo), accepted.shares.map((m) => `Rs ${m.share}`).join(', '));
  check(o, 'sums', 'Shares add up to the bid exactly', accepted.shares.reduce((s, m) => s + m.share, 0) === res.best.amount, `Rs ${accepted.shares.reduce((s, m) => s + m.share, 0)}`);

  // One rider never locks. They lose the seat, and nobody else is left paying for it.
  const noShow = accepted.shares[accepted.shares.length - 1].pid;
  for (const m of accepted.shares) if (m.pid !== noShow) hub.lockShare({ opId: `demo-lock-${tag}-${m.pid}`, pid: m.pid, podId: pod.id });
  check(o, 'waits', 'The cab is not booked until every share is locked', hub.pod(pod.id)!.state === 'LOCKED', `State is ${hub.pod(pod.id)!.state} with ${accepted.shares.length - 1} of ${accepted.shares.length} locked`);
  o.steps.push('Everyone but one rider locks their share. That rider does not respond before the deadline.');
  const after = hub.dropUnlocked(pod.id);
  check(o, 'no-show', 'A no-show loses the seat and nobody is charged for it', after.dropped.length === 1 && hub.reservationsFor(pod.id).every((r) => r.state === 'RELEASED'), `${after.dropped.length} dropped, all earlier blocks released`);
  o.steps.push('The no-show loses the seat, every block is released, and shares are recalculated for those who stayed.');
  for (const m of after.shares) hub.lockShare({ opId: `demo-relock-${tag}-${m.pid}`, pid: m.pid, podId: pod.id });
  const final = hub.pod(pod.id)!;
  const debited = hub.reservationsFor(pod.id).filter((r) => r.state === 'DEBITED');
  check(o, 'booked', 'Once all remaining shares lock, the group is booked', final.state === 'BOOKED', `State is ${final.state}`);
  check(o, 'paid', 'The driver is covered in full and the lead is not out of pocket', debited.reduce((s, r) => s + r.amount, 0) === final.fare, `Rs ${debited.reduce((s, r) => s + r.amount, 0)} debited against a fare of Rs ${final.fare}`);
  check(o, 'still-saves', 'Riders still save after the no-show', after.shares.every((m) => m.share < m.solo), after.shares.map((m) => `Rs ${m.share} instead of Rs ${m.solo}`).join(', '));

  o.evidence.push({ label: 'Driver bids (simulated drivers)', rows: [...res.ranked.map((b) => ({ driver: b.driver, bid: b.amount, etaMin: b.etaMin, rating: b.rating, outcome: b.id === res.best!.id ? 'Won' : 'Lost' })), ...res.rejected.map((x) => ({ driver: x.bid.driver, bid: x.bid.amount, etaMin: x.bid.etaMin, rating: x.bid.rating, outcome: x.why }))] });
  o.evidence.push({ label: 'Blocks through the payment gateway (simulated, no money moves)', rows: hub.reservationsFor(pod.id).map((r) => ({ rider: r.pid, amount: r.amount, state: r.state })) });
  const spot = SPOTS.find((s) => s.id === pod.spot)!;
  const normal = fareFor(Math.max(1, pod.routeMin * KM_PER_MIN));
  const finalShares = after.shares.map((m) => m.share);
  o.facts = {
    spot: spot.name, from: spot.node, stops: pod.stops, stopNames: pod.stops.map(nodeName), surge: spot.surge,
    soloEach, normalFare: normal, bid: res.best.amount, driver: res.best.driver, etaMin: res.best.etaMin,
    riders: members.length, boarded: after.shares.length, shareEach: Math.max(...finalShares), shares: finalShares,
    bids: [...res.ranked.map((b) => ({ driver: b.driver, amount: b.amount, etaMin: b.etaMin, won: b.id === res.best!.id, why: null })), ...res.rejected.map((x) => ({ driver: x.bid.driver, amount: x.bid.amount, etaMin: x.bid.etaMin, won: false, why: x.why }))],
  };
  o.summary = `Alone, each rider pays Rs ${soloEach} at ${spot.surge}x surge. Together they hire one cab for Rs ${res.best.amount}, about Rs ${Math.max(...finalShares)} each. The driver earns more than the normal Rs ${normal} fare, and a no-show cost nobody anything.`;
}

async function bridge({ hub }: ArenaContext, o: Out) {
  hub.reset(Number(hub.meta('seed') ?? 842), 200);
  const tag = Date.now().toString(36);
  const stops = ['MAS', 'EGM', 'KLK', 'MAA'];
  const ids: string[] = [];
  for (let i = 0; i < 40; i++) ids.push(hub.request({ opId: `bridge-${tag}-${i}`, spot: 'GDY-E', dest: stops[i % stops.length], party: 1, shareWith: 'ANYONE', maxWaitMin: 30, maxDetourMin: 15 }).pid);
  o.steps.push('40 riders are at Guindy heading to Central, Egmore, Kilpauk and the Airport. Rail at Guindy fails.');
  const res = hub.triggerBridge('GDY', 'Rail failure at Guindy');
  o.steps.push(`Riders are grouped for a short hop to the nearest running station instead of the whole trip.`);
  const views = ids.map((pid) => hub.riderView(pid));
  const placed = views.filter((v) => v.pod);
  const bridged = views.filter((v) => v.bridge);
  const cabs = new Set(placed.map((v) => v.pod!.id)).size;
  const hop = placed.reduce((s, v) => s + (v.seat?.share ?? 0), 0);
  const full = views.reduce((s, v) => s + (v.bridge?.fullFare ?? 0), 0);
  check(o, 'bridged', 'Riders are sent to a working station', bridged.length >= 30, `${bridged.length} of 40 bridged`);
  check(o, 'grouped', 'Those riders travel in far fewer cabs', placed.length > 0 && cabs <= Math.ceil(placed.length / 2), `${placed.length} riders in ${cabs} cabs`);
  check(o, 'cheaper', 'The short ride costs a fraction of the trip home', hop < full / 2, `Rs ${hop} in total against Rs ${full} for everyone riding the whole way`);
  check(o, 'certified', 'The plan passed its independent check', res.epoch.certificate.ok && res.epoch.podChecks.every((c) => c.ok), 'Certified');
  o.evidence.push({ label: 'Where riders were sent', rows: res.stations });
  const byPod = new Map<string, number>();
  for (const v of placed) byPod.set(v.pod!.id, (byPod.get(v.pod!.id) ?? 0) + 1);
  o.evidence.push({ label: 'Bridge rides', rows: [...byPod.entries()].slice(0, 12).map(([id, n]) => {
    const p = hub.pod(id)!;
    return { group: id, riders: n, to: p.stops.map(nodeName).join(', '), minutes: p.routeMin, fare: p.fare };
  }) });
  const nodeByName = new Map(NODES.map((n) => [n.name, n.id]));
  o.facts = {
    riders: 40, bridged: bridged.length, placed: placed.length, cabs, hop, full, failedAt: 'GDY',
    stations: res.stations.map((s) => ({ node: nodeByName.get(s.station) ?? null, name: s.station, riders: s.riders })),
    rides: [...byPod.entries()].map(([id, n]) => ({ riders: n, to: hub.pod(id)!.stops, fare: hub.pod(id)!.fare })),
  };
  o.summary = `40 riders became ${cabs} short bridge rides, costing Rs ${hop} in total instead of Rs ${full}.`;
}

async function surge({ hub }: ArenaContext, o: Out) {
  hub.reset(Number(hub.meta('seed') ?? 842));
  const { report } = hub.surgeModel();
  const spot = 'GDY-W';
  const before = hub.surgeForecast(spot);
  hub.setAlert('RAIN', true);
  hub.setAlert('TRANSIT', true);
  const after = hub.surgeForecast(spot);
  hub.setAlert('RAIN', false);
  hub.setAlert('TRANSIT', false);
  o.steps.push(`Forecast at Guindy west exit before any alert: ${before.multiple}x. ${before.message}`);
  o.steps.push(`A rain alert and a transit alert arrive: ${after.multiple}x. ${after.message}`);
  check(o, 'responds', 'The forecast reacts to the alerts', after.multiple > before.multiple, `${before.multiple}x to ${after.multiple}x`);
  check(o, 'early', 'Riders are told to form groups before surge climbs', after.advice === 'FORM_GROUPS_NOW', after.message);
  check(o, 'legal', 'The forecast respects the legal cap', after.multiple <= 2, `${after.multiple}x`);
  check(o, 'explains', 'The forecast explains itself', after.drivers.length > 0, after.drivers.map((d) => d.feature).join(', '));
  check(o, 'beats-baseline', 'It beats simple baselines on unseen days', report.maeModel < report.maeNoChange && report.maeModel < report.maeHourAverage, `Error ${report.maeModel} against ${report.maeNoChange} (no change) and ${report.maeHourAverage} (hourly average)`);
  o.evidence.push({ label: 'What is driving the forecast', rows: after.drivers.map((d) => ({ factor: d.feature, effect: d.effect })) });
  o.evidence.push({ label: 'Backtest on synthetic history', rows: [{ trainDays: report.trainDays, testDays: report.testDays, errorModel: report.maeModel, errorNoChange: report.maeNoChange, errorHourAverage: report.maeHourAverage, improvementPct: report.improvementPct, precision: report.precision, recall: report.recall }] });
  o.evidence.push({ label: 'Read this first', rows: [{ note: report.note }] });
  o.summary = `Forecast rose from ${before.multiple}x to ${after.multiple}x. Trained on synthetic data: real use means retraining on quotes riders share.`;
}

async function evidence({ hub }: ArenaContext, o: Out) {
  hub.reset(Number(hub.meta('seed') ?? 842));
  const pod = hub.pods(`state = 'LOCKED'`)[0];
  const stmt = hub.db.prepare('INSERT INTO quotes(pod_id, pid, app, amount, device, observed_at) VALUES (?, ?, ?, ?, ?, ?)');
  const before = hub.priceGapReport();
  hub.db.transaction(() => {
    for (let i = 0; i < 30; i++) {
      const base = 300 + ((i * 37) % 200);
      stmt.run(pod.id, 'synthetic', 'Demo app', base + 12 + (i % 5) * 3, 'iPhone', -100 - i);
      stmt.run(pod.id, 'synthetic', 'Demo app', base + (i % 3) * 2, 'Android', -100 - i);
    }
  })();
  const report = hub.priceGapReport();
  o.steps.push('30 pairs of quotes are loaded. These are invented for this demo to show the method. They say nothing about any real app.');
  check(o, 'needs-data', 'With too little data it refuses to conclude', before.verdict === 'NOT_ENOUGH_DATA', before.message);
  check(o, 'tested', 'A real test is run, with confidence levels', report.ci95 !== null && report.pValue !== null, `Mean gap Rs ${report.meanGap}, 95% interval Rs ${report.ci95?.join(' to Rs ')}, p = ${report.pValue}`);

  const refused = hub.complaintDraft({ spot: 'GDY-E', dest: 'MAA', app: 'Demo app', amount: 5000 });
  check(o, 'no-accusation', 'No complaint is drafted without a verified base fare', refused.ready === false, refused.reason);
  hub.setFareRule({ vehicle: 'MINI', baseFare: 50, perKm: 18, capMultiplier: 2, floorMultiplier: 0.5, verified: true, source: 'Demo fare table (not a real notification)' });
  const made = hub.complaintDraft({ spot: 'GDY-E', dest: 'MAA', app: 'Demo app', amount: 5000 });
  check(o, 'draft', 'An over-cap fare produces a ready draft', made.ready === true && !!made.draft, made.reason);
  check(o, 'no-identity', 'The draft holds no rider identity', !!made.draft && made.draft.includes('[Add your name'), 'Rider adds their own details on their phone');
  o.evidence.push({ label: 'Statistical result (synthetic quotes)', rows: [{ pairs: report.pairs, meanGap: report.meanGap, low: report.ci95?.[0] ?? null, high: report.ci95?.[1] ?? null, p: report.pValue, finding: report.message }] });
  o.evidence.push({ label: 'Complaint draft', rows: [{ draft: made.draft }] });
  o.summary = 'Quotes get a real test with confidence levels, and an over-cap fare becomes a draft ready to review and file.';
}

const RUNNERS: Record<string, (c: ArenaContext, o: Out) => Promise<void>> = { bloc, bridge, surge, evidence };

export async function runDemo(ctx: ArenaContext, id: string): Promise<CardResult> {
  const o: Out = { steps: [], checks: [], evidence: [], summary: '' };
  const t0 = performance.now();
  try {
    await RUNNERS[id](ctx, o);
  } catch (e) {
    check(o, 'crash', 'The demo ran to completion', false, e instanceof Error ? e.message : 'Unknown failure');
  }
  const info = DEMOS.find((d) => d.id === id)!;
  return {
    card: id, title: info.title, status: o.checks.length > 0 && o.checks.every((c) => c.ok) ? 'PASS' : 'FAIL',
    summary: o.summary || 'This demo did not complete. See the failed checks.', ranAtMs: Date.now(), durationMs: Math.round(performance.now() - t0),
    steps: o.steps, checks: o.checks, evidence: o.evidence, facts: o.facts,
  };
}
