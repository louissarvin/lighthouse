/**
 * MemWal account + delegate-key provisioning.
 *
 * Per LIGHTHOUSE.md §7.4 + researcher Q2:
 *   a) zkLogin → backend has user `sui_address`.
 *   b) Backend `generateDelegateKey()` and persists the private key encrypted
 *      (envelope.ts) BEFORE any on-chain call. If the bootstrap aborts mid-flow,
 *      the user can retry without re-generating the delegate.
 *   c) PTB 1: `account::create_account` only. Sponsored via Enoki. User signs.
 *      We extract `accountId` from `tx.objectChanges` after execution.
 *      (We split create vs add_delegate because `create_account` is reported
 *      by MemWal SDK to call `transfer::share_object` internally on the
 *      account, which means we cannot pass the return value to the next
 *      Move call in the same PTB.)
 *   d) PTB 2: `account::add_delegate_key`. Sponsored via Enoki. User signs.
 *
 * The frontend orchestrates this in two HTTP round-trips so the user
 * confirms each PTB:
 *   POST /memwal/begin-bootstrap → returns sponsored PTB 1 + ephemeral delegate
 *                                  public key (private already encrypted in DB)
 *   POST /memwal/finalise        → expects { digest, signature } of PTB 1
 *                                  Backend executes PTB 1, parses accountId,
 *                                  builds PTB 2, returns the next sponsored bytes.
 *   POST /memwal/finalise-step2  → expects { digest, signature } of PTB 2
 *                                  Backend executes PTB 2; writes accountId
 *                                  onto the TraderProfile.
 */

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { getZkLoginSignature } from '@mysten/sui/zklogin';
import { generateDelegateKey } from '@mysten-incubation/memwal/account';

import {
  LIGHTHOUSE_PACKAGE_ID,
  MEMWAL_PACKAGE_ID,
  MEMWAL_REGISTRY_ID,
  SUI_NETWORK,
} from '../config/main-config.ts';
import { envelopeDecrypt, envelopeEncrypt } from '../lib/envelope.ts';
import { getEnoki } from '../lib/enoki.ts';
import { getCoachKeypair } from '../lib/keypairs.ts';
import { prismaQuery } from '../lib/prisma.ts';
import { suiGrpc, suiRpc } from '../lib/sui.ts';
import { sponsorForAddress } from '../lib/enoki.ts';
import type { ZkLoginNonceState } from '../lib/zklogin.ts';

export interface BootstrapBeginResult {
  /// Sponsored tx bytes for the user to sign client-side.
  bytes: string;
  /// Sponsor digest used to address the sponsored tx in /finalise.
  digest: string;
  /// Public key of the generated delegate (already persisted encrypted).
  delegatePublicKeyHex: string;
}

export interface BootstrapStep2Result {
  bytes: string;
  digest: string;
}

/**
 * Step 1 — generate a delegate key, encrypt+persist it, build the
 * `create_account` PTB and sponsor it.
 *
 * Idempotent: if a delegate key already exists for this profile, we reuse it.
 */
