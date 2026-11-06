// Surge forecast: the multiple at a pickup spot 15 minutes from now.
//
// A ridge regression: small, explainable and fully local, so it keeps working offline and needs
// no hosted AI. Every forecast shows what is driving it.
//
// IMPORTANT: there is no public surge data to train on. The model is trained on a synthetic history
// generated below. The backtest shows it can learn that history. It says nothing about real Uber or
// Ola prices. Real use means retraining on quotes riders share.

import { rng } from './hash.ts';

export const FEATURES = ['Base level', 'Peak hours', 'Late night', 'Weekend', 'Rain alert', 'Transit alert', 'New alert', 'Riders per cab', 'Rising trend', 'Current surge'] as const;

export interface SurgeSample {
  hour: number;
  weekend: boolean;
  rain: boolean;
  transit: boolean;
  /** An alert began in the last 15 minutes: demand is about to rise but has not shown up yet. */
  newAlert: boolean;
  ratio: number;
  trend: number;
  current: number;
}

export interface SurgeRow extends SurgeSample {
  day: number;
  target: number;
}

export interface SurgeModel {
  weights: number[];
  residualStd: number;
  rows: number;
  lambda: number;
}

const CAP = 2;

export function features(s: SurgeSample): number[] {
  const peak = (s.hour >= 8 && s.hour < 11) || (s.hour >= 17 && s.hour < 21) ? 1 : 0;
  const night = s.hour >= 22 || s.hour < 5 ? 1 : 0;
  return [1, peak, night, s.weekend ? 1 : 0, s.rain ? 1 : 0, s.transit ? 1 : 0, s.newAlert ? 1 : 0, Math.min(s.ratio, 6), s.trend, s.current];
}

/** Solves (X'X + lambda I) w = X'y by Gaussian elimination with partial pivoting. */
export function trainSurge(rows: SurgeRow[], lambda = 1): SurgeModel {
  const k = FEATURES.length;
  const A = Array.from({ length: k }, () => new Array<number>(k + 1).fill(0));
  for (const r of rows) {
    const x = features(r);
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) A[i][j] += x[i] * x[j];
      A[i][k] += x[i] * r.target;
    }
  }
  for (let i = 1; i < k; i++) A[i][i] += lambda;
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let i = c + 1; i < k; i++) if (Math.abs(A[i][c]) > Math.abs(A[p][c])) p = i;
    [A[c], A[p]] = [A[p], A[c]];
    for (let i = 0; i < k; i++) {
      if (i === c) continue;
      const f = A[i][c] / A[c][c];
      for (let j = c; j <= k; j++) A[i][j] -= f * A[c][j];
    }
  }
  const weights = A.map((row, i) => row[k] / row[i]);
  const raw = (r: SurgeRow) => features(r).reduce((s, x, i) => s + x * weights[i], 0);
  const residualStd = Math.sqrt(rows.reduce((s, r) => s + (raw(r) - r.target) ** 2, 0) / Math.max(1, rows.length - k));
  return { weights, residualStd, rows: rows.length, lambda };
}

const clamp = (x: number) => Math.min(CAP, Math.max(1, x));

export function predictRaw(m: SurgeModel, s: SurgeSample): number {
  return clamp(features(s).reduce((a, x, i) => a + x * m.weights[i], 0));
}

/** Abramowitz and Stegun approximation of the normal distribution. */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

export interface SurgeForecast {
  multiple: number;
  range: [number, number];
  chanceOverHighSurge: number;
  drivers: { feature: string; effect: number }[];
  advice: 'FORM_GROUPS_NOW' | 'WAIT' | 'NORMAL';
  message: string;
}

export const HIGH_SURGE = 1.5;

export function forecast(m: SurgeModel, s: SurgeSample): SurgeForecast {
  const multiple = Math.round(predictRaw(m, s) * 100) / 100;
  const x = features(s);
  const drivers = FEATURES.map((feature, i) => ({ feature, effect: Math.round(x[i] * m.weights[i] * 100) / 100 }))
    .filter((d) => d.feature !== 'Base level' && d.effect !== 0)
    .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
  const chance = Math.round(normalCdf((multiple - HIGH_SURGE) / Math.max(0.01, m.residualStd)) * 100) / 100;
  const range: [number, number] = [clamp(multiple - 1.64 * m.residualStd), clamp(multiple + 1.64 * m.residualStd)].map((v) => Math.round(v * 100) / 100) as [number, number];
  const rising = multiple > s.current + 0.05;
  const falling = multiple < s.current - 0.1;
  const advice = rising && multiple >= 1.25 ? 'FORM_GROUPS_NOW' : falling ? 'WAIT' : 'NORMAL';
  const message = advice === 'FORM_GROUPS_NOW'
    ? `Surge likely to reach about ${multiple}x in 15 minutes. Start forming groups now, before it climbs.`
    : advice === 'WAIT' ? `Surge likely to ease to about ${multiple}x in 15 minutes. Waiting may save money.` : `Surge likely to stay near ${multiple}x.`;
  return { multiple, range, chanceOverHighSurge: chance, drivers: drivers.slice(0, 4), advice, message };
}

