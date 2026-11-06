// RAHA: the simulation viewer and story director.
// Every number shown here comes from src/sim/engine.js run in this page (seed 1) or from data/results.json
// (200-seed experiments produced by scripts/run_experiments.mjs with the same engine).
import * as THREE from 'three';
import { createRenderer, makeSky, makeGlobe, makeBeacon, latLonToVec3, buildIsland, layoutIsland, makeAgents, makeVehicles, makeArcs, makeRing, makeBeam, makeHeat, makeThreads, COLORS, mulberry } from './scene.js';
import { prepareWorld, simulate, POLICY_LABEL, score, losOf, mutate, providerMessage, naiveParse, makeAdapter, DRIFT_CLASSES } from './sim/engine.js';

const $ = (id) => document.getElementById(id);
const LOS_COL = { A: '#4ade80', B: '#a3e635', C: '#facc15', D: '#fb923c', E: '#f97316', F: '#ef4444' };
const fmt = (x, d = 0) => (x == null || !Number.isFinite(x) ? '–' : x.toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d }));
const clockOf = (m) => { const mm = ((Math.floor(m) % 1440) + 1440) % 1440; return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`; };
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const getJSON = async (u, opt = false) => { try { const r = await fetch(u); if (!r.ok) throw new Error(r.status); return await r.json(); } catch (e) { if (opt) return null; throw e; } };

// ------------------------------------------------------------------ data
const DATA = await getJSON('./data/scenarios.json');
const RESULTS = await getJSON('./data/results.json', true);
const LAND = await getJSON('./data/world/land.json');
const PLACES = await getJSON('./data/world/places.json');
const GEO = {};
await Promise.all(DATA.scenarios.map(async (s) => { GEO[s.id] = await getJSON(`./data/geo/${s.id}.json`, true); }));
const SCN = Object.fromEntries(DATA.scenarios.map((s) => [s.id, s]));
const SRC = DATA.sources;

// ------------------------------------------------------------------ three
const { renderer, scene, camera, controls, composer, bloom } = createRenderer($('gl'));
const sky = makeSky(scene);
const globe = makeGlobe(LAND, PLACES, 600);
scene.add(globe.group);
const beacons = DATA.scenarios.map((s) => {
  const b = makeBeacon(s.hero ? '#ffb547' : '#ff5a4e'); const p = latLonToVec3(s.lat, s.lon, 600);
  b.position.copy(p); b.lookAt(p.clone().multiplyScalar(2)); b.rotateX(Math.PI / 2); globe.group.add(b); return { s, b, p };
});
const islandRoot = new THREE.Group(); scene.add(islandRoot);
const finaleRoot = new THREE.Group(); scene.add(finaleRoot);

// ------------------------------------------------------------------ labels (DOM, projected each frame)
const labelLayer = $('labels');
let labels = [];
function addLabel(obj, html, cls = '', onClick = null) {
  const el = document.createElement('div'); el.className = `lbl ${cls}`; el.innerHTML = html; labelLayer.appendChild(el);
  if (onClick) el.addEventListener('click', onClick);
  const L = { obj, el }; labels.push(L); return L;
}
function clearLabels(filter = () => true) { labels = labels.filter((L) => { if (filter(L)) { L.el.remove(); return false; } return true; }); }
const _v = new THREE.Vector3();
function drawLabels() {
  for (const L of labels) {
    if (!L.obj.visible && L.obj.parent && !L.obj.parent.visible) { L.el.style.display = 'none'; continue; }
    L.obj.getWorldPosition(_v); _v.project(camera);
    const vis = _v.z < 1 && Math.abs(_v.x) < 1.15 && Math.abs(_v.y) < 1.15 && isVisible(L.obj);
    L.el.style.display = vis ? '' : 'none';
    if (vis) { L.el.style.left = `${(_v.x * 0.5 + 0.5) * innerWidth}px`; L.el.style.top = `${(-_v.y * 0.5 + 0.5) * innerHeight}px`; }
  }
}
function isVisible(o) { while (o) { if (!o.visible) return false; o = o.parent; } return true; }
beacons.forEach(({ s, b }) => addLabel(b, `${s.title} <span class="dim">${s.date}</span>`, 'beacon', () => jumpTo(s.id)));

// ------------------------------------------------------------------ island cache + views
const cache = {};
function islandFor(sid) {
  if (cache[sid]) return cache[sid];
  const s = SCN[sid], geo = GEO[sid];
  const world = prepareWorld(s, geo);
  const base = buildIsland(geo);
  const layout = layoutIsland(base, world.corridors.length, Math.max(1, world.P.gates), geo.places, s.corridors);
  return (cache[sid] = { s, geo, world, base, layout });
}

class View {
  constructor(isl, x, side) {
    this.isl = isl; this.side = side; this.group = new THREE.Group(); this.group.position.x = x;
    this.island = side === 0 ? isl.base.group : isl.base.group.clone();
    this.group.add(this.island);
    const N = isl.world.N; this.agents = makeAgents(N); this.group.add(this.agents.pts);
    this.veh = makeVehicles(900); this.group.add(this.veh);
    this.arcs = makeArcs(420); this.group.add(this.arcs.lines); this.arcPool = [];
    this.heat = makeHeat(380, 76); this.group.add(this.heat.mesh);
    this.ripples = [];
    const { layout, world, s, geo } = isl; this.layout = layout;
    const R = geo.radius;
    // corridor bays + destination beams at the real bearing
    this.bays = layout.bays; this.edge = [];
    world.corridors.forEach((c, i) => {
      const col = new THREE.Color(COLORS.corridor[i % 7]);
      const bay = layout.bays[i]; const beam = makeBeam(col, 70); beam.position.add(bay.pos); this.group.add(beam);
      const a = (bay.bearing * Math.PI) / 180; const e = new THREE.Vector3(Math.sin(a) * R * 0.96, 0, -Math.cos(a) * R * 0.96); this.edge.push(e);
      const db = makeBeam(col, 320); db.position.add(e); this.group.add(db);
      const anchor = new THREE.Object3D(); anchor.position.copy(e).setY(330 + i * 46); this.group.add(anchor);
      const dist = c.distKm != null ? `${fmt(c.distKm, 1)} km` : `${fmt(c.oneWay)} min`;
      addLabel(anchor, `<span style="color:${COLORS.corridor[i % 7]}">&#9679;</span> ${c.name} <span class="dim">${dist}</span>`, `dest v${side}`);
    });
    // geofenced pickup gates (Koottu cabs and two-wheelers)
    this.gates = layout.gates;
    if (world.vehicles.some((v) => v.kind === 'cab' || v.kind === 'bike')) {
      layout.gates.forEach((g, i) => { const r = makeRing('#ffd400', 26); r.position.add(g); this.group.add(r); const a = new THREE.Object3D(); a.position.copy(g).setY(30); this.group.add(a); addLabel(a, `Gate ${i + 1}`, `dest v${side}`); });
      const fence = new THREE.Mesh(new THREE.RingGeometry(R * 0.885, R * 0.9, 160), new THREE.MeshBasicMaterial({ color: '#ffd400', transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
      fence.rotation.x = -Math.PI / 2; fence.position.y = 3; this.group.add(fence);
      const fa = new THREE.Object3D(); fa.position.set(-R * 0.62, 12, R * 0.62); this.group.add(fa);
      addLabel(fa, `geofence ${world.P.geofenceKm} km (not to scale)`, `dest v${side}`);
    }
    // station hub
    const hubA = new THREE.Object3D(); hubA.position.set(0, 60, 0); this.group.add(hubA);
    addLabel(hubA, `${geo.hub.name}`, `dest v${side}`);
    // name card under the island (Tenku-style, our own words)
    const nameA = new THREE.Object3D(); nameA.position.set(0, -R * 1.05, 0); this.group.add(nameA);
    this.nameLabel = addLabel(nameA, '', `big v${side}`);
    // Constraint 1 props
    this.threads = makeThreads(20, R); this.threads.visible = false; this.group.add(this.threads);
    this.edgeNode = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 46, 16), new THREE.MeshBasicMaterial({ color: '#4ade80', transparent: true, opacity: 0.85 }));
    this.edgeNode.position.set(26, 23, 26); this.edgeNode.visible = false; this.group.add(this.edgeNode);
    this.heat.mesh.position.set(0, 2, 0);
    islandRoot.add(this.group);
  }
  setName(html) { this.nameLabel.el.innerHTML = html; }
  setRun(res, mode, opts = {}) {
    this.res = res; this.mode = mode; this.opts = opts; const L = res.log; const w = this.isl.world;
    const byKey = new Map(); for (const tr of L.trips) byKey.set(`${tr.v}|${tr.dep.toFixed(5)}`, tr);
    const rnd = mulberry(7 + this.side);
    this.P = L.pax.map((p) => {
      const tr = p.board >= 0 ? byKey.get(`${p.veh}|${p.board.toFixed(5)}`) : null;
      const kind = tr ? tr.kind : null;
      const e = this.layout.entries[Math.floor(rnd() * this.layout.entries.length)];
      const cabbound = kind === 'cab' || kind === 'bike';
      const raha = mode === 'raha' && !(tr && tr.rush);
      const gate = this.gates[raha ? p.ci % this.gates.length : 0] || this.bays[p.ci].pos;
      const bay = this.bays[p.ci].pos;
      const center = cabbound ? gate : bay;
      const back = center.clone().multiplyScalar(-1).normalize();
      return { ...p, tr, kind, raha, entry: e.clone().add(new THREE.Vector3((rnd() - 0.5) * 30, 0, (rnd() - 0.5) * 30)), center, hold: center.clone().add(back.multiplyScalar(raha ? 24 : 4)), dest: center, u1: rnd(), u2: rnd(), j: rnd() * 6.28, bs: tr ? tr.arr : Infinity, key: cabbound ? 'g' + (raha ? p.ci % this.gates.length : 0) : 'b' + p.ci };
    });
    this.counts = new Map(); this.prevT = -1e9; this.arcPool = []; this.ripples.forEach((r) => this.group.remove(r.m)); this.ripples = [];
    this.trips = L.trips.slice().sort((a, b) => a.arr - b.arr);
    // train placement: along the longest platform near the hub
    const pl = this.isl.geo.platforms.slice().sort((a, b) => b.length - a.length)[0];
    if (pl) { const a = pl[0], b = pl[pl.length - 1]; this.trainA = new THREE.Vector3(a[0], 0, -a[1]); this.trainB = new THREE.Vector3(b[0], 0, -b[1]); }
    else { this.trainA = new THREE.Vector3(-200, 0, 0); this.trainB = new THREE.Vector3(200, 0, 0); }
  }
  update(t, dtReal) {
    if (!this.res) return;
    const A = this.agents, n = this.P.length; const pos = A.pos, col = A.col, size = A.size;
    const counts = new Map();
    const c = new THREE.Color(); const P = this.isl.world.P;
    const essentialsAfter = P.essentialsAfterMin;
    const spawnArcs = [];
    for (let k = 0; k < n; k++) {
      const p = this.P[k]; let x = 0, z = 0, y = 2.2, s = 1, vis = true;
      const tw = p.arr + p.walk;
      if (t < p.arr || (p.board >= 0 && t > p.board)) { vis = false; }
      else if (t < tw) { const f = (t - p.arr) / Math.max(0.01, p.walk); x = p.entry.x + (p.hold.x - p.entry.x) * f; z = p.entry.z + (p.hold.z - p.entry.z) * f; c.copy(COLORS.walker); s = 0.9; }
      else {
        const cnt = (this.counts.get(p.key) || 1);
        const dens = p.raha ? 1.0 : 0.35; // m² per person: staged holding area vs Weidmann-dense waiting crowd
        const r = Math.sqrt((cnt * dens) / Math.PI) + 1;
        const ang = p.u1 * 6.283 + (p.raha ? 0 : Math.sin(t * 3 + p.j) * 0.08);
        const rr = Math.sqrt(p.u2) * r;
        let hx = p.hold.x + Math.cos(ang) * rr, hz = p.hold.z + Math.sin(ang) * rr;
        if (t < p.bs) {
          counts.set(p.key, (counts.get(p.key) || 0) + 1);
          x = hx; z = hz;
          const waited = t - p.arr;
          if (p.raha && p.issue >= 0 && t >= p.issue) { c.set(COLORS.corridor[p.ci % 7]); if (this.prevT < p.issue) spawnArcs.push([hx, hz, p.dest, p.ci]); }
          else if (p.raha) c.copy(COLORS.waiting);
          else { c.copy(COLORS.stranded); c.multiplyScalar(0.7 + Math.min(0.6, waited / 90)); }
          if (p.raha && waited > essentialsAfter) { c.lerp(new THREE.Color('#ff9f43'), 0.35 + 0.25 * Math.sin(t * 6 + p.j)); }
        } else {
          const f = Math.min(1, (t - p.bs) / Math.max(0.05, p.board - p.bs));
          x = hx + (p.dest.x - hx) * f; z = hz + (p.dest.z - hz) * f; c.set(COLORS.corridor[p.ci % 7]); c.multiplyScalar(1.3);
        }
      }
      if (p.wc || p.assist || p.elderly) { s *= 1.7; if (vis) c.lerp(COLORS.vulnerable, 0.35); }
      pos[k * 3] = x; pos[k * 3 + 1] = vis ? y : -9999; pos[k * 3 + 2] = z;
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b; size[k] = vis ? s : 0;
    }
    this.counts = counts; A.setCount(n); A.dirty();
    // pass-issue arcs (agent -> seat) and cab-pool arcs
    for (const [hx, hz, d, ci] of spawnArcs.slice(0, 40)) this.arcPool.push({ a: new THREE.Vector3(hx, 2, hz), b: d.clone().setY(4), life: 1.6, col: new THREE.Color(COLORS.corridor[ci % 7]) });
    // vehicles
    let vi = 0; const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pp = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for (const tr of this.trips) {
      const kind = tr.kind; const A0 = kind === 'train' ? 6 : kind === 'cab' || kind === 'bike' ? 1.2 : 3;
      if (t < tr.arr - A0 || t > tr.dep + A0) continue;
      if (vi >= 900) break;
      let from, to, f, dims, colr;
      if (kind === 'train') {
        const mid = this.trainA.clone().lerp(this.trainB, 0.5); const dir = this.trainB.clone().sub(this.trainA).normalize();
        const off = t < tr.arr ? -(tr.arr - t) / A0 * 500 : t > tr.dep ? (t - tr.dep) / A0 * 500 : 0;
        pp.copy(mid).addScaledVector(dir, off); dims = [Math.min(300, this.trainA.distanceTo(this.trainB) * 0.9), 4.2, 3.4]; colr = COLORS.train;
        q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      } else {
        const tgt = kind === 'cab' || kind === 'bike' ? (this.mode === 'raha' && !tr.rush ? this.gates[Math.max(0, tr.ci) % this.gates.length] : this.gates[0]) || this.bays[0].pos : this.bays[Math.max(0, tr.ci)].pos;
        const edge = tr.ci >= 0 ? this.edge[tr.ci % this.edge.length] : this.edge[0];
        if (t < tr.arr) { from = edge; to = tgt; f = 1 - (tr.arr - t) / A0; }
        else if (t > tr.dep) { from = tgt; to = edge; f = (t - tr.dep) / A0; }
        else { from = tgt; to = edge; f = 0; }
        pp.copy(from).lerp(to, ease(Math.max(0, Math.min(1, f))));
        const dir = to.clone().sub(from); dir.y = 0; if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0); dir.normalize();
        q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
        if (kind === 'cab') { dims = [4.6, 1.6, 1.9]; colr = tr.n > 1 ? new THREE.Color('#ffe14d') : new THREE.Color('#b59a1f'); }
        else if (kind === 'bike') { dims = [2.2, 1.4, 0.9]; colr = new THREE.Color('#ff8a3d'); }
        else if (kind === 'regular') { dims = [11, 3.1, 2.5]; colr = new THREE.Color('#7f8aa6'); }
        else { dims = [12, 3.3, 2.6]; colr = new THREE.Color(COLORS.corridor[tr.ci % 7]).lerp(COLORS.bus, 0.45); }
        if (tr.n === 0 && kind !== 'cab' && kind !== 'bike' && t >= tr.arr) colr = new THREE.Color('#3a3f52'); // empty departure
      }
      sc.set(dims[0], dims[1], dims[2]); pp.y = 1; m4.compose(pp, q, sc); this.veh.setMatrixAt(vi, m4); this.veh.setColorAt(vi, colr); vi++;
      // rush ripple at the door when people are turned away
      if (tr.rush && tr.crowd > tr.n && this.prevT < tr.arr && t >= tr.arr && kind !== 'cab' && kind !== 'bike') this.ripple(kind === 'train' ? this.trainA.clone().lerp(this.trainB, 0.5) : this.bays[tr.ci].pos, '#ff5a4e', 22 + Math.min(70, (tr.crowd - tr.n) / 6));
      if ((kind === 'cab') && this.mode === 'raha' && tr.n > 1 && this.prevT < tr.arr && t >= tr.arr) this.ripple(this.gates[Math.max(0, tr.ci) % this.gates.length], '#ffd400', 18);
    }
    this.veh.count = vi; this.veh.instanceMatrix.needsUpdate = true; if (this.veh.instanceColor) this.veh.instanceColor.needsUpdate = true;
    // arcs
    const ap = this.arcs.pos, ac = this.arcs.col; let ai = 0; const SEG = 8;
    this.arcPool = this.arcPool.filter((a) => (a.life -= dtReal) > 0).slice(-this.arcs.max);
    for (const a of this.arcPool) {
      const h = 30 + a.a.distanceTo(a.b) * 0.25; const alpha = Math.min(1, a.life / 0.8);
      for (let s2 = 0; s2 < SEG; s2++) {
        for (const tt of [s2 / SEG, (s2 + 1) / SEG]) {
          const x = a.a.x + (a.b.x - a.a.x) * tt, z = a.a.z + (a.b.z - a.a.z) * tt, y = a.a.y + (a.b.y - a.a.y) * tt + Math.sin(tt * Math.PI) * h;
          ap[ai * 3] = x; ap[ai * 3 + 1] = y; ap[ai * 3 + 2] = z; ac[ai * 3] = a.col.r * alpha; ac[ai * 3 + 1] = a.col.g * alpha; ac[ai * 3 + 2] = a.col.b * alpha; ai++;
        }
      }
    }
    this.arcs.g.setDrawRange(0, ai); this.arcs.g.attributes.position.needsUpdate = true; this.arcs.g.attributes.color.needsUpdate = true;
    // ripples
    this.ripples = this.ripples.filter((r) => { r.life -= dtReal; r.m.scale.setScalar(1 + (1.4 - r.life) * 2.2); r.m.material.opacity = Math.max(0, r.life / 1.4); if (r.life <= 0) { this.group.remove(r.m); return false; } return true; });
    // density heat floor (every few frames)
    if ((this._hf = (this._hf || 0) + 1) % 4 === 0) this.updateHeat();
    this.prevT = t;
  }
  ripple(p, color, r) { if (this.ripples.length > 30) return; const m = makeRing(color, r); m.position.add(p); this.group.add(m); this.ripples.push({ m, life: 1.4 }); }
  updateHeat() {
    const H = this.heat, res = H.res, cell = H.size / res, area = cell * cell; const grid = new Float32Array(res * res);
    const pos = this.agents.pos, n = this.P.length;
    for (let k = 0; k < n; k++) { if (pos[k * 3 + 1] < -100) continue; const gx = Math.floor((pos[k * 3] + H.size / 2) / cell), gz = Math.floor((pos[k * 3 + 2] + H.size / 2) / cell); if (gx >= 0 && gz >= 0 && gx < res && gz < res) grid[gz * res + gx]++; }
    const d = H.data; const cols = { A: [0, 0, 0, 0], B: [40, 120, 60, 60], C: [160, 150, 30, 90], D: [200, 110, 30, 130], E: [230, 80, 20, 170], F: [255, 40, 30, 220] };
    for (let i = 0; i < res * res; i++) { const L = losOf(grid[i] / area); const cc = cols[L]; d.set(cc, i * 4); }
    // texture rows are bottom-up; plane is rotated -90deg about X: flip handled by PlaneGeometry UVs
    H.tex.needsUpdate = true;
  }
  kpis(t) {
    const L = this.res.log; let waiting = 0, served = 0, worst = 0, ess = 0;
    for (const p of L.pax) { if (p.arr + p.walk <= t && (p.board < 0 || t < p.board)) { waiting++; worst = Math.max(worst, t - p.arr); if (t - p.arr > this.isl.world.P.essentialsAfterMin) ess++; } else if (p.board >= 0 && p.board <= t) served++; if (p.board >= 0 && p.board <= t && p.board - p.arr > this.isl.world.P.essentialsAfterMin) ess++; }
    let turned = 0, peakCrowd = 0, cabRiders = 0, cabTrips = 0, fare = 0, solo = 0, bikes = 0, pooledTrips = 0, empty = 0;
    for (const tr of L.trips) {
      if (tr.arr > t) continue;
      if (tr.kind === 'cab') { if (tr.n) { cabTrips++; cabRiders += tr.n; fare += tr.shares.reduce((a, b) => a + b, 0); solo += tr.solos.reduce((a, b) => a + b, 0); if (tr.n > 1) pooledTrips++; } continue; }
      if (tr.kind === 'bike') { bikes += tr.n; continue; }
      if (tr.rush) turned += Math.max(0, tr.crowd - tr.n);
      if (tr.kind === 'bus' || tr.kind === 'train') { peakCrowd = Math.max(peakCrowd, tr.crowd); if (tr.n === 0) empty++; }
    }
    const dens = peakCrowd / this.isl.world.P.doorZoneM2;
    return { waiting, served, worst, turned, los: peakCrowd ? losOf(dens) : '–', dens, cabRiders, cabTrips, perCab: cabTrips ? cabRiders / cabTrips : 0, fare: cabRiders ? fare / cabRiders : 0, solo: cabRiders ? solo / cabRiders : 0, bikes, ess, pooledTrips, empty };
  }
  dispose() { islandRoot.remove(this.group); clearLabels((L) => L.el.classList.contains(`v${this.side}`)); }
}

