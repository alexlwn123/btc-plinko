import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  type MutationCtx,
  type QueryCtx,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
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
    lightningExpiresAt: deposit.lightningExpiresAt,
    lightningPaymentHash: deposit.lightningPaymentHash,
    lightningPaymentRequest: deposit.lightningPaymentRequest,
    lightningState: deposit.lightningState,
    id: deposit._id,
    provider: deposit.provider,
    providerError: deposit.providerError,
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
    lightningFeePaid: withdrawal.lightningFeePaid,
    lightningPaymentHash: withdrawal.lightningPaymentHash,
    lightningPaymentPreimage: withdrawal.lightningPaymentPreimage,
    lightningPaymentRequest: withdrawal.lightningPaymentRequest,
    lightningState: withdrawal.lightningState,
    provider: withdrawal.provider,
    providerError: withdrawal.providerError,
    status: withdrawal.status,
    type: "withdrawal" as const,
    updatedAt: withdrawal.updatedAt,
  };
}

async function requireUserDeposit(
  ctx: QueryCtx | MutationCtx,
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
  ctx: QueryCtx | MutationCtx,
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

async function getDeposit(ctx: QueryCtx | MutationCtx, depositId: Id<"deposits">) {
  const deposit = await ctx.db.get(depositId);

  if (!deposit) {
    throw new Error("Deposit was not found.");
  }

  return deposit;
}

async function getWithdrawal(ctx: QueryCtx | MutationCtx, withdrawalId: Id<"withdrawals">) {
  const withdrawal = await ctx.db.get(withdrawalId);

  if (!withdrawal) {
    throw new Error("Withdrawal was not found.");
  }

  return withdrawal;
}

function assertPaymentHashMatches(existing: string | undefined, next: string, label: string) {
  if (existing && existing !== next) {
    throw new Error(`${label} payment hash does not match.`);
  }
}

export async function createLightningDepositRecordForUser(
  ctx: MutationCtx,
  {
    amount,
    requestId,
    userId,
  }: {
    amount: number;
    requestId: string;
    userId: Id<"users">;
  },
) {
  assertCashierAmount(amount);

  const now = Date.now();
  const idempotencyKey = cashierRequestKey("deposit", requestId);
  const existing = await ctx.db
    .query("deposits")
    .withIndex("by_user_idempotency", (q) =>
      q.eq("userId", userId).eq("idempotencyKey", idempotencyKey),
    )
    .unique();

  if (existing) {
    return serializeDeposit(existing);
  }

  const depositId = await ctx.db.insert("deposits", {
    amount,
    createdAt: now,
    idempotencyKey,
    provider: "lnd",
    status: "pending",
    updatedAt: now,
    userId,
  });
  const deposit = await getDeposit(ctx, depositId);

  return serializeDeposit(deposit);
}

export async function attachLightningDepositInvoiceForUser(
  ctx: MutationCtx,
  {
    depositId,
    expiresAt,
    paymentHash,
    paymentRequest,
  }: {
    depositId: Id<"deposits">;
    expiresAt: number;
    paymentHash: string;
    paymentRequest: string;
  },
) {
  const deposit = await getDeposit(ctx, depositId);

  if (deposit.lightningPaymentRequest) {
    assertPaymentHashMatches(deposit.lightningPaymentHash, paymentHash, "Deposit");
    return serializeDeposit(deposit);
  }

  assertPendingStatus(deposit.status, "Deposit");

  await ctx.db.patch(depositId, {
    lightningExpiresAt: expiresAt,
    lightningPaymentHash: paymentHash,
    lightningPaymentRequest: paymentRequest,
    lightningState: "invoice_created",
    providerError: undefined,
    updatedAt: Date.now(),
  });

  return serializeDeposit(await getDeposit(ctx, depositId));
}

export async function settleLightningDepositForUser(
  ctx: MutationCtx,
  {
    depositId,
    paymentHash,
    settledAmount,
    settledAt = Date.now(),
  }: {
    depositId: Id<"deposits">;
    paymentHash: string;
    settledAmount?: number;
    settledAt?: number;
  },
) {
  const deposit = await getDeposit(ctx, depositId);

  if (deposit.status === "completed") {
    assertPaymentHashMatches(deposit.lightningPaymentHash, paymentHash, "Deposit");
    return serializeDeposit(deposit);
  }

  assertPendingStatus(deposit.status, "Deposit");
  assertPaymentHashMatches(deposit.lightningPaymentHash, paymentHash, "Deposit");

  if (settledAmount !== undefined && settledAmount < deposit.amount) {
    throw new Error("Lightning deposit paid less than requested.");
  }

  const amountToCredit = settledAmount ?? deposit.amount;
  const result = await creditDepositForUser(ctx, {
    amount: amountToCredit,
    depositId,
    idempotencyKey: idempotencyKeyFor("deposit", depositId, "deposit_credit"),
    userId: deposit.userId,
  });

  await patchDepositStatus(ctx, deposit, "completed", settledAt, result.eventId);
  await ctx.db.patch(depositId, {
    amount: amountToCredit,
    lightningState: "settled",
    providerError: undefined,
    updatedAt: settledAt,
  });

  return serializeDeposit(await getDeposit(ctx, depositId));
}

export async function failLightningDepositForUser(
  ctx: MutationCtx,
  {
    depositId,
    failureReason,
    lightningState = "failed",
  }: {
    depositId: Id<"deposits">;
    failureReason: string;
    lightningState?: "canceled" | "expired" | "failed";
  },
) {
  const deposit = await getDeposit(ctx, depositId);

  if (deposit.status === "completed") {
    return serializeDeposit(deposit);
  }

  if (deposit.status !== "pending") {
    return serializeDeposit(deposit);
  }

  const now = Date.now();
  await patchDepositStatus(ctx, deposit, "failed", now);
  await ctx.db.patch(depositId, {
    lightningState,
    providerError: failureReason,
    updatedAt: now,
  });

  return serializeDeposit(await getDeposit(ctx, depositId));
}

export async function createLightningWithdrawalRecordForUser(
  ctx: MutationCtx,
  {
    amount,
    paymentHash,
    paymentRequest,
    requestId,
    userId,
  }: {
    amount: number;
    paymentHash: string;
    paymentRequest: string;
    requestId: string;
    userId: Id<"users">;
  },
) {
  assertCashierAmount(amount);

  const now = Date.now();
  const idempotencyKey = cashierRequestKey("withdrawal", requestId);
  const existing = await ctx.db
    .query("withdrawals")
    .withIndex("by_user_idempotency", (q) =>
      q.eq("userId", userId).eq("idempotencyKey", idempotencyKey),
    )
    .unique();

  if (existing) {
    assertPaymentHashMatches(existing.lightningPaymentHash, paymentHash, "Withdrawal");
    return serializeWithdrawal(existing);
  }

  const withdrawalId = await ctx.db.insert("withdrawals", {
    amount,
    createdAt: now,
    idempotencyKey,
    lightningPaymentHash: paymentHash,
    lightningPaymentRequest: paymentRequest,
    lightningState: "payment_created",
    provider: "lnd",
    status: "pending",
    updatedAt: now,
    userId,
  });
  const hold = await reserveWithdrawalForUser(ctx, {
    amount,
    idempotencyKey: idempotencyKeyFor("withdrawal", withdrawalId, "withdrawal_hold"),
    userId,
    withdrawalId,
  });

  await ctx.db.patch(withdrawalId, {
    holdEventId: hold.eventId,
    updatedAt: now,
  });

  return serializeWithdrawal(await getWithdrawal(ctx, withdrawalId));
}

export async function markLightningWithdrawalInFlightForUser(
  ctx: MutationCtx,
  {
    failureReason,
    paymentHash,
    withdrawalId,
  }: {
    failureReason?: string;
    paymentHash: string;
    withdrawalId: Id<"withdrawals">;
  },
) {
  const withdrawal = await getWithdrawal(ctx, withdrawalId);
  assertPaymentHashMatches(withdrawal.lightningPaymentHash, paymentHash, "Withdrawal");

  if (withdrawal.status !== "pending") {
    return serializeWithdrawal(withdrawal);
  }

  await ctx.db.patch(withdrawalId, {
    lightningState: "in_flight",
    providerError: failureReason,
    updatedAt: Date.now(),
  });

  return serializeWithdrawal(await getWithdrawal(ctx, withdrawalId));
}

export async function completeLightningWithdrawalForUser(
  ctx: MutationCtx,
  {
    feePaid,
    paymentHash,
    paymentPreimage,
    withdrawalId,
  }: {
    feePaid?: number;
    paymentHash: string;
    paymentPreimage?: string;
    withdrawalId: Id<"withdrawals">;
  },
) {
  const withdrawal = await getWithdrawal(ctx, withdrawalId);

  if (withdrawal.status === "completed") {
    assertPaymentHashMatches(withdrawal.lightningPaymentHash, paymentHash, "Withdrawal");
    return serializeWithdrawal(withdrawal);
  }

  assertPendingStatus(withdrawal.status, "Withdrawal");
  assertPaymentHashMatches(withdrawal.lightningPaymentHash, paymentHash, "Withdrawal");

  const now = Date.now();
  const result = await captureWithdrawalForUser(ctx, {
    idempotencyKey: idempotencyKeyFor("withdrawal", withdrawalId, "withdrawal_capture"),
    userId: withdrawal.userId,
    withdrawalId,
  });

  await patchWithdrawalStatus(ctx, withdrawal, "completed", now, result.eventId);
  await ctx.db.patch(withdrawalId, {
    lightningFeePaid: feePaid,
    lightningPaymentPreimage: paymentPreimage,
    lightningState: "succeeded",
    providerError: undefined,
    updatedAt: now,
  });

  return serializeWithdrawal(await getWithdrawal(ctx, withdrawalId));
}

export async function failLightningWithdrawalForUser(
  ctx: MutationCtx,
  {
    failureReason,
    paymentHash,
    withdrawalId,
  }: {
    failureReason: string;
    paymentHash: string;
    withdrawalId: Id<"withdrawals">;
  },
) {
  const withdrawal = await getWithdrawal(ctx, withdrawalId);

  if (withdrawal.status === "failed") {
    return serializeWithdrawal(withdrawal);
  }

  if (withdrawal.status !== "pending") {
    return serializeWithdrawal(withdrawal);
  }

  assertPaymentHashMatches(withdrawal.lightningPaymentHash, paymentHash, "Withdrawal");

  const now = Date.now();
  const result = await releaseWithdrawalForUser(ctx, {
    idempotencyKey: idempotencyKeyFor("withdrawal", withdrawalId, "withdrawal_release"),
    status: "failed",
    userId: withdrawal.userId,
    withdrawalId,
  });

  await patchWithdrawalStatus(ctx, withdrawal, "failed", now, result.eventId);
  await ctx.db.patch(withdrawalId, {
    lightningState: "failed",
    providerError: failureReason,
    updatedAt: now,
  });

  return serializeWithdrawal(await getWithdrawal(ctx, withdrawalId));
}

export const requireCashierSession = internalQuery({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, { sessionToken }) => {
    const user = await requireActiveUserBySession(ctx, sessionToken);

    return {
      userId: user._id,
    };
  },
});

