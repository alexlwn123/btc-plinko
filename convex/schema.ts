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
  walletEvents: defineTable({
    amount: v.number(),
    kind: v.string(),
    status: v.string(),
    userId: v.id("users"),
  }).index("by_user", ["userId"]),
  gameRounds: defineTable({
    betAmount: v.number(),
    payoutAmount: v.optional(v.number()),
    risk: v.string(),
    rows: v.number(),
    status: v.string(),
    userId: v.id("users"),
  }).index("by_user", ["userId"]),
});
