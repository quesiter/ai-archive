import { createHash } from "node:crypto";
import type { CaptureMessage } from "@ai-archive/contracts";

export interface ConversationMergeConflict {
  type: "content" | "order" | "disconnected";
  previous?: CaptureMessage;
  incoming?: CaptureMessage;
  messageIds?: string[];
}

const normalizedBodies = new WeakMap<CaptureMessage, string>();
const messageIdentities = new WeakMap<CaptureMessage, string>();

function body(message: CaptureMessage): string {
  const cached = normalizedBodies.get(message);
  if (cached !== undefined) return cached;
  const value = JSON.stringify({
    role: message.role,
    segments: message.segments.map((segment) => ({
      type: segment.type,
      content: segment.type === "code" ? segment.content.replace(/\r+\n/g, "\n") : segment.content.replace(/\r+\n/g, "\n").trim(),
      href: segment.href ?? null,
      language: segment.language ?? null,
    })),
  });
  normalizedBodies.set(message, value);
  return value;
}

function identity(message: CaptureMessage): string {
  if (message.externalMessageId) return `id:${message.externalMessageId}`;
  const cached = messageIdentities.get(message);
  if (cached !== undefined) return cached;
  // Hydrated delta prefixes share immutable message objects. Reuse their
  // content identity across window alignment and successive historical folds.
  const value = `body:${createHash("sha256").update(body(message)).digest("hex")}`;
  messageIdentities.set(message, value);
  return value;
}

function sameMessage(left: CaptureMessage, right: CaptureMessage): boolean {
  return (left.externalMessageId ?? null) === (right.externalMessageId ?? null) && body(left) === body(right);
}

function sequenceEqual(left: readonly CaptureMessage[], right: readonly CaptureMessage[]): boolean {
  return left.length === right.length && left.every((message, index) => sameMessage(message, right[index]!));
}

// Match a complete observed window, without globally deduplicating repeated
// anonymous messages such as consecutive "continue" requests.
function windowStart(existing: readonly string[], incoming: readonly string[]): number {
  if (!incoming.length) return 0;
  const prefix = new Array<number>(incoming.length).fill(0);
  for (let index = 1, matched = 0; index < incoming.length; index++) {
    while (matched && incoming[index] !== incoming[matched]) matched = prefix[matched - 1]!;
    if (incoming[index] === incoming[matched]) matched++;
    prefix[index] = matched;
  }
  for (let index = 0, matched = 0; index < existing.length; index++) {
    while (matched && existing[index] !== incoming[matched]) matched = prefix[matched - 1]!;
    if (existing[index] === incoming[matched]) matched++;
    if (matched === incoming.length) return index - matched + 1;
  }
  return -1;
}

function suffixPrefix(left: readonly string[], right: readonly string[]): number {
  if (!right.length) return 0;
  const prefix = new Array<number>(right.length).fill(0);
  for (let index = 1, matched = 0; index < right.length; index++) {
    while (matched && right[index] !== right[matched]) matched = prefix[matched - 1]!;
    if (right[index] === right[matched]) matched++;
    prefix[index] = matched;
  }
  let matched = 0;
  for (const key of left) {
    while (matched && (matched === right.length || key !== right[matched])) matched = prefix[matched - 1]!;
    if (key === right[matched]) matched++;
  }
  return matched;
}

type AlignedPosition = { oldIndex: number; newIndex: number };
const MAX_ALIGNMENT_CELLS = 250_000;
const TOTAL_ALIGNMENT_CELLS = 1_000_000;

/** An ordered observation may omit saved messages without being a new copy. */
function subsequencePositions(haystack: readonly string[], needle: readonly string[]): number[] | null {
  const positions: number[] = [];
  let cursor = 0;
  for (const value of needle) {
    while (cursor < haystack.length && haystack[cursor] !== value) cursor++;
    if (cursor === haystack.length) return null;
    positions.push(cursor++);
  }
  return positions;
}

