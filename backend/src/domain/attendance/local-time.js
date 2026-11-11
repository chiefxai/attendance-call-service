"use strict";

function partsAt(epochMilliseconds, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(epochMilliseconds));
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function sameLocalMinute(parts, target) {
  return parts.year === target.year && parts.month === target.month && parts.day === target.day
    && parts.hour === target.hour && parts.minute === target.minute;
}

/** Convert a wall-clock date/time in an IANA timezone to UTC without model offset math. */
function localDateTimeToUtc(dateValue, timeValue, timeZone) {
  const dateMatch = String(dateValue || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = String(timeValue || "").trim().match(/^(\d{2}):(\d{2})$/);
  if (!dateMatch || !timeMatch || !timeZone) return null;

  const target = {
    year: Number(dateMatch[1]), month: Number(dateMatch[2]), day: Number(dateMatch[3]),
    hour: Number(timeMatch[1]), minute: Number(timeMatch[2]),
  };
  if (target.month < 1 || target.month > 12 || target.day < 1 || target.day > 31
    || target.hour > 23 || target.minute > 59) return null;

  const localAsUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  const normalized = new Date(localAsUtc);
  if (normalized.getUTCFullYear() !== target.year || normalized.getUTCMonth() + 1 !== target.month
    || normalized.getUTCDate() !== target.day || normalized.getUTCHours() !== target.hour
    || normalized.getUTCMinutes() !== target.minute) return null;

  try {
    const offsets = new Set();
    for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
      const sample = localAsUtc + hours * 60 * 60_000;
      const wall = partsAt(sample, timeZone);
      const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
      offsets.add(wallAsUtc - sample);
    }
    const matches = [...offsets]
      .map((offset) => localAsUtc - offset)
      .filter((instant) => sameLocalMinute(partsAt(instant, timeZone), target));
    // Missing or repeated local times are ambiguous. Escalate instead of guessing.
    return matches.length === 1 ? new Date(matches[0]) : null;
  } catch {
    return null;
  }
}

function formatLocalDateTime(value, timeZone) {
  const epoch = new Date(value || "").getTime();
  if (!Number.isFinite(epoch)) return "";
  try {
    const parts = partsAt(epoch, timeZone);
    return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  } catch {
    return "";
  }
}

module.exports = { localDateTimeToUtc, formatLocalDateTime };
