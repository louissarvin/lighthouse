// Copyright (c) Lighthouse Labs
// SPDX-License-Identifier: Apache-2.0
module lighthouse::trader_profile;

use std::string::String;
use sui::clock::Clock;
use sui::package;
use sui::table::{Self, Table};
use sui::vec_set::{Self, VecSet};
use lighthouse::allowlist::{Self, Allowlist, AuditCap};
use lighthouse::version::{Self, Version};

const ENotOwner: u64 = 0;
const EBadSlice: u64 = 1;
const ENotInAllowlist: u64 = 2;
const EExpired: u64 = 3;
const EBadIdPrefix: u64 = 4;

const SEP_BYTE: u8 = 58; 
const SLICE_OFFSET: u64 = 33;

public struct TRADER_PROFILE() has drop;

public struct TraderProfile has key {
    id: UID,
    owner: address,
    created_at_ms: u64,
    latest_blobs: Table<String, vector<u8>>,
    copy_trader_grants: Allowlist,
    audit_grants: VecSet<ID>,
}

fun init(otw: TRADER_PROFILE, ctx: &mut TxContext) {
    package::claim_and_keep(otw, ctx);
}

public fun create(version: &Version, clock: &Clock, ctx: &mut TxContext): TraderProfile {
    version::check_is_valid(version);
    TraderProfile {
        id: object::new(ctx),
        owner: ctx.sender(),
        created_at_ms: clock.timestamp_ms(),
        latest_blobs: table::new(ctx),
        copy_trader_grants: allowlist::new(ctx),
        audit_grants: vec_set::empty<ID>(),
    }
}

#[allow(lint(share_owned))]
public fun share(profile: TraderProfile) {
    transfer::share_object(profile)
}

fun check_id_prefix(id: &vector<u8>, profile: &TraderProfile): bool {
    let prefix = object::uid_to_bytes(&profile.id);
    let plen = prefix.length();
    let ilen = id.length();
    if (ilen < plen + 1) { return false };
    let mut i = 0;
    while (i < plen) {
        if (id[i] != prefix[i]) { return false };
        i = i + 1;
    };
    id[plen] == SEP_BYTE
}

fun extract_slice(id: &vector<u8>): vector<u8> {
    let len = id.length();
    let mut out = vector::empty<u8>();
    let mut i = SLICE_OFFSET;
    while (i < len) {
        out.push_back(id[i]);
        i = i + 1;
    };
    out
}

entry fun seal_approve_owner(
    id: vector<u8>,
    profile: &TraderProfile,
    ctx: &TxContext,
) {
    assert!(check_id_prefix(&id, profile), EBadIdPrefix);
    assert!(ctx.sender() == profile.owner, ENotOwner);
}

entry fun seal_approve_copy_trader(
    id: vector<u8>,
    profile: &TraderProfile,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(check_id_prefix(&id, profile), EBadIdPrefix);
    let slice = extract_slice(&id);
    assert!(slice == b"risk-profile", EBadSlice);
    let caller = ctx.sender();
    let granted_until = allowlist::granted_until(&profile.copy_trader_grants, &caller);
    assert!(granted_until > 0, ENotInAllowlist);
    assert!(clock.timestamp_ms() < granted_until, EExpired);
}

entry fun seal_approve_audit(
    id: vector<u8>,
    profile: &TraderProfile,
    cap: &AuditCap,
    clock: &Clock,
) {
    assert!(check_id_prefix(&id, profile), EBadIdPrefix);
    let cap_id = object::id(cap);
    assert!(vec_set::contains(&profile.audit_grants, &cap_id), ENotInAllowlist);
    assert!(allowlist::audit_cap_valid(cap, clock), EExpired);
}

public fun update_blob(
    version: &Version,
    profile: &mut TraderProfile,
    slice: String,
    blob_id: vector<u8>,
    ctx: &TxContext,
) {
    version::check_is_valid(version);
    assert!(ctx.sender() == profile.owner, ENotOwner);
    assert!(slice.length() > 0, EBadSlice);
    assert!(blob_id.length() > 0, EBadSlice);
    if (table::contains(&profile.latest_blobs, slice)) {
        *table::borrow_mut(&mut profile.latest_blobs, slice) = blob_id;
    } else {
        table::add(&mut profile.latest_blobs, slice, blob_id);
    };
}

public fun grant_audit(
    version: &Version,
    profile: &mut TraderProfile,
    auditor: address,
    valid_until_ms: u64,
    ctx: &mut TxContext,
) {
    version::check_is_valid(version);
    assert!(ctx.sender() == profile.owner, ENotOwner);
    let cap = allowlist::mint_audit_cap(auditor, valid_until_ms, ctx);
    vec_set::insert(&mut profile.audit_grants, object::id(&cap));
    transfer::public_transfer(cap, auditor);
}

public fun revoke_audit(
    version: &Version,
    profile: &mut TraderProfile,
    cap_id: ID,
    ctx: &TxContext,
) {
    version::check_is_valid(version);
    assert!(ctx.sender() == profile.owner, ENotOwner);
    if (vec_set::contains(&profile.audit_grants, &cap_id)) {
        vec_set::remove(&mut profile.audit_grants, &cap_id);
    };
}

public fun grant_copy_trader(
    version: &Version,
    profile: &mut TraderProfile,
    copy_trader: address,
    valid_until_ms: u64,
    ctx: &TxContext,
) {
    version::check_is_valid(version);
    assert!(ctx.sender() == profile.owner, ENotOwner);
    allowlist::grant(&mut profile.copy_trader_grants, copy_trader, valid_until_ms);
}

public fun revoke_copy_trader(
    version: &Version,
    profile: &mut TraderProfile,
    copy_trader: address,
    ctx: &TxContext,
) {
    version::check_is_valid(version);
    assert!(ctx.sender() == profile.owner, ENotOwner);
    allowlist::revoke(&mut profile.copy_trader_grants, &copy_trader);
}


public fun owner(profile: &TraderProfile): address { profile.owner }
public fun created_at_ms(profile: &TraderProfile): u64 { profile.created_at_ms }

public fun latest_blob(profile: &TraderProfile, slice: String): vector<u8> {
    if (table::contains(&profile.latest_blobs, slice)) {
        *table::borrow(&profile.latest_blobs, slice)
    } else {
        vector::empty<u8>()
    }
}

public fun copy_trader_granted_until(profile: &TraderProfile, addr: address): u64 {
    allowlist::granted_until(&profile.copy_trader_grants, &addr)
}

public fun audit_grant_count(profile: &TraderProfile): u64 {
    vec_set::length(&profile.audit_grants)
}

public fun is_audit_granted(profile: &TraderProfile, cap_id: &ID): bool {
    vec_set::contains(&profile.audit_grants, cap_id)
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(TRADER_PROFILE(), ctx)
}
