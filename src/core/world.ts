// The demo world: a schematic of south and central Chennai. Place names are real; every time,
// capacity and passenger in this file is synthetic and exists only for the simulation.

import { rng } from './hash.ts';
import type { DeadlineKind, Need, Passenger, PlanMode, Vehicle } from './types.ts';

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

export interface Corridor {
  id: string;
  name: string;
  terminal: string;
  covers: string[];
  pivot: { node: string; metroMin: number; stepFree: boolean } | null;
}

export const HUB = 'GDY';

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

export const CORRIDORS: Corridor[] = [
  { id: 'AIR', name: 'Airport', terminal: 'MAA', covers: ['ALD', 'MAA'], pivot: { node: 'ALD', metroMin: 6, stepFree: true } },
  { id: 'STH', name: 'Tambaram and SRM', terminal: 'SRM', covers: ['ALD', 'TBM', 'SRM'], pivot: null },
  { id: 'OMR', name: 'Velachery and OMR', terminal: 'SHO', covers: ['VLC', 'SHO'], pivot: null },
  { id: 'CEN', name: 'Egmore and Central', terminal: 'MAS', covers: ['TNG', 'EGM', 'MAS'], pivot: { node: 'TNG', metroMin: 11, stepFree: false } },
  { id: 'KLK', name: 'Kilpauk', terminal: 'KLK', covers: ['VDP', 'KLK'], pivot: { node: 'VDP', metroMin: 8, stepFree: true } },
  { id: 'WST', name: 'Porur and Poonamallee', terminal: 'PML', covers: ['VDP', 'PRR', 'PML'], pivot: null },
];

export const DESTINATIONS = [...new Set(CORRIDORS.flatMap((c) => c.covers))];
export const nodeName = (id: string) => NODES.find((n) => n.id === id)?.name ?? id;

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

export function makeFleet(): Vehicle[] {
  const v: Vehicle[] = [];
  const add = (n: number, kind: Vehicle['kind'], label: string, seats: number, bays: number) => {
    for (let i = 0; i < n; i++) v.push({ id: `V${String(v.length + 1).padStart(2, '0')}`, label: `${label} ${i + 1}`, kind, seats, bays, active: true });
  };
  add(6, 'BUS', 'Bus', 60, 0);
  add(6, 'SHUTTLE', 'Shuttle', 45, 2);
  add(3, 'SHUTTLE', 'Mini shuttle', 28, 2);
  add(3, 'MICROVAN', 'Access van', 14, 3);
  return v;
}

export interface GenOptions {
  count: number;
  arrivalSpreadMin: number;
  startAt?: number;
  idPrefix?: string;
}

/** Destination weights are illustrative, not survey data. */
const DEST_WEIGHTS: [string, number][] = [
  ['MAA', 10], ['ALD', 5], ['TBM', 12], ['SRM', 10], ['VLC', 11], ['SHO', 13],
  ['TNG', 8], ['EGM', 8], ['MAS', 9], ['KLK', 5], ['VDP', 4], ['PRR', 3], ['PML', 2],
];

export function makePassengers(seed: number, opt: GenOptions): Passenger[] {
  const r = rng(seed);
  const pick = <T,>(items: [T, number][]): T => {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let x = r() * total;
    for (const [v, w] of items) if ((x -= w) <= 0) return v;
    return items[items.length - 1][0];
  };
  const start = opt.startAt ?? 0;
  const out: Passenger[] = [];
  let people = 0;
  let i = 0;
  while (people < opt.count) {
    const dest = pick(DEST_WEIGHTS);
    const need = pick<Need>([['NONE', 90], ['ASSIST', 7], ['WHEELCHAIR', 3]]);
    const kind = pick<DeadlineKind>(dest === 'MAA' ? [['FLIGHT', 70], ['NONE', 30]] : dest === 'MAS' || dest === 'EGM' ? [['RAIL', 55], ['SHIFT', 10], ['NONE', 35]] : dest === 'KLK' ? [['MEDICAL', 30], ['SHIFT', 20], ['NONE', 50]] : [['SHIFT', 28], ['NONE', 72]]);
    const party = need === 'WHEELCHAIR' ? pick<number>([[1, 60], [2, 40]]) : pick<number>([[1, 82], [2, 11], [3, 5], [4, 2]]);
    const arrive = start + Math.round(r() * opt.arrivalSpreadMin);
    const span = kind === 'NONE' ? 0 : 40 + Math.round(r() * 170);
    out.push({
      pid: `${opt.idPrefix ?? 'P'}-${String(i).padStart(5, '0')}`,
      dest,
      need,
      party: Math.min(party, opt.count - people),
      deadlineKind: kind,
      deadlineAt: kind === 'NONE' ? null : arrive + span,
      deadlineVerified: kind === 'NONE' ? false : r() < 0.6,
      checkinAt: arrive,
      state: 'WAITING',
      displaced: false,
    });
    people += out[out.length - 1].party;
    i++;
  }
  return out;
}

export interface TripPlan {
  corridor: string;
  dropAt: string;
  mode: PlanMode;
  oneWayMin: number;
  rttMin: number;
  arriveExtraMin: number;
  routeEdges: string[];
}

const DWELL_MIN = 4;

export function tripFor(c: Corridor, mode: PlanMode, closed: Set<string>): TripPlan | null {
  const useTrunk = mode === 'TRUNK' && c.pivot !== null;
  const target = useTrunk ? c.pivot!.node : c.terminal;
  const path = shortest(HUB, target, closed);
  if (!path) return null;
  return {
    corridor: c.id,
    dropAt: target,
    mode: useTrunk ? 'TRUNK' : 'DIRECT',
    oneWayMin: path.min,
    rttMin: path.min * 2 + DWELL_MIN,
    arriveExtraMin: useTrunk ? c.pivot!.metroMin : 0,
    routeEdges: path.edges,
  };
}

export interface CorridorDemand {
  corridor: string;
  people: number;
  wheelchairs: number;
}

/**
 * Hands vehicles to corridors by Sainte-Lague highest averages, weighted by trips per hour:
 * no corridor can be starved and small corridors are not swallowed by large ones. Vehicles with
 * wheelchair bays go first, to wherever wheelchair demand is greatest.
 */
export function apportion(vehicles: Vehicle[], demand: CorridorDemand[], trips: Map<string, TripPlan>): Map<string, string> {
  const out = new Map<string, string>();
  const served = new Map(demand.map((d) => [d.corridor, 0]));
  const bays = new Map(demand.map((d) => [d.corridor, 0]));
  const usable = demand.filter((d) => trips.has(d.corridor));
  if (usable.length === 0) return out;

  const hourly = (v: Vehicle, c: string) => (v.seats * 60) / trips.get(c)!.rttMin;
  const list = [...vehicles].sort((a, b) => b.bays - a.bays || b.seats - a.seats || a.id.localeCompare(b.id));

  for (const v of list) {
    let best: CorridorDemand | null = null;
    let bestQ = -Infinity;
    for (const d of usable) {
      const need = v.bays > 0 ? d.wheelchairs * 6 / (1 + bays.get(d.corridor)!) : 0;
      const q = d.people / (2 * served.get(d.corridor)! + hourly(v, d.corridor)) + need;
      if (q > bestQ || (q === bestQ && best !== null && d.corridor < best.corridor)) {
        bestQ = q;
        best = d;
      }
    }
    out.set(v.id, best!.corridor);
    served.set(best!.corridor, served.get(best!.corridor)! + hourly(v, best!.corridor));
    bays.set(best!.corridor, bays.get(best!.corridor)! + v.bays);
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
