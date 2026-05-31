import { describe, expect, it } from "vitest";
import {
  applyWalletDelta,
  assertPositiveWalletAmount,
  assertWalletAmount,
  idempotencyKeyFor,
} from "../convex/walletCore";

describe("wallet core", () => {
  it("applies available and held balance deltas", () => {
    expect(
      applyWalletDelta(
        { availableBalance: 1000, heldBalance: 0 },
        { availableDelta: -250, heldDelta: 250 },
      ),
    ).toEqual({
      availableBalance: 750,
      heldBalance: 250,
    });
  });

  it("rejects negative available balances", () => {
    expect(() =>
      applyWalletDelta(
        { availableBalance: 100, heldBalance: 0 },
        { availableDelta: -101, heldDelta: 101 },
      ),
    ).toThrow("Wallet amounts must be non-negative safe integers in sats.");
  });

  it("rejects negative held balances", () => {
    expect(() =>
      applyWalletDelta(
        { availableBalance: 100, heldBalance: 10 },
        { availableDelta: 0, heldDelta: -11 },
      ),
    ).toThrow("Wallet amounts must be non-negative safe integers in sats.");
  });

  it("requires safe integer sat amounts", () => {
    expect(() => assertWalletAmount(1.5)).toThrow(
      "Wallet amounts must be non-negative safe integers in sats.",
    );
    expect(() => assertWalletAmount(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      "Wallet amounts must be non-negative safe integers in sats.",
    );
  });

  it("requires positive wallet mutation amounts", () => {
    expect(() => assertPositiveWalletAmount(0)).toThrow("Wallet amount must be greater than zero.");
  });

  it("builds stable idempotency keys", () => {
    expect(idempotencyKeyFor("deposit", "dep_123", "deposit_credit")).toBe(
      "deposit:dep_123:deposit_credit",
    );
    expect(() => idempotencyKeyFor("deposit", "", "deposit_credit")).toThrow(
      "Wallet idempotency source must be complete.",
    );
  });
});
