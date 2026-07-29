import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import { getEffectiveUserId, isDeletionInProgress } from "./lib/auth";

export const MEMORY_FACT_CATEGORIES = [
  "exercise_preference",
  "schedule_preference",
  "workout_style_preference",
] as const;

export type MemoryFactCategory = (typeof MEMORY_FACT_CATEGORIES)[number];

export const MAX_MEMORY_FACTS_PER_USER = 50;
export const MAX_MEMORY_FACTS_PER_TURN = 3;
export const MAX_INJECTED_MEMORY_FACTS = 8;
export const MIN_MEMORY_FACT_CONFIDENCE = 0.85;
export const MAX_MEMORY_FACT_LENGTH = 180;
export const MAX_MEMORY_FACT_SUBJECT_LENGTH = 80;

const memoryFactCategoryValidator = v.union(
  v.literal("exercise_preference"),
  v.literal("schedule_preference"),
  v.literal("workout_style_preference"),
);

const extractedFactValidator = v.object({
  category: memoryFactCategoryValidator,
  subject: v.string(),
  fact: v.string(),
  confidence: v.number(),
});

export interface ExtractedPreferenceFact {
  category: MemoryFactCategory;
  subject: string;
  fact: string;
  confidence: number;
}

export interface MemoryFactView {
  id: Id<"userMemoryFacts">;
  fact: string;
  category: MemoryFactCategory;
  confidence: number;
  createdAt: number;
  lastReferencedAt: number;
}

export interface PersistFactsResult {
  ok: boolean;
  inserted: number;
  updated: number;
  rejected: number;
  error?: string;
}

const CONTROL_OR_MARKUP_PATTERN = /[\u0000-\u001f\u007f<>]/u;
const EMAIL_PATTERN = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/u;
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/iu;
const PHONE_PATTERN = /(?:\+?\d[\s().-]*){8,}/u;
const INSTRUCTION_PATTERN =
  /\b(?:ignore (?:all |the )?(?:instructions|previous|prior)|follow (?:these|my) instructions|system prompt|developer message|assistant:|user:)\b/iu;

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function isSafeMemoryText(value: string, maxLength: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maxLength &&
    !CONTROL_OR_MARKUP_PATTERN.test(value) &&
    !EMAIL_PATTERN.test(value) &&
    !URL_PATTERN.test(value) &&
    !PHONE_PATTERN.test(value) &&
    !INSTRUCTION_PATTERN.test(value)
  );
}

function normalizeSubject(subject: string): string {
  return normalizeText(subject)
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

export function validateExtractedPreferenceFact(
  candidate: ExtractedPreferenceFact,
): ExtractedPreferenceFact | null {
  if (!MEMORY_FACT_CATEGORIES.includes(candidate.category)) return null;
  if (!Number.isFinite(candidate.confidence)) return null;
  if (candidate.confidence < MIN_MEMORY_FACT_CONFIDENCE || candidate.confidence > 1) return null;

  const subject = normalizeText(candidate.subject);
  const fact = normalizeText(candidate.fact);
  if (!isSafeMemoryText(subject, MAX_MEMORY_FACT_SUBJECT_LENGTH)) return null;
  if (!isSafeMemoryText(fact, MAX_MEMORY_FACT_LENGTH)) return null;
  if (!normalizeSubject(subject)) return null;

  return { ...candidate, subject, fact };
}

function toMemoryFactView(doc: Doc<"userMemoryFacts">): MemoryFactView {
  return {
    id: doc._id,
    fact: doc.fact,
    category: doc.category,
    confidence: doc.confidence,
    createdAt: doc.createdAt,
    lastReferencedAt: doc.lastReferencedAt,
  };
}

export const listMine = query({
  args: {},
  handler: async (ctx): Promise<MemoryFactView[]> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) return [];

    const rows = await ctx.db
      .query("userMemoryFacts")
      .withIndex("by_userId_confidence_lastReferencedAt", (q) => q.eq("userId", userId))
      .order("desc")
      .take(MAX_MEMORY_FACTS_PER_USER);
    return rows.map(toMemoryFactView);
  },
});

export const removeMine = mutation({
  args: { factId: v.id("userMemoryFacts") },
  handler: async (ctx, { factId }): Promise<{ removed: boolean }> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const fact = await ctx.db.get(factId);
    if (!fact || fact.userId !== userId) return { removed: false };
    await ctx.db.delete(factId);
    return { removed: true };
  },
});

export const persistExtractedFacts = internalMutation({
  args: {
    userId: v.id("users"),
    sourceMessageId: v.string(),
    facts: v.array(extractedFactValidator),
  },
  handler: async (ctx, { userId, sourceMessageId, facts }): Promise<PersistFactsResult> => {
    if (await isDeletionInProgress(ctx, userId)) {
      return { ok: false, inserted: 0, updated: 0, rejected: facts.length, error: "user_missing" };
    }
    const normalizedSourceMessageId = sourceMessageId.trim();
    if (!normalizedSourceMessageId || normalizedSourceMessageId.length > 200) {
      return {
        ok: false,
        inserted: 0,
        updated: 0,
        rejected: facts.length,
        error: "invalid_source",
      };
    }
    if (facts.length > MAX_MEMORY_FACTS_PER_TURN) {
      return {
        ok: false,
        inserted: 0,
        updated: 0,
        rejected: facts.length,
        error: "too_many_facts",
      };
    }

    const uniqueCandidates = new Map<string, ExtractedPreferenceFact>();
    let rejected = 0;
    for (const candidate of facts) {
      const validated = validateExtractedPreferenceFact(candidate);
      if (!validated) {
        rejected += 1;
        continue;
      }
      const dedupeKey = normalizeSubject(validated.subject);
      const batchKey = `${validated.category}:${dedupeKey}`;
      const existing = uniqueCandidates.get(batchKey);
      if (!existing || validated.confidence > existing.confidence) {
        if (existing) rejected += 1;
        uniqueCandidates.set(batchKey, validated);
      } else {
        rejected += 1;
      }
    }

    const now = Date.now();
    let inserted = 0;
    let updated = 0;
    for (const [batchKey, candidate] of uniqueCandidates) {
      const dedupeKey = batchKey.slice(candidate.category.length + 1);
      const existing = await ctx.db
        .query("userMemoryFacts")
        .withIndex("by_userId_category_dedupeKey", (q) =>
          q.eq("userId", userId).eq("category", candidate.category).eq("dedupeKey", dedupeKey),
        )
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, {
          fact: candidate.fact,
          confidence: candidate.confidence,
          sourceMessageId: normalizedSourceMessageId,
          lastReferencedAt: now,
        });
        updated += 1;
      } else {
        await ctx.db.insert("userMemoryFacts", {
          userId,
          fact: candidate.fact,
          category: candidate.category,
          dedupeKey,
          sourceMessageId: normalizedSourceMessageId,
          createdAt: now,
          lastReferencedAt: now,
          confidence: candidate.confidence,
        });
        inserted += 1;
      }
    }

    const allFacts = await ctx.db
      .query("userMemoryFacts")
      .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId))
      .collect();
    const overflow = allFacts
      .sort((a, b) => b.confidence - a.confidence || b.lastReferencedAt - a.lastReferencedAt)
      .slice(MAX_MEMORY_FACTS_PER_USER);
    for (const fact of overflow) await ctx.db.delete(fact._id);

    return { ok: true, inserted, updated, rejected };
  },
});
