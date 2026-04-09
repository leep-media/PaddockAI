import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    name: v.string(),
    email: v.string(),
    plan: v.string(), // "free" | "pro"
    avatarData: v.optional(v.string()),
    googleId: v.optional(v.string()),
    facebookId: v.optional(v.string()),
    appleId: v.optional(v.string()),
    authProvider: v.optional(v.string()),
    subscriptionId: v.optional(v.string()),
    createdAt: v.string(),
  }).index("by_email", ["email"]),

  lists: defineTable({
    userId: v.optional(v.string()),
    showId: v.string(),
    showName: v.string(),
    listName: v.optional(v.string()),
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
    riderIds: v.array(v.number()),
    selections: v.optional(v.any()),
    shareToken: v.optional(v.string()),
    createdAt: v.string(),
  }).index("by_share_token", ["shareToken"]),
});
