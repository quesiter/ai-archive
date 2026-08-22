import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverDeviceComponents,
  publicDeviceComponent,
  resolveDeviceComponent,
} from "../src/services/device-components.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function releaseRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ai-archive-components-"));
  roots.push(root);
  return root;
}

describe("device component discovery", () => {
  it("finds the newest matching archive for every supported platform", async () => {
    const root = await releaseRoot();
    await Promise.all([
      writeFile(join(root, "ai-archiveextension-V20260817-chrome.zip"), "chrome"),
      writeFile(join(root, "ai-archiveextension-V20260816-chrome.zip"), "older"),
      writeFile(join(root, "ai-conversation-archive-windows-sync-V20260817.zip"), "windows"),
      writeFile(join(root, "ai-conversation-archive-macos-sync-V20260817.tar.gz"), "macos"),
      writeFile(join(root, "ignore-me.zip"), "ignored"),
    ]);

    const components = await discoverDeviceComponents(root);
    expect(components.map((component) => component.id)).toEqual([
      "windows",
      "macos",
      "chrome",
    ]);
    expect(components.every((component) => component.available)).toBe(true);
    expect(components.find((component) => component.id === "chrome")?.version).toBe(
      "V20260817",
    );
    expect(
      publicDeviceComponent(components[0]!),
    ).not.toHaveProperty("absolutePath");
  });

  it("prefers the current semantic version track over legacy date versions", async () => {
    const root = await releaseRoot();
    await Promise.all([
      writeFile(join(root, "ai-archiveextension-V260822-4-chrome.zip"), "legacy"),
      writeFile(join(root, "ai-archiveextension-V2.0.0-chrome.zip"), "current"),
    ]);

    const components = await discoverDeviceComponents(root);
    expect(components.find((component) => component.id === "chrome")?.version).toBe("V2.0.0");
  });

  it("returns unavailable entries for a missing release directory", async () => {
    const root = await releaseRoot();
    const missing = join(root, "missing");
    const components = await discoverDeviceComponents(missing);
    expect(components).toHaveLength(3);
    expect(components.every((component) => !component.available)).toBe(true);
  });

  it("never serves a directory that merely matches an archive name", async () => {
    const root = await releaseRoot();
    await mkdir(join(root, "ai-archiveextension-V20260817-chrome.zip"));
    expect(await resolveDeviceComponent("chrome", root)).toBeNull();
  });
});
