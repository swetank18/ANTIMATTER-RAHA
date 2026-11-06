// The live demo: one network map and four scenes, each run against the real hub. The map is drawn
// from the same world data the hub uses, and every number on screen comes back from a real run.

import { EDGES, NODES, shortest } from '../core/world.ts';

type Any = any;

export interface StageDeps {
  api: (path: string, body?: unknown) => Promise<Any>;
  esc: (v: unknown) => string;
  renderResult: (r: Any) => string;
}

interface Pt {
  x: number;
  y: number;
}

const SVG = 'http://www.w3.org/2000/svg';
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, reduced() ? 0 : ms));
const at = (id: string): Pt => {
  const n = NODES.find((x) => x.id === id)!;
  return { x: n.x, y: n.y };
};
const rs = (n: number) => `Rs ${Math.round(n).toLocaleString('en-IN')}`;
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};

// ---------- the map ----------

class TrackMap {
  private svg: SVGSVGElement;
  private movers: SVGGElement;
  private marks: SVGGElement;
  private desc: SVGDescElement;
  private gen = 0;

  constructor(host: HTMLElement) {
    const roads = EDGES.filter((e) => e.mode === 'ROAD');
    const rails = EDGES.filter((e) => e.mode === 'METRO');
    const line = (e: (typeof EDGES)[number], cls: string) => {
      const a = at(e.a);
      const b = at(e.b);
      return `<line class="${cls}" data-edge="${e.id}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
    };
    host.innerHTML = `<svg viewBox="0 20 900 760" role="img" aria-labelledby="map-title map-desc">
      <title id="map-title">Map of south and central Chennai</title>
      <desc id="map-desc"></desc>
      <g class="roads">${roads.map((e) => line(e, 'road')).join('')}</g>
      <g class="rails">${rails.map((e) => line(e, 'rail')).join('')}${rails.map((e) => line(e, 'ties')).join('')}</g>
      <g class="marks"></g>
      <g class="stations">${NODES.map((n) => `<g class="stn" data-node="${n.id}" transform="translate(${n.x} ${n.y})"><rect class="nb" x="0" y="0" width="0" height="0"/><circle r="6"/><text class="lbl" x="12" y="5">${n.name}</text><text class="count" x="12" y="24"></text></g>`).join('')}</g>
      <g class="movers"></g>
    </svg>`;
    this.svg = host.querySelector('svg')!;
    this.movers = this.svg.querySelector('.movers')!;
    this.marks = this.svg.querySelector('.marks')!;
    this.desc = this.svg.querySelector('desc')!;
  }

  /** Clears everything a scene drew and returns a token; a stale token means the scene was left. */
  reset(description: string): number {
    this.gen++;
    this.movers.innerHTML = '';
    this.marks.innerHTML = '';
    this.svg.classList.remove('dim');
    this.svg.querySelectorAll('.down, .delayed').forEach((x) => x.classList.remove('down', 'delayed'));
    this.svg.querySelectorAll('.stn').forEach((s) => this.board(s.getAttribute('data-node')!, false));
    this.describe(description);
    return this.gen;
  }

  live(token: number) {
    return token === this.gen;
  }

  describe(text: string) {
    this.desc.textContent = text;
  }

  dim(on: boolean) {
    this.svg.classList.toggle('dim', on);
  }

  /** Puts a station on a yellow nameboard, like the signs on a platform. */
  board(id: string, on: boolean, count = '') {
    const g = this.svg.querySelector<SVGGElement>(`.stn[data-node="${id}"]`);
    if (!g) return;
    g.classList.toggle('on', on);
    g.querySelector('.count')!.textContent = on ? count : '';
    const rect = g.querySelector('.nb')!;
    if (!on) return rect.setAttribute('width', '0');
    const b = (g.querySelector('.lbl') as SVGTextElement).getBBox();
    rect.setAttribute('x', String(b.x - 6));
    rect.setAttribute('y', String(b.y - 3));
    rect.setAttribute('width', String(b.width + 12));
    rect.setAttribute('height', String(b.height + 6));
  }

  railDown(node: string) {
    for (const e of EDGES.filter((x) => x.mode === 'METRO' && (x.a === node || x.b === node))) {
      this.svg.querySelectorAll(`[data-edge="${e.id}"]`).forEach((l) => l.classList.add('down'));
      const a = at(e.a);
      const b = at(e.b);
      const m = el('text', { class: 'cross', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + 8, 'text-anchor': 'middle' });
      m.textContent = '✕';
      this.marks.append(m);
    }
    const p = at(node);
    const t = el('text', { class: 'warn', x: p.x + 12, y: p.y - 16 });
    t.textContent = 'Rail down';
    this.marks.append(t);
  }

  delayed(edgeId: string, label: string) {
    const e = EDGES.find((x) => x.id === edgeId);
    if (!e) return;
    this.svg.querySelectorAll(`[data-edge="${e.id}"]`).forEach((l) => l.classList.add('delayed'));
    const a = at(e.a);
    const b = at(e.b);
    const t = el('text', { class: 'note-lbl', x: (a.x + b.x) / 2 + 14, y: (a.y + b.y) / 2 });
    t.textContent = label;
    this.marks.append(t);
  }

  banner(text: string) {
    const g = el('g', { class: 'banner' });
    const r = el('rect', { x: 24, y: 30, width: 0, height: 44 });
    const t = el('text', { x: 40, y: 59 });
    t.textContent = text;
    g.append(r, t);
    this.marks.append(g);
    const b = t.getBBox();
    r.setAttribute('y', String(b.y - 10));
    r.setAttribute('width', String(b.width + 32));
    r.setAttribute('height', String(b.height + 20));
  }

  /** People waiting around a station, packed so they read as a crowd. */
  crowd(node: string, n: number): SVGCircleElement[] {
    const c = at(node);
    const centre = { x: c.x - 40, y: c.y + 8 };
    return Array.from({ length: n }, (_, i) => {
      const r = 5.6 * Math.sqrt(i + 0.5);
      const a = i * 2.39996;
      const d = el('circle', { class: 'person', r: 4.4 });
      place(d, { x: centre.x + r * Math.cos(a), y: centre.y + r * Math.sin(a) });
      this.movers.append(d);
      return d;
    });
  }

  cab(p: Pt, seats: number): SVGGElement {
    const g = el('g', { class: 'cab' });
    g.append(el('rect', { x: -16, y: -11, width: 32, height: 22 }));
    const t = el('text', { x: 0, y: 6, 'text-anchor': 'middle' });
    t.textContent = String(seats);
    g.append(t);
    place(g, p);
    this.movers.append(g);
    return g;
  }

  tag(p: Pt, text: string, cls = 'tag-lbl') {
    const t = el('text', { class: cls, x: p.x, y: p.y });
    t.textContent = text;
    this.movers.append(t);
    return t;
  }
}

function place(e: SVGElement, p: Pt) {
  e.style.transform = `translate(${p.x}px, ${p.y}px)`;
}

/** Moves along points at a steady speed, so long legs take longer than short ones. */
async function travel(e: SVGElement, pts: Pt[], msPerUnit: number, delay = 0) {
  const end = pts[pts.length - 1];
  if (reduced() || pts.length < 2) return place(e, end);
  const lens = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
  const total = lens.reduce((s, l) => s + l, 0) || 1;
  let acc = 0;
  const frames = pts.map((p, i) => {
    if (i > 0) acc += lens[i - 1];
    return { transform: `translate(${p.x}px, ${p.y}px)`, offset: acc / total };
  });
  const anim = e.animate(frames, { duration: total * msPerUnit, delay, easing: 'ease-in-out', fill: 'forwards' });
  try {
    await anim.finished;
  } catch {
    /* the scene was left */
  }
  place(e, end);
  anim.cancel();
}

/** Where the nth cab to reach a station stops: rows of three up and to its left, clear of names. */
function parking(node: string, n: number): Pt {
  const p = at(node);
  return { x: p.x - 26 - (n % 3) * 36, y: p.y - 16 - Math.floor(n / 3) * 26 };
}

function roadPath(from: string, stops: string[]): Pt[] {
  const pts: Pt[] = [];
  let here = from;
  for (const s of stops) {
    const r = shortest(here, s, new Set(), ['ROAD']);
    for (const id of (r?.path ?? [here, s]).slice(1)) pts.push(at(id));
    here = s;
  }
  return pts;
}

function fade(e: SVGElement, ms = 400) {
  if (reduced()) return e.remove();
  e.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, fill: 'forwards' }).finished.then(() => e.remove(), () => {});
}

// ---------- scenes ----------

const SCENES = [
  { id: 'share', title: 'Share a cab', line: 'Four strangers, one fare' },
  { id: 'bridge', title: 'A train fails', line: '40 people, 10 cabs' },
  { id: 'offline', title: 'The internet goes', line: 'Constraint 1, dealt to us' },
  { id: 'api', title: 'An API changes', line: 'Constraint 3, dealt to us' },
] as const;

type SceneId = (typeof SCENES)[number]['id'];

let map: TrackMap | null = null;
let current: SceneId = 'share';
let D: StageDeps;

const panel = () => document.getElementById('scene')!;

function checksLine(r: Any) {
  const ok = r.checks.filter((c: Any) => c.ok).length;
  return `${ok} of ${r.checks.length} checks passed`;
}

function how(r: Any) {
  return `<details class="how"><summary>How we know: ${D.esc(checksLine(r))}</summary>${D.renderResult(r)}</details>`;
}

function failed(e: Any) {
  return `<p class="oops" role="alert">That did not run. ${D.esc(e?.message ?? '')}</p>`;
}

async function busy(btn: HTMLButtonElement, label: string, work: () => Promise<void>) {
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    await work();
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
}

// Scene 1: four people, one cab.

function share() {
  const token = map!.reset('Four people wait at Guindy station, each about to book a cab to Tambaram on their own.');
  map!.crowd('GDY', 4);
  map!.board('GDY', true);
  map!.board('TBM', true);
  map!.tag({ x: 380, y: 300 }, 'Rs 649 each, alone');
  panel().innerHTML = `
    <h2 class="scene-h">Four people at Guindy, all going to Tambaram</h2>
    <p class="money"><span class="amt">Rs 649</span> each</p>
    <p>That is what each of them sees in Uber right now, at 1.9x surge. Four cabs, four bills, the same road.</p>
    <button class="go" id="go">Make them one buyer</button>
    <div id="out" aria-live="polite"></div>`;
  const btn = document.getElementById('go') as HTMLButtonElement;
  btn.onclick = () => busy(btn, 'Asking drivers to bid…', async () => {
    try {
      const r = await D.api('/api/demo/bloc/run', {});
      const f = r.facts;
      if (!map!.live(token)) return;
      document.getElementById('out')!.innerHTML = `
        <dl class="compare">
          <div><dt>Alone</dt><dd>${rs(f.soloEach)} each</dd></div>
          <div class="win"><dt>Together</dt><dd>${rs(f.shareEach)} each</dd></div>
        </dl>
        <p>They post one request. Drivers bid for the whole cab:</p>
        <ul class="bids">${f.bids.map((b: Any) => `<li class="${b.won ? 'won' : ''}"><span>${D.esc(b.driver)}${b.why ? `<span class="why">${D.esc(b.why)}</span>` : ''}</span><span class="num">${rs(b.amount)}</span><span>${b.won ? 'Won ✓' : b.why ? 'Refused ✗' : 'Lost'}</span></li>`).join('')}</ul>
        <p>The driver gets ${rs(f.bid)}, more than the normal ${rs(f.normalFare)} fare, with no commission taken.</p>
        <p>One person did not lock their share in time. Their seat was released, the others were repriced, and nobody paid for the empty seat.</p>
        ${how(r)}`;
      btn.textContent = 'Run it again';
      await animateShare(f);
    } catch (e) {
      document.getElementById('out')!.innerHTML = failed(e);
    }
  });
}

async function animateShare(f: Any) {
  const m = map!;
  const token = m.reset(`Four people at Guindy post one request. ${f.driver} wins at ${rs(f.bid)}. One person does not lock in time, and three ride to Tambaram for ${rs(f.shareEach)} each.`);
  m.board('GDY', true);
  m.board('TBM', true);
  const people = m.crowd('GDY', f.riders);
  await sleep(300);
  const meet = { x: at('GDY').x - 40, y: at('GDY').y + 40 };
  const noShow = people[people.length - 1];
  await Promise.all(people.slice(0, -1).map((p) => travel(p, [readPos(p), meet], 6)));
  if (!m.live(token)) return;
  fade(noShow);
  m.tag({ x: 360, y: 310 }, 'No-show: seat released');
  people.slice(0, -1).forEach((p) => p.remove());
  const cab = m.cab(meet, f.boarded);
  await sleep(250);
  await travel(cab, [meet, ...roadPath('GDY', f.stops), parking(f.stops[f.stops.length - 1], 0)], 7);
  if (!m.live(token)) return;
  m.board('TBM', true, `${f.boarded} people, ${rs(f.shareEach)} each`);
}

function readPos(e: SVGElement): Pt {
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(e.style.transform);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 };
}

// Scene 2: the rail fails and 40 people are bridged to stations that still run.

function bridge() {
  const token = map!.reset('Forty people wait at Guindy station for trains to Central, Egmore, Kilpauk and the Airport.');
  map!.crowd('GDY', 40);
  map!.board('GDY', true);
  panel().innerHTML = `
    <h2 class="scene-h">Rush hour at Guindy. 40 people are waiting for trains.</h2>
    <p class="money"><span class="amt">Rs 20,110</span> if they all cab home</p>
    <p>When a line fails, everyone opens Uber at once and surge climbs. Most of them do not need a cab home. They need a short ride to a station that still runs.</p>
    <button class="go warn" id="go">Fail the rail at Guindy</button>
    <div id="out" aria-live="polite"></div>`;
  const btn = document.getElementById('go') as HTMLButtonElement;
  btn.onclick = () => busy(btn, 'Regrouping 40 people…', async () => {
    try {
      const r = await D.api('/api/demo/bridge/run', {});
      const f = r.facts;
      if (!map!.live(token)) return;
      const each = (n: number) => rs(n / f.placed);
      document.getElementById('out')!.innerHTML = `
        <dl class="compare">
          <div><dt>Everyone cabs home</dt><dd>${rs(f.full)}</dd></div>
          <div class="win"><dt>Short shared hops</dt><dd>${rs(f.hop)}</dd></div>
        </dl>
        <p class="big-line">${f.placed} people in ${f.cabs} cabs. ${each(f.hop)} each instead of ${each(f.full)}.</p>
        <ul class="bids">${f.stations.map((s: Any) => `<li><span>${D.esc(s.name)}</span><span class="num">${s.riders} people</span><span>Trains running ✓</span></li>`).join('')}</ul>
        <p>Each group rides to the nearest working station and carries on by train. Groups are checked by an independent solver before anyone is told.</p>
        ${how(r)}`;
      btn.textContent = 'Run it again';
      await animateBridge(f);
    } catch (e) {
      document.getElementById('out')!.innerHTML = failed(e);
    }
  });
}

async function animateBridge(f: Any) {
  const m = map!;
  const token = m.reset(`Rail fails at Guindy. ${f.placed} people are grouped into ${f.cabs} cabs to ${f.stations.map((s: Any) => s.name).join(', ')}, where trains still run.`);
  m.board('GDY', true);
  const people = m.crowd('GDY', f.riders);
  await sleep(250);
  m.railDown('GDY');
  await sleep(700);
  if (!m.live(token)) return;
  const g = at('GDY');
  const centre = { x: g.x - 40, y: g.y + 8 };
  const stage = (i: number): Pt => {
    const a = (i / f.rides.length) * Math.PI * 2 - Math.PI / 2;
    return { x: centre.x + 62 * Math.cos(a), y: centre.y + 52 * Math.sin(a) };
  };
  let k = 0;
  const moves: Promise<void>[] = [];
  f.rides.forEach((ride: Any, i: number) => {
    for (let j = 0; j < ride.riders && k < people.length; j++, k++) moves.push(travel(people[k], [readPos(people[k]), stage(i)], 9, i * 40));
  });
  await Promise.all(moves);
  if (!m.live(token)) return;
  people.forEach((p) => p.remove());
  const cabs = f.rides.map((ride: Any, i: number) => m.cab(stage(i), ride.riders));
  await sleep(200);
  const parked = new Map<string, number>();
  await Promise.all(cabs.map((c: SVGGElement, i: number) => {
    const to: string[] = f.rides[i].to;
    const last = to[to.length - 1];
    const n = parked.get(last) ?? 0;
    parked.set(last, n + 1);
    return travel(c, [stage(i), ...roadPath('GDY', to), parking(last, n)], 6, i * 140);
  }));
  if (!m.live(token)) return;
  for (const s of f.stations) if (s.node) m.board(s.node, true, `${s.riders} people`);
}

// Scene 3: our card. The internet goes and the rider's phone keeps working.

async function offline() {
  const token = map!.reset('The network map. The hub on this laptop keeps matching people even with no internet.');
  const state = await D.api('/api/health').catch(() => ({ offline: false }));
  if (!map!.live(token)) return;
  panel().innerHTML = `
    <p class="dealt">Constraint 1, dealt to us</p>
    <h2 class="scene-h">The internet goes down. The app keeps working.</h2>
    <p>This is the real rider app. Cut the internet, then use it: check a fare, ask for a group. Requests wait on the phone and arrive exactly once when it comes back.</p>
    <div class="bar"><button class="go warn" id="cut">Cut the internet</button><button class="go alt" id="back">Bring it back</button></div>
    <p id="netline" class="netline" role="status"></p>
    <div class="phone"><iframe src="/#/rider?embed=1" title="Rider app on a phone"></iframe></div>
    <button class="go alt" id="full">Run the full offline test</button>
    <div id="out" aria-live="polite"></div>`;
  const show = (off: boolean) => {
    map!.reset(off ? 'No internet. The map is dimmed, but the hub on this laptop still matches people and checks passes.' : 'The network map. The internet is up.');
    map!.dim(off);
    if (off) map!.banner('No internet. Matching still runs on this laptop.');
    document.getElementById('netline')!.textContent = off ? 'Internet cut ✕. Phones lose the hub, and every outside service is blocked.' : 'Internet up ✓';
    (document.getElementById('cut') as HTMLButtonElement).disabled = off;
    (document.getElementById('back') as HTMLButtonElement).disabled = !off;
  };
  show(!!state.offline);
  document.getElementById('cut')!.onclick = async () => {
    await D.api('/api/arena/offline', { on: true });
    show(true);
  };
  document.getElementById('back')!.onclick = async () => {
    await D.api('/api/arena/offline', { on: false });
    show(false);
  };
  const full = document.getElementById('full') as HTMLButtonElement;
  full.onclick = () => busy(full, 'Running the offline test…', async () => {
    try {
      const r = await D.api('/api/arena/C01/run', {});
      document.getElementById('out')!.innerHTML = `<p class="big-line">${r.status === 'PASS' ? 'Passed ✓' : 'Not passed ✗'} ${D.esc(checksLine(r))}</p><p>${D.esc(r.summary)}</p>
        <ul class="ticks">${r.checks.map((c: Any) => `<li><span>${c.ok ? '✓' : '✕'}</span> ${D.esc(c.requirement)}</li>`).join('')}</ul>${how(r)}`;
      show(false);
    } catch (e) {
      document.getElementById('out')!.innerHTML = failed(e);
    }
  });
}

// Scene 4: our card. The transit provider changes its response format.

const OLD_SHAPE = `{
  "routes": [
    { "route_id": "TNG-EGM",
      "status": "DELAYED",
      "updated": "2026-11-06T17:30:00Z" }
  ]
}`;
const NEW_SHAPE = `{
  "apiVersion": "2.0",
  "data": { "items": [
    { "routeInfo": { "routeId": "TNG-EGM" },
      "currentState": { "status": "delayed" },
      "lastUpdated": 1793934000000 }
  ] }
}`;

const SAMPLE = JSON.stringify({ result: { lines: [{ lineCode: 'GDY-ALD', operationalStatus: 'RUNNING', stamp: 1793934000 }, { lineCode: 'TNG-EGM', operationalStatus: 'DELAYED' }] } }, null, 2);

const FIELD_NAMES: Record<string, string> = { route: 'Route', status: 'Status', observedAtIso: 'Time' };
const TRANSFORM_WORDS: Record<string, string> = {
  identity: 'as is', upper: 'made upper case', epochMsToIso: 'number turned into a date', epochSecToIso: 'number turned into a date', isoDate: 'read as a date', toString: 'number turned into text',
};

function api() {
  const token = map!.reset('The network map. Line status comes from a transit provider feed.');
  panel().innerHTML = `
    <p class="dealt">Constraint 3, dealt to us</p>
    <h2 class="scene-h">The transit provider changes its API overnight.</h2>
    <p>Field names move, a status turns lower case, the time becomes a number, and one record drops it. Most apps break here.</p>
    <div class="shapes"><figure><figcaption>Yesterday</figcaption><pre>${D.esc(OLD_SHAPE)}</pre></figure><figure><figcaption>Today</figcaption><pre>${D.esc(NEW_SHAPE)}</pre></figure></div>
    <button class="go" id="go">Send the changed response</button>
    <div id="out" aria-live="polite"></div>
    <details class="how"><summary>Bring your own response</summary>
      <label for="own">Paste any JSON response with route, status and time fields</label>
      <textarea id="own">${D.esc(SAMPLE)}</textarea>
      <button class="go alt" id="own-go">Run with this response</button></details>`;
  const run = async (btn: HTMLButtonElement, params: Any) => busy(btn, 'Reading the new format…', async () => {
    try {
      const r = await D.api('/api/arena/C03/run', { params });
      if (!map!.live(token)) return;
      const mapping = r.evidence.find((e: Any) => e.label.startsWith('Field by field'))?.rows ?? [];
      const seen = r.evidence.find((e: Any) => e.label.startsWith('The rest of the system'))?.rows ?? [];
      document.getElementById('out')!.innerHTML = `
        <p class="big-line">${r.status === 'PASS' ? 'Adapted ✓' : 'Not passed ✗'} No code changed.</p>
        <ol class="flow">
          <li>The old reader refused the new format safely. Matching kept running on the last good data.</li>
          <li>Koottu worked out the new mapping from the data itself. A person approved it before use.</li>
          <li>The provider then sent broken JSON. It was rejected and nothing crashed.</li>
        </ol>
        <table class="mapping"><thead><tr><th scope="col">We need</th><th scope="col">Now found at</th><th scope="col">Change</th></tr></thead>
        <tbody>${mapping.map((m: Any) => `<tr><td>${D.esc(FIELD_NAMES[m.internalField] ?? m.internalField)}</td><td><code>${D.esc(m.newPath)}</code></td><td>${D.esc(TRANSFORM_WORDS[m.transform] ?? m.transform)}</td></tr>`).join('')}</tbody></table>
        ${how(r)}`;
      const delayed = seen.find((s: Any) => s.value === 'DELAYED');
      if (delayed) {
        const [a, b] = String(delayed.route).split('-');
        map!.delayed(`${a}-${b}`, 'Delayed, read from the new format');
        map!.describe(`The ${a} to ${b} line shows as delayed, read from the provider's new format.`);
      }
      map!.banner('Transit feed: new format, mapped ✓');
    } catch (e) {
      document.getElementById('out')!.innerHTML = failed(e);
    }
  });
  const go = document.getElementById('go') as HTMLButtonElement;
  go.onclick = () => run(go, {});
  const own = document.getElementById('own-go') as HTMLButtonElement;
  own.onclick = () => run(own, { response: (document.getElementById('own') as HTMLTextAreaElement).value });
}

