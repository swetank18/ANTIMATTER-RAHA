import { canon, sha256Hex } from './hash.ts';

export interface LedgerEntry {
  seq: number;
  at: number;
  type: string;
  actor: string;
  payload: unknown;
  prev: string;
  hash: string;
}

export const GENESIS = '0'.repeat(64);

export function entryHash(e: Omit<LedgerEntry, 'hash'>): string {
  return sha256Hex(canon({ seq: e.seq, at: e.at, type: e.type, actor: e.actor, payload: e.payload, prev: e.prev }));
}

export interface LedgerAnchor {
  seq: number;
  hash: string;
}

/**
 * Walks the chain and reports the first entry that does not link to the one before it.
 *
 * A chain alone cannot notice its newest entries being cut off, because what remains still links
 * up. Passing an anchor closes that gap: it is a (seq, hash) pair published earlier, and that
 * exact entry must still be present.
 */
export function verifyChain(entries: LedgerEntry[], anchor?: LedgerAnchor): { ok: boolean; checked: number; brokenAt: number | null } {
  let prev = GENESIS;
  let expected = 1;
  for (const e of entries) {
    if (e.seq !== expected || e.prev !== prev || entryHash(e) !== e.hash) return { ok: false, checked: expected, brokenAt: expected };
    prev = e.hash;
    expected++;
  }
  if (anchor && entries[anchor.seq - 1]?.hash !== anchor.hash) return { ok: false, checked: entries.length, brokenAt: anchor.seq };
  return { ok: true, checked: entries.length, brokenAt: null };
}

export type MerkleStep = { side: 'L' | 'R'; hash: string };

const pair = (a: string, b: string) => sha256Hex(`node:${a}${b}`);

export function leafHash(value: unknown): string {
  return sha256Hex(`leaf:${canon(value)}`);
}

export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return GENESIS;
  let level = leaves;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(pair(level[i], level[i + 1] ?? level[i]));
    level = next;
  }
  return level[0];
}

export function merkleProof(leaves: string[], index: number): MerkleStep[] {
  const proof: MerkleStep[] = [];
  let level = leaves;
  let i = index;
  while (level.length > 1) {
    const sibling = i % 2 === 0 ? (level[i + 1] ?? level[i]) : level[i - 1];
    proof.push({ side: i % 2 === 0 ? 'R' : 'L', hash: sibling });
    const next: string[] = [];
    for (let j = 0; j < level.length; j += 2) next.push(pair(level[j], level[j + 1] ?? level[j]));
    level = next;
    i = Math.floor(i / 2);
  }
  return proof;
}

export function verifyMerkle(leaf: string, proof: MerkleStep[], root: string): boolean {
  let h = leaf;
  for (const s of proof) h = s.side === 'R' ? pair(h, s.hash) : pair(s.hash, h);
  return h === root;
}
