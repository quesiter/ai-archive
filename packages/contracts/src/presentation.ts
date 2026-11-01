// Presentation helpers are shared without initializing validation schemas.
export const providers = [
  "chatgpt",
  "gemini",
  "grok",
  "grok_build",
  "yuanbao",
  "doubao",
  "minimax_agent",
  "deepseek",
  "qianwen",
  "kimi",
  "openclaw",
  "codex",
  "claude_code",
] as const;

type Provider = (typeof providers)[number];

export const providerLabels: Record<Provider, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  grok: "Grok",
  grok_build: "Grok Build",
  yuanbao: "腾讯元宝",
  doubao: "豆包",
  minimax_agent: "MiniMax Agent",
  deepseek: "DeepSeek",
  qianwen: "千问",
  kimi: "Kimi",
  openclaw: "OpenClaw",
  codex: "Codex",
  claude_code: "Claude Code",
};

const INTERNAL_CONVERSATION_BLOCK_TAGS = [
  "recommended_plugins",
  "environment_context",
  "app-context",
  "skills_instructions",
  "permissions instructions",
  "apps_instructions",
  "plugins_instructions",
  "collaboration_mode",
  "multi_agent_mode",
] as const;

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Removes product/runtime envelopes that can be stored in the same message as
 * the user's actual prompt. The original archived content remains unchanged.
 */
export function stripInternalConversationMetadata(value: string): string {
  let output = value.replace(/\r\n/g, "\n");
  for (const tag of INTERNAL_CONVERSATION_BLOCK_TAGS) {
    const escaped = escapedRegExp(tag);
    output = output.replace(
      new RegExp(`<${escaped}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${escaped}\\s*>`, "gi"),
      "",
    );
  }
  return output.replace(/\n{3,}/g, "\n\n").trim();
}
