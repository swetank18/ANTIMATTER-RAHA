// RAHA scene builders: sky, globe, floating islands from real OSM data, agents, vehicles, effects.
// Everything is generated in code (no textures, no models, no network): Constraint 1 by construction.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const COLORS = {
  corridor: ['#56B4E9', '#E69F00', '#009E73', '#F0E442', '#CC79A7', '#D55E00', '#0072B2'], // Okabe-Ito
  stranded: new THREE.Color('#ff5a4e'), waiting: new THREE.Color('#ffb547'), walker: new THREE.Color('#ffd9a8'),
  vulnerable: new THREE.Color('#ffffff'), cab: new THREE.Color('#ffd400'), bus: new THREE.Color('#e9eef7'), train: new THREE.Color('#9fb4ff'),
};

// ------------------------------------------------------------------ renderer
export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0b1030, 0.00011);
  const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 1, 60000);
  camera.position.set(0, 900, 2400);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.06; controls.maxDistance = 9000; controls.minDistance = 60;
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2), 0.75, 0.55, 0.62);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight); composer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);
  scene.add(new THREE.HemisphereLight(0x9db4ff, 0x1a1020, 0.9));
  const moon = new THREE.DirectionalLight(0xc9d6ff, 1.6); moon.position.set(-1200, 2200, 900); scene.add(moon);
  const warm = new THREE.DirectionalLight(0xff9a5a, 0.55); warm.position.set(1800, 300, -1400); scene.add(warm);
  return { renderer, scene, camera, controls, composer, bloom };
}

