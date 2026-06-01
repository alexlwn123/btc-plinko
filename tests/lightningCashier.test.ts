import { describe, expect, it } from "vitest";
import {
  attachLightningDepositInvoiceForUser,
  completeLightningWithdrawalForUser,
  createLightningDepositRecordForUser,
  createLightningWithdrawalRecordForUser,
  failLightningDepositForUser,
  failLightningWithdrawalForUser,
  markLightningWithdrawalInFlightForUser,
  settleLightningDepositForUser,
} from "../convex/cashier";
import { INITIAL_PLAYABLE_BALANCE_SATS } from "../convex/walletCore";
import { createDbMock, mutationCtx, testUserId as userId } from "./convexDbMock";

const paymentHash = "ab".repeat(32);
const paymentRequest = "lnbc10n1ptest";

describe("lightning cashier mutations", () => {
  it("creates, attaches, and settles a Lightning deposit exactly once", async () => {
    const db = createDbMock();
    const deposit = await createLightningDepositRecordForUser(mutationCtx(db), {
      amount: 1500,
      requestId: "deposit-request-1",
      userId,
    });
    const duplicate = await createLightningDepositRecordForUser(mutationCtx(db), {
      amount: 1500,
      requestId: "deposit-request-1",
      userId,
    });
    const attached = await attachLightningDepositInvoiceForUser(mutationCtx(db), {
      depositId: deposit.id,
      expiresAt: 2_000,
      paymentHash,
      paymentRequest,
    });
    const settled = await settleLightningDepositForUser(mutationCtx(db), {
      depositId: deposit.id,
      paymentHash,
      settledAmount: 1700,
      settledAt: 3_000,
    });
    const settledAgain = await settleLightningDepositForUser(mutationCtx(db), {
      depositId: deposit.id,
      paymentHash,
      settledAmount: 1700,
      settledAt: 4_000,
    });

    expect(duplicate.id).toBe(deposit.id);
    expect(attached).toMatchObject({
      lightningPaymentHash: paymentHash,
      lightningPaymentRequest: paymentRequest,
      lightningState: "invoice_created",
      provider: "lnd",
      status: "pending",
    });
    expect(settled).toMatchObject({
      amount: 1700,
      lightningState: "settled",
      status: "completed",
    });
    expect(settledAgain).toMatchObject({
      id: deposit.id,
      status: "completed",
    });
    expect(db.rows("wallets")[0]).toMatchObject({
      availableBalance: INITIAL_PLAYABLE_BALANCE_SATS + 1700,
      heldBalance: 0,
    });
    expect(db.rows("walletEvents").filter((event) => event.kind === "deposit_credit")).toHaveLength(
      1,
    );
  });

  it("fails a Lightning deposit without crediting the wallet", async () => {
    const db = createDbMock();
    const deposit = await createLightningDepositRecordForUser(mutationCtx(db), {
      amount: 1000,
      requestId: "deposit-request-2",
      userId,
    });

    const failed = await failLightningDepositForUser(mutationCtx(db), {
      depositId: deposit.id,
      failureReason: "invoice expired",
      lightningState: "expired",
    });

    expect(failed).toMatchObject({
      lightningState: "expired",
      providerError: "invoice expired",
      status: "failed",
    });
    expect(db.rows("walletEvents")).toHaveLength(0);
  });

  it("holds and captures Lightning withdrawals exactly once", async () => {
    const db = createDbMock();
    const withdrawal = await createLightningWithdrawalRecordForUser(mutationCtx(db), {
      amount: 600,
      paymentHash,
      paymentRequest,
      requestId: "withdraw-request-1",
      userId,
    });
    const inFlight = await markLightningWithdrawalInFlightForUser(mutationCtx(db), {
      paymentHash,
      withdrawalId: withdrawal.id,
    });
    const completed = await completeLightningWithdrawalForUser(mutationCtx(db), {
      feePaid: 3,
      paymentHash,
      paymentPreimage: "preimage",
      withdrawalId: withdrawal.id,
    });
    const completedAgain = await completeLightningWithdrawalForUser(mutationCtx(db), {
      feePaid: 4,
      paymentHash,
      withdrawalId: withdrawal.id,
    });

    expect(withdrawal).toMatchObject({
      lightningPaymentHash: paymentHash,
      lightningState: "payment_created",
      provider: "lnd",
      status: "pending",
    });
    expect(inFlight).toMatchObject({
      lightningState: "in_flight",
      status: "pending",
    });
    expect(completed).toMatchObject({
      lightningFeePaid: 3,
      lightningPaymentPreimage: "preimage",
      lightningState: "succeeded",
      status: "completed",
    });
    expect(completedAgain.status).toBe("completed");
    expect(db.rows("wallets")[0]).toMatchObject({
      availableBalance: INITIAL_PLAYABLE_BALANCE_SATS - 600,
      heldBalance: 0,
    });
    expect(db.rows("walletEvents").map((event) => event.kind)).toEqual([
      "manual_adjustment",
      "withdrawal_hold",
      "withdrawal_capture",
    ]);
  });

  it("releases held funds when a Lightning withdrawal fails", async () => {
    const db = createDbMock();
    const withdrawal = await createLightningWithdrawalRecordForUser(mutationCtx(db), {
      amount: 600,
      paymentHash,
      paymentRequest,
      requestId: "withdraw-request-2",
      userId,
    });

    const failed = await failLightningWithdrawalForUser(mutationCtx(db), {
      failureReason: "no route",
      paymentHash,
      withdrawalId: withdrawal.id,
    });

    expect(failed).toMatchObject({
      lightningState: "failed",
      providerError: "no route",
      status: "failed",
    });
    expect(db.rows("wallets")[0]).toMatchObject({
      availableBalance: INITIAL_PLAYABLE_BALANCE_SATS,
      heldBalance: 0,
    });
    expect(db.rows("walletEvents").map((event) => event.kind)).toEqual([
      "manual_adjustment",
      "withdrawal_hold",
      "withdrawal_release",
    ]);
  });
});
