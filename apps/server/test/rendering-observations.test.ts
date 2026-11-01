import type { CaptureMessage, MessageSegment } from "@ai-archive/contracts";
import { describe, expect, it } from "vitest";
import { classifyRenderingObservation } from "../src/services/rendering-observations.js";

const id = "00000000-0000-4000-8000-000000000001";
const gesture = "Use two fingers to move the map长按 Ctrl 以缩放";
const mapBlock = `4.4Park4.6Museum${gesture}`;
const attribution: MessageSegment = { type: "citation", content: "https://www.mapbox.com/", href: "https://www.mapbox.com/" };
const clean = (): CaptureMessage => ({ ordinal: 3, externalMessageId: id, role: "assistant", model: "recorded-model",
  createdAt: "2026-09-14T00:00:00.000Z", segments: [
    { type: "text", content: "Introduction.\nDay one: visit the museum.\nDay two: visit the park." },
    { type: "code", content: "const museum = true;", language: "js" },
    { type: "citation", content: "Museum hours", href: "https://example.test/museum" },
  ] });
const rendered = (base = clean(), block = mapBlock): CaptureMessage => ({ ...structuredClone(base),
  segments: base.segments.map((segment) => segment.type === "text" ? { ...segment,
    content: segment.content.replace("Introduction.\n", `Introduction.\n${block}`) } : { ...segment }).concat({ ...attribution }) });

