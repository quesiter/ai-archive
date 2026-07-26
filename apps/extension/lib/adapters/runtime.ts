import type {
  MessageRole,
  MessageSegment,
} from "@ai-archive/contracts";
import { adapterDefinitions } from "./definitions";
import type {
  AdapterDefinition,
  AdapterRuntime,
  ExtractedMessage,
} from "./types";

function visible(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
}

function uniqueTopLevel(elements: HTMLElement[]): HTMLElement[] {
  const unique = Array.from(new Set(elements));
  return unique.filter(
    (element) => !unique.some((other) => other !== element && other.contains(element)),
  );
}

function roleHintScore(element: HTMLElement, selectors: string[]): number {
  let score = 0;
  for (const selector of selectors) {
    try {
      if (element.matches(selector)) score = Math.max(score, 4);
      if (element.parentElement?.matches(selector)) score = Math.max(score, 3);
      for (const child of Array.from(element.children)) {
        if (child instanceof HTMLElement && child.matches(selector)) {
          score = Math.max(score, 2);
        }
      }
      if (element.querySelector(selector)) score = Math.max(score, 1);
    } catch {
      // Ignore a selector that became invalid after a provider redesign.
    }
  }
  return score;
}

function layoutRoleHint(element: HTMLElement): MessageRole | null {
  const style = getComputedStyle(element);
  if (style.textAlign === "right" || style.marginLeft === "auto") return "user";
  if (style.textAlign === "left" || style.marginRight === "auto") return "assistant";

  const rect = element.getBoundingClientRect();
  const container = elementScrollParent(element);
  const containerRect = container.getBoundingClientRect();
  if (rect.width <= 0 || containerRect.width <= 0) return null;
  const elementCenter = rect.left + rect.width / 2;
  const containerCenter = containerRect.left + containerRect.width / 2;
  const threshold = Math.max(80, containerRect.width * 0.16);
  if (elementCenter - containerCenter > threshold) return "user";
  if (containerCenter - elementCenter > threshold) return "assistant";
  return null;
}

