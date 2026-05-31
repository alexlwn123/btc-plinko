import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, query } from "./_generated/server";
import {
  type CashierStatus,
  assertCashierAmount,
  assertPendingStatus,
  cashierRequestKey,
} from "./cashierCore";
import { requireActiveUserBySession } from "./users";
import { idempotencyKeyFor } from "./walletCore";
import {
  captureWithdrawalForUser,
  creditDepositForUser,
  getWalletByUser,
  releaseWithdrawalForUser,
  reserveWithdrawalForUser,
  serializeWallet,
  serializeWalletEvent,
} from "./wallets";

const CASHIER_HISTORY_LIMIT = 20;

function serializeDeposit(deposit: Doc<"deposits">) {
  return {
    amount: deposit.amount,
    canceledAt: deposit.canceledAt,
    completedAt: deposit.completedAt,
    createdAt: deposit.createdAt,
    failedAt: deposit.failedAt,
    id: deposit._id,
    status: deposit.status,
    type: "deposit" as const,
    updatedAt: deposit.updatedAt,
  };
}

function serializeWithdrawal(withdrawal: Doc<"withdrawals">) {
  return {
    amount: withdrawal.amount,
    canceledAt: withdrawal.canceledAt,
    completedAt: withdrawal.completedAt,
    createdAt: withdrawal.createdAt,
    failedAt: withdrawal.failedAt,
    id: withdrawal._id,
    status: withdrawal.status,
    type: "withdrawal" as const,
    updatedAt: withdrawal.updatedAt,
  };
}

async function requireUserDeposit(
  ctx: MutationCtx,
  sessionToken: string,
  depositId: Id<"deposits">,
) {
  const user = await requireActiveUserBySession(ctx, sessionToken);
  const deposit = await ctx.db.get(depositId);

  if (!deposit || deposit.userId !== user._id) {
    throw new Error("Deposit was not found.");
  }

  return { deposit, user };
}

async function requireUserWithdrawal(
  ctx: MutationCtx,
  sessionToken: string,
  withdrawalId: Id<"withdrawals">,
) {
  const user = await requireActiveUserBySession(ctx, sessionToken);
  const withdrawal = await ctx.db.get(withdrawalId);

  if (!withdrawal || withdrawal.userId !== user._id) {
    throw new Error("Withdrawal was not found.");
  }

  return { user, withdrawal };
}

async function patchDepositStatus(
  ctx: MutationCtx,
  deposit: Doc<"deposits">,
  status: CashierStatus,
  now: number,
  walletEventId?: Id<"walletEvents">,
) {
  const patch = {
    canceledAt: status === "canceled" ? now : deposit.canceledAt,
    completedAt: status === "completed" ? now : deposit.completedAt,
    failedAt: status === "failed" ? now : deposit.failedAt,
    status,
    updatedAt: now,
  };

  await ctx.db.patch(
    deposit._id,
    walletEventId === undefined ? patch : { ...patch, walletEventId },
  );
}

async function patchWithdrawalStatus(
  ctx: MutationCtx,
  withdrawal: Doc<"withdrawals">,
  status: CashierStatus,
  now: number,
  resultEventId?: Id<"walletEvents">,
) {
  const patch = {
    canceledAt: status === "canceled" ? now : withdrawal.canceledAt,
    completedAt: status === "completed" ? now : withdrawal.completedAt,
    failedAt: status === "failed" ? now : withdrawal.failedAt,
    status,
    updatedAt: now,
  };

  await ctx.db.patch(
    withdrawal._id,
    resultEventId === undefined ? patch : { ...patch, resultEventId },
  );
}

