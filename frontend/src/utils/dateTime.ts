export const APP_TIME_ZONE = "Asia/Kolkata";

type DateInput = string | Date | null | undefined;

function parsedDate(value: DateInput) {
  if (value instanceof Date) return value;
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatAppDateTime(value: DateInput, options: Intl.DateTimeFormatOptions = {}) {
  const date = parsedDate(value);
  if (!date) return typeof value === "string" ? value : "—";
  const hasDatePartOptions = ["weekday", "year", "month", "day", "hour", "minute", "second", "timeZoneName"]
    .some((key) => key in options);
  return new Intl.DateTimeFormat("en-IN", {
    ...(hasDatePartOptions ? {} : { dateStyle: "medium", timeStyle: "short" }),
    ...options,
    timeZone: APP_TIME_ZONE,
  }).format(date);
}

export function formatAppDate(value: DateInput, options: Intl.DateTimeFormatOptions = {}) {
  const date = parsedDate(value);
  if (!date) return typeof value === "string" ? value : "—";
  return new Intl.DateTimeFormat("en-IN", {
    ...("dateStyle" in options || "weekday" in options || "year" in options || "month" in options || "day" in options ? {} : { dateStyle: "medium" }),
    ...options,
    timeZone: APP_TIME_ZONE,
  }).format(date);
}

export function appDateKey(value: DateInput) {
  const date = parsedDate(value);
  if (!date) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
