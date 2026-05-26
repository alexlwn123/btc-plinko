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
    displayName: v.optional(v.string()),
  }),
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