// ------------------------------------------------------------------ story steps
const STEPS = [{ kind: 'title' }, { kind: 'globe' }, { kind: 'cards' }];
for (const s of DATA.scenarios) {
  if (!GEO[s.id]) continue;
  STEPS.push({ kind: 'lift', sid: s.id }, { kind: 'why', sid: s.id }, { kind: 'split', sid: s.id }, { kind: 'raha', sid: s.id });
  if (s.cut) STEPS.push({ kind: 'c1', sid: s.id });
  if (s.drift) STEPS.push({ kind: 'c3', sid: s.id });
  STEPS.push({ kind: 'results', sid: s.id });
}
STEPS.push({ kind: 'finale' }, { kind: 'business' });
const STEP_NAME = { title: 'Title', globe: 'The globe', cards: 'The 2 constraint cards', lift: 'What happened', why: 'Why it happened', split: 'Replay twice', raha: 'RAHA up close', c1: 'Constraint 1: no internet', c3: 'Constraint 3: API changes', results: 'Measured results', finale: 'Finale', business: 'Business case' };

const st = { i: 0, t: 0, playing: true, speed: 2, sid: null, views: [], twin: false, tween: null, c3cls: null, lastKpi: 0, rise: null };
function buildRail() {
  const r = $('rail'); r.innerHTML = ''; let g = null;
  STEPS.forEach((S, i) => {
    if (S.sid && S.sid !== g) { g = S.sid; const h = document.createElement('div'); h.className = 'grp'; h.textContent = SCN[g].title; r.appendChild(h); }
    if (!S.sid && S.kind !== 'title') { const h = document.createElement('div'); h.className = 'grp'; h.textContent = S.kind === 'globe' ? 'Prologue' : 'All cities'; r.appendChild(h); }
    if (S.kind === 'title') return;
    const b = document.createElement('button'); b.textContent = STEP_NAME[S.kind]; b.dataset.i = i; b.onclick = () => go(i); r.appendChild(b);
  });
}
function markRail() { document.querySelectorAll('#rail button').forEach((b) => { const i = +b.dataset.i; b.classList.toggle('on', i === st.i); b.classList.toggle('done', i < st.i); }); $('progress-bar').style.width = `${(st.i / (STEPS.length - 1)) * 100}%`; }

