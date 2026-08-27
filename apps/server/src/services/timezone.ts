import { config } from "../config.js";

type CalendarParts = { year: number; month: number; day: number };

function parts(value: Date, timeZone: string): CalendarParts & {
  hour: number;
  minute: number;
  second: number;
} {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(value).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

export function zonedDateTimeToUtc(
  value: CalendarParts & { hour?: number; minute?: number; second?: number },
  timeZone = config.TZ,
): Date {
  const target = Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour ?? 0,
    value.minute ?? 0,
    value.second ?? 0,
  );
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = parts(new Date(candidate), timeZone);
    const represented = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    const correction = target - represented;
    candidate += correction;
    if (correction === 0) break;
  }
  return new Date(candidate);
}

export function instanceCalendarParts(value: Date): CalendarParts {
  const result = parts(value, config.TZ);
  return { year: result.year, month: result.month, day: result.day };
}

export function parseInstanceDateBoundary(value: string, exclusiveEnd = false): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number) as [number, number, number];
    const calendar = new Date(Date.UTC(year, month - 1, day + (exclusiveEnd ? 1 : 0)));
    return zonedDateTimeToUtc({
      year: calendar.getUTCFullYear(),
      month: calendar.getUTCMonth() + 1,
      day: calendar.getUTCDate(),
    });
  }
  return new Date(value);
}

export function formatInstanceCalendarDate(value: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: config.TZ,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(value);
}
