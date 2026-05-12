// Copyright (c) Lighthouse Labs
// SPDX-License-Identifier: Apache-2.0

/// Executor unit tests.
///
/// Covered: create_agent + revoke success/abort paths, auth, BM substitution
/// defense, idempotency, version gate, read accessors.
///
/// Also covered (added 2026-06-14, audit gap #2): four of the five budget-
/// enforcement abort branches of `place_limit_under_budget`:
///   - pool not whitelisted   (EPoolNotAllowed)
///   - per-trade notional cap (EBudgetExceeded)
///   - expired agent          (EExpired)
///   - revoked agent          (ERevoked)
/// These are exercised by constructing a real DeepBook v3 `Pool` via the
/// `pool::create_pool_admin` + `registry::test_registry` test-only helpers,
/// then calling `place_limit_under_budget` with configuration that fires the
/// targeted assertion before the inner `pool::place_limit_order` runs.
///
/// NOT covered, deferred to a testnet PTB harness:
///   - 24h rolling notional cap (EBudgetExceeded): would require mutating
///     `spent_today` from outside the module, which is only possible by
///     completing prior trades through `pool::place_limit_order`. That call
///     requires a funded `BalanceManager` (DEEP for fees + base/quote balances)
///     which DeepBook only exposes via `public(package)` test fixtures we
///     cannot reach from this external test module.
///   - happy path returning `OrderInfo`: same reason — the inner pool call
///     needs a funded BM with DEEP and matching liquidity.
/// See LIGHTHOUSE.md §10.4 and §5.5.4 for the testnet pool ID used in the
/// PTB harness that covers these two paths.
#[test_only]
#[allow(implicit_const_copy)]
module lighthouse::executor_tests;

use sui::clock;
use sui::test_scenario::{Self as ts};
use deepbook::balance_manager::{Self, BalanceManager};
use deepbook::pool::{Self, Pool};
use deepbook::registry::{Self, Registry};
use deepbook::constants as dbk_constants;
use lighthouse::executor;
use lighthouse::version::{Self, Version};

/// Phantom asset types used solely to parameterize a test DeepBook pool.
/// Never minted or transferred; only their type identity matters for the
/// `Pool<Base, Quote>` constructor.
public struct BASE has drop {}
public struct QUOTE has drop {}

const OWNER: address = @0xA1;
const AGENT: address = @0xA2;
const RANDO: address = @0xA3;

fun setup_version(scenario: &mut ts::Scenario): Version {
    version::init_for_testing(scenario.ctx());
    scenario.next_tx(OWNER);
    scenario.take_shared<Version>()
}

fun new_bm(scenario: &mut ts::Scenario): BalanceManager {
    balance_manager::new(scenario.ctx())
}

fun dummy_pool_ids(): vector<sui::object::ID> {
    let mut v = vector::empty<sui::object::ID>();
    v.push_back(sui::object::id_from_address(@0xB1));
    v.push_back(sui::object::id_from_address(@0xB2));
    v.push_back(sui::object::id_from_address(@0xB3));
    v
}

#[test]
fun create_agent_happy_path() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let mut clk = clock::create_for_testing(scenario.ctx());
    clock::set_for_testing(&mut clk, 1_000);

    let mut bm = new_bm(&mut scenario);
    let agent = executor::create_agent(
        &ver,
        &mut bm,
        AGENT,
        dummy_pool_ids(),
        /* max_per_trade */ 1_000_000_000,
        /* max_per_day  */ 10_000_000_000,
        /* expires_at   */ 1_000_000_000_000,
        &clk,
        scenario.ctx(),
    );
    assert!(executor::owner_address(&agent) == OWNER, 100);
    assert!(executor::agent_address(&agent) == AGENT, 101);
    assert!(executor::balance_manager_id(&agent) == sui::object::id(&bm), 102);
    assert!(executor::max_notional_per_trade(&agent) == 1_000_000_000, 103);
    assert!(executor::max_notional_per_day(&agent) == 10_000_000_000, 104);
    assert!(executor::spent_today(&agent) == 0, 105);
    assert!(executor::window_start_ms(&agent) == 1_000, 106);
    assert!(executor::expires_at_ms(&agent) == 1_000_000_000_000, 107);
    assert!(!executor::revoked(&agent), 108);
    assert!(executor::allowed_pools(&agent).length() == 3, 109);

    executor::share(agent);
    transfer::public_share_object(bm);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test, expected_failure(abort_code = executor::ENotOwner)]