// ------------------------------------------------------------------ runs
function run(sid, policy, opts = {}) { const { world } = islandFor(sid); return simulate(world, policy, 1, { ...opts, log: true }); }
function setupViews(sid, twin) {
  st.views.forEach((v) => v.dispose()); st.views = [];
  const isl = islandFor(sid);
  if (twin) { st.views.push(new View(isl, -900, 0), new View(isl, 900, 1)); }
  else st.views.push(new View(isl, 0, 0));
  st.twin = twin;
}
function startScenario(sid) {
  if (st.sid !== sid) { st.sid = sid; st.c3cls = SCN[sid].drift?.cls || null; }
  const s = SCN[sid];
  $('sc-title').textContent = `${s.title} · ${s.station}`; $('sc-date').textContent = `${s.weekday} ${s.date} · ${s.tz}`;
}
const t0Of = (sid) => SCN[sid].arrivalProfile[0].from;

// ------------------------------------------------------------------ step entry
async function go(i) {
  i = Math.max(0, Math.min(STEPS.length - 1, i));
  const prev = STEPS[st.i]; st.i = i; const S = STEPS[i];
  hide('choice'); hide('results'); hide('json-panel'); $('koottu').hidden = true; $('cut-badge').hidden = true; $('schema-badge').hidden = true;
  if (!['lift', 'why', 'raha'].includes(S.kind)) $('casefile').hidden = true;
  markRail();
  if (S.kind === 'title') { show('title'); setMode('globe'); labelLayer.style.visibility = 'hidden'; return; }
  hide('title'); labelLayer.style.visibility = '';
  if (S.kind === 'globe') { await fadeTo(() => { setMode('globe'); clearScenario(); }); caption('Five real disruptions', 'Three in India, two abroad. Each one is rebuilt from real OpenStreetMap data and replayed with real timelines. Click a city, or press → to begin with Chennai.', []); tweenCam(new THREE.Vector3(500, 700, 1500), new THREE.Vector3(0, 0, 0), 1.8); $('casefile').hidden = true; setPanelHead('', ''); $('kpis').innerHTML = ''; return; }
  if (S.kind === 'cards') { if (st.mode !== 'globe') await fadeTo(() => { setMode('globe'); clearScenario(); }); showCards(); return; }
  if (S.kind === 'finale') { await fadeTo(() => { clearScenario(); setMode('finale'); buildFinale(); }); return; }
  if (S.kind === 'business') { if (st.mode !== 'finale') await fadeTo(() => { clearScenario(); setMode('finale'); buildFinale(); }); showBusiness(); return; }
  const s = SCN[S.sid]; const sameScn = prev && prev.sid === S.sid;
  if (!sameScn || st.mode !== 'island') await fadeTo(() => { setMode('island'); startScenario(S.sid); setupViews(S.sid, false); });
  startScenario(S.sid);
  const t0 = t0Of(S.sid);
  if (S.kind === 'lift') {
    if (st.twin) setupViews(S.sid, false);
    const v = st.views[0]; v.setRun(run(S.sid, 'FREE_FOR_ALL', s.cut ? { cutAt: s.cut.at, reachAfter: s.cut.reachAfter } : {}), 'rush');
    v.setName(`${s.title} · ${s.station}<small>${s.weekday} ${s.date} · ${s.archetype}</small>`);
    st.t = t0 - 3; st.playing = true; rise(v.group);
    tweenCam(new THREE.Vector3(0, 1150, 1950), new THREE.Vector3(0, -80, 0), 2.2);
    caption(s.title, (s.memorial ? s.memorial + ' ' : '') + s.story.lift, s.what[1]?.s || s.what[0].s);
    openCase('what'); setPanelHead('As it happened', '');
  }
  if (S.kind === 'why') {
    if (st.twin) { setupViews(S.sid, false); st.views[0].setRun(run(S.sid, 'FREE_FOR_ALL', s.cut ? { cutAt: s.cut.at, reachAfter: s.cut.reachAfter } : {}), 'rush'); st.views[0].setName(`${s.title}<small>as it happened</small>`); }
    tweenCam(new THREE.Vector3(260, 520, 760), new THREE.Vector3(0, 0, 0), 2);
    caption('Why it happened', `${s.story.asIs} Read through the four lenses of crowd safety (Force, Information, Space, Time) plus the system and market causes.`, s.why.flatMap((w) => w.s).slice(0, 4));
    openCase('why'); setPanelHead('As it happened', '');
  }
  if (S.kind === 'split') {
    showChoice('Same people. Same vehicles. Same seed.', 'Replay with RAHA?', s.story.split, [['Split the island', () => doSplit(S.sid, false)]]);
  }
  if (S.kind === 'raha') {
    if (!st.twin) doSplit(S.sid, true);
    tweenCam(new THREE.Vector3(900 + 240, 430, 560), new THREE.Vector3(900, 0, 0), 2.2);
    caption('RAHA up close', s.story.omni, s.omni.length ? ['jin2016', 'fruin', 'surge_cap', 'shapley_rs'].filter((k) => SRC[k]) : []);
    openCase('raha'); $('koottu').hidden = false;
  }
  if (S.kind === 'c1') {
    setupViews(S.sid, true);
    const o = { cutAt: s.cut.at, reachAfter: s.cut.reachAfter };
    st.views[0].setRun(run(S.sid, 'RAHA', { ...o, arch: 'cloud' }), 'raha'); st.views[1].setRun(run(S.sid, 'RAHA', { ...o, arch: 'local' }), 'raha');
    st.views[0].setName('Cloud-only coordinator<small>internet cut at 12:33: allocation stops</small>'); st.views[1].setName('RAHA on the station edge node<small>UPS power, zero internet</small>');
    st.views.forEach((v) => { v.threads.visible = true; v.threads.children.forEach((l) => { l.position.set(0, 0, 0); l.material.opacity = 0.55; }); });
    st.views[1].edgeNode.visible = true;
    st.t = s.cut.at - 6; st.playing = true;
    tweenCam(new THREE.Vector3(0, 1700, 2700), new THREE.Vector3(0, 200, 0), 2.2);
    caption('Constraint 1: the internet is cut', `At ${clockOf(s.cut.at)} the grid and mobile data go (phones reach ${Math.round(s.cut.reachAfter * 100)}%). Left: a coordinator that lives in the cloud falls back to free-for-all. Right: RAHA keeps allocating on the station edge node; passes verify offline. This page itself makes zero external requests: see the badge.`, ['es_entsoe', 'es_net', 'localfirst', 'optus']);
    setPanelHead('Cloud-only', 'RAHA local');
  }
  if (S.kind === 'c3') {
    setupViews(S.sid, true); runC3(S.sid);
    tweenCam(new THREE.Vector3(0, 1500, 2500), new THREE.Vector3(0, 100, 0), 2.2);
    caption('Constraint 3: the API changes shape', 'Mid-incident, the bus feed renames, nests, retypes or drops the capacity field, sends garbage, or silently changes what a field means. Left: a naive parser. Right: RAHA\'s tolerant reader with invariants and a local vehicle registry. Pick a mutation in the panel.', ['fowler', 'mta', 'sydney_rt', 'espinha']);
    show('json-panel'); setPanelHead('Naive parser', 'RAHA adapter');
  }
  if (S.kind === 'results') { showResults(S.sid); caption(`${s.title}: measured`, `Each number is a mean over ${RESULTS?.stamp?.seeds ?? 'many'} seeded runs with a 95% bootstrap interval, from scripts/run_experiments.mjs and the same engine you just watched.`, ['lead_sim', 'bertsimas']); }
}
function doSplit(sid, silent) {
  hide('choice'); const s = SCN[sid];
  setupViews(sid, true);
  const cut = s.cut ? { cutAt: s.cut.at, reachAfter: s.cut.reachAfter } : {};
  st.views[0].setRun(run(sid, 'FREE_FOR_ALL', cut), 'rush'); st.views[1].setRun(run(sid, 'RAHA', { ...cut, arch: 'local' }), 'raha');
  st.views[0].setName(`As it happened<small>${POLICY_LABEL.FREE_FOR_ALL}</small>`); st.views[1].setName('With RAHA<small>fair, capacity-exact, offline-first</small>');
  st.t = t0Of(sid) - 2; st.playing = true;
  if (!silent) tweenCam(new THREE.Vector3(0, 1650, 2600), new THREE.Vector3(0, 120, 0), 2.4);
  caption('Two islands, one seed', s.story.split, []);
  setPanelHead('As it happened', 'RAHA'); $('koottu').hidden = false;
}
function runC3(sid) {
  const s = SCN[sid]; const cls = st.c3cls || 'rename';
  const o = { drift: { cls, at: s.drift.at } };
  st.views[0].setRun(run(sid, 'RAHA', { ...o, parser: 'naive' }), 'raha'); st.views[1].setRun(run(sid, 'RAHA', { ...o, parser: 'adapter' }), 'raha');
  st.views[0].setName(`Naive parser<small>feed mutation: ${cls}</small>`); st.views[1].setName(`RAHA tolerant reader<small>feed mutation: ${cls}</small>`);
  st.t = s.drift.at - 8; st.playing = true;
}

