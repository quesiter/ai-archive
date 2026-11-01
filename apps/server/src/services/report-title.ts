export const REPORT_TITLE_PREFIX = "【知言归藏】";

/** Keep generated, stored and emailed report titles consistently branded. */
export function withReportTitlePrefix(title: string): string {
  return `${REPORT_TITLE_PREFIX}${title.replace(/^(?:\s*【知言归藏】)+\s*/, "").trim()}`;
}