export const getCashier = query({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, { sessionToken }) => {
    const user = await requireActiveUserBySession(ctx, sessionToken);
    const [wallet, deposits, withdrawals, walletEvents] = await Promise.all([
      getWalletByUser(ctx, user._id),
      ctx.db
        .query("deposits")
        .withIndex("by_user_created_at", (q) => q.eq("userId", user._id))
        .order("desc")
        .take(CASHIER_HISTORY_LIMIT),
      ctx.db
        .query("withdrawals")
        .withIndex("by_user_created_at", (q) => q.eq("userId", user._id))
        .order("desc")
        .take(CASHIER_HISTORY_LIMIT),
      ctx.db
        .query("walletEvents")
        .withIndex("by_user_created_at", (q) => q.eq("userId", user._id))
        .order("desc")
        .take(CASHIER_HISTORY_LIMIT),
    ]);

    return {
      deposits: deposits.map(serializeDeposit),
      wallet: serializeWallet(wallet),
      walletEvents: walletEvents.map(serializeWalletEvent),
      withdrawals: withdrawals.map(serializeWithdrawal),
    };
  },
});

export const createFakeDeposit = mutation({
  args: {
    amount: v.number(),
    requestId: v.string(),
    sessionToken: v.string(),
  },
  handler: async (ctx, { amount, requestId, sessionToken }) => {
    assertCashierAmount(amount);

    const user = await requireActiveUserBySession(ctx, sessionToken);
    const now = Date.now();
    const idempotencyKey = cashierRequestKey("deposit", requestId);
    const existing = await ctx.db
      .query("deposits")
      .withIndex("by_user_idempotency", (q) =>
        q.eq("userId", user._id).eq("idempotencyKey", idempotencyKey),
      )
      .unique();

    if (existing) {
      return serializeDeposit(existing);
    }

    const depositId = await ctx.db.insert("deposits", {
      amount,
      createdAt: now,
      idempotencyKey,
      status: "pending",
      updatedAt: now,
      userId: user._id,
    });
    const deposit = await ctx.db.get(depositId);

    if (!deposit) {
      throw new Error("Deposit could not be created.");
    }

    return serializeDeposit(deposit);
  },
});

export const completeFakeDeposit = mutation({
  args: {
    depositId: v.id("deposits"),
    sessionToken: v.string(),
  },
  handler: async (ctx, { depositId, sessionToken }) => {
    const { deposit, user } = await requireUserDeposit(ctx, sessionToken, depositId);
    assertPendingStatus(deposit.status, "Deposit");

    const now = Date.now();
    const result = await creditDepositForUser(ctx, {
      amount: deposit.amount,
      depositId,
      idempotencyKey: idempotencyKeyFor("deposit", depositId, "deposit_credit"),
      userId: user._id,
    });

    await patchDepositStatus(ctx, deposit, "completed", now, result.eventId);
    const updated = await ctx.db.get(depositId);

    if (!updated) {
      throw new Error("Deposit could not be loaded.");
    }

    return serializeDeposit(updated);
  },
});

export const failFakeDeposit = mutation({
  args: {
    depositId: v.id("deposits"),
    sessionToken: v.string(),
  },
  handler: async (ctx, { depositId, sessionToken }) => {
    const { deposit } = await requireUserDeposit(ctx, sessionToken, depositId);
    assertPendingStatus(deposit.status, "Deposit");

    await patchDepositStatus(ctx, deposit, "failed", Date.now());
    const updated = await ctx.db.get(depositId);

    if (!updated) {
      throw new Error("Deposit could not be loaded.");
    }

    return serializeDeposit(updated);
  },
});

export const cancelFakeDeposit = mutation({
  args: {
    depositId: v.id("deposits"),
    sessionToken: v.string(),
  },
  handler: async (ctx, { depositId, sessionToken }) => {
    const { deposit } = await requireUserDeposit(ctx, sessionToken, depositId);
    assertPendingStatus(deposit.status, "Deposit");

    await patchDepositStatus(ctx, deposit, "canceled", Date.now());
    const updated = await ctx.db.get(depositId);

    if (!updated) {
      throw new Error("Deposit could not be loaded.");
    }

    return serializeDeposit(updated);
  },
});

