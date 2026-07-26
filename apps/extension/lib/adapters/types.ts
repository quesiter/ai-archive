import type {
  CaptureMessage,
  MessageRole,
  MessageSegment,
  Provider,
} from "@ai-archive/contracts";

export interface AdapterDefinition {
  provider: Provider;
  version: string;
  hosts: string[];
  sessionPatterns: RegExp[];
  sessionQueryKeys?: string[];
  conversationRootSelector?: string;
  messageSelectors: string[];
  userHints: string[];
  assistantHints: string[];
  reasoningSelectors?: string[];
  toolSelectors?: string[];
  streamingSelectors?: string[];
  modelSelectors?: string[];
  timeSelectors?: string[];
}

export interface ExtractedMessage extends CaptureMessage {
  key: string;
  element: HTMLElement;
}

export interface AdapterRuntime {
  definition: AdapterDefinition;
  getSessionId(url?: URL): string | null;
  getCanonicalUrl(url?: URL): string;
  getTitle(): string | undefined;
  getConversationRoot(): HTMLElement | null;
  findMessageElements(): HTMLElement[];
  getRole(element: HTMLElement, index: number): MessageRole;
  getExternalMessageId(element: HTMLElement): string | undefined;
  getModel(element: HTMLElement): string | undefined;
  getCreatedAt(element: HTMLElement): string | undefined;
  getSegments(element: HTMLElement): MessageSegment[];
  isStreaming(): boolean;
  extractVisibleMessages(): ExtractedMessage[];
}
