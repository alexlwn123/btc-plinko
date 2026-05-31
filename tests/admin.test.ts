import { describe, expect, it } from "vitest";
import { summarizeSiteMetrics } from "../convex/admin";

type MetricsInput = Parameters<typeof summarizeSiteMetrics>[0];
type UserInput = MetricsInput["users"][number];
type WalletInput = MetricsInput["wallets"][number];
type CashierInput = MetricsInput["deposits"][number];
type RoundInput = MetricsInput["rounds"][number];

const now = Date.UTC(2026, 4, 31, 12, 0, 0);
const recent = now - 60 * 60 * 1000;
const old = now - 48 * 60 * 60 * 1000;

function user(id: string, overrides: Partial<UserInput> = {}): UserInput {
  return {
    _id: id,
    accountState: "active",
    createdAt: old,
    lastSeenAt: recent,
    role: "player",
    ...overrides,
  } as UserInput;
}

function wallet(overrides: Partial<WalletInput> = {}): WalletInput {
  return {
    availableBalance: 0,
    heldBalance: 0,
    ...overrides,
  };
}

function cashier(id: string, overrides: Partial<CashierInput> = {}): CashierInput {
  return {
    _id: id,
    amount: 0,
    createdAt: recent,
    status: "pending",
    userId: "users:test-user",
    ...overrides,
  } as CashierInput;
}

function round(id: string, overrides: Partial<RoundInput> = {}): RoundInput {
  return {
    _id: id,
    betAmount: 0,
    createdAt: recent,
    multiplier: 0,
    payoutAmount: 0,
    risk: "medium",
    rows: 12,
    status: "completed",
    userId: "users:test-user",
    ...overrides,
  } as RoundInput;
}

describe("summarizeSiteMetrics", () => {
  it("aggregates lifetime and last-24h site numbers", () => {
    const metrics = summarizeSiteMetrics({
      deposits: [
        cashier("deposits:1", { amount: 500, status: "completed" }),
        cashier("deposits:2", { amount: 200, status: "pending" }),
        cashier("deposits:3", { amount: 300, createdAt: old, status: "completed" }),
      ],
      now,
      rounds: [
        round("gameRounds:1", { betAmount: 100, payoutAmount: 50 }),
        round("gameRounds:2", { betAmount: 200, payoutAmount: 500 }),
        round("gameRounds:3", { betAmount: 75, createdAt: old, payoutAmount: 0 }),
        round("gameRounds:4", { betAmount: 25, payoutAmount: 0, status: "settling" }),
      ],
      users: [
        user("users:1", { role: "admin" }),
        user("users:2", { accountState: "locked", lastSeenAt: old }),
        user("users:3", { accountState: "pending_review" }),
      ],
      wallets: [
        wallet({ availableBalance: 1000, heldBalance: 50 }),
        wallet({ availableBalance: 700, heldBalance: 0 }),
      ],
      withdrawals: [
        cashier("withdrawals:1", { amount: 125, status: "pending" }),
        cashier("withdrawals:2", { amount: 300, createdAt: old, status: "completed" }),
      ],
    });

    expect(metrics.users).toMatchObject({
      active24h: 2,
      adminCount: 1,
      lockedCount: 1,
      pendingReviewCount: 1,
      totalCount: 3,
    });
    expect(metrics.wallets).toMatchObject({
      availableBalance: 1700,
      heldBalance: 50,
      totalBalance: 1750,
      totalCount: 2,
    });
    expect(metrics.deposits.lifetime).toMatchObject({
      completedAmount: 800,
      completedCount: 2,
      pendingAmount: 200,
      pendingCount: 1,
      totalAmount: 1000,
      totalCount: 3,
    });
    expect(metrics.deposits.last24h).toMatchObject({
      completedAmount: 500,
      pendingAmount: 200,
      totalAmount: 700,
      totalCount: 2,
    });
    expect(metrics.withdrawals.lifetime).toMatchObject({
      completedAmount: 300,
      pendingAmount: 125,
      totalAmount: 425,
    });
    expect(metrics.rounds.lifetime).toMatchObject({
      completedCount: 3,
      netRevenueAmount: -175,
      payoutAmount: 550,
      settlingCount: 1,
      totalCount: 4,
      wageredAmount: 375,
    });
    expect(metrics.rounds.last24h).toMatchObject({
      netRevenueAmount: -250,
      payoutAmount: 550,
      settlingCount: 1,
      totalCount: 3,
      wageredAmount: 300,
    });
    expect(metrics.rounds.last24h.holdPercent).toBeCloseTo(-83.333, 3);
  });

  it("limits recent activity to newest records", () => {
    const metrics = summarizeSiteMetrics({
      deposits: Array.from({ length: 14 }, (_, index) =>
        cashier(`deposits:${index}`, {
          amount: index,
          createdAt: now - index,
          status: "completed",
        }),
      ),
      now,
      rounds: Array.from({ length: 14 }, (_, index) =>
        round(`gameRounds:${index}`, {
          betAmount: index,
          createdAt: now - index,
          payoutAmount: index * 2,
        }),
      ),
      users: [],
      wallets: [],
      withdrawals: [],
    });

    expect(metrics.recentCashier).toHaveLength(12);
    expect(metrics.recentCashier[0]?.id).toBe("deposits:0");
    expect(metrics.recentCashier[11]?.id).toBe("deposits:11");
    expect(metrics.recentRounds).toHaveLength(12);
    expect(metrics.recentRounds[0]?.id).toBe("gameRounds:0");
    expect(metrics.recentRounds[11]?.id).toBe("gameRounds:11");
  });
});