export const createFakeWithdrawal = mutation({
  args: {
    amount: v.number(),
    requestId: v.string(),
    sessionToken: v.string(),
  },
  handler: async (ctx, { amount, requestId, sessionToken }) => {
    assertCashierAmount(amount);

    const user = await requireActiveUserBySession(ctx, sessionToken);
    const now = Date.now();
    const idempotencyKey = cashierRequestKey("withdrawal", requestId);
    const existing = await ctx.db
      .query("withdrawals")
      .withIndex("by_user_idempotency", (q) =>
        q.eq("userId", user._id).eq("idempotencyKey", idempotencyKey),
      )
      .unique();

    if (existing) {
      return serializeWithdrawal(existing);
    }

    const withdrawalId = await ctx.db.insert("withdrawals", {
      amount,
      createdAt: now,
      idempotencyKey,
      status: "pending",
      updatedAt: now,
      userId: user._id,
    });
    const hold = await reserveWithdrawalForUser(ctx, {
      amount,
      idempotencyKey: idempotencyKeyFor("withdrawal", withdrawalId, "withdrawal_hold"),
      userId: user._id,
      withdrawalId,
    });

    await ctx.db.patch(withdrawalId, {
      holdEventId: hold.eventId,
      updatedAt: now,
    });
    const withdrawal = await ctx.db.get(withdrawalId);

    if (!withdrawal) {
      throw new Error("Withdrawal could not be created.");
    }

    return serializeWithdrawal(withdrawal);
  },
});

export const completeFakeWithdrawal = mutation({
  args: {
    sessionToken: v.string(),
    withdrawalId: v.id("withdrawals"),
  },
  handler: async (ctx, { sessionToken, withdrawalId }) => {
    const { user, withdrawal } = await requireUserWithdrawal(ctx, sessionToken, withdrawalId);
    assertPendingStatus(withdrawal.status, "Withdrawal");

    const now = Date.now();
    const result = await captureWithdrawalForUser(ctx, {
      idempotencyKey: idempotencyKeyFor("withdrawal", withdrawalId, "withdrawal_capture"),
      userId: user._id,
      withdrawalId,
    });

    await patchWithdrawalStatus(ctx, withdrawal, "completed", now, result.eventId);
    const updated = await ctx.db.get(withdrawalId);

    if (!updated) {
      throw new Error("Withdrawal could not be loaded.");
    }

    return serializeWithdrawal(updated);
  },
});

export const failFakeWithdrawal = mutation({
  args: {
    sessionToken: v.string(),
    withdrawalId: v.id("withdrawals"),
  },
  handler: async (ctx, { sessionToken, withdrawalId }) => {
    const { user, withdrawal } = await requireUserWithdrawal(ctx, sessionToken, withdrawalId);
    assertPendingStatus(withdrawal.status, "Withdrawal");

    const now = Date.now();
    const result = await releaseWithdrawalForUser(ctx, {
      idempotencyKey: idempotencyKeyFor("withdrawal", withdrawalId, "withdrawal_release"),
      status: "failed",
      userId: user._id,
      withdrawalId,
    });

    await patchWithdrawalStatus(ctx, withdrawal, "failed", now, result.eventId);
    const updated = await ctx.db.get(withdrawalId);

    if (!updated) {
      throw new Error("Withdrawal could not be loaded.");
    }

    return serializeWithdrawal(updated);
  },
});

export const cancelFakeWithdrawal = mutation({
  args: {
    sessionToken: v.string(),
    withdrawalId: v.id("withdrawals"),
  },
  handler: async (ctx, { sessionToken, withdrawalId }) => {
    const { user, withdrawal } = await requireUserWithdrawal(ctx, sessionToken, withdrawalId);
    assertPendingStatus(withdrawal.status, "Withdrawal");

    const now = Date.now();
    const result = await releaseWithdrawalForUser(ctx, {
      idempotencyKey: idempotencyKeyFor("withdrawal", withdrawalId, "withdrawal_release"),
      status: "canceled",
      userId: user._id,
      withdrawalId,
    });

    await patchWithdrawalStatus(ctx, withdrawal, "canceled", now, result.eventId);
    const updated = await ctx.db.get(withdrawalId);

    if (!updated) {
      throw new Error("Withdrawal could not be loaded.");
    }

    return serializeWithdrawal(updated);
  },
});
