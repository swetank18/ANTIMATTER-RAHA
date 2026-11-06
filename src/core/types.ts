// Shared domain types. Everything in src/core is pure and runs on the hub,
// on a driver handheld and on a passenger phone without modification.

export type Need = 'NONE' | 'ASSIST' | 'WHEELCHAIR' | 'UNKNOWN';
export type DeadlineKind = 'NONE' | 'FLIGHT' | 'RAIL' | 'SHIFT' | 'MEDICAL';
export type PassengerState = 'WAITING' | 'ASSIGNED' | 'BOARDED' | 'DEPARTED' | 'AWAITING_INFO' | 'CANCELLED';
export type SeatState = 'HELD' | 'COMMITTED' | 'BOARDED' | 'RELEASED';
export type RunState = 'PLANNED' | 'DEPARTED' | 'CANCELLED';
export type PlanMode = 'DIRECT' | 'TRUNK';

export interface Passenger {
  pid: string;
  dest: string;
  need: Need;
  party: number;
  deadlineKind: DeadlineKind;
  deadlineAt: number | null;
  deadlineVerified: boolean;
  checkinAt: number;
  state: PassengerState;
  displaced: boolean;
}

export interface Vehicle {
  id: string;
  label: string;
  kind: 'BUS' | 'SHUTTLE' | 'MICROVAN';
  seats: number;
  bays: number;
  active: boolean;
}

export interface Run {
  id: string;
  vehicleId: string;
  corridor: string;
  dropAt: string;
  mode: PlanMode;
  departAt: number;
  arriveAt: number;
  returnAt: number;
  seatsTotal: number;
  seatsTaken: number;
  baysTotal: number;
  baysTaken: number;
  escrowSeats: number;
  state: RunState;
}

export interface PolicyRule {
  need?: Need[];
  deadlineKinds?: DeadlineKind[];
  deadlineVerified?: boolean;
  deadlineWithinMin?: number;
  waitedAtLeastMin?: number;
  displaced?: boolean;
}

export interface Policy {
  version: number;
  name: string;
  note: string;
  tiers: { id: string; label: string; match: PolicyRule }[];
  weights: {
    wheelchair: number;
    assist: number;
    deadline: Record<Exclude<DeadlineKind, 'NONE'>, number>;
    waitPerMin: number;
    detourPerMin: number;
    displaced: number;
  };
  unverifiedDeadlineFactor: number;
  deadlineHorizonMin: number;
  commitWindowMin: number;
}

export interface ScorePart {
  key: 'VULNERABILITY' | 'DEADLINE' | 'WAIT' | 'DISPLACED';
  label: string;
  points: number;
  detail: string;
}

export interface Priority {
  tier: number;
  tierId: string;
  tierLabel: string;
  score: number;
  parts: ScorePart[];
  lottery: string;
}

export interface Alternative {
  kind: 'NEXT_WAVE' | 'STAGING' | 'METRO' | 'WALK';
  title: string;
  etaMin: number | null;
  stepFree: boolean;
  detail: string;
}

export type WitnessKind = 'HALL' | 'FRAGMENTED' | 'NO_OPTION';

export interface Witness {
  kind: WitnessKind;
  pools: string[];
}

export interface Decision {
  pid: string;
  epoch: number;
  outcome: 'SEATED' | 'WAITLISTED' | 'AWAITING_INFO' | 'COMMITTED_KEPT';
  runId: string | null;
  pool: 'S' | 'B' | null;
  priority: Priority;
  witness: Witness | null;
  rivals: number;
  capacity: number;
}

export interface CertificateCheck {
  id: string;
  label: string;
  ok: boolean;
  observed: string;
}

export interface Certificate {
  ok: boolean;
  checks: CertificateCheck[];
  seatsAvailable: number;
  unitsSeated: number;
  unitsRefused: number;
  relaxedBound: number;
  gap: number;
}

export interface PassPayload {
  v: 1;
  k: string;
  p: string;
  r: string;
  u: 'S' | 'B';
  n: number;
  nb: number;
  ex: number;
  id: string;
}

export type BeliefState = 'TRUSTED' | 'UNRESOLVED' | 'UNKNOWN';

export interface RouteRecord {
  route: string;
  field: 'status';
  value: string;
  source: string;
  observedAt: number;
  receivedAt: number;
}

export interface Belief {
  route: string;
  state: BeliefState;
  value: string | null;
  safeValue: string;
  because: string;
  stillUncertain: string;
  considered: { source: string; value: string; ageMin: number; weight: number; used: boolean; note: string }[];
}

export interface Reading {
  vehicleId: string;
  observedAt: number;
  receivedAt: number;
  lat: number | null;
  lng: number | null;
  odoKm: number | null;
  occupancy: number | null;
}

export type SensorVerdict = 'HEALTHY' | 'SENSOR_FAULT' | 'GENUINE_STOP' | 'UNCERTAIN';

export interface SensorReport {
  vehicleId: string;
  verdict: SensorVerdict;
  flags: { code: string; detail: string }[];
  action: string;
  lastGood: Reading | null;
  autoAction: boolean;
}

export interface QuarantineEntry {
  line: number;
  reasons: string[];
  excerpt: string;
}

export interface CardCheck {
  id: string;
  requirement: string;
  ok: boolean;
  observed: string;
}

export interface CardResult {
  card: string;
  title: string;
  status: 'PASS' | 'FAIL';
  summary: string;
  ranAtMs: number;
  durationMs: number;
  steps: string[];
  checks: CardCheck[];
  evidence: { label: string; rows: Record<string, string | number | boolean | null>[] }[];
  tryIt?: { label: string; href: string }[];
}
