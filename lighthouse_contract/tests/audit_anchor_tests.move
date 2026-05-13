// Copyright (c) Lighthouse Labs
// SPDX-License-Identifier: Apache-2.0

#[test_only]
#[allow(implicit_const_copy)]
module lighthouse::audit_anchor_tests;

use sui::clock;
use sui::test_scenario::{Self as ts};
use lighthouse::audit_anchor;
use lighthouse::version::{Self, Version};

const OWNER: address = @0xA1;

/// Build a 32-byte dummy tx digest.
fun dummy_digest(): vector<u8> {
    let mut v = vector::empty<u8>();
    let mut i = 0;
    while (i < 32) {
        v.push_back((i as u8));
        i = i + 1;
    };
    v
}

/// Take the shared Version object from the scenario inventory (set up by
/// `version::init_for_testing` in the prior tx).
fun setup_version(scenario: &mut ts::Scenario): Version {
    version::init_for_testing(scenario.ctx());
    scenario.next_tx(OWNER);
    scenario.take_shared<Version>()
}

#[test]
fun record_recommendation_happy_path() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let clk = clock::create_for_testing(scenario.ctx());

    let anchor = audit_anchor::record(
        &ver,
        audit_anchor::kind_recommendation(),
        b"blob-abc",
        dummy_digest(),
        &clk,
        scenario.ctx(),
    );
    assert!(audit_anchor::owner(&anchor) == OWNER, 100);
    assert!(audit_anchor::kind(&anchor) == 0, 101);
    assert!(audit_anchor::walrus_blob_id(&anchor) == b"blob-abc", 102);
    assert!(audit_anchor::sui_tx_digest(&anchor) == dummy_digest(), 103);

    audit_anchor::transfer_to_owner(anchor);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test]
fun record_all_three_kinds() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let clk = clock::create_for_testing(scenario.ctx());

    let r = audit_anchor::record(&ver, 0, b"rec", dummy_digest(), &clk, scenario.ctx());
    let t = audit_anchor::record(&ver, 1, b"trd", dummy_digest(), &clk, scenario.ctx());
    let w = audit_anchor::record(&ver, 2, b"wkl", dummy_digest(), &clk, scenario.ctx());
    assert!(audit_anchor::kind(&r) == audit_anchor::kind_recommendation(), 100);
    assert!(audit_anchor::kind(&t) == audit_anchor::kind_trade(), 101);
    assert!(audit_anchor::kind(&w) == audit_anchor::kind_weekly_report(), 102);

    audit_anchor::transfer_to_owner(r);
    audit_anchor::transfer_to_owner(t);
    audit_anchor::transfer_to_owner(w);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test, expected_failure(abort_code = audit_anchor::EBadKind)]
fun record_rejects_invalid_kind() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let clk = clock::create_for_testing(scenario.ctx());

    let anchor = audit_anchor::record(
        &ver,
        99, // > KIND_MAX
        b"blob",
        dummy_digest(),
        &clk,
        scenario.ctx(),
    );
    audit_anchor::transfer_to_owner(anchor);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test, expected_failure(abort_code = audit_anchor::EBadBlobId)]
fun record_rejects_empty_blob_id() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let clk = clock::create_for_testing(scenario.ctx());

    let anchor = audit_anchor::record(
        &ver,
        0,
        vector::empty<u8>(),
        dummy_digest(),
        &clk,
        scenario.ctx(),
    );
    audit_anchor::transfer_to_owner(anchor);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test, expected_failure(abort_code = audit_anchor::EBadDigest)]
fun record_rejects_short_digest() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let clk = clock::create_for_testing(scenario.ctx());

    let mut short = vector::empty<u8>();
    let mut i = 0;
    while (i < 16) { short.push_back(0); i = i + 1; };

    let anchor = audit_anchor::record(
        &ver,
        0,
        b"blob",
        short,
        &clk,
        scenario.ctx(),
    );
    audit_anchor::transfer_to_owner(anchor);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}
