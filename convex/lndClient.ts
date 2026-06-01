export type LndRestConfig = {
  invoiceExpirySeconds: number;
  macaroonHex: string;
  maxWithdrawalFeeSats: number;
  paymentTimeoutSeconds: number;
  restUrl: string;
};

export type LndCreateInvoiceResult = {
  expiresAt: number;
  paymentHash: string;
  paymentRequest: string;
};

export type LndInvoiceStatus = {
  paidAmountSats: number;
  settledAt?: number;
  state: "OPEN" | "SETTLED" | "CANCELED" | "ACCEPTED" | "UNKNOWN";
};

export type LndDecodedInvoice = {
  amountSats: number | null;
  description: string;
  expiresAt: number | null;
  paymentHash: string;
};

export type LndPaymentStatus = {
  failureReason?: string;
  feePaidSats: number;
  paymentHash: string;
  paymentPreimage?: string;
  status: "SUCCEEDED" | "FAILED" | "IN_FLIGHT" | "UNKNOWN";
};

type FetchLike = (
  input: string,
  init?: {
    body?: string;
    headers?: Record<string, string>;
    method?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

type LndJson = Record<string, unknown>;

const HEX_32_BYTE_PATTERN = /^[a-f0-9]{64}$/i;
const DEFAULT_INVOICE_EXPIRY_SECONDS = 15 * 60;
const DEFAULT_MAX_WITHDRAWAL_FEE_SATS = 50;
const DEFAULT_PAYMENT_TIMEOUT_SECONDS = 30;

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`LND response is missing ${field}.`);
  }

  return value;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFromLnd(value: unknown, field: string) {
  const parsed = typeof value === "string" ? Number(value) : value;

  if (!Number.isFinite(parsed)) {
    throw new Error(`LND response has invalid ${field}.`);
  }

  return Number(parsed);
}

function optionalNumberFromLnd(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return undefined;
  return numberFromLnd(value, field);
}

function urlSafePath(value: string) {
  return encodeURIComponent(value).replaceAll("%2F", "_").replaceAll("%2B", "-");
}

export function normalizePaymentHash(value: string) {
  if (HEX_32_BYTE_PATTERN.test(value)) {
    return value.toLowerCase();
  }

  const bytes = Buffer.from(value, "base64");
  const hex = bytes.toString("hex");

  if (!HEX_32_BYTE_PATTERN.test(hex)) {
    throw new Error("LND payment hash must be 32 bytes.");
  }

  return hex.toLowerCase();
}

