import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const upsert = mutation({
  args: {
    name: v.string(),
    email: v.string(),
    avatarData: v.optional(v.string()),
    googleId: v.optional(v.string()),
    facebookId: v.optional(v.string()),
    appleId: v.optional(v.string()),
    authProvider: v.optional(v.string()),
  },
  handler: async (ctx, { name, email, avatarData, googleId, facebookId, appleId, authProvider }) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_email", q => q.eq("email", email.toLowerCase()))
      .first();
    if (existing) {
      const patch: Record<string, string> = {};
      if (existing.name !== name) patch.name = name;
      if (avatarData && existing.avatarData !== avatarData) patch.avatarData = avatarData;
      if (googleId && existing.googleId !== googleId) patch.googleId = googleId;
      if (facebookId && existing.facebookId !== facebookId) patch.facebookId = facebookId;
      if (appleId && existing.appleId !== appleId) patch.appleId = appleId;
      if (authProvider && existing.authProvider !== authProvider) patch.authProvider = authProvider;
      if (Object.keys(patch).length) await ctx.db.patch(existing._id, patch);
      return await ctx.db.get(existing._id);
    }
    const id = await ctx.db.insert("users", {
      name,
      email: email.toLowerCase(),
      plan: "free",
      avatarData,
      googleId,
      facebookId,
      appleId,
      authProvider,
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
  args: { email: v.string(), plan: v.string(), subscriptionId: v.optional(v.string()) },
  handler: async (ctx, { email, plan, subscriptionId }) => {
    const user = await ctx.db.query("users").withIndex("by_email", q => q.eq("email", email.toLowerCase())).first();
    if (!user) throw new Error("User not found");
    const update: any = { plan };
    if (subscriptionId !== undefined) update.subscriptionId = subscriptionId;
    await ctx.db.patch(user._id, update);
    return await ctx.db.get(user._id);
  }
});

export const downgradeBySubscription = mutation({
  args: { subscriptionId: v.string() },
  handler: async (ctx, { subscriptionId }) => {
    const users = await ctx.db.query("users").collect();
    const user = users.find(u => (u as any).subscriptionId === subscriptionId);
    if (user) await ctx.db.patch(user._id, { plan: 'free' });
  }
});

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("users").collect();
  }
});
