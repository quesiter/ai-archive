import { asc, eq } from "drizzle-orm";
import type { CaptureMessage } from "@ai-archive/contracts";
import { db } from "../db.js";
import { conversationRevisions } from "../schema.js";
import { loadCaptureRevisionMessages } from "./revision-storage.js";

function messageKey(message: CaptureMessage): string {
  return message.externalMessageId
    ? `external:${message.externalMessageId}`
    : `ordinal:${message.ordinal}:${message.role}`;
}

function messageContent(message: CaptureMessage): string {
  return message.segments.map((segment) => `${segment.type}:${segment.content}`).join("\n");
}

export function diffRevisionMessages(
  base: readonly CaptureMessage[],
  target: readonly CaptureMessage[],
) {
  const baseByKey = new Map(base.map((message) => [messageKey(message), message]));
  const targetByKey = new Map(target.map((message) => [messageKey(message), message]));
  const added = target.filter((message) => !baseByKey.has(messageKey(message)));
  const removed = base.filter((message) => !targetByKey.has(messageKey(message)));
  const modified = target.flatMap((message) => {
    const before = baseByKey.get(messageKey(message));
    if (!before || messageContent(before) === messageContent(message)) return [];
    return [{
      key: messageKey(message),
      ordinal: message.ordinal,
      role: message.role,
      before: messageContent(before),
      after: messageContent(message),
    }];
  });
  return {
    summary: { added: added.length, removed: removed.length, modified: modified.length },
    added: added.map((message) => ({
      key: messageKey(message),
      ordinal: message.ordinal,
      role: message.role,
      content: messageContent(message),
    })),
    removed: removed.map((message) => ({
      key: messageKey(message),
      ordinal: message.ordinal,
      role: message.role,
      content: messageContent(message),
    })),
    modified,
  };
}

export async function loadRevisionDiff(input: {
  conversationId: string;
  revisionId: string;
  baseRevisionId?: string;
}) {
  const revisions = await db
    .select()
    .from(conversationRevisions)
    .where(eq(conversationRevisions.conversationId, input.conversationId))
    .orderBy(
      asc(conversationRevisions.capturedAt),
      asc(conversationRevisions.createdAt),
      asc(conversationRevisions.id),
    );
  const targetIndex = revisions.findIndex((revision) => revision.id === input.revisionId);
  if (targetIndex < 0) return null;
  const baseRevision = input.baseRevisionId
    ? revisions.find((revision) => revision.id === input.baseRevisionId)
    : revisions[targetIndex - 1];
  if (!baseRevision) {
    return {
      baseRevision: null,
      targetRevision: revisions[targetIndex],
      metadataUnavailable: !revisions[targetIndex]!.metadataCaptured,
      titleChanged: null,
      canonicalUrlChanged: null,
      ...diffRevisionMessages([], await loadCaptureRevisionMessages(input.revisionId)),
    };
  }
  const [baseMessages, targetMessages] = await Promise.all([
    loadCaptureRevisionMessages(baseRevision.id),
    loadCaptureRevisionMessages(input.revisionId),
  ]);
  return {
    baseRevision,
    targetRevision: revisions[targetIndex],
    metadataUnavailable: !baseRevision.metadataCaptured || !revisions[targetIndex]!.metadataCaptured,
    titleChanged: !baseRevision.metadataCaptured || !revisions[targetIndex]!.metadataCaptured || baseRevision.capturedTitle === revisions[targetIndex]!.capturedTitle
      ? null
      : { before: baseRevision.capturedTitle, after: revisions[targetIndex]!.capturedTitle },
    canonicalUrlChanged:
      !baseRevision.metadataCaptured || !revisions[targetIndex]!.metadataCaptured || baseRevision.capturedCanonicalUrl === revisions[targetIndex]!.capturedCanonicalUrl
        ? null
        : {
            before: baseRevision.capturedCanonicalUrl,
            after: revisions[targetIndex]!.capturedCanonicalUrl,
          },
    ...diffRevisionMessages(baseMessages, targetMessages),
  };
}