describe("saved map rendering observations", () => {
  it("classifies an exact display insertion and returns the existing clean observation without changing either input", () => {
    const observation = clean();
    const primary = rendered(observation);
    const before = structuredClone({ primary, observation });
    const result = classifyRenderingObservation({ primary, observation });
    expect(result).toEqual({ renderingCovered: true, cleanCandidate: observation,
      removedMapText: { primary: mapBlock, observation: null } });
    if (result.renderingCovered) expect(result.cleanCandidate).toBe(observation);
    expect({ primary, observation }).toEqual(before);
  });

  it("also classifies a saved rendered variant against a clean primary", () => {
    const primary = clean();
    const observation = rendered(primary);
    expect(classifyRenderingObservation({ primary, observation })).toEqual({ renderingCovered: true,
      cleanCandidate: primary, removedMapText: { primary: null, observation: mapBlock } });
  });

  it("requires an existing common clean observation to explain two different POI orders", () => {
    const candidate = clean();
    const primary = rendered(candidate);
    const reorderedBlock = `4.6Museum4.4Park${gesture}`;
    const observation = rendered(candidate, reorderedBlock);
    expect(classifyRenderingObservation({ primary, observation })).toEqual({ renderingCovered: false });
    expect(classifyRenderingObservation({ primary, observation, candidates: [candidate] })).toEqual({
      renderingCovered: true, cleanCandidate: candidate,
      removedMapText: { primary: mapBlock, observation: reorderedBlock },
    });
  });

  it("does not substitute a different ID, role, code, or unique prose as the common clean anchor", () => {
    const primary = rendered();
    const observation = rendered(clean(), `4.6Museum4.4Park${gesture}`);
    const differentId = { ...clean(), externalMessageId: "another-id" };
    const differentRole = { ...clean(), role: "user" as const };
    const differentCode = clean(); differentCode.segments[1]!.content = "const museum = false;";
    const uniqueProse = clean(); uniqueProse.segments[0]!.content += "New unique advice.";
    expect(classifyRenderingObservation({ primary, observation,
      candidates: [differentId, differentRole, differentCode, uniqueProse] })).toEqual({ renderingCovered: false });
  });

  const changedSegments: Array<[string, (message: CaptureMessage) => void]> = [
    ["code", (message) => { message.segments[1]!.content = "const museum = false;"; }],
    ["code language", (message) => { message.segments[1]!.language = "ts"; }],
    ["citation target", (message) => { message.segments[2]!.href = "https://example.test/another-museum"; }],
    ["citation label even with the same target", (message) => { message.segments[2]!.content = "Museum reservations"; }],
    ["extra citation with the same target", (message) => { message.segments.push({ ...message.segments[2]!, content: "Museum reservations" }); }],
    ["text link metadata", (message) => { message.segments[0]!.href = "https://example.test/text"; }],
    ["nontext order", (message) => { [message.segments[1], message.segments[2]] = [message.segments[2]!, message.segments[1]!]; }],
    ["text position among other segments", (message) => { [message.segments[0], message.segments[1]] = [message.segments[1]!, message.segments[0]!]; }],
    ["another text segment", (message) => { message.segments.push({ type: "text", content: "Additional independent advice." }); }],
    ["changed word outside the map", (message) => { message.segments[0]!.content = message.segments[0]!.content.replace("museum.", "library."); }],
    ["another inserted passage", (message) => { message.segments[0]!.content += "\nKeep this unique new instruction."; }],
    ["standalone carriage return", (message) => { message.segments[0]!.content += "\r"; }],
  ];
  it.each(changedSegments)("retains differences involving %s as unclassified content", (_name, mutate) => {
    const observation = clean(); const primary = rendered(observation); mutate(primary);
    expect(classifyRenderingObservation({ primary, observation })).toEqual({ renderingCovered: false });
  });

  it.each([
    "Park and Museum are ordinary itinerary text.",
    "4.4Park4.6MuseumUse two fingers to move the map",
    "4.4Park4.6Museum长按 Ctrl 以缩放",
  ])("does not classify ordinary place names or only one interaction label: %s", (block) => {
    const observation = clean();
    expect(classifyRenderingObservation({ primary: rendered(observation, block), observation })).toEqual({ renderingCovered: false });
  });

  it.each(["missing", "other-url", "other-label", "language"] as const)("requires the exact Mapbox attribution (%s)", (change) => {
    const observation = clean(); const primary = rendered(observation);
    if (change === "missing") primary.segments.pop();
    if (change === "other-url") primary.segments.at(-1)!.href = "https://www.mapbox.com/unrelated";
    if (change === "other-label") primary.segments.at(-1)!.content = "Mapbox";
    if (change === "language") primary.segments.at(-1)!.language = "en";
    expect(classifyRenderingObservation({ primary, observation })).toEqual({ renderingCovered: false });
  });

  it.each([undefined, " ", "turn-3", "conversation-turn-3"])("does not infer rendering identity from missing or positional IDs (%s)", (externalMessageId) => {
    const observation = clean(); const primary = rendered(observation);
    if (externalMessageId === undefined) { delete primary.externalMessageId; delete observation.externalMessageId; }
    else { primary.externalMessageId = externalMessageId; observation.externalMessageId = externalMessageId; }
    expect(classifyRenderingObservation({ primary, observation })).toEqual({ renderingCovered: false });
  });

  it("keeps a user table or preview and any role mismatch outside the rendering classification", () => {
    const observation = { ...clean(), role: "user" as const };
    const primary = { ...rendered(observation), role: "user" as const };
    expect(classifyRenderingObservation({ primary, observation })).toEqual({ renderingCovered: false });
    primary.role = "user";
    expect(classifyRenderingObservation({ primary: { ...primary, role: "assistant" }, observation })).toEqual({ renderingCovered: false });
  });

  it("does not equate multiple missing narrative ranges with one display block", () => {
    const primary = rendered();
    const observation = clean();
    observation.segments[0]!.content = "Introduction.\nDay one: museum.\nDay two: park.";
    expect(classifyRenderingObservation({ primary, observation })).toEqual({ renderingCovered: false });
  });

  it("requires text insertion evidence, not an attribution-only or identical-body change", () => {
    const observation = clean();
    const attributionOnly = { ...clean(), segments: [...clean().segments, { ...attribution }] };
    expect(classifyRenderingObservation({ primary: attributionOnly, observation })).toEqual({ renderingCovered: false });
    const primary = rendered();
    expect(classifyRenderingObservation({ primary, observation: structuredClone(primary), candidates: [clean()] }))
      .toEqual({ renderingCovered: false });
  });
});
