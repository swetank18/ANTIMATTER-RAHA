// A separate thread with its own SQLite connection, so writers genuinely compete for the file.
const Database = require('better-sqlite3');
const { workerData: w, parentPort } = require('node:worker_threads');

const db = new Database(w.file);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 8000');

const attempt = db.transaction((key) => {
  const seen = db.prepare('SELECT response FROM idempotency WHERE key = ?').get(key);
  if (seen) return { replay: true, outcome: seen.response };
  const r = db.prepare(
    `UPDATE pods SET seats_taken = seats_taken + 1
     WHERE id = ? AND state = 'LOCKED' AND seats_taken + escrow_seats + 1 <= seats_total`,
  ).run(w.podId);
  const outcome = r.changes === 1 ? 'WON' : 'TAKEN';
  db.prepare('INSERT INTO idempotency(key, fingerprint, status, response) VALUES (?, ?, 200, ?)').run(key, 'hammer', outcome);
  return { replay: false, outcome };
});

const tally = { won: 0, lost: 0, replays: 0, errors: 0 };
for (let i = 0; i < w.attempts; i++) {
  const key = `hammer:${w.tag}:${w.id}:${i}`;
  for (let pass = 0; pass < 2; pass++) {
    try {
      const r = attempt.immediate(key);
      if (r.replay) tally.replays++;
      else if (r.outcome === 'WON') tally.won++;
      else tally.lost++;
    } catch {
      tally.errors++;
    }
  }
}
db.close();
parentPort.postMessage(tally);