function uniqueOrderedAnchors(old: readonly string[], next: readonly string[]): AlignedPosition[] {
  const uniquePositions = (values: readonly string[]) => {
    const positions = new Map<string, number>();
    values.forEach((value, index) => positions.set(value, positions.has(value) ? -1 : index));
    return positions;
  };
  const oldPositions = uniquePositions(old);
  const nextPositions = uniquePositions(next);
  const candidates: AlignedPosition[] = [];
  next.forEach((value, newIndex) => {
    const oldIndex = oldPositions.get(value);
    if (oldIndex !== undefined && oldIndex >= 0 && nextPositions.get(value) === newIndex) candidates.push({ oldIndex, newIndex });
  });
  // Patience anchors: only noncrossing unique observations delimit a range in
  // which repeated anonymous messages can be matched by their local order.
  const tails: number[] = [];
  const previous = new Int32Array(candidates.length).fill(-1);
  for (let index = 0; index < candidates.length; index++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (candidates[tails[middle]!]!.oldIndex < candidates[index]!.oldIndex) low = middle + 1;
      else high = middle;
    }
    if (low) previous[index] = tails[low - 1]!;
    tails[low] = index;
  }
  const anchors: AlignedPosition[] = [];
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]!) anchors.push(candidates[index]!);
  return anchors.reverse();
}

function alignAnonymousObservations(old: readonly string[], next: readonly string[]): { positions: Map<number, number>; approximate: boolean } {
  const positions = new Map<number, number>();
  if (!old.length || !next.length) return { positions, approximate: false };
  const wholeWindow = windowStart(old, next);
  if (wholeWindow >= 0) {
    next.forEach((_, index) => positions.set(index, wholeWindow + index));
    return { positions, approximate: false };
  }
  const previousWindow = windowStart(next, old);
  if (previousWindow >= 0) {
    old.forEach((_, index) => positions.set(previousWindow + index, index));
    return { positions, approximate: false };
  }
  // The merged result is a common supersequence. Checking subsequences first
  // makes every repeated observation idempotent even after alternate anonymous
  // wording was retained between its original neighbors.
  const containedNext = subsequencePositions(old, next);
  if (containedNext) {
    containedNext.forEach((oldIndex, newIndex) => positions.set(newIndex, oldIndex));
    return { positions, approximate: false };
  }
  const containedOld = subsequencePositions(next, old);
  if (containedOld) {
    containedOld.forEach((newIndex, oldIndex) => positions.set(newIndex, oldIndex));
    return { positions, approximate: false };
  }

  const anchors = uniqueOrderedAnchors(old, next);
  if (!anchors.length) {
    const appendOverlap = suffixPrefix(old, next);
    const prependOverlap = suffixPrefix(next, old);
    if (appendOverlap >= 2 && appendOverlap >= prependOverlap) {
      for (let index = 0; index < appendOverlap; index++) positions.set(index, old.length - appendOverlap + index);
      return { positions, approximate: false };
    }
    if (prependOverlap >= 2) {
      for (let index = 0; index < prependOverlap; index++) positions.set(next.length - prependOverlap + index, index);
      return { positions, approximate: false };
    }
  }

  let remainingCells = TOTAL_ALIGNMENT_CELLS;
  let approximate = false;
  const alignRange = (oldStart: number, oldEnd: number, nextStart: number, nextEnd: number) => {
    while (oldStart < oldEnd && nextStart < nextEnd && old[oldStart] === next[nextStart]) positions.set(nextStart++, oldStart++);
    while (oldStart < oldEnd && nextStart < nextEnd && old[oldEnd - 1] === next[nextEnd - 1]) positions.set(--nextEnd, --oldEnd);
    const oldLength = oldEnd - oldStart;
    const nextLength = nextEnd - nextStart;
    if (!oldLength || !nextLength) return;
    const cells = (oldLength + 1) * (nextLength + 1);
    if (cells <= MAX_ALIGNMENT_CELLS && cells <= remainingCells) {
      remainingCells -= cells;
      const width = nextLength + 1;
      const lengths = new Uint32Array(cells);
      for (let left = oldLength - 1; left >= 0; left--) {
        for (let right = nextLength - 1; right >= 0; right--) {
          lengths[left * width + right] = old[oldStart + left] === next[nextStart + right]
            ? 1 + lengths[(left + 1) * width + right + 1]!
            : Math.max(lengths[(left + 1) * width + right]!, lengths[left * width + right + 1]!);
        }
      }
      let left = 0;
      let right = 0;
      while (left < oldLength && right < nextLength) {
        if (old[oldStart + left] === next[nextStart + right]) positions.set(nextStart + right++, oldStart + left++);
        else if (lengths[(left + 1) * width + right]! >= lengths[left * width + right + 1]!) left++;
        else right++;
      }
      return;
    }
    // Bound both memory and total DP work. Large unanchored ranges still match
    // occurrences one-to-one in order; uncertain alignment is never certified.
    approximate = true;
    const occurrences = new Map<string, number[]>();
    for (let index = oldStart; index < oldEnd; index++) {
      const indices = occurrences.get(old[index]!) ?? [];
      indices.push(index);
      occurrences.set(old[index]!, indices);
    }
    let cursor = oldStart;
    for (let index = nextStart; index < nextEnd; index++) {
      const indices = occurrences.get(next[index]!);
      if (!indices) continue;
      let low = 0;
      let high = indices.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (indices[middle]! < cursor) low = middle + 1;
        else high = middle;
      }
      if (low < indices.length) { positions.set(index, indices[low]!); cursor = indices[low]! + 1; }
    }
  };
  let oldStart = 0;
  let nextStart = 0;
  for (const anchor of [...anchors, { oldIndex: old.length, newIndex: next.length }]) {
    alignRange(oldStart, anchor.oldIndex, nextStart, anchor.newIndex);
    if (anchor.oldIndex < old.length) positions.set(anchor.newIndex, anchor.oldIndex);
    oldStart = anchor.oldIndex + 1;
    nextStart = anchor.newIndex + 1;
  }
  return { positions, approximate };
}

