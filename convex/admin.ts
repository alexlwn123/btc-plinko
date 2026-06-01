import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, query } from "./_generated/server";
import { requireAdminUserBySession } from "./users";
import { assertPositiveWalletAmount, idempotencyKeyFor } from "./walletCore";
import {
  adjustAvailableBalanceForUser,
  getWalletByUser,
  serializeWallet,
  serializeWalletEvent,
} from "./wallets";

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_ACTIVITY_LIMIT = 12;
const SUPPORT_HISTORY_LIMIT = 30;
const STUCK_CASHIER_MS = 15 * 60 * 1000;
const STUCK_SETTLEMENT_MS = 5 * 60 * 1000;

type UserRecord = Pick<Doc<"users">, "_id" | "accountState" | "createdAt" | "lastSeenAt" | "role">;
type WalletRecord = Pick<Doc<"wallets">, "availableBalance" | "heldBalance">;
type CashierRecord = Pick<
  Doc<"deposits"> | Doc<"withdrawals">,
  "_id" | "amount" | "createdAt" | "status" | "userId"
>;
type RoundRecord = Pick<
  Doc<"gameRounds">,
  | "_id"
  | "betAmount"
  | "createdAt"
  | "multiplier"
  | "payoutAmount"
  | "risk"
  | "rows"
  | "status"
  | "userId"
>;

type CashierKind = "deposit" | "withdrawal";
type AccountState = Doc<"users">["accountState"];
type AdjustmentDirection = "credit" | "debit";

function countByStatus<T extends { status: string }>(records: T[]) {
  return records.reduce<Record<string, number>>((counts, record) => {
    counts[record.status] = (counts[record.status] ?? 0) + 1;
    return counts;
  }, {});
}

function sumBy<T>(records: T[], readValue: (record: T) => number) {
  return records.reduce((total, record) => total + readValue(record), 0);
}

function recentSince<T extends { createdAt: number }>(records: T[], now: number) {
  const since = now - DAY_MS;
  return records.filter((record) => record.createdAt >= since);
}

function sortRecent<T extends { createdAt: number }>(records: T[]) {
  return [...records].sort((left, right) => right.createdAt - left.createdAt);
}

function requireReason(reason: string) {
  const trimmed = reason.trim();

  if (trimmed.length < 3) {
    throw new Error("Admin action reason is required.");
  }

  return trimmed;
}

function serializeUser(user: Doc<"users">) {
  return {
    accountState: user.accountState,
    authMethod: user.authMethod ?? "passkey",
    createdAt: user.createdAt,
    id: user._id,
    lastSeenAt: user.lastSeenAt,
    publicId: user.publicId ?? "anonymous",
    role: user.role ?? "player",
  };
}

function serializeDeposit(deposit: Doc<"deposits">) {
  return {
    amount: deposit.amount,
    canceledAt: deposit.canceledAt,
    completedAt: deposit.completedAt,
    createdAt: deposit.createdAt,
    failedAt: deposit.failedAt,
    id: deposit._id,
    lightningPaymentHash: deposit.lightningPaymentHash,
    lightningState: deposit.lightningState,
    provider: deposit.provider,
    providerError: deposit.providerError,
    status: deposit.status,
    updatedAt: deposit.updatedAt,
    userId: deposit.userId,
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
    lightningPaymentHash: withdrawal.lightningPaymentHash,
    lightningState: withdrawal.lightningState,
    provider: withdrawal.provider,
    providerError: withdrawal.providerError,
    status: withdrawal.status,
    updatedAt: withdrawal.updatedAt,
    userId: withdrawal.userId,
  };
}

function serializeRound(round: Doc<"gameRounds">) {
  return {
    betAmount: round.betAmount,
    completedAt: round.completedAt,
    createdAt: round.createdAt,
    id: round._id,
    multiplier: round.multiplier,
    nonce: round.nonce,
    payoutAmount: round.payoutAmount,
    risk: round.risk,
    rows: round.rows,
    serverSeedHash: round.serverSeedHash,
    slot: round.slot,
    status: round.status,
    updatedAt: round.updatedAt,
    userId: round.userId,
  };
}

function serializeAdminAction(action: Doc<"adminActions">) {
  return {
    action: action.action,
    adminUserId: action.adminUserId,
    amount: action.amount,
    createdAt: action.createdAt,
    direction: action.direction,
    id: action._id,
    reason: action.reason,
    targetId: action.targetId,
    targetType: action.targetType,
    targetUserId: action.targetUserId,
  };
}

