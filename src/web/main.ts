// Judges' Arena and a working rider app. The rider side is built to keep going with no network:
// it uses the same core code as the hub, a saved pack of local data, and a persistent queue.

import '@fontsource-variable/anek-latin/wdth.css';
import '@fontsource-variable/anek-tamil/wdth.css';
import qrcode from 'qrcode-generator';
import { advise, checkFare, fareFor, fareFromText, KM_PER_MIN } from '../core/fare.ts';
import { verifyPass } from '../core/pass.ts';
import { shortest } from '../core/world.ts';
import './style.css';

type Any = any;

const $ = (id: string) => document.getElementById(id)!;
const main = () => $('main');

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const store = {
  get<T>(k: string, d: T): T {
    try {
      return JSON.parse(localStorage.getItem(k) ?? 'null') ?? d;
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* private mode: the page still works, it just cannot remember */
    }
  },
};

async function api(path: string, body?: unknown): Promise<Any> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(body === undefined ? 4000 : 60000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(json?.error?.message ?? 'That did not work.'), { http: res.status });
  return json;
}

const opId = () => `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ---------- connection, saved data and the queue ----------

let online = true;
let pack: Any = store.get('pack', null);
let outbox: { opId: string; path: string; body: Any; label: string; state: 'waiting' | 'sent' }[] = store.get('outbox', []);

const saveOutbox = () => store.set('outbox', outbox);

function showNet() {
  $('net').textContent = online ? '' : 'You are offline. Your pass still works. New requests will send when you reconnect.';
}

async function flush() {
  for (const item of outbox.filter((o) => o.state === 'waiting')) {
    try {
      const res = await api(item.path, item.body);
      item.state = 'sent';
      if (item.path === '/api/field/request') store.set('pid', res.pid);
      saveOutbox();
    } catch (e: Any) {
      if (e.http) {
        item.state = 'sent';
        saveOutbox();
      }
      break;
    }
  }
}

async function heartbeat() {
  const was = online;
  try {
    await api('/api/field/ping');
    online = true;
  } catch {
    online = false;
  }
  showNet();
  if (online) {
    if (!was || outbox.some((o) => o.state === 'waiting')) await flush();
    await refreshRider();
    try {
      pack = await api('/api/field/offline-pack');
      store.set('pack', pack);
    } catch {
      /* keep the last saved pack */
    }
  }
  if (was !== online && location.hash.startsWith('#/rider')) renderRider();
}

// ---------- rider ----------

let view: Any = store.get('view', null);

async function refreshRider() {
  const pid = store.get<string | null>('pid', null);
  if (!pid || !online) return;
  try {
    view = await api(`/api/field/rider/${pid}`);
    store.set('view', view);
  } catch {
    /* keep the saved view */
  }
}

function placeOptions(selected = '') {
  return (pack?.places ?? []).map((p: Any) => `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}

