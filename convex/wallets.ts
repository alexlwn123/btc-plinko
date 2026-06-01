import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  type MutationCtx,
  type QueryCtx,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import { requireActiveUserBySession } from "./users";
import {
  INITIAL_PLAYABLE_BALANCE_SATS,
  applyWalletDelta,
  assertPositiveWalletAmount,
  idempotencyKeyFor,
} from "./walletCore";

const WALLET_EVENT_LIMIT = 30;

type WalletEventKind = Doc<"walletEvents">["kind"];
type WalletSourceType = Doc<"walletEvents">["sourceType"];
type WalletStatus = Doc<"walletEvents">["status"];
type WalletDoc = Doc<"wallets">;

export function serializeWallet(wallet: WalletDoc | null) {
  return {
    availableBalance: wallet?.availableBalance ?? 0,
    heldBalance: wallet?.heldBalance ?? 0,
    totalBalance: (wallet?.availableBalance ?? 0) + (wallet?.heldBalance ?? 0),
    unit: "sats" as const,
  };
}

export function serializeWalletEvent(event: Doc<"walletEvents">) {
  return {
    amount: event.amount,
    availableBalanceAfter: event.availableBalanceAfter,
    availableDelta: event.availableDelta,
    createdAt: event.createdAt,
    heldBalanceAfter: event.heldBalanceAfter,
    heldDelta: event.heldDelta,
    id: event._id,
    kind: event.kind,
    sourceId: event.sourceId,
    sourceType: event.sourceType,
    status: event.status,
  };
}

export async function getWalletByUser(ctx: QueryCtx | MutationCtx, userId: Id<"users">) {
  return await ctx.db
    .query("wallets")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

async function getEventByIdempotency(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  idempotencyKey: string,
) {
  return await ctx.db
    .query("walletEvents")
    .withIndex("by_user_idempotency", (q) =>
      q.eq("userId", userId).eq("idempotencyKey", idempotencyKey),
    )
    .unique();
}

async function getEventBySourceKind(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  sourceType: WalletSourceType,
  sourceId: string,
  kind: WalletEventKind,
) {
  return await ctx.db
    .query("walletEvents")
    .withIndex("by_user_source_kind", (q) =>
      q.eq("userId", userId).eq("sourceType", sourceType).eq("sourceId", sourceId).eq("kind", kind),
    )
    .unique();
}

async function getDuplicateEvent(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  idempotencyKey: string,
  sourceType: WalletSourceType,
  sourceId: string,
  kind: WalletEventKind,
) {
  return (
    (await getEventByIdempotency(ctx, userId, idempotencyKey)) ??
    (await getEventBySourceKind(ctx, userId, sourceType, sourceId, kind))
  );
}

export async function ensureWalletForUser(ctx: MutationCtx, userId: Id<"users">, now = Date.now()) {
  const existing = await getWalletByUser(ctx, userId);

  if (existing) {
    return existing;
  }

  const walletId = await ctx.db.insert("wallets", {
    availableBalance: INITIAL_PLAYABLE_BALANCE_SATS,
    createdAt: now,
    heldBalance: 0,
    unit: "sats",
    updatedAt: now,
    userId,
  });
  const wallet = await ctx.db.get(walletId);

  if (!wallet) {
    throw new Error("Wallet could not be created.");
  }

  await ctx.db.insert("walletEvents", {
    amount: INITIAL_PLAYABLE_BALANCE_SATS,
    availableBalanceAfter: INITIAL_PLAYABLE_BALANCE_SATS,
    availableDelta: INITIAL_PLAYABLE_BALANCE_SATS,
    createdAt: now,
    heldBalanceAfter: 0,
    heldDelta: 0,
    idempotencyKey: idempotencyKeyFor("system", userId, "manual_adjustment"),
    kind: "manual_adjustment",
    sourceId: userId,
    sourceType: "system",
    status: "completed",
    userId,
    walletId,
  });

  return wallet;
}

async function applyWalletEvent(
  ctx: MutationCtx,
  wallet: WalletDoc,
  event: {
    amount: number;
    availableDelta: number;
    heldDelta: number;
    idempotencyKey: string;
    kind: WalletEventKind;
    sourceId: string;
    sourceType: WalletSourceType;
    status: WalletStatus;
  },
  now = Date.now(),
) {
  assertPositiveWalletAmount(event.amount);

  const next = applyWalletDelta(wallet, {
    availableDelta: event.availableDelta,
    heldDelta: event.heldDelta,
  });

  await ctx.db.patch(wallet._id, {
    availableBalance: next.availableBalance,
    heldBalance: next.heldBalance,
    updatedAt: now,
  });

  const eventId = await ctx.db.insert("walletEvents", {
    amount: event.amount,
    availableBalanceAfter: next.availableBalance,
    availableDelta: event.availableDelta,
    createdAt: now,
    heldBalanceAfter: next.heldBalance,
    heldDelta: event.heldDelta,
    idempotencyKey: event.idempotencyKey,
    kind: event.kind,
    sourceId: event.sourceId,
    sourceType: event.sourceType,
    status: event.status,
    userId: wallet.userId,
    walletId: wallet._id,
  });

  return {
    eventId,
    wallet: {
      ...wallet,
      availableBalance: next.availableBalance,
      heldBalance: next.heldBalance,
      updatedAt: now,
    },
  };
}

export const getWallet = query({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, { sessionToken }) => {
    const user = await requireActiveUserBySession(ctx, sessionToken);
    const wallet = await getWalletByUser(ctx, user._id);
    const events = await ctx.db
      .query("walletEvents")
      .withIndex("by_user_created_at", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(WALLET_EVENT_LIMIT);

    return {
      ...serializeWallet(wallet),
      events: events.map(serializeWalletEvent),
    };
  },
});

export const ensureWallet = mutation({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, { sessionToken }) => {
    const user = await requireActiveUserBySession(ctx, sessionToken);
    const wallet = await ensureWalletForUser(ctx, user._id);

    return serializeWallet(wallet);
  },
});

