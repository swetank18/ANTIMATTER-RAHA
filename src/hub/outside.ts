// A stand-in for the internet: a separate listener on its own port. It serves the transport
// provider's feed and records everything sent to it, so privacy claims can be measured at the
// socket and not merely asserted. The v2 shape applies every change the card names: fields are
// renamed, moved into nested objects, change type, and one becomes optional.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hashOf, rng } from '../core/hash.ts';

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
          if (req.url?.startsWith('/beckn/search')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(this.onSearch(body));
            return;
          }
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

  /**
   * A sandbox standing in for drivers on an open mobility network. Drivers here are simulated, and
   * their prices are an assumption: per-km rates with no platform commission and no surge. One
   * driver is deliberately unsuitable, so the filter has something to reject.
   */
  private onSearch(body: string): string {
    let intent: any = {};
    try {
      intent = JSON.parse(body)?.message?.intent ?? {};
    } catch {
      /* an empty intent simply gets no useful bids */
    }
    const km = Number(intent.km) || 8;
    const seats = Number(intent.seats) || 4;
    const r = rng(parseInt(hashOf(body).slice(0, 8), 16));
    const names = ['Selvam', 'Rahim', 'Priya', 'Kumaran', 'Anitha'];
    const count = 3 + Math.floor(r() * 3);
    const providers = Array.from({ length: count }, (_, i) => {
      const small = i === count - 1;
      return {
        id: `DRV-${i + 1}`,
        rating: small ? 3.6 : Math.round((4.2 + r() * 0.7) * 10) / 10,
        descriptor: { name: `${names[i]} (simulated driver)` },
        items: [{
          id: `BID-${hashOf(body).slice(0, 6)}-${i + 1}`,
          price: { currency: 'INR', value: String(Math.round((40 + 15 * km) * (0.9 + r() * 0.3))) },
          fulfillment: { etaMinutes: 3 + Math.floor(r() * 9), vehicle: { category: 'CAB', capacity: small ? Math.max(1, seats - 1) : Math.max(4, seats) } },
        }],
      };
    });
    return JSON.stringify({ context: { action: 'on_search', domain: 'mobility', network: 'sandbox' }, message: { catalog: { providers } } });
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
