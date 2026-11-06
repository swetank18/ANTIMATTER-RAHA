import { Hub } from './hub.ts';
import { Outside } from './outside.ts';
import { buildServer } from './server.ts';

const port = Number(process.env.PORT ?? 4100);
const hub = new Hub({ file: 'data/omnistrand.db', keyFile: 'data/hub-key.json', logFile: 'logs/hub.log' });
const outside = new Outside();
const outsideUrl = await outside.start();
hub.egress.allowlist = { 'transit-feed': outsideUrl, analytics: outsideUrl };

const { app, ctx } = buildServer(hub, outside);
await app.listen({ port, host: '127.0.0.1' });
ctx.baseUrl = `http://127.0.0.1:${port}`;

const s = hub.state();
console.log(`OmniStrand hub on ${ctx.baseUrl}`);
console.log(`${s.kpis.stranded} people stranded, ${s.kpis.fleetActive} vehicles, clock ${s.clockLabel}`);

const stop = async () => {
  await app.close();
  await outside.stop();
  hub.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
