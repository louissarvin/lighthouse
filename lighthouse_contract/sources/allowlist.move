// Copyright (c) Lighthouse Labs
// SPDX-License-Identifier: Apache-2.0

module lighthouse::allowlist;

use sui::clock::Clock;
use sui::table::{Self, Table};

public struct Allowlist has store {
    grants: Table<address, u64>,
}

public struct AuditCap has key, store {
    id: UID,
    auditor: address,
    valid_until_ms: u64,
}

public(package) fun new(ctx: &mut TxContext): Allowlist {
    Allowlist { grants: table::new(ctx) }
}

public(package) fun grant(allowlist: &mut Allowlist, addr: address, valid_until_ms: u64) {
    if (table::contains(&allowlist.grants, addr)) {
        *table::borrow_mut(&mut allowlist.grants, addr) = valid_until_ms;
    } else {
        table::add(&mut allowlist.grants, addr, valid_until_ms);
    };
}

public(package) fun revoke(allowlist: &mut Allowlist, addr: &address) {
    if (table::contains(&allowlist.grants, *addr)) {
        table::remove(&mut allowlist.grants, *addr);
    };
}

public fun granted_until(allowlist: &Allowlist, addr: &address): u64 {
    if (table::contains(&allowlist.grants, *addr)) {
        *table::borrow(&allowlist.grants, *addr)
    } else {
        0
    }
}

public(package) fun mint_audit_cap(
    auditor: address,
    valid_until_ms: u64,
    ctx: &mut TxContext,
): AuditCap {
    AuditCap {
        id: object::new(ctx),
        auditor,
        valid_until_ms,
    }
}

public fun audit_cap_valid(cap: &AuditCap, clock: &Clock): bool {
    clock.timestamp_ms() < cap.valid_until_ms
}

public fun audit_cap_auditor(cap: &AuditCap): address {
    cap.auditor
}

public fun audit_cap_valid_until_ms(cap: &AuditCap): u64 {
    cap.valid_until_ms
}

#[test_only]
public fun destroy_for_testing(al: Allowlist) {
    let Allowlist { grants } = al;
    grants.drop();
}
