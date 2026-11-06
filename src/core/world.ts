// The demo world: a schematic of south and central Chennai. Place names are real; every time,
// fare, cab count and rider in this file is synthetic and exists only for the simulation.

import { fareFor, KM_PER_MIN } from './fare.ts';
import { rng } from './hash.ts';
import type { DeadlineKind, Need, Rider, ShareWith } from './types.ts';

export interface WorldNode {
  id: string;
  name: string;
  x: number;
  y: number;
  lat: number;
  lng: number;
  stepFree: boolean;
}

export interface WorldEdge {
  id: string;
  a: string;
  b: string;
  min: number;
  mode: 'ROAD' | 'METRO';
}

export const NODES: WorldNode[] = [
  { id: 'GDY', name: 'Guindy', x: 470, y: 330, lat: 13.0067, lng: 80.2206, stepFree: true },
  { id: 'ALD', name: 'Alandur', x: 400, y: 410, lat: 12.9975, lng: 80.2006, stepFree: true },
  { id: 'MAA', name: 'Airport', x: 330, y: 520, lat: 12.9941, lng: 80.1709, stepFree: true },
  { id: 'TBM', name: 'Tambaram', x: 300, y: 650, lat: 12.9249, lng: 80.1, stepFree: false },
  { id: 'SRM', name: 'Potheri (SRM)', x: 170, y: 730, lat: 12.8231, lng: 80.0442, stepFree: false },
  { id: 'VLC', name: 'Velachery', x: 610, y: 430, lat: 12.9756, lng: 80.2212, stepFree: true },
  { id: 'SHO', name: 'Sholinganallur', x: 760, y: 590, lat: 12.901, lng: 80.2279, stepFree: false },
  { id: 'TNG', name: 'T. Nagar', x: 520, y: 220, lat: 13.0418, lng: 80.2341, stepFree: false },
  { id: 'EGM', name: 'Egmore', x: 610, y: 120, lat: 13.0732, lng: 80.2609, stepFree: true },
  { id: 'MAS', name: 'Chennai Central', x: 720, y: 60, lat: 13.0827, lng: 80.2752, stepFree: true },
  { id: 'KLK', name: 'Kilpauk', x: 440, y: 110, lat: 13.0827, lng: 80.2424, stepFree: true },
  { id: 'VDP', name: 'Vadapalani', x: 330, y: 240, lat: 13.0501, lng: 80.2121, stepFree: true },
  { id: 'PRR', name: 'Porur', x: 190, y: 300, lat: 13.0382, lng: 80.1565, stepFree: false },
  { id: 'PML', name: 'Poonamallee', x: 60, y: 230, lat: 13.0473, lng: 80.0945, stepFree: false },
];

const road = (a: string, b: string, min: number): WorldEdge => ({ id: `${a}-${b}`, a, b, min, mode: 'ROAD' });
const metro = (a: string, b: string, min: number): WorldEdge => ({ id: `M:${a}-${b}`, a, b, min, mode: 'METRO' });

export const EDGES: WorldEdge[] = [
  road('GDY', 'ALD', 8), road('ALD', 'MAA', 12), road('MAA', 'TBM', 16), road('TBM', 'SRM', 24),
  road('GDY', 'VLC', 12), road('VLC', 'SHO', 22), road('GDY', 'TNG', 12), road('TNG', 'EGM', 14),
  road('EGM', 'MAS', 8), road('TNG', 'KLK', 14), road('KLK', 'EGM', 10), road('GDY', 'VDP', 13),
  road('VDP', 'PRR', 13), road('PRR', 'PML', 15), road('VDP', 'KLK', 14), road('ALD', 'VDP', 12),
  road('ALD', 'PRR', 18), road('VLC', 'TBM', 26),
  metro('ALD', 'MAA', 6), metro('ALD', 'VDP', 7), metro('VDP', 'KLK', 8), metro('KLK', 'EGM', 6),
  metro('EGM', 'MAS', 4), metro('GDY', 'ALD', 3), metro('GDY', 'TNG', 6), metro('TNG', 'EGM', 7),
];

