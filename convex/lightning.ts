"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action } from "./_generated/server";
import { assertCashierAmount } from "./cashierCore";
import { LndRestClient, readLndRestConfig } from "./lndClient";

type DepositActionResult = {
  amount: number;
  id: Id<"deposits">;
  lightningExpiresAt?: number;
  lightningPaymentHash?: string;
  lightningPaymentRequest?: string;
  status: string;
};

type WithdrawalActionResult = {
  id: Id<"withdrawals">;
  lightningPaymentHash?: string;
  status: string;
};

// biome-ignore lint/suspicious/noExplicitAny: breaks recursive Convex generated action inference.
const cashierInternal = internal.cashier as Record<string, any>;

function lndClient() {
  return new LndRestClient(readLndRestConfig(process.env));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Lightning payment failed.";
}

function assertPaymentRequest(value: string) {
  const trimmed = value.trim();

  if (!/^ln[a-z0-9]+$/i.test(trimmed)) {
    throw new Error("Enter a valid Lightning invoice.");
  }

  return trimmed;
}

export const createDeposit = action({
  args: {
    amount: v.number(),
    requestId: v.string(),
    sessionToken: v.string(),
  },
  handler: async (ctx, args): Promise<DepositActionResult> => {
    assertCashierAmount(args.amount);

    const deposit = (await ctx.runMutation(
      cashierInternal.createLightningDepositRecord,
      args,
    )) as DepositActionResult;

    if (deposit.status !== "pending" || deposit.lightningPaymentRequest) {
      return deposit;
    }

    try {
      const invoice = await lndClient().createInvoice({
        amountSats: deposit.amount,
        memo: `BTC Plinko deposit ${deposit.id}`,
      });

      return (await ctx.runMutation(cashierInternal.attachLightningDepositInvoice, {
        depositId: deposit.id,
        expiresAt: invoice.expiresAt,
        paymentHash: invoice.paymentHash,
        paymentRequest: invoice.paymentRequest,
      })) as DepositActionResult;
    } catch (error) {
      await ctx.runMutation(cashierInternal.failLightningDeposit, {
        depositId: deposit.id,
        failureReason: errorMessage(error),
        lightningState: "failed",
      });
      throw error;
    }
  },
});

export const syncDeposit = action({
  args: {
    depositId: v.id("deposits"),
    sessionToken: v.string(),
  },
  handler: async (ctx, { depositId, sessionToken }): Promise<DepositActionResult> => {
    const deposit = (await ctx.runQuery(cashierInternal.getLightningDepositForUser, {
      depositId,
      sessionToken,
    })) as DepositActionResult;

    if (deposit.status !== "pending") {
      return deposit;
    }

    if (!deposit.lightningPaymentHash) {
      throw new Error("Deposit has no Lightning invoice.");
    }

    const invoice = await lndClient().lookupInvoice(deposit.lightningPaymentHash);

    if (invoice.state === "SETTLED") {
      return (await ctx.runMutation(cashierInternal.settleLightningDeposit, {
        depositId,
        paymentHash: deposit.lightningPaymentHash,
        settledAmount: invoice.paidAmountSats,
        settledAt: invoice.settledAt,
      })) as DepositActionResult;
    }

    if (invoice.state === "CANCELED") {
      return (await ctx.runMutation(cashierInternal.failLightningDeposit, {
        depositId,
        failureReason: "Lightning invoice was canceled.",
        lightningState: "canceled",
      })) as DepositActionResult;
    }

    if (deposit.lightningExpiresAt && deposit.lightningExpiresAt < Date.now()) {
      return (await ctx.runMutation(cashierInternal.failLightningDeposit, {
        depositId,
        failureReason: "Lightning invoice expired.",
        lightningState: "expired",
      })) as DepositActionResult;
    }

    return deposit;
  },
});