// ------------------------------------------------------------------ UI helpers
function show(id) { $(id).hidden = false; } function hide(id) { $(id).hidden = true; }
function setPanelHead(l, r) { $('lh').textContent = l; $('rh').textContent = r; }
function srcChips(ids) { return (ids || []).filter((k) => SRC[k]).map((k) => `<span class="src" data-src="${k}" title="${SRC[k].t}">${SRC[k].o}${SRC[k].d ? ' · ' + SRC[k].d.slice(0, 7) : ''}</span>`).join(''); }
function caption(title, text, src) { $('cap-title').textContent = title; $('cap-text').textContent = text; $('cap-src').innerHTML = srcChips(src); }
document.addEventListener('click', (e) => { const k = e.target?.dataset?.src; if (k) openSources(k); });
function showChoice(kicker, title, text, buttons) {
  $('choice-kicker').textContent = kicker; $('choice-title').textContent = title; $('choice-text').textContent = text;
  const row = $('choice-buttons'); row.innerHTML = '';
  for (const [label, fn] of buttons) { const b = document.createElement('button'); b.className = 'primary'; b.textContent = label; b.onclick = fn; row.appendChild(b); }
  show('choice');
}
let caseTab = 'what';
function openCase(tab) { caseTab = tab; $('casefile').hidden = false; renderCase(); }
function renderCase() {
  const s = SCN[st.sid]; if (!s) return; const body = $('tab-body');
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === caseTab));
  if (caseTab === 'what') body.innerHTML = `<div class="dim small" style="margin-bottom:6px">${s.headline}</div>` + s.what.map((w) => `<div class="tl"><div class="t">${w.t}</div><div>${w.x}<div>${srcChips(w.s)}</div></div></div>`).join('');
  if (caseTab === 'why') body.innerHTML = s.why.map((w) => `<div class="why"><span class="chip k-${w.k}">${w.k}</span>${w.x}<div>${srcChips(w.s)}</div></div>`).join('') + `<p class="small dim">Fruin's FIST model: crowd disasters come from Force, Information, Space and Time interacting, not from "panic". ${srcChips(['fruin', 'helbing2012'])}</p>`;
  if (caseTab === 'raha') body.innerHTML = `<ul style="padding-left:18px;margin:0">${s.omni.map((o) => `<li style="margin:4px 0">${o}</li>`).join('')}</ul><p class="small dim">Priority score = ${DATA.meta.weights.v}·V (vulnerability) + ${DATA.meta.weights.d}·D (deadline urgency) + ${DATA.meta.weights.w}·W (wait, never decreases) − ${DATA.meta.weights.c}·C (detour). Willingness to pay is never an input.</p>`;
  if (caseTab === 'data') {
    const g = GEO[s.id];
    body.innerHTML = `<p class="small">Map: ${g.stats.buildings} buildings, ${g.stats.roads} road segments, ${g.stats.rail} rail lines from OpenStreetMap (${g.fetched?.slice(0, 10) || ''}). Building heights: <span class="tier T1">T1</span>${g.stats.heightFromTag} tagged, <span class="tier T2">T2</span>${g.stats.heightFromLevels} from levels, <span class="tier T4">T4</span>${g.stats.heightDefault} default.</p>` +
      `<table class="params">${Object.entries(s.params).map(([k, p]) => `<tr><td><span class="tier ${p.tier}">${p.tier}</span>${k}</td><td class="v">${Array.isArray(p.v) ? p.v.join('–') : p.v}</td><td class="small dim">${p.how || ''} ${srcChips(p.s)}</td></tr>`).join('')}</table>` +
      `<div class="legend">${Object.entries(DATA.meta.tiers).map(([k, v]) => `<span><span class="tier ${k}">${k}</span>${v}</span>`).join('')}</div>`;
  }
}
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => { caseTab = b.dataset.tab; renderCase(); }));
function openSources(focus) {
  const s = SCN[st.sid]; const ids = new Set();
  if (s) { s.what.forEach((w) => w.s.forEach((x) => ids.add(x))); s.why.forEach((w) => w.s.forEach((x) => ids.add(x))); Object.values(s.params).forEach((p) => (p.s || []).forEach((x) => ids.add(x))); }
  Object.keys(SRC).forEach((k) => ids.add(k));
  $('drawer-body').innerHTML = `<h3>Sources</h3><p class="small dim">Opening a link needs the internet; everything the simulation uses is already bundled.</p>` + [...ids].map((k) => `<div class="srcitem" id="src-${k}" style="${k === focus ? 'background:rgba(255,181,71,.12)' : ''}"><b>${SRC[k].o}</b> ${SRC[k].d ? '· ' + SRC[k].d : ''}<br>${SRC[k].t}<br>${SRC[k].u ? `<a href="${SRC[k].u}" target="_blank" rel="noopener">${SRC[k].u}</a>` : ''}</div>`).join('');
  show('drawer'); if (focus) document.getElementById(`src-${focus}`)?.scrollIntoView({ block: 'center' });
}
$('drawer-close').onclick = () => hide('drawer');
$('btn-src').onclick = () => ($('drawer').hidden ? openSources() : hide('drawer'));
$('btn-case').onclick = () => { $('casefile').hidden = !$('casefile').hidden; renderCase(); };
$('btn-data').onclick = () => toggleData();
function toggleData() { openCase('data'); for (const v of st.views) { v.isl.base.buildings.visible = !v.isl.base.buildings.visible; v.isl.base.provenance.visible = !v.isl.base.buildings.visible; } }