export const getLightningDepositForUser = internalQuery({
  args: {
    depositId: v.id("deposits"),
    sessionToken: v.string(),
  },
  handler: async (ctx, { depositId, sessionToken }) => {
    const { deposit } = await requireUserDeposit(ctx, sessionToken, depositId);
    return serializeDeposit(deposit);
  },
});

export const getLightningWithdrawalForUser = internalQuery({
  args: {
    sessionToken: v.string(),
    withdrawalId: v.id("withdrawals"),
  },
  handler: async (ctx, { sessionToken, withdrawalId }) => {
    const { withdrawal } = await requireUserWithdrawal(ctx, sessionToken, withdrawalId);
    return serializeWithdrawal(withdrawal);
  },
});

export const createLightningDepositRecord = internalMutation({
  args: {
    amount: v.number(),
    requestId: v.string(),
    sessionToken: v.string(),
  },
  handler: async (ctx, { amount, requestId, sessionToken }) => {
    const user = await requireActiveUserBySession(ctx, sessionToken);

    return await createLightningDepositRecordForUser(ctx, {
      amount,
      requestId,
      userId: user._id,
    });
  },
});

export const attachLightningDepositInvoice = internalMutation({
  args: {
    depositId: v.id("deposits"),
    expiresAt: v.number(),
    paymentHash: v.string(),
    paymentRequest: v.string(),
  },
  handler: async (ctx, args) => {
    return await attachLightningDepositInvoiceForUser(ctx, args);
  },
});

