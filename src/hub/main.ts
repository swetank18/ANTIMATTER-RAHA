import { Hub } from './hub.ts';
import { Outside } from './outside.ts';
import { buildServer } from './server.ts';

const port = Number(process.env.PORT ?? 4100);
const host = process.env.HOST ?? '127.0.0.1';
const hub = new Hub({ file: 'data/koottu.db', keyFile: 'data/hub-key.json', logFile: 'logs/hub.log' });
const outside = new Outside();
const outsideUrl = await outside.start();
hub.egress.allowlist = { 'transit-feed': outsideUrl, analytics: outsideUrl };

const { app, ctx } = buildServer(hub, outside);
await app.listen({ port, host });
ctx.baseUrl = `http://127.0.0.1:${port}`;

const s = hub.state();
console.log(`Koottu hub on http://${host}:${port}`);
console.log(`${s.kpis.waiting} riders, ${s.kpis.groups} groups, clock ${s.clockLabel}`);

const stop = async () => {
  await app.close();
  await outside.stop();
  hub.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
