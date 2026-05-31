# MVP Audit

Audit date: May 31, 2026

## Current Status

The core player MVP is mostly in place:

- Anonymous passkey account flow exists.
- Convex wallet balances and wallet events are the source of truth for signed-in play.
- Fake cashier deposit and withdrawal flows exist while real payment rails stay out of scope.
- Server-side Plinko settlement records game rounds, seed proof data, bet debits, and payout credits.
- Player-facing wallet balance, held funds, play history, and error states are wired into the UI.
- CI runs lint and tests.

## Remaining Before MVP Complete

- Run one real passkey browser smoke from `http://localhost:4173`, not `127.0.0.1`: create account, sign out, sign in, and confirm the Convex session survives reload.
- Run one real signed-in cashier/game smoke against Convex: create fake deposit, complete it in dev, place a server-settled drop, confirm wallet balance and play history update, request withdrawal, cancel or fail it, and confirm held funds release.
- Add a minimal support/admin read-only surface before any real-money-like rollout: user lookup, wallet history lookup, cashier transaction lookup, and game round lookup. Full admin write tools can wait, but read visibility is necessary to diagnose stuck player states.
- Add a basic stuck-state review path for pending deposits, pending withdrawals, and failed or incomplete game rounds. This can start as admin queries or a simple internal view before becoming alerts/jobs.
- Do a production deployment smoke on Vercel with the configured Convex URL and confirm dev-only fake controls are unavailable in production.
- Decide the MVP policy for resetting or migrating local demo state when a user signs into a real passkey account.

## Tests Added In This Audit

- `tests/plinko.test.ts` now covers composed backend settlement: round insert, wallet debit/payout, duplicate request idempotency, per-user nonce increments, and insufficient-balance rejection without recording a round.
- `tests/convexDbMock.ts` centralizes the in-memory Convex DB mock so backend helper tests can share one test harness.

## Remaining Test Gaps

- Browser end-to-end tests for passkeys need a Playwright virtual authenticator or equivalent WebAuthn harness.
- Cashier public mutation flows should get composed backend tests similar to Plinko settlement if we extract session-free helper functions from `convex/cashier.ts`.
- Admin/support lookup tests should be added when the Phase 7 read-only support surface exists.
- Stuck-state and reconciliation tests should be added when pending/failed review paths exist.
