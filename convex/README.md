# Convex Setup

Phase 0 adds the local Convex app structure and dependencies, but does not link this repo to a real Convex deployment yet.

Run `pnpm convex:dev` after the Convex project is created/linked. That command will generate `convex/_generated` and connect the local functions to the selected Convex project.

## LND Lightning Cashier

Lightning deposits and withdrawals run through Convex actions, which call the LND REST API from the server side. The browser never receives LND credentials.

Required Convex environment variables:

- `LND_REST_URL`: HTTPS base URL for the LND REST endpoint or a narrow payment bridge in front of it.
- `LND_MACAROON_HEX`: hex-encoded macaroon with the least permissions needed for invoice creation, invoice lookup, payment decode, payment send, and payment tracking.

Optional Convex environment variables:

- `LND_INVOICE_EXPIRY_SECONDS`: deposit invoice expiry. Defaults to `900`.
- `LND_MAX_WITHDRAWAL_FEE_SATS`: maximum LND routing fee for withdrawals. Defaults to `50`.
- `LND_PAYMENT_TIMEOUT_SECONDS`: withdrawal payment attempt timeout. Defaults to `30`.

For production, prefer putting a small authenticated payment bridge beside the cloud LND node instead of exposing LND REST directly to the public internet.
