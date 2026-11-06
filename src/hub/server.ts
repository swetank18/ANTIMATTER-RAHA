import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { coverage } from '../core/i18n.ts';
import { verifyChain } from '../core/ledger.ts';
import { DESTINATIONS, EDGES, NODES, SPOTS } from '../core/world.ts';
import { Arena, CARDS, type ArenaContext } from './arena.ts';
import { DEMOS, runDemo } from './demos.ts';
import { Hub, HubError } from './hub.ts';
import type { Outside } from './outside.ts';

export interface Server {
  app: FastifyInstance;
  arena: Arena;
  ctx: ArenaContext;
}

export function buildServer(hub: Hub, outside: Outside): Server {
  const app = Fastify({ logger: false, bodyLimit: 2_500_000 });
  const ctx: ArenaContext = { hub, outside, baseUrl: null };
  const arena = new Arena(ctx);

  // Rider batches arrive here untouched: the tolerant parser must see even broken JSON.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (req.url.startsWith('/api/ingest/riders')) return done(null, body);
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch {
      done(new HubError('BAD_JSON', 'The request body is not valid JSON'), undefined);
    }
  });
  app.addContentTypeParser(['text/plain', 'text/csv'], { parseAs: 'string' }, (_req, body, done) => done(null, body));

  // During an outage field clients must see a real network failure, not a polite error.
  app.addHook('onRequest', (req, _reply, done) => {
    if (hub.offline && req.url.startsWith('/api/field/')) {
      req.raw.socket.destroy();
      return;
    }
    done();
  });

  // Errors are safe to show: known codes only, and nothing from the request is ever echoed.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HubError) return reply.code(err.http).send({ error: { code: err.code, message: err.message } });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: { code: 'BAD_REQUEST', message: 'The request could not be read.' } });
    hub.log.write('error', 'unhandled', { code: (err as { code?: string }).code ?? 'UNKNOWN' });
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong. The system is still running.' } });
  });

  let pending: NodeJS.Timeout | null = null;
  const allocateSoon = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      try {
        hub.matchEpoch('New requests');
      } catch {
        hub.log.write('error', 'deferred_allocation_failed');
      }
    }, 300);
    pending.unref();
  };

  const body = <T = any>(req: { body: unknown }) => (req.body ?? {}) as T;

  // Field
  app.post('/api/field/request', async (req) => {
    const out = hub.request(body(req));
    allocateSoon();
    return out;
  });
  app.get('/api/field/rider/:pid', async (req) => hub.riderView((req.params as { pid: string }).pid));
  app.post('/api/field/answer', async (req) => {
    const b = body(req);
    return hub.answerClarification(b.pid, Number(b.clarificationId), b.value);
  });
  app.post('/api/field/cancel', async (req) => {
    const b = body(req);
    return hub.cancel(b.opId, b.pid);
  });
  app.post('/api/field/claim', async (req) => hub.claim(body(req)));
  app.post('/api/field/quote', async (req) => hub.submitQuote(body(req)));
  app.post('/api/field/book', async (req) => hub.book(body(req)));
  app.post('/api/field/paid', async (req) => {
    const b = body(req);
    return hub.markPaid(b.opId, b.pid, b.podId);
  });
  app.post('/api/field/check', async (req) => hub.checkQuote(body(req)));
  app.post('/api/field/bids', async (req) => hub.requestBids(body(req).podId));
  app.post('/api/field/accept', async (req) => hub.acceptBid(body(req)));
  app.post('/api/field/lock', async (req) => hub.lockShare(body(req)));
  app.post('/api/field/complaint', async (req) => hub.complaintDraft(body(req)));
  app.get('/api/field/surge/:spot', async (req) => hub.surgeForecast((req.params as { spot: string }).spot));
  app.get('/api/field/ping', async () => ({ ok: true }));
  app.get('/api/field/offline-pack', async () => hub.offlinePack());
  app.get('/api/field/group/:podId', async (req) => {
    const q = req.query as { device?: string };
    return hub.deviceSnapshot((req.params as { podId: string }).podId, q.device ?? 'unknown');
  });
  app.post('/api/field/escrow', async (req) => hub.grantEscrow(body(req)));
  app.post('/api/field/sync', async (req) => {
    const b = body(req);
    return hub.sync(String(b.device ?? 'unknown'), b.ops);
  });

  // Operations
  app.get('/api/health', async () => ({ ok: true, offline: hub.offline, clock: hub.now }));
  app.get('/api/world', async () => ({ nodes: NODES, edges: EDGES, spots: SPOTS, destinations: DESTINATIONS }));
  app.get('/api/state', async () => hub.state());
  app.get('/api/cohorts', async () => hub.cohorts());
  app.post('/api/reset', async (req) => {
    const b = body(req);
    hub.reset(Number(b.seed ?? 842), Number(b.riders ?? 1200));
    outside.shape = 'v1';
    arena.last.clear();
    return hub.state();
  });
  app.post('/api/clock/advance', async (req) => hub.advance(Number(body(req).minutes)));
  app.post('/api/match', async () => hub.matchEpoch('Operator request', 'operator'));
  app.get('/api/decisions', async (req) => {
    const q = req.query as { outcome?: string; limit?: string };
    return hub.decisions(q.outcome ?? null, Math.min(Number(q.limit ?? 100), 1000));
  });
  app.get('/api/epochs/latest', async () => hub.latestEpoch());
  app.get('/api/ledger', async (req) => {
    const q = req.query as { after?: string; limit?: string };
    return hub.ledger(Number(q.after ?? 0), Math.min(Number(q.limit ?? 200), 2000));
  });
  app.get('/api/ledger/verify', async () => verifyChain(hub.ledger(0, 10_000_000)));
  app.get('/api/ledger/head', async () => hub.state().ledgerHead);
  app.get('/api/proof/:pid', async (req) => hub.proof((req.params as { pid: string }).pid));
  app.get('/api/policy', async () => ({
    active: hub.policy(),
    history: hub.db.prepare('SELECT version, name, hash, activated_at FROM policies ORDER BY version').all(),
  }));
  app.post('/api/policy', async (req) => {
    const b = body(req);
    return hub.activatePolicy(b.doc, { dryRun: b.dryRun === true, by: b.by });
  });
  app.get('/api/approvals', async () => hub.approvals());
  app.post('/api/approvals/:id', async (req) => {
    const b = body(req);
    return hub.decideApproval(Number((req.params as { id: string }).id), b.decision, b.by);
  });
  app.post('/api/ingest/riders', async (req) => {
    const report = hub.ingestRiders(String(req.body ?? ''));
    allocateSoon();
    return report;
  });
  app.get('/api/quarantine', async () => hub.quarantine());
  app.post('/api/ingest/route-records', async (req) => {
    const b = body(req);
    if (!Array.isArray(b.records)) throw new HubError('BAD_RECORDS', 'Send { "records": [...] }');
    return hub.ingestRouteRecords(b.records);
  });
  app.get('/api/beliefs', async () => ({ beliefs: hub.beliefs(), verifications: hub.verifications() }));
  app.post('/api/verifications/:id', async (req) => {
    const b = body(req);
    return hub.answerVerification(Number((req.params as { id: string }).id), b.answer, String(b.by ?? 'unknown'));
  });
  app.post('/api/ingest/telemetry', async (req) => {
    const b = body(req);
    if (!Array.isArray(b.readings)) throw new HubError('BAD_READINGS', 'Send { "readings": [...] }');
    return hub.ingestTelemetry(b.readings);
  });
  app.get('/api/sensors', async () => hub.sensorReports());
  app.post('/api/feed/poll', async () => hub.pollFeed());
  app.get('/api/feed', async () => hub.feedState());
  app.post('/api/feed/adapters/:version/approve', async (req) => hub.approveAdapter((req.params as { version: string }).version, body(req).by));
  app.get('/api/fare-rule', async () => hub.fareRule('MINI'));
  app.post('/api/fare-rule', async (req) => hub.setFareRule(body(req)));
  app.get('/api/egress', async () => hub.db.prepare('SELECT at, dest, decision, reason, bytes FROM egress_log ORDER BY id DESC LIMIT 200').all());
  app.get('/api/i18n', async () => hub.packs().map((pack) => ({ pack, coverage: coverage(pack) })));
  app.post('/api/i18n/pack', async (req) => hub.loadPack(req.body));

  app.post('/api/alerts', async (req) => {
    const b = body(req);
    if (b.kind !== 'RAIN' && b.kind !== 'TRANSIT') throw new HubError('BAD_ALERT', 'kind must be RAIN or TRANSIT');
    hub.setAlert(b.kind, b.on !== false);
    return hub.state().alerts;
  });
  app.post('/api/bridge', async (req) => hub.triggerBridge(String(body(req).node ?? 'GDY').toUpperCase(), 'Rail failure'));
  app.get('/api/surge/backtest', async () => hub.surgeModel().report);
  app.get('/api/evidence/price-gap', async () => hub.priceGapReport());

  // Product demos
  app.get('/api/demo', async () => DEMOS);
  app.post('/api/demo/:id/run', async (req) => {
    const id = (req.params as { id: string }).id;
    if (!DEMOS.some((d) => d.id === id)) throw new HubError('NOT_FOUND', 'No such demo', 404);
    return runDemo(ctx, id);
  });

  // Arena
  app.get('/api/arena', async () => arena.list());
  app.post('/api/arena/run-all', async () => arena.runAll());
  app.post('/api/arena/restore', async () => {
    hub.setOffline(false);
    outside.shape = 'v1';
    return { ok: true };
  });
  app.post('/api/arena/offline', async (req) => {
    hub.setOffline(body(req).on === true);
    return { offline: hub.offline };
  });
  app.post('/api/arena/:card/run', async (req) => {
    const id = (req.params as { card: string }).card.toUpperCase();
    if (!CARDS.some((c) => c.id === id)) throw new HubError('NOT_FOUND', 'No such card', 404);
    const b = body(req);
    return arena.run(id, b.params ?? {}, { fresh: b.stack !== true });
  });

  // Live updates: a small ping tells clients to refetch.
  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    let timer: NodeJS.Timeout | null = null;
    const ping = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        res.write(`event: changed\ndata: ${hub.now}\n\n`);
      }, 200);
    };
    hub.on('changed', ping);
    req.raw.on('close', () => {
      hub.off('changed', ping);
      if (timer) clearTimeout(timer);
    });
  });

  const web = join(process.cwd(), 'dist/web');
  if (existsSync(web)) app.register(fastifyStatic, { root: web });
  else app.get('/', async () => ({ name: 'Koottu hub', ui: 'Not built yet. Run npm run build.' }));

  return { app, arena, ctx };
}
