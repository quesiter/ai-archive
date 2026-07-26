const ANSI_ESCAPE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const UNSUPPORTED_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function sanitizeDatabaseText(value: string): string {
  return value
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(UNSUPPORTED_CONTROL_PATTERN, "");
}

export function truncateDatabaseText(
  value: string,
  limit: number,
  label = "text",
): string {
  const sanitized = sanitizeDatabaseText(value);
  if (sanitized.length <= limit) return sanitized;
  if (limit <= 0) return "";
  const marker = `\n[...${sanitized.length - limit} characters omitted from ${label}...]\n`;
  const available = limit - marker.length;
  if (available <= 0) return sanitized.slice(0, limit);
  const headLength = Math.ceil(available * 0.7);
  const tailLength = available - headLength;
  return `${sanitized.slice(0, headLength)}${marker}${sanitized.slice(
    sanitized.length - tailLength,
  )}`;
}