function elementScrollParent(element: HTMLElement): HTMLElement {
  let current: HTMLElement | null = element.parentElement;
  while (current && current !== document.body) {
    const style = getComputedStyle(current);
    if (/(auto|scroll)/.test(style.overflowY)) return current;
    current = current.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

function structuralRole(
  definition: AdapterDefinition,
  element: HTMLElement,
): MessageRole | null {
  const explicit = roleFromAttributes(element);
  if (explicit) return explicit;
  const classes = element.className.toString().toLowerCase();
  const userScore = roleHintScore(element, definition.userHints);
  const assistantScore = roleHintScore(element, definition.assistantHints);
  if (assistantScore > userScore) return "assistant";
  if (userScore > assistantScore) return "user";
  if (assistantScore > 0 && /assistant|answer|response|model/.test(classes)) {
    return "assistant";
  }
  if (userScore > 0 && /\buser\b|human|question|prompt/.test(classes)) {
    return "user";
  }
  if (/\buser\b|human|question|prompt/.test(classes)) return "user";
  if (/assistant|answer|response|model/.test(classes)) return "assistant";
  return layoutRoleHint(element);
}

function messageSetScore(
  definition: AdapterDefinition,
  elements: HTMLElement[],
): number {
  const roles = new Set(
    elements.flatMap((element) => {
      const role = structuralRole(definition, element);
      return role ? [role] : [];
    }),
  );
  const roleScore = roles.has("user") && roles.has("assistant")
    ? 20_000
    : roles.size > 0
      ? 10_000
      : 0;
  return roleScore + elements.length;
}

function cleanText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const genericConversationTitles = [
  /^gemini$/i,
  /^google gemini$/i,
  /^与\s*gemini\s*对话$/i,
  /^chatgpt$/i,
  /^grok$/i,
  /^deepseek$/i,
  /^kimi$/i,
  /^腾讯元宝$/i,
  /^(通义)?千问$/i,
  /^minimax( agent)?$/i,
  /^minimax agent\s*[:：-]/i,
  /^(new|temporary) chat$/i,
  /^(skip|jump) to (?:main )?content$/i,
  /^(?:跳至|跳到|跳过至|转到)(?:主要|主)?内容$/,
  /^(新建?|临时)(聊天|对话)$/i,
];

function normalizedConversationTitle(value: string): string | undefined {
  const lines = cleanText(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !/^(更多|固定|取消固定|重命名|删除|more|pin|unpin|rename|delete)$/i.test(
          line,
        ),
    );
  let title = lines[0] ?? "";
  title = title
    .replace(
      /\s*(?:[-|·])\s*(?:Google\s+Gemini|Gemini|ChatGPT|Grok|DeepSeek|Kimi|腾讯元宝|(?:通义)?千问|MiniMax(?:\s+Agent)?)\s*$/i,
      "",
    )
    .trim();
  if (!title || genericConversationTitles.some((pattern) => pattern.test(title))) {
    return undefined;
  }
  return title.slice(0, 2_048);
}

function titleText(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll("button, svg, [role='menu'], [role='menuitem']")
    .forEach((node) => node.remove());
  return clone.innerText || clone.textContent || "";
}

function matchingSessionLinkTitle(sessionId: string | null): string | undefined {
  if (!sessionId) return undefined;
  const currentUrl = new URL(location.href);
  const matches = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
    .filter((anchor) => {
      try {
        const rawHref = anchor.getAttribute("href")?.trim();
        if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("?")) {
          return false;
        }
        const candidate = new URL(anchor.href, currentUrl);
        const decodedHref = decodeURIComponent(rawHref);
        return (
          candidate.origin === currentUrl.origin &&
          // A same-page accessibility link such as ChatGPT's `#main`
          // resolves to the conversation URL too. Require the Session ID to
          // be present in the link's own href so it cannot become the title.
          decodedHref.includes(sessionId)
        );
      } catch {
        return false;
      }
    })
    .sort((left, right) => {
      const leftCurrent = left.getAttribute("aria-current") === "page" ? 1 : 0;
      const rightCurrent = right.getAttribute("aria-current") === "page" ? 1 : 0;
      return rightCurrent - leftCurrent;
    });
  for (const anchor of matches) {
    const title = normalizedConversationTitle(titleText(anchor));
    if (title) return title;
  }
  return undefined;
}

const userSpeakerLabels = new Set([
  "你说",
  "您说",
  "用户",
  "you said",
  "user",
]);

const assistantSpeakerLabels = new Set([
  "ai",
  "assistant",
  "chatgpt",
  "chatgpt said",
  "chatgpt 说",
  "gemini",
  "gemini said",
  "gemini 说",
  "grok",
  "grok said",
  "grok 说",
  "deepseek",
  "kimi",
  "千问",
  "通义千问",
  "腾讯元宝",
  "元宝",
  "minimax",
  "minimax agent",
  "模型回复",
]);

/** Remove provider-rendered speaker chrome such as “You said”/“Gemini said”. */
function withoutSpeakerLabel(value: string, role: MessageRole): string {
  const lines = value.split("\n");
  if (lines.length < 2) return value;
  const firstLine = lines[0]!
    .trim()
    .replace(/[：:]$/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  const labels = role === "user"
    ? userSpeakerLabels
    : role === "assistant"
      ? assistantSpeakerLabels
      : undefined;
  return labels?.has(firstLine) ? cleanText(lines.slice(1).join("\n")) : value;
}

function firstAttributeValue(
  element: HTMLElement,
  attributes: string[],
): string | undefined {
  for (const node of [element, ...Array.from(element.querySelectorAll<HTMLElement>("*"))]) {
    for (const attribute of attributes) {
      const value = node.getAttribute(attribute);
      if (value && value.trim()) return cleanText(value).slice(0, 256);
    }
  }
  return undefined;
}

function firstSelectorText(
  element: HTMLElement,
  selectors: string[],
): string | undefined {
  for (const selector of selectors) {
    try {
      const node = element.matches(selector)
        ? element
        : element.querySelector<HTMLElement>(selector);
      const value = cleanText(node?.innerText ?? node?.textContent ?? "");
      if (value) return value.slice(0, 256);
    } catch {
      // Ignore a selector that became invalid after a provider redesign.
    }
  }
  return undefined;
}

function isoDateFromValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function roleFromAttributes(element: HTMLElement): MessageRole | null {
  const candidates = [
    element.dataset.messageAuthorRole,
    element.dataset.role,
    element.dataset.author,
    element.dataset.sender,
    element.dataset.messageRole,
    element.getAttribute("data-author-role"),
    element.getAttribute("data-message-role"),
    element.getAttribute("data-msg-role"),
    element.getAttribute("data-sender"),
    element.getAttribute("data-author"),
    element.getAttribute("aria-label"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/\b(user|human)\b|用户|你说/.test(candidates)) return "user";
  if (/\b(assistant|bot|model|ai)\b|助手|回答/.test(candidates)) return "assistant";
  if (/\btool\b|工具/.test(candidates)) return "tool";
  if (/\bsystem\b|系统/.test(candidates)) return "system";
  return null;
}

function extractSegments(
  element: HTMLElement,
  definition: AdapterDefinition,
): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const consumed = new Set<Element>();
  const addScopedText = (selectors: string[] | undefined, type: MessageSegment["type"]) => {
    for (const selector of selectors ?? []) {
      for (const node of Array.from(element.querySelectorAll<HTMLElement>(selector))) {
        if (consumed.has(node)) continue;
        const content = cleanText(node.innerText);
        if (!content) continue;
        consumed.add(node);
        segments.push({ type, content });
      }
    }
  };
  addScopedText(definition.reasoningSelectors, "reasoning");
  addScopedText(definition.toolSelectors, "tool_status");

  for (const node of Array.from(element.querySelectorAll<HTMLElement>("pre"))) {
    if ([...consumed].some((parent) => parent.contains(node))) continue;
    const content = cleanText(node.innerText);
    if (!content) continue;
    consumed.add(node);
    const language = Array.from(node.querySelector("code")?.classList ?? [])
      .find((className) => className.startsWith("language-"))
      ?.slice("language-".length);
    segments.push({ type: "code", content, ...(language ? { language } : {}) });
  }

  for (const node of Array.from(element.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    if ([...consumed].some((parent) => parent.contains(node))) continue;
    const content = cleanText(node.innerText || node.href);
    if (!content || !/^https?:/i.test(node.href)) continue;
    consumed.add(node);
    segments.push({ type: "citation", content, href: node.href });
  }

  const clone = element.cloneNode(true) as HTMLElement;
  for (const selector of [
    ...(definition.reasoningSelectors ?? []),
    ...(definition.toolSelectors ?? []),
    "pre",
    "button",
    "svg",
    "img",
    "script",
    "style",
    "textarea",
  ]) {
    try {
      clone.querySelectorAll(selector).forEach((node) => node.remove());
    } catch {
      // A provider selector becoming invalid should not destroy the remaining text.
    }
  }
  const mainText = cleanText(clone.innerText || clone.textContent || "");
  if (mainText) segments.unshift({ type: "text", content: mainText });

  const deduped: MessageSegment[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    const key = `${segment.type}:${segment.content}:${segment.href ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(segment);
  }
  return deduped;
}

export function createAdapterRuntime(
  definition: AdapterDefinition,
): AdapterRuntime {
  return {
    definition,
    getSessionId(url = new URL(location.href)) {
      for (const pattern of definition.sessionPatterns) {
        const match = url.pathname.match(pattern);
        if (match?.[1]) return decodeURIComponent(match[1]);
      }
      for (const key of definition.sessionQueryKeys ?? []) {
        const value = url.searchParams.get(key);
        if (value) return value;
      }
      const embedded = document.querySelector<HTMLElement>(
        "[data-conversation-id], [data-session-id], [data-chat-id]",
      );
      return (
        embedded?.dataset.conversationId ??
        embedded?.dataset.sessionId ??
        embedded?.dataset.chatId ??
        null
      );
    },
    getCanonicalUrl(url = new URL(location.href)) {
      return `${url.origin}${url.pathname}`;
    },
    getTitle() {
      const sessionTitle = matchingSessionLinkTitle(this.getSessionId());
      if (sessionTitle) return sessionTitle;

      const selectors = [
        "a[aria-current='page']",
        "[data-testid='conversation-title']",
        "[data-test-id='conversation-title']",
        "[class*='conversation-title']",
        "[class*='chat-title']",
        "[role='option'][aria-selected='true']",
        "[class*='conversation'][class*='selected']",
        "main h1",
      ];
      for (const selector of selectors) {
        for (const node of Array.from(
          document.querySelectorAll<HTMLElement>(selector),
        )) {
          const title = normalizedConversationTitle(titleText(node));
          if (title) return title;
        }
      }
      return normalizedConversationTitle(document.title);
    },
    getConversationRoot() {
      for (const selector of [
        definition.conversationRootSelector,
        "main",
        "[role='main']",
      ].filter(Boolean) as string[]) {
        try {
          const root = document.querySelector<HTMLElement>(selector);
          if (root && visible(root)) return root;
        } catch {
          // Ignore provider selectors that become invalid.
        }
      }
      return document.body;
    },
    findMessageElements() {
      let bestElements: HTMLElement[] = [];
      let bestScore = -1;
      const root = this.getConversationRoot() ?? document.body;
      for (const selector of definition.messageSelectors) {
        let elements: HTMLElement[] = [];
        try {
          elements = uniqueTopLevel(
            Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
              (element) =>
                !element.closest("#ai-archive-floating-indicator") &&
                visible(element) &&
                cleanText(element.innerText).length > 0,
            ),
          );
        } catch {
          continue;
        }
        if (!elements.length) continue;
        const score = messageSetScore(definition, elements);
        if (score > bestScore) {
          bestScore = score;
          bestElements = elements;
        }
      }
      return bestElements;
    },
    getRole(element, index) {
      const role = structuralRole(definition, element);
      if (role) return role;
      // Alternation is only a fallback; completeness still requires a real user/assistant pair.
      return index % 2 === 0 ? "user" : "assistant";
    },
    getExternalMessageId(element) {
      const directId =
        element.dataset.messageId ??
        element.dataset.id ??
        (element.id || undefined);
      if (directId) return directId;

      const minimaxMessageId =
        element.getAttribute("data-msg-id") ??
        element.getAttribute("data-message-root-id") ??
        element.closest<HTMLElement>("[data-msg-id]")?.getAttribute("data-msg-id") ??
        element
          .closest<HTMLElement>("[data-message-root-id]")
          ?.getAttribute("data-message-root-id");
      if (minimaxMessageId) return minimaxMessageId;

      // Grok 2026 renders the stable response ID on the surrounding row while
      // the message bubble itself only has a generic user/assistant test ID.
      const responseRowId = element.closest<HTMLElement>("[id^='response-']")?.id;
      if (responseRowId?.startsWith("response-") && responseRowId.length > 9) {
        return responseRowId.slice(9);
      }

      const testId = element.getAttribute("data-testid") ?? undefined;
      if (
        testId &&
        !/^(user|assistant|model|conversation)-(message|turn)$/i.test(testId)
      ) {
        return testId;
      }
      return (
        element.getAttribute("data-response-id") ??
        element.getAttribute("data-chat-message-id") ??
        undefined
      );
    },
    getModel(element) {
      const explicit = firstAttributeValue(element, [
        "data-model",
        "data-model-name",
        "data-model-id",
      ]);
      return (
        explicit ??
        firstSelectorText(element, definition.modelSelectors ?? [
          "[data-model]",
          "[data-model-name]",
          "[data-testid*='model' i]",
        ])
      );
    },
    getCreatedAt(element) {
      const explicit = firstAttributeValue(element, [
        "data-created-at",
        "data-timestamp",
        "datetime",
      ]);
      const selectorValue = firstSelectorText(element, definition.timeSelectors ?? [
        "time[datetime]",
        "[data-created-at]",
        "[data-timestamp]",
      ]);
      return isoDateFromValue(explicit ?? selectorValue);
    },
    getSegments(element) {
      return extractSegments(element, definition);
    },
    isStreaming() {
      for (const selector of definition.streamingSelectors ?? []) {
        try {
          if (document.querySelector(selector)) return true;
        } catch {
          continue;
        }
      }
      const buttons = Array.from(document.querySelectorAll<HTMLElement>("button"));
      return buttons.some((button) =>
        /^(stop|停止|中止|终止)( generating| generation|回答|生成)?$/i.test(
          cleanText(button.getAttribute("aria-label") ?? button.innerText),
        ),
      );
    },
    extractVisibleMessages() {
      return this.findMessageElements().flatMap((element, index) => {
        const role = this.getRole(element, index);
        const segments = this.getSegments(element).flatMap((segment) => {
          if (segment.type !== "text") return [segment];
          const content = withoutSpeakerLabel(segment.content, role);
          return content ? [{ ...segment, content }] : [];
        });
        if (!segments.length) return [];
        const externalMessageId = this.getExternalMessageId(element);
        const model = this.getModel(element);
        const createdAt = this.getCreatedAt(element);
        const key =
          externalMessageId ??
          `${role}:${segments.map((segment) => `${segment.type}:${segment.content}`).join("|")}`;
        return [
          {
            key,
            element,
            ...(externalMessageId ? { externalMessageId } : {}),
            ...(model ? { model } : {}),
            ...(createdAt ? { createdAt } : {}),
            ordinal: index,
            role,
            segments,
          },
        ];
      });
    },
  };
}

export function adapterForLocation(hostname = location.hostname): AdapterRuntime | null {
  const definition = adapterDefinitions.find((candidate) =>
    candidate.hosts.includes(hostname),
  );
  return definition ? createAdapterRuntime(definition) : null;
}