export async function beginBootstrap(profileId: string): Promise<BootstrapBeginResult> {
  if (!MEMWAL_PACKAGE_ID || !MEMWAL_REGISTRY_ID) {
    throw new Error('[memwal-bootstrap] MEMWAL_PACKAGE_ID + MEMWAL_REGISTRY_ID must be set');
  }

  const profile = await prismaQuery.traderProfile.findUnique({
    where: { id: profileId },
    select: {
      id: true,
      sui_address: true,
      memwal_account_id: true,
      memwal_delegate_key_encrypted: true,
    },
  });
  if (!profile) throw new Error(`[memwal-bootstrap] no TraderProfile id=${profileId}`);
  if (profile.memwal_account_id) {
    throw new Error('[memwal-bootstrap] memwal_account_id already set; skip bootstrap');
  }

  // Generate (or reuse) the delegate key.
  let delegateHex: string;
  let delegatePublicKeyHex: string;
  if (profile.memwal_delegate_key_encrypted) {
    // Reuse — encrypted hex is the private key.
    delegateHex = (await import('../lib/envelope.ts')).envelopeDecrypt(
      profile.id,
      profile.memwal_delegate_key_encrypted,
    );
    // Reconstruct public key from private. The SDK doesn't expose a derive-only
    // helper publicly so we regenerate via Ed25519 keypair convention.
    const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
    const kp = Ed25519Keypair.fromSecretKey(Buffer.from(delegateHex, 'hex'));
    delegatePublicKeyHex = Buffer.from(kp.getPublicKey().toRawBytes()).toString('hex');
  } else {
    const gen = await generateDelegateKey();
    delegateHex = gen.privateKey;
    delegatePublicKeyHex = Buffer.from(gen.publicKey).toString('hex');
    await prismaQuery.traderProfile.update({
      where: { id: profile.id },
      data: { memwal_delegate_key_encrypted: envelopeEncrypt(profile.id, delegateHex) },
    });
  }

  // Build PTB 1.
  const tx = new Transaction();
  const [account] = tx.moveCall({
    target: `${MEMWAL_PACKAGE_ID}::account::create_account`,
    arguments: [tx.object(MEMWAL_REGISTRY_ID), tx.object('0x6')],
  });
  // Researcher Q2: create_account may share internally. If so, the next
  // moveCall on `account` fails. We can't tell statically; we ONLY build
  // create_account here and capture the resulting object ID from effects.
  // We intentionally do NOT keep the returned `[account]` handle.
  void account;

  const sponsored = await sponsorForAddress(tx, profile.sui_address);

  return {
    bytes: sponsored.bytes,
    digest: sponsored.digest,
    delegatePublicKeyHex,
  };
}

/**
 * Step 2 — after PTB 1 has been signed + executed by the user (via the
 * /sponsor/execute path), parse the `accountId` from objectChanges, build
 * the `add_delegate_key` PTB, and sponsor it.
 *
 * @param executedDigest  Digest of the PTB 1 execution result.
 * @param label           Human-readable label for the delegate key registry.
 */
export async function buildAddDelegatePtb(
  profileId: string,
  executedDigest: string,
  label: string,
): Promise<BootstrapStep2Result> {
  if (!MEMWAL_PACKAGE_ID) {
    throw new Error('[memwal-bootstrap] MEMWAL_PACKAGE_ID must be set');
  }

  const profile = await prismaQuery.traderProfile.findUnique({
    where: { id: profileId },
    select: {
      id: true,
      sui_address: true,
      memwal_delegate_key_encrypted: true,
    },
  });
  if (!profile) throw new Error(`[memwal-bootstrap] no TraderProfile id=${profileId}`);
  if (!profile.memwal_delegate_key_encrypted) {
    throw new Error('[memwal-bootstrap] no delegate key persisted; call /memwal/begin first');
  }

  // Look up the accountId from PTB 1 effects.
  const txResp = await suiGrpc.getTransaction({
    digest: executedDigest,
    include: { effects: true, objectTypes: true },
  });
  const accountId = extractMemWalAccountId(txResp);
  if (!accountId) {
    throw new Error(
      `[memwal-bootstrap] failed to find created MemWalAccount in tx ${executedDigest}`,
    );
  }

  // Persist accountId.
  await prismaQuery.traderProfile.update({
    where: { id: profile.id },
    data: { memwal_account_id: accountId },
  });

  // Reconstruct delegate keypair for public key derivation.
  const { envelopeDecrypt } = await import('../lib/envelope.ts');
  const delegateHex = envelopeDecrypt(profile.id, profile.memwal_delegate_key_encrypted);
  const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
  const kp = Ed25519Keypair.fromSecretKey(Buffer.from(delegateHex, 'hex'));
  const publicKey = Array.from(kp.getPublicKey().toRawBytes());
  const delegateSuiAddress = kp.getPublicKey().toSuiAddress();

  // Build PTB 2 — `account::add_delegate_key(account, public_key, sui_address, label, clock)`.
  // Per researcher Q2: the SDK derives sui_address from public_key INSIDE the
  // SDK, but the underlying Move call still takes it as a parameter.
  const tx = new Transaction();
  tx.moveCall({
    target: `${MEMWAL_PACKAGE_ID}::account::add_delegate_key`,
    arguments: [
      tx.object(accountId),
      tx.pure(bcs.vector(bcs.U8).serialize(publicKey).toBytes()),
      tx.pure(bcs.Address.serialize(delegateSuiAddress).toBytes()),
      tx.pure(bcs.String.serialize(label).toBytes()),
      tx.object('0x6'),
    ],
  });

  const sponsored = await sponsorForAddress(tx, profile.sui_address);
  return { bytes: sponsored.bytes, digest: sponsored.digest };
}

