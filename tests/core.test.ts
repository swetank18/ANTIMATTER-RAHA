import { describe, expect, it } from 'vitest';
import { adapt, MAPPING_V1, proposeMapping } from '../src/core/contract.ts';
import { newFieldSnapshot, scan, walkup } from '../src/core/field.ts';
import { coverage, pseudoPack, STRINGS, translate } from '../src/core/i18n.ts';
import { GENESIS, entryHash, leafHash, merkleProof, merkleRoot, verifyChain, verifyMerkle } from '../src/core/ledger.ts';
import { newKeyPair, signToken, verifyPass } from '../src/core/pass.ts';
import { compare, POLICY_V1, prioritise, validatePolicy } from '../src/core/priority.ts';
import { assess, hampel } from '../src/core/sensors.ts';
import { naiveNewestArrival, resolveRoute } from '../src/core/truth.ts';
import type { PassPayload, Rider, RouteRecord } from '../src/core/types.ts';
import { checkBatch, parseCsv, parseJsonTolerant, safeExcerpt } from '../src/core/validate.ts';
import { dbscan, shortest } from '../src/core/world.ts';

const person = (o: Partial<Rider> = {}): Rider => ({
  pid: 'P-1', circle: 'X', spot: 'GDY-E', dest: 'MAA', need: 'NONE', party: 1, shareWith: 'ANYONE', deadlineKind: 'NONE', deadlineAt: null, deadlineVerified: false,
  checkinAt: 0, maxWaitMin: 15, maxDetourMin: 12, soloFare: 300, state: 'WAITING', displaced: false, ...o,
});

describe('priority', () => {
  it('always shows parts that add up to the total', () => {
    const p = prioritise(person({ need: 'WHEELCHAIR', deadlineKind: 'FLIGHT', deadlineAt: 40, deadlineVerified: true, checkinAt: -33, displaced: true }), 0, POLICY_V1, 's');
    expect(p.parts.length).toBe(4);
    expect(p.score).toBeCloseTo(p.parts.reduce((s, x) => s + x.points, 0), 5);
  });

  it('never lets priority fall as someone keeps waiting', () => {
    let last = -1;
    for (let t = 0; t < 600; t += 7) {
      const s = prioritise(person(), t, POLICY_V1, 's').score;
      expect(s).toBeGreaterThanOrEqual(last);
      last = s;
    }
  });

  it('breaks ties with the lottery, not arrival order', () => {
    const a = prioritise(person({ pid: 'A' }), 0, POLICY_V1, 'seed');
    const b = prioritise(person({ pid: 'B' }), 0, POLICY_V1, 'seed');
    expect(compare(a, b)).not.toBe(0);
    expect(prioritise(person({ pid: 'A' }), 0, POLICY_V1, 'seed').lottery).toBe(a.lottery);
  });

  it('refuses a policy under which someone could wait forever', () => {
    const bad = { ...POLICY_V1, weights: { ...POLICY_V1.weights, waitPerMin: 0 } };
    expect(validatePolicy(bad).ok).toBe(false);
  });
});

