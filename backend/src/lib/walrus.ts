/**
 * Walrus client (testnet).
 *
 * Source: https://sdk.mystenlabs.com/walrus
 *   - `walrus({ uploadRelay, storageNodeClientOptions })` factory
 *   - `sui.$extend(walrus(...))` to get `client.walrus.writeBlob` / `writeFiles`
 *   - `WalrusFile.from({ contents, identifier, tags })` for Quilts
 *
 * Testnet:
 *   - Upload-relay: https://upload-relay.testnet.walrus.space
 *   - Aggregator:   https://aggregator.walrus-testnet.walrus.space
 *   - Epoch = 1 day (so `epochs: 53` ≈ 53 days lifetime)
 */

import { walrus, WalrusFile } from '@mysten/walrus';

import {
  WALRUS_AGGREGATOR_URL,
  WALRUS_DEFAULT_EPOCHS,
  WALRUS_UPLOAD_RELAY_HOST,
} from '../config/main-config.ts';
import { suiGrpc } from './sui.ts';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

/// Walrus-extended Sui client. Use `client.walrus.writeBlob(...)` etc.
export const walrusClient = suiGrpc.$extend(
  walrus({
    uploadRelay: {
      host: WALRUS_UPLOAD_RELAY_HOST,
      // `sendTip.max` is a NUMBER (not bigint). Capped at 0.001 SUI for testnet demo.
      sendTip: { max: 1_000 },
    },
    storageNodeClientOptions: { timeout: 60_000 },
  }),
);

/**
 * Write a single (typically SEAL-encrypted) blob to Walrus.
 * Returns the blob ID for on-chain anchoring.
 */
export async function writeBlob(
  bytes: Uint8Array,
  signer: Ed25519Keypair,
  opts: { deletable?: boolean; epochs?: number } = {},
): Promise<{ blobId: string }> {
  const { blobId } = await walrusClient.walrus.writeBlob({
    blob: bytes,
    deletable: opts.deletable ?? false,
    epochs: opts.epochs ?? WALRUS_DEFAULT_EPOCHS,
    signer,
  });
  return { blobId };
}

/**
 * Write a Quilt (multi-file blob). Use for weekly reports where we bundle
 * encrypted detail + plaintext tearsheet + encrypted summary in one Walrus
 * blob with three identifiers.
 */
export interface QuiltEntry {
  contents: Uint8Array;
  identifier: string;
  tags?: Record<string, string>;
}

export interface QuiltWriteResult {
  /// The parent QUILT blob id (base64url). Same on every patch row.
  quiltId: string;
  /// Per-file patch info: original identifier -> quilt-patch-id.
  patches: { identifier: string; patchId: string }[];
}

/**
 * Write a Quilt (multi-file blob).
 *
 * `writeFiles` returns one row per file with `{ id, blobId, blobObject }`.
 * Per researcher Q6 (`@mysten/walrus@1.1.7/dist/client.d.mts:824-833`):
 *   - `blobId` is the parent QUILT blob id (same on every row)
 *   - `id` is the per-file quilt-patch-id
 *
 * Public URL per testnet aggregator OpenAPI:
 *   `GET ${aggregator}/v1/blobs/by-quilt-id/{quilt_id}/{identifier}` → bytes
 */
export async function writeFiles(
  entries: QuiltEntry[],
  signer: Ed25519Keypair,
  opts: { deletable?: boolean; epochs?: number } = {},
): Promise<QuiltWriteResult> {
  const files = entries.map((e) => WalrusFile.from(e));
  const results = await walrusClient.walrus.writeFiles({
    files,
    epochs: opts.epochs ?? WALRUS_DEFAULT_EPOCHS,
    deletable: opts.deletable ?? false,
    signer,
  });
  if (results.length === 0) {
    throw new Error('[walrus] writeFiles returned empty result');
  }
  return {
    quiltId: results[0]!.blobId,
    patches: results.map((r, i) => ({
      identifier: entries[i]!.identifier,
      patchId: r.id,
    })),
  };
}

/**
 * Read a blob via the testnet aggregator. Caller decrypts with SEAL.
 */
export async function readBlob(blobId: string): Promise<Uint8Array> {
  const res = await fetch(`${WALRUS_AGGREGATOR_URL}/v1/blobs/${blobId}`);
  if (!res.ok) {
    throw new Error(`[walrus] read failed for ${blobId}: ${res.status} ${res.statusText}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Read one file from a Walrus Quilt by its identifier.
 *
 * Source: `aggregator.walrus-testnet.walrus.space/v1/api` OpenAPI spec —
 * `GET /v1/blobs/by-quilt-id/{quilt_id}/{identifier}`.
 */
export async function readQuiltFile(
  quiltId: string,
  identifier: string,
): Promise<Uint8Array> {
  const url = `${WALRUS_AGGREGATOR_URL}/v1/blobs/by-quilt-id/${quiltId}/${encodeURIComponent(identifier)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `[walrus] quilt read failed for ${quiltId}/${identifier}: ${res.status} ${res.statusText}`,
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Fetch all 3 patch files in a weekly tearsheet Quilt in parallel.
 * Returns the raw bytes for each — caller decrypts the .seal files via SEAL.
 */
export async function readWeeklyQuilt(
  quiltId: string,
  identifiers: { summary: string; detail: string; tearsheet: string },
): Promise<{ summaryCiphertext: Uint8Array; detailCiphertext: Uint8Array; tearsheetPlaintext: Uint8Array }> {
  const [summaryCiphertext, detailCiphertext, tearsheetPlaintext] = await Promise.all([
    readQuiltFile(quiltId, identifiers.summary),
    readQuiltFile(quiltId, identifiers.detail),
    readQuiltFile(quiltId, identifiers.tearsheet),
  ]);
  return { summaryCiphertext, detailCiphertext, tearsheetPlaintext };
}
