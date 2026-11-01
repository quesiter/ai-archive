import type { StructuredResponseDiagnostic } from "./llm.js";
import { redactLogText, safeStoredError } from "./operation-log.js";
import {
  loadEnabledCustomRedactionRules,
  redactForCloud,
  redactSensitiveTextForStorage,
} from "./redaction.js";

// Keep the response itself, rather than a summary that could hide a parsing bug.
// Bound storage while retaining both ends of exceptionally large responses.
export const MAX_REPORT_DIAGNOSTIC_CHARS = 120_000;
export const MAX_REPORT_DIAGNOSTICS = 6;

function redactJsonStrings(content: string, redact: (value: string) => string): string {
  let start = -1;
  let copiedThrough = 0;
  let escaped = false;
  const parts: string[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (start < 0) {
      if (char === '"') start = index;
      continue;
    }
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      const token = content.slice(start, index + 1);
      let replacement = token;
      try {
        const value: unknown = JSON.parse(token);
        if (typeof value === "string") replacement = JSON.stringify(redact(value));
      } catch {
        // An invalid string remains subject to whole-response redaction below.
      }
      parts.push(content.slice(copiedThrough, start), replacement);
      copiedThrough = index + 1;
      start = -1;
    }
  }
  parts.push(content.slice(copiedThrough));
  return parts.join("");
}

export async function prepareReportDiagnostic(diagnostic: StructuredResponseDiagnostic) {
  const rules = await loadEnabledCustomRedactionRules();
  // The response is often JSON, including malformed or fenced JSON. Decode each
  // closed string separately so escaped newlines/unicode cannot hide credentials
  // from text redaction. Re-encode it to retain the surrounding response syntax.
  // Load custom rules once for all tokens instead of making one DB query per field.
  const decodedAndRedacted = redactJsonStrings(diagnostic.content, (value) =>
    redactLogText(redactSensitiveTextForStorage(value, rules).text),
  );
  const redacted = redactLogText((await redactForCloud(decodedAndRedacted)).text);
  const contentTruncated = redacted.length > MAX_REPORT_DIAGNOSTIC_CHARS;
  const content = contentTruncated
    ? `${redacted.slice(0, 90_000)}\n\n[诊断响应过长，中间部分已省略]\n\n${redacted.slice(-30_000)}`
    : redacted;
  return {
    ...diagnostic,
    model: safeStoredError(diagnostic.model, 300),
    ...(diagnostic.responseId ? { responseId: safeStoredError(diagnostic.responseId, 300) } : {}),
    ...(diagnostic.requestId ? { requestId: safeStoredError(diagnostic.requestId, 300) } : {}),
    ...(diagnostic.error ? { error: safeStoredError(diagnostic.error) } : {}),
    content,
    contentTruncated,
    recordedAt: new Date().toISOString(),
  };
}
