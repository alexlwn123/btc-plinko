# Payment sandbox

Open `/sandbox` to test checkout creation, confirmation, duplicate refreshes,
failure, expiry, and browser-local test credit updates. The link is also on the
signed-out account screen. This page does not access Convex wallets, game balances,
deposits, withdrawals, or settlement. Credits have no cash value and cannot be wagered.

## Local simulator

Run `pnpm dev` and visit `http://127.0.0.1:4173/sandbox` (use the port printed by Vite).
The simulator needs no credentials and makes no MDK calls. QR codes contain an
unpayable sandbox reference, not a Lightning invoice. Simulate success, failure,
or expiry from the checkout panel. Successful checkouts are counted once by ID.
History lives only in `btc-plinko:payment-sandbox:v1` in this browser. It is demo
state, not an authoritative financial ledger. Reset clears only that sandbox history.

## Money Dev Kit staging

The adapter uses `@moneydevkit/core` 0.22.0 with `sandbox: true` and `MDK_PREVIEW=true`,
and pins every network service to Signet/Mutinynet staging. It never sends payments.
Credentials are required to test the hosted provider; the simulator is not proof
that staging checkout/webhook delivery works.

Obtain a dedicated staging app and credentials using MDK's
[staging guide](https://github.com/moneydevkit/mdk-checkout/blob/main/STAGING-TESTING.md).
Use a separate sandbox deployment or tunnel and register its base URL for webhook
delivery to `/api/mdk`. Do not use an existing merchant's production credentials.

Set these **server-only** variables in `.env.local`, or on the sandbox Vercel deployment:

```dotenv
MDK_ACCESS_TOKEN=<dedicated staging app token>
MDK_MNEMONIC=<dedicated staging mnemonic>
MDK_NETWORK=signet
```

Do not prefix these names with `VITE_`, commit them, or paste them into chat.
Restart Vite after configuration changes. The Money Dev Kit staging option becomes
available once the server sees both credentials, an explicit Signet network, and
no conflicting endpoint settings. These are MDK's standard variable names; no
custom credential aliases are used. Credentials alone do not enable the SDK.
Checkout confirmation fetches the
provider record, verifies its sandbox flag, purpose, currency and amount, then uses
MDK's preview-only confirmation method and re-fetches payment status. Only the
provider's `PAYMENT_RECEIVED` state adds test credits. Pending MDK checkouts poll
every three seconds; failed requests expose a retryable message.

All MDK node/RPC URLs are fixed in `server/mdkSandbox.ts`. Conflicting `MDK_NETWORK`
or endpoint variables cause requests to fail before loading the SDK. The public
endpoint exposes only create/get/test-confirm; webhook/ping requests use the SDK's
secret validation. No payout, wallet balance, or mainnet endpoint is exposed.

## Build and verification

`pnpm build` bundles the SDK into `server/generated/mdkSdk.cjs` because the package's
extensionless ESM imports cannot load directly in Node. The native Lightning addon
remains external. The same adapter serves `/api/mdk` in Vite and Vercel Functions.
`vercel.json` rewrites `/sandbox` to the SPA entry point.

Run `pnpm test`, `pnpm check`, and `pnpm build`. Provider tests use an injected SDK
fixture; a staging account and working webhook URL are still needed for hosted
end-to-end testing. Never treat these sandbox checks as real payment validation.