// ---------- page ----------

async function open(id: SceneId) {
  if (current === 'offline' && id !== 'offline') {
    // Leaving the outage scene brings the internet back, so the other scenes can reach drivers.
    await D.api('/api/arena/offline', { on: false }).catch(() => {});
  }
  current = id;
  document.querySelectorAll<HTMLButtonElement>('[data-scene]').forEach((b) => b.setAttribute('aria-current', b.dataset.scene === id ? 'step' : 'false'));
  if (id === 'share') share();
  else if (id === 'bridge') bridge();
  else if (id === 'offline') await offline();
  else api();
}

export function renderStage(root: HTMLElement, deps: StageDeps) {
  D = deps;
  root.innerHTML = `
    <div class="stage">
      <div class="intro"><h1 class="pitch">Uber prices one rider at a time. Koottu turns a crowd into one buyer.</h1>
      <p class="lede">People going the same way share one cab and split the fare fairly. Drivers bid for the whole group. It keeps working when a train fails, the internet goes, or a provider changes its API.</p></div>
      <ol class="levers" aria-label="Demo scenes">${SCENES.map((s, i) => `<li><button data-scene="${s.id}" aria-current="false"><span class="n">${i + 1}</span><span class="t">${s.title}</span><span class="l">${s.line}</span></button></li>`).join('')}</ol>
      <div class="cabin">
        <figure class="map" id="map"></figure>
        <section class="panel" id="scene" aria-live="polite"></section>
      </div>
      <p class="honest">Place names are real. People, drivers, fares and payments are simulated, and every run is checked against the stored data.</p>
    </div>`;
  map = new TrackMap(document.getElementById('map')!);
  document.querySelectorAll<HTMLButtonElement>('[data-scene]').forEach((b) => (b.onclick = () => void open(b.dataset.scene as SceneId)));
  void open(current);
}