function summarizeCashier(records: CashierRecord[]) {
  const statusCounts = countByStatus(records);

  return {
    canceledAmount: sumBy(
      records.filter((record) => record.status === "canceled"),
      (record) => record.amount,
    ),
    canceledCount: statusCounts.canceled ?? 0,
    completedAmount: sumBy(
      records.filter((record) => record.status === "completed"),
      (record) => record.amount,
    ),
    completedCount: statusCounts.completed ?? 0,
    failedAmount: sumBy(
      records.filter((record) => record.status === "failed"),
      (record) => record.amount,
    ),
    failedCount: statusCounts.failed ?? 0,
    pendingAmount: sumBy(
      records.filter((record) => record.status === "pending"),
      (record) => record.amount,
    ),
    pendingCount: statusCounts.pending ?? 0,
    totalAmount: sumBy(records, (record) => record.amount),
    totalCount: records.length,
  };
}

function summarizeRounds(rounds: RoundRecord[]) {
  const statusCounts = countByStatus(rounds);
  const completedRounds = rounds.filter((round) => round.status === "completed");
  const wageredAmount = sumBy(completedRounds, (round) => round.betAmount);
  const payoutAmount = sumBy(completedRounds, (round) => round.payoutAmount);
  const netRevenueAmount = wageredAmount - payoutAmount;

  return {
    completedCount: statusCounts.completed ?? 0,
    failedCount: statusCounts.failed ?? 0,
    holdPercent: wageredAmount > 0 ? (netRevenueAmount / wageredAmount) * 100 : 0,
    netRevenueAmount,
    payoutAmount,
    settlingCount: statusCounts.settling ?? 0,
    totalCount: rounds.length,
    wageredAmount,
  };
}

export function summarizeSiteMetrics({
  deposits,
  now = Date.now(),
  rounds,
  users,
  wallets,
  withdrawals,
}: {
  deposits: CashierRecord[];
  now?: number;
  rounds: RoundRecord[];
  users: UserRecord[];
  wallets: WalletRecord[];
  withdrawals: CashierRecord[];
}) {
  const recentDeposits = recentSince(deposits, now);
  const recentWithdrawals = recentSince(withdrawals, now);
  const recentRounds = recentSince(rounds, now);
  const activeSince = now - DAY_MS;
  const cashierActivity = [
    ...deposits.map((entry) => ({ ...entry, type: "deposit" as CashierKind })),
    ...withdrawals.map((entry) => ({ ...entry, type: "withdrawal" as CashierKind })),
  ];

  return {
    deposits: {
      last24h: summarizeCashier(recentDeposits),
      lifetime: summarizeCashier(deposits),
    },
    generatedAt: now,
    recentCashier: sortRecent(cashierActivity)
      .slice(0, RECENT_ACTIVITY_LIMIT)
      .map((entry) => ({
        amount: entry.amount,
        createdAt: entry.createdAt,
        id: entry._id,
        status: entry.status,
        type: entry.type,
        userId: entry.userId,
      })),
    recentRounds: sortRecent(rounds)
      .slice(0, RECENT_ACTIVITY_LIMIT)
      .map((round) => ({
        betAmount: round.betAmount,
        createdAt: round.createdAt,
        id: round._id,
        multiplier: round.multiplier,
        payoutAmount: round.payoutAmount,
        risk: round.risk,
        rows: round.rows,
        status: round.status,
        userId: round.userId,
      })),
    rounds: {
      last24h: summarizeRounds(recentRounds),
      lifetime: summarizeRounds(rounds),
    },
    users: {
      active24h: users.filter((user) => user.lastSeenAt >= activeSince).length,
      activeCount: users.filter((user) => user.accountState === "active").length,
      adminCount: users.filter((user) => user.role === "admin").length,
      disabledCount: users.filter((user) => user.accountState === "disabled").length,
      lockedCount: users.filter((user) => user.accountState === "locked").length,
      pendingReviewCount: users.filter((user) => user.accountState === "pending_review").length,
      totalCount: users.length,
    },
    wallets: {
      availableBalance: sumBy(wallets, (wallet) => wallet.availableBalance),
      heldBalance: sumBy(wallets, (wallet) => wallet.heldBalance),
      totalBalance: sumBy(wallets, (wallet) => wallet.availableBalance + wallet.heldBalance),
      totalCount: wallets.length,
    },
    withdrawals: {
      last24h: summarizeCashier(recentWithdrawals),
      lifetime: summarizeCashier(withdrawals),
    },
    workQueue: summarizeAdminWorkQueue({ deposits, now, rounds, withdrawals }),
    windowMs: DAY_MS,
  };
}