// ------------------------------------------------------------------ sky: dusk-to-night gradient + stars
export function makeSky(scene) {
  const g = new THREE.SphereGeometry(30000, 48, 24);
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uNight: { value: 0.6 }, uTime: { value: 0 } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `varying vec3 vP; uniform float uNight; uniform float uTime;
      void main(){ float h = vP.y;
        vec3 top = mix(vec3(0.10,0.12,0.30), vec3(0.015,0.02,0.07), uNight);
        vec3 mid = mix(vec3(0.42,0.25,0.42), vec3(0.06,0.06,0.18), uNight);
        vec3 hor = mix(vec3(1.00,0.55,0.30), vec3(0.32,0.16,0.26), uNight);
        vec3 c = h > 0.0 ? mix(mid, top, smoothstep(0.0,0.65,h)) : mix(mid, vec3(0.01,0.01,0.03), smoothstep(0.0,-0.5,h));
        c = mix(c, hor, exp(-abs(h)*7.0)*0.85);
        gl_FragColor = vec4(c,1.0); }`,
  });
  const sky = new THREE.Mesh(g, m); scene.add(sky);
  const n = 2400, pos = new Float32Array(n * 3); const rnd = mulberry(11);
  for (let i = 0; i < n; i++) { const u = rnd() * 2 - 1, t = rnd() * Math.PI * 2, r = 24000; const s = Math.sqrt(1 - u * u); pos.set([r * s * Math.cos(t), Math.abs(r * u) * 0.95 + 400, r * s * Math.sin(t)], i * 3); }
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const stars = new THREE.Points(sg, new THREE.PointsMaterial({ size: 28, color: 0xdfe8ff, transparent: true, opacity: 0.85, fog: false, depthWrite: false }));
  scene.add(stars);
  return { sky, stars, setNight: (v) => (m.uniforms.uNight.value = v) };
}
export function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ------------------------------------------------------------------ globe (Natural Earth, real coastlines and cities)
export function latLonToVec3(lat, lon, r) {
  const phi = (90 - lat) * Math.PI / 180, th = (lon + 180) * Math.PI / 180;
  return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(th), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(th));
}
function pointInRing(x, y, ring) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; }
export function makeGlobe(land, places, R = 600) {
  const group = new THREE.Group();
  const core = new THREE.Mesh(new THREE.SphereGeometry(R * 0.985, 64, 48), new THREE.MeshStandardMaterial({ color: 0x07102a, roughness: 0.9, metalness: 0.1, emissive: 0x050b20 }));
  group.add(core);
  const atm = new THREE.Mesh(new THREE.SphereGeometry(R * 1.06, 64, 48), new THREE.ShaderMaterial({ transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: 'varying vec3 vN; void main(){ vN = normalize(normalMatrix*normal); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: 'varying vec3 vN; void main(){ float i = pow(0.72 - dot(vN, vec3(0,0,1.0)), 3.0); gl_FragColor = vec4(0.35,0.55,1.0,1.0)*i; }' }));
  group.add(atm);
  // land dots: sample a lat/lon grid and keep points inside Natural Earth land polygons
  const polys = [];
  for (const f of land.features) { const g = f.geometry; const rings = g.type === 'Polygon' ? [g.coordinates] : g.coordinates; for (const p of rings) { const ring = p[0]; let a = 180, b = -180, c = 90, d = -90; for (const [x, y] of ring) { a = Math.min(a, x); b = Math.max(b, x); c = Math.min(c, y); d = Math.max(d, y); } polys.push({ ring, a, b, c, d }); } }
  const dots = [];
  for (let lat = -84; lat <= 84; lat += 1.15) { const step = 1.15 / Math.max(0.2, Math.cos(lat * Math.PI / 180)); for (let lon = -180; lon < 180; lon += step) { for (const p of polys) { if (lon < p.a || lon > p.b || lat < p.c || lat > p.d) continue; if (pointInRing(lon, lat, p.ring)) { dots.push(latLonToVec3(lat, lon, R)); break; } } } }
  const dg = new THREE.BufferGeometry().setFromPoints(dots);
  group.add(new THREE.Points(dg, new THREE.PointsMaterial({ size: 4.2, color: 0x3d5aa8, transparent: true, opacity: 0.9 })));
  // city lights (Natural Earth populated places, sized by population)
  const lp = [], lc = []; const warm = new THREE.Color('#ffc46b');
  for (const f of places.features) { const [lon, lat] = f.geometry.coordinates; const pop = f.properties.pop_max || 1e4; const v = latLonToVec3(lat, lon, R * 1.003); lp.push(v.x, v.y, v.z); const k = Math.min(1, Math.log10(pop) / 7.3); lc.push(warm.r * k, warm.g * k, warm.b * k); }
  const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3)); lg.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
  group.add(new THREE.Points(lg, new THREE.PointsMaterial({ size: 6, vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })));
  return { group, R };
}
export function makeBeacon(color = '#ff5a4e') {
  const g = new THREE.Group();
  const c = new THREE.Color(color);
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 90, 8, 1, true), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
  pillar.position.y = 45; g.add(pillar);
  const ring = new THREE.Mesh(new THREE.RingGeometry(6, 9, 40), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.9, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; g.add(ring);
  g.userData.ring = ring;
  return g;
}

// ------------------------------------------------------------------ island from a real OSM pack
const toV = (p) => [p[0], -p[1]]; // OSM (east, north) -> three (x, z)
function ribbonGeometry(lines, width, y) {
  const pos = [];
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      const [x1, z1] = toV(line[i]), [x2, z2] = toV(line[i + 1]);
      const dx = x2 - x1, dz = z2 - z1, L = Math.hypot(dx, dz) || 1; const nx = (-dz / L) * width / 2, nz = (dx / L) * width / 2;
      pos.push(x1 + nx, y, z1 + nz, x2 + nx, y, z2 + nz, x2 - nx, y, z2 - nz, x1 + nx, y, z1 + nz, x2 - nx, y, z2 - nz, x1 - nx, y, z1 - nz);
    }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
  return g;
}
function polyMesh(polys, color, y, opacity = 1) {
  const geos = [];
  for (const poly of polys) { if (poly.length < 3) continue; const shape = new THREE.Shape(poly.map((p) => new THREE.Vector2(p[0], p[1]))); const g = new THREE.ShapeGeometry(shape); g.rotateX(-Math.PI / 2); g.translate(0, y, 0); geos.push(g); }
  if (!geos.length) return null;
  const merged = mergeGeos(geos);
  return new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color, roughness: 1, transparent: opacity < 1, opacity }));
}
function mergeGeos(geos) {
  const flat = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let n = 0; for (const g of flat) n += g.attributes.position.array.length;
  const pos = new Float32Array(n); let o = 0;
  for (const gi of flat) { pos.set(gi.attributes.position.array, o); o += gi.attributes.position.array.length; }
  const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, o), 3)); out.computeVertexNormals(); return out;
}
function buildingsMesh(buildings, palette) {
  // buildings: [heightSrc, h, x0,y0, x1,y1, ...]  -> one merged geometry with vertex colours
  const pos = [], col = [];
  const c0 = new THREE.Color(palette.base), cTop = new THREE.Color(palette.top), cSrc = [new THREE.Color('#7ee0a8'), new THREE.Color('#7fc3ff'), new THREE.Color(palette.base)];
  for (const b of buildings) {
    const src = b[0], h = Math.max(3, b[1]); const pts = []; for (let i = 2; i < b.length; i += 2) pts.push(toV([b[i], b[i + 1]]));
    if (pts.length < 3) continue;
    const wallC = palette.provenance ? cSrc[src] : c0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length];
      pos.push(x1, 0, z1, x2, 0, z2, x2, h, z2, x1, 0, z1, x2, h, z2, x1, h, z1);
      const shade = 0.75 + 0.25 * Math.abs(Math.sin(Math.atan2(z2 - z1, x2 - x1)));
      for (let k = 0; k < 6; k++) col.push(wallC.r * shade, wallC.g * shade, wallC.b * shade);
    }
    const tris = THREE.ShapeUtils.triangulateShape(pts.map(([x, z]) => new THREE.Vector2(x, z)), []);
    for (const t of tris) for (const k of t) { pos.push(pts[k][0], h, pts[k][1]); col.push(cTop.r, cTop.g, cTop.b); }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide }));
}
function rockUnderside(R, seed) {
  const H = R * 0.95; const g = new THREE.ConeGeometry(R, H, 72, 18, true); g.rotateX(Math.PI); g.translate(0, -H / 2 - 4, 0);
  const p = g.attributes.position; const rnd = mulberry(seed); const col = [];
  const bands = [new THREE.Color('#5b3a2a'), new THREE.Color('#6e5140'), new THREE.Color('#3f3a44'), new THREE.Color('#2a2633'), new THREE.Color('#1a1722')];
  const noise = Array.from({ length: 64 }, () => rnd());
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i); const a = Math.atan2(z, x); const depth = -y / H;
    const n = noise[Math.floor(((a + Math.PI) / (2 * Math.PI)) * 63)] * 0.6 + Math.sin(a * 7 + depth * 9) * 0.25 + Math.sin(a * 17) * 0.12;
    const s = 1 + n * 0.18 * Math.min(1, depth * 3);
    if (depth > 0.02) { p.setX(i, x * s); p.setZ(i, z * s); }
    const bi = Math.min(bands.length - 1, Math.floor(depth * 4.2 + n * 0.8)); const c = bands[Math.max(0, bi)];
    col.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }));
}
export function buildIsland(geo, opts = {}) {
  const R = geo.radius; const group = new THREE.Group(); group.name = geo.id;
  const top = new THREE.Mesh(new THREE.CircleGeometry(R, 96), new THREE.MeshStandardMaterial({ color: '#1d2433', roughness: 1 }));
  top.rotation.x = -Math.PI / 2; group.add(top);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 3.2, 8, 160), new THREE.MeshBasicMaterial({ color: '#7aa7ff', transparent: true, opacity: 0.55 }));
  rim.rotation.x = Math.PI / 2; group.add(rim);
  group.add(rockUnderside(R, geo.id.length * 97));
  const green = polyMesh(geo.green.map((p) => p.map(toV).map(([x, z]) => [x, -z])), '#1f3b2c', 0.4); if (green) group.add(green);
  const water = polyMesh(geo.water.filter((p) => p.length > 3).map((p) => p.map(toV).map(([x, z]) => [x, -z])), '#16324f', 0.6); if (water) group.add(water);
  const roadW = [13, 9, 5.5, 2.2], roadC = ['#c9a86a', '#8f8aa0', '#5e6478', '#4b5266'];
  geo.roads.forEach((lines, cls) => { if (!lines.length) return; group.add(new THREE.Mesh(ribbonGeometry(lines, roadW[cls], 0.9 + cls * 0.05), new THREE.MeshStandardMaterial({ color: roadC[cls], roughness: 0.9, emissive: cls === 0 ? '#3a2a10' : '#000000' }))); });
  if (geo.platforms.length) group.add(new THREE.Mesh(ribbonGeometry(geo.platforms, 7, 1.6), new THREE.MeshStandardMaterial({ color: '#9aa6c8', roughness: 0.8 })));
  if (geo.rail.length) group.add(new THREE.Mesh(ribbonGeometry(geo.rail, 3.2, 1.25), new THREE.MeshBasicMaterial({ color: '#8fb2ff' })));
  if (geo.footbridges.length) group.add(new THREE.Mesh(ribbonGeometry(geo.footbridges, 4, 8), new THREE.MeshBasicMaterial({ color: '#ffcf7a' })));
  const bmesh = buildingsMesh(geo.buildings, { base: '#3a4560', top: '#5b6a8f', provenance: false }); group.add(bmesh);
  const bprov = buildingsMesh(geo.buildings, { base: '#9a8f86', top: '#bfb5ab', provenance: true }); bprov.visible = false; group.add(bprov);
  // debris rocks floating below the island
  const rnd = mulberry(geo.id.length * 31 + 5);
  const rockG = new THREE.DodecahedronGeometry(1, 0); const rockM = new THREE.MeshStandardMaterial({ color: '#2d2836', flatShading: true });
  const debris = new THREE.InstancedMesh(rockG, rockM, 26); const m4 = new THREE.Matrix4();
  for (let i = 0; i < 26; i++) { const a = rnd() * Math.PI * 2, r = R * (0.75 + rnd() * 0.6), s = 12 + rnd() * 38; m4.compose(new THREE.Vector3(Math.cos(a) * r, -R * (0.2 + rnd() * 0.8), Math.sin(a) * r), new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * 3, rnd() * 3, rnd() * 3)), new THREE.Vector3(s, s * 0.8, s)); debris.setMatrixAt(i, m4); }
  group.add(debris);
  // hub, bays (real bus stops when available), geofenced gates, entries
  const hub = new THREE.Vector3(0, 0, 0);
  const stops = geo.busStops.map((s) => ({ v: new THREE.Vector3(s[0], 0, -s[1]), name: s[2] })).filter((s) => s.v.length() < 420).sort((a, b) => a.v.length() - b.v.length());
  return { group, R, hub, stops, geo, buildings: bmesh, provenance: bprov };
}
export function layoutIsland(island, nCorr, gates, places, corridors) {
  // bays: nearest real bus stops; otherwise points 90 m from the hub toward each corridor's real bearing
  const bays = [];
  for (let i = 0; i < nCorr; i++) {
    const pl = places?.find((p) => p.key === corridors[i]?.place);
    const brg = pl ? pl.bearing : (i / nCorr) * 360;
    const a = (brg * Math.PI) / 180;
    const fallback = new THREE.Vector3(Math.sin(a) * 95, 0, -Math.cos(a) * 95);
    const st = island.stops[i];
    bays.push({ pos: st ? st.v.clone().lerp(fallback, 0.25) : fallback, bearing: brg, name: st?.name || '' });
  }
  const gatePos = [];
  for (let g = 0; g < gates; g++) { const a = (g / gates) * Math.PI * 2 + 0.6; gatePos.push(new THREE.Vector3(Math.cos(a) * 165, 0, Math.sin(a) * 165)); }
  // entries: where stranded people come from (platform ends and the rail line)
  const entries = [];
  for (const pl of island.geo.platforms.slice(0, 12)) { const p = pl[Math.floor(pl.length / 2)]; const v = new THREE.Vector3(p[0], 0, -p[1]); if (v.length() < 450) entries.push(v); }
  for (const rl of island.geo.rail.slice(0, 20)) for (const p of [rl[0], rl[rl.length - 1]]) { const v = new THREE.Vector3(p[0], 0, -p[1]); if (v.length() > 300 && v.length() < island.R - 20) entries.push(v); }
  if (!entries.length) for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; entries.push(new THREE.Vector3(Math.cos(a) * 140, 0, Math.sin(a) * 140)); }
  return { bays, gates: gatePos, entries };
}
export function makeLabelAnchor(group, pos) { const o = new THREE.Object3D(); o.position.copy(pos); group.add(o); return o; }