/**
 * zkLogin-signed MemWal bootstrap with coach-paid gas.
 *
 * Why not Enoki sponsorship: the MemWal package is not on Enoki's allowlist.
 * Why not fully server-side: `account::create_account` registers ONE account
 * per sender address — the coach cannot be sender for multiple users.
 *
 * Solution: user's zkLogin address is the sender (so the registry slot is
 * unique per user), and the coach keypair provides the gas coins. The coach
 * co-signs as gas owner; the user signs the transaction body via zkLogin.
 * No Enoki gas endpoint is called — only `createZkLoginZkp` for the proof.
 *
 * Both PTBs reuse the same ZKP (valid for the entire epoch window) but
 * produce different user signatures (different transaction bytes).
 */
export async function bootstrapMemWalViaZkLogin(args: {
  profileId: string;
  jwt: string;
  zklState: ZkLoginNonceState;
}): Promise<{ accountId: string; digest1: string; digest2: string }> {
  if (!MEMWAL_PACKAGE_ID || !MEMWAL_REGISTRY_ID) {
    throw new Error('[memwal-bootstrap] MEMWAL_PACKAGE_ID + MEMWAL_REGISTRY_ID must be set');
  }

  const profile = await prismaQuery.traderProfile.findUnique({
    where: { id: args.profileId },
    select: { id: true, sui_address: true, memwal_account_id: true, memwal_delegate_key_encrypted: true },
  });
  if (!profile) throw new Error(`[memwal-bootstrap] no TraderProfile id=${args.profileId}`);
  if (profile.memwal_account_id) {
    return { accountId: profile.memwal_account_id, digest1: '', digest2: '' };
  }

  // Generate (or reuse) the per-user delegate key.
  let delegateHex: string;
  if (profile.memwal_delegate_key_encrypted) {
    delegateHex = envelopeDecrypt(profile.id, profile.memwal_delegate_key_encrypted);
  } else {
    const gen = await generateDelegateKey();
    delegateHex = gen.privateKey;
    await prismaQuery.traderProfile.update({
      where: { id: profile.id },
      data: { memwal_delegate_key_encrypted: envelopeEncrypt(profile.id, delegateHex) },
    });
  }

  const coach = getCoachKeypair();
  const enoki = getEnoki();
  const network = SUI_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';

  // Reconstruct ephemeral keypair from OAuth nonce state.
  const ephemeral = Ed25519Keypair.fromSecretKey(
    Buffer.from(args.zklState.ephemeralSecretHex, 'hex'),
  );

  // Build the ZKP once — reusable for both PTBs within the same epoch window.
  const zkpInputs = await enoki.createZkLoginZkp({
    network,
    jwt: args.jwt,
    ephemeralPublicKey: ephemeral.getPublicKey(),
    randomness: args.zklState.randomness,
    maxEpoch: args.zklState.maxEpoch,
  });

  // Detect transient rate-limit / resource-exhausted errors that Sui public
  // testnet returns under load. Retry with exponential backoff instead of
  // failing the whole onboarding for one throttled call.
  const isTransientRateLimit = (e: unknown): boolean => {
    const msg = (e as Error)?.message?.toLowerCase() ?? '';
    const code = (e as { code?: string })?.code ?? '';
    return (
      msg.includes('429') ||
      msg.includes('too many requests') ||
      msg.includes('resource_exhausted') ||
      msg.includes('resource exhausted') ||
      msg.includes('unavailable') ||
      code === 'RESOURCE_EXHAUSTED' ||
      code === 'UNAVAILABLE'
    );
  };

  // Helper: build tx, dual-sign (user zkLogin + coach gas), execute.
  // Retries up to 5× on 429/RESOURCE_EXHAUSTED with exponential backoff
  // (1s → 2s → 4s → 8s → 16s). Other errors propagate immediately.
  const executeWithCoachGas = async (tx: Transaction): Promise<string> => {
    tx.setSender(profile.sui_address);
    tx.setGasOwner(coach.toSuiAddress());
    tx.setGasBudget(50_000_000);
    const bytes = await tx.build({ client: suiGrpc as never });

    // User's zkLogin signature over these specific transaction bytes.
    const { signature: userSig } = await ephemeral.signTransaction(bytes);
    const wrappedZk = getZkLoginSignature({
      inputs: zkpInputs,
      maxEpoch: args.zklState.maxEpoch,
      userSignature: userSig,
    });

    // Coach co-signs as gas owner.
    const { signature: coachSig } = await coach.signTransaction(bytes);

    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = (await suiGrpc.executeTransaction({
          transaction: bytes,
          signatures: [wrappedZk, coachSig],
        })) as { Transaction?: { digest?: string }; digest?: string };
        const digest = res.Transaction?.digest ?? res.digest ?? '';
        if (!digest) throw new Error('[memwal-bootstrap] executeWithCoachGas returned no digest');
        return digest;
      } catch (e) {
        lastErr = e;
        if (!isTransientRateLimit(e)) throw e;
        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 16_000);
        console.warn(
          `[memwal-bootstrap] executeTransaction 429/RESOURCE_EXHAUSTED — retry ${attempt + 1}/5 after ${backoffMs}ms`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
    throw new Error(
      `[memwal-bootstrap] executeWithCoachGas exhausted 5 retries on rate-limit: ${(lastErr as Error)?.message ?? String(lastErr)}`,
    );
  };

  // ── PTB 1: account::create_account (user is sender → account in user's registry slot) ──
  const tx1 = new Transaction();
  tx1.moveCall({
    target: `${MEMWAL_PACKAGE_ID}::account::create_account`,
    arguments: [tx1.object(MEMWAL_REGISTRY_ID), tx1.object('0x6')],
  });

  let digest1: string;
  let accountId: string;

  try {
    digest1 = await executeWithCoachGas(tx1);

    // Query effects to extract the created MemWalAccount object id.
    let txResp: unknown = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        txResp = await suiGrpc.getTransaction({
          digest: digest1,
          include: { effects: true, objectTypes: true },
        });
        break;
      } catch {
        if (attempt < 4) await new Promise((r) => setTimeout(r, 1000));
      }
    }

    const extracted = extractMemWalAccountId(txResp);
    if (!extracted) {
      throw new Error(
        `[memwal-bootstrap] could not find MemWalAccount in PTB1 effects (tx=${digest1})`,
      );
    }
    accountId = extracted;
  } catch (ptb1Err) {
    // PTB1 may fail with Move abort code 1 if the user already has a registry
    // entry from a previous bootstrap attempt where the account was created
    // on-chain but the ID was never persisted to DB (e.g., due to the old
    // parsing bug). Attempt recovery by scanning recent txs for this sender.
    console.warn(
      `[memwal-bootstrap] PTB1 error — attempting registry recovery for ${profile.sui_address}:`,
      (ptb1Err as Error).message,
    );
    const existing = await findExistingMemWalAccount(profile.sui_address);
    if (!existing) {
      throw ptb1Err;
    }
    console.log(
      `[memwal-bootstrap] recovery: found existing MemWalAccount ${existing} for ${profile.sui_address}`,
    );
    accountId = existing;
    digest1 = '(recovered)';
  }

  // Persist immediately so a PTB2 failure is recoverable.
  await prismaQuery.traderProfile.update({
    where: { id: profile.id },
    data: { memwal_account_id: accountId },
  });

  // ── PTB 2: account::add_delegate_key ──────────────────────────────────────
  const kp = Ed25519Keypair.fromSecretKey(Buffer.from(delegateHex, 'hex'));
  const publicKey = Array.from(kp.getPublicKey().toRawBytes());
  const delegateSuiAddress = kp.getPublicKey().toSuiAddress();

  const tx2 = new Transaction();
  tx2.moveCall({
    target: `${MEMWAL_PACKAGE_ID}::account::add_delegate_key`,
    arguments: [
      tx2.object(accountId),
      tx2.pure(bcs.vector(bcs.U8).serialize(publicKey).toBytes()),
      tx2.pure(bcs.Address.serialize(delegateSuiAddress).toBytes()),
      tx2.pure(bcs.String.serialize('lighthouse-coach').toBytes()),
      tx2.object('0x6'),
    ],
  });
  const digest2 = await executeWithCoachGas(tx2);

  console.log(
    `[memwal-bootstrap] zkLogin bootstrap complete — profile=${args.profileId} ` +
      `account=${accountId.slice(0, 10)}… ptb1=${digest1.slice(0, 12)}… ptb2=${digest2.slice(0, 12)}…`,
  );

  return { accountId, digest1, digest2 };
}

