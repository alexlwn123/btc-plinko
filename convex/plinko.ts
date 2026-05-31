import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, query } from "./_generated/server";
import {
  type PlinkoRisk,
  assertPlinkoBetAmount,
  buildPlinkoMultipliers,
  normalizeClientSeed,
  parsePlinkoRisk,
  settlePlinkoDrop as settlePlinkoDropCore,
} from "./plinkoCore";
import { requireActiveUserBySession } from "./users";
import { idempotencyKeyFor } from "./walletCore";
import { ensureWalletForUser, getWalletByUser, serializeWallet, settleBetForUser } from "./wallets";

const ROUND_HISTORY_LIMIT = 20;

function plinkoRequestKey(requestId: string) {
  if (!requestId.trim()) {
    throw new Error("Plinko request id is required.");
  }

  return `plinko:request:${requestId}`;
}

function serializeRound(round: Doc<"gameRounds">) {
  return {
    betAmount: round.betAmount,
    clientSeed: round.clientSeed,
    completedAt: round.completedAt,
    createdAt: round.createdAt,
    directions: round.directions,
    id: round._id,
    multiplier: round.multiplier,
    nonce: round.nonce,
    payoutAmount: round.payoutAmount,
    points: round.points,
    risk: round.risk,
    rowHashes: round.rowHashes,
    rows: round.rows,
    serverSeed: round.serverSeed,
    serverSeedHash: round.serverSeedHash,
    slot: round.slot,
    status: round.status,
  };
}

async function getExistingRound(ctx: MutationCtx, userId: Id<"users">, idempotencyKey: string) {
  return await ctx.db
    .query("gameRounds")
    .withIndex("by_user_idempotency", (q) =>
      q.eq("userId", userId).eq("idempotencyKey", idempotencyKey),
    )
    .unique();
}

async function getNextNonce(ctx: MutationCtx, userId: Id<"users">) {
  const latest = await ctx.db
    .query("gameRounds")
    .withIndex("by_user_nonce", (q) => q.eq("userId", userId))
    .order("desc")
    .take(1);

  return (latest[0]?.nonce ?? -1) + 1;
}

function walletEventPatch({
  betEventId,
  payoutEventId,
}: {
  betEventId: Id<"walletEvents">;
  payoutEventId?: Id<"walletEvents">;
}) {
  return payoutEventId ? { betEventId, payoutEventId } : { betEventId };
}

export const getRecentRounds = query({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, { sessionToken }) => {
    const user = await requireActiveUserBySession(ctx, sessionToken);
    const rounds = await ctx.db
      .query("gameRounds")
      .withIndex("by_user_created_at", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(ROUND_HISTORY_LIMIT);

    return rounds.map(serializeRound);
  },
});

export async function settleDropForUser(
  ctx: MutationCtx,
  {
    betAmount,
    clientSeed,
    requestId,
    risk,
    rows,
    userId,
  }: {
    betAmount: number;
    clientSeed: string;
    requestId: string;
    risk: string;
    rows: number;
    userId: Id<"users">;
  },
) {
  assertPlinkoBetAmount(betAmount);
  buildPlinkoMultipliers(rows, risk);

  const idempotencyKey = plinkoRequestKey(requestId);
  const existing = await getExistingRound(ctx, userId, idempotencyKey);

  if (existing) {
    return {
      duplicate: true,
      round: serializeRound(existing),
      wallet: serializeWallet(await getWalletByUser(ctx, userId)),
    };
  }

  const normalizedRisk: PlinkoRisk = parsePlinkoRisk(risk);
  const normalizedClientSeed = normalizeClientSeed(clientSeed);
  const wallet = await ensureWalletForUser(ctx, userId);

  if (wallet.availableBalance < betAmount) {
    throw new Error("Insufficient available balance.");
  }

  const now = Date.now();
  const nonce = await getNextNonce(ctx, userId);
  const settled = await settlePlinkoDropCore({
    betAmount,
    clientSeed: normalizedClientSeed,
    nonce,
    risk: normalizedRisk,
    rows,
  });
  const roundId = await ctx.db.insert("gameRounds", {
    betAmount,
    clientSeed: settled.clientSeed,
    createdAt: now,
    directions: settled.directions,
    idempotencyKey,
    multiplier: settled.multiplier,
    nonce,
    payoutAmount: settled.payoutAmount,
    points: settled.points,
    risk: settled.risk,
    rowHashes: settled.rowHashes,
    rows,
    serverSeed: settled.serverSeed,
    serverSeedHash: settled.serverSeedHash,
    slot: settled.slot,
    status: "settling",
    updatedAt: now,
    userId,
  });
  const walletSettlement = await settleBetForUser(ctx, {
    betAmount,
    betId: roundId,
    idempotencyKey: idempotencyKeyFor("bet", roundId, "bet_debit"),
    payoutAmount: settled.payoutAmount,
    userId,
  });

  await ctx.db.patch(roundId, {
    ...walletEventPatch(walletSettlement),
    completedAt: now,
    status: "completed",
    updatedAt: now,
  });

  const round = await ctx.db.get(roundId);

  if (!round) {
    throw new Error("Game round could not be loaded.");
  }

  return {
    duplicate: false,
    round: serializeRound(round),
    wallet: walletSettlement.wallet,
  };
}

export const settleDrop = mutation({
  args: {
    betAmount: v.number(),
    clientSeed: v.string(),
    requestId: v.string(),
    risk: v.string(),
    rows: v.number(),
    sessionToken: v.string(),
  },
  handler: async (ctx, { betAmount, clientSeed, requestId, risk, rows, sessionToken }) => {
    const user = await requireActiveUserBySession(ctx, sessionToken);

    return await settleDropForUser(ctx, {
      betAmount,
      clientSeed,
      requestId,
      risk,
      rows,
      userId: user._id,
    });
  },
});