// ------------------------------------------------------------------ KPI panel + Koottu + proofs
function renderKpis() {
  const vs = st.views; if (!vs.length || !vs[0].res) return;
  const K = vs.map((v) => v.kpis(st.t)); const twin = K.length > 1;
  const cur = SCN[st.sid].currency;
  const row = (label, f, better = 'low', d = 0) => {
    const a = K.map(f); let cls = ['', ''];
    if (twin && Number.isFinite(a[0]) && Number.isFinite(a[1]) && a[0] !== a[1]) { const rb = better === 'low' ? a[1] < a[0] : a[1] > a[0]; cls = rb ? ['badv', 'good'] : ['good', 'badv']; }
    return `<div class="kpi"><span class="k">${label}</span><span class="v ${twin ? cls[0] : ''}">${twin ? fmt(a[0], d) : ''}</span><span class="v ${twin ? cls[1] : ''}">${twin ? fmt(a[1], d) : fmt(a[0], d)}</span></div>`;
  };
  const losCell = (k) => `<span class="los" style="background:${LOS_COL[k.los] || '#334'}">${k.los}</span>`;
  let h = row('Waiting now', (k) => k.waiting) + row('Boarded / left', (k) => k.served, 'high') + row('Longest wait now (min)', (k) => k.worst) + row('Turned away at doors', (k) => k.turned) + row('Buses leaving empty', (k) => k.empty);
  h += `<div class="kpi"><span class="k">Peak door crowd (Fruin LOS)</span><span class="v">${twin ? losCell(K[0]) : ''}</span><span class="v">${losCell(K[twin ? 1 : 0])}</span></div>`;
  if (vs[0].isl.world.vehicles.some((x) => x.kind === 'cab')) {
    h += row('Cab riders', (k) => k.cabRiders, 'high') + row('Riders per cab', (k) => k.perCab, 'high', 2) + row(`Cab fare per rider (${cur})`, (k) => k.fare, 'low', cur === 'Rs' ? 0 : 2);
  }
  if (vs[0].isl.world.vehicles.some((x) => x.kind === 'bike')) h += row('Two-wheeler rides', (k) => k.bikes, 'high');
  h += row(`Waited > ${vs[0].isl.world.P.essentialsAfterMin} min`, (k) => k.ess);
  $('kpis').innerHTML = h;
  // Koottu panel: latest pooled cab on the RAHA side
  const rv = vs[vs.length - 1]; const kb = $('koottu');
  if (!kb.hidden && rv.mode === 'raha') {
    const s = SCN[st.sid]; const trips = rv.res.log.trips.filter((tr) => tr.kind === 'cab' && tr.n > 1 && tr.arr <= st.t);
    const last = trips[trips.length - 1]; const india = s.country === 'India';
    let html = `<h4>Koottu shared cabs (simulated)</h4>`;
    if (last) {
      html += `<div class="small dim">${clockOf(last.arr)} · ${last.n} riders · trusted circle #${last.circle + 1} · corridor ${s.corridors[last.ci]?.name || ''}</div>`;
      html += `<div class="small">Cheapest of ${last.n} phone quotes books: <b class="mono">${cur} ${fmt(last.booked)}</b> · surge ${fmt(last.surge, 2)}×</div>`;
      html += last.shares.map((x, j) => `<div class="split-row"><span>Rider ${j + 1} pays</span><span>${cur} ${fmt(x)}</span><span class="${x <= last.solos[j] + 1e-6 ? 'tick' : 'bad-txt'}">alone ${fmt(last.solos[j])} ${x <= last.solos[j] + 1e-6 ? '✓' : '✗'}</span></div>`).join('');
      html += `<div class="small" style="margin-top:4px">Fare check: ${india ? (last.surge <= 2 + 1e-9 ? `surge within the 2× legal cap <span class="tick">✓</span>` : '<span class="bad-txt">above the 2× legal cap</span>') : 'no statutory surge cap found: cannot check'} ${srcChips(india ? ['surge_cap'] : [])}</div>`;
      html += `<div class="small dim">Split: Shapley value of the drop-off order (airport game), then a direct check that nobody pays more than alone. ${srcChips(['airport_game', 'shapley_rs'])}</div>`;
    } else html += `<div class="small dim">Waiting for the first pooled cab…</div>`;
    const pr = refusalProof(rv); if (pr) html += `<h4 style="margin-top:10px">Refusal proof</h4><div class="small">${pr}</div>`;
    kb.innerHTML = html;
  }
  // C3 JSON panel
  const S = STEPS[st.i];
  if (S.kind === 'c3') renderJson(S.sid);
  if (S.kind === 'c1') { const s = SCN[S.sid]; $('cut-badge').hidden = st.t < s.cut.at; }
}
let proofCache = { key: '', html: '' };
function refusalProof(v) {
  // a rider still waiting whose corridor just had a departure without them: show why, checkably
  const L = v.res.log; const t = st.t; const w = v.isl.world;
  const recent = L.trips.filter((tr) => tr.kind === 'bus' && !tr.rush && tr.dep <= t && tr.dep > t - 8 && tr.n >= tr.cap);
  if (!recent.length) return proofCache.html;
  const tr = recent[recent.length - 1];
  const key = `${tr.v}|${tr.dep}`; if (proofCache.key === key) return proofCache.html;
  const present = L.pax.map((p, k) => [p, k]).filter(([p]) => p.ci === tr.ci && p.arr + p.walk <= tr.arr && (p.board < 0 || p.board >= tr.dep));
  if (present.length <= tr.n) return proofCache.html;
  const scored = present.map(([p, k]) => [k, score(p, tr.arr, w)]).sort((a, b) => b[1].S - a[1].S);
  const cut = scored[tr.n - 1][1].S; const me = scored[tr.n]; const sc = me[1];
  const rec = { vehicle: tr.v, departed: clockOf(tr.dep), seats: tr.cap, boarded: tr.n, cutoffScore: +cut.toFixed(2), rider: me[0], riderScore: +sc.S.toFixed(2), rank: tr.n + 1 };
  const html = `Bus #${tr.v} left at ${clockOf(tr.dep)} with ${tr.n}/${tr.cap} seats filled by riders scoring ≥ ${fmt(cut, 1)}. Rider #${me[0]} scored <b>${fmt(sc.S, 1)}</b> = ${DATA.meta.weights.v}×${fmt(sc.V, 2)} V + ${DATA.meta.weights.d}×${fmt(sc.D, 2)} D + ${DATA.meta.weights.w}×${fmt(sc.W, 2)} W and ranked #${tr.n + 1}. Next pass is guaranteed by the rising wait term. <span class="mono dim" id="proof-hash">record hash …</span>`;
  proofCache = { key, html };
  if (crypto?.subtle) crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rec))).then((b) => { const hx = [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 20); proofCache.html = proofCache.html.replace('record hash …', `SHA-256 ${hx}…`); const el = $('proof-hash'); if (el) el.textContent = `SHA-256 ${hx}…`; });
  return html;
}
function renderJson(sid) {
  const s = SCN[sid]; const cls = st.c3cls; const v = { id: 7, cap: 120 }; const t = st.t;
  const msg = providerMessage(v, t, 0); const drifted = t >= s.drift.at;
  const rnd = mulberry(Math.floor(t)); const raw = drifted ? mutate(msg, cls, rnd) : JSON.stringify(msg);
  let naive; try { const r = naiveParse(raw); naive = `capacity − occupied = <b class="${Number.isFinite(r.capacity - r.occupied) && r.capacity - r.occupied <= 120 ? 'ok-txt' : 'bad-txt'}">${r.capacity - r.occupied}</b>, eta ${fmt(r.etaMin, 1)} min`; } catch (e) { naive = `<b class="bad-txt">throws: ${e.message.slice(0, 60)}</b>`; }
  const ad = makeAdapter(new Map([[7, 120]])); const r2 = ad.read(raw, 7);
  const rep = Object.entries(ad.report).filter(([, x]) => x).map(([k, x]) => `${k} ${x}`).join(', ') || 'clean';
  $('schema-badge').hidden = false; $('schema-text').textContent = drifted ? `drifted: ${cls}` : 'v1'; $('schema-badge').className = `badge ${drifted ? 'warn' : ''}`;
  $('json-panel').innerHTML = `<h4>Provider feed (Constraint 3)</h4><div class="cls-row">${DRIFT_CLASSES.map((c) => `<button data-cls="${c}" class="${c === cls ? 'on' : ''}">${c}</button>`).join('')}</div>
    <div class="small dim">${drifted ? `Mutation active since ${clockOf(s.drift.at)}` : `Mutation arrives at ${clockOf(s.drift.at)}`}</div><pre>${raw.replace(/</g, '&lt;')}</pre>
    <div class="cols2"><div><b>Naive parser</b><br>${naive}</div><div><b>RAHA adapter</b><br>capacity <b class="ok-txt">${r2.capacity}</b>${r2.degraded ? ' (fallback)' : ''}, eta ${fmt(r2.etaMin, 1)} min<br><span class="dim">${rep}</span></div></div>
    <div class="small dim" style="margin-top:6px">Tolerant reader (alias paths, coercion), invariants against semantic drift, last-known-good and a local vehicle registry. ${srcChips(['fowler', 'mta'])}</div>`;
  $('json-panel').querySelectorAll('button[data-cls]').forEach((b) => (b.onclick = () => { st.c3cls = b.dataset.cls; runC3(sid); }));
}
function showResults(sid) {
  const R = RESULTS?.scenarios?.[sid]; const box = $('results'); show('results');
  if (!R) { box.innerHTML = '<h4>Results</h4><p>Run <code>node scripts/run_experiments.mjs</code> to produce data/results.json.</p>'; return; }
  const pols = Object.keys(R.main); const cur = SCN[sid].currency;
  const rows = [['worstWait', 'Worst-off wait (min)', 'low'], ['p95Wait', 'p95 wait (min)', 'low'], ['meanWait', 'Mean wait (min)', 'low'], ['wheelchairP95', 'Wheelchair p95 wait (min)', 'low'], ['deadlinesMet', 'Deadlines met (share)', 'high'], ['turnedAway', 'Turned away at doors', 'low'], ['peakDoorDensity', 'Peak door density (p/m²)', 'low'], ['gini', 'Gini of waits', 'low'], ['unserved', 'Unserved at horizon', 'low'], ['ridersPerCab', 'Riders per cab', 'high'], ['cabFarePerRider', `Cab fare per rider (${cur})`, 'low'], ['clearanceMin', 'Clearance (min)', 'low']];
  let h = `<h4>${SCN[sid].title}: ${R.stamp.seeds} seeds per policy · mean [95% CI] · sanity bound ${fmt(R.sanityBoundMin)} min</h4><table><tr><th>Metric</th>${pols.map((p) => `<th>${p === 'RAHA' ? '<b style="color:#ffb547">RAHA</b>' : p.replace('_', ' ')}</th>`).join('')}</tr>`;
  for (const [k, label, better] of rows) {
    const vals = pols.map((p) => R.main[p][k]); if (vals.every((x) => !x)) continue;
    const means = vals.map((x) => (x ? x[0] : null)); const best = better === 'low' ? Math.min(...means.filter((x) => x != null)) : Math.max(...means.filter((x) => x != null));
    h += `<tr><td>${label}</td>${vals.map((x) => `<td class="${x && x[0] === best ? 'best' : ''}">${x ? fmt(x[0], x[0] < 10 ? 2 : 0) : '–'}<br><span class="ci">[${x ? fmt(x[1], x[1] < 10 ? 2 : 0) : ''}, ${x ? fmt(x[2], x[2] < 10 ? 2 : 0) : ''}]</span></td>`).join('')}</tr>`;
  }
  h += '</table>';
  if (R.c1) { h += `<h4 style="margin-top:12px">Constraint 1: internet cut, phone reach sweep (worst-off wait min · turned away)</h4><table><tr><th>Reach</th>${Object.keys(R.c1.reach_1).map((k) => `<th>${k.replace('_', ' ')}</th>`).join('')}</tr>${Object.entries(R.c1).map(([rk, row]) => `<tr><td>${rk.replace('reach_', '')}</td>${Object.values(row).map((x) => `<td>${fmt(x.worstWait[0])} · ${fmt(x.turnedAway[0])}</td>`).join('')}</tr>`).join('')}</table>`; }
  if (R.c3) { h += `<h4 style="margin-top:12px">Constraint 3: feed mutation (empty departures · turned away · worst wait)</h4><table><tr><th>Mutation</th><th>Naive parser</th><th>RAHA adapter</th></tr>${Object.entries(R.c3).map(([c, x]) => `<tr><td>${c}</td><td class="bad-txt">${fmt(x.naive.emptyDepartures?.[0] ?? 0)} · ${fmt(x.naive.turnedAway[0])} · ${fmt(x.naive.worstWait[0])}</td><td class="ok-txt">${fmt(x.adapter.emptyDepartures?.[0] ?? 0)} · ${fmt(x.adapter.turnedAway[0])} · ${fmt(x.adapter.worstWait[0])}</td></tr>`).join('')}</table>`; }
  h += `<p class="small dim">Baselines: free-for-all (status quo), digital first-come-first-served, market pricing (highest bidder) and pure throughput. Synthetic riders drawn from real counts and distributions; every input carries a data tier (Data tab). Generated ${R.stamp.date?.slice(0, 10)} · commit ${R.stamp.commit}.</p>`;
  box.innerHTML = h;
}