describe('passes', () => {
  const keys = newKeyPair();
  const pk = { hub: keys.publicHex };
  const payload: PassPayload = { v: 1, k: 'hub', p: 'P-1', r: 'R1', u: 'S', n: 2, nb: -30, ex: 30, id: 'abc' };
  const token = signToken(payload, keys.secretHex);

  it('verifies with only the public key', () => {
    const r = verifyPass(token, pk);
    expect(r.ok && r.payload.p).toBe('P-1');
  });

  it('rejects a tampered pass', () => {
    const [a, , c] = token.split('.');
    const forged = `${a}.${Buffer.from(JSON.stringify({ ...payload, n: 9 })).toString('base64url')}.${c}`;
    expect(verifyPass(forged, pk)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('rejects a pass signed by anyone else', () => {
    expect(verifyPass(signToken(payload, newKeyPair().secretHex), pk).ok).toBe(false);
  });

  it('survives garbage without throwing', () => {
    for (const g of ['', 'x', 'OS1.a.b', 'OS1.!!!.???', 'a.b.c.d']) expect(verifyPass(g, pk).ok).toBe(false);
  });

  it('handles boarding rules on the handheld with no network', () => {
    const s = newFieldSnapshot('D1', 'R1', pk, null);
    expect(scan(s, token, 0).ok).toBe(true);
    expect(scan(s, token, 0)).toMatchObject({ ok: false, code: 'ALREADY_USED' });
    const other = newFieldSnapshot('D2', 'R2', pk, null);
    expect(scan(other, token, 0)).toMatchObject({ ok: false, code: 'WRONG_RIDE' });
    expect(scan(newFieldSnapshot('D3', 'R1', pk, null), token, 99)).toMatchObject({ ok: false, code: 'EXPIRED' });
  });

  it('never lets walk-ups exceed the signed grant', () => {
    const grant = signToken({ v: 1, k: 'hub', g: 'g1', r: 'R1', d: 'D1', n: 2 }, keys.secretHex, 'OSG');
    const s = newFieldSnapshot('D1', 'R1', pk, grant);
    expect(walkup(s, 1, 0).ok).toBe(true);
    expect(walkup(s, 2, 0).ok).toBe(false);
    expect(walkup(s, 1, 0).ok).toBe(true);
    expect(walkup(s, 1, 0).ok).toBe(false);
    const wrong = newFieldSnapshot('OTHER', 'R1', pk, grant);
    expect(walkup(wrong, 1, 0).ok).toBe(false);
  });
});

describe('ledger', () => {
  const build = () => {
    const out = [];
    let prev = GENESIS;
    for (let seq = 1; seq <= 5; seq++) {
      const e = { seq, at: seq, type: 'X', actor: 'a', payload: { n: seq }, prev };
      const hash = entryHash(e);
      out.push({ ...e, hash });
      prev = hash;
    }
    return out;
  };

  it('accepts an untouched chain', () => {
    expect(verifyChain(build())).toEqual({ ok: true, checked: 5, brokenAt: null });
  });

  const attacks: [string, (c: ReturnType<typeof build>) => void, number][] = [
    ['rewritten payload', (c) => { c[2].payload = { n: 99 }; }, 3],
    ['changed actor', (c) => { c[1].actor = 'attacker'; }, 2],
    ['changed type', (c) => { c[3].type = 'NOTHING_HAPPENED'; }, 4],
    ['changed time', (c) => { c[0].at = 999; }, 1],
    ['changed hash', (c) => { c[2].hash = 'f'.repeat(64); }, 3],
    ['deleted middle entry', (c) => { c.splice(2, 1); }, 3],
    ['deleted first entry', (c) => { c.shift(); }, 1],
    ['swapped entries', (c) => { [c[1], c[2]] = [c[2], c[1]]; }, 2],
  ];
  for (const [name, attack, at] of attacks) {
    it(`detects a ${name}`, () => {
      const chain = build();
      attack(chain);
      expect(verifyChain(chain)).toMatchObject({ ok: false, brokenAt: at });
    });
  }

  it('cannot see its newest entries being cut off without an anchor', () => {
    const chain = build();
    const head = chain[4];
    chain.pop();
    expect(verifyChain(chain).ok).toBe(true);
    expect(verifyChain(chain, { seq: head.seq, hash: head.hash })).toMatchObject({ ok: false, brokenAt: 5 });
  });

  it('accepts a chain that has grown past an old anchor', () => {
    const chain = build();
    expect(verifyChain(chain, { seq: 3, hash: chain[2].hash }).ok).toBe(true);
    expect(verifyChain(chain, { seq: 3, hash: 'a'.repeat(64) }).ok).toBe(false);
  });

  it('proves one decision without revealing the others', () => {
    const leaves = Array.from({ length: 11 }, (_, i) => leafHash({ i }));
    const root = merkleRoot(leaves);
    leaves.forEach((l, i) => expect(verifyMerkle(l, merkleProof(leaves, i), root)).toBe(true));
    expect(verifyMerkle(leafHash({ i: 99 }), merkleProof(leaves, 0), root)).toBe(false);
  });
});

describe('truth', () => {
  const rec = (source: string, value: string, observedAt: number, receivedAt = 100): RouteRecord => ({ route: 'R', field: 'status', value, source, observedAt, receivedAt });

  it('is not fooled by a stale record that arrives last', () => {
    const list = [rec('CONTROL_ROOM', 'SUSPENDED', 95, 96), rec('OPERATOR_FEED', 'RUNNING', 60, 100)];
    expect(naiveNewestArrival('R', list)).toBe('RUNNING');
    expect(resolveRoute('R', list, 100)).toMatchObject({ state: 'TRUSTED', value: 'SUSPENDED' });
  });

  it('keeps a real conflict unresolved and closed', () => {
    const b = resolveRoute('R', [rec('FIELD_MARSHAL', 'RUNNING', 98), rec('CONTROL_ROOM', 'SUSPENDED', 98)], 100);
    expect(b).toMatchObject({ state: 'UNRESOLVED', value: null, safeValue: 'SUSPENDED' });
  });

  it('does not let weak sources outvote a credible closure', () => {
    const b = resolveRoute('R', [rec('CONTROL_ROOM', 'RUNNING', 99), rec('CROWD', 'SUSPENDED', 99)], 100);
    expect(b.state).toBe('TRUSTED');
    const close = resolveRoute('R', [rec('OPERATOR_FEED', 'RUNNING', 99), rec('CONTROL_ROOM', 'SUSPENDED', 90)], 100);
    expect(close.safeValue).toBe('SUSPENDED');
  });

  it('treats all-stale data as unknown, and ignores future timestamps', () => {
    expect(resolveRoute('R', [rec('CONTROL_ROOM', 'RUNNING', 10)], 100).state).toBe('UNKNOWN');
    expect(resolveRoute('R', [rec('CONTROL_ROOM', 'RUNNING', 500)], 100).state).toBe('UNKNOWN');
  });

  it('never trusts an unknown source', () => {
    expect(resolveRoute('R', [rec('RANDOM_BLOG', 'RUNNING', 99)], 100).state).toBe('UNKNOWN');
  });
});

describe('sensors', () => {
  const ctx = { capacity: 45, manifest: 0, now: 100 };
  const r = (i: number, o = {}) => ({ vehicleId: 'V', observedAt: i, receivedAt: i, lat: 13 + i * 0.005, lng: 80, odoKm: 10 + i * 0.6, occupancy: null, ...o });

  it('leaves a healthy vehicle alone', () => {
    expect(assess('V', [0, 1, 2, 3, 4, 5].map((i) => r(i)), ctx).verdict).toBe('HEALTHY');
  });

  it('tells a frozen GPS from a real stop using the odometer', () => {
    const frozen = [0, 1, 2, 3, 4, 5].map((i) => r(i, { lat: 13, lng: 80 }));
    expect(assess('V', frozen, ctx).verdict).toBe('SENSOR_FAULT');
    const stopped = [0, 1, 2, 3, 4, 5].map((i) => r(i, { lat: 13 + (i % 2) * 0.00002, lng: 80, odoKm: 10 }));
    expect(assess('V', stopped, ctx).verdict).toBe('GENUINE_STOP');
  });

  it('never acts automatically', () => {
    const jump = [0, 1, 2, 3].map((i) => r(i));
    jump[2] = r(2, { lat: 14 });
    const rep = assess('V', jump, ctx);
    expect(rep.verdict).toBe('SENSOR_FAULT');
    expect(rep.autoAction).toBe(false);
  });

  it('finds an outlier with the Hampel filter', () => {
    expect(hampel([10, 11, 10, 12, 11, 90, 10])).toEqual([false, false, false, false, false, true, false]);
  });
});

describe('contract adapter', () => {
  const v1 = { routes: [{ route_id: 'A-B', status: 'running', updated_at: '2026-11-06T03:00:00Z' }] };
  const v2 = { data: { items: [
    { routeInfo: { routeId: 'A-B' }, currentState: { status: 'delayed', crowding: 'high' }, lastUpdated: 1793934000000 },
    { routeInfo: { routeId: 'C-D' }, currentState: { status: 'running', crowding: 'low' }, lastUpdated: 1793934060000 },
  ] } };

  it('reads the original shape', () => {
    expect(adapt(v1, MAPPING_V1).records[0]).toMatchObject({ route: 'A-B', status: 'RUNNING' });
  });

  it('fails on the changed shape instead of guessing', () => {
    expect(adapt(v2, MAPPING_V1).ok).toBe(false);
  });

  it('proposes a working mapping as data', () => {
    const p = proposeMapping(v2, 'v2')!;
    expect(p.complete).toBe(true);
    const res = adapt(v2, p.mapping);
    expect(res.ok).toBe(true);
    expect(res.records[0].route).toBe('A-B');
    expect(res.records[0].status).toBe('DELAYED');
    expect(res.unknownFields).toContain('currentState.crowding');
  });

  it('accepts a field that became optional, and only when marked so', () => {
    const partial = { data: { items: [
      { routeInfo: { routeId: 'A-B' }, currentState: { status: 'running' }, lastUpdated: 1793934000000 },
      { routeInfo: { routeId: 'C-D' }, currentState: { status: 'delayed' } },
    ] } };
    const p = proposeMapping(partial, 'v2')!;
    expect(p.mapping.fields.observedAtIso.optional).toBe(true);
    const res = adapt(partial, p.mapping);
    expect(res.records.length).toBe(2);
    expect(res.records[1].observedAtIso).toBeNull();
    const strict = { ...p.mapping, fields: { ...p.mapping.fields, observedAtIso: { ...p.mapping.fields.observedAtIso, optional: false } } };
    expect(adapt(partial, strict).records.length).toBe(1);
  });

  it('rejects one bad record without losing the good ones', () => {
    const mixed = { routes: [{ route_id: 'A-B', status: 'running', updated_at: '2026-11-06T03:00:00Z' }, { route_id: 'C-D', status: 'on fire', updated_at: '2026-11-06T03:00:00Z' }] };
    const res = adapt(mixed, MAPPING_V1);
    expect(res.ok).toBe(true);
    expect(res.records.length).toBe(1);
    expect(res.errors.length).toBe(1);
  });

  it('does not propose a mapping from nonsense', () => {
    const p = proposeMapping({ a: [{ b: 1 }] }, 'v9');
    expect(p === null || !p.complete).toBe(true);
  });

  it('cannot be tricked through the prototype chain', () => {
    const m = { ...MAPPING_V1, recordsAt: '__proto__' };
    expect(adapt({ routes: [] }, m).ok).toBe(false);
  });
});

describe('input validation', () => {
  const stops = new Set(['MAA', 'TBM']);

  it('handles quotes, commas and newlines in CSV', () => {
    const rows = parseCsv('a,b\n"x,1","y\nz"\n');
    expect(rows[0].raw).toEqual({ a: 'x,1', b: 'y\nz' });
  });

  it('recovers valid records from broken JSON', () => {
    const rows = parseJsonTolerant('[{"a":1},{"a":2},{"a":');
    expect(rows.filter((r) => !r.parseError).length).toBe(2);
    expect(rows.filter((r) => r.parseError).length).toBe(1);
  });

  it('does not coerce values into something plausible', () => {
    const csv = 'rider_id,destination,need,party\nA,MAA,NONE,12 people\nB,MAA,NONE,1.5\nC,MAA,NONE,0\nD,MAA,NONE,-1\nE,MAA,NONE,2\n';
    const r = checkBatch(csv, stops);
    expect(r.accepted.map((x) => x.externalId)).toEqual(['E']);
    expect(r.quarantined.length).toBe(4);
  });

  it('rejects impossible dates that JavaScript would quietly roll over', () => {
    const csv = 'rider_id,destination,need,deadline_kind,deadline_at\nA,MAA,NONE,FLIGHT,2026-02-31T10:00:00+05:30\nB,MAA,NONE,FLIGHT,2026-02-28T10:00:00+05:30\n';
    expect(checkBatch(csv, stops).accepted.map((x) => x.externalId)).toEqual(['B']);
  });

  it('keeps identity data out of quarantine excerpts', () => {
    const e = safeExcerpt({ name: 'Secret Person', phone: '9876543210', destination: 'call 9876543210', need: 'x' });
    expect(e).not.toContain('Secret');
    expect(e).not.toContain('9876543210');
    expect(safeExcerpt('Secret Person,9876543210')).not.toContain('Secret');
  });

  it('survives a hostile batch without throwing', () => {
    for (const s of ['', '\0\0', '{', '[', '"', ',,,', 'a'.repeat(5000), '{"__proto__":{"x":1}}', '[[[[[']) {
      expect(() => checkBatch(s, stops)).not.toThrow();
    }
  });
});

describe('language rules', () => {
  const pack = { code: 'ta', name: 'Tamil', strings: { 'nav.ride': 'tamil', 'pod.show': 'guess' }, glossary: {} };

  it('never shows an unverified critical translation', () => {
    expect(translate('pod.show', pack)).toMatchObject({ lang: 'en', criticalUnverified: true });
  });

  it('uses a verified term', () => {
    const p = { ...pack, glossary: { 'pod.show': { text: 'verified', verifiedBy: 'Organiser' } } };
    expect(translate('pod.show', p)).toMatchObject({ text: 'verified', lang: 'ta' });
  });

  it('falls back on non-critical text', () => {
    expect(translate('nav.settings', pack)).toMatchObject({ lang: 'en', fallback: true });
  });

  it('reports coverage honestly', () => {
    const c = coverage(pack);
    expect(c.criticalVerified).toBe(0);
    expect(c.missingCritical.length).toBe(Object.values(STRINGS).filter((s) => s.critical).length);
  });

  it('stretches layout text by at least 40%', () => {
    for (const k of Object.keys(STRINGS)) expect(translate(k, pseudoPack()).text.length).toBeGreaterThanOrEqual(STRINGS[k].en.length * 1.4);
  });
});

describe('routing and clustering', () => {
  it('routes around a closure', () => {
    const open = shortest('GDY', 'VLC', new Set())!;
    const closed = shortest('GDY', 'VLC', new Set(['GDY-VLC']))!;
    expect(open.path).toEqual(['GDY', 'VLC']);
    expect(closed.min).toBeGreaterThan(open.min);
  });

  it('returns null when nothing connects', () => {
    expect(shortest('GDY', 'SRM', new Set(['TBM-SRM']))).toBeNull();
  });

  it('separates dense groups and marks noise', () => {
    const pts = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, lat: 13 + i * 0.0001, lng: 80 })),
      ...Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, lat: 13.5 + i * 0.0001, lng: 80.5 })),
      { id: 'lonely', lat: 12, lng: 79 },
    ];
    const { labels, clusters } = dbscan(pts, 0.5, 3);
    expect(clusters).toBe(2);
    expect(labels[12]).toBe(-1);
  });
});