export interface Spot {
  id: string;
  name: string;
  node: string;
  circle: string;
  carsPerSlot: number;
  accessPerSlot: number;
  surge: number;
}

/** Where groups meet. One pickup per group keeps every booking a plain point-to-point trip. */
export const SPOTS: Spot[] = [
  { id: 'SRM-MAIN', name: 'SRM main gate', node: 'SRM', circle: 'SRM', carsPerSlot: 8, accessPerSlot: 1, surge: 1.6 },
  { id: 'SRM-TP', name: 'SRM Tech Park gate', node: 'SRM', circle: 'SRM', carsPerSlot: 5, accessPerSlot: 0, surge: 1.3 },
  { id: 'GDY-E', name: 'Guindy station east exit', node: 'GDY', circle: 'PUBLIC', carsPerSlot: 9, accessPerSlot: 1, surge: 1.9 },
  { id: 'GDY-W', name: 'Guindy station west exit', node: 'GDY', circle: 'PUBLIC', carsPerSlot: 6, accessPerSlot: 0, surge: 1.4 },
  { id: 'TBM-W', name: 'Tambaram west exit', node: 'TBM', circle: 'PUBLIC', carsPerSlot: 7, accessPerSlot: 1, surge: 1.5 },
  { id: 'SHO-TP', name: 'Sholinganallur tech park', node: 'SHO', circle: 'TECHPARK', carsPerSlot: 8, accessPerSlot: 1, surge: 1.7 },
];

export const CIRCLES = [...new Set(SPOTS.map((s) => s.circle))];
export const spotOf = (id: string) => SPOTS.find((s) => s.id === id);
export const DESTINATIONS = NODES.map((n) => n.id);
export const nodeName = (id: string) => NODES.find((n) => n.id === id)?.name ?? id;

/** Spots at the same place are a short walk apart. */
export function nearbySpots(id: string): { spot: string; name: string; walkMin: number }[] {
  const me = spotOf(id);
  if (!me) return [];
  return SPOTS.filter((s) => s.id !== id && s.node === me.node).map((s) => ({ spot: s.id, name: s.name, walkMin: 6 }));
}

export function shortest(from: string, to: string, closed: Set<string>, modes: WorldEdge['mode'][] = ['ROAD']): { min: number; path: string[]; edges: string[] } | null {
  const dist = new Map<string, number>([[from, 0]]);
  const back = new Map<string, { node: string; edge: string }>();
  const open = new Set(NODES.map((n) => n.id));
  while (open.size) {
    let u: string | null = null;
    for (const n of open) if (dist.has(n) && (u === null || dist.get(n)! < dist.get(u)!)) u = n;
    if (u === null) break;
    open.delete(u);
    if (u === to) break;
    for (const e of EDGES) {
      if (!modes.includes(e.mode) || closed.has(e.id)) continue;
      const v = e.a === u ? e.b : e.b === u ? e.a : null;
      if (v === null) continue;
      const d = dist.get(u)! + e.min;
      if (d < (dist.get(v) ?? Infinity)) {
        dist.set(v, d);
        back.set(v, { node: u, edge: e.id });
      }
    }
  }
  if (!dist.has(to)) return null;
  const path = [to];
  const edges: string[] = [];
  while (path[0] !== from) {
    const b = back.get(path[0])!;
    path.unshift(b.node);
    edges.unshift(b.edge);
  }
  return { min: dist.get(to)!, path, edges };
}

export interface GenOptions {
  count: number;
  arrivalSpreadMin: number;
  startAt?: number;
  idPrefix?: string;
}

const pickW = <T,>(r: () => number, items: [T, number][]): T => {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of items) if ((x -= w) <= 0) return v;
  return items[items.length - 1][0];
};

/** Destination weights are illustrative, not survey data. */
const DEST_WEIGHTS: [string, number][] = [
  ['MAA', 10], ['ALD', 5], ['TBM', 10], ['SRM', 8], ['VLC', 11], ['SHO', 11],
  ['TNG', 9], ['EGM', 8], ['MAS', 9], ['KLK', 5], ['VDP', 5], ['PRR', 3], ['PML', 2],
];