fun create_agent_non_bm_owner_aborts() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let clk = clock::create_for_testing(scenario.ctx());
    let mut bm = new_bm(&mut scenario);

    scenario.next_tx(RANDO);
    let agent = executor::create_agent(
        &ver,
        &mut bm,
        AGENT,
        dummy_pool_ids(),
        1_000_000_000,
        10_000_000_000,
        1_000_000_000_000,
        &clk,
        scenario.ctx(),
    );

    executor::share(agent);
    transfer::public_share_object(bm);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test, expected_failure(abort_code = executor::EBadBudget)]
fun create_agent_zero_per_trade_aborts() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let clk = clock::create_for_testing(scenario.ctx());
    let mut bm = new_bm(&mut scenario);

    let agent = executor::create_agent(
        &ver,
        &mut bm,
        AGENT,
        dummy_pool_ids(),
        /* max_per_trade */ 0,
        10_000_000_000,
        1_000_000_000_000,
        &clk,
        scenario.ctx(),
    );

    executor::share(agent);
    transfer::public_share_object(bm);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test, expected_failure(abort_code = executor::EBadBudget)]
fun create_agent_per_day_less_than_per_trade_aborts() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let clk = clock::create_for_testing(scenario.ctx());
    let mut bm = new_bm(&mut scenario);

    let agent = executor::create_agent(
        &ver,
        &mut bm,
        AGENT,
        dummy_pool_ids(),
        1_000_000_000,
        500_000_000,
        1_000_000_000_000,
        &clk,
        scenario.ctx(),
    );

    executor::share(agent);
    transfer::public_share_object(bm);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test, expected_failure(abort_code = executor::EExpired)]
fun create_agent_past_expiry_aborts() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let mut clk = clock::create_for_testing(scenario.ctx());
    clock::set_for_testing(&mut clk, 1_000_000);
    let mut bm = new_bm(&mut scenario);

    let agent = executor::create_agent(
        &ver,
        &mut bm,
        AGENT,
        dummy_pool_ids(),
        1_000_000_000,
        10_000_000_000,
        /* expires_at */ 999_999,
        &clk,
        scenario.ctx(),
    );

    executor::share(agent);
    transfer::public_share_object(bm);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test]
fun revoke_owner_succeeds_and_is_idempotent() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let clk = clock::create_for_testing(scenario.ctx());
    let mut bm = new_bm(&mut scenario);

    let mut agent = executor::create_agent(
        &ver,
        &mut bm,
        AGENT,
        dummy_pool_ids(),
        1_000_000_000,
        10_000_000_000,
        1_000_000_000_000,
        &clk,
        scenario.ctx(),
    );

    assert!(!executor::revoked(&agent), 100);
    executor::revoke(&ver, &mut agent, &mut bm, &clk, scenario.ctx());
    assert!(executor::revoked(&agent), 101);

    executor::revoke(&ver, &mut agent, &mut bm, &clk, scenario.ctx());
    assert!(executor::revoked(&agent), 102);

    executor::share(agent);
    transfer::public_share_object(bm);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test, expected_failure(abort_code = executor::ENotOwner)]
fun revoke_non_owner_aborts() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let clk = clock::create_for_testing(scenario.ctx());
    let mut bm = new_bm(&mut scenario);
    let mut agent = executor::create_agent(
        &ver,
        &mut bm,
        AGENT,
        dummy_pool_ids(),
        1_000_000_000,
        10_000_000_000,
        1_000_000_000_000,
        &clk,
        scenario.ctx(),
    );

    scenario.next_tx(RANDO);
    executor::revoke(&ver, &mut agent, &mut bm, &clk, scenario.ctx());

    executor::share(agent);
    transfer::public_share_object(bm);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

#[test, expected_failure(abort_code = executor::EBalanceManagerMismatch)]
fun revoke_wrong_bm_aborts() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let clk = clock::create_for_testing(scenario.ctx());
    let mut bm1 = new_bm(&mut scenario);
    let mut bm2 = new_bm(&mut scenario);

    let mut agent = executor::create_agent(
        &ver,
        &mut bm1,
        AGENT,
        dummy_pool_ids(),
        1_000_000_000,
        10_000_000_000,
        1_000_000_000_000,
        &clk,
        scenario.ctx(),
    );

    executor::revoke(&ver, &mut agent, &mut bm2, &clk, scenario.ctx());

    executor::share(agent);
    transfer::public_share_object(bm1);
    transfer::public_share_object(bm2);
    clock::destroy_for_testing(clk);
    ts::return_shared(ver);
    scenario.end();
}

// =============================================================================
// place_limit_under_budget tests (audit gap #2, added 2026-06-14)
//
// Each test below constructs a real DeepBook Pool via the public test-only
// helpers `registry::test_registry` + `registry::get_admin_cap_for_testing` +
// `pool::create_pool_admin`. The pool is shared, then taken back in the next
// transaction so it can be passed by `&mut` to `place_limit_under_budget`.
// =============================================================================