/** A made-up city: demand curves, rain, and transit failures, sampled every 5 minutes. */
export function syntheticHistory(seed: number, days: number): SurgeRow[] {
  const r = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r());
  const rows: SurgeRow[] = [];
  const stepsPerDay = 288;
  const horizon = 3;
  for (let day = 0; day < days; day++) {
    const weekend = day % 7 >= 5;
    const rainStart = r() < 0.3 ? Math.floor(r() * stepsPerDay) : -1;
    const rainLen = 12 + Math.floor(r() * 36);
    const failStart = r() < 0.08 ? Math.floor(r() * stepsPerDay) : -1;
    const failLen = 12 + Math.floor(r() * 24);
    const series: { hour: number; rain: boolean; transit: boolean; ratio: number; m: number }[] = [];
    let noise = 0;
    let level = 1;
    for (let t = 0; t < stepsPerDay; t++) {
      const hour = (t * 5) / 60;
      const rain = rainStart >= 0 && t >= rainStart && t < rainStart + rainLen;
      const transit = failStart >= 0 && t >= failStart && t < failStart + failLen;
      const wave = Math.exp(-((hour - 9) ** 2) / 2) + 1.2 * Math.exp(-((hour - 18.5) ** 2) / 3);
      noise = 0.85 * noise + 0.12 * gauss();
      // Assumption: people react to an alert over about 20 minutes, not instantly. That lag is the
      // window in which groups can form before surge arrives.
      const ramp = (start: number) => Math.min(1, (t - start) / 4);
      const ratio = Math.max(0.2, 0.7 + (weekend ? 0.5 : 1) * 1.6 * wave + (rain ? 0.7 * ramp(rainStart) : 0) + (transit ? 1.5 * ramp(failStart) : 0) + noise);
      const target = clamp(1 + 0.5 * Math.max(0, ratio - 1));
      level += 0.35 * (target - level);
      series.push({ hour, rain, transit, ratio, m: clamp(level + 0.03 * gauss()) });
    }
    for (let t = 6; t + horizon < stepsPerDay; t++) {
      const s = series[t];
      const newAlert = (s.rain && !series[t - 3].rain) || (s.transit && !series[t - 3].transit);
      rows.push({ day, hour: s.hour, weekend, rain: s.rain, transit: s.transit, newAlert, ratio: s.ratio, trend: s.m - series[t - 6].m, current: s.m, target: series[t + horizon].m });
    }
  }
  return rows;
}

export interface Backtest {
  trainDays: number;
  testDays: number;
  testRows: number;
  maeModel: number;
  maeNoChange: number;
  maeHourAverage: number;
  improvementPct: number;
  precision: number;
  recall: number;
  note: string;
}

/** Trains on the earlier days and tests only on later, unseen days, so nothing leaks backwards. */
export function backtest(seed = 11, days = 120): { model: SurgeModel; report: Backtest } {
  const rows = syntheticHistory(seed, days);
  const cut = Math.floor(days * 0.7);
  const train = rows.filter((r) => r.day < cut);
  const test = rows.filter((r) => r.day >= cut);
  const model = trainSurge(train);

  const byHour = new Map<number, { s: number; n: number }>();
  for (const r of train) {
    const h = Math.floor(r.hour);
    const c = byHour.get(h) ?? { s: 0, n: 0 };
    c.s += r.target;
    c.n += 1;
    byHour.set(h, c);
  }
  const hourAverage = (r: SurgeRow) => {
    const c = byHour.get(Math.floor(r.hour));
    return c ? c.s / c.n : 1;
  };

  let eM = 0;
  let eN = 0;
  let eH = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const r of test) {
    const p = predictRaw(model, r);
    eM += Math.abs(p - r.target);
    eN += Math.abs(r.current - r.target);
    eH += Math.abs(hourAverage(r) - r.target);
    const said = p >= HIGH_SURGE;
    const was = r.target >= HIGH_SURGE;
    if (said && was) tp++;
    else if (said) fp++;
    else if (was) fn++;
  }
  const n = test.length;
  const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
  const maeModel = round(eM / n);
  const maeNoChange = round(eN / n);
  return {
    model,
    report: {
      trainDays: cut, testDays: days - cut, testRows: n, maeModel, maeNoChange, maeHourAverage: round(eH / n),
      improvementPct: round(((maeNoChange - maeModel) / maeNoChange) * 100, 1),
      precision: round(tp / Math.max(1, tp + fp)), recall: round(tp / Math.max(1, tp + fn)),
      note: 'Measured on synthetic history only. This shows the model can learn that history, not that it predicts real Uber or Ola surge.',
    },
  };
}
