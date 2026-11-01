import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeTabState, PAGE_RECONNECT_MESSAGE } from "../lib/current-tab";

const query = vi.fn();
const sendMessage = vi.fn();

beforeEach(() => {
  query.mockReset().mockResolvedValue([{ id: 12, url: "https://chatgpt.com/c/test" }]);
  sendMessage.mockReset();
  vi.stubGlobal("browser", { tabs: { query, sendMessage } });
});
afterEach(() => vi.unstubAllGlobals());

describe("current page connection", () => {
  it("keeps a supported site recognizable when its content script has disconnected", async () => {
    sendMessage.mockRejectedValue(new Error("Receiving end does not exist"));
    expect(await activeTabState()).toMatchObject({ tabId: 12, supported: true, connectionError: PAGE_RECONNECT_MESSAGE });
  });
  it("requires a real response rather than treating an empty reply as a connected page", async () => {
    sendMessage.mockResolvedValue(undefined);
    expect(await activeTabState()).toMatchObject({ supported: true, connectionError: PAGE_RECONNECT_MESSAGE });
  });
  it("preserves the session returned by a connected page", async () => {
    sendMessage.mockResolvedValue({ supported: true, provider: "chatgpt", sessionId: "test" });
    expect(await activeTabState()).toEqual({ tabId: 12, hostname: "chatgpt.com", supported: true, provider: "chatgpt", sessionId: "test" });
  });
  it("does not suggest reconnecting unsupported sites", async () => {
    query.mockResolvedValue([{ id: 12, url: "https://example.com/" }]);
    sendMessage.mockRejectedValue(new Error("Receiving end does not exist"));
    expect(await activeTabState()).toEqual({ tabId: 12, hostname: "example.com", supported: false });
  });
});