// ------------------------------------------------------------------ the two constraint cards (how RAHA adapts, where the sim proves it)
function showCards() {
  const C = DATA.constraints; const box = $('results'); show('results');
  const c1 = RESULTS?.scenarios?.atocha?.c1, c3 = RESULTS?.scenarios?.jurong?.c3;
  const c1line = c1 ? `Measured (Madrid blackout, internet cut, phones at 30%): worst-off wait cloud-only ${fmt(c1['reach_0.3'].RAHA_cloud.worstWait[0])} min vs RAHA local ${fmt(c1['reach_0.3'].RAHA_local.worstWait[0])} min; turned away ${fmt(c1['reach_0.3'].RAHA_cloud.turnedAway[0])} vs ${fmt(c1['reach_0.3'].RAHA_local.turnedAway[0])}.` : '';
  const c3sum = c3 ? Object.entries(c3).map(([k, x]) => `${k}: ${fmt(x.naive.emptyDepartures?.[0] ?? 0)}→${fmt(x.adapter.emptyDepartures?.[0] ?? 0)} empty buses`).join(' · ') : '';
  const card = (c, measured, jump) => `<div class="glass" style="padding:14px 16px"><div class="kicker" style="color:#ffb547;font-size:11px;letter-spacing:.12em">${c.id}</div><h3 style="margin:4px 0 6px">${c.title}</h3><p class="small dim" style="margin:0 0 8px">${c.card}</p>
    <b class="small">How RAHA adapts (product)</b><ul class="small" style="margin:4px 0 8px;padding-left:18px">${c.product.map((x) => `<li>${x}</li>`).join('')}</ul>
    <b class="small">How the simulation proves it</b><ul class="small" style="margin:4px 0 8px;padding-left:18px">${c.sim.map((x) => `<li>${x}</li>`).join('')}</ul>
    ${measured ? `<div class="small ok-txt">${measured}</div>` : ''}<div>${srcChips(c.s)}</div><div class="row" style="justify-content:flex-start"><button class="primary" data-jump="${jump}">Watch it live</button></div></div>`;
  box.innerHTML = `<h4>The two constraint cards we drew, and how RAHA adapts</h4><div class="cols2">${card(C[0], c1line, 'c1')}${card(C[1], c3sum ? `Measured (Singapore line closure, 200 seeds): ${c3sum}` : '', 'c3')}</div>`;
  box.querySelectorAll('button[data-jump]').forEach((b) => (b.onclick = () => go(STEPS.findIndex((S) => S.kind === b.dataset.jump))));
  caption('Two constraint cards', 'Constraint 1: no internet or third-party APIs. Constraint 3: an API changes its response shape. Both are built into the product and tested in the simulation, live and over 200 seeds.', ['localfirst', 'fowler']);
  tweenCam(new THREE.Vector3(300, 500, 1500), new THREE.Vector3(0, 0, 0), 1.6);
}

