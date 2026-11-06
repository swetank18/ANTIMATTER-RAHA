// C03. All knowledge of the external feed's shape lives in one declarative mapping. The rest of
// the system only sees RouteStatus. When the provider changes shape, a new mapping is added as
// data; no application code changes. Mappings cannot execute code, only the listed transforms.

export interface RouteStatus {
  route: string;
  status: 'RUNNING' | 'DELAYED' | 'SUSPENDED';
  /** null when the provider left an optional timestamp out. */
  observedAtIso: string | null;
}

export type Transform = 'identity' | 'isoDate' | 'epochMsToIso' | 'epochSecToIso' | 'toString' | 'upper';

export interface FieldMap {
  path: string;
  transform: Transform;
  values?: Record<string, RouteStatus['status']>;
  /** The provider may leave this out. Only a field marked optional is allowed to be missing. */
  optional?: boolean;
}

export interface Mapping {
  version: string;
  recordsAt: string;
  fields: { route: FieldMap; status: FieldMap; observedAtIso: FieldMap };
}

export const MAPPING_V1: Mapping = {
  version: 'v1',
  recordsAt: 'routes',
  fields: {
    route: { path: 'route_id', transform: 'identity' },
    status: { path: 'status', transform: 'upper' },
    observedAtIso: { path: 'updated_at', transform: 'isoDate' },
  },
};

const STATUSES = new Set(['RUNNING', 'DELAYED', 'SUSPENDED']);

export function getPath(obj: unknown, path: string): unknown {
  if (path === '' || path === '$') return obj;
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function transform(value: unknown, t: Transform): unknown {
  switch (t) {
    case 'identity':
      return value;
    case 'toString':
      return typeof value === 'number' || typeof value === 'string' ? String(value) : undefined;
    case 'upper':
      return typeof value === 'string' ? value.trim().toUpperCase() : undefined;
    case 'isoDate': {
      if (typeof value !== 'string') return undefined;
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
    }
    case 'epochMsToIso':
    case 'epochSecToIso': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      const d = new Date(t === 'epochMsToIso' ? value : value * 1000);
      return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
    }
  }
}

export interface AdaptResult {
  ok: boolean;
  records: RouteStatus[];
  errors: string[];
  unknownFields: string[];
}

export function adapt(raw: unknown, m: Mapping): AdaptResult {
  const list = getPath(raw, m.recordsAt);
  if (!Array.isArray(list)) {
    return { ok: false, records: [], errors: [`Expected a list at "${m.recordsAt}"`], unknownFields: [] };
  }
  const records: RouteStatus[] = [];
  const errors: string[] = [];
  const known = new Set(Object.values(m.fields).map((f) => f.path));
  const unknown = new Set<string>();

  list.forEach((item, i) => {
    for (const path of flatten(item).keys()) if (!known.has(path)) unknown.add(path);
    const route = transform(getPath(item, m.fields.route.path), m.fields.route.transform);
    let status = transform(getPath(item, m.fields.status.path), m.fields.status.transform);
    if (m.fields.status.values && typeof status === 'string') status = m.fields.status.values[status] ?? status;
    const rawTime = getPath(item, m.fields.observedAtIso.path);
    const timeMissing = rawTime === undefined || rawTime === null;
    const observedAtIso = timeMissing && m.fields.observedAtIso.optional ? null : transform(rawTime, m.fields.observedAtIso.transform);
    const problems: string[] = [];
    if (typeof route !== 'string' || !route) problems.push('route is missing');
    if (typeof status !== 'string' || !STATUSES.has(status)) problems.push(`status "${String(status)}" is not recognised`);
    if (observedAtIso !== null && typeof observedAtIso !== 'string') problems.push('timestamp is missing or invalid');
    if (problems.length) errors.push(`Record ${i}: ${problems.join(', ')}`);
    else records.push({ route: route as string, status: status as RouteStatus['status'], observedAtIso: observedAtIso as string | null });
  });

  // One bad record is rejected on its own. The feed only fails if nothing at all could be read.
  return { ok: records.length > 0, records, errors, unknownFields: [...unknown].sort() };
}

function flatten(value: unknown, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out.set(prefix, value);
  }
  return out;
}

function findRecordList(raw: unknown, prefix = ''): { path: string; list: unknown[] } | null {
  if (Array.isArray(raw)) return { path: prefix || '$', list: raw };
  if (raw !== null && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      const hit = findRecordList(v, prefix ? `${prefix}.${k}` : k);
      if (hit && hit.list.length > 0 && typeof hit.list[0] === 'object') return hit;
    }
  }
  return null;
}