/** Bridge ID-less and identified observations only through an ordered window
 * or exact unique bodies between shared ID anchors. Never merge distinct IDs. */
function reconcileObservationIds(existingInput: CaptureMessage[], incomingInput: CaptureMessage[]) {
  const existing = [...existingInput];
  const incoming = [...incomingInput];
  if (!existing.some(message => !message.externalMessageId) && !incoming.some(message => !message.externalMessageId)) return { existing, incoming };
  const oldBodies = existing.map(body);
  const nextBodies = incoming.map(body);
  const compatible = (oldIndex: number, newIndex: number) => {
    const left = existing[oldIndex]!;
    const right = incoming[newIndex]!;
    return oldBodies[oldIndex] === nextBodies[newIndex] &&
      (!left.externalMessageId || !right.externalMessageId || left.externalMessageId === right.externalMessageId);
  };
  const adopt = (oldIndex: number, newIndex: number) => {
    if (!compatible(oldIndex, newIndex)) return;
    const id = existing[oldIndex]!.externalMessageId ?? incoming[newIndex]!.externalMessageId;
    if (!id) return;
    if (!existing[oldIndex]!.externalMessageId) existing[oldIndex] = { ...existing[oldIndex]!, externalMessageId: id };
    if (!incoming[newIndex]!.externalMessageId) incoming[newIndex] = { ...incoming[newIndex]!, externalMessageId: id };
  };
  // A uniquely positioned complete body window preserves occurrence counts,
  // including repeated prompts. An isolated partial prompt is not an anchor.
  const matchWindow = (long: string[], short: string[], reversed: boolean) => {
    if (!short.length || (short.length < 2 && long.length !== short.length)) return false;
    const start = windowStart(long, short);
    if (start < 0 || windowStart(long.slice(start + 1), short) >= 0) return false;
    const pairs = short.map((_, index) => reversed
      ? { oldIndex: index, newIndex: start + index }
      : { oldIndex: start + index, newIndex: index });
    if (!pairs.every(({ oldIndex, newIndex }) => compatible(oldIndex, newIndex))) return false;
    pairs.forEach(({ oldIndex, newIndex }) => adopt(oldIndex, newIndex));
    return true;
  };
  if (matchWindow(oldBodies, nextBodies, false) || matchWindow(nextBodies, oldBodies, true)) return { existing, incoming };
  const oldIds = existing.map((message, index) => message.externalMessageId ? `id:${message.externalMessageId}` : `old:${index}`);
  const nextIds = incoming.map((message, index) => message.externalMessageId ? `id:${message.externalMessageId}` : `next:${index}`);
  const anchors = uniqueOrderedAnchors(oldIds, nextIds);
  if (!anchors.length) {
    const bodyAnchors = uniqueOrderedAnchors(oldBodies, nextBodies).filter(({ oldIndex, newIndex }) => compatible(oldIndex, newIndex));
    if (bodyAnchors.length >= 2) {
      bodyAnchors.forEach(({ oldIndex, newIndex }) => adopt(oldIndex,newIndex));
    } else if (existing.length === incoming.length && existing.every((message,index) => {
      const next = incoming[index]!;
      return message.role === next.role && (!message.externalMessageId || !next.externalMessageId || message.externalMessageId === next.externalMessageId);
    })) {
      // The same whole turn layout may contain revised assistant wording.
      // Promote only exact user bodies, preserving every different response.
      existing.forEach((message,index) => { if (message.role === "user") adopt(index,index); });
    }
    return { existing, incoming };
  }
  let oldStart = 0;
  let nextStart = 0;
  for (const anchor of [...anchors, { oldIndex: existing.length, newIndex: incoming.length }]) {
    const uniqueBodies = (bodies: string[], start: number, end: number) => {
      const positions = new Map<string, number>();
      for (let index = start; index < end; index++) {
        const value = bodies[index]!;
        positions.set(value, positions.has(value) ? -1 : index);
      }
      return positions;
    };
    const oldPositions = uniqueBodies(oldBodies, oldStart, anchor.oldIndex);
    const nextPositions = uniqueBodies(nextBodies, nextStart, anchor.newIndex);
    for (const [value, oldIndex] of oldPositions) {
      const newIndex = nextPositions.get(value);
      if (oldIndex >= 0 && newIndex !== undefined && newIndex >= 0) adopt(oldIndex, newIndex);
    }
    oldStart = anchor.oldIndex + 1;
    nextStart = anchor.newIndex + 1;
  }
  return { existing, incoming };
}
/** Merge observations into one conversation. Absence never deletes a message. */
export function mergeConversationMessages(
  existingInput: readonly CaptureMessage[],
  incomingInput: readonly CaptureMessage[],
  options: { allowKnownPrefixReorder?: boolean } = {},
): {
  messages: CaptureMessage[];
  changed: boolean;
  orderReliable: boolean;
  sourceMatchesArchive: boolean;
  conflicts: ConversationMergeConflict[];
} {
  const originalExisting = [...existingInput].sort((a, b) => a.ordinal - b.ordinal);
  const { existing, incoming } = reconcileObservationIds(originalExisting, [...incomingInput].sort((a, b) => a.ordinal - b.ordinal));
  const conflicts: ConversationMergeConflict[] = [];
  const oldKeys: string[] = [];
  const values = new Map<string, CaptureMessage>();
  const anonymousCounts = new Map<string, number>();
  for (const message of existing) {
    let key = identity(message);
    if (!message.externalMessageId) {
      const count = anonymousCounts.get(key) ?? 0;
      anonymousCounts.set(key, count + 1);
      key += `:${count}`;
    }
    if (values.has(key)) {
      if (!sameMessage(values.get(key)!, message)) conflicts.push({ type: "content", previous: values.get(key)!, incoming: message });
      continue;
    }
    oldKeys.push(key);
    values.set(key, message);
  }

  const incomingIdentities = incoming.map(identity);
  const existingIdentities = oldKeys.map((key) => identity(values.get(key)!));
  const alignment = incoming.some((message) => !message.externalMessageId)
    ? alignAnonymousObservations(existingIdentities, incomingIdentities) : { positions: new Map<number, number>(), approximate: false };
  if (alignment.approximate) conflicts.push({ type: "order", messageIds: [] });

  const newKeys: string[] = [];
  const seen = new Set<string>();
  for (const [index, message] of incoming.entries()) {
    const signature = identity(message);
    let key = `${signature}:new:${index}`;
    if (message.externalMessageId) key = signature;
    else if (alignment.positions.has(index)) key = oldKeys[alignment.positions.get(index)!]!;
    if (seen.has(key)) {
      const previous = values.get(key)!;
      if (!sameMessage(previous, message)) conflicts.push({ type: "content", previous, incoming: message });
      conflicts.push({ type: "order", messageIds: message.externalMessageId ? [message.externalMessageId] : [] });
      continue;
    }
    seen.add(key);
    newKeys.push(key);
    const previous = values.get(key);
    // DOM observations often have no source timestamp. A later native read
    // can supply it even when the body is identical (or a shorter rendering).
    // Keep recorded source metadata, and enrich only fields that were absent.
    const metadata = previous ? {
      ...(previous.createdAt ?? message.createdAt ? { createdAt: previous.createdAt ?? message.createdAt } : {}),
      ...(previous.model ?? message.model ? { model: previous.model ?? message.model } : {}),
    } : {};
    if (previous && !sameMessage(previous, message)) {
      // A rendering shell may omit entire segments. Only exact segment-prefix
      // expansion is safe without preserving an alternative observation.
      const segmentPrefix = (short: CaptureMessage, long: CaptureMessage) => short.role === long.role &&
        short.segments.length <= long.segments.length && short.segments.every((segment, ordinal) => {
          const next = long.segments[ordinal]!;
          return segment.type === next.type && (segment.href ?? null) === (next.href ?? null) &&
            (segment.language ?? null) === (next.language ?? null) && next.content.startsWith(segment.content);
        });
      if (segmentPrefix(message, previous)) {
        values.set(key, { ...previous, ...metadata });
        continue;
      }
      if (!segmentPrefix(previous, message)) conflicts.push({ type: "content", previous, incoming: message });
      values.set(key, { ...message, ...metadata });
    } else if (!previous) values.set(key, message);
    else values.set(key, { ...previous, ...metadata });
  }

  const oldPositions = new Map(oldKeys.map((key, index) => [key, index]));
  const shared = new Set(newKeys.filter((key) => oldPositions.has(key)));
  let resultKeys: string[];
  if (!oldKeys.length) resultKeys = newKeys;
  else if (!newKeys.length) resultKeys = oldKeys;
  else if (!shared.size) {
    // Save disconnected observations, but never claim their relative order or
    // that merely concatenating two windows establishes complete coverage.
    resultKeys = [...oldKeys, ...newKeys];
    conflicts.push({ type: "disconnected", messageIds: incoming.flatMap((message) => message.externalMessageId ? [message.externalMessageId] : []) });
  } else {
    const observedPositions = newKeys.filter((key) => shared.has(key)).map((key) => oldPositions.get(key)!);
    if (observedPositions.some((position, index) => index > 0 && position < observedPositions[index - 1]!)) {
      conflicts.push({ type: "order", messageIds: newKeys.filter((key) => shared.has(key)).map((key) => values.get(key)!.externalMessageId).filter((id): id is string => Boolean(id)) });
    }
    // Preserve the already saved prefix even when a later scan starts halfway
    // down the conversation. The new observation orders its shared anchors;
    // older runs absent from it stay attached before their next known anchor.
    const firstShared = oldKeys.findIndex((key) => shared.has(key));
    const prefix = oldKeys.slice(0, firstShared);
    const before = new Map<string, string[]>();
    let pending: string[] = [];
    for (const key of oldKeys.slice(firstShared)) {
      if (shared.has(key)) {
        if (pending.length) before.set(key, pending);
        pending = [];
      } else pending.push(key);
    }
    const suffix = pending;
    if (suffix.length && newKeys.some((key) => !oldPositions.has(key))) {
      conflicts.push({ type: "order", messageIds: suffix.map((key) => values.get(key)!.externalMessageId).filter((id): id is string => Boolean(id)) });
    }
    resultKeys = [...prefix];
    for (const key of newKeys) resultKeys.push(...(before.get(key) ?? []), key);
    resultKeys.push(...suffix);
    // A new run and a retained run between the same anchors have no established
    // relative order; both stay saved and the uncertainty is surfaced.
    let previousIncomingWasNew = false;
    for (const key of newKeys) {
      if (previousIncomingWasNew && before.get(key)?.length) conflicts.push({ type: "order", messageIds: before.get(key)!.map((id) => values.get(id)!.externalMessageId).filter((id): id is string => Boolean(id)) });
      previousIncomingWasNew = !shared.has(key);
    }
  }
  if (oldKeys.length && !options.allowKnownPrefixReorder) {
    const savedFirst = resultKeys.indexOf(oldKeys[0]!);
    const firstKnown = resultKeys.findIndex((key) => oldPositions.has(key));
    if (savedFirst > firstKnown && firstKnown >= 0) {
      resultKeys.splice(savedFirst, 1);
      resultKeys.splice(firstKnown, 0, oldKeys[0]!);
    }
  }
  const messages = [...new Set(resultKeys)].map((key, ordinal) => {
    const value = values.get(key)!;
    return value.ordinal === ordinal ? value : { ...value, ordinal };
  });
  return {
    messages,
    changed: !sequenceEqual(originalExisting, messages) || originalExisting.some((message, index) =>
      (message.createdAt ?? null) !== (messages[index]?.createdAt ?? null) ||
      (message.model ?? null) !== (messages[index]?.model ?? null)),
    orderReliable: !conflicts.some((conflict) => conflict.type !== "content"),
    sourceMatchesArchive: sequenceEqual(incoming, messages),
    conflicts,
  };
}
