import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import chokidar from "chokidar";

interface TranscriptWatchConfig {
  openClawRoot: string;
  codexRoots: string[];
  claudeCodeRoots: string[];
  grokBuildRoots?: string[];
}

type WatchScope = { provider: "openclaw" | "codex" | "claude_code" | "grok_build"; root: string };

function relativeParts(root: string, path: string): string[] | null {
  const value = relative(root, path);
  if (isAbsolute(value) || value === ".." || value.startsWith(`..${sep}`)) return null;
  return value ? value.split(sep) : [];
}

function allowedPath(scope: WatchScope, parts: string[], directory: boolean): boolean {
  if (!parts.length) return directory;
  if (parts.some((part) => /\.(?:bak|deleted|tmp|lock|migrated)$/.test(part))) return false;
  const name = parts.at(-1)!;
  if (scope.provider === "openclaw") {
    if (directory) return parts.length === 1 || (parts.length === 2 && parts[1] === "sessions");
    if (parts.length !== 3 || parts[1] !== "sessions") return false;
  } else if (scope.provider === "codex") {
    if (!directory && parts.length === 1 && name === "session_index.jsonl") return true;
    if (parts[0] !== "sessions" && parts[0] !== "archived_sessions") return false;
    if (parts[0] === "archived_sessions" && parts.length > (directory ? 1 : 2)) return false;
    if (directory) return true;
    if (!name.endsWith(".jsonl")) return false;
  } else if (scope.provider === "grok_build") {
    if (parts[0] !== "sessions") return false;
    if (directory) return parts.length <= 3;
    return parts.length === 4 && name === "updates.jsonl";
  } else {
    if (parts.some((part) => /key|token|cookie|credential/.test(part))) return false;
    if (directory) return true;
  }
  if (!/\.jsonl(?:\..+)?$/.test(name)) return false;
  return !/\.(?:bak|deleted|tmp|lock|migrated)$/.test(name) &&
    !/\.codex-app-server\.json(?:\..*)?$/.test(name);
}

function watchScopes(config: TranscriptWatchConfig): WatchScope[] {
  return [
    { provider: "openclaw", root: resolve(config.openClawRoot, "agents") },
    ...config.codexRoots.map((root) => ({ provider: "codex" as const, root: resolve(root) })),
    ...config.claudeCodeRoots.map((root) => ({ provider: "claude_code" as const, root: resolve(root) })),
    ...(config.grokBuildRoots ?? []).map((root) => ({ provider: "grok_build" as const, root: resolve(root) })),
  ];
}

/** Apply the same exclusions to scan results and filesystem events. */
export function createTranscriptPathFilter(config: TranscriptWatchConfig) {
  const scopes = watchScopes(config);
  return (provider: WatchScope["provider"], path: string) => scopes.some((scope) => {
    if (scope.provider !== provider) return false;
    const parts = relativeParts(scope.root, path);
    return parts !== null && allowedPath(scope, parts, false);
  });
}

async function existingAncestor(path: string): Promise<string> {
  try {
    const metadata = await lstat(path);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) return path;
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) ||
        (error.code !== "ENOENT" && error.code !== "ENOTDIR")) throw error;
  }
  const parent = dirname(path);
  if (parent === path) throw new Error(`No existing directory for transcript root: ${path}`);
  return existingAncestor(parent);
}

/** Chokidar 4 watches concrete paths; source matching stays in this filter. */
export async function createTranscriptWatcher(config: TranscriptWatchConfig) {
  const scopes = watchScopes(config);
  // Watch an existing ancestor for roots not created yet. Sharing one parent
  // watch also avoids several missing targets racing over Chokidar's tracking.
  const ancestors = [...new Set(await Promise.all(scopes.map((scope) => existingAncestor(scope.root))))];
  const watchRoots = ancestors.filter((root) => !ancestors.some((other) =>
    other !== root && relativeParts(other, root) !== null));
  return chokidar.watch(watchRoots, {
    ignoreInitial: true,
    followSymlinks: false,
    awaitWriteFinish: { stabilityThreshold: 1_000, pollInterval: 200 },
    ignored: (path: string, stats?: Stats) => {
      if (stats?.isSymbolicLink()) return true;
      // Missing roots require watching their existing ancestors until created.
      return !scopes.some((scope) => {
        const parts = relativeParts(scope.root, path);
        if (!parts) return relativeParts(resolve(path), scope.root) !== null;
        return stats ? allowedPath(scope, parts, stats.isDirectory()) :
          allowedPath(scope, parts, true) || allowedPath(scope, parts, false);
      });
    },
  });
}
