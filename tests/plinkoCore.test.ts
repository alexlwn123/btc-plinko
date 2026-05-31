import { describe, expect, it } from "vitest";
import {
  PLINKO_MULTIPLIERS,
  assertPlinkoBetAmount,
  buildPlinkoMultipliers,
  calculatePayoutAmount,
  commitServerSeed,
  normalizeClientSeed,
  settlePlinkoDrop,
} from "../convex/plinkoCore";
import { buildMultipliers } from "../src/core";

describe("plinko settlement core", () => {
  it("keeps server multipliers aligned with the client display table", () => {
    for (const [rows, byRisk] of Object.entries(PLINKO_MULTIPLIERS)) {
      for (const risk of Object.keys(byRisk)) {
        expect(buildPlinkoMultipliers(Number(rows), risk)).toEqual(
          buildMultipliers(Number(rows), risk),
        );
      }
    }
  });

  it("settles deterministic drops from server seed, client seed, and nonce", async () => {
    const settled = await settlePlinkoDrop({
      betAmount: 10,
      clientSeed: "client-visible-example",
      nonce: 42,
      risk: "medium",
      rows: 12,
      serverSeed: "server-secret-example",
    });
    const rebuilt = await settlePlinkoDrop({
      betAmount: 10,
      clientSeed: "client-visible-example",
      nonce: 42,
      risk: "medium",
      rows: 12,
      serverSeed: "server-secret-example",
    });

    expect(settled).toEqual(rebuilt);
    expect(settled.serverSeedHash).toBe(await commitServerSeed("server-secret-example"));
    expect(settled.directions).toHaveLength(12);
    expect(settled.points).toHaveLength(13);
    expect(settled.slot).toBe(settled.directions.filter((direction) => direction === "R").length);
    expect(settled.multiplier).toBe(buildMultipliers(12, "medium")[settled.slot]);
    expect(settled.payoutAmount).toBe(calculatePayoutAmount(10, settled.multiplier));
  });

  it("calculates fractional multiplier payouts with integer math", () => {
    expect(calculatePayoutAmount(10, 0.3)).toBe(3);
    expect(calculatePayoutAmount(11, 0.3)).toBe(3);
    expect(calculatePayoutAmount(10, 1.1)).toBe(11);
    expect(calculatePayoutAmount(10, 1000)).toBe(10_000);
  });

  it("validates bet amount, rows, risk, and client seed", async () => {
    expect(() => assertPlinkoBetAmount(0)).toThrow("Wallet amount must be greater than zero.");
    expect(() => assertPlinkoBetAmount(1_000_001)).toThrow(
      "Bet amount cannot exceed 1000000 sats.",
    );
    expect(normalizeClientSeed("")).toBe("browser-client");
    expect(() => normalizeClientSeed("x".repeat(129))).toThrow(
      "Client seed cannot exceed 128 characters.",
    );
    expect(() => buildPlinkoMultipliers(7, "medium")).toThrow("Rows setting is not supported.");
    expect(() => buildPlinkoMultipliers(12, "extreme")).toThrow("Risk level is not supported.");
    await expect(
      settlePlinkoDrop({
        betAmount: 10,
        clientSeed: "client",
        nonce: 1,
        risk: "extreme",
        rows: 12,
        serverSeed: "server",
      }),
    ).rejects.toThrow("Risk level is not supported.");
  });
});
