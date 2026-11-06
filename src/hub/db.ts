import Database from 'better-sqlite3';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS passengers(
  pid TEXT PRIMARY KEY, dest TEXT NOT NULL, need TEXT NOT NULL,
  party INTEGER NOT NULL CHECK (party >= 1),
  deadline_kind TEXT NOT NULL, deadline_at INTEGER, deadline_verified INTEGER NOT NULL DEFAULT 0,
  checkin_at INTEGER NOT NULL, state TEXT NOT NULL, displaced INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'SEED');
CREATE INDEX IF NOT EXISTS passengers_state ON passengers(state);

CREATE TABLE IF NOT EXISTS vehicles(
  id TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL,
  seats INTEGER NOT NULL, bays INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES vehicles(id), corridor TEXT NOT NULL,
  drop_at TEXT NOT NULL, mode TEXT NOT NULL, depart_at INTEGER NOT NULL, arrive_at INTEGER NOT NULL,
  return_at INTEGER NOT NULL,
  seats_total INTEGER NOT NULL, seats_taken INTEGER NOT NULL DEFAULT 0,
  bays_total INTEGER NOT NULL, bays_taken INTEGER NOT NULL DEFAULT 0,
  escrow_seats INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,
  CHECK (seats_taken >= 0 AND escrow_seats >= 0 AND bays_taken >= 0),
  CHECK (seats_taken + escrow_seats <= seats_total),
  CHECK (bays_taken <= bays_total));
CREATE INDEX IF NOT EXISTS runs_state ON runs(state, depart_at);

CREATE TABLE IF NOT EXISTS seats(
  id INTEGER PRIMARY KEY AUTOINCREMENT, pid TEXT NOT NULL REFERENCES passengers(pid),
  run_id TEXT NOT NULL REFERENCES runs(id), seat_units INTEGER NOT NULL, bay_units INTEGER NOT NULL,
  state TEXT NOT NULL, epoch INTEGER, policy_version INTEGER, pass_id TEXT, pass_token TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS seats_one_per_person ON seats(pid)
  WHERE state IN ('HELD','COMMITTED','BOARDED');
CREATE UNIQUE INDEX IF NOT EXISTS seats_pass ON seats(pass_id) WHERE pass_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS seats_run ON seats(run_id, state);

CREATE TABLE IF NOT EXISTS decisions(
  pid TEXT NOT NULL, epoch INTEGER NOT NULL, outcome TEXT NOT NULL, run_id TEXT, pool TEXT,
  priority TEXT NOT NULL, witness TEXT, rivals INTEGER NOT NULL DEFAULT 0, capacity INTEGER NOT NULL DEFAULT 0,
  policy_version INTEGER NOT NULL, PRIMARY KEY (epoch, pid));
CREATE INDEX IF NOT EXISTS decisions_pid ON decisions(pid, epoch);

CREATE TABLE IF NOT EXISTS epochs(
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, reason TEXT NOT NULL, policy_version INTEGER NOT NULL,
  seed TEXT NOT NULL, input_hash TEXT NOT NULL, output_hash TEXT NOT NULL, merkle_root TEXT NOT NULL,
  certificate TEXT NOT NULL, solve_ms REAL NOT NULL);

CREATE TABLE IF NOT EXISTS ledger(
  seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL,
  payload TEXT NOT NULL, prev TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger
  BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger
  BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;

CREATE TABLE IF NOT EXISTS policies(
  version INTEGER PRIMARY KEY, name TEXT NOT NULL, doc TEXT NOT NULL, hash TEXT NOT NULL, activated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS approvals(
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, subject TEXT NOT NULL, reason TEXT NOT NULL,
  payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'PENDING', decided_by TEXT, decided_at INTEGER);

CREATE TABLE IF NOT EXISTS quarantine(
  id INTEGER PRIMARY KEY AUTOINCREMENT, batch TEXT NOT NULL, line INTEGER NOT NULL,
  reasons TEXT NOT NULL, excerpt TEXT NOT NULL, at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS route_records(
  id INTEGER PRIMARY KEY AUTOINCREMENT, route TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL,
  source TEXT NOT NULL, observed_at INTEGER NOT NULL, received_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS verifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT, route TEXT NOT NULL, question TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'OPEN', answer TEXT, answered_by TEXT);

CREATE TABLE IF NOT EXISTS telemetry(
  id INTEGER PRIMARY KEY AUTOINCREMENT, vehicle_id TEXT NOT NULL, observed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL, lat REAL, lng REAL, odo_km REAL, occupancy INTEGER);

CREATE TABLE IF NOT EXISTS adapters(
  version TEXT PRIMARY KEY, mapping TEXT NOT NULL, state TEXT NOT NULL, confidence REAL NOT NULL,
  notes TEXT NOT NULL DEFAULT '[]', approved_by TEXT);

CREATE TABLE IF NOT EXISTS clarifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT, pid TEXT NOT NULL, field TEXT NOT NULL, question TEXT NOT NULL,
  why TEXT NOT NULL, options TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'OPEN', answer TEXT, due_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS clarify_once ON clarifications(pid, field) WHERE state IN ('OPEN','ESCALATED');

CREATE TABLE IF NOT EXISTS escrow(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), device TEXT NOT NULL,
  seats INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, token TEXT NOT NULL, CHECK (used <= seats));
CREATE UNIQUE INDEX IF NOT EXISTS escrow_device ON escrow(run_id, device);

CREATE TABLE IF NOT EXISTS idempotency(
  key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status INTEGER NOT NULL, response TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS field_ops(
  op_id TEXT PRIMARY KEY, device TEXT NOT NULL, kind TEXT NOT NULL, run_id TEXT NOT NULL, result TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS egress_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, dest TEXT NOT NULL, decision TEXT NOT NULL,
  reason TEXT NOT NULL, bytes INTEGER NOT NULL, payload_hash TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS lang_packs(code TEXT PRIMARY KEY, doc TEXT NOT NULL);
`;

const TABLES = ['lang_packs', 'egress_log', 'field_ops', 'idempotency', 'escrow', 'clarifications', 'adapters', 'telemetry',
  'verifications', 'route_records', 'quarantine', 'approvals', 'policies', 'ledger', 'epochs', 'decisions', 'seats', 'runs',
  'vehicles', 'passengers', 'meta'];

export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/** A reset is the only way the ledger goes away: the tables are dropped, never edited. */
export function wipe(db: DB): void {
  db.pragma('foreign_keys = OFF');
  for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
}
