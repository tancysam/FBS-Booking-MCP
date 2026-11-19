import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertDate,
  normaliseTime,
  dropPastSlots,
  freeRanges,
  indexToTime,
  parseSchedule,
  roundTripDateTime,
  sgtMidnightIso,
  timeToIndex,
  todaySgt,
} from "../src/grid.js";

const HTML = `
<table id='tblCalendar'>
  <thead><tr><th>Time</th><th value='SP1'>GSR 2-1</th><th Value='SP2'> GSR 2-2 </th></tr></thead>
  <tbody>
    <tr><td>14:00</td><td value='14.0' class='x'></td><td value='14.0' class='ConfirmedTD' Message='Booked~|~Alice'></td></tr>
    <tr><td>14:30</td><td value='14.5'></td><td value='14.5' class='PendingApprovalTD'></td></tr>
    <tr><td>15:00</td><td value='15' class='UnAvailableTD'></td><td value='15'></td></tr>
    <tr><td>15:30</td><td value='15.5'></td><td value='15.5' class='HoursDown'></td></tr>
  </tbody>
</table>`;

test("time helpers convert both ways", () => {
  assert.equal(timeToIndex("14:30"), 29);
  assert.equal(timeToIndex("24:00"), 48);
  assert.equal(indexToTime(29), "14:30");
  assert.equal(indexToTime(0), "00:00");
  assert.throws(() => timeToIndex("14:15"));
  assert.throws(() => timeToIndex("2pm"));
});

test("parseSchedule maps cells to the room in the same column", () => {
  const rooms = parseSchedule(HTML);
  assert.deepEqual(rooms.map((r) => [r.spaceId, r.spaceName]), [["SP1", "GSR 2-1"], ["SP2", "GSR 2-2"]]);
  assert.deepEqual(rooms[0]!.slots.map((s) => s.status), ["free", "free", "unavailable", "free"]);
  assert.deepEqual(rooms[1]!.slots.map((s) => s.status), ["booked", "pending", "free", "closed"]);
  assert.equal(JSON.stringify(rooms).includes("Alice"), false, "who booked a slot is never read");
  assert.equal(rooms[0]!.slots[0]!.raw, "14.0");
  assert.equal(rooms[0]!.slots[1]!.start, "14:30");
});

test("freeRanges merges neighbouring free slots only", () => {
  const rooms = parseSchedule(HTML);
  assert.deepEqual(freeRanges(rooms[0]!.slots), [
    { start: "14:00", end: "15:00" },
    { start: "15:30", end: "16:00" },
  ]);
});

test("dropPastSlots hides slots that already started today", () => {
  const slots = parseSchedule(HTML)[0]!.slots;
  const now = new Date("2026-11-10T06:40:00Z"); // 14:40 SGT
  assert.equal(todaySgt(now), "2026-11-10");
  assert.deepEqual(dropPastSlots(slots, "2026-11-10", now).map((s) => s.start), ["15:00", "15:30"]);
  assert.equal(dropPastSlots(slots, "2026-11-11", now).length, 4);
  assert.equal(dropPastSlots(slots, "2026-11-09", now).length, 0);
});

test("dates serialise the way the web app sends them", () => {
  assert.equal(sgtMidnightIso("2026-11-10"), "2026-11-09T16:00:00.000Z");
  assert.equal(roundTripDateTime("2026-11-10T06:00:00"), "2026-11-10T06:00:00.000Z");
  assert.equal(roundTripDateTime("2026-11-10T14:00:00+08:00"), "2026-11-10T06:00:00.000Z");
  assert.equal(roundTripDateTime("1900-01-01T00:00:00"), "1900-01-01T00:00:00");
  assert.equal(roundTripDateTime(""), "1900-01-01T00:00:00");
});

test("assertDate rejects dates that are not on the calendar", () => {
  assert.equal(assertDate("2028-02-29"), "2028-02-29");
  for (const bad of ["2026-02-31", "2026-02-29", "2026-13-01", "2026-04-31", "2026-1-5", "tomorrow"]) {
    assert.throws(() => assertDate(bad), /YYYY-MM-DD|not a real calendar date/, bad);
  }
});

test("normaliseTime pads the hour and keeps the half-hour rule", () => {
  assert.equal(normaliseTime("9:00"), "09:00");
  assert.equal(normaliseTime(" 14:30 "), "14:30");
  assert.equal(normaliseTime("24:00"), "24:00");
  assert.throws(() => normaliseTime("9:15"), /half hour/);
});