function spotOptions() {
  return (pack?.spots ?? []).map((s: Any) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
}

function checkOffline(spotId: string, dest: string, app: string, amount: number) {
  const spot = pack.spots.find((s: Any) => s.id === spotId);
  const path = shortest(spot.node, dest, new Set(pack.closed ?? []));
  const km = Math.max(1, (path?.min ?? 20) * KM_PER_MIN);
  const nearby = pack.spots.filter((s: Any) => s.id !== spotId && s.node === spot.node).map((s: Any) => ({ spot: s.id, name: s.name, walkMin: 6 }));
  return {
    check: checkFare(amount, km, null),
    advice: advise({ spot: spotId, app, amount, km, now: pack.savedAt, samples: pack.samples, nearby, shareRs: Math.round(fareFor(km, 1.5) / 2) }),
    km: Math.round(km * 10) / 10,
    samples: pack.samples.filter((s: Any) => s.spot === spotId).length,
  };
}

async function surgeLine(spot: string) {
  try {
    if (!online) return '';
    const f = await api(`/api/field/surge/${spot}`);
    return `<p><strong>Next 15 minutes:</strong> ${esc(f.message)} <span class="sub">Forecast from a model trained on synthetic data.</span></p>`;
  } catch {
    return '';
  }
}

function renderCheck(res: Any, fromSaved: boolean) {
  const moves = res.advice.length
    ? `<ul>${res.advice.map((a: Any) => `<li><strong>${esc(a.title)}</strong>: save about Rs ${esc(a.saveRs)}. ${esc(a.basis)}.</li>`).join('')}</ul>`
    : '<p>Not enough recent fares here to compare yet.</p>';
  $('check-out').innerHTML = `<div class="note"><p>${esc(res.check.message)}</p>${moves}
    <p class="sub">${fromSaved ? `Using fares saved at ${esc(pack.savedAtLabel)}. Live fares are unavailable offline.` : `Compared with ${esc(res.samples)} recent fares here.`}</p></div>`;
  $('check-out').focus();
}

function renderRider() {
  const queue = outbox.slice(-6).reverse();
  const hasPack = !!pack;
  const v = view;
  let ride = '';
  if (v?.pod) {
    const qr = v.pass ? (() => {
      const q = qrcode(0, 'L');
      q.addData(v.pass);
      q.make();
      return `<div class="qr" role="img" aria-label="Your pass code">${q.createSvgTag({ cellSize: 3, margin: 0, scalable: true })}</div>`;
    })() : '';
    const check = v.pass && v.publicKeys ? verifyPass(v.pass, v.publicKeys) : null;
    ride = `<section class="ticket" aria-labelledby="ride-h"><h2 id="ride-h">Your group</h2>
      <p class="big">You pay Rs ${esc(v.seat.share)}</p>
      <p>Alone it would cost Rs ${esc(v.seat.solo)}. You save Rs ${esc(v.seat.saved)}.</p>
      <p>Meet at <strong>${esc(v.pod.spotName)}</strong>, leaving ${esc(v.pod.leavesLabel)}. ${esc(v.pod.members)} in this group, stops: ${esc(v.pod.stopNames.join(', '))}.</p>
      ${v.bridge ? `<p>Rail is down. This short ride takes you to <strong>${esc(v.bridge.station)}</strong>, where trains are running. The whole trip would cost Rs ${esc(v.bridge.fullFare)}.</p>` : ''}
      ${v.pod.isLead ? '<p><strong>This phone books the cab.</strong></p>' : ''}
      ${v.pod.state === 'BOOKED' ? '<p><strong>Booked. Your share is paid.</strong></p>' : v.pod.state === 'LOCKED' ? `<div class="bar">
        ${v.pod.isLead ? `<button class="btn" id="bids" ${online ? '' : 'disabled'}>Ask drivers to bid</button>` : ''}
        <button class="btn alt" id="lock" ${v.locked || !online ? 'disabled' : ''}>${v.locked ? 'Your share is locked' : `Lock my share (Rs ${esc(v.seat.share)})`}</button></div>
        <div id="bid-out" tabindex="-1"></div>` : ''}
      ${qr}
      ${check ? `<p>${check.ok ? 'Pass checked on this phone: valid. This pass works without internet.' : 'This pass could not be verified.'}</p>` : '<p>Your pass appears shortly before leaving.</p>'}
    </section>`;
  } else if (v?.clarification) {
    ride = `<section class="ticket"><h2>We need one answer before we can group you</h2><p>${esc(v.clarification.question)}</p><p class="sub">${esc(v.clarification.why)}</p>
      <div class="bar">${v.clarification.options.map((o: string) => `<button class="btn" data-answer="${esc(o)}">${o === 'ANYONE' ? 'Anyone in my circle' : 'Women only'}</button>`).join('')}</div></section>`;
  } else if (v?.explanation) {
    ride = `<section class="note"><h2>${esc(v.explanation.headline)}</h2><ul>${(v.alternatives ?? []).map((a: Any) => `<li><strong>${esc(a.title)}</strong>. ${esc(a.detail)}</li>`).join('')}</ul></section>`;
  } else if (store.get('pid', null)) {
    ride = '<p class="note" role="status">Finding your group.</p>';
  }

  main().innerHTML = `
    <h1>Is this fare fair?</h1>
    <p class="lede">Uber prices one rider at a time. Koottu turns a crowd into one buyer: check your fare, join people going your way, and let drivers bid for your group.</p>
    ${hasPack ? '' : '<p class="note">Saving local data. Keep this page open for a moment while you have a connection.</p>'}
    <form id="check" class="form" aria-label="Check a fare">
      <label>Pickup spot <select name="spot" required>${spotOptions()}</select></label>
      <label>Destination <select name="dest" required>${placeOptions('MAA')}</select></label>
      <label>App <select name="app"><option>Uber</option><option>Ola</option><option>Namma Yatri</option></select></label>
      <label>Screenshot of your fare (read on this phone, never uploaded) <input id="shot" type="file" accept="image/*"></label>
      <p id="shot-out" class="sub" role="status"></p>
      <label>Fare shown in your app (Rs) <input id="amount" name="amount" type="number" min="1" required value="420"></label>
      <button class="btn">Check this fare</button>
    </form>
    <div id="check-out" tabindex="-1"></div>

    <h2>Find people going your way</h2>
    <form id="req" class="form" aria-label="Find a group">
      <label>Who are you comfortable sharing with?
        <select name="shareWith"><option value="ANYONE">Anyone in my circle</option><option value="WOMEN_ONLY">Women only</option><option value="">Not sure yet</option></select></label>
      <label>People travelling together <input name="party" type="number" min="1" max="4" value="1"></label>
      <p class="sub">Your name and number stay on this phone. They are never sent.</p>
      <button class="btn">Find my group</button>
    </form>
    <div id="ride" tabindex="-1">${ride}</div>

    <h2>Requests on this phone</h2>
    ${queue.length ? `<ul class="queue">${queue.map((o) => `<li>${esc(o.label)}: <strong>${o.state === 'sent' ? 'Sent' : 'Waiting to send'}</strong></li>`).join('')}</ul>` : '<p>Nothing waiting.</p>'}
    ${(pack?.notes ?? []).length ? `<h2>Disruption notes saved here</h2><ul>${pack.notes.map((n: string) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <h2>What works right now</h2>
    <ul>
      <li>Your saved pass: <strong>Works</strong></li>
      <li>Fare check: <strong>${online ? 'Works' : 'Works from saved fares'}</strong></li>
      <li>New group request: <strong>${online ? 'Works' : 'Queued until you reconnect'}</strong></li>
      <li>Booking in Uber or Ola: <strong>${online ? 'Works' : 'Unavailable, those apps need the internet'}</strong></li>
    </ul>`;

  ($('check') as HTMLFormElement).onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target as HTMLFormElement);
    const input = { spot: String(f.get('spot')), dest: String(f.get('dest')), app: String(f.get('app')), amount: Number(f.get('amount')) };
    try {
      if (!online) throw new Error('offline');
      renderCheck(await api('/api/field/check', input), false);
      $('check-out').insertAdjacentHTML('beforeend', `<div class="note">${await surgeLine(input.spot)}</div>`);
    } catch {
      if (pack) renderCheck(checkOffline(input.spot, input.dest, input.app, input.amount), true);
      else $('check-out').textContent = 'No saved fares on this phone yet. Reconnect once to save them.';
    }
  };

  ($('req') as HTMLFormElement).onsubmit = async (e) => {
    e.preventDefault();
    const c = new FormData($('check') as HTMLFormElement);
    const f = new FormData(e.target as HTMLFormElement);
    const share = String(f.get('shareWith'));
    const id = opId();
    const body: Any = { opId: id, spot: c.get('spot'), dest: c.get('dest'), party: Number(f.get('party')), maxDetourMin: 15 };
    if (share) body.shareWith = share;
    outbox.push({ opId: id, path: '/api/field/request', body, label: `Group request to ${c.get('dest')}`, state: 'waiting' });
    saveOutbox();
    if (online) {
      await flush();
      await new Promise((r) => setTimeout(r, 500));
      await refreshRider();
    }
    renderRider();
    $('ride').focus();
  };

  ($('shot') as HTMLInputElement).onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const out = $('shot-out');
    out.textContent = 'Reading your screenshot on this phone…';
    try {
      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker('eng', 1, { workerPath: '/ocr/worker.min.js', corePath: '/ocr/', langPath: '/ocr/', gzip: true, workerBlobURL: false });
      const { data } = await worker.recognize(file);
      await worker.terminate();
      const fare = fareFromText(data.text);
      if (fare === null) {
        out.textContent = 'No fare found in that screenshot. Type it in instead.';
        return;
      }
      ($('amount') as HTMLInputElement).value = String(fare);
      out.textContent = `Read Rs ${fare} from your screenshot. Check it before continuing.`;
    } catch {
      out.textContent = 'That screenshot could not be read. Type the fare in instead.';
    }
  };

  const bidsBtn = document.getElementById('bids');
  if (bidsBtn) {
    bidsBtn.onclick = async () => {
      const res = await api('/api/field/bids', { podId: view.pod.id });
      const out = $('bid-out');
      if (!res.ok) {
        out.textContent = res.message;
        return;
      }
      out.innerHTML = `<p>${esc(res.because)} Simulated drivers.</p><ul>${res.ranked.map((b: Any) => `<li>${esc(b.driver)}: Rs ${esc(b.amount)}, ${esc(b.etaMin)} min <button class="btn alt" data-bid="${esc(b.id)}">Accept</button></li>`).join('')}</ul>`;
      out.focus();
      out.querySelectorAll<HTMLButtonElement>('[data-bid]').forEach((x) => {
        x.onclick = async () => {
          await api('/api/field/accept', { opId: opId(), pid: store.get('pid', ''), podId: view.pod.id, bidId: x.dataset.bid });
          await refreshRider();
          renderRider();
        };
      });
    };
  }
  const lockBtn = document.getElementById('lock');
  if (lockBtn) {
    lockBtn.onclick = async () => {
      await api('/api/field/lock', { opId: opId(), pid: store.get('pid', ''), podId: view.pod.id });
      await refreshRider();
      renderRider();
    };
  }

  document.querySelectorAll<HTMLButtonElement>('[data-answer]').forEach((b) => {
    b.onclick = async () => {
      view = await api('/api/field/answer', { pid: store.get('pid', ''), clarificationId: view.clarification.id, value: b.dataset.answer });
      store.set('view', view);
      renderRider();
    };
  });
}

// While there is signal, pull everything screenshot reading needs through the service worker, so it
// keeps working later with none. These are fetched at runtime, so the app shell alone would not
// include them.
const OCR_FILES = ['/ocr/worker.min.js', '/ocr/tesseract-core-lstm.wasm.js', '/ocr/tesseract-core-simd-lstm.wasm.js', '/ocr/tesseract-core-relaxedsimd-lstm.wasm.js', '/ocr/eng.traineddata.gz'];
let warmed = false;

async function warmOffline() {
  if (warmed || !navigator.serviceWorker?.controller) return;
  warmed = true;
  try {
    await import('tesseract.js');
    await Promise.all(OCR_FILES.map((u) => fetch(u).then((r) => r.arrayBuffer())));
    document.documentElement.dataset.offlineReady = 'yes';
  } catch {
    warmed = false;
  }
}

// ---------- arena ----------

let cards: Any[] = [];

const SAMPLE_API = JSON.stringify({ result: { lines: [{ lineCode: 'GDY-ALD', operationalStatus: 'RUNNING', stamp: 1793934000 }, { lineCode: 'TNG-EGM', operationalStatus: 'DELAYED' }] } }, null, 2);

function table(rows: Any[]) {
  if (!rows.length) return '<p class="sub">Nothing to show.</p>';
  const cols = Object.keys(rows[0]);
  return `<div class="scroll"><table><thead><tr>${cols.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function renderResult(r: Any) {
  if (!r) return '';
  const passed = r.status === 'PASS';
  return `<p class="status ${passed ? 'pass' : 'fail'}">${passed ? 'Pass ✓' : 'Not passed ✗'} <span class="sub">in ${esc(r.durationMs)} ms</span></p>
    <p>${esc(r.summary)}</p>
    <details ${passed ? '' : 'open'}><summary>What happened and the evidence</summary>
      <h3>What happened</h3><ol class="steps">${r.steps.map((s: string) => `<li>${esc(s)}</li>`).join('')}</ol>
      <h3>Checks</h3><ul class="checks">${r.checks.map((c: Any) => `<li><strong class="${c.ok ? 'pass' : 'fail'}">${c.ok ? 'Pass ✓' : 'Failed ✗'}</strong> ${esc(c.requirement)}. <span class="sub">${esc(c.observed)}</span></li>`).join('')}</ul>
      ${r.evidence.map((e: Any) => `<h3>${esc(e.label)}</h3>${table(e.rows)}`).join('')}
    </details>`;
}

function cardHtml(c: Any) {
  const data = c.id === 'C03' ? `<details><summary>Use your own API response</summary><label>Paste the changed response as JSON<textarea id="data-C03">${esc(SAMPLE_API)}</textarea></label>
    <button class="btn alt" data-run="C03" data-own="1">Run with this response</button></details>` : '';
  return `<article class="card ${c.assigned ? 'ours' : ''}" aria-labelledby="t-${c.id}">
    <div class="row"><span class="code">${esc(c.id)}</span>
      <div><p class="title" id="t-${c.id}">${esc(c.title)}${c.assigned ? '<span class="tag">Our card</span>' : ''}</p><p class="sub">${esc(c.scenario)}</p></div>
      <button class="btn" data-run="${c.id}">Run</button></div>
    <p class="sub"><strong>Pass condition:</strong> ${esc(c.passCondition)}</p>
    ${data}
    <div id="r-${c.id}" aria-live="polite">${renderResult(c.last)}</div></article>`;
}

async function renderArena() {
  try {
    cards = await api('/api/arena');
  } catch {
    main().innerHTML = '<h1>The hub is not reachable</h1><p class="lede">The Constraints page needs the hub. The rider app keeps working offline.</p><p><a href="#/rider">Open the rider app</a></p>';
    return;
  }
  const ours = cards.filter((c) => c.assigned);
  const rest = cards.filter((c) => !c.assigned);
  const demos: Any[] = await api('/api/demo').catch(() => []);
  main().innerHTML = `<h1>Uber prices one rider at a time. Koottu turns a crowd into one buyer.</h1>
    <p class="lede">Riders lock their share, open network drivers bid for the group, and when a train fails we bridge you to the next working station instead of all the way home.</p>
    <p class="sub">Demo data is synthetic. Drivers and payments are simulated, and every run says so.</p>
    <h2>See it work</h2>
    ${demos.map((d) => `<article class="card ours"><div class="row"><span class="code" aria-hidden="true">▶</span><div><p class="title">${esc(d.title)}</p><p class="sub">${esc(d.blurb)}</p></div><button class="btn" data-demo="${esc(d.id)}">Run</button></div><div id="d-${esc(d.id)}" aria-live="polite"></div></article>`).join('')}
    <h2>Run any constraint against the live system</h2>
    <p class="lede">Each card attacks the running app, then judges it by checking real data afterwards. A card can fail.</p>
    <div class="bar"><button class="btn" id="all">Run all 12</button>
      <button class="btn warn" id="cut">Cut the network</button>
      <button class="btn alt" id="restore">Restore the network</button></div>
    <p id="all-out" role="status"></p>
    <h2>The constraints we were dealt</h2>${ours.map(cardHtml).join('')}
    <h2>All other constraints</h2>${rest.map(cardHtml).join('')}`;

  document.querySelectorAll<HTMLButtonElement>('[data-run]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.run!;
      const params: Any = {};
      if (b.dataset.own) params.response = ($(`data-${id}`) as HTMLTextAreaElement).value;
      const slot = $(`r-${id}`);
      b.disabled = true;
      slot.innerHTML = '<p>Running…</p>';
      try {
        slot.innerHTML = renderResult(await api(`/api/arena/${id}/run`, { params }));
      } catch (e: Any) {
        slot.textContent = e.message;
      }
      b.disabled = false;
    };
  });
  document.querySelectorAll<HTMLButtonElement>('[data-demo]').forEach((b) => {
    b.onclick = async () => {
      const slot = $(`d-${b.dataset.demo}`);
      b.disabled = true;
      slot.innerHTML = '<p>Running…</p>';
      try {
        slot.innerHTML = renderResult(await api(`/api/demo/${b.dataset.demo}/run`, {}));
      } catch (e: Any) {
        slot.textContent = e.message;
      }
      b.disabled = false;
    };
  });
  $('all').onclick = async () => {
    $('all-out').textContent = 'Running all 12 on one world…';
    const res = await api('/api/arena/run-all', {});
    for (const r of res.results) $(`r-${r.card}`).innerHTML = renderResult(r);
    $('all-out').textContent = `${res.passed} of ${res.total} passed in ${(res.durationMs / 1000).toFixed(1)} seconds.`;
  };
  $('cut').onclick = async () => {
    await api('/api/arena/offline', { on: true });
    $('all-out').textContent = 'Network cut. Open the Rider app to see what still works.';
  };
  $('restore').onclick = async () => {
    await api('/api/arena/offline', { on: false });
    $('all-out').textContent = 'Network restored. Queued requests are sending.';
  };
}

// ---------- routing ----------

function route() {
  const hash = location.hash || '#/arena';
  const name = hash.startsWith('#/rider') ? 'rider' : 'arena';
  document.documentElement.dataset.mode = hash.includes('mode=keyboard') ? 'keyboard' : '';
  document.querySelectorAll<HTMLAnchorElement>('[data-nav]').forEach((a) => {
    if (a.dataset.nav === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (name === 'rider') {
    renderRider();
    void warmOffline();
  } else void renderArena();
  main().focus();
}

window.addEventListener('hashchange', route);
window.addEventListener('online', () => void heartbeat());
window.addEventListener('offline', () => void heartbeat());

navigator.serviceWorker?.addEventListener('controllerchange', () => {
  if (location.hash.startsWith('#/rider')) void warmOffline();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(async () => {
    const reg = await navigator.serviceWorker.ready;
    const urls = performance.getEntriesByType('resource').map((r) => r.name).filter((u) => u.startsWith(location.origin) && !u.includes('/api/'));
    reg.active?.postMessage({ type: 'CACHE', urls });
  }).catch(() => {});
}

route();
void heartbeat().then(() => {
  if (location.hash.startsWith('#/rider')) renderRider();
});
setInterval(() => void heartbeat(), 2500);
