// Copyright (c) Lighthouse Labs
// SPDX-License-Identifier: Apache-2.0

#[test_only]
module lighthouse::version_tests;

use sui::test_scenario::{Self as ts};
use lighthouse::version::{Self, Version, AdminCap};

const DEPLOYER: address = @0xA1;

#[test]
fun init_creates_shared_version_and_admin_cap() {
    let mut scenario = ts::begin(DEPLOYER);
    version::init_for_testing(scenario.ctx());

    // Next tx: shared object exists; AdminCap was transferred to deployer.
    scenario.next_tx(DEPLOYER);
    let ver = scenario.take_shared<Version>();
    assert!(version::current(&ver) == version::expected(), 100);
    assert!(version::current(&ver) == 1, 101);

    let cap = scenario.take_from_sender<AdminCap>();
    // Just confirm it exists; no state to inspect.

    version::check_is_valid(&ver);

    scenario.return_to_sender(cap);
    ts::return_shared(ver);
    scenario.end();
}

#[test]
fun migrate_with_admin_cap_succeeds() {
    let mut scenario = ts::begin(DEPLOYER);
    version::init_for_testing(scenario.ctx());
    scenario.next_tx(DEPLOYER);

    let mut ver = scenario.take_shared<Version>();
    let cap = scenario.take_from_sender<AdminCap>();

    // Pretend the on-chain version drifted to 0 (only possible if a future
    // migration logic sets it lower — this test simulates the post-upgrade
    // delta where version.version != VERSION).
    // We can't directly mutate ver.version from outside the module, so we
    // call migrate to confirm it sets to VERSION idempotently.
    version::migrate(&cap, &mut ver);
    assert!(version::current(&ver) == 1, 100);

    // Re-migrate is a no-op.
    version::migrate(&cap, &mut ver);
    assert!(version::current(&ver) == 1, 101);

    scenario.return_to_sender(cap);
    ts::return_shared(ver);
    scenario.end();
}
