# Casino Implementation Plan

This plan turns the current Plinko demo into an account-based casino game using Convex as the backend/database layer. The phases below are the intended implementation order. Payment rails are treated as a black box: the app needs deposit and withdrawal UI plus internal wallet state handling, but not the actual payment provider implementation yet.

## Implementation Guidance

- [ ] Test business logic as it is implemented, especially wallet mutations, deposit and withdrawal status transitions, bet settlement, payout handling, and duplicate-request/idempotency cases.
- [ ] Add focused tests at the same time as each backend behavior instead of waiting until the end of the phase.
- [ ] Use the browser for real status checks at natural checkpoints, especially after account setup, cashier flows, wallet balance updates, betting, payout settlement, play history updates, and failure states.
- [ ] Treat browser validation as a functional smoke test: confirm the UI state, Convex-backed data, loading states, disabled states, and error paths match the behavior that was just implemented.
- [ ] Keep each phase shippable enough that the current browser experience still works before moving to the next phase.

## Phase 0: React, TypeScript, pnpm, And Convex Setup

- [x] Initialize the repo as a pnpm-managed project.
- [x] Add React and TypeScript.
- [x] Add Vitest for unit and logic tests.
- [x] Add Biome for formatting and linting.
- [x] Add a modern build/dev setup for the frontend.
- [x] Add Convex to the project.
- [x] Create the initial Convex app structure.
- [x] Create or link the real Convex project.
- [x] Add development scripts for the frontend and Convex backend.
- [x] Add TypeScript configuration for frontend and Convex code.
- [x] Move the current Plinko UI into React components without changing gameplay behavior.
- [x] Move reusable game logic into typed modules.
- [x] Preserve the existing local-only game as the baseline before wallet/account work begins.
- [x] Add initial Vitest coverage for migrated game logic.
- [x] Add Biome check and format scripts.
- [x] Add initial smoke checks for the migrated React app.
- [x] Validate the migrated app in the browser before starting Phase 1.

## Phase 1: Scope And Data Model Outline

- [ ] Keep the current Plinko board as the primary game experience.
- [ ] Use Convex as the source of truth for users, wallet state, game rounds, payouts, and history.
- [ ] Treat the frontend as display, input, and animation only.
- [ ] Make all balance-changing actions go through Convex mutations.
- [ ] Define the conceptual Convex data we need to track:
  - [ ] Users and account state.
  - [ ] Wallet balances and held funds.
  - [ ] Wallet movements.
  - [ ] Deposits and their statuses.
  - [ ] Withdrawals and their statuses.
  - [ ] Game rounds.
  - [ ] Bets.
  - [ ] Payouts.
  - [ ] Provably fair seed, nonce, and proof data.
  - [ ] Play history.
  - [ ] Cashier transaction history.
  - [ ] Account and session activity.
  - [ ] Admin actions.
  - [ ] Errors and settlement events.
- [ ] Define the payment-provider boundary without implementing the real rails.
- [ ] Decide the money unit the app stores internally so balances never depend on floating-point math.

## Phase 2: Convex And Account Foundation

- [ ] Add Convex to the project.
- [ ] Add account-based play instead of anonymous local-only state.
- [ ] Add sign-in and sign-out.
- [ ] Store user profile state in Convex.
- [ ] Track account state such as active, locked, pending review, or disabled.
- [ ] Add a global app shell that can show user identity, wallet balance, and cashier access.
- [ ] Associate wallet events, bets, game rounds, deposits, and withdrawals with a user.

## Phase 3: Convex Wallet System

- [ ] Move playable balance from local browser state into Convex.
- [ ] Track available balance separately from money that is temporarily held.
- [ ] Track wallet-changing events such as deposits, bets, payouts, withdrawals, refunds, and manual adjustments.
- [ ] Ensure the client never directly edits a balance.
- [ ] Make wallet mutations atomic so one action cannot partially apply.
- [ ] Add idempotency for actions that may be retried, especially deposits, withdrawals, and bet settlement.
- [ ] Prevent duplicate deposit crediting.
- [ ] Prevent duplicate bet settlement.
- [ ] Prevent withdrawals from spending more than the user's available balance.

## Phase 4: Cashier UI And Fake Funding Flows

- [ ] Add a cashier modal or drawer.
- [ ] Add Deposit and Withdraw tabs.
- [ ] Add a cashier transaction history view.
- [ ] Add deposit status states: pending, completed, failed, canceled.
- [ ] Add withdrawal status states: pending, completed, failed, canceled.
- [ ] Build a fake deposit flow that creates a deposit status in Convex.
- [ ] Add a development-only way to mark a fake deposit successful.
- [ ] Credit the wallet exactly once when a fake deposit succeeds.
- [ ] Build a fake withdrawal flow that checks available balance.
- [ ] Place withdrawal funds into a pending state.
- [ ] Finalize or release pending withdrawal funds based on fake withdrawal result.
- [ ] Show clear loading, pending, failed, and retry states.

## Phase 5: Server-Side Plinko Settlement

- [ ] Replace local bet and payout balance changes with Convex mutations.
- [ ] Send bet amount, rows, risk, and client seed to Convex.
- [ ] Validate the user, wallet state, bet amount, rows, and risk in Convex.
- [ ] Record the bet.
- [ ] Generate or settle the Plinko result in Convex.
- [ ] Record the game round result.
- [ ] Record the payout.
- [ ] Return the result path to the client.
- [ ] Keep the Plinko animation client-side after receiving the backend result.
- [ ] Keep the current provably fair display, but make the backend own seed, nonce, and result data.
- [ ] Ensure a game round can be replayed or inspected from saved data.

## Phase 6: Player-Facing Frontend Integration

- [ ] Replace local balance reads with a Convex-backed balance subscription.
- [ ] Show wallet state globally.
- [ ] Keep the current play history UI, but back it with Convex data.
- [ ] Disable betting while wallet state or game settlement is pending.
- [ ] Handle insufficient balance before a bet is submitted.
- [ ] Handle failed settlement without leaving the UI in a stuck state.
- [ ] Keep row and risk preferences local unless they become account-level settings later.
- [ ] Make transaction history and play history visually distinct.

## Phase 7: Admin And Support Tools

- [ ] Add user lookup.
- [ ] Add wallet history lookup.
- [ ] Add deposit and withdrawal status lookup.
- [ ] Add game round lookup.
- [ ] Add manual account lock and unlock controls.
- [ ] Add a manual balance adjustment flow.
- [ ] Track admin actions.
- [ ] Add a failed settlement queue.
- [ ] Add tools for inspecting stuck deposits or withdrawals.

## Phase 8: Reliability And Test Hardening

- [ ] Add structured logs for wallet and game events.
- [ ] Add monitoring for failed wallet mutations.
- [ ] Add monitoring for stuck deposits.
- [ ] Add monitoring for stuck withdrawals.
- [ ] Add monitoring for failed or delayed game settlement.
- [ ] Add reconciliation checks for wallet totals and transaction history.
- [ ] Add alerts for impossible states such as negative available balance.
- [ ] Add test coverage for wallet mutation edge cases.
- [ ] Add test coverage for bet settlement edge cases.
- [ ] Add test coverage for cashier status transitions.

## Out Of Scope For This Plan

- [ ] Do not implement the real deposit payment rails yet.
- [ ] Do not implement the real withdrawal payment rails yet.
- [ ] Do not choose provider-specific callback payloads yet.
- [ ] Do not over-design final database tables before the Convex implementation starts.