// ------------------------------------------------------------------ judge check: run both constraint tests live, in this browser
async function judgeCheck() {
  hide('title'); const box = $('results'); show('results'); box.innerHTML = '<h4>Judge check: running…</h4>';
  const ok = (b) => (b ? '<span class="tick">✓ pass</span>' : '<span class="bad-txt">✗ fail</span>');
  const rows = []; let all = true; const add = (name, pass, detail) => { all = all && pass; rows.push(`<tr><td>${name}</td><td style="text-align:left">${detail}</td><td>${ok(pass)}</td></tr>`); };
  // ---- Constraint 1
  add('C1 · external requests made by this page', window.__rahaNet() === 0, `${window.__rahaNet()} (every outside call is counted and blocked)`);
  window.__rahaTesting = true; let blocked = false;
  try { await fetch('https://example.com/raha-offline-probe'); } catch (e) { blocked = /RAHA offline/.test(e.message); } finally { window.__rahaTesting = false; }
  add('C1 · a live call to example.com is blocked', blocked, blocked ? 'rejected locally: "external request blocked"' : 'was not blocked');
  let cache = null;
  if (navigator.serviceWorker?.controller) cache = await new Promise((res) => { const h = (ev) => { if (ev.data?.type === 'raha-cache-status') { navigator.serviceWorker.removeEventListener('message', h); res(ev.data); } }; navigator.serviceWorker.addEventListener('message', h); navigator.serviceWorker.controller.postMessage('raha-cache-status'); setTimeout(() => res(null), 2500); });
  add('C1 · whole site cached for offline reload', !!cache && cache.cached >= cache.total, cache ? `${cache.cached}/${cache.total} files in ${cache.version}` : 'service worker not active yet (reload once over HTTPS or localhost)');
  add('C1 · network status right now', true, navigator.onLine ? 'online (switch Wi-Fi off and press J again: everything below still runs)' : '<b>offline</b>: the simulation is still running');
  if (GEO.atocha) {
    const s = SCN.atocha; const w = islandFor('atocha').world; const o = { cutAt: s.cut.at, reachAfter: s.cut.reachAfter };
    const a = simulate(w, 'RAHA', 1, { ...o, arch: 'cloud' }), b = simulate(w, 'RAHA', 1, { ...o, arch: 'local' });
    add('C1 · RAHA keeps allocating with the internet cut (Madrid blackout, seed 1)', b.turnedAway === 0 && b.worstWait <= a.worstWait, `cloud-only: worst wait ${fmt(a.worstWait)} min, ${fmt(a.turnedAway)} turned away · RAHA edge node: ${fmt(b.worstWait)} min, ${fmt(b.turnedAway)} turned away`);
  }
  // ---- Constraint 3
  const msg = providerMessage({ id: 7, cap: 120 }, 600, 0);
  for (const cls of DRIFT_CLASSES) {
    let naiveOk = false, naiveTxt = '', adOk = false, adTxt = '';
    for (let rep = 0; rep < 6; rep++) { // several draws per class (some mutations are random)
      const raw = mutate(msg, cls, mulberry(rep * 31 + 7));
      try { const r = naiveParse(raw); const v = r.capacity - r.occupied; const good = v === 120 && r.etaMin >= -10 && r.etaMin <= 240; naiveOk = rep === 0 ? good : naiveOk && good; if (!good) naiveTxt = `reads ${Number.isNaN(v) ? 'NaN' : v} seats${r.etaMin > 240 ? `, ETA ${fmt(r.etaMin / 60 / 24 / 365, 0)} years` : ''}`; }
      catch (e) { naiveOk = false; naiveTxt = 'throws'; }
      const ad = makeAdapter(new Map([[7, 120]])); const r2 = ad.read(raw, 7); const g2 = r2.capacity === 120 && Math.abs(r2.etaMin) < 240;
      adOk = rep === 0 ? g2 : adOk && g2; adTxt = `${r2.capacity} seats · ${Object.entries(ad.report).filter(([, x]) => x).map(([k]) => k).join(', ') || 'clean'}`;
    }
    add(`C3 · ${cls}`, adOk, `naive parser: <span class="${naiveOk ? 'ok-txt' : 'bad-txt'}">${naiveOk ? 'ok' : naiveTxt}</span> · RAHA adapter: <span class="ok-txt">${adTxt}</span>`);
  }
  if (GEO.jurong) {
    const w = islandFor('jurong').world; const at = SCN.jurong.drift.at;
    const a = simulate(w, 'RAHA', 1, { drift: { cls: 'rename', at }, parser: 'naive' }), b = simulate(w, 'RAHA', 1, { drift: { cls: 'rename', at }, parser: 'adapter' });
    add('C3 · whole incident with a renamed field (Singapore line closure, seed 1)', b.emptyDepartures <= a.emptyDepartures && b.turnedAway === 0, `naive: ${fmt(a.emptyDepartures)} buses left empty, worst wait ${fmt(a.worstWait)} min · adapter: ${fmt(b.emptyDepartures)} empty, worst wait ${fmt(b.worstWait)} min`);
  }
  // ---- determinism (every number is re-runnable)
  const w = islandFor('tambaram').world; const strip = (r) => JSON.stringify({ ...r, log: undefined });
  const h = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 16);
  const h1 = await h(strip(simulate(w, 'RAHA', 42))), h2 = await h(strip(simulate(w, 'RAHA', 42)));
  add('Same seed, same result (re-runnable evidence)', h1 === h2, `seed 42 → ${h1} twice`);
  box.innerHTML = `<h4>Judge check · run live in this browser · ${new Date().toLocaleTimeString()}</h4><table><tr><th>Check</th><th style="text-align:left">Result</th><th></th></tr>${rows.join('')}</table><p class="small" style="margin-top:8px">${all ? '<span class="tick">All constraint checks passed.</span>' : '<span class="bad-txt">Some checks failed: see above.</span>'} Press J again after switching the network off.</p>`;
  caption('Judge check', 'Both constraint cards are tested live: blocked network calls, the offline cache, a cut internet, and all six API mutations against the real parser code.', ['localfirst', 'fowler']);
}
$('btn-judge').onclick = () => judgeCheck();