export async function creditDepositForUser(
  ctx: MutationCtx,
  {
    amount,
    depositId,
    idempotencyKey,
    userId,
  }: {
    amount: number;
    depositId: string;
    idempotencyKey?: string;
    userId: Id<"users">;
  },
) {
  const kind = "deposit_credit";
  const key = idempotencyKey ?? idempotencyKeyFor("deposit", depositId, kind);
  const duplicate = await getDuplicateEvent(ctx, userId, key, "deposit", depositId, kind);

  if (duplicate) {
    return {
      duplicate: true,
      eventId: duplicate._id,
      wallet: serializeWallet(await getWalletByUser(ctx, userId)),
    };
  }

  const wallet = await ensureWalletForUser(ctx, userId);
  const result = await applyWalletEvent(ctx, wallet, {
    amount,
    availableDelta: amount,
    heldDelta: 0,
    idempotencyKey: key,
    kind,
    sourceId: depositId,
    sourceType: "deposit",
    status: "completed",
  });

  return {
    duplicate: false,
    eventId: result.eventId,
    wallet: serializeWallet(result.wallet),
  };
}

export const creditDeposit = internalMutation({
  args: {
    amount: v.number(),
    depositId: v.string(),
    idempotencyKey: v.optional(v.string()),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    return await creditDepositForUser(ctx, args);
  },
});

export async function reserveWithdrawalForUser(
  ctx: MutationCtx,
  {
    amount,
    idempotencyKey,
    userId,
    withdrawalId,
  }: {
    amount: number;
    idempotencyKey?: string;
    userId: Id<"users">;
    withdrawalId: string;
  },
) {
  const kind = "withdrawal_hold";
  const key = idempotencyKey ?? idempotencyKeyFor("withdrawal", withdrawalId, kind);
  const duplicate = await getDuplicateEvent(ctx, userId, key, "withdrawal", withdrawalId, kind);

  if (duplicate) {
    return {
      duplicate: true,
      eventId: duplicate._id,
      wallet: serializeWallet(await getWalletByUser(ctx, userId)),
    };
  }

  const wallet = await ensureWalletForUser(ctx, userId);
  const result = await applyWalletEvent(ctx, wallet, {
    amount,
    availableDelta: -amount,
    heldDelta: amount,
    idempotencyKey: key,
    kind,
    sourceId: withdrawalId,
    sourceType: "withdrawal",
    status: "pending",
  });

  return {
    duplicate: false,
    eventId: result.eventId,
    wallet: serializeWallet(result.wallet),
  };
}

export const reserveWithdrawal = internalMutation({
  args: {
    amount: v.number(),
    idempotencyKey: v.optional(v.string()),
    userId: v.id("users"),
    withdrawalId: v.string(),
  },
  handler: async (ctx, args) => {
    return await reserveWithdrawalForUser(ctx, args);
  },
});

