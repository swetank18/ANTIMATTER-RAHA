import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyChain, verifyMerkle } from '../src/core/ledger.ts';
import { verifyPass } from '../src/core/pass.ts';
import { POLICY_V2 } from '../src/core/priority.ts';
import { Hub, HubError } from '../src/hub/hub.ts';

let hub: Hub;
beforeEach(() => {
  hub = new Hub({ riders: 400 });
});
afterEach(() => hub.close());

const anyPass = () => hub.db.prepare(`SELECT pass_token token, pass_id id, pid, pod_id podId FROM seats WHERE state = 'COMMITTED' LIMIT 1`).get() as any;
const { version: _v, ...policyDoc } = POLICY_V2;

describe('world and matching', () => {
  it('is reproducible: same seed, same decisions', () => {
    const other = new Hub({ riders: 400 });
    expect(hub.latestEpoch()!.output_hash).toBe(other.latestEpoch()!.output_hash);
    other.close();
  });

  it('saves riders money and uses fewer cabs', () => {
    const k = hub.state().kpis;
    expect(k.ridersSavedRs).toBeGreaterThan(0);
    expect(k.peoplePerCab).toBeGreaterThan(1.5);
  });

  it('never over-allocates through a long evening', () => {
    for (let i = 0; i < 16; i++) {
      const e = hub.advance(5);
      expect(hub.state().kpis.overAllocated).toBe(0);
      expect(e.certificate.ok).toBe(true);
      expect(e.podChecks.filter((c) => !c.ok)).toEqual([]);
    }
  });

  it('gets everyone moving in the end', () => {
    for (let i = 0; i < 60 && hub.state().kpis.waiting > 0; i++) hub.advance(5);
    const stuck = hub.riders().map((r) => `${r.pid} ${r.spot} ${r.need} ${r.state}`);
    expect(stuck).toEqual([]);
  });

  it('gives each person one seat at most', () => {
    expect(hub.db.prepare(`SELECT pid, COUNT(*) c FROM seats WHERE state IN ('HELD','COMMITTED','BOARDED') GROUP BY pid HAVING c > 1`).all()).toEqual([]);
  });

  it('will not apply a match its checker rejects', () => {
    const before = (hub.db.prepare('SELECT COUNT(*) c FROM epochs').get() as { c: number }).c;
    const original = hub.computePlan.bind(hub);
    hub.computePlan = (...args: Parameters<Hub['computePlan']>) => {
      const p = original(...args);
      p.pools = p.pools.map((x) => ({ ...x, cap: 0 }));
      return p;
    };
    expect(() => hub.matchEpoch('sabotage')).toThrow(HubError);
    hub.computePlan = original;
    expect((hub.db.prepare('SELECT COUNT(*) c FROM epochs').get() as { c: number }).c).toBe(before);
    expect(hub.ledger(0, 100000).some((e) => e.type === 'ALLOCATION_REJECTED')).toBe(true);
  });
});

describe('fare check', () => {
  it('will not judge legality without a verified base fare', () => {
    expect(hub.checkQuote({ spot: 'GDY-E', dest: 'MAA', app: 'Uber', amount: 5000 }).check.status).toBe('NO_VERIFIED_BASE_FARE');
  });

  it('flags an over-cap quote once a verified rule exists', () => {
    hub.setFareRule({ vehicle: 'MINI', baseFare: 50, perKm: 18, capMultiplier: 2, floorMultiplier: 0.5, verified: true, source: 'Test rule' });
    expect(hub.checkQuote({ spot: 'GDY-E', dest: 'MAA', app: 'Uber', amount: 5000 }).check.status).toBe('OVER_CAP');
  });

  it('offers options from saved fares', () => {
    expect(hub.checkQuote({ spot: 'GDY-E', dest: 'MAA', app: 'Uber', amount: 900 }).advice.length).toBeGreaterThan(0);
  });
});

describe('the group journey', () => {
  const locked = () => hub.pods(`state = 'LOCKED'`).find((p) => (hub.db.prepare(`SELECT COUNT(*) c FROM seats WHERE pod_id = ? AND state = 'COMMITTED'`).get(p.id) as { c: number }).c >= 2)!;
  const members = (podId: string) => (hub.db.prepare(`SELECT pid FROM seats WHERE pod_id = ? AND state = 'COMMITTED'`).all(podId) as { pid: string }[]).map((m) => m.pid);

  it('the cheapest phone books, and the split still adds up', () => {
    const pod = locked();
    const [a, b] = members(pod.id);
    hub.submitQuote({ opId: 'q-0001', pid: a, podId: pod.id, app: 'Uber', amount: pod.fare + 40, device: 'iPhone' });
    const r = hub.submitQuote({ opId: 'q-0002', pid: b, podId: pod.id, app: 'Uber', amount: pod.fare, device: 'Android' });
    expect(r.best!.pid).toBe(b);
    expect(r.gaps.length).toBe(1);
    expect(hub.pod(pod.id)!.lead).toBe(b);
    expect(() => hub.book({ opId: 'b-0001', pid: a, podId: pod.id, app: 'Uber', amount: pod.fare })).toThrow(/lowest fare/);
    const booked = hub.book({ opId: 'b-0002', pid: b, podId: pod.id, app: 'Uber', amount: pod.fare });
    expect(booked.shares.reduce((s: number, x: any) => s + x.share, 0)).toBe(pod.fare);
    hub.markPaid('p-0001', a, pod.id);
    expect(hub.riderView(a).seat!.paid).toBe(true);
  });

  it('only members can quote', () => {
    const pod = locked();
    expect(() => hub.submitQuote({ opId: 'q-0003', pid: 'R-NOBODY', podId: pod.id, app: 'Uber', amount: 100 })).toThrow(/not in this group/);
  });

  it('leaving a group reprices the rest fairly', () => {
    const pod = locked();
    const [a] = members(pod.id);
    hub.cancel('c-0001', a);
    const after = hub.pod(pod.id)!;
    const sum = (hub.db.prepare(`SELECT COALESCE(SUM(share), 0) s FROM seats WHERE pod_id = ? AND state = 'COMMITTED'`).get(pod.id) as { s: number }).s;
    expect(sum).toBe(after.fare);
  });
});

