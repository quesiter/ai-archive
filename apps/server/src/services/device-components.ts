import { realpath, readdir, stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { config } from "../config.js";

export type DeviceComponentId = "chrome" | "windows" | "macos";

export interface DeviceComponentDownload {
  id: DeviceComponentId;
  name: string;
  platform: string;
  description: string;
  archiveType: "zip" | "tar.gz";
  available: boolean;
  filename: string | null;
  version: string | null;
  sizeBytes: number | null;
  updatedAt: string | null;
  downloadUrl: string | null;
}

interface ComponentDefinition {
  id: DeviceComponentId;
  name: string;
  platform: string;
  description: string;
  archiveType: DeviceComponentDownload["archiveType"];
  pattern: RegExp;
}

const COMPONENT_DEFINITIONS: ComponentDefinition[] = [
  {
    id: "windows",
    name: "Windows 电脑上传组件",
    platform: "Windows 10/11",
    description: "同步本机 OpenClaw、Codex 和 Claude Code 对话，支持后台计划任务。",
    archiveType: "zip",
    pattern: /^ai-conversation-archive-windows-sync-(.+)\.zip$/i,
  },
  {
    id: "macos",
    name: "macOS 电脑上传组件",
    platform: "macOS",
    description: "同步本机 OpenClaw、Codex 和 Claude Code 对话，支持 LaunchAgent 后台运行。",
    archiveType: "tar.gz",
    pattern: /^ai-conversation-archive-macos-sync-(.+)\.tar\.gz$/i,
  },
  {
    id: "chrome",
    name: "Chrome 采集扩展",
    platform: "Chrome / Chromium",
    description: "采集 ChatGPT、Gemini、Grok、元宝等网页 AI 会话。",
    archiveType: "zip",
    pattern: /^ai-archiveextension-(.+)-chrome\.zip$/i,
  },
];

type ResolvedComponent = DeviceComponentDownload & { absolutePath: string | null };

function semanticVersion(value: string): number[] | null {
  const match = /^V?(\d+)\.(\d+)\.(\d+)$/i.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left: string, right: string): number {
  const leftSemantic = semanticVersion(left);
  const rightSemantic = semanticVersion(right);
  if (leftSemantic && rightSemantic) {
    for (let index = 0; index < leftSemantic.length; index += 1) {
      const difference = (leftSemantic[index] ?? 0) - (rightSemantic[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  }
  if (leftSemantic) return 1;
  if (rightSemantic) return -1;
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

async function safeReleaseRoot(releaseDirectory: string): Promise<string | null> {
  try {
    return await realpath(resolve(releaseDirectory));
  } catch {
    return null;
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

export async function discoverDeviceComponents(
  releaseDirectory = config.COMPONENT_RELEASE_DIR,
): Promise<ResolvedComponent[]> {
  const root = await safeReleaseRoot(releaseDirectory);
  const entries = root
    ? await readdir(root, { withFileTypes: true }).catch(() => [])
    : [];

  return Promise.all(
    COMPONENT_DEFINITIONS.map(async (definition): Promise<ResolvedComponent> => {
      const matches = entries
        .filter((entry) => entry.isFile() && definition.pattern.test(entry.name))
        .map((entry) => entry.name);
      const candidates = await Promise.all(
        matches.map(async (filename) => {
          if (!root) return null;
          const candidate = resolve(root, filename);
          try {
            const canonical = await realpath(candidate);
            if (!isWithinRoot(root, canonical)) return null;
            const fileStat = await stat(canonical);
            if (!fileStat.isFile()) return null;
            const match = definition.pattern.exec(filename);
            return {
              filename: basename(filename),
              version: match?.[1] ?? "",
              absolutePath: canonical,
              sizeBytes: fileStat.size,
              updatedAt: fileStat.mtime.toISOString(),
              modifiedAtMs: fileStat.mtimeMs,
            };
          } catch {
            return null;
          }
        }),
      );
      const selected = candidates
        .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
        .sort(
          (left, right) =>
            compareVersions(right.version, left.version) ||
            right.modifiedAtMs - left.modifiedAtMs ||
            right.filename.localeCompare(left.filename),
        )[0];
      return {
        id: definition.id,
        name: definition.name,
        platform: definition.platform,
        description: definition.description,
        archiveType: definition.archiveType,
        available: Boolean(selected),
        filename: selected?.filename ?? null,
        version: selected?.version ?? null,
        sizeBytes: selected?.sizeBytes ?? null,
        updatedAt: selected?.updatedAt ?? null,
        downloadUrl: selected
          ? `/api/v1/device-components/${definition.id}/download`
          : null,
        absolutePath: selected?.absolutePath ?? null,
      };
    }),
  );
}

export async function resolveDeviceComponent(
  id: DeviceComponentId,
  releaseDirectory = config.COMPONENT_RELEASE_DIR,
): Promise<ResolvedComponent | null> {
  const components = await discoverDeviceComponents(releaseDirectory);
  return components.find((component) => component.id === id && component.available) ?? null;
}

export function publicDeviceComponent(
  component: ResolvedComponent,
): DeviceComponentDownload {
  const { absolutePath: _absolutePath, ...payload } = component;
  return payload;
}