const tokens = (s: string) => s.split(/[._\-\s]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean).map((t) => t.toLowerCase());

function nameScore(path: string, words: string[]): number {
  const t = tokens(path);
  const hits = words.filter((w) => t.some((x) => x === w || x.startsWith(w) || w.startsWith(x)));
  return hits.length / words.length;
}

export interface MappingProposal {
  mapping: Mapping;
  confidence: number;
  notes: { field: string; path: string; transform: Transform; confidence: number; why: string }[];
  complete: boolean;
}

/**
 * Proposes a mapping for an unknown response from the field names and value shapes it contains.
 * It is only a proposal: a person approves it before it is used.
 */
export function proposeMapping(raw: unknown, version: string): MappingProposal | null {
  const found = findRecordList(raw);
  if (!found) return null;
  const sample = found.list.slice(0, 50);
  const paths = new Map<string, unknown[]>();
  for (const item of sample) {
    for (const [p, v] of flatten(item)) {
      if (!paths.has(p)) paths.set(p, []);
      paths.get(p)!.push(v);
    }
  }

  const pick = (score: (path: string, values: unknown[]) => number) => {
    let best = { path: '', c: 0 };
    for (const [p, vals] of paths) {
      const c = score(p, vals);
      if (c > best.c || (c === best.c && p < best.path)) best = { path: p, c };
    }
    return best;
  };

  const looksStatus = (v: unknown) => typeof v === 'string' && STATUSES.has(v.trim().toUpperCase());
  const statusBest = pick((p, vals) => {
    const shape = vals.filter(looksStatus).length / vals.length;
    return 0.75 * shape + 0.25 * nameScore(p, ['status']) + 0.1 * nameScore(p, ['state']);
  });

  const isIso = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(new Date(v).getTime());
  const isEpochMs = (v: unknown) => typeof v === 'number' && v > 1e12 && v < 1e14;
  const isEpochSec = (v: unknown) => typeof v === 'number' && v > 1e9 && v < 1e10;
  const timeBest = pick((p, vals) => {
    const shape = Math.max(vals.filter(isIso).length, vals.filter(isEpochMs).length, vals.filter(isEpochSec).length) / vals.length;
    return shape > 0 ? 0.75 * shape + 0.25 * Math.max(nameScore(p, ['updated']), nameScore(p, ['time']), nameScore(p, ['ts']), nameScore(p, ['at'])) : 0;
  });

  const routeBest = pick((p, vals) => {
    if (p === statusBest.path || p === timeBest.path) return 0;
    const scalar = vals.filter((v) => typeof v === 'string' || typeof v === 'number').length / vals.length;
    const distinct = new Set(vals.map(String)).size / vals.length;
    const named = Math.max(nameScore(p, ['route', 'id']), nameScore(p, ['route']) * 0.9, nameScore(p, ['line']) * 0.7);
    return named > 0 ? 0.3 * scalar * distinct + 0.7 * named : 0;
  });

  const v0 = paths.get(timeBest.path)?.[0];
  const timeT: Transform = isEpochMs(v0) ? 'epochMsToIso' : isEpochSec(v0) ? 'epochSecToIso' : 'isoDate';
  const routeV = paths.get(routeBest.path)?.[0];
  const routeT: Transform = typeof routeV === 'number' ? 'toString' : 'identity';

  const notes: MappingProposal['notes'] = [
    { field: 'route', path: routeBest.path, transform: routeT, confidence: Math.min(1, routeBest.c), why: 'Name resembles a route id and values are distinct' },
    { field: 'status', path: statusBest.path, transform: 'upper', confidence: Math.min(1, statusBest.c), why: 'Values match the known status words' },
    { field: 'observedAtIso', path: timeBest.path, transform: timeT, confidence: Math.min(1, timeBest.c), why: timeT === 'isoDate' ? 'Values are ISO dates' : 'Values are numeric timestamps, converted to ISO' },
  ];
  const complete = notes.every((n) => n.path && n.confidence >= 0.5);
  return {
    mapping: {
      version,
      recordsAt: found.path,
      fields: {
        route: { path: routeBest.path, transform: routeT },
        status: { path: statusBest.path, transform: 'upper' },
        observedAtIso: { path: timeBest.path, transform: timeT, optional: (paths.get(timeBest.path)?.filter((v) => v !== null).length ?? 0) < sample.length },
      },
    },
    confidence: Math.min(...notes.map((n) => n.confidence)),
    notes,
    complete,
  };
}
