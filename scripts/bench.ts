// Times the solver on the real world model and writes the result beside the other evidence.
import { writeFileSync, mkdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { Hub } from '../src/hub/hub.ts';

const rows = [];
for (const n of [1500, 5000, 20000]) {
  const hub = new Hub({ riders: n });
  const a = hub.matchEpoch('bench');
  const t0 = performance.now();
  const c = hub.cohorts();
  rows.push({ riders: n, solveMs: Math.round(a.solveMs * 10) / 10, clusterMs: c.ms, clusterTotalMs: Math.round((performance.now() - t0) * 10) / 10, groups: a.pods, certified: a.certificate.ok });
  hub.close();
}
console.table(rows);
mkdirSync('results', { recursive: true });
writeFileSync('results/bench.json', JSON.stringify({ node: process.version, cpu: cpus()[0]?.model, ranAt: new Date().toISOString(), rows }, null, 2));
