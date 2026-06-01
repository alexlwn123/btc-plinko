import { describe, expect, it } from "vitest";
import {
  LndRestClient,
  normalizePaymentHash,
  parseLndStreamJson,
  readLndRestConfig,
} from "../convex/lndClient";

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  };
}

const hashHex = "ab".repeat(32);
const hashBase64 = Buffer.from(hashHex, "hex").toString("base64");
const config = {
  invoiceExpirySeconds: 900,
  macaroonHex: "00ff",
  maxWithdrawalFeeSats: 21,
  paymentTimeoutSeconds: 30,
  restUrl: "https://lnd.example.com",
};

describe("LndRestClient", () => {
  it("creates invoices with LND REST auth headers", async () => {
    const requests: Array<{ body?: string; headers?: Record<string, string>; url: string }> = [];
    const client = new LndRestClient(
      config,
      async (url, init) => {
        requests.push({ body: init?.body, headers: init?.headers, url });
        return response(200, {
          payment_request: "lnbc10n1ptest",
          r_hash: hashBase64,
        });
      },
      () => 1_000,
    );

    const invoice = await client.createInvoice({
      amountSats: 2500,
      memo: "deposit deposits:1",
    });

    expect(invoice).toEqual({
      expiresAt: 901_000,
      paymentHash: hashHex,
      paymentRequest: "lnbc10n1ptest",
    });
    expect(requests).toEqual([
      {
        body: JSON.stringify({
          expiry: "900",
          memo: "deposit deposits:1",
          value: "2500",
        }),
        headers: {
          "Content-Type": "application/json",
          "Grpc-Metadata-macaroon": "00ff",
        },
        url: "https://lnd.example.com/v1/invoices",
      },
    ]);
  });

  it("looks up settled invoices", async () => {
    const client = new LndRestClient(config, async () =>
      response(200, {
        amt_paid_sat: "1200",
        settle_date: "1780000000",
        state: "SETTLED",
      }),
    );

    await expect(client.lookupInvoice(hashHex)).resolves.toEqual({
      paidAmountSats: 1200,
      settledAt: 1_780_000_000_000,
      state: "SETTLED",
    });
  });

  it("decodes payment requests before withdrawals", async () => {
    const client = new LndRestClient(config, async (url) => {
      expect(url).toBe("https://lnd.example.com/v1/payreq/lnbc1ptest");
      return response(200, {
        description: "cash out",
        expiry: "3600",
        num_satoshis: "500",
        payment_hash: hashHex,
        timestamp: "1780000000",
      });
    });

    await expect(client.decodePayReq("lnbc1ptest")).resolves.toEqual({
      amountSats: 500,
      description: "cash out",
      expiresAt: 1_780_003_600_000,
      paymentHash: hashHex,
    });
  });

  it("parses streaming payment responses and returns the terminal status", async () => {
    const client = new LndRestClient(config, async (_url, init) => {
      expect(JSON.parse(init?.body ?? "{}")).toMatchObject({
        fee_limit_sat: "21",
        no_inflight_updates: true,
        payment_request: "lnbc1ptest",
        timeout_seconds: 30,
      });

      return response(
        200,
        `${JSON.stringify({ result: { payment_hash: hashHex, status: "IN_FLIGHT" } })}\n${JSON.stringify(
          {
            result: {
              fee_sat: "3",
              payment_hash: hashHex,
              payment_preimage: "preimage",
              status: "SUCCEEDED",
            },
          },
        )}`,
      );
    });

    await expect(client.payInvoice("lnbc1ptest")).resolves.toEqual({
      failureReason: undefined,
      feePaidSats: 3,
      paymentHash: hashHex,
      paymentPreimage: "preimage",
      status: "SUCCEEDED",
    });
  });

  it("tracks an existing payment by hash", async () => {
    const client = new LndRestClient(config, async (url) => {
      expect(url).toBe(
        `https://lnd.example.com/v2/router/track/${hashHex}?no_inflight_updates=true`,
      );
      return response(200, {
        result: {
          failure_reason: "FAILURE_REASON_NO_ROUTE",
          fee_sat: "2",
          payment_hash: hashHex,
          status: "FAILED",
        },
      });
    });

    await expect(client.trackPayment(hashHex)).resolves.toEqual({
      failureReason: "FAILURE_REASON_NO_ROUTE",
      feePaidSats: 2,
      paymentHash: hashHex,
      paymentPreimage: undefined,
      status: "FAILED",
    });
  });

  it("surfaces LND error bodies", async () => {
    const client = new LndRestClient(config, async () => response(503, { error: "node offline" }));

    await expect(client.lookupInvoice(hashHex)).rejects.toThrow(
      "LND request failed (503): node offline",
    );
  });
});

describe("lnd client helpers", () => {
  it("normalizes base64 and hex payment hashes", () => {
    expect(normalizePaymentHash(hashHex.toUpperCase())).toBe(hashHex);
    expect(normalizePaymentHash(hashBase64)).toBe(hashHex);
    expect(() => normalizePaymentHash("short")).toThrow("LND payment hash must be 32 bytes.");
  });

  it("parses whole JSON and newline-delimited stream responses", () => {
    expect(parseLndStreamJson(JSON.stringify({ result: { status: "SUCCEEDED" } }))).toEqual([
      { result: { status: "SUCCEEDED" } },
    ]);
    expect(
      parseLndStreamJson(
        `${JSON.stringify({ result: { status: "IN_FLIGHT" } })}\n${JSON.stringify({
          result: { status: "FAILED" },
        })}`,
      ),
    ).toEqual([{ result: { status: "IN_FLIGHT" } }, { result: { status: "FAILED" } }]);
  });

  it("reads required LND config from env", () => {
    expect(
      readLndRestConfig({
        LND_INVOICE_EXPIRY_SECONDS: "60",
        LND_MACAROON_HEX: "abc",
        LND_MAX_WITHDRAWAL_FEE_SATS: "9",
        LND_PAYMENT_TIMEOUT_SECONDS: "10",
        LND_REST_URL: "https://lnd.example.com/",
      }),
    ).toEqual({
      invoiceExpirySeconds: 60,
      macaroonHex: "abc",
      maxWithdrawalFeeSats: 9,
      paymentTimeoutSeconds: 10,
      restUrl: "https://lnd.example.com",
    });
    expect(() => readLndRestConfig({ LND_MACAROON_HEX: "abc" })).toThrow(
      "LND_REST_URL is required.",
    );
  });
});
