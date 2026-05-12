// Copyright (c) Lighthouse Labs
// SPDX-License-Identifier: Apache-2.0

#[test_only]
#[allow(implicit_const_copy)]
module lighthouse::trader_profile_tests;

use std::string;
use sui::clock;
use sui::test_scenario::{Self as ts};
use lighthouse::trader_profile;
use lighthouse::allowlist::AuditCap;
use lighthouse::version::{Self, Version};

const OWNER: address = @0xA1;
const COPY_TRADER: address = @0xA2;
const AUDITOR: address = @0xA3;
const RANDO: address = @0xA4;

fun setup_version(scenario: &mut ts::Scenario): Version {
    version::init_for_testing(scenario.ctx());
    scenario.next_tx(OWNER);
    scenario.take_shared<Version>()
}

#[test]
fun create_records_owner_and_timestamp() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let mut clk = clock::create_for_testing(scenario.ctx());
    clock::set_for_testing(&mut clk, 12345);

    let profile = trader_profile::create(&ver, &clk, scenario.ctx());
    assert!(trader_profile::owner(&profile) == OWNER, 100);
    assert!(trader_profile::created_at_ms(&profile) == 12345, 101);
    assert!(trader_profile::audit_grant_count(&profile) == 0, 102);

    trader_profile::share(profile);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test]
fun update_blob_owner_succeeds() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let clk = clock::create_for_testing(scenario.ctx());

    let mut profile = trader_profile::create(&ver, &clk, scenario.ctx());
    trader_profile::update_blob(
        &ver,
        &mut profile,
        string::utf8(b"risk-profile"),
        b"blob-xyz",
        scenario.ctx(),
    );
    assert!(
        trader_profile::latest_blob(&profile, string::utf8(b"risk-profile")) == b"blob-xyz",
        100,
    );

    trader_profile::update_blob(
        &ver,
        &mut profile,
        string::utf8(b"risk-profile"),
        b"blob-new",
        scenario.ctx(),
    );
    assert!(
        trader_profile::latest_blob(&profile, string::utf8(b"risk-profile")) == b"blob-new",
        101,
    );

    trader_profile::share(profile);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test, expected_failure(abort_code = trader_profile::ENotOwner)]
fun update_blob_non_owner_aborts() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let clk = clock::create_for_testing(scenario.ctx());
    let mut profile = trader_profile::create(&ver, &clk, scenario.ctx());

    scenario.next_tx(RANDO);
    trader_profile::update_blob(
        &ver,
        &mut profile,
        string::utf8(b"risk-profile"),
        b"blob",
        scenario.ctx(),
    );

    trader_profile::share(profile);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test]
fun grant_revoke_copy_trader_flow() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let clk = clock::create_for_testing(scenario.ctx());
    let mut profile = trader_profile::create(&ver, &clk, scenario.ctx());

    trader_profile::grant_copy_trader(&ver, &mut profile, COPY_TRADER, 10_000, scenario.ctx());
    assert!(
        trader_profile::copy_trader_granted_until(&profile, COPY_TRADER) == 10_000,
        100,
    );

    trader_profile::revoke_copy_trader(&ver, &mut profile, COPY_TRADER, scenario.ctx());
    assert!(
        trader_profile::copy_trader_granted_until(&profile, COPY_TRADER) == 0,
        101,
    );

    // Re-revoke is idempotent.
    trader_profile::revoke_copy_trader(&ver, &mut profile, COPY_TRADER, scenario.ctx());

    trader_profile::share(profile);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test, expected_failure(abort_code = trader_profile::ENotOwner)]
fun grant_copy_trader_non_owner_aborts() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let clk = clock::create_for_testing(scenario.ctx());
    let mut profile = trader_profile::create(&ver, &clk, scenario.ctx());

    scenario.next_tx(RANDO);
    trader_profile::grant_copy_trader(&ver, &mut profile, COPY_TRADER, 10_000, scenario.ctx());

    trader_profile::share(profile);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test]
fun grant_audit_mints_cap_and_registers() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let clk = clock::create_for_testing(scenario.ctx());
    let mut profile = trader_profile::create(&ver, &clk, scenario.ctx());

    trader_profile::grant_audit(&ver, &mut profile, AUDITOR, 99_999, scenario.ctx());
    assert!(trader_profile::audit_grant_count(&profile) == 1, 100);

    scenario.next_tx(AUDITOR);
    let cap = scenario.take_from_sender<AuditCap>();
    assert!(trader_profile::is_audit_granted(&profile, &sui::object::id(&cap)), 101);

    scenario.next_tx(OWNER);
    trader_profile::revoke_audit(&ver, &mut profile, sui::object::id(&cap), scenario.ctx());
    assert!(trader_profile::audit_grant_count(&profile) == 0, 102);
    assert!(!trader_profile::is_audit_granted(&profile, &sui::object::id(&cap)), 103);

    transfer::public_transfer(cap, AUDITOR);
    std::unit_test::destroy(profile);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test, expected_failure(abort_code = trader_profile::ENotOwner)]
