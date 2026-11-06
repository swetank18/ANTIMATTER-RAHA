// RAHA experiments: node scripts/run_experiments.mjs [seeds=200]
// Runs the same engine the browser uses and writes results/*.json plus data/results.json (read by the app).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { POLICIES, prepareWorld, makePassengers, simulate, bootstrapCI, makeRng, sanityBound, DRIFT_CLASSES } from '../src/sim/engine.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SEEDS = Number(process.argv[2] || 200);
const scn = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/scenarios.json'), 'utf8'));
const geoOf = (id) => { const f = path.join(ROOT, `data/geo/${id}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
let commit = 'uncommitted'; try { commit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch {}
const stamp = { seeds: SEEDS, commit, date: new Date().toISOString(), engine: 'src/sim/engine.js' };
const KEYS = ['clearanceMin', 'meanWait', 'medianWait', 'p95Wait', 'worstWait', 'wheelchairP95', 'deadlinesMet', 'gini', 'seatUtil', 'turnedAway', 'overbooked', 'emptyDepartures', 'peakDoorCrowd', 'peakDoorDensity', 'unserved', 'cabTrips', 'ridersPerCab', 'cabFarePerRider', 'cabSoloPerRider', 'maxShareRatio', 'peakSurge', 'peakGateCrowd', 'allocatorDownEvents', 'bikeRiders', 'bikeFarePerRider', 'dropsForGuarantee', 'essentialsDrops'];
const R = makeRng(7);
function summarize(runs) {
  const o = {};
  for (const k of KEYS) { const xs = runs.map((r) => r[k]).filter((x) => x != null && Number.isFinite(x)); o[k] = xs.length ? bootstrapCI(xs, R, 600).map((x) => +x.toFixed(4)) : null; }
  return o;
}
function runSet(world, policy, opts = {}, seeds = SEEDS) {
  const runs = [];
  for (let s = 1; s <= seeds; s++) runs.push(simulate(world, policy, s, { ...opts, pax: makePassengers(world, s) }));
  return runs;
}
fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
const out = { stamp, scenarios: {} };
const t0 = Date.now();
for (const s of scn.scenarios) {
  const geo = geoOf(s.id);
  if (!geo && s.corridors.some((c) => c.place)) { console.log(`skip ${s.id}: no geo pack yet`); continue; }
  const world = prepareWorld(s, geo);
  const res = { stamp, N: world.N, sanityBoundMin: sanityBound(world), main: {}, sensitivity: {}, c1: null, c3: null };
  // E1 main comparison + E2 sanity bound
  for (const pol of POLICIES) {
    const runs = runSet(world, pol);
    res.main[pol] = summarize(runs);
    const below = runs.filter((r) => !r.unserved && r.clearanceMin + 1e-6 < res.sanityBoundMin).length;
    if (below) console.warn(`  !! ${s.id}/${pol}: ${below} runs below the sanity bound`);
  }
  // E3 sensitivity (fewer seeds): door crush 0, demand x0.5/x2, fleet x0.5
  const half = Math.max(20, Math.floor(SEEDS / 4));
  const variants = { doorCrush0: { opts: { doorCrush: 0 } }, demandHalf: { ov: { demandScale: 0.5 } }, demandDouble: { ov: { demandScale: 2 } }, fleetHalf: { ov: { fleetScale: 0.5 } } };
  for (const [name, v] of Object.entries(variants)) {
    const w = v.ov ? prepareWorld(s, geo, v.ov) : world;
    res.sensitivity[name] = {};
    for (const pol of ['FREE_FOR_ALL', 'FCFS', 'RAHA']) res.sensitivity[name][pol] = summarize(runSet(w, pol, v.opts || {}, half));
  }
  // E4 Constraint 1: internet cut at the start of the incident, phone reach sweep, local vs cloud architecture
  if (s.id === 'atocha' || s.id === 'tambaram') {
    const cutAt = s.cut?.at ?? s.arrivalProfile[0].from;
    res.c1 = {};
    for (const reach of [1, 0.7, 0.3, 0]) {
      const row = {};
      for (const [label, pol, arch] of [['FREE_FOR_ALL', 'FREE_FOR_ALL', 'local'], ['FCFS_app', 'FCFS', 'cloud'], ['RAHA_cloud', 'RAHA', 'cloud'], ['RAHA_local', 'RAHA', 'local']]) {
        row[label] = summarize(runSet(world, pol, { cutAt: reach === 1 ? null : cutAt, reachAfter: reach, arch }, half));
      }
      res.c1[`reach_${reach}`] = row;
    }
  }
  // E5 Constraint 3: provider feed changes shape mid-incident; naive parser vs tolerant reader
  if (s.id === 'jurong' || s.id === 'tambaram') {
    const at = s.drift?.at ?? s.arrivalProfile[0].from + 20;
    res.c3 = {};
    for (const cls of DRIFT_CLASSES) {
      res.c3[cls] = {
        naive: summarize(runSet(world, 'RAHA', { drift: { cls, at }, parser: 'naive' }, half)),
        adapter: summarize(runSet(world, 'RAHA', { drift: { cls, at }, parser: 'adapter' }, half)),
      };
    }
  }
  out.scenarios[s.id] = res;
  fs.writeFileSync(path.join(ROOT, `results/${s.id}.json`), JSON.stringify(res, null, 1));
  const m = res.main;
  console.log(`${s.id}: N=${world.N} bound=${res.sanityBoundMin.toFixed(0)}min | worst wait FFA ${m.FREE_FOR_ALL.worstWait[0].toFixed(0)} FCFS ${m.FCFS.worstWait[0].toFixed(0)} RAHA ${m.RAHA.worstWait[0].toFixed(0)} | turned away FFA ${m.FREE_FOR_ALL.turnedAway[0].toFixed(0)} RAHA ${m.RAHA.turnedAway[0].toFixed(0)} | riders/cab FFA ${m.FREE_FOR_ALL.ridersPerCab[0].toFixed(2)} RAHA ${m.RAHA.ridersPerCab[0].toFixed(2)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
fs.writeFileSync(path.join(ROOT, 'data/results.json'), JSON.stringify(out));
fs.writeFileSync(path.join(ROOT, 'results/summary.json'), JSON.stringify(out, null, 1));
console.log('done', ((Date.now() - t0) / 1000).toFixed(1), 's');