export function makeRiders(seed: number, opt: GenOptions): Rider[] {
  const r = rng(seed);
  const start = opt.startAt ?? 0;
  const closed = new Set<string>();
  const out: Rider[] = [];
  let people = 0;
  let i = 0;
  while (people < opt.count) {
    const spot = pickW(r, SPOTS.map((s): [typeof s, number] => [s, s.carsPerSlot]));
    let dest = pickW(r, DEST_WEIGHTS);
    if (dest === spot.node) dest = spot.node === 'MAS' ? 'TNG' : 'MAS';
    const need = pickW<Need>(r, [['NONE', 90], ['ASSIST', 7], ['WHEELCHAIR', 3]]);
    const kind = pickW<DeadlineKind>(r, dest === 'MAA' ? [['FLIGHT', 60], ['NONE', 40]] : dest === 'MAS' || dest === 'EGM' ? [['RAIL', 40], ['SHIFT', 10], ['NONE', 50]] : [['SHIFT', 20], ['NONE', 80]]);
    const party = need === 'WHEELCHAIR' ? 1 : pickW<number>(r, [[1, 80], [2, 15], [3, 5]]);
    const shareWith = pickW<ShareWith>(r, [['ANYONE', 78], ['WOMEN_ONLY', 22]]);
    const arrive = start + Math.round(r() * opt.arrivalSpreadMin);
    const span = kind === 'NONE' ? 0 : 40 + Math.round(r() * 170);
    const path = shortest(spot.node, dest, closed);
    const solo = fareFor((path?.min ?? 20) * KM_PER_MIN, spot.surge);
    out.push({
      pid: `${opt.idPrefix ?? 'R'}-${String(i).padStart(5, '0')}`,
      circle: spot.circle, spot: spot.id, dest, need, party: Math.min(party, opt.count - people), shareWith,
      deadlineKind: kind, deadlineAt: kind === 'NONE' ? null : arrive + span, deadlineVerified: kind === 'NONE' ? false : r() < 0.6,
      checkinAt: arrive, maxWaitMin: 10 + Math.round(r() * 10), maxDetourMin: 8 + Math.round(r() * 10), soloFare: solo, state: 'WAITING', displaced: false, bridgeTo: null,
    });
    people += out[out.length - 1].party;
    i++;
  }
  return out;
}

export interface ClusterPoint {
  id: string;
  lat: number;
  lng: number;
}

/** DBSCAN with a grid index, so the neighbour search stays close to linear. */
export function dbscan(points: ClusterPoint[], epsKm: number, minPts: number): { labels: Int32Array; clusters: number } {
  const n = points.length;
  const labels = new Int32Array(n).fill(-2);
  const cell = epsKm / 111;
  const key = (lat: number, lng: number) => `${Math.floor(lat / cell)}:${Math.floor(lng / cell)}`;
  const grid = new Map<string, number[]>();
  points.forEach((p, i) => {
    const k = key(p.lat, p.lng);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(i);
  });
  const neighbours = (i: number) => {
    const p = points[i];
    const cy = Math.floor(p.lat / cell);
    const cx = Math.floor(p.lng / cell);
    const out: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const j of grid.get(`${cy + dy}:${cx + dx}`) ?? []) {
          const dLat = (points[j].lat - p.lat) * 111;
          const dLng = (points[j].lng - p.lng) * 108;
          if (dLat * dLat + dLng * dLng <= epsKm * epsKm) out.push(j);
        }
      }
    }
    return out;
  };
  let clusters = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== -2) continue;
    const seeds = neighbours(i);
    if (seeds.length < minPts) {
      labels[i] = -1;
      continue;
    }
    const id = clusters++;
    labels[i] = id;
    const queue = [...seeds];
    for (let q = 0; q < queue.length; q++) {
      const j = queue[q];
      if (labels[j] === -1) labels[j] = id;
      if (labels[j] !== -2) continue;
      labels[j] = id;
      const next = neighbours(j);
      if (next.length >= minPts) queue.push(...next);
    }
  }
  return { labels, clusters };
}