// ------------------------------------------------------------------ dynamic layers
export function makeAgents(max) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(max * 3), col = new Float32Array(max * 3), size = new Float32Array(max);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setAttribute('size', new THREE.BufferAttribute(size, 1));
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
    uniforms: { uScale: { value: 1 } },
    vertexShader: `attribute float size; varying vec3 vC; uniform float uScale; void main(){ vC = color; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = clamp(size*uScale*2400.0/(-mv.z), 2.2, 18.0); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `varying vec3 vC; void main(){ vec2 d = gl_PointCoord-0.5; float r = length(d); if (r>0.5) discard; float a = smoothstep(0.5,0.15,r); gl_FragColor = vec4(vC*1.25, a); }`,
  });
  const pts = new THREE.Points(g, m); pts.frustumCulled = false;
  return { pts, pos, col, size, geo: g, setCount: (n) => g.setDrawRange(0, n), dirty: () => { g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true; g.attributes.size.needsUpdate = true; } };
}
export function makeVehicles(max) {
  const geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, 0.5, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.2, emissive: 0x111111 });
  const mesh = new THREE.InstancedMesh(geo, mat, max); mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.count = 0; mesh.frustumCulled = false;
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
  return mesh;
}
export function makeArcs(max) {
  const g = new THREE.BufferGeometry(); const pos = new Float32Array(max * 2 * 3 * 8); const col = new Float32Array(max * 2 * 3 * 8);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
  lines.frustumCulled = false;
  return { lines, pos, col, max, g };
}
export function makeRing(color, r = 30) {
  const m = new THREE.Mesh(new THREE.RingGeometry(r * 0.82, r, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = 2.5; return m;
}
export function makeBeam(color, h = 260) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 6, h, 10, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
  m.position.y = h / 2; return m;
}
export function makeHeat(size = 360, res = 72) {
  const data = new Uint8Array(res * res * 4); const tex = new THREE.DataTexture(data, res, res); tex.needsUpdate = true; tex.magFilter = THREE.LinearFilter;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  m.rotation.x = -Math.PI / 2; m.position.y = 2; return { mesh: m, data, tex, res, size };
}
export function makeThreads(n, R) {
  // the island's links to the cloud: they snap when the internet is cut (Constraint 1)
  const g = new THREE.Group(); const rnd = mulberry(77);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2, r = rnd() * R * 0.6; const p0 = new THREE.Vector3(Math.cos(a) * r, 4, Math.sin(a) * r); const p1 = new THREE.Vector3(Math.cos(a) * R * 2.4, 2600 + rnd() * 900, Math.sin(a) * R * 2.4);
    const curve = new THREE.QuadraticBezierCurve3(p0, new THREE.Vector3(p0.x * 1.5, 1400, p0.z * 1.5), p1);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(40)), new THREE.LineBasicMaterial({ color: '#6fb6ff', transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending }));
    line.userData.v = new THREE.Vector3((rnd() - 0.5) * 20, -30 - rnd() * 40, (rnd() - 0.5) * 20);
    g.add(line);
  }
  return g;
}
export { THREE };
