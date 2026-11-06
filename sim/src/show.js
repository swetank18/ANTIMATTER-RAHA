// RAHA pitch show: a 1.5-minute auto-play tour of everything in the simulator,
// plus close buttons for every panel. Start with the "Pitch show" button, key T, or open the URL with #pitch.
const $ = (id) => document.getElementById(id);
const R = () => window.__raha;
let runId = 0;

// ------------------------------------------------------------ close buttons on every panel
function closeBtn(el, onClose) {
  if (!el || el.querySelector(':scope > .close-x')) return;
  const b = document.createElement('button');
  b.className = 'close-x'; b.type = 'button'; b.setAttribute('aria-label', 'Close panel'); b.innerHTML = '&times;';
  b.onclick = (e) => { e.stopPropagation(); onClose ? onClose() : (el.hidden = true); };
  el.prepend(b);
}
function watch(id) { // panels whose content is replaced: re-add the button after every update
  const el = $(id); if (!el) return;
  closeBtn(el);
  new MutationObserver(() => closeBtn(el)).observe(el, { childList: true });
}
['results', 'json-panel'].forEach(watch);
closeBtn($('casefile'));
closeBtn($('panel'), () => $('panel').classList.toggle('collapsed'));
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { ['results', 'json-panel', 'casefile', 'drawer'].forEach((id) => $(id) && ($(id).hidden = true)); stopShow(); }
  if ((e.key === 't' || e.key === 'T') && e.target.tagName !== 'SELECT') runId ? stopShow() : pitchShow();
});

// ------------------------------------------------------------ the 1.5-minute show
const idx = (kind, sid) => R().STEPS.findIndex((s) => s.kind === kind && (!sid || s.sid === sid));
const click = (sel) => document.querySelector(sel)?.click();
// [label, action, seconds on screen]
const TIMELINE = [
  ['RAHA', () => R().go(0), 2.5],
  ['Five real disruptions', () => R().go(idx('globe')), 5],
  ['The two constraint cards', () => R().go(idx('cards')), 8],
  ['Chennai: what happened', () => R().go(idx('lift', 'tambaram')), 6],
  ['Chennai: why it happened', () => R().go(idx('why', 'tambaram')), 5],
  ['Replay twice: same seed', () => R().go(idx('split', 'tambaram')), 1.5],
  ['As it happened vs RAHA', () => click('#choice-buttons button'), 5.5],
  ['RAHA up close: passes, Koottu, refusal proof', () => R().go(idx('raha', 'tambaram')), 8],
  ['Chennai: measured over 200 runs', () => R().go(idx('results', 'tambaram')), 5],
  ['Constraint 1: internet cut (Madrid blackout)', () => R().go(idx('c1')), 9],
  ['Constraint 3: API changes (Singapore)', () => R().go(idx('c3')), 4.5],
  ['Constraint 3: semantic drift caught', () => click('#json-panel button[data-cls="semantic"]'), 4.5],
  ['Judge check: both constraints tested live', () => click('#btn-judge'), 8],
  ['One engine, five real cities', () => R().go(idx('finale')), 7],
  ['Business case', () => R().go(idx('business')), 9],
];
const TOTAL = TIMELINE.reduce((a, x) => a + x[2], 0);
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function hud() {
  let h = $('show-hud');
  if (!h) {
    h = document.createElement('div'); h.id = 'show-hud';
    h.innerHTML = '<span class="dot"></span><b>PITCH SHOW</b><span id="show-label"></span><span id="show-time" class="mono"></span><button id="show-stop" type="button">Stop</button><div id="show-bar"><i></i></div>';
    document.body.appendChild(h); $('show-stop').onclick = stopShow;
  }
  h.hidden = false; return h;
}
export function stopShow() {
  if (!runId) return;
  runId = 0; const h = $('show-hud'); if (h) h.hidden = true;
  if (R()) R().st.speed = +$('speed').value || 2;
  document.body.classList.remove('showing');
}
export async function pitchShow() {
  if (!R()) return;
  const id = ++runId; hud(); document.body.classList.add('showing');
  ['drawer', 'results', 'json-panel'].forEach((x) => $(x) && ($(x).hidden = true));
  const t0 = performance.now(); let at = 0;
  const timer = setInterval(() => {
    if (id !== runId) return clearInterval(timer);
    const el = (performance.now() - t0) / 1000;
    $('show-time').textContent = `${fmt(Math.min(el, TOTAL))} / ${fmt(TOTAL)}`;
    $('show-bar').firstChild.style.width = `${Math.min(100, (el / TOTAL) * 100)}%`;
  }, 250);
  for (const [label, action, secs] of TIMELINE) {
    if (id !== runId) return;
    $('show-label').textContent = label;
    try { await action(); } catch (e) { console.warn('[show]', e); }
    R().st.speed = 6; R().st.playing = true; // keep the replays moving at presentation pace
    at += secs;
    const wait = t0 + at * 1000 - performance.now();
    await new Promise((r) => setTimeout(r, Math.max(0, wait)));
  }
  if (id === runId) { $('show-label').textContent = 'Done: press T to play again'; setTimeout(() => id === runId && stopShow(), 2500); }
}

// buttons + #pitch auto-start
$('btn-show')?.addEventListener('click', () => (runId ? stopShow() : pitchShow()));
$('begin-show')?.addEventListener('click', () => pitchShow());
window.__rahaShow = { pitchShow, stopShow, TOTAL };
if (location.hash === '#pitch') { const wait = () => (R() ? pitchShow() : setTimeout(wait, 200)); setTimeout(wait, 400); }
