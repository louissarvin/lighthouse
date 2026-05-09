// Copyright (c) Lighthouse Labs
// SPDX-License-Identifier: Apache-2.0
module lighthouse::executor;

use sui::clock::Clock;
use sui::event;
use deepbook::balance_manager::{Self, BalanceManager, TradeCap};
use deepbook::pool::{Self, Pool};
use deepbook::order_info::{Self, OrderInfo};
use lighthouse::version::{Self, Version};

const FLOAT_SCALING: u128 = 1_000_000_000;
const ROLLING_WINDOW_MS: u64 = 86_400_000;
const U64_MAX: u128 = 18_446_744_073_709_551_615;

const EBudgetExceeded: u64 = 0;
const EPoolNotAllowed: u64 = 1;
const EExpired: u64 = 2;
const ENotAgent: u64 = 3;
const ENotOwner: u64 = 4;
const ERevoked: u64 = 5;
const EBalanceManagerMismatch: u64 = 6;
const EBadBudget: u64 = 7;

public struct ExecutorAgent has key, store {
    id: UID,
    balance_manager_id: ID,
    trade_cap: TradeCap,
    owner_address: address,
    agent_address: address,
    allowed_pools: vector<ID>,
    max_notional_per_trade: u64,
    max_notional_per_day: u64,
    spent_today: u64,
    window_start_ms: u64,
    expires_at_ms: u64,
    revoked: bool,
}

public struct AgentCreated has copy, drop, store {
    agent_id: ID,
    trade_cap_id: ID,
    owner: address,
    agent: address,
    balance_manager_id: ID,
    allowed_pools: vector<ID>,
    max_notional_per_trade: u64,
    max_notional_per_day: u64,
    expires_at_ms: u64,
}

public struct TradeExecuted has copy, drop, store {
    agent_id: ID,
    pool_id: ID,
    order_id: u128,
    is_bid: bool,
    price: u64,
    quantity: u64,
    notional: u64,
    timestamp_ms: u64,
}

public struct AgentRevoked has copy, drop, store {
    agent_id: ID,
    revoked_at_ms: u64,
}

public fun create_agent(
    version: &Version,
    bm: &mut BalanceManager,
    agent_address: address,
    allowed_pools: vector<ID>,
    max_per_trade: u64,
    max_per_day: u64,
    expires_at_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): ExecutorAgent {
    version::check_is_valid(version);

    let owner = ctx.sender();
    assert!(balance_manager::owner(bm) == owner, ENotOwner);

    assert!(max_per_trade > 0, EBadBudget);
    assert!(max_per_day >= max_per_trade, EBadBudget);
    assert!(expires_at_ms > clock.timestamp_ms(), EExpired);

    let trade_cap = balance_manager::mint_trade_cap(bm, ctx);
    let trade_cap_id = object::id(&trade_cap);
    let bm_id = object::id(bm);
    let uid = object::new(ctx);
    let agent_id = uid.to_inner();

    event::emit(AgentCreated {
        agent_id,
        trade_cap_id,
        owner,
        agent: agent_address,
        balance_manager_id: bm_id,
        allowed_pools,
        max_notional_per_trade: max_per_trade,
        max_notional_per_day: max_per_day,
        expires_at_ms,
    });

    ExecutorAgent {
        id: uid,
        balance_manager_id: bm_id,
        trade_cap,
        owner_address: owner,
        agent_address,
        allowed_pools,
        max_notional_per_trade: max_per_trade,
        max_notional_per_day: max_per_day,
        spent_today: 0,
        window_start_ms: clock.timestamp_ms(),
        expires_at_ms,
        revoked: false,
    }
}

#[allow(lint(custom_state_change, share_owned))]
public fun share(agent: ExecutorAgent) {
    transfer::share_object(agent)
}

