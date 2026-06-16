// SECURITY: Private key files MUST live outside the project tree.
// Default location is ~/.lighthouse/keys/ (per LIGHTHOUSE_KEYS_DIR env var).
// The .gitignore at backend/ and repo root excludes *.key as defense in depth,
// but the canonical control is to keep secrets off the project filesystem.
// See backend/BACKEND_KEY_ROTATION.md for rotation procedure if these keys
// are ever committed accidentally.

/**
 * Backend keypair loaders.
 *
 * SECURITY:
 *   - Two supported sources, checked in order:
 *       1. Env var `COACH_AGENT_PRIVATE_KEY` (or EXECUTOR_, KEEPER_) — Bech32
 *          string starting with `suiprivkey1...`. Generate via
 *          `sui keytool generate ed25519 --json | jq -r '.suiKey'`.
 *       2. File `${LIGHTHOUSE_KEYS_DIR}/<address>.key` — 44-char base64
 *          (33 bytes after decode: 1 scheme flag + 32 secret key). Filename
 *          MUST equal the derived Sui address (matches the `sui keytool`
 *          on-disk export format). The address is read from the matching
 *          `*_ADDRESS` env var (e.g. COACH_AGENT_ADDRESS).
 *   - Loaded lazily so missing config only fails when the service that needs
 *     the key boots, not on every process start.
 *   - Each keypair has a SINGLE purpose. Never share between services.
 *   - In production, the keys dir is verified to exist, be a directory, and
 *     have restrictive permissions (mode 0700). World-readable dirs throw.
 *
 * Source: https://raw.githubusercontent.com/MystenLabs/ts-sdks/main/packages/sui/src/keypairs/ed25519/keypair.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromBase64 } from '@mysten/sui/utils';

import {
  COACH_AGENT_ADDRESS,
  COACH_AGENT_PRIVATE_KEY,
  EXECUTOR_AGENT_ADDRESS,
  EXECUTOR_AGENT_PRIVATE_KEY,
  IS_PROD,
  LIGHTHOUSE_KEYS_DIR,
  SETTLEMENT_KEEPER_ADDRESS,
  SETTLEMENT_KEEPER_PRIVATE_KEY,
} from '../config/main-config.ts';

/// Expand a leading `~` to the user's home directory. Node's `fs` and `path`
/// modules do NOT auto-expand tilde, unlike shells.
function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/// Returns the resolved, absolute keys directory, with `~` expanded.
function resolveKeysDir(): string {
  return path.resolve(expandHome(LIGHTHOUSE_KEYS_DIR));
}

/// Cache for the one-time dir validation (perms, existence). Throws once,
/// remembered across all loaders.
let _keysDirValidated = false;
function validateKeysDir(dir: string): void {
  if (_keysDirValidated) return;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[keypairs] LIGHTHOUSE_KEYS_DIR does not exist: ${dir}. ` +
        `Create with: mkdir -p "${dir}" && chmod 700 "${dir}". (${msg})`,
    );
  }

  if (!stat.isDirectory()) {
    throw new Error(`[keypairs] LIGHTHOUSE_KEYS_DIR is not a directory: ${dir}`);
  }

  // Mode check: mask to permission bits. Other-readable (0o004) or
  // other-writable (0o002) is unacceptable. Group bits are warned but allowed
  // in dev.
  const mode = stat.mode & 0o777;
  const otherReadable = (mode & 0o004) !== 0;
  const otherWritable = (mode & 0o002) !== 0;
  const groupReadable = (mode & 0o040) !== 0;

  if (otherReadable || otherWritable) {
    const msg =
      `[keypairs] LIGHTHOUSE_KEYS_DIR is world-readable or world-writable ` +
      `(mode ${mode.toString(8)}): ${dir}. Fix with: chmod 700 "${dir}".`;
    if (IS_PROD) throw new Error(msg);
    console.warn(msg);
  } else if (groupReadable && IS_PROD) {
    console.warn(
      `[keypairs] LIGHTHOUSE_KEYS_DIR is group-readable (mode ${mode.toString(8)}): ${dir}. ` +
        `Recommend chmod 700.`,
    );
  }

  _keysDirValidated = true;
}

/// Validate that base64 content decodes to exactly 33 bytes (1 scheme flag +
/// 32-byte Ed25519 secret). Returns the decoded Uint8Array on success.
function parseKeyFileContent(b64: string, label: string, filename: string): Uint8Array {
  const trimmed = b64.trim();
  if (!trimmed) {
    throw new Error(`[keypairs] ${label} key file is empty: ${filename}`);
  }
  let decoded: Uint8Array;
  try {
    decoded = fromBase64(trimmed);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[keypairs] ${label} key file is not valid base64: ${filename} (${msg})`,
    );
  }
  if (decoded.length !== 33) {
    throw new Error(
      `[keypairs] ${label} key file has invalid length: ${decoded.length} bytes ` +
        `(expected 33 = 1 scheme flag + 32-byte secret): ${filename}`,
    );
  }
  // Scheme flag 0x00 = Ed25519 (per Sui crypto spec).
  if (decoded[0] !== 0x00) {
    throw new Error(
      `[keypairs] ${label} key file has non-Ed25519 scheme flag 0x${decoded[0]?.toString(16)} ` +
        `in: ${filename}`,
    );
  }
  return decoded;
}

/// Load from a `.key` file at `${LIGHTHOUSE_KEYS_DIR}/<address>.key`.
function fromKeyFile(address: string, label: string): Ed25519Keypair {
  const dir = resolveKeysDir();
  validateKeysDir(dir);
  const filename = path.join(dir, `${address}.key`);
  if (!fs.existsSync(filename)) {
    throw new Error(
      `[keypairs] ${label} key file missing: ${filename}. ` +
        `Either generate it (sui keytool export) or set ${label}_PRIVATE_KEY env var instead.`,
    );
  }

  // Defense in depth: per-file perm check.
  try {
    const fileStat = fs.statSync(filename);
    const fileMode = fileStat.mode & 0o777;
    if ((fileMode & 0o004) !== 0 || (fileMode & 0o002) !== 0) {
      const msg =
        `[keypairs] ${label} key file is world-readable (mode ${fileMode.toString(8)}): ` +
        `${filename}. Fix with: chmod 600 "${filename}".`;
      if (IS_PROD) throw new Error(msg);
      console.warn(msg);
    }
  } catch (err: unknown) {
    // statSync of an existing file should not fail; rethrow.
    throw err instanceof Error ? err : new Error(String(err));
  }

  const b64 = fs.readFileSync(filename, 'utf8');
  const decoded = parseKeyFileContent(b64, label, filename);
  // Strip the 1-byte scheme flag — Ed25519Keypair.fromSecretKey wants the
  // raw 32-byte secret.
  const secret = decoded.slice(1);
  return Ed25519Keypair.fromSecretKey(secret);
}

/// Load from a Bech32 env var string (existing behaviour).
function fromBech32(bech32: string, label: string): Ed25519Keypair {
  if (!bech32.startsWith('suiprivkey')) {
    throw new Error(
      `[keypairs] ${label} private key must be Bech32 (suiprivkey1...), got: ${bech32.slice(0, 12)}…`,
    );
  }
  const parsed = decodeSuiPrivateKey(bech32);
  // `decodeSuiPrivateKey` (`@mysten/sui@2.17`) returns
  // `{ schema: SignatureScheme; secretKey: Uint8Array }`. Passing `secretKey`
  // straight into `Ed25519Keypair.fromSecretKey` succeeds for Ed25519 schemes
  // and throws otherwise.
  return Ed25519Keypair.fromSecretKey(parsed.secretKey);
}

/// Unified loader: env var takes precedence, then file-based.
function loadKeypair(bech32: string, address: string, label: string): Ed25519Keypair {
  if (bech32) return fromBech32(bech32, label);
  if (address) return fromKeyFile(address, label);
  throw new Error(
    `[keypairs] ${label} not configured. Set ${label}_PRIVATE_KEY (Bech32) or ` +
      `${label}_ADDRESS (paired with a key file in ${resolveKeysDir()}).`,
  );
}

let _coach: Ed25519Keypair | null = null;
let _executor: Ed25519Keypair | null = null;
let _keeper: Ed25519Keypair | null = null;

/**
 * Coach agent keypair. Signs MemWal writes, Walrus blob writes, and the audit
 * anchor PTBs. Does NOT sign user trades.
 */