export const settleLightningDeposit = internalMutation({
  args: {
    depositId: v.id("deposits"),
    paymentHash: v.string(),
    settledAmount: v.optional(v.number()),
    settledAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await settleLightningDepositForUser(ctx, args);
  },
});

export const failLightningDeposit = internalMutation({
  args: {
    depositId: v.id("deposits"),
    failureReason: v.string(),
    lightningState: v.optional(
      v.union(v.literal("canceled"), v.literal("expired"), v.literal("failed")),
    ),
  },
  handler: async (ctx, args) => {
    return await failLightningDepositForUser(ctx, args);
  },
});

export const createLightningWithdrawalRecord = internalMutation({
  args: {
    amount: v.number(),
    paymentHash: v.string(),
    paymentRequest: v.string(),
    requestId: v.string(),
    sessionToken: v.string(),
  },
  handler: async (ctx, { amount, paymentHash, paymentRequest, requestId, sessionToken }) => {
    const user = await requireActiveUserBySession(ctx, sessionToken);

    return await createLightningWithdrawalRecordForUser(ctx, {
      amount,
      paymentHash,
      paymentRequest,
      requestId,
      userId: user._id,
    });
  },
});

export const markLightningWithdrawalInFlight = internalMutation({
  args: {
    failureReason: v.optional(v.string()),
    paymentHash: v.string(),
    withdrawalId: v.id("withdrawals"),
  },
  handler: async (ctx, args) => {
    return await markLightningWithdrawalInFlightForUser(ctx, args);
  },
});

export const completeLightningWithdrawal = internalMutation({
  args: {
    feePaid: v.optional(v.number()),
    paymentHash: v.string(),
    paymentPreimage: v.optional(v.string()),
    withdrawalId: v.id("withdrawals"),
  },
  handler: async (ctx, args) => {
    return await completeLightningWithdrawalForUser(ctx, args);
  },
});

export const failLightningWithdrawal = internalMutation({
  args: {
    failureReason: v.string(),
    paymentHash: v.string(),
    withdrawalId: v.id("withdrawals"),
  },
  handler: async (ctx, args) => {
    return await failLightningWithdrawalForUser(ctx, args);
  },
});

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
