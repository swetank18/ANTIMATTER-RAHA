// C04. Everything is checked at the boundary before it can touch stored data. A bad record is
// rejected with a reason and the batch carries on. Nothing is coerced into a plausible value:
// "12 people" is not 12, and "2026-13-45" is not "some date".

import type { DeadlineKind, Need, QuarantineEntry } from './types.ts';

export const MAX_BATCH_BYTES = 2_000_000;
export const MAX_ROWS = 20_000;
export const MAX_FIELD_CHARS = 200;

export interface CleanRider {
  externalId: string;
  spot: string | null;
  shareWith: 'ANYONE' | 'WOMEN_ONLY' | null;
  dest: string;
  need: Need;
  party: number;
  deadlineKind: DeadlineKind;
  deadlineAtIso: string | null;
  deadlineVerified: boolean;
}

export interface ParsedRow {
  line: number;
  raw: unknown;
  parseError?: string;
}

export function parseCsv(text: string): ParsedRow[] {
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        if (c === '\n') line++;
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      cells.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      cells.push(cell);
      rows.push({ line: rowLine, cells });
      cells = [];
      cell = '';
      line++;
      rowLine = line;
    } else {
      cell += c;
    }
  }
  if (cell !== '' || cells.length > 0) {
    cells.push(cell);
    rows.push({ line: rowLine, cells });
  }
  const live = rows.filter((r) => r.cells.some((c) => c.trim() !== ''));
  if (live.length === 0) return [];
  const header = live[0].cells.map((h) => h.replace(/^﻿/, '').trim());
  return live.slice(1).map((r) => {
    if (r.cells.length !== header.length) {
      return { line: r.line, raw: r.cells.join(','), parseError: `Expected ${header.length} columns, found ${r.cells.length}` };
    }
    return { line: r.line, raw: Object.fromEntries(header.map((h, i) => [h, r.cells[i]])) };
  });
}

/** Reads a JSON array, recovering every intact object even when part of the file is broken. */
export function parseJsonTolerant(text: string): ParsedRow[] {
  try {
    const v = JSON.parse(text);
    const list = Array.isArray(v) ? v : Array.isArray(v?.riders) ? v.riders : [v];
    return list.map((raw: unknown, i: number) => ({ line: i + 1, raw }));
  } catch {
    /* fall through to salvage */
  }
  const out: ParsedRow[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let line = 1;
  let startLine = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') line++;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"' && depth > 0) inString = true;
    else if (c === '{') {
      if (depth === 0) {
        start = i;
        startLine = line;
      }
      depth++;
    } else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0) {
        const chunk = text.slice(start, i + 1);
        try {
          out.push({ line: startLine, raw: JSON.parse(chunk) });
        } catch {
          out.push({ line: startLine, raw: chunk, parseError: 'Malformed JSON object' });
        }
        start = -1;
      }
    }
  }
  if (depth > 0 && start >= 0) out.push({ line: startLine, raw: text.slice(start), parseError: 'JSON ended before this object closed' });
  return out;
}

