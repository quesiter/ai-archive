import { defineConfig } from "wxt";

const archiveServerOrigin = new URL(
  process.env.ARCHIVE_SERVER_ORIGIN ?? "https://ai-archive.gyee.tech:18443",
).origin;
const archiveServerUrl = new URL(archiveServerOrigin);
if (
  archiveServerUrl.protocol !== "https:" &&
  !["localhost", "127.0.0.1", "::1"].includes(archiveServerUrl.hostname)
) {
  throw new Error("ARCHIVE_SERVER_ORIGIN must use HTTPS outside local development");
}

// Chrome match patterns grant a host, not a single TCP port. Keep the exact
// port in the compiled runtime origin while omitting it from the permission
// pattern so Chrome accepts the manifest.
function hostPermissionPattern(origin: string): string {
  const url = new URL(origin);
  const host = url.hostname.includes(":")
    ? `[${url.hostname.replace(/^\[|\]$/g, "")}]`
    : url.hostname;
  return `${url.protocol}//${host}/*`;
}

const aiOrigins = [
  "https://chatgpt.com/*",
  "https://chat.openai.com/*",
  "https://gemini.google.com/*",
  "https://grok.com/*",
  "https://yuanbao.tencent.com/*",
  "https://agent.minimax.io/*",
  "https://agent.minimaxi.com/*",
  "https://chat.deepseek.com/*",
  "https://qianwen.com/*",
  "https://www.qianwen.com/*",
  "https://www.kimi.com/*",
  "https://kimi.com/*",
];

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "AI 会话归档",
    description: "自动归档当前打开的完整 AI 会话可见分支。",
    version: "0.4.0",
    incognito: "split",
    permissions: ["storage", "alarms", "tabs"],
    optional_host_permissions: [
      hostPermissionPattern(archiveServerOrigin),
      ...aiOrigins,
    ],
    action: { default_title: "AI 会话归档" },
  },
  vite: () => ({
    define: {
      __ARCHIVE_SERVER_ORIGIN__: JSON.stringify(archiveServerOrigin),
    },
  }),
});