fun revoke_audit_non_owner_aborts() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let clk = clock::create_for_testing(scenario.ctx());
    let mut profile = trader_profile::create(&ver, &clk, scenario.ctx());

    trader_profile::grant_audit(&ver, &mut profile, AUDITOR, 99_999, scenario.ctx());

    scenario.next_tx(AUDITOR);
    let cap = scenario.take_from_sender<AuditCap>();

    scenario.next_tx(RANDO);
    trader_profile::revoke_audit(&ver, &mut profile, sui::object::id(&cap), scenario.ctx());

    transfer::public_transfer(cap, AUDITOR);
    std::unit_test::destroy(profile);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

// ============================================================================
// SEAL approve entry function tests
// ----------------------------------------------------------------------------
// These tests cover the three `seal_approve_*` entry functions consumed by the
// SEAL key server policy check. The single most security-critical assertion is
// `check_id_prefix`: it binds the SEAL identity (first 32 bytes of `id`) to the
// `&TraderProfile` reference passed in the same call, blocking an attacker
// from substituting a different profile object reference under an `id` they
// have authority for.
//
// SEAL `id` byte layout (see LIGHTHOUSE.md §6.2):
//   [0..32)  profile UID bytes (object::uid_to_bytes)
//   [32]     SEP_BYTE = b':' (0x3A == 58)
//   [33..]   slice name (e.g. b"risk-profile", b"trade-history")
// ============================================================================

const SEP_BYTE: u8 = 58; // ':'

/// Build a SEAL `id` from a profile's object id bytes and a slice name.
fun build_id(profile: &trader_profile::TraderProfile, slice: vector<u8>): vector<u8> {
    let prefix = sui::object::id_bytes(profile);
    let mut id = vector::empty<u8>();
    let mut i = 0;
    let plen = prefix.length();
    while (i < plen) {
        id.push_back(prefix[i]);
        i = i + 1;
    };
    id.push_back(SEP_BYTE);
    let mut j = 0;
    let slen = slice.length();
    while (j < slen) {
        id.push_back(slice[j]);
        j = j + 1;
    };
    id
}

#[test]
fun seal_approve_owner_succeeds_with_valid_id() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let clk = clock::create_for_testing(scenario.ctx());
    let profile = trader_profile::create(&ver, &clk, scenario.ctx());

    let id = build_id(&profile, b"risk-profile");
    // OWNER is the active sender; expect clean return.
    trader_profile::seal_approve_owner(id, &profile, scenario.ctx());

    std::unit_test::destroy(profile);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test, expected_failure(abort_code = trader_profile::EBadIdPrefix)]
fun seal_approve_owner_aborts_on_bad_id_prefix() {
    // Object-substitution defense: an id authorized for P2 must not pass when
    // P1 is the object reference handed to the entry function.
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let clk = clock::create_for_testing(scenario.ctx());
    let p1 = trader_profile::create(&ver, &clk, scenario.ctx());
    let p2 = trader_profile::create(&ver, &clk, scenario.ctx());

    let bad_id = build_id(&p2, b"risk-profile");
    trader_profile::seal_approve_owner(bad_id, &p1, scenario.ctx());

    std::unit_test::destroy(p1);
    std::unit_test::destroy(p2);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test]
fun seal_approve_copy_trader_succeeds_when_grant_active() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let mut clk = clock::create_for_testing(scenario.ctx());
    clock::set_for_testing(&mut clk, 1_000);
    let mut profile = trader_profile::create(&ver, &clk, scenario.ctx());

    // Grant valid for 1 hour from current clock.
    trader_profile::grant_copy_trader(
        &ver,
        &mut profile,
        COPY_TRADER,
        1_000 + 3_600_000,
        scenario.ctx(),
    );

    let id = build_id(&profile, b"risk-profile");
    scenario.next_tx(COPY_TRADER);
    trader_profile::seal_approve_copy_trader(id, &profile, &clk, scenario.ctx());

    std::unit_test::destroy(profile);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test, expected_failure(abort_code = trader_profile::EExpired)]
fun seal_approve_copy_trader_aborts_when_grant_expired() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let mut clk = clock::create_for_testing(scenario.ctx());
    clock::set_for_testing(&mut clk, 10_000);
    let mut profile = trader_profile::create(&ver, &clk, scenario.ctx());

    // Grant expired 1ms in the past (granted_until = 9_999, clock = 10_000).
    trader_profile::grant_copy_trader(&ver, &mut profile, COPY_TRADER, 9_999, scenario.ctx());

    let id = build_id(&profile, b"risk-profile");
    scenario.next_tx(COPY_TRADER);
    trader_profile::seal_approve_copy_trader(id, &profile, &clk, scenario.ctx());

    std::unit_test::destroy(profile);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test, expected_failure(abort_code = trader_profile::EBadSlice)]
