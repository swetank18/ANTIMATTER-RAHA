// Boarding passes are signed by the hub with Ed25519. Phones and driver handhelds only ever
// hold the public key, so a lost or copied device can verify passes but never forge one.
// (A shared HMAC secret on handhelds would let any stolen device mint valid passes.)

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { fromB64Url, fromHex, toB64Url, toHex } from './hash.ts';
import type { PassPayload } from './types.ts';

ed.hashes.sha512 = sha512;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function newKeyPair(): { secretHex: string; publicHex: string } {
  const secret = ed.utils.randomSecretKey();
  return { secretHex: toHex(secret), publicHex: toHex(ed.getPublicKey(secret)) };
}

export function signToken(payload: object, secretHex: string, prefix = 'OS1'): string {
  const body = enc.encode(JSON.stringify(payload));
  const sig = ed.sign(body, fromHex(secretHex));
  return `${prefix}.${toB64Url(body)}.${toB64Url(sig)}`;
}

export type VerifyResult<T> = { ok: true; payload: T } | { ok: false; reason: string };

export function verifyToken<T>(token: string, publicKeys: Record<string, string>, prefix = 'OS1'): VerifyResult<T> {
  const parts = String(token).trim().split('.');
  if (parts.length !== 3 || parts[0] !== prefix) return { ok: false, reason: 'NOT_A_PASS' };
  let body: Uint8Array;
  let sig: Uint8Array;
  let payload: T & { k?: string };
  try {
    body = fromB64Url(parts[1]);
    sig = fromB64Url(parts[2]);
    payload = JSON.parse(dec.decode(body));
  } catch {
    return { ok: false, reason: 'UNREADABLE' };
  }
  const key = publicKeys[payload.k ?? ''];
  if (!key) return { ok: false, reason: 'UNKNOWN_KEY' };
  let valid = false;
  try {
    valid = ed.verify(sig, body, fromHex(key));
  } catch {
    valid = false;
  }
  return valid ? { ok: true, payload } : { ok: false, reason: 'BAD_SIGNATURE' };
}

export function verifyPass(token: string, publicKeys: Record<string, string>): VerifyResult<PassPayload> {
  return verifyToken<PassPayload>(token, publicKeys);
}