export function parseBatch(text: string): { rows: ParsedRow[]; format: 'json' | 'csv' } {
  const t = text.replace(/^﻿/, '').trimStart();
  if (t.startsWith('[') || t.startsWith('{')) return { rows: parseJsonTolerant(t), format: 'json' };
  return { rows: parseCsv(text), format: 'csv' };
}

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const BIDI = /[‪-‮⁦-⁩‎‏]/;
const ZERO_WIDTH = /[​‌‍⁠﻿]/;
const INJECTION = [
  { re: /<\s*script|javascript:|onerror\s*=/i, why: 'looks like a script injection' },
  { re: /('|")\s*(or|and)\s+('|"|\d)|;\s*(drop|delete|update|insert)\s|--\s*$|\bunion\s+select\b/i, why: 'looks like SQL injection' },
  { re: /^[=+@]|^-[^0-9]/, why: 'looks like spreadsheet formula injection' },
  { re: /\.\.[/\\]/, why: 'looks like a path traversal' },
];

const NEEDS: Record<string, Need> = { NONE: 'NONE', ASSIST: 'ASSIST', WHEELCHAIR: 'WHEELCHAIR', '': 'NONE' };
const KINDS = new Set<DeadlineKind>(['NONE', 'FLIGHT', 'RAIL', 'SHIFT', 'MEDICAL']);

function unsafeText(label: string, v: string): string[] {
  const r: string[] = [];
  if (v.length > MAX_FIELD_CHARS) r.push(`${label}: longer than ${MAX_FIELD_CHARS} characters`);
  if (CONTROL.test(v)) r.push(`${label}: contains control characters`);
  if (BIDI.test(v)) r.push(`${label}: contains text-direction override characters`);
  if (ZERO_WIDTH.test(v)) r.push(`${label}: contains invisible characters`);
  for (const inj of INJECTION) if (inj.re.test(v)) r.push(`${label}: ${inj.why}`);
  return r;
}

function strictIso(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return false;
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(Number(m[1]), month, 0)).getUTCDate() && hour <= 23;
}

export function checkRecord(raw: unknown, knownDest: Set<string>, knownSpots?: Set<string>): { ok: true; value: CleanRider } | { ok: false; reasons: string[] } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reasons: ['Record is not an object'] };
  const r = raw as Record<string, unknown>;
  const reasons: string[] = [];

  const text = (key: string): string | null => {
    const v = r[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' && typeof v !== 'number') {
      reasons.push(`${key}: expected text, found ${Array.isArray(v) ? 'a list' : typeof v}`);
      return null;
    }
    const s = String(v).normalize('NFC').trim();
    reasons.push(...unsafeText(key, s));
    return s;
  };

  const id = text('rider_id');
  if (!id) reasons.push('rider_id: missing');

  const dest = text('destination');
  if (!dest) reasons.push('destination: missing');
  else if (!knownDest.has(dest.toUpperCase())) reasons.push(`destination: "${dest.slice(0, 40)}" is not a known stop`);

  const pickup = text('pickup');
  if (pickup && knownSpots && !knownSpots.has(pickup.toUpperCase())) reasons.push(`pickup: "${pickup.slice(0, 40)}" is not a known pickup spot`);

  const shareRaw = (text('share_with') ?? '').toUpperCase();
  if (shareRaw && shareRaw !== 'ANYONE' && shareRaw !== 'WOMEN_ONLY') reasons.push(`share_with: "${shareRaw.slice(0, 40)}" is not recognised`);

  const needRaw = text('need');
  const need = NEEDS[(needRaw ?? '').toUpperCase()];
  if (!need) reasons.push(`need: "${String(needRaw).slice(0, 40)}" is not a recognised value`);

  const partyRaw = r.party ?? r.party_size;
  let party = 1;
  if (partyRaw !== undefined && partyRaw !== '') {
    const s = String(partyRaw).trim();
    if (typeof partyRaw === 'boolean' || typeof partyRaw === 'object' || !/^-?\d+$/.test(s)) reasons.push(`party: "${s.slice(0, 40)}" is not a whole number`);
    else {
      party = Number(s);
      if (party < 1) reasons.push(`party: ${party} is not a possible group size`);
      else if (party > 12) reasons.push(`party: ${party} is unrealistic for one booking`);
    }
  }

  const kindRaw = (text('deadline_kind') ?? 'NONE').toUpperCase() || 'NONE';
  if (!KINDS.has(kindRaw as DeadlineKind)) reasons.push(`deadline_kind: "${kindRaw.slice(0, 40)}" is not recognised`);

  const at = text('deadline_at');
  if (at && !strictIso(at)) reasons.push(`deadline_at: "${at.slice(0, 40)}" is not a valid timestamp`);
  if (kindRaw !== 'NONE' && !at) reasons.push('deadline_at: required when deadline_kind is set');

  const verifiedRaw = r.deadline_verified;
  const verified = verifiedRaw === true || verifiedRaw === 'true' || verifiedRaw === '1' || verifiedRaw === 1;

  if (reasons.length) return { ok: false, reasons };
  return {
    ok: true,
    value: {
      externalId: id!,
      spot: pickup ? pickup.toUpperCase() : null,
      shareWith: shareRaw === 'ANYONE' || shareRaw === 'WOMEN_ONLY' ? shareRaw : null,
      dest: dest!.toUpperCase(),
      need,
      party,
      deadlineKind: kindRaw as DeadlineKind,
      deadlineAtIso: at || null,
      deadlineVerified: verified,
    },
  };
}

export interface BatchReport {
  format: 'json' | 'csv';
  total: number;
  accepted: CleanRider[];
  quarantined: QuarantineEntry[];
  duplicates: number;
}

const EXCERPT_KEYS = ['pickup', 'destination', 'need', 'party', 'party_size', 'deadline_kind', 'deadline_at', 'share_with'];

/** Removes anything that could identify a person from text that is about to be stored. */
export function scrub(text: string): string {
  return Array.from(text)
    .map((c) => (CONTROL.test(c) || BIDI.test(c) || ZERO_WIDTH.test(c) ? '\uFFFD' : c))
    .join('')
    .replace(/[+]?\d[\d\s-]{8,}\d/g, '[number removed]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email removed]');
}

/**
 * A quarantined row is stored for diagnosis, so it must never carry identity data. Only an
 * allowlist of non-identifying fields survives; rows that cannot be parsed keep their size only.
 */
export function safeExcerpt(raw: unknown): string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    const size = typeof raw === 'string' ? raw.length : JSON.stringify(raw ?? null).length;
    return `[unreadable row, ${size} characters]`;
  }
  const r = raw as Record<string, unknown>;
  const kept: Record<string, string> = {};
  for (const k of EXCERPT_KEYS) if (r[k] !== undefined) kept[k] = scrub(String(r[k]).slice(0, 40));
  return JSON.stringify(kept);
}

export function checkBatch(text: string, knownDest: Set<string>, knownSpots?: Set<string>): BatchReport {
  if (text.length > MAX_BATCH_BYTES) {
    return { format: 'csv', total: 0, accepted: [], duplicates: 0, quarantined: [{ line: 0, reasons: [`Batch is larger than ${MAX_BATCH_BYTES} bytes`], excerpt: '' }] };
  }
  const { rows, format } = parseBatch(text);
  const accepted: CleanRider[] = [];
  const quarantined: QuarantineEntry[] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  for (const row of rows.slice(0, MAX_ROWS)) {
    if (row.parseError) {
      quarantined.push({ line: row.line, reasons: [row.parseError], excerpt: safeExcerpt(row.raw) });
      continue;
    }
    const res = checkRecord(row.raw, knownDest, knownSpots);
    if (!res.ok) {
      quarantined.push({ line: row.line, reasons: res.reasons, excerpt: safeExcerpt(row.raw) });
    } else if (seen.has(res.value.externalId)) {
      duplicates++;
      quarantined.push({ line: row.line, reasons: ['Duplicate of an earlier rider_id in this batch'], excerpt: safeExcerpt(row.raw) });
    } else {
      seen.add(res.value.externalId);
      accepted.push(res.value);
    }
  }
  if (rows.length > MAX_ROWS) {
    quarantined.push({ line: MAX_ROWS + 1, reasons: [`Only the first ${MAX_ROWS} rows were read`], excerpt: '' });
  }
  return { format, total: rows.length, accepted, quarantined, duplicates };
}
