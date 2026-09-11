import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSandboxRequest, sandboxConfig, sandboxConfigured } from "../server/mdkSandbox";

const require = createRequire(import.meta.url);
const env = {
  MDK_ACCESS_TOKEN: "test-only",
  MDK_MNEMONIC: "test-only",
  MDK_NETWORK: "signet",
};
const request = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://example.com/api/mdk", {
    method: "POST",
    headers: { "Content-Type": "application/json", host: "example.com", ...headers },
    body: JSON.stringify(body),
  });
const csrf = { cookie: "mdk_csrf=test-token", "x-moneydevkit-csrf-token": "test-token" };

beforeEach(() => {
  for (const key of Object.keys(sandboxConfig(env))) vi.stubEnv(key, process.env[key]);
  for (const key of ["REPLIT_DEV_DOMAIN", "REPLIT_DOMAINS"]) vi.stubEnv(key, undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("Signet network boundary", () => {
  it("uses standard credentials and disables preview simulation", () => {
    expect(sandboxConfig(env)).toMatchObject({
      ...env,
      MDK_PREVIEW: "false",
      NEXT_PUBLIC_MDK_PREVIEW: "false",
      MDK_API_BASE_URL: "https://staging.moneydevkit.com/rpc",
    });
    expect(sandboxConfigured(env)).toBe(true);
    expect(sandboxConfigured({ ...env, MDK_ACCESS_TOKEN: " " })).toBe(false);
  });

  it.each([
    { ...env, MDK_NETWORK: undefined },
    { ...env, MDK_NETWORK: "mainnet" },
    { ...env, MDK_API_BASE_URL: "https://moneydevkit.com/rpc" },
    { ...env, MDK_MNEMONIC: "" },
  ])("never loads MDK for missing or incompatible configuration", async (config) => {
    const load = vi.fn();
    const response = await handleSandboxRequest(
      request({ handler: "create_checkout" }),
      config,
      load,
    );
    expect(response.status).toBe(503);
    expect(load).not.toHaveBeenCalled();
    expect(sandboxConfigured(config)).toBe(false);
  });

  it("reports configuration without loading the SDK or returning credentials", async () => {
    const load = vi.fn();
    const response = await handleSandboxRequest(
      new Request("https://example.com/api/mdk"),
      env,
      load,
    );
    expect(await response.json()).toEqual({
      mdkConfigured: true,
      network: "signet",
      redeemable: false,
    });
    expect(load).not.toHaveBeenCalled();
  });
});

describe("standard MDK protocol", () => {
  it("passes the original request and response through without translating checkout data", async () => {
    const body = {
      handler: "create_checkout",
      params: { type: "AMOUNT", currency: "SAT", amount: 1000 },
    };
    const input = request(body, csrf);
    const response = Response.json({ data: { id: "sdk-checkout", status: "UNCONFIRMED" } });
    const POST = vi.fn(async (received: Request) => {
      expect(received).toBe(input);
      expect(await received.json()).toEqual(body);
      expect(process.env.MDK_NETWORK).toBe("signet");
      return response;
    });
    expect(await handleSandboxRequest(input, env, () => ({ POST }))).toBe(response);
    expect(POST).toHaveBeenCalledOnce();
  });

  // These exercise the installed SDK's validation, without provider or Lightning calls.
  it("uses MDK's CSRF protection", async () => {
    const sdk = require("../server/generated/mdkSdk.cjs");
    const response = await handleSandboxRequest(
      request({ handler: "create_checkout" }),
      env,
      () => sdk,
    );
    expect(response.status).toBe(401);
  });

  it("uses MDK's webhook authentication", async () => {
    const sdk = require("../server/generated/mdkSdk.cjs");
    const response = await handleSandboxRequest(request({ handler: "webhook" }), env, () => sdk);
    expect(response.status).toBe(401);
  });

  it("uses MDK's checkout parameter validation", async () => {
    const sdk = require("../server/generated/mdkSdk.cjs");
    const response = await handleSandboxRequest(
      request({ handler: "create_checkout", params: {} }, csrf),
      env,
      () => sdk,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Invalid checkout params" });
  });

  it("does not enable MDK's fake payment confirmation", async () => {
    const sdk = require("../server/generated/mdkSdk.cjs");
    const response = await handleSandboxRequest(
      request({ handler: "pay_invoice", paymentHash: "test", amountSats: 1000 }, csrf),
      env,
      () => sdk,
    );
    expect(response.status).toBe(403);
  });

  it("does not support the removed custom action protocol", async () => {
    const sdk = require("../server/generated/mdkSdk.cjs");
    const response = await handleSandboxRequest(
      request({ action: "confirm", id: "test" }),
      env,
      () => sdk,
    );
    expect(response.status).toBe(400);
  });
});
