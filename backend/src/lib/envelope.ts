/**
 * Envelope encryption for per-user secrets (primarily MemWal delegate keys).
 *
 * Design:
 *   - Master secret comes from `MEMWAL_DELEGATE_ENCRYPTION_KEY` env var
 *     (32 bytes — generate via `openssl rand -hex 32`).
 *   - Per-row key derived via HKDF-SHA256 using `profileId` as salt and
 *     a versioned `info` string. Rotating `INFO_V` lets us re-key without
 *     touching the env secret.
 *   - AES-256-GCM with 12-byte nonce, 16-byte tag.
 *   - Persisted form: `${iv_b64}:${tag_b64}:${ciphertext_b64}` (three
 *     URL-safe-base64 fields, colon-delimited). Self-describing; rotation
 *     can prepend a version prefix if needed.
 *
 * SECURITY:
 *   - Decryption only happens in memory; no DB-level pgcrypto. SQL injection
 *     cannot exfiltrate plaintext without also exfiltrating the env secret.
 *   - Rotation: bump INFO_V, decrypt rows with old key, re-encrypt with new.
 *
 * Source: docs.bun.sh + node:crypto stdlib. No external dependency.
 */

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

import { MEMWAL_DELEGATE_ENCRYPTION_KEY } from '../config/main-config.ts';

const INFO_V = 'lighthouse:memwal:v1';

function masterKey(): Buffer {
  if (!MEMWAL_DELEGATE_ENCRYPTION_KEY) {
    throw new Error(
      '[envelope] MEMWAL_DELEGATE_ENCRYPTION_KEY is not set; generate via `openssl rand -hex 32`',
    );
  }
  // Accept hex or base64; require 32 raw bytes.
  let bytes: Buffer;
  if (/^[0-9a-f]{64}$/i.test(MEMWAL_DELEGATE_ENCRYPTION_KEY)) {
    bytes = Buffer.from(MEMWAL_DELEGATE_ENCRYPTION_KEY, 'hex');
  } else {
    bytes = Buffer.from(MEMWAL_DELEGATE_ENCRYPTION_KEY, 'base64');
  }
  if (bytes.length !== 32) {
    throw new Error(
      `[envelope] MEMWAL_DELEGATE_ENCRYPTION_KEY must decode to 32 bytes, got ${bytes.length}`,
    );
  }
  return bytes;
}

function rowKey(profileId: string): Buffer {
  // hkdfSync(digest, ikm, salt, info, length): ArrayBuffer
  const out = hkdfSync('sha256', masterKey(), Buffer.from(profileId, 'utf8'), INFO_V, 32);
  return Buffer.from(out);
}

/**
 * Encrypt a UTF-8 plaintext for storage on `TraderProfile`.
 * `profileId` MUST be the TraderProfile.id row this ciphertext belongs to —
 * it acts as the per-row salt that prevents cross-row substitution.
 */
export function envelopeEncrypt(profileId: string, plaintext: string): string {
  const key = rowKey(profileId);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/**
 * Decrypt the stored ciphertext back to UTF-8 plaintext. Throws on auth-tag
 * mismatch (tampering) or wrong `profileId` (binding break).
 */
export function envelopeDecrypt(profileId: string, stored: string): string {
  const parts = stored.split(':');
  if (parts.length !== 3) {
    throw new Error('[envelope] stored ciphertext is malformed (expected iv:tag:ct)');
  }
  const iv = Buffer.from(parts[0]!, 'base64');
  const tag = Buffer.from(parts[1]!, 'base64');
  const ct = Buffer.from(parts[2]!, 'base64');
  const key = rowKey(profileId);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  const pt = Buffer.concat([d.update(ct), d.final()]);
  return pt.toString('utf8');
}

/**
 * Convenience: load a per-user MemWal delegate key from TraderProfile.
 * Returns null if the column is empty.
 */
export async function loadDelegateKey(
  profileId: string,
  encryptedColumn: string | null | undefined,
): Promise<string | null> {
  if (!encryptedColumn) return null;
  try {
    return envelopeDecrypt(profileId, encryptedColumn);
  } catch (e) {
    throw new Error(
      `[envelope] failed to decrypt MemWal delegate key for profile=${profileId}: ${(e as Error).message}`,
    );
  }
}
