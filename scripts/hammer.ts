// C09 from the command line, against a running hub: npm run hammer -- 500
export {};
const base = process.env.HUB ?? 'http://127.0.0.1:4100';
const res = await fetch(`${base}/api/arena/C09/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
const card = await res.json();
console.log(`${card.card} ${card.status}: ${card.summary}`);
for (const c of card.checks) console.log(`  ${c.ok ? 'pass' : 'FAIL'}  ${c.requirement}: ${c.observed}`);
process.exit(card.status === 'PASS' ? 0 : 1);
