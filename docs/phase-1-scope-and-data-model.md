# Phase 1: Scope And Data Model Outline

This phase defines the product and data boundaries before account, wallet, cashier, and server-side settlement work starts.

## Scope Decisions

- Keep the current Plinko board as the primary game experience.
- Keep the local-only React game working until each Convex-backed replacement is ready.
- Convex will become the source of truth for users, wallet state, game rounds, payouts, and history.
- The browser client may render controls, animations, optimistic loading states, and read-only history.
- The browser client must not be the authority for money movement, bet acceptance, payout settlement, or game-round finality.
- All balance-changing actions will be modeled as Convex mutations.
- The current local balance and local play history are temporary Phase 0 baseline state only.

## Money Unit

- Store wallet money as integer sats.
- Use `sat` as the internal unit: one wallet unit equals one satoshi.
- UI may display sats directly or BTC converted from sats, but wallet state and wallet mutations should use integer sats.
- Reject negative, non-finite, fractional-sat, or unsafe integer money values before they reach wallet logic.
- Payment-provider units can be adapted at the payment boundary later; they should not leak into game or wallet logic directly.

## Convex Data To Track

These are conceptual domain records, not final table prescriptions. The exact Convex schema can evolve as implementation starts.

- Users and account state.
- Wallet balances and held funds.
- Wallet movements.
- Deposits and their statuses.
- Withdrawals and their statuses.
- Game rounds.
- Bets.
- Payouts.
- Provably fair seed, nonce, and proof data.
- Play history.
- Cashier transaction history.
- Account and session activity.
- Admin actions.
- Errors and settlement events.

## Convex Authority Boundaries

Convex should own:

- User/account state.
- Available and held wallet balances.
- Deposit and withdrawal state transitions.
- Bet validation.
- Bet debit.
- Plinko result settlement.
- Payout credit.
- Game-round records.
- Play history records.
- Transaction history records.
- Admin actions and audit events.

The frontend should own:

- Form state.
- Canvas rendering.
- Drop animation after receiving a settled result.
- Local display preferences such as rows and risk until they become account settings.
- Loading, pending, success, and failure UI states.

## Payment-Provider Boundary

The real payment rails are out of scope for this phase.

For now, the app only needs to define the boundary:

- Deposit flow creates an internal deposit intent/status.
- External provider work happens outside this implementation.
- A provider result eventually reports success, failure, or cancellation.
- Successful deposits credit the Convex wallet exactly once.
- Withdrawal flow creates a pending withdrawal and holds funds.
- External provider work happens outside this implementation.
- Withdrawal success finalizes the held funds.
- Withdrawal failure or cancellation releases the held funds.

Provider-specific callback payloads, credentials, reconciliation files, and webhook security details are intentionally deferred.

## Phase 1 Exit Criteria

- The planned Convex data domains are written down.
- The payment-provider boundary is written down.
- The frontend/backend authority split is written down.
- The internal money unit is decided and represented in typed code.
- Money-unit helpers have focused test coverage.