/// Stand up a Registry and a Pool<BASE, QUOTE>, return the pool ID.
/// Caller must be in a fresh transaction before this and must call
/// `next_tx` after to take the shared Pool by id.
fun setup_registry_and_pool(scenario: &mut ts::Scenario): sui::object::ID {
    let registry_id = registry::test_registry(scenario.ctx());
    scenario.next_tx(OWNER);
    let mut reg = scenario.take_shared_by_id<Registry>(registry_id);
    let admin_cap = registry::get_admin_cap_for_testing(scenario.ctx());
    let pool_id = pool::create_pool_admin<BASE, QUOTE>(
        &mut reg,
        dbk_constants::tick_size(),
        dbk_constants::lot_size(),
        dbk_constants::min_size(),
        /* whitelisted_pool */ false,
        /* stable_pool */ false,
        &admin_cap,
        scenario.ctx(),
    );
    ts::return_shared(reg);
    // Caller code does not need the admin cap again; transfer it away to
    // satisfy the linear-type discipline.
    transfer::public_transfer(admin_cap, OWNER);
    pool_id
}

#[test, expected_failure(abort_code = executor::EPoolNotAllowed)]
fun place_limit_aborts_on_pool_not_whitelisted() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let mut clk = clock::create_for_testing(scenario.ctx());
    clock::set_for_testing(&mut clk, 1_000);
    let mut bm = new_bm(&mut scenario);

    // Whitelist contains only fabricated IDs; the real pool we build below
    // is intentionally NOT among them.
    let agent = executor::create_agent(
        &ver,
        &mut bm,
        AGENT,
        dummy_pool_ids(),
        1_000_000_000,
        10_000_000_000,
        1_000_000_000_000,
        &clk,
        scenario.ctx(),
    );
    executor::share(agent);

    let pool_id = setup_registry_and_pool(&mut scenario);

    scenario.next_tx(AGENT);
    let mut agent = scenario.take_shared<executor::ExecutorAgent>();
    let mut pool = scenario.take_shared_by_id<Pool<BASE, QUOTE>>(pool_id);

    // notional = price * quantity / 1e9 = 1e9 * 1e9 / 1e9 = 1e9 (well within caps).
    let _info = executor::place_limit_under_budget<BASE, QUOTE>(
        &ver,
        &mut agent,
        &mut bm,
        &mut pool,
        /* client_order_id */ 1,
        /* order_type */ 0,
        /* self_matching */ 0,
        /* price */ 1_000_000_000,
        /* quantity */ 1_000_000_000,
        /* is_bid */ true,
        /* pay_with_deep */ true,
        /* expire_timestamp */ dbk_constants::max_u64(),
        &clk,
        scenario.ctx(),
    );

    abort 0xDEAD
}

#[test, expected_failure(abort_code = executor::EBudgetExceeded)]
fun place_limit_aborts_on_per_trade_notional_exceeded() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let mut clk = clock::create_for_testing(scenario.ctx());
    clock::set_for_testing(&mut clk, 1_000);
    let mut bm = new_bm(&mut scenario);

    // Build the real pool first so we can include its ID in the agent
    // whitelist, isolating the assertion under test from EPoolNotAllowed.
    let pool_id = setup_registry_and_pool(&mut scenario);

    scenario.next_tx(OWNER);
    let mut allowed = vector::empty<sui::object::ID>();
    allowed.push_back(pool_id);

    // per-trade cap = 100 USDC (6-decimal units).
    let agent = executor::create_agent(
        &ver,
        &mut bm,
        AGENT,
        allowed,
        /* max_per_trade */ 100_000_000,
        /* max_per_day  */ 1_000_000_000,
        1_000_000_000_000,
        &clk,
        scenario.ctx(),
    );
    executor::share(agent);

    scenario.next_tx(AGENT);
    let mut agent = scenario.take_shared<executor::ExecutorAgent>();
    let mut pool = scenario.take_shared_by_id<Pool<BASE, QUOTE>>(pool_id);

    // notional = price * quantity / 1e9. Pick price=2e9 ("2.0"), quantity=1e8
    // ("0.1") -> notional = 2e9 * 1e8 / 1e9 = 200_000_000, which exceeds the
    // 100_000_000 per-trade cap.
    let _info = executor::place_limit_under_budget<BASE, QUOTE>(
        &ver,
        &mut agent,
        &mut bm,
        &mut pool,
        1,
        0,
        0,
        /* price */ 2_000_000_000,
        /* quantity */ 100_000_000,
        true,
        true,
        dbk_constants::max_u64(),
        &clk,
        scenario.ctx(),
    );

    abort 0xDEAD
}

