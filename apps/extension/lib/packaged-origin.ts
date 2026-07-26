const platformHosts = new Set([
  "chatgpt.com",
  "chat.openai.com",
  "gemini.google.com",
  "grok.com",
  "yuanbao.tencent.com",
  "agent.minimax.io",
  "agent.minimaxi.com",
  "chat.deepseek.com",
  "qianwen.com",
  "www.qianwen.com",
  "www.kimi.com",
  "kimi.com",
]);

declare const __ARCHIVE_SERVER_ORIGIN__: string | undefined;

function compiledServerOrigin(): string | undefined {
  try {
    if (
      typeof __ARCHIVE_SERVER_ORIGIN__ !== "undefined" &&
      __ARCHIVE_SERVER_ORIGIN__
    ) {
      return new URL(__ARCHIVE_SERVER_ORIGIN__).origin;
    }
  } catch {
    // Fall back to the manifest when running an older development build.
  }
  return undefined;
}

export function serverPermissionPattern(origin: string): string {
  const url = new URL(origin);
  const host = url.hostname.includes(":")
    ? `[${url.hostname.replace(/^\[|\]$/g, "")}]`
    : url.hostname;
  return `${url.protocol}//${host}/*`;
}

/**
 * The exact archive origin (including a non-standard port) is compiled into
 * the extension bundle. The manifest is retained as a fallback for older
 * development builds; Chrome host permission patterns intentionally omit the
 * port and therefore must not be used as the upload URL.
 */
export function packagedServerOrigin(): string {
  const compiled = compiledServerOrigin();
  if (compiled) return compiled;
  const manifest = browser.runtime.getManifest() as {
    optional_host_permissions?: string[];
  };
  for (const pattern of manifest.optional_host_permissions ?? []) {
    const origin = pattern.replace(/\/\*$/, "");
    try {
      const url = new URL(origin);
      if (
        ["http:", "https:"].includes(url.protocol) &&
        !platformHosts.has(url.hostname)
      ) {
        return url.origin;
      }
    } catch {
      // Ignore a malformed optional permission and continue looking.
    }
  }
  return "";
}