public fun place_limit_under_budget<Base, Quote>(
    version: &Version,
    agent: &mut ExecutorAgent,
    bm: &mut BalanceManager,
    pool: &mut Pool<Base, Quote>,
    client_order_id: u64,
    order_type: u8,
    self_matching: u8,
    price: u64,
    quantity: u64,
    is_bid: bool,
    pay_with_deep: bool,
    expire_timestamp: u64,
    clock: &Clock,
    ctx: &TxContext,
): OrderInfo {
    version::check_is_valid(version);

    assert!(ctx.sender() == agent.agent_address, ENotAgent);
    assert!(!agent.revoked, ERevoked);

    assert!(object::id(bm) == agent.balance_manager_id, EBalanceManagerMismatch);

    let now = clock.timestamp_ms();
    assert!(now < agent.expires_at_ms, EExpired);

    let pool_id = object::id(pool);
    let mut i = 0;
    let mut ok = false;
    let n = agent.allowed_pools.length();
    while (i < n) {
        if (agent.allowed_pools[i] == pool_id) {
            ok = true;
            break
        };
        i = i + 1;
    };
    assert!(ok, EPoolNotAllowed);

    let notional_u128 = (price as u128) * (quantity as u128) / FLOAT_SCALING;
    assert!(notional_u128 <= U64_MAX, EBudgetExceeded);
    let notional = notional_u128 as u64;
    assert!(notional <= agent.max_notional_per_trade, EBudgetExceeded);

    if (now > agent.window_start_ms + ROLLING_WINDOW_MS) {
        agent.window_start_ms = now;
        agent.spent_today = 0;
    };
    assert!(agent.spent_today + notional <= agent.max_notional_per_day, EBudgetExceeded);
    agent.spent_today = agent.spent_today + notional;

    let proof = balance_manager::generate_proof_as_trader(bm, &agent.trade_cap, ctx);
    let info = pool::place_limit_order<Base, Quote>(
        pool,
        bm,
        &proof,
        client_order_id,
        order_type,
        self_matching,
        price,
        quantity,
        is_bid,
        pay_with_deep,
        expire_timestamp,
        clock,
        ctx,
    );

    event::emit(TradeExecuted {
        agent_id: object::id(agent),
        pool_id,
        order_id: order_info::order_id(&info),
        is_bid,
        price,
        quantity,
        notional,
        timestamp_ms: now,
    });

    info
}

public fun revoke(
    version: &Version,
    agent: &mut ExecutorAgent,
    bm: &mut BalanceManager,
    clock: &Clock,
    ctx: &TxContext,
) {
    version::check_is_valid(version);
    assert!(ctx.sender() == agent.owner_address, ENotOwner);
    assert!(object::id(bm) == agent.balance_manager_id, EBalanceManagerMismatch);

    if (!agent.revoked) {
        agent.revoked = true;
        let cap_id = object::id(&agent.trade_cap);
        balance_manager::revoke_trade_cap(bm, &cap_id, ctx);
        event::emit(AgentRevoked {
            agent_id: object::id(agent),
            revoked_at_ms: clock.timestamp_ms(),
        });
    };
}

public fun owner_address(agent: &ExecutorAgent): address { agent.owner_address }
public fun agent_address(agent: &ExecutorAgent): address { agent.agent_address }
public fun balance_manager_id(agent: &ExecutorAgent): ID { agent.balance_manager_id }
public fun max_notional_per_trade(agent: &ExecutorAgent): u64 { agent.max_notional_per_trade }
public fun max_notional_per_day(agent: &ExecutorAgent): u64 { agent.max_notional_per_day }
public fun spent_today(agent: &ExecutorAgent): u64 { agent.spent_today }
public fun window_start_ms(agent: &ExecutorAgent): u64 { agent.window_start_ms }
public fun expires_at_ms(agent: &ExecutorAgent): u64 { agent.expires_at_ms }
public fun revoked(agent: &ExecutorAgent): bool { agent.revoked }
public fun allowed_pools(agent: &ExecutorAgent): vector<ID> { agent.allowed_pools }
