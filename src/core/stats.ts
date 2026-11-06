// Evidence, not anecdotes. Quotes seen on two phones at the same moment are paired, and the gap is
// tested with a sign-flip permutation test and a bootstrap interval. Neither assumes normal data.

import { rng } from './hash.ts';

export interface GapReport {
  pairs: number;
  meanGap: number | null;
  ci95: [number, number] | null;
  pValue: number | null;
  verdict: 'NOT_ENOUGH_DATA' | 'NO_CLEAR_GAP' | 'CONSISTENT_GAP';
  message: string;
}

export const MIN_PAIRS = 12;
const ITERATIONS = 4000;
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

export function pairedGap(pairs: [number, number][], seed = 1, labels: [string, string] = ['A', 'B']): GapReport {
  const n = pairs.length;
  if (n < MIN_PAIRS) {
    return { pairs: n, meanGap: null, ci95: null, pValue: null, verdict: 'NOT_ENOUGH_DATA', message: `Only ${n} paired quotes. At least ${MIN_PAIRS} are needed before saying anything.` };
  }
  const r = rng(seed);
  const d = pairs.map(([a, b]) => a - b);
  const observed = mean(d);

  let extreme = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    let s = 0;
    for (const x of d) s += r() < 0.5 ? x : -x;
    if (Math.abs(s / n) >= Math.abs(observed) - 1e-9) extreme++;
  }
  const pValue = (extreme + 1) / (ITERATIONS + 1);

  const boots: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += d[Math.floor(r() * n)];
    boots.push(s / n);
  }
  boots.sort((a, b) => a - b);
  const ci95: [number, number] = [boots[Math.floor(ITERATIONS * 0.025)], boots[Math.floor(ITERATIONS * 0.975)]];
  const round = (x: number) => Math.round(x * 10) / 10;
  const clear = pValue < 0.05 && (ci95[0] > 0 || ci95[1] < 0);
  return {
    pairs: n, meanGap: round(observed), ci95: [round(ci95[0]), round(ci95[1])], pValue: Math.round(pValue * 10000) / 10000,
    verdict: clear ? 'CONSISTENT_GAP' : 'NO_CLEAR_GAP',
    message: clear
      ? `Across ${n} paired quotes, ${labels[0]} averaged Rs ${round(Math.abs(observed))} ${observed > 0 ? 'more' : 'less'} than ${labels[1]} (95% interval Rs ${round(ci95[0])} to Rs ${round(ci95[1])}, p = ${pValue.toFixed(4)}). This shows a pattern in shared quotes, not why it happens.`
      : `Across ${n} paired quotes there is no clear gap between ${labels[0]} and ${labels[1]} (p = ${pValue.toFixed(4)}).`,
  };
}
