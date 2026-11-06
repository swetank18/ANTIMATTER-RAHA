import { join } from 'node:path';
import { Hub } from './hub.ts';
import { Outside } from './outside.ts';
import { buildServer } from './server.ts';

const port = Number(process.env.PORT ?? 4100);
// A host that sets PORT sends outside traffic in, so listen on every interface there. On a laptop
// it stays on 127.0.0.1, because operator routes have no login.
const host = process.env.HOST ?? (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
// DATA_DIR points at a persistent volume if the host has one. Without it, data resets on redeploy.
const dataDir = process.env.DATA_DIR ?? 'data';
const hub = new Hub({ file: join(dataDir, 'koottu.db'), keyFile: join(dataDir, 'hub-key.json'), logFile: 'logs/hub.log' });
const outside = new Outside();
const outsideUrl = await outside.start();
hub.egress.allowlist = { 'transit-feed': outsideUrl, analytics: outsideUrl, 'open-network': outsideUrl };

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
