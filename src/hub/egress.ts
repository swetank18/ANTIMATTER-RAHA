// The only file in the hub allowed to open a network connection. A test fails the build if
// fetch or http.request appears anywhere else, so this boundary cannot be bypassed by accident.

import { sha256Hex } from '../core/hash.ts';

export type EgressDecision = 'ALLOWED' | 'BLOCKED';

export interface EgressRecord {
  dest: string;
  decision: EgressDecision;
  reason: string;
  bytes: number;
  payloadHash: string;
}

export interface EgressResult {
  ok: boolean;
  blocked: string | null;
  status: number | null;
  text: string | null;
}

const PROTECTED_KEYS = /^(pid|passenger_?id|name|full_?name|passenger_?name|phone|mobile|email|aadhaar|id_?number|address|dob|need|lat|lng)$/i;
const PATTERNS: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/, 'an email address'],
  [/(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d)/, 'a phone number'],
  [/(?<!\d)\d{4}\s?\d{4}\s?\d{4}(?!\d)/, 'a 12-digit identity number'],
];

function findProtected(value: unknown, path = ''): string | null {
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findProtected(v, path);
      if (hit) return hit;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (PROTECTED_KEYS.test(k)) return `protected field "${k}"`;
      const hit = findProtected(v, k);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === 'string') {
    for (const [re, what] of PATTERNS) if (re.test(value)) return what;
  }
  return null;
}

export function inspect(body: string | null): string | null {
  if (!body) return null;
  let parsed: unknown = body;
  try {
    parsed = JSON.parse(body);
  } catch {
    /* plain text is scanned as a single string */
  }
  return findProtected(parsed);
}

export class Egress {
  allowlist: Record<string, string> = {};
  offline = false;

  constructor(private record: (r: EgressRecord) => void) {}

  async send(dest: string, path: string, opts: { method?: string; body?: string } = {}): Promise<EgressResult> {
    const body = opts.body ?? null;
    const note = (decision: EgressDecision, reason: string) =>
      this.record({ dest, decision, reason, bytes: body?.length ?? 0, payloadHash: body ? sha256Hex(body) : '' });

    if (this.offline) {
      note('BLOCKED', 'Offline: no external connections');
      return { ok: false, blocked: 'OFFLINE', status: null, text: null };
    }
    const base = this.allowlist[dest];
    if (!base) {
      note('BLOCKED', 'Destination is not on the allowlist');
      return { ok: false, blocked: 'NOT_ALLOWED', status: null, text: null };
    }
    const found = inspect(body);
    if (found) {
      note('BLOCKED', `Payload contains ${found}`);
      return { ok: false, blocked: 'PRIVATE_DATA', status: null, text: null };
    }
    try {
      const res = await fetch(base + path, {
        method: opts.method ?? 'GET',
        body: body ?? undefined,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        signal: AbortSignal.timeout(3000),
      });
      const text = await res.text();
      note('ALLOWED', `HTTP ${res.status}`);
      return { ok: res.ok, blocked: null, status: res.status, text };
    } catch {
      note('BLOCKED', 'Destination unreachable');
      return { ok: false, blocked: 'UNREACHABLE', status: null, text: null };
    }
  }
}

/** Requests to the hub's own port, used by the Arena to attack itself over real sockets. */
export async function loopback(base: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number | null; json: any }> {
  try {
    const res = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    return { ok: res.ok, status: res.status, json: await res.json().catch(() => null) };
  } catch {
    return { ok: false, status: null, json: null };
  }
}
