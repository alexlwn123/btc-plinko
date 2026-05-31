import { describe, expect, it } from "vitest";
import {
  assertCashierAmount,
  assertPendingStatus,
  canRetryCashierStatus,
  cashierRequestKey,
} from "../convex/cashierCore";

describe("cashier core", () => {
  it("requires positive integer sat amounts", () => {
    expect(() => assertCashierAmount(1)).not.toThrow();
    expect(() => assertCashierAmount(0)).toThrow(
      "Cashier amounts must be positive safe integers in sats.",
    );
    expect(() => assertCashierAmount(1.25)).toThrow(
      "Cashier amounts must be positive safe integers in sats.",
    );
  });

  it("only allows pending records to transition", () => {
    expect(() => assertPendingStatus("pending", "Deposit")).not.toThrow();
    expect(() => assertPendingStatus("completed", "Deposit")).toThrow(
      "Deposit is already completed.",
    );
  });

  it("identifies retryable failed and canceled records", () => {
    expect(canRetryCashierStatus("pending")).toBe(false);
    expect(canRetryCashierStatus("completed")).toBe(false);
    expect(canRetryCashierStatus("failed")).toBe(true);
    expect(canRetryCashierStatus("canceled")).toBe(true);
  });

  it("builds stable request idempotency keys", () => {
    expect(cashierRequestKey("deposit", "req_123")).toBe("deposit:request:req_123");
    expect(() => cashierRequestKey("withdrawal", "")).toThrow("Cashier request id is required.");
  });
});
