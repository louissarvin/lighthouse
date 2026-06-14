/**
 * scripts/setup-display-objects.ts
 *
 * Registers Sui Display templates for all 4 Lighthouse user-facing types
 * in ONE atomic PTB. Maximizes the Sui stack by making our objects render
 * as rich cards in Slush / Suiet / SuiVision instead of raw 0x... IDs.
 *
 * Uses the Publisher object that was minted at deploy time via
 * `trader_profile::init`'s `package::claim_and_keep(otw, ctx)`.
 *
 *   Publisher: 0x7ae5aafa2263bb40faf50f00a6c15dcdd26ec80d21609623c1b6be1ad91255f5
 *
 * One-shot setup. Run once per published package version. Cost: ~0.05 SUI.
 *
 * PTB composition (12 moveCalls):
 *   for each of [ExecutorAgent, TraderProfile, AuditAnchor, AuditCap]:
 *     1. display::new_with_fields<T>(publisher, fields, values, ctx) → display
 *     2. display::update_version<T>(display)
 *     3. transfer::public_transfer(display, sender)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import { bcs } from '@mysten/sui/bcs';

import { suiGrpc } from '../src/lib/sui.ts';

const PKG = '0x150ae38deaf5a71e04106a6487a3779099ac1f19eeaffc1b7e83b6c43157f744';
const PUBLISHER = '0x7ae5aafa2263bb40faf50f00a6c15dcdd26ec80d21609623c1b6be1ad91255f5';
const SITE = 'https://lighthouse.wal.app';

type AnySigner = Ed25519Keypair | Secp256k1Keypair;

function loadActiveKeypair(): { keypair: AnySigner; address: string } {
  const configPath = path.join(os.homedir(), '.sui', 'sui_config', 'client.yaml');
  const activeAddr = fs
    .readFileSync(configPath, 'utf8')
    .match(/active_address:\s*"?(0x[a-f0-9]+)"?/)?.[1];
  if (!activeAddr) throw new Error('no active_address in client.yaml');
  const ks = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), '.sui', 'sui_config', 'sui.keystore'), 'utf8'),
  ) as string[];
  for (const b64 of ks) {
    const bytes = fromBase64(b64);
    const secret = bytes.slice(1, 33);
    let kp: AnySigner | null = null;
    if (bytes[0] === 0x00) kp = Ed25519Keypair.fromSecretKey(secret);
    else if (bytes[0] === 0x01) kp = Secp256k1Keypair.fromSecretKey(secret);
    if (!kp) continue;
    if (kp.toSuiAddress() === activeAddr) return { keypair: kp, address: activeAddr };
  }
  throw new Error('active keypair not found in keystore');
}

// ─── Display field templates (one per type) ─────────────────────────────

interface TypeTemplate {
  typeArg: string;
  fields: string[];
  values: string[];
}

const TEMPLATES: TypeTemplate[] = [
  // ExecutorAgent: scoped trading agent
  {
    typeArg: `${PKG}::executor::ExecutorAgent`,
    fields: ['name', 'description', 'image_url', 'link', 'project_url', 'creator'],
    values: [
      'Lighthouse Executor Agent',
      'Scoped trading agent on DeepBook. Owner {owner_address}. Agent {agent_address}. Per-trade cap {max_notional_per_trade}. Daily cap {max_notional_per_day}. Revoked: {revoked}.',
      `${SITE}/og/executor.svg`,
      `${SITE}/agent/{id}`,
      SITE,
      'Lighthouse Labs',
    ],
  },
  // TraderProfile: verifiable AI memory
  {
    typeArg: `${PKG}::trader_profile::TraderProfile`,
    fields: ['name', 'description', 'image_url', 'link', 'project_url', 'creator'],
    values: [
      'Lighthouse Trader Profile',
      'Verifiable AI trading coach memory anchored on Walrus. Owner {owner}. Created at {created_at_ms} ms.',
      `${SITE}/og/profile.svg`,
      `${SITE}/u/{id}`,
      SITE,
      'Lighthouse Labs',
    ],
  },
  // AuditAnchor: on-chain receipt for off-chain events
  {
    typeArg: `${PKG}::audit_anchor::AuditAnchor`,
    fields: ['name', 'description', 'image_url', 'link', 'project_url', 'creator'],
    values: [
      'Lighthouse Audit Anchor',
      'Cryptographic receipt for a Lighthouse coaching event. Owner {owner}. Kind {kind}. Recorded at {created_at_ms} ms. Resolves on Walrus.',
      `${SITE}/og/anchor.svg`,
      `${SITE}/anchor/{id}`,
      SITE,
      'Lighthouse Labs',
    ],
  },
  // AuditCap: time-bound decryption capability
  {
    typeArg: `${PKG}::allowlist::AuditCap`,
    fields: ['name', 'description', 'image_url', 'link', 'project_url', 'creator'],
    values: [
      'Lighthouse Audit Cap',
      'Time-bound capability to decrypt portions of an audited TraderProfile. Auditor {auditor}. Valid until {valid_until_ms} ms.',
      `${SITE}/og/auditcap.svg`,
      `${SITE}/cap/{id}`,
      SITE,
      'Lighthouse Labs',
    ],
  },
];

function addDisplayMoveCalls(tx: Transaction, sender: string, t: TypeTemplate): void {
  const [display] = tx.moveCall({
    target: '0x2::display::new_with_fields',
    typeArguments: [t.typeArg],
    arguments: [
      tx.object(PUBLISHER),
      tx.pure(bcs.vector(bcs.string()).serialize(t.fields).toBytes()),
      tx.pure(bcs.vector(bcs.string()).serialize(t.values).toBytes()),
    ],
  });
  tx.moveCall({
    target: '0x2::display::update_version',
    typeArguments: [t.typeArg],
    arguments: [display],
  });
  tx.moveCall({
    target: '0x2::transfer::public_transfer',
    typeArguments: [`0x2::display::Display<${t.typeArg}>`],
    arguments: [display, tx.pure.address(sender)],
  });
}

async function main(): Promise<void> {
  const { keypair, address } = loadActiveKeypair();
  console.log(`sender: ${address}`);
  console.log(`registering ${TEMPLATES.length} Display objects in one PTB`);

  const tx = new Transaction();
  for (const tpl of TEMPLATES) addDisplayMoveCalls(tx, address, tpl);
  tx.setSender(address);
  tx.setGasBudget(200_000_000);

  const result = (await suiGrpc.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
  })) as {
    Transaction?: {
      digest?: string;
      status?: { success?: boolean; error?: string | null };
    };
  };
  const inner = result.Transaction ?? {};
  console.log(`\ndigest:  ${inner.digest}`);
  console.log(`success: ${inner.status?.success}`);
  if (inner.status?.error) console.log(`error:   ${inner.status.error}`);
  if (inner.digest) {
    console.log(`explorer: https://suiscan.xyz/testnet/tx/${inner.digest}`);
  }
}

main().catch((err) => {
  console.error('failed:', err);
  process.exit(1);
});