describe('ledger and proofs', () => {
  it('keeps an intact chain and blocks edits', () => {
    hub.advance(5);
    expect(verifyChain(hub.ledger(0, 100000)).ok).toBe(true);
    expect(() => hub.db.prepare(`UPDATE ledger SET actor = 'x' WHERE seq = 1`).run()).toThrow(/append-only/);
    expect(() => hub.db.prepare('DELETE FROM ledger WHERE seq = 1').run()).toThrow(/append-only/);
  });

  it('gives each rider a verifiable inclusion proof', () => {
    const p = hub.proof(anyPass().pid);
    expect(verifyMerkle(p.leaf, p.proof, p.root)).toBe(true);
  });
});

describe('field operations', () => {
  it('signs passes the phone can verify', () => {
    expect(verifyPass(anyPass().token, hub.publicKeys).ok).toBe(true);
  });

  it('treats a retried request as one person', () => {
    const body = { opId: 'op-12345', spot: 'GDY-E', dest: 'MAA', shareWith: 'ANYONE' as const };
    expect(hub.request(body).pid).toBe(hub.request(body).pid);
  });

  it('refuses to reuse an opId for something else', () => {
    hub.request({ opId: 'op-12345', spot: 'GDY-E', dest: 'MAA' });
    expect(() => hub.request({ opId: 'op-12345', spot: 'GDY-E', dest: 'TBM' })).toThrow(/different request/);
  });

  it('validates a request', () => {
    expect(() => hub.request({ opId: 'op-00001', spot: 'GDY-E', dest: 'ATLANTIS' })).toThrow(HubError);
    expect(() => hub.request({ opId: 'op-00002', spot: 'NOWHERE', dest: 'MAA' })).toThrow(HubError);
    expect(() => hub.request({ opId: 'op-00003', spot: 'GDY-E', dest: 'MAA', party: 0 })).toThrow(HubError);
    expect(() => hub.request({ opId: 'x', spot: 'GDY-E', dest: 'MAA' })).toThrow(/opId/);
  });

  it('applies a boarding once and reports the repeat', () => {
    const p = anyPass();
    const op = { opId: 'dev:1', kind: 'BOARD' as const, podId: p.podId, passId: p.id, pid: p.pid, party: 1, at: 0 };
    expect(hub.sync('dev', [op]).results[0].status).toBe('APPLIED');
    expect(hub.sync('dev', [op]).results[0].status).toBe('DUPLICATE');
    expect(hub.sync('other', [{ ...op, opId: 'other:1' }]).results[0].status).toBe('CONFLICT');
  });

  it('never grants more escrow than the cab can hold', () => {
    const pod = hub.pods(`state = 'LOCKED'`)[0];
    expect(() => hub.grantEscrow({ opId: 'esc-0001', podId: pod.id, device: 'A', seats: 6 })).toThrow(/free seats/);
  });
});

describe('missing information', () => {
  it('escalates an unanswered question', () => {
    hub.request({ opId: 'partner-01', spot: 'GDY-E', dest: 'MAS', shareWith: 'ANYONE', maxDetourMin: 20, maxWaitMin: 30 });
    const { pid } = hub.request({ opId: 'unsure-001', spot: 'GDY-E', dest: 'MAS', maxDetourMin: 20, maxWaitMin: 30 });
    hub.matchEpoch('test');
    expect(hub.riderView(pid).clarification).not.toBeNull();
    expect(hub.riderView(pid).pass).toBeNull();
    hub.advance(6);
    expect(hub.clarifications(pid)[0].state).toBe('ESCALATED');
  });

  it('does not ask when no answer would change anything', () => {
    const { pid } = hub.request({ opId: 'lonely-001', spot: 'GDY-E', dest: 'PML', maxDetourMin: 0, maxWaitMin: 0, circle: 'NOBODY-ELSE' });
    hub.matchEpoch('test');
    expect(hub.riderView(pid).clarification).toBeNull();
  });
});

describe('policy', () => {
  it('validates a policy before use', () => expect(() => hub.activatePolicy({ name: 'x' })).toThrow(HubError));

  it('a dry run changes nothing', () => {
    const v = hub.policy().version;
    expect(hub.activatePolicy(policyDoc, { dryRun: true }).applied).toBe(false);
    expect(hub.policy().version).toBe(v);
  });

  it('needs a named person for an approval', () => {
    const res = hub.activatePolicy(policyDoc);
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
    expect(files.filter((f) => !f.endsWith('egress.ts') && banned.test(readFileSync(f, 'utf8')))).toEqual([]);
  });

  it('keeps the core free of Node and database imports', () => {
    for (const f of readdirSync('src/core')) expect(readFileSync(join('src/core', f), 'utf8')).not.toMatch(/from 'node:|better-sqlite3|fastify/);
  });

  it('has no column for identity in the riders table', () => {
    const cols = (hub.db.prepare('PRAGMA table_info(riders)').all() as { name: string }[]).map((c) => c.name);
    for (const banned of ['name', 'phone', 'email', 'address', 'upi']) expect(cols).not.toContain(banned);
  });
});
