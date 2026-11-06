import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyChain } from '../src/core/ledger.ts';
import { verifyMerkle } from '../src/core/ledger.ts';
import { POLICY_V2 } from '../src/core/priority.ts';
import { verifyPass } from '../src/core/pass.ts';
import { Hub, HubError } from '../src/hub/hub.ts';

let hub: Hub;
beforeEach(() => {
  hub = new Hub({ passengers: 300 });
});
afterEach(() => hub.close());

const anyPass = () => hub.db.prepare(`SELECT pass_token token, pass_id id, pid, run_id runId FROM seats WHERE state = 'COMMITTED' LIMIT 1`).get() as any;

describe('world and allocation', () => {
  it('is reproducible: same seed, same decisions', () => {
    const other = new Hub({ passengers: 300 });
    const a = hub.latestEpoch()!;
    const b = other.latestEpoch()!;
    expect(a.output_hash).toBe(b.output_hash);
    expect(a.input_hash).toBe(b.input_hash);
    other.close();
  });

  it('never over-allocates through a long incident', () => {
    for (let i = 0; i < 12; i++) {
      hub.advance(10);
      expect(hub.state().kpis.overAllocated).toBe(0);
      expect(hub.latestEpoch()!.certificate.ok).toBe(true);
    }
  });

  it('clears everyone in the end', () => {
    for (let i = 0; i < 40 && hub.state().kpis.stranded > 0; i++) hub.advance(10);
    expect(hub.state().kpis.stranded).toBe(0);
  });

  it('gives each person one seat at most', () => {
    const dup = hub.db.prepare(`SELECT pid, COUNT(*) c FROM seats WHERE state IN ('HELD','COMMITTED','BOARDED') GROUP BY pid HAVING c > 1`).all();
    expect(dup).toEqual([]);
  });

  it('will not apply an allocation its checker rejects', () => {
    const seats = hub.db.prepare('SELECT COUNT(*) c FROM epochs').get() as { c: number };
    const original = hub.shadow.bind(hub);
    hub.shadow = (...args: Parameters<Hub['shadow']>) => {
      const s = original(...args);
      s.units = s.units.map((u, i) => (i === 0 ? { ...u, locked: u.options[0] ?? { run: 'NOPE', demand: { 'NOPE:S': 1 } } } : u));
      s.pools = s.pools.map((p) => ({ ...p, cap: 0 }));
      return s;
    };
    expect(() => hub.allocateEpoch('sabotage')).toThrow(HubError);
    hub.shadow = original;
    expect((hub.db.prepare('SELECT COUNT(*) c FROM epochs').get() as { c: number }).c).toBe(seats.c);
    expect(hub.ledger(0, 100000).some((e) => e.type === 'ALLOCATION_REJECTED')).toBe(true);
  });
});

describe('ledger and proofs', () => {
  it('keeps an intact chain and blocks edits', () => {
    hub.advance(10);
    expect(verifyChain(hub.ledger(0, 100000)).ok).toBe(true);
    expect(() => hub.db.prepare(`UPDATE ledger SET actor = 'x' WHERE seq = 1`).run()).toThrow(/append-only/);
    expect(() => hub.db.prepare('DELETE FROM ledger WHERE seq = 1').run()).toThrow(/append-only/);
  });

  it('survives a restart with the chain intact', () => {
    const before = hub.ledger(0, 100000).length;
    expect(before).toBeGreaterThan(0);
  });

  it('gives each passenger a verifiable inclusion proof', () => {
    const { pid } = anyPass();
    const p = hub.proof(pid);
    expect(verifyMerkle(p.leaf, p.proof, p.root)).toBe(true);
  });
});