export function parseLndStreamJson(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  try {
    return [JSON.parse(trimmed)];
  } catch {
    return trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

function unwrapLndResult(value: unknown): LndJson {
  if (!value || typeof value !== "object") {
    throw new Error("LND response is not a JSON object.");
  }

  const result = (value as { result?: unknown }).result;
  if (result && typeof result === "object") {
    return result as LndJson;
  }

  return value as LndJson;
}

function normalizeInvoiceState(state: unknown, settled: unknown): LndInvoiceStatus["state"] {
  if (state === "SETTLED" || settled === true) return "SETTLED";
  if (state === "CANCELED") return "CANCELED";
  if (state === "ACCEPTED") return "ACCEPTED";
  if (state === "OPEN" || state === undefined || state === "") return "OPEN";
  return "UNKNOWN";
}

function normalizePaymentStatus(status: unknown): LndPaymentStatus["status"] {
  if (status === "SUCCEEDED" || status === "FAILED" || status === "IN_FLIGHT") {
    return status;
  }

  return "UNKNOWN";
}

function positiveIntegerFromEnv(value: string | undefined, fallback: number, name: string) {
  if (value === undefined || value === "") return fallback;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

export function readLndRestConfig(env: Record<string, string | undefined>): LndRestConfig {
  const restUrl = env.LND_REST_URL?.replace(/\/+$/, "");
  const macaroonHex = env.LND_MACAROON_HEX;

  if (!restUrl) {
    throw new Error("LND_REST_URL is required.");
  }

  if (!macaroonHex) {
    throw new Error("LND_MACAROON_HEX is required.");
  }

  return {
    invoiceExpirySeconds: positiveIntegerFromEnv(
      env.LND_INVOICE_EXPIRY_SECONDS,
      DEFAULT_INVOICE_EXPIRY_SECONDS,
      "LND_INVOICE_EXPIRY_SECONDS",
    ),
    macaroonHex,
    maxWithdrawalFeeSats: positiveIntegerFromEnv(
      env.LND_MAX_WITHDRAWAL_FEE_SATS,
      DEFAULT_MAX_WITHDRAWAL_FEE_SATS,
      "LND_MAX_WITHDRAWAL_FEE_SATS",
    ),
    paymentTimeoutSeconds: positiveIntegerFromEnv(
      env.LND_PAYMENT_TIMEOUT_SECONDS,
      DEFAULT_PAYMENT_TIMEOUT_SECONDS,
      "LND_PAYMENT_TIMEOUT_SECONDS",
    ),
    restUrl,
  };
}

export class LndRestClient {
  constructor(
    private readonly config: LndRestConfig,
    private readonly fetchFn: FetchLike = fetch,
    private readonly now = () => Date.now(),
  ) {}

  async createInvoice({
    amountSats,
    memo,
  }: {
    amountSats: number;
    memo: string;
  }): Promise<LndCreateInvoiceResult> {
    const json = await this.post("/v1/invoices", {
      expiry: String(this.config.invoiceExpirySeconds),
      memo,
      value: String(amountSats),
    });

    return {
      expiresAt: this.now() + this.config.invoiceExpirySeconds * 1000,
      paymentHash: normalizePaymentHash(requiredString(json.r_hash, "r_hash")),
      paymentRequest: requiredString(json.payment_request, "payment_request"),
    };
  }

  async decodePayReq(paymentRequest: string): Promise<LndDecodedInvoice> {
    const json = await this.get(`/v1/payreq/${urlSafePath(paymentRequest)}`);
    const timestamp = optionalNumberFromLnd(json.timestamp, "timestamp");
    const expirySeconds = optionalNumberFromLnd(json.expiry, "expiry");

    return {
      amountSats: optionalNumberFromLnd(json.num_satoshis, "num_satoshis") ?? null,
      description: optionalString(json.description) ?? "",
      expiresAt:
        timestamp !== undefined && expirySeconds !== undefined
          ? (timestamp + expirySeconds) * 1000
          : null,
      paymentHash: normalizePaymentHash(requiredString(json.payment_hash, "payment_hash")),
    };
  }

  async lookupInvoice(paymentHash: string): Promise<LndInvoiceStatus> {
    const json = await this.get(`/v1/invoice/${urlSafePath(paymentHash)}`);
    const paidAmount =
      optionalNumberFromLnd(json.amt_paid_sat, "amt_paid_sat") ??
      Math.floor((optionalNumberFromLnd(json.amt_paid_msat, "amt_paid_msat") ?? 0) / 1000);
    const settleDate = optionalNumberFromLnd(json.settle_date, "settle_date");

    return {
      paidAmountSats: paidAmount,
      settledAt: settleDate ? settleDate * 1000 : undefined,
      state: normalizeInvoiceState(json.state, json.settled),
    };
  }

  async payInvoice(paymentRequest: string): Promise<LndPaymentStatus> {
    const json = await this.postStream("/v2/router/send", {
      fee_limit_sat: String(this.config.maxWithdrawalFeeSats),
      no_inflight_updates: true,
      payment_request: paymentRequest,
      timeout_seconds: this.config.paymentTimeoutSeconds,
    });

    return {
      failureReason: optionalString(json.failure_reason),
      feePaidSats: optionalNumberFromLnd(json.fee_sat, "fee_sat") ?? 0,
      paymentHash: normalizePaymentHash(requiredString(json.payment_hash, "payment_hash")),
      paymentPreimage: optionalString(json.payment_preimage),
      status: normalizePaymentStatus(json.status),
    };
  }

  async trackPayment(paymentHash: string): Promise<LndPaymentStatus> {
    const json = await this.getStream(`/v2/router/track/${urlSafePath(paymentHash)}`);

    return {
      failureReason: optionalString(json.failure_reason),
      feePaidSats: optionalNumberFromLnd(json.fee_sat, "fee_sat") ?? 0,
      paymentHash: normalizePaymentHash(requiredString(json.payment_hash, "payment_hash")),
      paymentPreimage: optionalString(json.payment_preimage),
      status: normalizePaymentStatus(json.status),
    };
  }

  private async get(path: string) {
    return await this.request(path, { method: "GET" });
  }

  private async post(path: string, body: LndJson) {
    return await this.request(path, {
      body: JSON.stringify(body),
      method: "POST",
    });
  }

  private async postStream(path: string, body: LndJson) {
    const text = await this.requestText(path, {
      body: JSON.stringify(body),
      method: "POST",
    });
    const objects = parseLndStreamJson(text).map(unwrapLndResult);
    const last = objects.at(-1);

    if (!last) {
      throw new Error("LND returned an empty payment stream.");
    }

    return last;
  }

  private async getStream(path: string) {
    const text = await this.requestText(`${path}?no_inflight_updates=true`, {
      method: "GET",
    });
    const objects = parseLndStreamJson(text).map(unwrapLndResult);
    const last = objects.at(-1);

    if (!last) {
      throw new Error("LND returned an empty payment stream.");
    }

    return last;
  }

  private async request(path: string, init: { body?: string; method: string }) {
    const text = await this.requestText(path, init);
    return unwrapLndResult(JSON.parse(text));
  }

  private async requestText(path: string, init: { body?: string; method: string }) {
    const response = await this.fetchFn(`${this.config.restUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "Grpc-Metadata-macaroon": this.config.macaroonHex,
      },
    });
    const text = await response.text();

    if (!response.ok) {
      let message = text;
      try {
        const parsed = JSON.parse(text);
        message = parsed.error ?? parsed.message ?? text;
      } catch {
        // Keep the raw body.
      }

      throw new Error(`LND request failed (${response.status}): ${message}`);
    }

    return text;
  }
}
