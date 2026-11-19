import * as cheerio from "cheerio";
import { NULL_DATETIME, SGT_OFFSET } from "./config.js";

export type SlotStatus = "free" | "unavailable" | "booked" | "pending" | "closed";

export interface Slot {
  /** The cell's `value` exactly as the server sent it, e.g. "14.5". */
  raw: string;
  /** Half-hour index since midnight: 29 = 14:30. */
  index: number;
  start: string;
  status: SlotStatus;
}

export interface RoomSchedule {
  spaceId: string;
  spaceName: string;
  slots: Slot[];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "14:30" -> 29. Accepts "24:00" as the end of the day. */
export function timeToIndex(time: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) throw new Error(`Time must look like HH:MM, got "${time}"`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || (min !== 0 && min !== 30) || (h === 24 && min !== 0)) {
    throw new Error(`Time must be on a half hour between 00:00 and 24:00, got "${time}"`);
  }
  return h * 2 + min / 30;
}

/** "9:00" -> "09:00", which is the form FBS and the booking records use. */
export function normaliseTime(time: string): string {
  return indexToTime(timeToIndex(time));
}

export function indexToTime(index: number): string {
  return `${pad(Math.floor(index / 2))}:${index % 2 ? "30" : "00"}`;
}

/** The grid encodes times as decimal hours: "14.5" is 14:30. */
export function decimalHourToIndex(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return -1;
  return Math.round(n * 2);
}

export function assertDate(date: string): string {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
  if (Number.isNaN(parsed)) throw new Error(`Date must look like YYYY-MM-DD, got "${date}"`);
  // Date.parse rolls 2026-02-31 over into March instead of rejecting it.
  if (new Date(parsed).toISOString().slice(0, 10) !== date) {
    throw new Error(`"${date}" is not a real calendar date.`);
  }
  return date;
}

/** Today's date in Singapore. */
export function todaySgt(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** The instant of Singapore midnight on `date`, as the site's browser code would serialise it. */
export function sgtMidnightIso(date: string): string {
  return new Date(`${date}T00:00:00${SGT_OFFSET}`).toISOString();
}

/**
 * Re-serialises a DateTime the way the web app does after reading it from a
 * response: values with no timezone are taken as UTC, and the "null date" is
 * kept as-is.
 */
export function roundTripDateTime(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  if (!text || (text.includes("1900-01-01") && text.includes("00:00:00"))) return NULL_DATETIME;
  const hasZone = /([+-]\d{2}((:\d{2})|(\d{2})?)|Z)$/.test(text);
  const parsed = Date.parse(text.includes("T") && !hasZone ? `${text.trim()}Z` : text);
  return Number.isNaN(parsed) ? NULL_DATETIME : new Date(parsed).toISOString();
}

function statusOf(classes: string): SlotStatus {
  if (/\bUnAvailableTD\b/.test(classes)) return "unavailable";
  if (/\bConfirmedTD\b/.test(classes)) return "booked";
  if (/\bPendingApprovalTD\b/.test(classes)) return "pending";
  if (/\bHoursUp\b|\bHoursDown\b/.test(classes)) return "closed";
  return "free";
}

/**
 * Reads the availability table FBS returns as HTML. Each header cell with a
 * `value` is a room; each body cell with a `value` is one half-hour slot in
 * the column of the header that shares its position.
 */
export function parseSchedule(html: string): RoomSchedule[] {
  const $ = cheerio.load(html);
  const table = $("#tblCalendar").length ? $("#tblCalendar").first() : $("table").first();
  const headers = table.find("th").toArray();
  const rooms = new Map<number, RoomSchedule>();
  headers.forEach((th, i) => {
    const id = $(th).attr("value");
    if (id) rooms.set(i, { spaceId: id, spaceName: $(th).text().trim(), slots: [] });
  });

  table.find("tr").each((_, tr) => {
    $(tr)
      .children()
      .each((col, cell) => {
        const room = rooms.get(col);
        if (!room || cell.tagName.toLowerCase() !== "td") return;
        const raw = $(cell).attr("value");
        if (raw === undefined || raw === "") return;
        const index = decimalHourToIndex(raw);
        if (index < 0 || index > 47) return;
        // The cell's `message` attribute names who booked the slot and why. It is
        // deliberately not read, so no tool can pass other bookers' details on.
        room.slots.push({
          raw,
          index,
          start: indexToTime(index),
          status: statusOf($(cell).attr("class") ?? ""),
        });
      });
  });

  const result = [...rooms.values()];
  for (const room of result) room.slots.sort((a, b) => a.index - b.index);
  return result;
}

/** Merges consecutive free half-hours into `{start, end}` ranges. */
export function freeRanges(slots: Slot[]): { start: string; end: string }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const slot of slots) {
    if (slot.status !== "free") continue;
    const last = ranges[ranges.length - 1];
    if (last && last.end === slot.index) last.end = slot.index + 1;
    else ranges.push({ start: slot.index, end: slot.index + 1 });
  }
  return ranges.map((r) => ({ start: indexToTime(r.start), end: indexToTime(r.end) }));
}

/** Drops slots that have already started, for a schedule on today's date. */
export function dropPastSlots(slots: Slot[], date: string, now = new Date()): Slot[] {
  if (date !== todaySgt(now)) return date < todaySgt(now) ? [] : slots;
  const sgt = new Date(now.getTime() + 8 * 3600_000);
  const nowIndex = sgt.getUTCHours() * 2 + (sgt.getUTCMinutes() >= 30 ? 1 : 0);
  return slots.filter((s) => s.index > nowIndex);
}
