// Anyone can run this against the database file. It reads the raw rows and recomputes the whole
// hash chain itself, so it does not have to trust the hub.
//
//   npm run verify:ledger -- [database] [--anchor seq:hash]
//
// Without an anchor the chain cannot detect its newest entries being removed. Take an anchor from
// GET /api/ledger/head at any time and pass it here later to rule that out.
import Database from 'better-sqlite3';
import { verifyChain, type LedgerAnchor, type LedgerEntry } from '../src/core/ledger.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--anchor');
let anchor: LedgerAnchor | undefined;
if (at >= 0) {
  const [seq, hash] = String(args[at + 1]).split(':');
  anchor = { seq: Number(seq), hash };
  args.splice(at, 2);
}
const file = args[0] ?? 'data/omnistrand.db';
const db = new Database(file, { readonly: true });
const rows = (db.prepare('SELECT * FROM ledger ORDER BY seq').all() as any[]).map((r): LedgerEntry => ({ ...r, payload: JSON.parse(r.payload) }));
const res = verifyChain(rows, anchor);
const scope = anchor ? ` Anchor at entry ${anchor.seq} matches.` : ' No anchor given, so removal of the newest entries cannot be ruled out.';
console.log(res.ok ? `Ledger intact: ${res.checked} entries verified.${scope}` : `Ledger BROKEN at entry ${res.brokenAt}.`);
process.exit(res.ok ? 0 : 1);