export function summarizeAdminWorkQueue({
  deposits,
  now = Date.now(),
  rounds,
  withdrawals,
}: {
  deposits: CashierRecord[];
  now?: number;
  rounds: RoundRecord[];
  withdrawals: CashierRecord[];
}) {
  const stuckCashierBefore = now - STUCK_CASHIER_MS;
  const stuckSettlementBefore = now - STUCK_SETTLEMENT_MS;

  return {
    failedRounds: sortRecent(rounds.filter((round) => round.status === "failed")).slice(
      0,
      RECENT_ACTIVITY_LIMIT,
    ),
    settlingRounds: sortRecent(
      rounds.filter(
        (round) => round.status === "settling" && round.createdAt <= stuckSettlementBefore,
      ),
    ).slice(0, RECENT_ACTIVITY_LIMIT),
    stuckDeposits: sortRecent(
      deposits.filter(
        (deposit) => deposit.status === "pending" && deposit.createdAt <= stuckCashierBefore,
      ),
    ).slice(0, RECENT_ACTIVITY_LIMIT),
    stuckWithdrawals: sortRecent(
      withdrawals.filter(
        (withdrawal) =>
          withdrawal.status === "pending" && withdrawal.createdAt <= stuckCashierBefore,
      ),
    ).slice(0, RECENT_ACTIVITY_LIMIT),
  };
}

async function logAdminAction(
  ctx: MutationCtx,
  action: {
    action: Doc<"adminActions">["action"];
    adminUserId: Id<"users">;
    amount?: number;
    direction?: AdjustmentDirection;
    reason: string;
    targetId: string;
    targetType: Doc<"adminActions">["targetType"];
    targetUserId?: Id<"users">;
  },
) {
  await ctx.db.insert("adminActions", {
    ...action,
    createdAt: Date.now(),
  });
}

export async function setUserAccountStateForAdmin(
  ctx: MutationCtx,
  {
    adminUserId,
    reason,
    state,
    targetUserId,
  }: {
    adminUserId: Id<"users">;
    reason: string;
    state: AccountState;
    targetUserId: Id<"users">;
  },
) {
  if (adminUserId === targetUserId) {
    throw new Error("Admins cannot change their own account state.");
  }

  const targetUser = await ctx.db.get(targetUserId);

  if (!targetUser) {
    throw new Error("User was not found.");
  }

  await ctx.db.patch(targetUserId, {
    accountState: state,
  });
  await logAdminAction(ctx, {
    action: "account_state_change",
    adminUserId,
    reason: requireReason(reason),
    targetId: targetUserId,
    targetType: "user",
    targetUserId,
  });

  const updated = await ctx.db.get(targetUserId);

  if (!updated) {
    throw new Error("User could not be reloaded.");
  }

  return serializeUser(updated);
}

export async function manualBalanceAdjustmentForAdmin(
  ctx: MutationCtx,
  {
    adminUserId,
    amount,
    direction,
    reason,
    requestId,
    targetUserId,
  }: {
    adminUserId: Id<"users">;
    amount: number;
    direction: AdjustmentDirection;
    reason: string;
    requestId: string;
    targetUserId: Id<"users">;
  },
) {
  const targetUser = await ctx.db.get(targetUserId);

  if (!targetUser) {
    throw new Error("User was not found.");
  }

  assertPositiveWalletAmount(amount);

  const adjustmentId = `admin-adjustment:${requestId}`;
  const result = await adjustAvailableBalanceForUser(ctx, {
    adjustmentId,
    amount,
    direction,
    idempotencyKey: idempotencyKeyFor("manual_adjustment", adjustmentId, "manual_adjustment"),
    userId: targetUserId,
  });

  await logAdminAction(ctx, {
    action: "manual_balance_adjustment",
    adminUserId,
    amount,
    direction,
    reason: requireReason(reason),
    targetId: result.eventId,
    targetType: "wallet",
    targetUserId,
  });

  return result;
}

export const getSiteMetrics = query({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, { sessionToken }) => {
    await requireAdminUserBySession(ctx, sessionToken);

    const [users, wallets, deposits, withdrawals, rounds] = await Promise.all([
      ctx.db.query("users").collect(),
      ctx.db.query("wallets").collect(),
      ctx.db.query("deposits").collect(),
      ctx.db.query("withdrawals").collect(),
      ctx.db.query("gameRounds").collect(),
    ]);

    return summarizeSiteMetrics({
      deposits,
      rounds,
      users,
      wallets,
      withdrawals,
    });
  },
});

