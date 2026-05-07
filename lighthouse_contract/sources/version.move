// Copyright (c) Lighthouse Labs
// SPDX-License-Identifier: Apache-2.0

module lighthouse::version;

const VERSION: u64 = 1;

const EWrongVersion: u64 = 0;

public struct Version has key {
    id: UID,
    version: u64,
}

public struct AdminCap has key, store {
    id: UID,
}

fun init(ctx: &mut TxContext) {
    transfer::share_object(Version {
        id: object::new(ctx),
        version: VERSION,
    });
    transfer::transfer(
        AdminCap { id: object::new(ctx) },
        ctx.sender(),
    );
}

public fun check_is_valid(self: &Version) {
    assert!(self.version == VERSION, EWrongVersion);
}

public fun migrate(_admin: &AdminCap, self: &mut Version) {
    self.version = VERSION;
}

public fun current(self: &Version): u64 { self.version }
public fun expected(): u64 { VERSION }


#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx)
}

#[test_only]
public fun new_admin_cap_for_testing(ctx: &mut TxContext): AdminCap {
    AdminCap { id: object::new(ctx) }
}

#[test_only]
public fun destroy_admin_cap_for_testing(cap: AdminCap) {
    let AdminCap { id } = cap;
    id.delete();
}