export function getCoachKeypair(): Ed25519Keypair {
  if (!_coach) {
    _coach = loadKeypair(COACH_AGENT_PRIVATE_KEY, COACH_AGENT_ADDRESS, 'COACH_AGENT');
  }
  return _coach;
}

/**
 * Executor agent keypair. Signs `lighthouse::executor::place_limit_under_budget`
 * PTBs ON BEHALF of users who minted an `ExecutorAgent` bound to this address.
 *
 * IMPORTANT: this address MUST equal the `agent_address` field on every
 * `ExecutorAgent` shared object the backend is allowed to drive.
 */
export function getExecutorKeypair(): Ed25519Keypair {
  if (!_executor) {
    _executor = loadKeypair(
      EXECUTOR_AGENT_PRIVATE_KEY,
      EXECUTOR_AGENT_ADDRESS,
      'EXECUTOR_AGENT',
    );
  }
  return _executor;
}

/**
 * Settlement keeper keypair (v2 stretch — Predict only). Calls
 * `predict::redeem_permissionless`. Permission-less on-chain so this is just
 * gas custody, not authority custody.
 */
export function getSettlementKeeperKeypair(): Ed25519Keypair {
  if (!_keeper) {
    _keeper = loadKeypair(
      SETTLEMENT_KEEPER_PRIVATE_KEY,
      SETTLEMENT_KEEPER_ADDRESS,
      'SETTLEMENT_KEEPER',
    );
  }
  return _keeper;
}

/// Convenience: returns the Sui address for an already-loaded keypair.
export function getCoachAddress(): string {
  return getCoachKeypair().getPublicKey().toSuiAddress();
}

export function getExecutorAddress(): string {
  return getExecutorKeypair().getPublicKey().toSuiAddress();
}

export function getKeeperAddress(): string {
  return getSettlementKeeperKeypair().getPublicKey().toSuiAddress();
}

/**
 * Returns a diagnostic summary of all configured keypairs.
 * Useful for the /health endpoint and boot-time logging.
 * Catches load errors so a misconfigured optional keypair does not crash
 * the health check.
 */
export function getKeypairAddresses(): {
  coach: string | null
  executor: string | null
  keeper: string | null
} {
  const safe = (fn: () => string): string | null => {
    try { return fn() } catch { return null }
  }
  return {
    coach: safe(getCoachAddress),
    executor: safe(getExecutorAddress),
    keeper: safe(getKeeperAddress),
  }
}
