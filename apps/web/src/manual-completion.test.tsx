import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ConversationArchiveSummary } from "./conversation-archive";

const manual = { version: 1, source: "user_acceptance", sourceVerified: false,
  reason: "source_unavailable_user_accepted", confirmedAt: "2026-10-26T01:00:00Z" };
const defaults = { messageCount: 4, capturedAt: "2026/7/28", status: "完整", captureMode: "完整采集", triggerReason: "批量补采", sourceDevice: "Chrome" };

it("labels user-accepted unavailable archives without claiming a new source capture", () => {
  const html=renderToStaticMarkup(<ConversationArchiveSummary {...defaults} manualCompletion={manual}
    reason="原始采集未到顶部" />);
  expect(html).toContain("人工确认完整");
  expect(html).toContain("停止补采");
  expect(html).toContain("不表示重新取得了源站全文");
  expect(html).toContain("原始采集未到顶部");
  expect(html).toContain("4 条");
});

it("does not apply an old acceptance marker after the archive becomes partial", () => {
  const html=renderToStaticMarkup(<ConversationArchiveSummary {...defaults} status="部分完成" manualCompletion={manual} />);
  expect(html).toContain("部分完成");expect(html).not.toContain("人工确认完整");
});

it("does not mistake unrelated or malformed evidence for manual acceptance", () => {
  const html=renderToStaticMarkup(<ConversationArchiveSummary {...defaults} manualCompletion={{...manual, source: "chatgpt_source_ui"}} />);
  expect(html).not.toContain("人工确认完整");expect(html).not.toContain("停止补采");
});
