import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const upsert = mutation({
  args: { name: v.string(), email: v.string() },
  handler: async (ctx, { name, email }) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_email", q => q.eq("email", email.toLowerCase()))
      .first();
    if (existing) {
      if (existing.name !== name) await ctx.db.patch(existing._id, { name });
      return existing;
    }
    const id = await ctx.db.insert("users", {
      name, email: email.toLowerCase(), plan: "free",
      createdAt: new Date().toISOString()
    });
    return await ctx.db.get(id);
  }
});

export const getByEmail = query({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    return await ctx.db
      .query("users")
      .withIndex("by_email", q => q.eq("email", email.toLowerCase()))
      .first();
  }
});

export const updatePlan = mutation({
  args: { email: v.string(), plan: v.string() },
  handler: async (ctx, { email, plan }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", q => q.eq("email", email.toLowerCase()))
      .first();
    if (!user) throw new Error("User not found");
    await ctx.db.patch(user._id, { plan });
    return await ctx.db.get(user._id);
  }
});
