import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { requireAdminUserBySession } from "./users";

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_ACTIVITY_LIMIT = 12;

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
    windowMs: DAY_MS,
  };
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
