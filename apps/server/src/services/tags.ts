import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db.js";
import { conversationTags, tags } from "../schema.js";

export interface TagSuggestion {
  name: string;
  confidence: number;
}

const UUID_TAG_NAME_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;

export function isProtectedConversationTag(link: {
  source: "auto" | "manual";
  lockedByUser: boolean;
}): boolean {
  return link.source === "manual" || link.lockedByUser;
}

export function mergeConversationTagState(
  existing: { confidence: number | null; source: "auto" | "manual"; lockedByUser: boolean },
  incoming: { confidence: number | null; source: "auto" | "manual"; lockedByUser: boolean },
) {
  return {
    confidence: Math.max(existing.confidence ?? 0, incoming.confidence ?? 0),
    source: existing.source === "manual" || incoming.source === "manual"
      ? "manual" as const
      : "auto" as const,
    lockedByUser: existing.lockedByUser || incoming.lockedByUser,
  };
}

export function normalizeTagName(value: string): {
  name: string;
  normalizedName: string;
} {
  const name = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  return {
    name,
    normalizedName: name.toLocaleLowerCase("en-US"),
  };
}

export function isReusableTagName(value: string): boolean {
  const { name } = normalizeTagName(value);
  if (!name || [...name].length > 40) return false;
  if (UUID_TAG_NAME_PATTERN.test(name)) return false;
  if (/\r|\n|[。！？!?；;]/u.test(name)) return false;
  if (name.split(" ").length > 6) return false;
  return true;
}

export function normalizeTagSuggestions(
  suggestions: readonly TagSuggestion[],
  limit = 10,
): TagSuggestion[] {
  const byName = new Map<string, TagSuggestion>();
  for (const suggestion of suggestions) {
    if (!isReusableTagName(suggestion.name)) continue;
    const normalized = normalizeTagName(suggestion.name);
    const confidence = Math.min(1, Math.max(0, Number(suggestion.confidence) || 0));
    if (confidence < 0.35) continue;
    const existing = byName.get(normalized.normalizedName);
    if (!existing || confidence > existing.confidence) {
      byName.set(normalized.normalizedName, {
        name: normalized.name,
        confidence,
      });
    }
  }
  return [...byName.values()]
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, Math.max(0, limit));
}

export async function getOrCreateTag(nameInput: string) {
  const normalized = normalizeTagName(nameInput);
  if (!isReusableTagName(normalized.name)) {
    throw Object.assign(new Error("Tag name must be concise and reusable"), {
      statusCode: 400,
    });
  }
  const [created] = await db
    .insert(tags)
    .values({
      name: normalized.name,
      normalizedName: normalized.normalizedName,
      updatedAt: new Date(),
    })
    .onConflictDoNothing({ target: tags.normalizedName })
    .returning();
  if (created) return created;
  const [existing] = await db
    .select()
    .from(tags)
    .where(eq(tags.normalizedName, normalized.normalizedName))
    .limit(1);
  if (!existing) throw new Error("Failed to resolve tag");
  return existing;
}

export async function persistAutoTags(
  conversationId: string,
  suggestions: readonly TagSuggestion[],
): Promise<Array<typeof tags.$inferSelect & { confidence: number }>> {
  const normalized = normalizeTagSuggestions(suggestions);
  const existingLinks = await db
    .select()
    .from(conversationTags)
    .where(eq(conversationTags.conversationId, conversationId));
  const protectedTagIds = new Set(
    existingLinks
      .filter(isProtectedConversationTag)
      .map((link) => link.tagId),
  );
  const resolved = await Promise.all(
    normalized.map(async (suggestion) => ({
      tag: await getOrCreateTag(suggestion.name),
      confidence: suggestion.confidence,
    })),
  );
  const nextAutoTagIds = new Set(resolved.map((item) => item.tag.id));

  await db.transaction(async (tx) => {
    const removable = existingLinks
      .filter(
        (link) =>
          link.source === "auto" &&
          !link.lockedByUser &&
          !nextAutoTagIds.has(link.tagId),
      )
      .map((link) => link.tagId);
    if (removable.length) {
      await tx
        .delete(conversationTags)
        .where(
          and(
            eq(conversationTags.conversationId, conversationId),
            inArray(conversationTags.tagId, removable),
          ),
        );
    }
    for (const item of resolved) {
      if (protectedTagIds.has(item.tag.id)) continue;
      await tx
        .insert(conversationTags)
        .values({
          conversationId,
          tagId: item.tag.id,
          confidence: item.confidence,
          source: "auto",
          lockedByUser: false,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [conversationTags.conversationId, conversationTags.tagId],
          set: {
            confidence: item.confidence,
            source: "auto",
            updatedAt: new Date(),
          },
        });
    }
  });

  return resolved.map((item) => ({ ...item.tag, confidence: item.confidence }));
}

export async function loadConversationTags(conversationId: string) {
  return db
    .select({
      id: tags.id,
      name: tags.name,
      normalizedName: tags.normalizedName,
      confidence: conversationTags.confidence,
      source: conversationTags.source,
      lockedByUser: conversationTags.lockedByUser,
      createdAt: conversationTags.createdAt,
      updatedAt: conversationTags.updatedAt,
    })
    .from(conversationTags)
    .innerJoin(tags, eq(tags.id, conversationTags.tagId))
    .where(eq(conversationTags.conversationId, conversationId))
    .orderBy(desc(conversationTags.lockedByUser), desc(conversationTags.confidence), tags.name);
}