/**
 * Fully server-side MemWal bootstrap — no user signature, no Enoki sponsorship.
 *
 * The coach keypair is the transaction sender for both PTBs, making it the
 * MemWal account owner. The per-user delegate key (encrypted in DB) is added
 * as a delegate so the backend can recall/remember on behalf of the user.
 *
 * Why server-side: the MemWal package is not on Enoki's sponsorship allowlist,
 * so user-signed sponsored transactions are blocked. Since the coach already
 * has write authority over trades and audit anchors, it is appropriate for it
 * to own and manage MemWal accounts too.
 *
 * Idempotent: if memwal_account_id is already set on the profile, returns
 * the existing value without touching the chain.
 */
export async function bootstrapMemWalServerSide(
  profileId: string,
): Promise<{ accountId: string; digest1: string; digest2: string }> {
  if (!MEMWAL_PACKAGE_ID || !MEMWAL_REGISTRY_ID) {
    throw new Error('[memwal-bootstrap] MEMWAL_PACKAGE_ID + MEMWAL_REGISTRY_ID must be set');
  }

  const profile = await prismaQuery.traderProfile.findUnique({
    where: { id: profileId },
    select: {
      id: true,
      sui_address: true,
      memwal_account_id: true,
      memwal_delegate_key_encrypted: true,
    },
  });
  if (!profile) throw new Error(`[memwal-bootstrap] no TraderProfile id=${profileId}`);
  if (profile.memwal_account_id) {
    return { accountId: profile.memwal_account_id, digest1: '', digest2: '' };
  }

  // Generate (or reuse) the per-user delegate key.
  let delegateHex: string;
  if (profile.memwal_delegate_key_encrypted) {
    delegateHex = envelopeDecrypt(profile.id, profile.memwal_delegate_key_encrypted);
  } else {
    const gen = await generateDelegateKey();
    delegateHex = gen.privateKey;
    await prismaQuery.traderProfile.update({
      where: { id: profile.id },
      data: { memwal_delegate_key_encrypted: envelopeEncrypt(profile.id, delegateHex) },
    });
  }

  const coach = getCoachKeypair();

  // ── PTB 1: account::create_account ────────────────────────────────────────
  const tx1 = new Transaction();
  tx1.moveCall({
    target: `${MEMWAL_PACKAGE_ID}::account::create_account`,
    arguments: [tx1.object(MEMWAL_REGISTRY_ID), tx1.object('0x6')],
  });
  tx1.setSender(coach.toSuiAddress());
  tx1.setGasBudget(50_000_000);
  const built1 = await tx1.build({ client: suiGrpc as never });
  const sig1 = await coach.signTransaction(built1);
  const res1 = (await suiGrpc.executeTransaction({
    transaction: built1,
    signatures: [sig1.signature],
  })) as { Transaction?: { digest?: string }; digest?: string };
  const digest1 = res1.Transaction?.digest ?? res1.digest ?? '';
  if (!digest1) throw new Error('[memwal-bootstrap] PTB1 returned no digest');

  // Query effects to extract the newly created MemWalAccount object id.
  // Retry up to 5× with 1 s backoff for RPC propagation lag.
  let txResp: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      txResp = await suiGrpc.getTransaction({
        digest: digest1,
        include: { effects: true, objectTypes: true },
      });
      break;
    } catch {
      if (attempt < 4) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const accountId = extractMemWalAccountId(txResp);
  if (!accountId) {
    throw new Error(
      `[memwal-bootstrap] could not find MemWalAccount in PTB1 effects (tx=${digest1})`,
    );
  }

  // Persist accountId immediately — even if PTB2 fails the account exists and
  // can be recovered by re-running this function (it will skip PTB1 on retry).
  await prismaQuery.traderProfile.update({
    where: { id: profile.id },
    data: { memwal_account_id: accountId },
  });

  // ── PTB 2: account::add_delegate_key ──────────────────────────────────────
  const kp = Ed25519Keypair.fromSecretKey(Buffer.from(delegateHex, 'hex'));
  const publicKey = Array.from(kp.getPublicKey().toRawBytes());
  const delegateSuiAddress = kp.getPublicKey().toSuiAddress();

  const tx2 = new Transaction();
  tx2.moveCall({
    target: `${MEMWAL_PACKAGE_ID}::account::add_delegate_key`,
    arguments: [
      tx2.object(accountId),
      tx2.pure(bcs.vector(bcs.U8).serialize(publicKey).toBytes()),
      tx2.pure(bcs.Address.serialize(delegateSuiAddress).toBytes()),
      tx2.pure(bcs.String.serialize('lighthouse-coach').toBytes()),
      tx2.object('0x6'),
    ],
  });
  tx2.setSender(coach.toSuiAddress());
  tx2.setGasBudget(50_000_000);
  const built2 = await tx2.build({ client: suiGrpc as never });
  const sig2 = await coach.signTransaction(built2);
  const res2 = (await suiGrpc.executeTransaction({
    transaction: built2,
    signatures: [sig2.signature],
  })) as { Transaction?: { digest?: string }; digest?: string };
  const digest2 = res2.Transaction?.digest ?? res2.digest ?? '';

  console.log(
    `[memwal-bootstrap] server-side complete — profile=${profileId} ` +
      `account=${accountId.slice(0, 10)}… ptb1=${digest1.slice(0, 12)}… ptb2=${digest2.slice(0, 12)}…`,
  );

  return { accountId, digest1, digest2 };
}