export const createWithdrawal = action({
  args: {
    amount: v.number(),
    paymentRequest: v.string(),
    requestId: v.string(),
    sessionToken: v.string(),
  },
  handler: async (
    ctx,
    { amount, paymentRequest, requestId, sessionToken },
  ): Promise<WithdrawalActionResult> => {
    assertCashierAmount(amount);
    await ctx.runQuery(cashierInternal.requireCashierSession, { sessionToken });

    const trimmedPaymentRequest = assertPaymentRequest(paymentRequest);
    const client = lndClient();
    const decoded = await client.decodePayReq(trimmedPaymentRequest);

    if (decoded.amountSats !== null && decoded.amountSats !== amount) {
      throw new Error("Lightning invoice amount does not match withdrawal amount.");
    }

    if (decoded.expiresAt !== null && decoded.expiresAt < Date.now()) {
      throw new Error("Lightning invoice is expired.");
    }

    const withdrawal = (await ctx.runMutation(cashierInternal.createLightningWithdrawalRecord, {
      amount,
      paymentHash: decoded.paymentHash,
      paymentRequest: trimmedPaymentRequest,
      requestId,
      sessionToken,
    })) as WithdrawalActionResult;

    if (withdrawal.status !== "pending") {
      return withdrawal;
    }

    try {
      const payment = await client.payInvoice(trimmedPaymentRequest);

      if (payment.status === "SUCCEEDED") {
        return (await ctx.runMutation(cashierInternal.completeLightningWithdrawal, {
          feePaid: payment.feePaidSats,
          paymentHash: payment.paymentHash,
          paymentPreimage: payment.paymentPreimage,
          withdrawalId: withdrawal.id,
        })) as WithdrawalActionResult;
      }

      if (payment.status === "FAILED") {
        return (await ctx.runMutation(cashierInternal.failLightningWithdrawal, {
          failureReason: payment.failureReason ?? "Lightning payment failed.",
          paymentHash: payment.paymentHash,
          withdrawalId: withdrawal.id,
        })) as WithdrawalActionResult;
      }

      return (await ctx.runMutation(cashierInternal.markLightningWithdrawalInFlight, {
        paymentHash: payment.paymentHash,
        withdrawalId: withdrawal.id,
      })) as WithdrawalActionResult;
    } catch (error) {
      await ctx.runMutation(cashierInternal.markLightningWithdrawalInFlight, {
        failureReason: errorMessage(error),
        paymentHash: decoded.paymentHash,
        withdrawalId: withdrawal.id,
      });
      throw error;
    }
  },
});

export const syncWithdrawal = action({
  args: {
    sessionToken: v.string(),
    withdrawalId: v.id("withdrawals"),
  },
  handler: async (ctx, { sessionToken, withdrawalId }): Promise<WithdrawalActionResult> => {
    const withdrawal = (await ctx.runQuery(cashierInternal.getLightningWithdrawalForUser, {
      sessionToken,
      withdrawalId,
    })) as WithdrawalActionResult;

    if (withdrawal.status !== "pending") {
      return withdrawal;
    }

    if (!withdrawal.lightningPaymentHash) {
      throw new Error("Withdrawal has no Lightning payment hash.");
    }

    const payment = await lndClient().trackPayment(withdrawal.lightningPaymentHash);

    if (payment.status === "SUCCEEDED") {
      return (await ctx.runMutation(cashierInternal.completeLightningWithdrawal, {
        feePaid: payment.feePaidSats,
        paymentHash: payment.paymentHash,
        paymentPreimage: payment.paymentPreimage,
        withdrawalId,
      })) as WithdrawalActionResult;
    }

    if (payment.status === "FAILED") {
      return (await ctx.runMutation(cashierInternal.failLightningWithdrawal, {
        failureReason: payment.failureReason ?? "Lightning payment failed.",
        paymentHash: payment.paymentHash,
        withdrawalId,
      })) as WithdrawalActionResult;
    }

    return (await ctx.runMutation(cashierInternal.markLightningWithdrawalInFlight, {
      paymentHash: payment.paymentHash,
      withdrawalId,
    })) as WithdrawalActionResult;
  },
});
