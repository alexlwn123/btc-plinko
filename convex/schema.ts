import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    accountState: v.union(
      v.literal("active"),
      v.literal("locked"),
      v.literal("pending_review"),
      v.literal("disabled"),
    ),
    anonymousId: v.optional(v.string()),
    authMethod: v.optional(v.union(v.literal("passkey"), v.literal("legacy_anonymous"))),
    createdAt: v.number(),
    displayName: v.optional(v.string()),
    lastSeenAt: v.number(),
    publicId: v.optional(v.string()),
    role: v.optional(v.union(v.literal("player"), v.literal("admin"))),
  }).index("by_anonymous_id", ["anonymousId"]),
  passkeyCredentials: defineTable({
    backedUp: v.boolean(),
    counter: v.number(),
    createdAt: v.number(),
    credentialId: v.string(),
    deviceType: v.string(),
    lastUsedAt: v.optional(v.number()),
    publicKey: v.bytes(),
    transports: v.array(v.string()),
    userId: v.id("users"),
  })
    .index("by_credential_id", ["credentialId"])
    .index("by_user", ["userId"]),
  passkeyChallenges: defineTable({
    challenge: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    kind: v.union(v.literal("registration"), v.literal("authentication")),
    origin: v.string(),
    rpId: v.string(),
    usedAt: v.optional(v.number()),
    userHandle: v.optional(v.string()),
  }).index("by_challenge", ["challenge"]),
  passkeySessions: defineTable({
    createdAt: v.number(),
    expiresAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    tokenHash: v.string(),
    userId: v.id("users"),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_user", ["userId"]),
  wallets: defineTable({
    availableBalance: v.number(),
    createdAt: v.number(),
    heldBalance: v.number(),
    unit: v.literal("sats"),
    updatedAt: v.number(),
    userId: v.id("users"),
  }).index("by_user", ["userId"]),
  walletEvents: defineTable({
    amount: v.number(),
    availableBalanceAfter: v.number(),
    availableDelta: v.number(),
    createdAt: v.number(),
    heldBalanceAfter: v.number(),
    heldDelta: v.number(),
    idempotencyKey: v.string(),
    kind: v.union(
      v.literal("deposit_credit"),
      v.literal("bet_debit"),
      v.literal("payout_credit"),
      v.literal("withdrawal_hold"),
      v.literal("withdrawal_capture"),
      v.literal("withdrawal_release"),
      v.literal("refund_credit"),
      v.literal("manual_adjustment"),
    ),
    sourceId: v.string(),
    sourceType: v.union(
      v.literal("deposit"),
      v.literal("withdrawal"),
      v.literal("bet"),
      v.literal("refund"),
      v.literal("manual_adjustment"),
      v.literal("system"),
    ),
    status: v.union(
      v.literal("pending"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("canceled"),
    ),
    userId: v.id("users"),
    walletId: v.id("wallets"),
  })
    .index("by_user_created_at", ["userId", "createdAt"])
    .index("by_user_idempotency", ["userId", "idempotencyKey"])
    .index("by_user_source_kind", ["userId", "sourceType", "sourceId", "kind"]),
  deposits: defineTable({
    amount: v.number(),
    canceledAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
    failedAt: v.optional(v.number()),
    idempotencyKey: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("canceled"),
    ),
    updatedAt: v.number(),
    userId: v.id("users"),
    walletEventId: v.optional(v.id("walletEvents")),
  })
    .index("by_user_created_at", ["userId", "createdAt"])
    .index("by_user_idempotency", ["userId", "idempotencyKey"])
    .index("by_user_status", ["userId", "status"]),
  withdrawals: defineTable({
    amount: v.number(),
    canceledAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
    failedAt: v.optional(v.number()),
    holdEventId: v.optional(v.id("walletEvents")),
    idempotencyKey: v.string(),
    resultEventId: v.optional(v.id("walletEvents")),
    status: v.union(
      v.literal("pending"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("canceled"),
    ),
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_user_created_at", ["userId", "createdAt"])
    .index("by_user_idempotency", ["userId", "idempotencyKey"])
    .index("by_user_status", ["userId", "status"]),
  gameRounds: defineTable({
    betAmount: v.number(),
    betEventId: v.optional(v.id("walletEvents")),
    clientSeed: v.string(),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
    directions: v.array(v.union(v.literal("L"), v.literal("R"))),
    idempotencyKey: v.string(),
    multiplier: v.number(),
    nonce: v.number(),
    payoutAmount: v.number(),
    payoutEventId: v.optional(v.id("walletEvents")),
    points: v.array(
      v.object({
        layer: v.number(),
        rights: v.number(),
        slot: v.number(),
      }),
    ),
    risk: v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
    rowHashes: v.array(v.string()),
    rows: v.number(),
    serverSeed: v.string(),
    serverSeedHash: v.string(),
    slot: v.number(),
    status: v.union(v.literal("settling"), v.literal("completed"), v.literal("failed")),
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_user", ["userId"])
    .index("by_user_created_at", ["userId", "createdAt"])
    .index("by_user_idempotency", ["userId", "idempotencyKey"])
    .index("by_user_nonce", ["userId", "nonce"]),
});
