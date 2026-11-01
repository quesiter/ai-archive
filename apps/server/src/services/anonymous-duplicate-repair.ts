import type { CaptureMessage } from "@ai-archive/contracts";

/** Repair exact mixed-ID copies corroborated by adjacency or parallel ordered runs.
 * Anonymous repeats and distinct stable IDs are never globally deduplicated. */
function repairAnonymousPass(input: readonly CaptureMessage[]) {
  const sorted = [...input].sort((a, b) => a.ordinal - b.ordinal);
  const body = (message: CaptureMessage) => JSON.stringify([message.role, message.segments]);
  const identified = new Map<string, number[]>();
  const runIds: number[] = [];
  let run = 0;
  sorted.forEach((message,index) => {
    if (index && Boolean(message.externalMessageId) !== Boolean(sorted[index-1]!.externalMessageId)) run++;
    runIds.push(run);
    if (message.externalMessageId) {
      const key = body(message);
      identified.set(key,[...(identified.get(key) ?? []),index]);
    }
  });
  const remove = new Set<CaptureMessage>();
  const protectedAnonymous = new Set<CaptureMessage>();
  const anonymousCounts = new Map<string,number>();
  for (const message of sorted) if (!message.externalMessageId) anonymousCounts.set(body(message),(anonymousCounts.get(body(message)) ?? 0)+1);
  for (let start = 0; start < sorted.length;) {
    let limit = start + 1;
    while (limit < sorted.length && runIds[limit] === runIds[start]) limit++;
    if (!sorted[start]!.externalMessageId) {
      const counts = new Map<string,number>();
      for (let index = start; index < limit; index++) {
        const key = body(sorted[index]!);
        counts.set(key,(counts.get(key) ?? 0)+1);
      }
      const pairs: Array<{ anonymous: number; identified: number }> = [];
      for (let index = start; index < limit; index++) {
        const key = body(sorted[index]!);
        const candidates = identified.get(key);
        if (counts.get(key) === 1 && candidates?.length === 1) pairs.push({ anonymous: index, identified: candidates[0]! });
      }
      // A retained prefix can split the identified observation into runs.
      // Corroborate each ordered run independently, leaving unmatched copies.
      const groups = new Map<number,typeof pairs>();
      for (const pair of pairs) {
        const key = runIds[pair.identified]!;
        groups.set(key,[...(groups.get(key) ?? []),pair]);
      }
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        // Match only a noncrossing ordered subsequence. Other observations can
        // be historical branches or order conflicts and stay independently saved.
        const tails: number[] = [];
        const previous = new Int32Array(group.length).fill(-1);
        for (let index = 0; index < group.length; index++) {
          let low = 0;
          let high = tails.length;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (group[tails[middle]!]!.identified < group[index]!.identified) low = middle + 1;
            else high = middle;
          }
          if (low) previous[index] = tails[low-1]!;
          tails[low] = index;
        }
        if (tails.length >= 2) {
          for (let index = tails.at(-1)!; index >= 0; index = previous[index]!) remove.add(sorted[group[index]!.anonymous]!);
        } else {
          for (let index = start; index < limit; index++) protectedAnonymous.add(sorted[index]!);
        }
      }
    }
    start = limit;
  }
  const messages: CaptureMessage[] = [];
  for (const message of sorted) {
    if (remove.has(message)) continue;
    const previous = messages.at(-1);
    if (previous && Boolean(previous.externalMessageId) !== Boolean(message.externalMessageId) && body(previous) === body(message) &&
      identified.get(body(message))?.length === 1 && anonymousCounts.get(body(message)) === 1 &&
      !protectedAnonymous.has(message) && !protectedAnonymous.has(previous)) {
      if (previous.externalMessageId) remove.add(message);
      else { remove.add(previous); messages[messages.length-1] = message; }
    } else messages.push(message);
  }
  return { messages, removed: sorted.filter(message => remove.has(message)) };
}
export function repairAnonymousDuplicates(input: readonly CaptureMessage[]) {
  let messages = [...input];
  const removed: CaptureMessage[] = [];
  while (true) {
    const result = repairAnonymousPass(messages);
    messages = result.messages;
    removed.push(...result.removed);
    if (!result.removed.length) break;
  }
  return { messages: messages.map((message,ordinal) => ({ ...message,ordinal })), removed };
}