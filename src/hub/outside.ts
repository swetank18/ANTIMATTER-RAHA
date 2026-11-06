// A stand-in for the internet: a separate listener on its own port. It serves the transport
// provider's feed and records everything sent to it, so privacy claims can be measured at the
// socket and not merely asserted. The v2 shape applies every change the card names: fields are
// renamed, moved into nested objects, change type, and one becomes optional.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FeedShape = 'v1' | 'v2' | 'garbage' | 'custom';

export class Outside {
  shape: FeedShape = 'v1';
  custom: string | null = null;
  received: string[] = [];
  routes: { id: string; status: string; atMs: number }[] = [];
  private server: Server | null = null;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          this.received.push(body);
          res.writeHead(204).end();
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(this.feed());
    });
    await new Promise<void>((ok) => this.server!.listen(0, '127.0.0.1', ok));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((ok) => (this.server ? this.server.close(() => ok()) : ok()));
  }

  private feed(): string {
    if (this.shape === 'custom' && this.custom !== null) return this.custom;
    if (this.shape === 'garbage') return '{"oops": <<not json>>';
    if (this.shape === 'v2') {
      return JSON.stringify({
        apiVersion: '2.0',
        data: {
          items: this.routes.map((r, i) => ({
            routeInfo: { routeId: r.id, operator: 'MTC' },
            currentState: { status: r.status.toLowerCase(), crowding: 'high' },
            ...(i === this.routes.length - 1 ? {} : { lastUpdated: r.atMs }),
          })),
        },
      });
    }
    return JSON.stringify({
      routes: this.routes.map((r) => ({ route_id: r.id, status: r.status, updated_at: new Date(r.atMs).toISOString() })),
    });
  }
}
