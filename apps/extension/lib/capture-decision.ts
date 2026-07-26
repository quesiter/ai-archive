import type { CaptureTriggerReason, MessageRole } from "@ai-archive/contracts";
import type { LightweightConversationFingerprint } from "./scanner";

export interface LocalConversationBaseline {
  adapterVersion: string;
  messageCount: number;
  lastMessageId?: string | undefined;
  lastMessageRole?: MessageRole | undefined;
  lastMessageTextHash?: string | undefined;
  completeness?: "complete" | "partial" | undefined;
}

export type CaptureDecision =
  | { action: "wait"; triggerReason: "stream_finished"; message: string }
  | { action: "skip"; triggerReason: CaptureTriggerReason; message: string }
  | { action: "full"; triggerReason: CaptureTriggerReason; message: string }
  | { action: "append"; triggerReason: CaptureTriggerReason; message: string };

export function decideCaptureAction(input: {
  light: LightweightConversationFingerprint;
  state: LocalConversationBaseline | null;
  requestedReason: CaptureTriggerReason;
  forceFullReason?: CaptureTriggerReason | null | undefined;
  previousStreaming?: boolean | undefined;
}): CaptureDecision {
  if (input.light.streaming) {
    return {
      action: "wait",
      triggerReason: "stream_finished",
      message: "等待 AI 生成完成",
    };
  }
  if (input.forceFullReason) {
    return {
      action: "full",
      triggerReason: input.forceFullReason,
      message: "用户或服务端要求完整校验",
    };
  }
  if (!input.state) {
    return {
      action: "full",
      triggerReason: "new_session",
      message: "首次打开新会话",
    };
  }

  const unchanged =
    input.state.adapterVersion === input.light.adapterVersion &&
    input.state.messageCount === input.light.messageCount &&
    input.state.lastMessageId === input.light.lastMessageId &&
    input.state.lastMessageRole === input.light.lastMessageRole &&
    input.state.lastMessageTextHash === input.light.lastMessageTextHash;
  if (unchanged) {
    return {
      action: "skip",
      triggerReason: input.requestedReason,
      message: "内容未变化，已跳过",
    };
  }
  if (input.state.adapterVersion !== input.light.adapterVersion) {
    return {
      action: "full",
      triggerReason: "adapter_upgraded",
      message: "适配器版本变化，需要完整校验",
    };
  }
  if (input.state.messageCount > input.light.messageCount) {
    return {
      action: "full",
      triggerReason: "branch_changed",
      message: "消息数量减少，可能切换了分支",
    };
  }
  if (
    input.state.messageCount === input.light.messageCount &&
    (input.state.lastMessageId !== input.light.lastMessageId ||
      input.state.lastMessageTextHash !== input.light.lastMessageTextHash)
  ) {
    return {
      action: "full",
      triggerReason: "branch_changed",
      message: "最后消息变化，可能重新生成或切换了分支",
    };
  }
  if (input.state.completeness !== "complete") {
    return {
      action: "full",
      triggerReason: "new_messages",
      message: "上一版不是完整基线，需要完整归档",
    };
  }
  if (input.light.messageCount > input.state.messageCount) {
    return {
      action: "append",
      triggerReason: input.previousStreaming ? "stream_finished" : "new_messages",
      message: "检测到新增消息，优先增量同步",
    };
  }
  return {
    action: "skip",
    triggerReason: input.requestedReason,
    message: "内容未变化，已跳过",
  };
}