fun seal_approve_copy_trader_aborts_on_wrong_slice() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let mut clk = clock::create_for_testing(scenario.ctx());
    clock::set_for_testing(&mut clk, 1_000);
    let mut profile = trader_profile::create(&ver, &clk, scenario.ctx());

    trader_profile::grant_copy_trader(
        &ver,
        &mut profile,
        COPY_TRADER,
        1_000 + 3_600_000,
        scenario.ctx(),
    );

    // Copy-trader only has access to `risk-profile`, not `trade-history`.
    let id = build_id(&profile, b"trade-history");
    scenario.next_tx(COPY_TRADER);
    trader_profile::seal_approve_copy_trader(id, &profile, &clk, scenario.ctx());

    std::unit_test::destroy(profile);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test, expected_failure(abort_code = trader_profile::EBadIdPrefix)]
fun seal_approve_copy_trader_aborts_on_bad_id_prefix() {
    // Object-substitution defense for the copy-trader entry function. The
    // copy-trader has a valid grant on P1, crafts an id for P2, and tries to
    // pass it together with the P1 object reference.
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let mut clk = clock::create_for_testing(scenario.ctx());
    clock::set_for_testing(&mut clk, 1_000);
    let mut p1 = trader_profile::create(&ver, &clk, scenario.ctx());
    let p2 = trader_profile::create(&ver, &clk, scenario.ctx());

    trader_profile::grant_copy_trader(
        &ver,
        &mut p1,
        COPY_TRADER,
        1_000 + 3_600_000,
        scenario.ctx(),
    );

    let bad_id = build_id(&p2, b"risk-profile");
    scenario.next_tx(COPY_TRADER);
    trader_profile::seal_approve_copy_trader(bad_id, &p1, &clk, scenario.ctx());

    std::unit_test::destroy(p1);
    std::unit_test::destroy(p2);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test]
fun seal_approve_audit_succeeds_when_cap_active() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let mut clk = clock::create_for_testing(scenario.ctx());
    clock::set_for_testing(&mut clk, 1_000);
    let mut profile = trader_profile::create(&ver, &clk, scenario.ctx());

    trader_profile::grant_audit(&ver, &mut profile, AUDITOR, 1_000 + 3_600_000, scenario.ctx());

    scenario.next_tx(AUDITOR);
    let cap = scenario.take_from_sender<AuditCap>();

    // Auditor has access to broader slices, e.g. `trade-history`.
    let id = build_id(&profile, b"trade-history");
    trader_profile::seal_approve_audit(id, &profile, &cap, &clk);

    transfer::public_transfer(cap, AUDITOR);
    std::unit_test::destroy(profile);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test, expected_failure(abort_code = trader_profile::ENotInAllowlist)]
fun seal_approve_audit_aborts_when_revoked() {
    // The contract removes the cap id from `audit_grants` on revoke, so the
    // post-revoke approve call aborts on the allowlist membership check, not
    // on the cap's own validity window.
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let mut clk = clock::create_for_testing(scenario.ctx());
    clock::set_for_testing(&mut clk, 1_000);
    let mut profile = trader_profile::create(&ver, &clk, scenario.ctx());

    trader_profile::grant_audit(&ver, &mut profile, AUDITOR, 1_000 + 3_600_000, scenario.ctx());

    scenario.next_tx(AUDITOR);
    let cap = scenario.take_from_sender<AuditCap>();
    let cap_id = sui::object::id(&cap);

    // Owner revokes before the auditor attempts to use the cap.
    scenario.next_tx(OWNER);
    trader_profile::revoke_audit(&ver, &mut profile, cap_id, scenario.ctx());

    scenario.next_tx(AUDITOR);
    let id = build_id(&profile, b"trade-history");
    trader_profile::seal_approve_audit(id, &profile, &cap, &clk);

    transfer::public_transfer(cap, AUDITOR);
    std::unit_test::destroy(profile);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test, expected_failure(abort_code = trader_profile::EBadIdPrefix)]
fun seal_approve_audit_aborts_on_bad_id_prefix() {
    // Object-substitution defense for the audit entry function. Auditor has a
    // cap registered on P1, crafts an id for P2, and tries to pass it with
    // the P1 object reference (and the P1-registered cap).
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let mut clk = clock::create_for_testing(scenario.ctx());
    clock::set_for_testing(&mut clk, 1_000);
    let mut p1 = trader_profile::create(&ver, &clk, scenario.ctx());
    let p2 = trader_profile::create(&ver, &clk, scenario.ctx());

    trader_profile::grant_audit(&ver, &mut p1, AUDITOR, 1_000 + 3_600_000, scenario.ctx());

    scenario.next_tx(AUDITOR);
    let cap = scenario.take_from_sender<AuditCap>();

    let bad_id = build_id(&p2, b"trade-history");
    trader_profile::seal_approve_audit(bad_id, &p1, &cap, &clk);

    transfer::public_transfer(cap, AUDITOR);
    std::unit_test::destroy(p1);
    std::unit_test::destroy(p2);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}
