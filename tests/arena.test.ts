import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hub } from '../src/hub/hub.ts';
import { Outside } from '../src/hub/outside.ts';
import { buildServer, type Server } from '../src/hub/server.ts';

let dir: string;
let hub: Hub;
let outside: Outside;
let server: Server;
let base: string;

const post = async (path: string, body: unknown = {}) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const failed = (c: any) => c.checks.filter((x: any) => !x.ok).map((x: any) => `${x.id}: ${x.observed}`);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'omnistrand-'));
  hub = new Hub({ file: join(dir, 'hub.db'), passengers: 1420 });
  outside = new Outside();
  const url = await outside.start();
  hub.egress.allowlist = { 'transit-feed': url, analytics: url };
  server = buildServer(hub, outside);
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = server.app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
  server.ctx.baseUrl = base;
}, 60000);

afterAll(async () => {
  await server.app.close();
  await outside.stop();
  hub.close();
  rmSync(dir, { recursive: true, force: true });
});

const UI_DEPENDENT = existsSync('results/a11y.json') ? [] : ['C06'];

describe('each card on a fresh world', () => {
  for (const id of ['C01', 'C02', 'C03', 'C04', 'C05', 'C07', 'C08', 'C09', 'C10', 'C11', 'C12']) {
    it(id, async () => {
      const { json } = await post(`/api/arena/${id}/run`);
      expect(failed(json)).toEqual([]);
      expect(json.status).toBe('PASS');
      expect(json.checks.length).toBeGreaterThanOrEqual(4);
    }, 60000);
  }

  it('C06 reports honestly that it needs the browser audit', async () => {
    const { json } = await post('/api/arena/C06/run');
    if (UI_DEPENDENT.length) {
      expect(json.status).toBe('FAIL');
      expect(json.checks.find((c: any) => c.id === 'browser').observed).toMatch(/UI/);
    }
  });
});

describe('cards can really fail', () => {
  it('C03 fails if the provider sends something unmappable', async () => {
    const { json } = await post('/api/arena/C03/run', { params: { response: '{"nothing":"useful"}' } });
    expect(json.status).toBe('FAIL');
  });

  it('C10 flags faults in organiser data', async () => {
    const now = hub.now;
    const readings = [0, 1, 2, 3].map((i) => ({ vehicleId: 'V07', observedAt: now - 4 + i, receivedAt: now - 4 + i, lat: i === 2 ? 20 : 13, lng: 80, odoKm: 5 + i, occupancy: null }));
    const { json } = await post('/api/arena/C10/run', { params: { readings } });
    expect(json.status).toBe('PASS');
  });

  it('C04 takes organiser data', async () => {
    const data = 'passenger_id,destination,need\nORG-1,MAA,NONE\nORG-2,NOWHERE,NONE\n';
    const { json } = await post('/api/arena/C04/run', { params: { data } });
    expect(json.summary).toMatch(/1 accepted, 1 quarantined/);
  });

  it('C02 takes organiser records', async () => {
    const records = [
      { route: 'GDY-TNG', value: 'RUNNING', source: 'FIELD_MARSHAL', observedAt: 0 },
      { route: 'GDY-TNG', value: 'SUSPENDED', source: 'CONTROL_ROOM', observedAt: 0 },
    ];
    const { json } = await post('/api/arena/C02/run', { params: { records } });
    expect(failed(json)).toEqual([]);
  });

  it('C11 rejects a bad policy from the organiser without breaking', async () => {
    const { json } = await post('/api/arena/C11/run', { params: { policy: { name: 'broken' } } });
    expect(json.status).toBe('FAIL');
    expect((await fetch(`${base}/api/health`)).ok).toBe(true);
  });
});

describe('all twelve stacked on one world', () => {
  it('passes everything that does not need the browser', async () => {
    const { json } = await post('/api/arena/run-all');
    const bad = json.results.filter((r: any) => r.status !== 'PASS' && !UI_DEPENDENT.includes(r.card)).map((r: any) => `${r.card} ${failed(r).join(' | ')}`);
    expect(bad).toEqual([]);
    expect(hub.state().kpis.overAllocated).toBe(0);
    expect((await (await fetch(`${base}/api/ledger/verify`)).json()).ok).toBe(true);
  }, 120000);
});

describe('HTTP behaviour', () => {
  it('drops field connections during an outage but keeps operations up', async () => {
    await post('/api/arena/offline', { on: true });
    await expect(fetch(`${base}/api/field/passenger/x`)).rejects.toThrow();
    expect((await fetch(`${base}/api/state`)).ok).toBe(true);
    await post('/api/arena/offline', { on: false });
    expect((await fetch(`${base}/api/field/passenger/x`)).status).toBe(404);
  });

  it('never echoes the request back in an error', async () => {
    const r = await fetch(`${base}/api/field/checkin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"Secret Person",' });
    const text = await r.text();
    expect(r.status).toBe(400);
    expect(text).not.toContain('Secret');
  });

  it('accepts a broken JSON batch at the boundary', async () => {
    const r = await fetch(`${base}/api/ingest/passengers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[{"passenger_id":"H1","destination":"MAA","need":"NONE"},{"oops' });
    const j = await r.json();
    expect(j.accepted).toBe(1);
    expect(j.quarantined.length).toBe(1);
  });

  it('accepts CSV as plain text', async () => {
    const r = await fetch(`${base}/api/ingest/passengers`, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: 'passenger_id,destination,need\nH2,TBM,NONE\n' });
    expect((await r.json()).accepted).toBe(1);
  });

  it('runs a passenger journey end to end', async () => {
    const { json: made } = await post('/api/field/checkin', { opId: 'journey-1', dest: 'MAA', party: 1, need: 'NONE' });
    await post('/api/allocate');
    const v = await (await fetch(`${base}/api/field/passenger/${made.pid}`)).json();
    expect(v.decision).toBeTruthy();
    expect(v.explanation.headline.length).toBeGreaterThan(0);
  });

  it('streams change notices', async () => {
    const ctl = new AbortController();
    const res = await fetch(`${base}/api/stream`, { signal: ctl.signal });
    const reader = res.body!.getReader();
    await post('/api/allocate');
    let text = '';
    while (!text.includes('changed')) text += new TextDecoder().decode((await reader.read()).value);
    ctl.abort();
    expect(text).toContain('event: changed');
  });
});

describe('restart', () => {
  it('resumes the ledger from disk with the chain intact', async () => {
    const file = join(dir, 'restart.db');
    const a = new Hub({ file, passengers: 100 });
    const key = a.keys;
    a.advance(5);
    const seq = a.state().ledgerHead.seq;
    a.close();
    const b = new Hub({ file });
    expect(b.state().ledgerHead.seq).toBe(seq);
    b.allocateEpoch('after restart');
    expect(b.ledger(0, 100000).length).toBe(seq + 1);
    void key;
    b.close();
  });
});