export async function captureWithdrawalForUser(
  ctx: MutationCtx,
  {
    idempotencyKey,
    userId,
    withdrawalId,
  }: {
    idempotencyKey?: string;
    userId: Id<"users">;
    withdrawalId: string;
  },
) {
  const hold = await getEventBySourceKind(
    ctx,
    userId,
    "withdrawal",
    withdrawalId,
    "withdrawal_hold",
  );

  if (!hold) {
    throw new Error("Withdrawal hold was not found.");
  }

  const existingRelease = await getEventBySourceKind(
    ctx,
    userId,
    "withdrawal",
    withdrawalId,
    "withdrawal_release",
  );

  if (existingRelease) {
    throw new Error("Withdrawal has already been released.");
  }

  const kind = "withdrawal_capture";
  const key = idempotencyKey ?? idempotencyKeyFor("withdrawal", withdrawalId, kind);
  const duplicate = await getDuplicateEvent(ctx, userId, key, "withdrawal", withdrawalId, kind);

  if (duplicate) {
    return {
      duplicate: true,
      eventId: duplicate._id,
      wallet: serializeWallet(await getWalletByUser(ctx, userId)),
    };
  }

  const wallet = await ensureWalletForUser(ctx, userId);
  const result = await applyWalletEvent(ctx, wallet, {
    amount: hold.amount,
    availableDelta: 0,
    heldDelta: -hold.amount,
    idempotencyKey: key,
    kind,
    sourceId: withdrawalId,
    sourceType: "withdrawal",
    status: "completed",
  });

  return {
    duplicate: false,
    eventId: result.eventId,
    wallet: serializeWallet(result.wallet),
  };
}

export const captureWithdrawal = internalMutation({
  args: {
    idempotencyKey: v.optional(v.string()),
    userId: v.id("users"),
    withdrawalId: v.string(),
  },
  handler: async (ctx, args) => {
    return await captureWithdrawalForUser(ctx, args);
  },
});

export async function releaseWithdrawalForUser(
  ctx: MutationCtx,
  {
    idempotencyKey,
    status = "canceled",
    userId,
    withdrawalId,
  }: {
    idempotencyKey?: string;
    status?: Extract<WalletStatus, "failed" | "canceled">;
    userId: Id<"users">;
    withdrawalId: string;
  },
) {
  const hold = await getEventBySourceKind(
    ctx,
    userId,
    "withdrawal",
    withdrawalId,
    "withdrawal_hold",
  );

  if (!hold) {
    throw new Error("Withdrawal hold was not found.");
  }

  const existingCapture = await getEventBySourceKind(
    ctx,
    userId,
    "withdrawal",
    withdrawalId,
    "withdrawal_capture",
  );

  if (existingCapture) {
    throw new Error("Withdrawal has already been captured.");
  }

  const kind = "withdrawal_release";
  const key = idempotencyKey ?? idempotencyKeyFor("withdrawal", withdrawalId, kind);
  const duplicate = await getDuplicateEvent(ctx, userId, key, "withdrawal", withdrawalId, kind);

  if (duplicate) {
    return {
      duplicate: true,
      eventId: duplicate._id,
      wallet: serializeWallet(await getWalletByUser(ctx, userId)),
    };
  }

  const wallet = await ensureWalletForUser(ctx, userId);
  const result = await applyWalletEvent(ctx, wallet, {
    amount: hold.amount,
    availableDelta: hold.amount,
    heldDelta: -hold.amount,
    idempotencyKey: key,
    kind,
    sourceId: withdrawalId,
    sourceType: "withdrawal",
    status,
  });

  return {
    duplicate: false,
    eventId: result.eventId,
    wallet: serializeWallet(result.wallet),
  };
}

export const releaseWithdrawal = internalMutation({
  args: {
    idempotencyKey: v.optional(v.string()),
    userId: v.id("users"),
    withdrawalId: v.string(),
  },
  handler: async (ctx, args) => {
    return await releaseWithdrawalForUser(ctx, args);
  },
});

