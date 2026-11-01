import type { CaptureMessage, MessageSegment } from "@ai-archive/contracts";

const MAPBOX_ATTRIBUTION = "https://www.mapbox.com/";
const MAP_GESTURE_LABELS = ["Use two fingers to move the map", "长按 Ctrl 以缩放"] as const;

export type RenderingObservationClassification =
  | { renderingCovered: false }
  | {
    renderingCovered: true;
    /** An existing observation, returned unchanged; never a synthesized body. */
    cleanCandidate: CaptureMessage;
    /** Exact display blocks to retain as evidence, not instructions to delete. */
    removedMapText: { primary: string | null; observation: string | null };
  };

type ObservationParts = {
  text: string;
  withoutAttribution: readonly MessageSegment[];
  attributionCount: number;
};

function isMapboxAttribution(segment: MessageSegment): boolean {
  return segment.type === "citation" && segment.content === MAPBOX_ATTRIBUTION &&
    segment.href === MAPBOX_ATTRIBUTION && segment.language == null;
}

function observationParts(message: CaptureMessage): ObservationParts | undefined {
  const textSegments = message.segments.filter((segment) => segment.type === "text");
  if (textSegments.length !== 1) return;
  const withoutAttribution = message.segments.filter((segment) => !isMapboxAttribution(segment));
  return { text: textSegments[0]!.content, withoutAttribution,
    attributionCount: message.segments.length - withoutAttribution.length };
}

function sameSegments(left: readonly MessageSegment[], right: readonly MessageSegment[], ignoreText = false): boolean {
  return left.length === right.length && left.every((segment, index) => {
    const other = right[index]!;
    return segment.type === other.type && (segment.href ?? null) === (other.href ?? null) &&
      (segment.language ?? null) === (other.language ?? null) &&
      (ignoreText && segment.type === "text" || segment.content === other.content);
  });
}

/** Linear, exact one-block insertion proof. No substring/word normalization. */
function mapTextAddedTo(clean: ObservationParts, rendered: ObservationParts): string | undefined {
  if (clean.attributionCount !== 0 || rendered.attributionCount === 0 || rendered.text.length <= clean.text.length ||
    !sameSegments(clean.withoutAttribution, rendered.withoutAttribution, true) ||
    MAP_GESTURE_LABELS.some((label) => clean.text.includes(label))) return;
  let start = 0;
  while (start < clean.text.length && clean.text[start] === rendered.text[start]) start++;
  const length = rendered.text.length - clean.text.length;
  if (rendered.text.slice(start + length) !== clean.text.slice(start)) return;
  const added = rendered.text.slice(start, start + length);
  if (!MAP_GESTURE_LABELS.every((label) => added.includes(label))) return;
  return added;
}

/**
 * Classify saved observations that differ only by an explicitly identifiable
 * map display block and its attribution. This neither merges nor discards
 * observations, and proves nothing about conversation branches or chronology.
 */
export function classifyRenderingObservation(input: {
  primary: CaptureMessage;
  observation: CaptureMessage;
  candidates?: readonly CaptureMessage[];
}): RenderingObservationClassification {
  const { primary, observation } = input;
  const id = primary.externalMessageId;
  if (!id?.trim() || /^(?:turn|conversation-turn)-\d+$/i.test(id) ||
    primary.role !== "assistant" || observation.role !== "assistant" || observation.externalMessageId !== id ||
    sameSegments(primary.segments, observation.segments)) return { renderingCovered: false };
  const cache = new Map<CaptureMessage, ObservationParts | undefined>();
  const parts = (message: CaptureMessage) => {
    if (!cache.has(message)) cache.set(message, observationParts(message));
    return cache.get(message);
  };
  const primaryParts = parts(primary);
  const observationPartsValue = parts(observation);
  if (!primaryParts || !observationPartsValue) return { renderingCovered: false };

  const primaryMapText = mapTextAddedTo(observationPartsValue, primaryParts);
  if (primaryMapText !== undefined) return { renderingCovered: true, cleanCandidate: observation,
    removedMapText: { primary: primaryMapText, observation: null } };
  const observationMapText = mapTextAddedTo(primaryParts, observationPartsValue);
  if (observationMapText !== undefined) return { renderingCovered: true, cleanCandidate: primary,
    removedMapText: { primary: null, observation: observationMapText } };

  // Two map renderings can reorder POIs. Both must independently reproduce
  // the same existing clean observation outside their exact added map block.
  for (const candidate of input.candidates ?? []) {
    if (candidate === primary || candidate === observation || candidate.externalMessageId !== id || candidate.role !== "assistant") continue;
    const candidateParts = parts(candidate);
    if (!candidateParts) continue;
    const primaryAdded = mapTextAddedTo(candidateParts, primaryParts);
    if (primaryAdded === undefined) continue;
    const observationAdded = mapTextAddedTo(candidateParts, observationPartsValue);
    if (observationAdded !== undefined) return { renderingCovered: true, cleanCandidate: candidate,
      removedMapText: { primary: primaryAdded, observation: observationAdded } };
  }
  return { renderingCovered: false };
}