// ------------------------------------------------------------------ business case (value computed from the measured results)
function showBusiness() {
  const B = DATA.business; const box = $('results'); show('results');
  let h = `<h4>Business case: who pays, why it is viable</h4><p class="small">${B.thesis}</p>`;
  h += `<table><tr><th>Measured value per incident (mean of 200 seeds)</th><th>Rider-hours saved</th><th>Turned away avoided</th><th>Cab trips avoided</th><th>Saved by pooled riders</th><th>Deadlines met</th></tr>`;
  for (const s of DATA.scenarios) {
    const R = RESULTS?.scenarios?.[s.id]?.main; if (!R) continue; const f = R.FREE_FOR_ALL, r = R.RAHA;
    const hours = ((f.meanWait[0] - r.meanWait[0]) * RESULTS.scenarios[s.id].N) / 60;
    const cabRiders = r.cabTrips[0] * r.ridersPerCab[0]; const avoided = r.ridersPerCab[0] > 0 ? cabRiders - r.cabTrips[0] : 0;
    const saved = cabRiders * Math.max(0, r.cabSoloPerRider[0] - r.cabFarePerRider[0]);
    h += `<tr><td>${s.title}</td><td>${fmt(hours)}</td><td>${fmt(f.turnedAway[0])}</td><td>${fmt(avoided)}</td><td>${s.currency} ${fmt(saved)}</td><td>${f.deadlinesMet?.[0] != null ? `${fmt(f.deadlinesMet[0] * 100)}% → <b>${fmt(r.deadlinesMet[0] * 100)}%</b>` : '–'}</td></tr>`;
  }
  h += `</table><div class="cols2" style="margin-top:10px">${B.streams.map((x) => `<div class="glass" style="padding:10px 12px"><b>${x.who}</b> <span class="dim small">${x.model}</span><div class="small">${x.why}</div><div>${srcChips(x.s)}</div></div>`).join('')}</div>`;
  h += `<p class="small"><b>Go to market:</b> ${B.gtm}</p><p class="small"><b>Proof the market pays:</b> ${B.proof.map((p) => `${p.x} ${srcChips(p.s)}`).join(' ')}</p><p class="small dim"><b>Risks:</b> ${B.risks}</p>`;
  box.innerHTML = h;
  caption('Business case', 'Free for riders, paid by the operators who own the problem. Every value above is measured by the same engine on the five real incidents.', ['via_ipo', 'ir_amenities', 'ir_76']);
}

// ------------------------------------------------------------------ finale
function buildFinale() {
  finaleRoot.clear(); clearLabels((L) => L.el.classList.contains('fin'));
  const ids = DATA.scenarios.filter((s) => GEO[s.id]).map((s) => s.id);
  ids.forEach((sid, i) => {
    const isl = islandFor(sid); const g = isl.base.group.clone(); const a = (i / ids.length) * Math.PI * 2;
    g.scale.setScalar(0.5); g.position.set(Math.cos(a) * 1500, Math.sin(i * 1.7) * 120, Math.sin(a) * 1500); finaleRoot.add(g);
    const R = RESULTS?.scenarios?.[sid]?.main; let line = '';
    if (R) { const ffa = R.FREE_FOR_ALL, rh = R.RAHA; line = `worst wait ${fmt(ffa.worstWait[0])} → <b>${fmt(rh.worstWait[0])}</b> min · turned away ${fmt(ffa.turnedAway[0])} → <b>${fmt(rh.turnedAway[0])}</b>${rh.ridersPerCab?.[0] ? ` · ${fmt(rh.ridersPerCab[0], 2)} riders/cab` : ''}`; }
    const an = new THREE.Object3D(); an.position.set(0, -500, 0); g.add(an);
    addLabel(an, `${SCN[sid].title}<small>${line || SCN[sid].date}</small>`, 'big fin');
  });
  tweenCam(new THREE.Vector3(0, 2300, 3600), new THREE.Vector3(0, -200, 0), 2.6);
  caption('One engine. Five real cities.', 'Fair, capacity-exact, offline-first recovery: bridging buses, Koottu shared cabs, geofenced two-wheeler and essentials dispatch. Every number has a source: press S.', ['osm', 'lead_sim']);
  setPanelHead('', ''); $('kpis').innerHTML = ''; $('casefile').hidden = true;
}

// ------------------------------------------------------------------ modes, camera, transitions
function setMode(m) { st.mode = m; globe.group.visible = m === 'globe'; islandRoot.visible = m === 'island'; finaleRoot.visible = m === 'finale'; sky.setNight(m === 'globe' ? 0.92 : 0.62); scene.fog.density = m === 'globe' ? 0.00002 : 0.00011; labels.forEach((L) => {}); }
function clearScenario() { st.views.forEach((v) => v.dispose()); st.views = []; st.sid = null; $('sc-title').textContent = 'Five real disruptions'; $('sc-date').textContent = ''; $('clock').textContent = ''; }
function tweenCam(pos, target, dur) { st.tween = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: target, k: 0, dur }; }
async function fadeTo(fn) { const f = $('fade'); f.style.opacity = 1; await new Promise((r) => setTimeout(r, 450)); try { fn(); } catch (e) { console.error(e); } finally { await new Promise((r) => setTimeout(r, 60)); f.style.opacity = 0; } }
function rise(group) { st.rise = { g: group, k: 0 }; group.position.y = -1400; }
function jumpTo(sid) { const i = STEPS.findIndex((S) => S.sid === sid && S.kind === 'lift'); if (i >= 0) go(i); }

// ------------------------------------------------------------------ input
$('begin').onclick = () => go(1);
$('next').onclick = () => go(st.i + 1); $('prev').onclick = () => go(st.i - 1);
$('play').onclick = () => { st.playing = !st.playing; $('play').innerHTML = st.playing ? '&#10073;&#10073;' : '&#9654;'; };
$('speed').onchange = (e) => (st.speed = +e.target.value);
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT') return;
  if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); if (!$('choice').hidden) $('choice-buttons').querySelector('button')?.click(); else go(st.i + 1); }
  else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); go(st.i - 1); }
  else if (e.key === 'p' || e.key === 'P') $('play').click();
  else if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('hide-ui');
  else if (e.key === 's' || e.key === 'S') $('btn-src').click();
  else if (e.key === 'c' || e.key === 'C') $('btn-case').click();
  else if (e.key === 'd' || e.key === 'D') toggleData();
  else if (e.key === 'f' || e.key === 'F') go(STEPS.findIndex((S) => S.kind === 'finale'));
  else if (e.key === 'j' || e.key === 'J') judgeCheck();
  else if (/^[1-5]$/.test(e.key)) { const s = DATA.scenarios[+e.key - 1]; if (s) jumpTo(s.id); }
  else if (e.key === 'Escape') { hide('drawer'); }
});

// ------------------------------------------------------------------ loop
buildRail(); setMode('globe'); $('loading').remove(); labelLayer.style.visibility = 'hidden';
camera.position.set(400, 650, 1700); controls.target.set(0, 0, 0);
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (st.tween) { const T = st.tween; T.k = Math.min(1, T.k + dt / T.dur); const e = ease(T.k); camera.position.lerpVectors(T.p0, T.p1, e); controls.target.lerpVectors(T.t0, T.t1, e); if (T.k >= 1) st.tween = null; }
  if (st.rise) { const R = st.rise; R.k = Math.min(1, R.k + dt / 2.4); R.g.position.y = -1400 * (1 - (1 - Math.pow(1 - R.k, 3))); if (R.k >= 1) st.rise = null; }
  if (st.mode === 'globe') { globe.group.rotation.y += dt * 0.05; beacons.forEach(({ b }, i) => { const r = b.userData.ring; const k = (now / 1000 + i * 0.3) % 1.6; r.scale.setScalar(1 + k * 2); r.material.opacity = 1 - k / 1.6; }); }
  if (st.mode === 'finale') finaleRoot.rotation.y += dt * 0.04;
  if (st.mode === 'island' && st.views.length) {
    const s = SCN[st.sid]; const hz = s.params.horizonMin.v;
    if (st.playing) st.t = Math.min(hz, st.t + dt * st.speed);
    $('clock').textContent = `${clockOf(st.t)} ${s.tz}`;
    for (const v of st.views) v.update(st.t, dt);
    // Constraint 1: threads snap at the cut and fall away
    if (s.cut) for (const v of st.views) if (v.threads.visible && st.t >= s.cut.at) v.threads.children.forEach((l) => { l.position.addScaledVector(l.userData.v, dt); l.material.opacity = Math.max(0, l.material.opacity - dt * 0.4); });
    for (const v of st.views) if (v.edgeNode.visible) v.edgeNode.material.opacity = 0.55 + 0.4 * Math.sin(now / 300);
    if (now - st.lastKpi > 250) { st.lastKpi = now; renderKpis(); }
  }
  controls.update();
  composer.render();
  drawLabels();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.__raha = { st, STEPS, go };