#[test, expected_failure(abort_code = executor::EExpired)]
fun place_limit_aborts_on_expired() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let mut clk = clock::create_for_testing(scenario.ctx());
    // Set clock far ahead so we can create the agent with a near-future
    // expiry that we then step PAST before calling place_limit_under_budget.
    clock::set_for_testing(&mut clk, 1_000);
    let mut bm = new_bm(&mut scenario);

    let pool_id = setup_registry_and_pool(&mut scenario);

    scenario.next_tx(OWNER);
    let mut allowed = vector::empty<sui::object::ID>();
    allowed.push_back(pool_id);

    let agent = executor::create_agent(
        &ver,
        &mut bm,
        AGENT,
        allowed,
        1_000_000_000,
        10_000_000_000,
        /* expires_at_ms */ 2_000,
        &clk,
        scenario.ctx(),
    );
    executor::share(agent);

    // Advance clock past expiry. now (3_000) >= expires_at (2_000) -> EExpired.
    clock::set_for_testing(&mut clk, 3_000);

    scenario.next_tx(AGENT);
    let mut agent = scenario.take_shared<executor::ExecutorAgent>();
    let mut pool = scenario.take_shared_by_id<Pool<BASE, QUOTE>>(pool_id);

    let _info = executor::place_limit_under_budget<BASE, QUOTE>(
        &ver,
        &mut agent,
        &mut bm,
        &mut pool,
        1,
        0,
        0,
        1_000_000_000,
        1_000_000_000,
        true,
        true,
        dbk_constants::max_u64(),
        &clk,
        scenario.ctx(),
    );

    abort 0xDEAD
}

#[test, expected_failure(abort_code = executor::ERevoked)]
fun place_limit_aborts_on_revoked() {
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let mut clk = clock::create_for_testing(scenario.ctx());
    clock::set_for_testing(&mut clk, 1_000);
    let mut bm = new_bm(&mut scenario);

    let pool_id = setup_registry_and_pool(&mut scenario);

    scenario.next_tx(OWNER);
    let mut allowed = vector::empty<sui::object::ID>();
    allowed.push_back(pool_id);

    let mut agent = executor::create_agent(
        &ver,
        &mut bm,
        AGENT,
        allowed,
        1_000_000_000,
        10_000_000_000,
        1_000_000_000_000,
        &clk,
        scenario.ctx(),
    );

    // Owner revokes before any trade is attempted.
    executor::revoke(&ver, &mut agent, &mut bm, &clk, scenario.ctx());
    assert!(executor::revoked(&agent), 200);
    executor::share(agent);

    scenario.next_tx(AGENT);
    let mut agent = scenario.take_shared<executor::ExecutorAgent>();
    let mut pool = scenario.take_shared_by_id<Pool<BASE, QUOTE>>(pool_id);

    let _info = executor::place_limit_under_budget<BASE, QUOTE>(
        &ver,
        &mut agent,
        &mut bm,
        &mut pool,
        1,
        0,
        0,
        1_000_000_000,
        1_000_000_000,
        true,
        true,
        dbk_constants::max_u64(),
        &clk,
        scenario.ctx(),
    );

    abort 0xDEAD
}

#[test, expected_failure(abort_code = executor::ENotAgent)]
fun place_limit_aborts_on_wrong_sender() {
    // Bonus coverage: the sender == agent_address check (ENotAgent) is the
    // very first assert after the version gate. A malicious party who holds
    // a TradeProof or a copy of the shared ExecutorAgent cannot submit on
    // someone else's behalf.
    let mut scenario = ts::begin(OWNER);
    let ver = setup_version(&mut scenario);
    let mut clk = clock::create_for_testing(scenario.ctx());
    clock::set_for_testing(&mut clk, 1_000);
    let mut bm = new_bm(&mut scenario);

    let pool_id = setup_registry_and_pool(&mut scenario);

    scenario.next_tx(OWNER);
    let mut allowed = vector::empty<sui::object::ID>();
    allowed.push_back(pool_id);

    let agent = executor::create_agent(
        &ver,
        &mut bm,
        AGENT,
        allowed,
        1_000_000_000,
        10_000_000_000,
        1_000_000_000_000,
        &clk,
        scenario.ctx(),
    );
    executor::share(agent);

    // RANDO tries to drive the agent.
    scenario.next_tx(RANDO);
    let mut agent = scenario.take_shared<executor::ExecutorAgent>();
    let mut pool = scenario.take_shared_by_id<Pool<BASE, QUOTE>>(pool_id);

    let _info = executor::place_limit_under_budget<BASE, QUOTE>(
        &ver,
        &mut agent,
        &mut bm,
        &mut pool,
        1,
        0,
        0,
        1_000_000_000,
        1_000_000_000,
        true,
        true,
        dbk_constants::max_u64(),
        &clk,
        scenario.ctx(),
    );

    abort 0xDEAD
}

