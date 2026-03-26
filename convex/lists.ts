import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const create = mutation({
  args: {
    showId: v.string(), showName: v.string(), listName: v.optional(v.string()),
    startDate: v.optional(v.string()), endDate: v.optional(v.string()),
    riderIds: v.array(v.number()), selections: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("lists", {
      ...args, createdAt: new Date().toISOString()
    });
    return await ctx.db.get(id);
  }
});

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("lists").order("desc").collect();
  }
});

export const getById = query({
  args: { id: v.id("lists") },
  handler: async (ctx, { id }) => {
    return await ctx.db.get(id);
  }
});

export const getByShareToken = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    return await ctx.db
      .query("lists")
      .withIndex("by_share_token", q => q.eq("shareToken", token))
      .first();
  }
});

export const remove = mutation({
  args: { id: v.id("lists") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
    return { ok: true };
  }
});

export const addShareToken = mutation({
  args: { id: v.id("lists"), token: v.string() },
  handler: async (ctx, { id, token }) => {
    await ctx.db.patch(id, { shareToken: token });
    return await ctx.db.get(id);
  }
});

// Update riders/selections on a list
export const updateRiders = mutation({
  args: {
    id: v.id("lists"),
    riderIds: v.array(v.number()),
    selections: v.optional(v.any()),
  },
  handler: async (ctx, { id, riderIds, selections }) => {
    const patch: Record<string, unknown> = { riderIds };
    if (selections !== undefined) patch.selections = selections;
    await ctx.db.patch(id, patch);
    return await ctx.db.get(id);
  }
});

// Rename a list
export const rename = mutation({
  args: { id: v.id("lists"), listName: v.string() },
  handler: async (ctx, { id, listName }) => {
    await ctx.db.patch(id, { listName });
    return await ctx.db.get(id);
  }
});