export const getSupportLookup = query({
  args: {
    depositId: v.optional(v.id("deposits")),
    publicId: v.optional(v.string()),
    roundId: v.optional(v.id("gameRounds")),
    sessionToken: v.string(),
    userId: v.optional(v.id("users")),
    withdrawalId: v.optional(v.id("withdrawals")),
  },
  handler: async (ctx, { depositId, publicId, roundId, sessionToken, userId, withdrawalId }) => {
    await requireAdminUserBySession(ctx, sessionToken);

    const selectedDeposit = depositId ? await ctx.db.get(depositId) : null;
    const selectedWithdrawal = withdrawalId ? await ctx.db.get(withdrawalId) : null;
    const selectedRound = roundId ? await ctx.db.get(roundId) : null;
    const selectedRecordUserId =
      selectedDeposit?.userId ?? selectedWithdrawal?.userId ?? selectedRound?.userId;
    const resolvedUser =
      (userId ? await ctx.db.get(userId) : null) ??
      (selectedRecordUserId ? await ctx.db.get(selectedRecordUserId) : null) ??
      (publicId
        ? await ctx.db
            .query("users")
            .withIndex("by_public_id", (q) => q.eq("publicId", publicId))
            .unique()
        : null);

    if (!resolvedUser) {
      return {
        adminActions: [],
        deposits: [],
        found: false,
        rounds: [],
        selectedDeposit: selectedDeposit ? serializeDeposit(selectedDeposit) : null,
        selectedRound: selectedRound ? serializeRound(selectedRound) : null,
        selectedWithdrawal: selectedWithdrawal ? serializeWithdrawal(selectedWithdrawal) : null,
        user: null,
        wallet: serializeWallet(null),
        walletEvents: [],
        withdrawals: [],
      };
    }

    const [wallet, walletEvents, deposits, withdrawals, rounds, adminActions] = await Promise.all([
      getWalletByUser(ctx, resolvedUser._id),
      ctx.db
        .query("walletEvents")
        .withIndex("by_user_created_at", (q) => q.eq("userId", resolvedUser._id))
        .order("desc")
        .take(SUPPORT_HISTORY_LIMIT),
      ctx.db
        .query("deposits")
        .withIndex("by_user_created_at", (q) => q.eq("userId", resolvedUser._id))
        .order("desc")
        .take(SUPPORT_HISTORY_LIMIT),
      ctx.db
        .query("withdrawals")
        .withIndex("by_user_created_at", (q) => q.eq("userId", resolvedUser._id))
        .order("desc")
        .take(SUPPORT_HISTORY_LIMIT),
      ctx.db
        .query("gameRounds")
        .withIndex("by_user_created_at", (q) => q.eq("userId", resolvedUser._id))
        .order("desc")
        .take(SUPPORT_HISTORY_LIMIT),
      ctx.db
        .query("adminActions")
        .withIndex("by_target_user_created_at", (q) => q.eq("targetUserId", resolvedUser._id))
        .order("desc")
        .take(SUPPORT_HISTORY_LIMIT),
    ]);

    return {
      adminActions: adminActions.map(serializeAdminAction),
      deposits: deposits.map(serializeDeposit),
      found: true,
      rounds: rounds.map(serializeRound),
      selectedDeposit: selectedDeposit ? serializeDeposit(selectedDeposit) : null,
      selectedRound: selectedRound ? serializeRound(selectedRound) : null,
      selectedWithdrawal: selectedWithdrawal ? serializeWithdrawal(selectedWithdrawal) : null,
      user: serializeUser(resolvedUser),
      wallet: serializeWallet(wallet),
      walletEvents: walletEvents.map(serializeWalletEvent),
      withdrawals: withdrawals.map(serializeWithdrawal),
    };
  },
});

export const setUserAccountState = mutation({
  args: {
    reason: v.string(),
    sessionToken: v.string(),
    state: v.union(
      v.literal("active"),
      v.literal("locked"),
      v.literal("pending_review"),
      v.literal("disabled"),
    ),
    userId: v.id("users"),
  },
  handler: async (ctx, { reason, sessionToken, state, userId }) => {
    const admin = await requireAdminUserBySession(ctx, sessionToken);

    return await setUserAccountStateForAdmin(ctx, {
      adminUserId: admin._id,
      reason,
      state,
      targetUserId: userId,
    });
  },
});

export const manualBalanceAdjustment = mutation({
  args: {
    amount: v.number(),
    direction: v.union(v.literal("credit"), v.literal("debit")),
    reason: v.string(),
    requestId: v.string(),
    sessionToken: v.string(),
    userId: v.id("users"),
  },
  handler: async (ctx, { amount, direction, reason, requestId, sessionToken, userId }) => {
    const admin = await requireAdminUserBySession(ctx, sessionToken);

    return await manualBalanceAdjustmentForAdmin(ctx, {
      adminUserId: admin._id,
      amount,
      direction,
      reason,
      requestId,
      targetUserId: userId,
    });
  },
});