// === Helpers ===

/**
 * Extract the newly-created MemWalAccount object ID from a SuiGrpcClient
 * `getTransaction` response.
 *
 * The gRPC client returns a **different shape** than JSON-RPC:
 *   { $kind: 'Transaction', Transaction: { effects: { changedObjects }, objectTypes } }
 *
 * `objectChanges` (JSON-RPC field) does not exist here.  Instead:
 *   - `effects.changedObjects[n].idOperation === 'Created'` flags a new object.
 *   - `objectTypes[objectId]` gives the full Move struct type for that object.
 *
 * We request both `include.effects` and `include.objectTypes` in the gRPC call
 * so that both arrays are populated.
 *
 * Ref: node_modules/@mysten/sui/src/grpc/core.ts — parseTransaction,
 *      parseTransactionEffects, mapIdOperation.
 */
interface GrpcChangedObject {
  objectId?: string;
  idOperation?: string; // 'Created' | 'Deleted' | 'None' | 'Unknown' | null
}

interface GrpcTransactionResult {
  Transaction?: {
    effects?: {
      changedObjects?: GrpcChangedObject[];
    };
    objectTypes?: Record<string, string>;
  };
}

/**
 * Recovery helper: scan recent transactions from `senderAddress` looking for
 * a MemWalAccount creation. Used when PTB1 fails with Move abort code 1
 * (registry slot already occupied from a prior bootstrap attempt).
 *
 * Uses the JSON-RPC client (suiRpc) because `queryTransactionBlocks` is not
 * yet available on the gRPC client surface, and `showObjectChanges` in the
 * JSON-RPC response is the easiest way to find the created shared object.
 */
