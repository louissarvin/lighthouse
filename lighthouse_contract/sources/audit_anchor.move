// Copyright (c) Lighthouse Labs
// SPDX-License-Identifier: Apache-2.0

module lighthouse::audit_anchor;

use sui::clock::Clock;
use sui::event;
use lighthouse::version::{Self, Version};

const KIND_RECOMMENDATION: u8 = 0;
const KIND_TRADE: u8 = 1;
const KIND_WEEKLY_REPORT: u8 = 2;
const KIND_MAX: u8 = 2;
const TX_DIGEST_LEN: u64 = 32;

const EBadKind: u64 = 0;
const EBadBlobId: u64 = 1;
const EBadDigest: u64 = 2;

public struct AuditAnchor has key, store {
    id: UID,
    owner: address,
    kind: u8,
    walrus_blob_id: vector<u8>,
    sui_tx_digest: vector<u8>,
    created_at_ms: u64,
}

public struct AnchorRecorded has copy, drop, store {
    anchor_id: ID,
    owner: address,
    kind: u8,
    walrus_blob_id: vector<u8>,
    created_at_ms: u64,
}

public fun record(
    version: &Version,
    kind: u8,
    walrus_blob_id: vector<u8>,
    sui_tx_digest: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
): AuditAnchor {
    version::check_is_valid(version);
    assert!(kind <= KIND_MAX, EBadKind);
    assert!(walrus_blob_id.length() > 0, EBadBlobId);
    assert!(sui_tx_digest.length() == TX_DIGEST_LEN, EBadDigest);

    let owner = ctx.sender();
    let created_at_ms = clock.timestamp_ms();
    let uid = object::new(ctx);
    let anchor_id = uid.to_inner();

    event::emit(AnchorRecorded {
        anchor_id,
        owner,
        kind,
        walrus_blob_id,
        created_at_ms,
    });

    AuditAnchor {
        id: uid,
        owner,
        kind,
        walrus_blob_id,
        sui_tx_digest,
        created_at_ms,
    }
}

public fun transfer_to_owner(anchor: AuditAnchor) {
    let owner = anchor.owner;
    transfer::public_transfer(anchor, owner)
}

public fun owner(anchor: &AuditAnchor): address { anchor.owner }
public fun kind(anchor: &AuditAnchor): u8 { anchor.kind }
public fun walrus_blob_id(anchor: &AuditAnchor): vector<u8> { anchor.walrus_blob_id }
public fun sui_tx_digest(anchor: &AuditAnchor): vector<u8> { anchor.sui_tx_digest }
public fun created_at_ms(anchor: &AuditAnchor): u64 { anchor.created_at_ms }

public fun kind_recommendation(): u8 { KIND_RECOMMENDATION }
public fun kind_trade(): u8 { KIND_TRADE }
public fun kind_weekly_report(): u8 { KIND_WEEKLY_REPORT }
