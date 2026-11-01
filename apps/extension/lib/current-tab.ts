import { adapterDefinitions } from "./adapters/definitions";
import type { ExtensionMessage } from "./messages";

export interface CurrentTabState {
  tabId?: number;
  hostname?: string;
  supported?: boolean;
  connectionError?: string;
  provider?: string;
  adapterVersion?: string;
  title?: string;
  sessionId?: string | null;
  scanning?: boolean;
}

export const PAGE_RECONNECT_MESSAGE = "页面采集脚本未连接，请刷新此页面后重试；若仍未连接，请在扩展设置中允许访问本站。";

export async function activeTabState(): Promise<CurrentTabState> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || !tab.url) return {};
  let url: URL;
  try {
    url = new URL(tab.url);
  } catch {
    return { tabId: tab.id };
  }
  const supported = url.protocol === "https:" && adapterDefinitions.some(
    (definition) => definition.hosts.includes(url.hostname),
  );
  try {
    const content = (await browser.tabs.sendMessage(tab.id, {
      type: "getContentState",
    } satisfies ExtensionMessage)) as CurrentTabState | undefined;
    if (!content || typeof content.supported !== "boolean") throw new Error("Missing content response");
    return { ...content, tabId: tab.id, hostname: url.hostname };
  } catch {
    return {
      tabId: tab.id, hostname: url.hostname, supported,
      ...(supported ? { connectionError: PAGE_RECONNECT_MESSAGE } : {}),
    };
  }
}