async function findExistingMemWalAccount(senderAddress: string): Promise<string | null> {
  try {
    const page = await suiRpc.queryTransactionBlocks({
      filter: { FromAddress: senderAddress },
      options: { showObjectChanges: true },
      limit: 20,
      order: 'descending',
    });
    for (const tx of page.data) {
      for (const change of tx.objectChanges ?? []) {
        if (
          change.type === 'created' &&
          'objectType' in change &&
          (change.objectType as string)?.includes('::account::MemWalAccount')
        ) {
          return (change as { objectId: string }).objectId;
        }
      }
    }
  } catch (e) {
    console.warn('[memwal-bootstrap] recovery query failed:', (e as Error).message);
  }
  return null;
}

function extractMemWalAccountId(txResp: unknown): string | null {
  const tx = (txResp as GrpcTransactionResult)?.Transaction;
  if (!tx) return null;

  const changedObjects = tx.effects?.changedObjects ?? [];
  const objectTypes = tx.objectTypes ?? {};

  for (const obj of changedObjects) {
    if (
      obj.idOperation === 'Created' &&
      obj.objectId &&
      objectTypes[obj.objectId]?.includes('::account::MemWalAccount')
    ) {
      return obj.objectId;
    }
  }
  return null;
}

/// Used by `/memwal/begin` route to ensure the LIGHTHOUSE_PACKAGE_ID is set
/// — bootstrap depends on the package being published.
export function ensurePackagePublished(): void {
  if (!LIGHTHOUSE_PACKAGE_ID) {
    throw new Error('[memwal-bootstrap] LIGHTHOUSE_PACKAGE_ID must be set');
  }
}
