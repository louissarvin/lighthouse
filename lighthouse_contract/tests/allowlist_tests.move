// Copyright (c) Lighthouse Labs
// SPDX-License-Identifier: Apache-2.0

#[test_only]
#[allow(implicit_const_copy)]
module lighthouse::allowlist_tests;

use sui::clock;
use sui::test_scenario::{Self as ts};
use lighthouse::allowlist;

const OWNER: address = @0xA1;
const ALICE: address = @0xA2;
const BOB: address = @0xA3;

#[test]
fun grant_revoke_lifecycle() {
    let mut scenario = ts::begin(OWNER);
    let ctx = scenario.ctx();
    let mut al = allowlist::new(ctx);

    // Initial state: no grant.
    assert!(allowlist::granted_until(&al, &ALICE) == 0, 100);

    // Grant ALICE until t=1000.
    allowlist::grant(&mut al, ALICE, 1000);
    assert!(allowlist::granted_until(&al, &ALICE) == 1000, 101);

    // Grant BOB until t=2000.
    allowlist::grant(&mut al, BOB, 2000);
    assert!(allowlist::granted_until(&al, &BOB) == 2000, 102);

    // Overwrite ALICE to t=3000 (no double-add).
    allowlist::grant(&mut al, ALICE, 3000);
    assert!(allowlist::granted_until(&al, &ALICE) == 3000, 103);

    // Revoke ALICE; BOB untouched.
    allowlist::revoke(&mut al, &ALICE);
    assert!(allowlist::granted_until(&al, &ALICE) == 0, 104);
    assert!(allowlist::granted_until(&al, &BOB) == 2000, 105);

    // Revoke is idempotent.
    allowlist::revoke(&mut al, &ALICE);
    assert!(allowlist::granted_until(&al, &ALICE) == 0, 106);

    allowlist::destroy_for_testing(al);
    scenario.end();
}

#[test]
fun audit_cap_validity_window() {
    let mut scenario = ts::begin(OWNER);
    let clk = clock::create_for_testing(scenario.ctx());

    let cap = allowlist::mint_audit_cap(ALICE, 5000, scenario.ctx());
    assert!(allowlist::audit_cap_auditor(&cap) == ALICE, 200);
    assert!(allowlist::audit_cap_valid_until_ms(&cap) == 5000, 201);

    // Clock at 0, cap valid until 5000 -> valid.
    assert!(allowlist::audit_cap_valid(&cap, &clk), 202);

    // Advance clock to 4999 -> still valid.
    let mut clk2 = clk;
    clock::set_for_testing(&mut clk2, 4999);
    assert!(allowlist::audit_cap_valid(&cap, &clk2), 203);

    // Advance clock to 5000 -> invalid (strict <).
    clock::set_for_testing(&mut clk2, 5000);
    assert!(!allowlist::audit_cap_valid(&cap, &clk2), 204);

    // Advance further -> still invalid.
    clock::set_for_testing(&mut clk2, 10_000);
    assert!(!allowlist::audit_cap_valid(&cap, &clk2), 205);

    sui::transfer::public_transfer(cap, ALICE);
    clock::destroy_for_testing(clk2);
    scenario.end();
}
