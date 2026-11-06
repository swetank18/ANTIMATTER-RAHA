import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { scrub } from '../core/validate.ts';

/** The only logger in the hub. Values pass through scrub and protected keys are dropped. */
const PROTECTED = /^(name|full_?name|passenger_?name|phone|mobile|email|aadhaar|id_?number|address|dob)$/i;

export class SafeLog {
  constructor(private file: string | null) {
    if (file) mkdirSync(dirname(file), { recursive: true });
  }

  write(level: 'info' | 'warn' | 'error', event: string, data: Record<string, unknown> = {}): void {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (PROTECTED.test(k)) continue;
      safe[k] = typeof v === 'string' ? scrub(v).slice(0, 200) : typeof v === 'number' || typeof v === 'boolean' ? v : '[omitted]';
    }
    const line = JSON.stringify({ at: new Date().toISOString(), level, event, ...safe });
    if (this.file) appendFileSync(this.file, `${line}\n`);
  }
}