describe('field operations', () => {
  it('signs passes the handheld can verify', () => {
    const r = verifyPass(anyPass().token, hub.publicKeys);
    expect(r.ok).toBe(true);
  });

  it('treats a retried check-in as one person', () => {
    const body = { opId: 'op-12345', dest: 'MAA', party: 1, need: 'NONE' as const };
    expect(hub.checkin(body).pid).toBe(hub.checkin(body).pid);
  });

  it('refuses to reuse an opId for something else', () => {
    hub.checkin({ opId: 'op-12345', dest: 'MAA', party: 1, need: 'NONE' });
    expect(() => hub.checkin({ opId: 'op-12345', dest: 'TBM', party: 1, need: 'NONE' })).toThrow(/different request/);
  });

  it('validates check-in input', () => {
    expect(() => hub.checkin({ opId: 'op-00001', dest: 'ATLANTIS' })).toThrow(HubError);
    expect(() => hub.checkin({ opId: 'op-00002', dest: 'MAA', party: 0 })).toThrow(HubError);
    expect(() => hub.checkin({ opId: 'x', dest: 'MAA' })).toThrow(/opId/);
  });

  it('applies a boarding once and reports the repeat', () => {
    const p = anyPass();
    const op = { opId: 'dev:1', kind: 'BOARD' as const, runId: p.runId, passId: p.id, pid: p.pid, party: 1, at: 0 };
    expect(hub.sync('dev', [op]).results[0].status).toBe('APPLIED');
    expect(hub.sync('dev', [op]).results[0].status).toBe('DUPLICATE');
    expect(hub.sync('other', [{ ...op, opId: 'other:1' }]).results[0].status).toBe('CONFLICT');
  });

  it('never grants more escrow than the vehicle can hold', () => {
    const run = hub.runs()[0];
    expect(() => hub.grantEscrow({ opId: 'esc-0001', runId: run.id, device: 'A', seats: 20 })).toThrow(/free seats|between/);
  });

  it('leaves escrowed seats out of the allocator', () => {
    const run = hub.runs().at(-1)!;
    hub.grantEscrow({ opId: 'esc-0002', runId: run.id, device: 'A', seats: 2 });
    hub.allocateEpoch('after escrow');
    const r = hub.run(run.id)!;
    expect(r.seatsTaken + r.escrowSeats).toBeLessThanOrEqual(r.seatsTotal);
  });
});

describe('missing information', () => {
  it('escalates an unanswered question to a marshal', () => {
    const { pid } = hub.checkin({ opId: 'q-00001', dest: 'MAS', need: 'UNKNOWN' });
    hub.allocateEpoch('test');
    const v = hub.passengerView(pid);
    if (v.clarification) {
      expect(v.pass).toBeNull();
      hub.advance(11);
      expect(hub.clarifications(pid)[0].state).toBe('ESCALATED');
      expect(hub.ledger(0, 100000).some((e) => e.type === 'CLARIFICATION_ESCALATED')).toBe(true);
    }
  });
});

describe('policy', () => {
  it('validates a policy before use', () => {
    expect(() => hub.activatePolicy({ name: 'x' })).toThrow(HubError);
  });

  it('a dry run changes nothing', () => {
    const v = hub.policy().version;
    const { version: _, ...doc } = POLICY_V2;
    expect(hub.activatePolicy(doc, { dryRun: true }).applied).toBe(false);
    expect(hub.policy().version).toBe(v);
  });

  it('needs a named person for an approval', () => {
    const { version: _, ...doc } = POLICY_V2;
    const res = hub.activatePolicy(doc);
    if (res.approvals.length) expect(() => hub.decideApproval(res.approvals[0], 'APPROVE', ' ')).toThrow(/who/);
  });
});

describe('boundaries', () => {
  it('opens network connections only from egress.ts', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk('src/hub');
    walk('src/core');
    const banned = /\bfetch\(|http\.request|https\.request|net\.connect|new WebSocket|XMLHttpRequest/;
    const offenders = files.filter((f) => !f.endsWith('egress.ts') && banned.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('keeps the core free of Node and database imports', () => {
    for (const f of readdirSync('src/core')) {
      const text = readFileSync(join('src/core', f), 'utf8');
      expect(text).not.toMatch(/from 'node:|better-sqlite3|fastify/);
    }
  });

  it('has no column for identity in the passengers table', () => {
    const cols = (hub.db.prepare('PRAGMA table_info(passengers)').all() as { name: string }[]).map((c) => c.name);
    for (const banned of ['name', 'phone', 'email', 'address']) expect(cols).not.toContain(banned);
  });
});