export async function settleBetForUser(
  ctx: MutationCtx,
  {
    betAmount,
    betId,
    idempotencyKey,
    payoutAmount,
    userId,
  }: {
    betAmount: number;
    betId: string;
    idempotencyKey?: string;
    payoutAmount: number;
    userId: Id<"users">;
  },
) {
  assertPositiveWalletAmount(betAmount);

  if (payoutAmount < 0) {
    throw new Error("Payout cannot be negative.");
  }

  const kind = "bet_debit";
  const key = idempotencyKey ?? idempotencyKeyFor("bet", betId, kind);
  const duplicate = await getDuplicateEvent(ctx, userId, key, "bet", betId, kind);

  if (duplicate) {
    return {
      betEventId: duplicate._id,
      duplicate: true,
      payoutEventId: (await getEventBySourceKind(ctx, userId, "bet", betId, "payout_credit"))?._id,
      wallet: serializeWallet(await getWalletByUser(ctx, userId)),
    };
  }

  let wallet = await ensureWalletForUser(ctx, userId);
  const debit = await applyWalletEvent(ctx, wallet, {
    amount: betAmount,
    availableDelta: -betAmount,
    heldDelta: 0,
    idempotencyKey: key,
    kind,
    sourceId: betId,
    sourceType: "bet",
    status: "completed",
  });
  wallet = debit.wallet;
  let payoutEventId: Id<"walletEvents"> | undefined;

  if (payoutAmount > 0) {
    const payout = await applyWalletEvent(ctx, wallet, {
      amount: payoutAmount,
      availableDelta: payoutAmount,
      heldDelta: 0,
      idempotencyKey: idempotencyKeyFor("bet", betId, "payout_credit"),
      kind: "payout_credit",
      sourceId: betId,
      sourceType: "bet",
      status: "completed",
    });
    wallet = payout.wallet;
    payoutEventId = payout.eventId;
  }

  return {
    betEventId: debit.eventId,
    duplicate: false,
    payoutEventId,
    wallet: serializeWallet(wallet),
  };
}

export const settleBet = internalMutation({
  args: {
    betAmount: v.number(),
    betId: v.string(),
    idempotencyKey: v.optional(v.string()),
    payoutAmount: v.number(),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    return await settleBetForUser(ctx, args);
  },
});

export const creditRefund = internalMutation({
  args: {
    amount: v.number(),
    idempotencyKey: v.optional(v.string()),
    refundId: v.string(),
    userId: v.id("users"),
  },
  handler: async (ctx, { amount, idempotencyKey, refundId, userId }) => {
    const kind = "refund_credit";
    const key = idempotencyKey ?? idempotencyKeyFor("refund", refundId, kind);
    const duplicate = await getDuplicateEvent(ctx, userId, key, "refund", refundId, kind);

    if (duplicate) {
      return {
        duplicate: true,
        eventId: duplicate._id,
        wallet: serializeWallet(await getWalletByUser(ctx, userId)),
      };
    }

    const wallet = await ensureWalletForUser(ctx, userId);
    const result = await applyWalletEvent(ctx, wallet, {
      amount,
      availableDelta: amount,
      heldDelta: 0,
      idempotencyKey: key,
      kind,
      sourceId: refundId,
      sourceType: "refund",
      status: "completed",
    });

    return {
      duplicate: false,
      eventId: result.eventId,
      wallet: serializeWallet(result.wallet),
    };
  },
});

export async function adjustAvailableBalanceForUser(
  ctx: MutationCtx,
  {
    adjustmentId,
    amount,
    direction,
    idempotencyKey,
    userId,
  }: {
    adjustmentId: string;
    amount: number;
    direction: "credit" | "debit";
    idempotencyKey?: string;
    userId: Id<"users">;
  },
) {
  const kind = "manual_adjustment";
  const key = idempotencyKey ?? idempotencyKeyFor("manual_adjustment", adjustmentId, kind);
  const duplicate = await getDuplicateEvent(
    ctx,
    userId,
    key,
    "manual_adjustment",
    adjustmentId,
    kind,
  );

  if (duplicate) {
    return {
      duplicate: true,
      eventId: duplicate._id,
      wallet: serializeWallet(await getWalletByUser(ctx, userId)),
    };
  }

  const availableDelta = direction === "credit" ? amount : -amount;
  const wallet = await ensureWalletForUser(ctx, userId);
  const result = await applyWalletEvent(ctx, wallet, {
    amount,
    availableDelta,
    heldDelta: 0,
    idempotencyKey: key,
    kind,
    sourceId: adjustmentId,
    sourceType: "manual_adjustment",
    status: "completed",
  });

  return {
    duplicate: false,
    eventId: result.eventId,
    wallet: serializeWallet(result.wallet),
  };
}

export const adjustAvailableBalance = internalMutation({
  args: {
    adjustmentId: v.string(),
    amount: v.number(),
    direction: v.union(v.literal("credit"), v.literal("debit")),
    idempotencyKey: v.optional(v.string()),
    userId: v.id("users"),
  },
  handler: async (ctx, { adjustmentId, amount, direction, idempotencyKey, userId }) => {
    return await adjustAvailableBalanceForUser(ctx, {
      adjustmentId,
      amount,
      direction,
      idempotencyKey,
      userId,
    });
  },
});
