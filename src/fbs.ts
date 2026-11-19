import { createHash } from "node:crypto";
import { FbsApiError, FbsClient, Json } from "./client.js";
import { NULL_DATETIME } from "./config.js";
import {
  assertDate,
  dropPastSlots,
  freeRanges,
  indexToTime,
  normaliseTime,
  parseSchedule,
  RoomSchedule,
  roundTripDateTime,
  sgtMidnightIso,
  timeToIndex,
  todaySgt,
} from "./grid.js";

const BOOKING_VIEW = "BookingFlow.Booking";
const MY_BOOKINGS_VIEW = "MyBookingFlow.MyBookings";

export interface Option {
  id: string;
  name: string;
}

type Rec = Record<string, unknown>;

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

/** Fields that drift between a preview and its confirmation without changing what the user agreed to. */
const VOLATILE = new Set(["BookingCredits"]);

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v === null || typeof v !== "object") return v;
  const o = v as Rec;
  return Object.fromEntries(
    Object.keys(o).filter((k) => !VOLATILE.has(k)).sort().map((k) => [k, canonical(o[k])]),
  );
}

/** Fingerprint of exactly what a write would submit, so a confirmation can be tied to its preview. */
export function proposalDigest(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
}

export class ProposalChangedError extends Error {
  constructor() {
    super(
      "This no longer matches the preview the user agreed to (the slot, fee or details changed). " +
        "Nothing was submitted. Preview again and show the user the new preview.",
    );
    this.name = "ProposalChangedError";
  }
}

function assertUnchanged(digest: string, expected: string | undefined): void {
  if (expected !== undefined && expected !== digest) throw new ProposalChangedError();
}

/** Flattens text written by other FBS users so it cannot smuggle layout or run on for pages. */
export function clip(v: unknown, max = 300): string {
  const text = str(v).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** OutSystems wraps every list as `{ List: [...] }`. */
export function listOf(v: unknown): Rec[] {
  const l = (v as { List?: unknown } | undefined)?.List;
  return Array.isArray(l) ? (l as Rec[]) : [];
}

function toOptions(v: unknown): Option[] {
  return listOf(v)
    .map((o) => ({ id: str(o["ObjectID"]), name: str(o["ObjectName"]) }))
    .filter((o) => o.id !== "" || o.name !== "");
}

/** Finds the `{ResultCode, ResultObject, IsSuccess, ResultMessage}` wrapper in a reply. */
function wrapper(data: Json, key?: string): Rec {
  const direct = key ? (data[key] as Rec | undefined) : undefined;
  const found =
    direct ??
    (Object.values(data).find(
      (v) => v !== null && typeof v === "object" && "ResultObject" in (v as object),
    ) as Rec | undefined);
  if (!found) throw new FbsApiError("FBS reply did not have the expected shape.");
  if (found["IsSuccess"] === false && str(found["ResultMessage"])) {
    throw new FbsApiError(`FBS said: ${str(found["ResultMessage"])}`);
  }
  return found;
}

/** Matches what the user typed against a dropdown: by ID, then exact name, then a unique partial name. */
export function resolveOption(options: Option[], input: string, label: string): Option {
  const want = input.trim().toLowerCase();
  const byId = options.find((o) => o.id.toLowerCase() === want);
  if (byId) return byId;
  const exact = options.filter((o) => o.name.toLowerCase() === want);
  if (exact.length === 1) return exact[0]!;
  const partial = options.filter((o) => o.name.toLowerCase().includes(want));
  if (partial.length === 1) return partial[0]!;
  const shown = (partial.length > 1 ? partial : options).map((o) => o.name).join(", ");
  throw new Error(
    partial.length > 1
      ? `"${input}" matches more than one ${label}: ${shown}`
      : `No ${label} matches "${input}". Choices: ${shown || "(none offered)"}`,
  );
}

function searchScreenVariables(overrides: Rec = {}): Json {
  return {
    Building: "",
    Level: "",
    FacilityType: "",
    Date: todaySgt(),
    StartTime: "",
    EndTime: "",
    Capacity: "",
    Equipment: "",
    CheckBoxHeader: false,
    MaxRecords: 10,
    StartIndex: 0,
    IsAdvancedFilter: false,
    IsFilter: true,
    TotalCount: 0,
    IsSpacePopup: false,
    ImageIndex: 0,
    ImageCount: 0,
    ImageCountCarousel: 0,
    ...overrides,
  };
}

export interface Filters {
  buildings: Option[];
  levels: Option[];
  facilityTypes: Option[];
  capacities: Option[];
  equipment: Option[];
}

const FILTER_TTL_MS = 10 * 60_000;
const filterCache = new WeakMap<FbsClient, Map<string, { at: number; user: string; filters: Filters }>>();

/** The dropdown lists rarely change, and every search needs them, so they are kept for ten minutes. */
export async function getFilters(client: FbsClient, buildingId = ""): Promise<Filters> {
  const { username } = await client.identity();
  const hit = cachedFilters(client, buildingId, username);
  if (hit) return hit;
  const filters = await fetchFilters(client, buildingId);
  let cache = filterCache.get(client);
  if (!cache) filterCache.set(client, (cache = new Map()));
  cache.set(buildingId, { at: Date.now(), user: username, filters });
  return filters;
}

function cachedFilters(client: FbsClient, buildingId: string, username: string): Filters | undefined {
  const hit = filterCache.get(client)?.get(buildingId);
  return hit && hit.user === username && Date.now() - hit.at < FILTER_TTL_MS ? hit.filters : undefined;
}

/** One uncached `getFilters` call is this many FBS requests. */
const FILTER_REQUESTS = 5;

async function fetchFilters(client: FbsClient, buildingId: string): Promise<Filters> {
  const vars = searchScreenVariables({ Building: buildingId });
  const fetch = async (name: string) =>
    toOptions(
      wrapper(await client.dataAction(`BookingFlow/FacilitySearch/${name}`, BOOKING_VIEW, vars))[
        "ResultObject"
      ],
    );
  return {
    buildings: await fetch("DataActionBuildings"),
    levels: await fetch("DataActionLevels"),
    facilityTypes: await fetch("DataActionFacilityTypes"),
    capacities: await fetch("DataActionCapacitys"),
    equipment: await fetch("DataActionEquipments"),
  };
}

export interface SearchInput {
  date: string;
  startTime?: string;
  endTime?: string;
  building?: string;
  level?: string;
  facilityType?: string;
  capacity?: string;
  equipment?: string;
}

/** Most FBS requests one search may make before it stops and reports itself as cut short. */
export const MAX_SEARCH_REQUESTS = 30;

export interface SearchOptions {
  maxRequests?: number;
  /** Called after each FBS request the search makes, so a client can show it is still working. */
  onProgress?: (done: number, max: number) => void;
}

export interface SearchResult {
  rooms: Option[];
  /** True when the request limit was reached, so more rooms may match than are listed. */
  truncated: boolean;
}

export async function searchFacilities(client: FbsClient, input: SearchInput): Promise<Option[]> {
  return (await findFacilities(client, input, { maxRequests: Infinity })).rooms;
}

export async function findFacilities(
  client: FbsClient,
  rawInput: SearchInput,
  opts: SearchOptions = {},
): Promise<SearchResult> {
  const input = {
    ...rawInput,
    ...(rawInput.startTime ? { startTime: normaliseTime(rawInput.startTime) } : {}),
    ...(rawInput.endTime ? { endTime: normaliseTime(rawInput.endTime) } : {}),
  };
  const max = opts.maxRequests ?? MAX_SEARCH_REQUESTS;
  let requests = 0;
  let truncated = false;
  /** Claims one request from the budget; false once it is spent. */
  const spend = (): boolean => {
    if (requests >= max) {
      truncated = true;
      return false;
    }
    requests++;
    opts.onProgress?.(requests, max);
    return true;
  };
  assertDate(input.date);
  let window: { from: number; to: number } | undefined;
  if (input.startTime !== undefined || input.endTime !== undefined) {
    if (!input.startTime || !input.endTime) {
      throw new Error("Give both start_time and end_time for a search window.");
    }
    window = validateBookingTimes({ ...input, spaceId: "", startTime: input.startTime, endTime: input.endTime });
  }
  if (!input.building && !input.level && !input.facilityType) {
    throw new Error("Give at least one of building, level or facility_type.");
  }
  const { username } = await client.identity();
  const filtersByBuilding = new Map<string, Filters>();
  /** A building's dropdown lists, or undefined when fetching them would exceed the request limit. */
  const buildingFilters = async (building: string): Promise<Filters | undefined> => {
    let filters = filtersByBuilding.get(building);
    if (!filters) {
      if (!cachedFilters(client, building, username)) {
        if (building !== "" && requests + FILTER_REQUESTS > max) {
          truncated = true;
          return undefined;
        }
        requests += FILTER_REQUESTS;
        opts.onProgress?.(requests, max);
      }
      filters = await getFilters(client, building);
      filtersByBuilding.set(building, filters);
    }
    return filters;
  };
  const first = (await buildingFilters(""))!;
  let ids = { building: "", level: "", facilityType: "", capacity: "", equipment: "" };
  if (input.building) ids.building = resolveOption(first.buildings, input.building, "building").id;
  const f = (input.level && ids.building ? await buildingFilters(ids.building) : undefined) ?? first;
  if (input.level) ids.level = resolveOption(f.levels, input.level, "level").id;
  if (input.facilityType) {
    ids.facilityType = resolveOption(f.facilityTypes, input.facilityType, "facility type").id;
  }
  if (input.capacity) ids.capacity = resolveOption(f.capacities, input.capacity, "capacity").id;
  if (input.equipment) ids.equipment = resolveOption(f.equipment, input.equipment, "equipment").id;
  const { clientToken } = await client.identity();
  const search = async (filters: typeof ids): Promise<Option[]> => {
    if (!spend()) return [];
    const data = await client.serverAction("BookingFlow/FacilitySearch/ActionSearchCS", BOOKING_VIEW, {
      SearchRequest: {
        Buildings: { List: [filters.building] },
        Levels: { List: [filters.level] },
        FacilityTypes: { List: [filters.facilityType] },
        Date: NULL_DATETIME,
        StartTime: input.startTime ?? "",
        EndTime: input.endTime ?? "",
        Capacity: filters.capacity,
        Equipment: { List: [filters.equipment] },
        DateText: input.date,
      },
      ClientToken: clientToken,
    });
    const rooms = toOptions(wrapper(data, "SearchResponse")["ResultObject"]);
    if (rooms.length < 50) return rooms;
    // ActionSearchCS caps replies at 50 and exposes no paging inputs or total count.
    let key: "building" | "level" | "facilityType" | undefined;
    let partitions: Option[] = [];
    for (const dimension of ["building", "level", "facilityType"] as const) {
      if (filters[dimension]) continue;
      const options = dimension === "building" ? first.buildings
        : dimension === "level" ? (await buildingFilters(filters.building))?.levels : first.facilityTypes;
      // Out of budget before this result could be split: keep the 50 rooms FBS did return.
      if (!options) return rooms;
      partitions = options.filter((o) => o.id !== "");
      if (partitions.length > 0) {
        key = dimension;
        break;
      }
    }
    if (!key) {
      throw new FbsApiError("FBS search reached its 50-room limit and cannot be split further. Narrow the capacity or equipment filter.");
    }
    const all = new Map(rooms.map((room) => [room.id, room]));
    for (const option of partitions) {
      if (truncated) break;
      for (const room of await search({ ...filters, [key]: option.id })) all.set(room.id, room);
    }
    return [...all.values()];
  };
  const candidates = await search(ids);
  if (!window) return { rooms: candidates, truncated };
  const available = new Set<string>();
  for (let i = 0; i < candidates.length; i += 10) {
    if (!spend()) break;
    const rooms = await getSchedule(client, candidates.slice(i, i + 10).map((r) => r.id), input.date);
    for (const room of rooms) {
      const ranges = freeRanges(dropPastSlots(room.slots, input.date));
      if (ranges.some((r) => timeToIndex(r.start) <= window.from && timeToIndex(r.end) >= window.to)) {
        available.add(room.spaceId);
      }
    }
  }
  return { rooms: candidates.filter((r) => available.has(r.id)), truncated };
}

export async function getFacilityDetails(client: FbsClient, spaceId: string): Promise<Rec> {
  const { clientToken } = await client.identity();
  const data = await client.serverAction("BookingFlow/FacilitySearch/ActionSpaceDetails", BOOKING_VIEW, {
    SpaceDetailsRequestCS: spaceId,
    ClientToken: clientToken,
  });
  const d = (wrapper(data, "SpaceDetailsResponseCS")["ResultObject"] ?? {}) as Rec;
  const texts = (v: unknown) => listOf(v).map((x) => str(x)).filter(Boolean);
  return {
    name: str(d["ObjectName"]) || str(d["Space"]),
    building: str(d["Building"]),
    type: str(d["SpaceType"]),
    capacity: str(d["Capacity"]),
    description: str(d["Description"]),
    term_hours: texts(d["Term"]),
    non_term_hours: texts(d["NonTerm"]),
    charges: toOptions(d["Charges"]),
  };
}

export async function getSchedule(
  client: FbsClient,
  spaceIds: string[],
  date: string,
): Promise<RoomSchedule[]> {
  assertDate(date);
  if (spaceIds.length === 0) throw new Error("Give at least one facility ID.");
  const { clientToken } = await client.identity();
  const data = await client.serverAction(
    "BookingFlow/BookingSchedule/ActionBookingScheduleCS",
    BOOKING_VIEW,
    {
      // The web app sends local midnight plus eight hours, which is midnight UTC on the same date.
      BookingScheduleRequestCS: { SpaceID: { List: spaceIds }, BookingDate: `${date}T00:00:00.000Z` },
      ClientToken: clientToken,
    },
  );
  const html = str(wrapper(data, "BookingScheduleResponseCS")["ResultObject"]);
  const rooms = parseSchedule(html);
  if (rooms.length === 0) {
    throw new FbsApiError("FBS returned a schedule this server could not read (no rooms found in it).");
  }
  return rooms;
}

export function summariseSchedule(rooms: RoomSchedule[], date: string): Rec[] {
  return rooms.map((room) => {
    const live = dropPastSlots(room.slots, date);
    const taken = live.filter((s) => s.status !== "free").map((s) => ({ time: s.start, status: s.status }));
    return {
      space_id: room.spaceId,
      name: room.spaceName,
      free: freeRanges(live),
      not_free: taken,
    };
  });
}

export interface BookingRequest {
  date: string;
  spaceId: string;
  startTime: string;
  endTime: string;
}

export interface Prepared {
  selectedJson: string;
  room: RoomSchedule;
  result: Rec;
  models: Rec[];
}

function validateBookingTimes(req: BookingRequest): { from: number; to: number } {
  const from = timeToIndex(req.startTime);
  const to = timeToIndex(req.endTime);
  if (to <= from) throw new Error("end_time must be later than start_time.");
  return { from, to };
}

/** Picks the half-hour cells for a booking and checks every one of them is free. */
export function selectSlots(room: RoomSchedule, req: BookingRequest): string {
  const { from, to } = validateBookingTimes(req);
  const values: Rec[] = [];
  for (let i = from; i < to; i++) {
    const slot = room.slots.find((s) => s.index === i);
    if (!slot) throw new Error(`${room.spaceName} has no ${indexToTime(i)} slot on ${req.date}.`);
    if (slot.status !== "free") {
      throw new Error(`${room.spaceName} is ${slot.status} at ${indexToTime(i)} on ${req.date}.`);
    }
    values.push({ SpaceID: room.spaceId, SpaceName: room.spaceName, SelectedTime: slot.raw });
  }
  if (dropPastSlots(room.slots, req.date).every((s) => s.index !== from)) {
    throw new Error(`${req.startTime} on ${req.date} has already passed.`);
  }
  return JSON.stringify({ SelectedDate: sgtMidnightIso(req.date), SelectedValues: values });
}

/** Runs the read-only half of the booking wizard: slot check, credit check, details form. */
export async function prepareBooking(client: FbsClient, req: BookingRequest): Promise<Prepared> {
  assertDate(req.date);
  validateBookingTimes(req);
  const rooms = await getSchedule(client, [req.spaceId], req.date);
  const room = rooms.find((r) => r.spaceId === req.spaceId) ?? (rooms.length === 1 ? rooms[0] : undefined);
  if (!room) throw new Error(`Facility ${req.spaceId} is not in the schedule FBS returned.`);
  const selectedJson = selectSlots(room, req);
  const id = await client.identity();

  if (id.userType !== "Staff") {
    const credit = await client.serverAction(
      "BookingFlow/BookingSchedule/ActionBookingScheduleCreditValidationCS",
      BOOKING_VIEW,
      {
        BookingScheduleRequestCS: {
          BookingType: "New",
          SelectedDateText: req.date,
          SelectedDate: NULL_DATETIME,
          SelectedValues: selectedJson,
        },
        ClientToken: id.clientToken,
      },
    );
    const verdict = (credit["BookingScheduleResponseCS"] as Rec | null | undefined)?.["ResultObject"];
    if (typeof verdict !== "string") {
      throw new FbsApiError(
        "FBS did not return a readable credit check for this slot, so it was not treated as bookable. Try again.",
      );
    }
    if (verdict) throw new FbsApiError(`FBS would not allow this slot: ${verdict}`);
  }

  const data = await client.dataAction(
    "BookingFlow/BookingDetails/DataActionFetchDataFromBookingDetails",
    BOOKING_VIEW,
    {
      Purpose: "",
      UseTypeID: "",
      CourseCodeID: "",
      BookingUsageID: "",
      BookingFor: "",
      SendCalendarInvite: false,
      ErrorMessage: "",
      IsCourseCodeVisible: false,
      EventID: "",
      IsPreview: false,
      IsShowUserPopup: false,
      BookingForNameValue: "",
      BookingForID: "",
      IsTermsandConditions: false,
      Search: "",
      StartIndex: 0,
      TotalCount: 0,
      MaxRecords: 10,
      IsCoBooker: false,
      CoBookerSearch: "",
      IsFromHeaders: false,
      CurrentIndex: -1,
      TotalBookingFee: "0",
      TechSupportLink: "",
      TechSupportFacilityNames: "",
      IsExecuting: false,
      AirconMessage: "",
      BookingScheduleSelectedValues: selectedJson,
      SelectedDate: req.date,
      directQR: "",
    },
  );
  const result = (wrapper(data, "BookingDetailsResponse")["ResultObject"] ?? {}) as Rec;
  const models = listOf(result["CalendarProcessModels"]);
  if (models.length === 0) {
    throw new FbsApiError("FBS returned no booking form for this slot, so it cannot be booked from here.");
  }
  return { selectedJson, room, result, models };
}

export interface BookingFields {
  purpose?: string;
  useType?: string;
  bookingUsage?: string;
  courseCode?: string;
  event?: string;
  sendCalendarInvite?: boolean;
  coBookers?: Rec[];
}

export interface BookingOptions {
  use_types: Option[];
  booking_usages: Option[];
  course_codes: Option[];
  events: Option[];
  co_bookers_required: number;
  needs_approval: boolean;
}

export function bookingOptions(p: Pick<Prepared, "result" | "models">): BookingOptions {
  const m = p.models[0] ?? {};
  const pick = (modelKey: string, resultKey: string) => {
    const own = toOptions(m[modelKey]);
    return own.length ? own : toOptions(p.result[resultKey]);
  };
  return {
    use_types: pick("UseTypeList", "UseTypeList"),
    booking_usages: toOptions(p.result["BookingUsageList"]),
    course_codes: pick("CourseCodeList", "CourseCodeList"),
    events: pick("EventList", "EventList"),
    co_bookers_required: Number(str(m["NoofCoBookerRequired"]) || "0"),
    needs_approval: p.models.some((x) => x["IsRequiredApproval"] === true || x["IsSpaceRequiredApproval"] === true),
  };
}

const nameIn = (list: unknown, id: string): string =>
  id === "" ? "" : (toOptions(list).find((o) => o.id === id)?.name ?? "");

/**
 * Builds the exact records the site's Confirm button submits: the server's
 * own pre-filled models with the user's choices applied on top.
 */
export function buildBookingRecords(p: Pick<Prepared, "result" | "models">, f: BookingFields): Rec[] {
  const opts = bookingOptions(p);
  const choose = (input: string | undefined, options: Option[], label: string, current: string) => {
    if (input) return resolveOption(options, input, label).id;
    if (current) return current;
    return options.length === 1 ? options[0]!.id : "";
  };

  return p.models.map((m) => {
    const useType = choose(f.useType, opts.use_types, "use type", str(m["UseType"]));
    const usage = choose(f.bookingUsage, opts.booking_usages, "booking usage", str(m["BookingUsage"]));
    const course = f.courseCode
      ? resolveOption(opts.course_codes, f.courseCode, "course code").id
      : str(m["CourseCode"]);
    const event = f.event ? resolveOption(opts.events, f.event, "event").id : str(m["EventID"]);
    const day = str(m["DateText"]).slice(0, 10);
    const bookingFor = str(m["BookingFor"]) || "0";
    return {
      SpaceID: str(m["SpaceID"]),
      SpaceName: str(m["SpaceName"]),
      Date: roundTripDateTime(m["Date"]),
      StartDateTime: roundTripDateTime(m["StartDateTime"]),
      EndDateTime: roundTripDateTime(m["EndDateTime"]),
      StartTime: str(m["StartTime"]),
      EndTime: str(m["EndTime"]),
      BuildingID: str(m["BuildingID"]),
      LevelID: str(m["LevelID"]),
      BookingFor: bookingFor,
      BookingFee: str(m["BookingFee"]) || "0",
      UseType: useType,
      CourseCode: course,
      BookingUsage: usage,
      Purpose: f.purpose ?? str(m["Purpose"]),
      IsSendCalendarInvite: f.sendCalendarInvite ?? m["IsSendCalendarInvite"] === true,
      ErrorMessage: str(m["ErrorMessage"]),
      EventID: event,
      IsRequiredApproval: m["IsRequiredApproval"] === true,
      BookingReferenceNo: str(m["BookingReferenceNo"]),
      NoofCoBookerRequired: str(m["NoofCoBookerRequired"]) || "0",
      CoBookersList: { List: f.coBookers ?? [] },
      Status: str(m["Status"]),
      BuildingName: nameIn(p.result["BuildingList"], str(m["BuildingID"])),
      LevelName: nameIn(p.result["FloorsList"], str(m["LevelID"])),
      BookingForName: nameIn(p.result["BookingForList"], bookingFor),
      UseTypeName: nameIn({ List: opts.use_types.map((o) => ({ ObjectID: o.id, ObjectName: o.name })) }, useType),
      CourseCodeName: nameIn({ List: opts.course_codes.map((o) => ({ ObjectID: o.id, ObjectName: o.name })) }, course),
      BookingUsageName: nameIn(p.result["BookingUsageList"], usage),
      DateText: day,
      StartDateTimeText: `${day} ${str(m["StartTime"])}`,
      EndDateTimeText: `${day} ${str(m["EndTime"])}`,
      EventCodeName: nameIn({ List: opts.events.map((o) => ({ ObjectID: o.id, ObjectName: o.name })) }, event),
      BookingForID: str(m["BookingForID"]),
      BookingForNameValue: str(m["BookingForNameValue"]),
      ReasonForEditing: "",
      IsSpaceRequiredApproval: m["IsSpaceRequiredApproval"] === true,
      BookingType: "",
    };
  });
}

export async function searchCoBookers(
  client: FbsClient,
  useTypeName: string,
  search: string,
  startText: string,
  endText: string,
): Promise<Rec[]> {
  const { clientToken } = await client.identity();
  const data = await client.serverAction(
    "BookingFlow/BookingDetails/ActionGetCoBookerDetailsCS",
    BOOKING_VIEW,
    {
      GetCoBookerDetailsRequestCS: useTypeName,
      SearchValue: search || "Load",
      StartDateTimeText: startText,
      EndDateTimeText: endText,
      ClientToken: clientToken,
    },
  );
  return listOf(wrapper(data, "GetCoBookerDetailsResponseCS")["ResultObject"]);
}

async function resolveCoBookers(
  client: FbsClient,
  wanted: string[],
  record: Rec,
): Promise<Rec[]> {
  const chosen: Rec[] = [];
  for (const who of wanted) {
    const found = await searchCoBookers(
      client,
      str(record["UseTypeName"]),
      who,
      str(record["StartDateTimeText"]),
      str(record["EndDateTimeText"]),
    );
    const want = who.trim().toLowerCase();
    const exact = found.filter(
      (c) => str(c["UserID"]).toLowerCase() === want || str(c["NameandEmail"]).toLowerCase().includes(want),
    );
    const pool = exact.length ? exact : found;
    if (pool.length !== 1) {
      const names = pool.map((c) => str(c["NameandEmail"])).slice(0, 10).join("; ");
      throw new Error(
        pool.length === 0
          ? `No eligible co-booker matches "${who}".`
          : `"${who}" matches more than one co-booker: ${names}`,
      );
    }
    const c = pool[0]!;
    chosen.push({
      UserID: str(c["UserID"]),
      NameandEmail: str(c["NameandEmail"]),
      BookingCredits: str(c["BookingCredits"]) || "0",
      IsSelected: true,
    });
  }
  return chosen;
}

export interface CreateInput extends BookingRequest {
  purpose?: string;
  useType?: string;
  bookingUsage?: string;
  courseCode?: string;
  event?: string;
  sendCalendarInvite?: boolean;
  coBookers?: string[];
  confirm: boolean;
  /** Digest from the preview the user agreed to; the booking is refused if it no longer matches. */
  expected?: string;
}

export function describe(r: Rec): Rec {
  return {
    facility: r["SpaceName"],
    date: r["DateText"],
    start: r["StartTime"],
    end: r["EndTime"],
    purpose: r["Purpose"],
    use_type: r["UseTypeName"] || r["UseType"],
    booking_usage: r["BookingUsageName"] || r["BookingUsage"] || undefined,
    course_code: r["CourseCodeName"] || r["CourseCode"] || undefined,
    fee: r["BookingFee"],
    co_bookers: listOf(r["CoBookersList"]).map((c) => c["NameandEmail"]),
    needs_approval: r["IsRequiredApproval"] === true || r["IsSpaceRequiredApproval"] === true,
  };
}

export async function createBooking(client: FbsClient, input: CreateInput): Promise<Rec> {
  const prepared = await prepareBooking(client, input);
  const options = bookingOptions(prepared);
  const fields: BookingFields = {
    purpose: input.purpose,
    useType: input.useType,
    bookingUsage: input.bookingUsage,
    courseCode: input.courseCode,
    event: input.event,
    sendCalendarInvite: input.sendCalendarInvite,
  };
  let records = buildBookingRecords(prepared, fields);
  const missing: string[] = [];
  if (!str(records[0]!["Purpose"]).trim()) missing.push("purpose");
  if (!str(records[0]!["UseType"]) && options.use_types.length > 0) missing.push("use_type");

  const wanted = input.coBookers ?? [];
  if (options.co_bookers_required !== wanted.length && (options.co_bookers_required > 0 || wanted.length > 0)) {
    missing.push(`co_bookers (exactly ${options.co_bookers_required} needed, ${wanted.length} given)`);
  }

  const warnings: string[] = [];
  if (missing.length === 0) {
    const { clientToken } = await client.identity();
    if (wanted.length > 0) {
      fields.coBookers = await resolveCoBookers(client, wanted, records[0]!);
      records = buildBookingRecords(prepared, fields);
    }
    for (const r of records) {
      const fee = await client.serverAction("BookingFlow/BookingDetails/ActionGetBookingFeeCS", BOOKING_VIEW, {
        ClientToken: clientToken,
        GetAmountRequestCS: {
          SpaceID: r["SpaceID"],
          CourseID: r["CourseCode"],
          EventID: r["EventID"],
          UseTypeID: r["UseType"],
          BookingForID: r["BookingForID"],
          Status: r["Status"],
          StartDateTimeText: r["StartDateTimeText"],
          EndDateTimeText: r["EndDateTimeText"],
        },
      });
      const raw = (fee["GetAmountResponseCS"] as Rec | null | undefined)?.["ResultObject"];
      const amount = typeof raw === "string" || typeof raw === "number" ? str(raw).trim() : undefined;
      if (amount === undefined || (amount !== "" && !Number.isFinite(Number(amount)))) {
        throw new FbsApiError(
          `FBS did not return a readable fee for ${str(r["SpaceName"]) || "this booking"}, so it cannot be ` +
            "previewed or booked from here. Try again.",
        );
      }
      if (amount === "") {
        warnings.push(
          `FBS quoted no fee for ${str(r["SpaceName"]) || "this booking"}; the fee shown is the booking form's default.`,
        );
      } else {
        r["BookingFee"] = amount;
      }
    }
  }
  const digest = proposalDigest(records);

  if (missing.length > 0 || !input.confirm) {
    return {
      status: missing.length > 0 ? "needs_input" : "preview",
      booked: false,
      ...(missing.length > 0 ? { missing } : {}),
      would_book: records.map(describe),
      ...(warnings.length > 0 ? { warnings } : {}),
      options,
      ...(missing.length === 0 ? { digest } : {}),
      next: missing.length > 0
        ? "Supply the missing fields and call again."
        : "Nothing has been booked.",
    };
  }
  assertUnchanged(digest, input.expected);

  const { clientToken } = await client.identity();
  const data = await client.serverAction(
    "BookingFlow/BookingDetails/ActionValidateAndCreateBookingCS",
    BOOKING_VIEW,
    {
      ValidateAndCreateBookingRequestCS: { CalendarProcessModels: { List: records } },
      ClientToken: clientToken,
    },
    { write: true },
  );
  const response = (data["ValidateAndCreateBookingResponseCS"] ?? {}) as Rec;
  const out = listOf((response["ResultObject"] as Rec | undefined)?.["CalendarProcessModels"]);
  const errors = out.map((m) => str(m["ErrorMessage"])).filter(Boolean);
  const references = out.map((m) => str(m["BookingReferenceNo"])).filter(Boolean);
  const message = str(response["ResultMessage"]);

  if (errors.length > 0) {
    return { status: "rejected", booked: false, errors, ...(message ? { message } : {}) };
  }
  if (out.length === 0) {
    return {
      status: "unknown",
      booked: false,
      message:
        message ||
        "FBS replied without a booking result. Check fbs_list_my_bookings before trying again.",
    };
  }
  return {
    status: references.length > 0 ? "booked" : "submitted",
    booked: true,
    bookings: out.map((m) => ({
      reference: str(m["BookingReferenceNo"]),
      state: str(m["Status"]),
      facility: str(m["SpaceName"]),
      date: str(m["DateText"]).slice(0, 10),
      start: str(m["StartTime"]),
      end: str(m["EndTime"]),
      fee: str(m["BookingFee"]),
    })),
    ...(references.length === 0
      ? { note: "FBS accepted the request but returned no reference number. Confirm with fbs_list_my_bookings." }
      : {}),
  };
}

export async function listMyBookings(client: FbsClient, search = ""): Promise<Rec[]> {
  const { clientToken } = await client.identity();
  const data = await client.serverAction(
    "MyBookingFlow/BookingsList/ActionMyBookingsSearchPostCS",
    MY_BOOKINGS_VIEW,
    {
      MyBookingsSearchRequestCS: {
        Search: search,
        StartDateTime: "",
        EndDateTime: "",
        BookingCreatedDate: "",
        DateTime: new Date().toISOString(),
        BuildingID: "",
        FloorID: "",
        FacilityTypeID: "",
        FacilityID: "",
        BookedBy: "",
        BookedFor: "",
        EventID: "",
        CourseID: "",
        Purpose: "",
        Status: "",
        UseTypeID: "",
        TypeOfTransaction: "",
        TypeOfBookings: "",
        SearchType: "Normal",
        TypeOfRequest: "",
        TypeOfServiceRequest: "",
        StartDateTimeText: "",
        EndDateTimeText: "",
        Day: "",
      },
      ClientToken: clientToken,
    },
  );
  const result = (wrapper(data, "MyBookingsSearchResponseCS")["ResultObject"] ?? {}) as Rec;
  return listOf(result["CalendarProcessModels"]).map((m) => ({
    booking_id: str(m["SpaceBookingID"]),
    space_id: str(m["SpaceID"]),
    booking_for_id: str(m["BookingForID"]) || str(m["BookingFor"]),
    reference: str(m["BookingReferenceNo"]),
    facility: str(m["SpaceName"]),
    date: str(m["DateText"]).slice(0, 10),
    start: str(m["StartTime"]),
    end: str(m["EndTime"]),
    status: str(m["Status"]),
    purpose: str(m["Purpose"]),
    use_type: str(m["UseTypeName"]),
    fee: str(m["BookingFee"]),
    co_bookers: listOf(m["CoBookersList"]).map((c) => str(c["NameandEmail"])).filter(Boolean),
  }));
}

export async function cancelBookings(
  client: FbsClient,
  bookingIds: string[],
  reason: string,
  confirm: boolean,
  expected?: string,
): Promise<Rec> {
  if (bookingIds.length === 0) throw new Error("Give at least one booking_id.");
  const { clientToken } = await client.identity();
  const mine = await listMyBookings(client);
  const targets = bookingIds.map((id) => {
    const found = mine.find((b) => b["booking_id"] === id);
    if (!found) throw new Error(`Booking ${id} is not in your current bookings.`);
    return found;
  });

  const feeData = await client.serverAction(
    "MyBookingFlow/BookingsList/ActionMyBookingsGetCancelorEditFeeCS",
    MY_BOOKINGS_VIEW,
    {
      MyBookingsGetCancelorEditFeeRequestCS: { SpaceBookingIDs: { List: bookingIds }, Type: "Cancel" },
      ClientToken: clientToken,
    },
  );
  const feeList = wrapper(feeData, "MyBookingsGetCancelorEditFeeResponseCS")["ResultObject"];
  if (!Array.isArray((feeList as { List?: unknown } | null | undefined)?.List)) {
    throw new FbsApiError(
      "FBS did not return a readable cancellation fee, so nothing was cancelled. Try again.",
    );
  }
  const fees = toOptions(feeList);
  const digest = proposalDigest({ bookingIds, reason, targets, fees });

  if (!confirm) {
    return {
      status: "preview",
      cancelled: false,
      would_cancel: targets,
      cancellation_fees: fees,
      next: "Nothing has been cancelled.",
      digest,
    };
  }
  assertUnchanged(digest, expected);

  const data = await client.serverAction(
    "MyBookingFlow/BookingsList/ActionMyBookingsCancelCS",
    MY_BOOKINGS_VIEW,
    {
      MyBookingsCancelRequestCS: {
        SpaceBookingIDs: { List: bookingIds },
        CancelReason: reason,
        RequestType: "",
      },
      ClientToken: clientToken,
    },
    { write: true },
  );
  const response = (data["MyBookingsCancelResponseCS"] ?? {}) as Rec;
  const messages = listOf(response["ResultObject"]).map((x) => str(x)).filter(Boolean);
  const stillThere = (await listMyBookings(client)).filter(
    (b) => bookingIds.includes(str(b["booking_id"])) && !/cancel|withdraw/i.test(str(b["status"])),
  );
  return {
    status: stillThere.length === 0 ? "cancelled" : "not_confirmed",
    cancelled: stillThere.length === 0,
    fbs_messages: messages,
    ...(str(response["ResultMessage"]) ? { message: str(response["ResultMessage"]) } : {}),
    ...(stillThere.length > 0 ? { still_active: stillThere } : {}),
  };
}

export async function getCredits(client: FbsClient): Promise<string> {
  const data = await client.dataAction("Common/Profile/DataActionFetchCredits", "Common.Profile", {});
  return str(data["Out1"]);
}

export interface EditBookingInput extends Omit<BookingFields, "coBookers"> {
  bookingId: string;
  coBookers?: string[];
  startTime?: string;
  endTime?: string;
  reasonForEditing?: string;
  confirm?: boolean;
  /** Digest from the preview the user agreed to; the edit is refused if it no longer matches. */
  expected?: string;
}

async function ownedBooking(client: FbsClient, id: string): Promise<Rec> {
  const found = (await listMyBookings(client)).find((b) => b["booking_id"] === id);
  if (!found) throw new Error(`Booking ${id} is not in your current bookings.`);
  return found;
}

async function updateBooking(client: FbsClient, screen: string, record: Rec): Promise<Rec> {
  const { clientToken } = await client.identity();
  const transfer = record["Status"] === "Transferred";
  const previousIds = transfer
    ? new Set<unknown>()
    : new Set((await listMyBookings(client)).map((b) => b["booking_id"]));
  const data = await client.serverAction(
    `MyBookingFlow/${screen}/ActionMyBookingsUpdateCS`,
    MY_BOOKINGS_VIEW,
    {
      MyBookingUpdateRequestCS: { CalendarProcessModels: { List: [record] } },
      ClientToken: clientToken,
    },
    { write: true },
  );
  const response = data["MyBookingUpdateResponseCS"] as Rec | undefined;
  const message = str(response?.["ResultMessage"]);
  const acknowledged =
    response?.["IsSuccess"] === true ||
    response?.["ResultCode"] === "SMUE00" ||
    /\b(?:updated|transferred)\s+successfully\b/i.test(str(response?.["ResultObject"]));
  let bookings: Rec[];
  try {
    bookings = await listMyBookings(client);
  } catch (err) {
    if (response?.["IsSuccess"] === false && !acknowledged && message) {
      return { status: "rejected", message, fbs_response: response };
    }
    return {
      status: "not_confirmed",
      ...(message ? { message } : {}),
      fbs_response: response,
      note: `Booking verification failed: ${err instanceof Error ? err.message : String(err)}. ` +
        "Check fbs_list_my_bookings before retrying the write.",
    };
  }
  const booking = bookings.find((b) => b["booking_id"] === record["SpaceBookingID"]);
  const matches = transfer
    ? []
    : bookings.filter(
        (b) =>
          (b["booking_id"] === record["SpaceBookingID"] || !previousIds.has(b["booking_id"])) &&
          !/cancel|withdraw/i.test(str(b["status"])) &&
          (b["space_id"] ? b["space_id"] === str(record["SpaceID"]) : b["facility"] === str(record["SpaceName"])) &&
          b["date"] === str(record["DateText"]).slice(0, 10) &&
          b["purpose"] === str(record["Purpose"]) &&
          b["start"] === str(record["StartTime"]) &&
          b["end"] === str(record["EndTime"]),
      );
  const edited =
    matches.find((b) => b["booking_id"] === record["SpaceBookingID"]) ??
    (matches.length === 1 ? matches[0] : undefined);
  const verified = transfer
    ? acknowledged && (!booking || booking["booking_for_id"] === record["BookingForID"])
    : edited !== undefined;
  if (!verified && !acknowledged && response?.["IsSuccess"] === false && message) {
    return { status: "rejected", message, fbs_response: response, bookings };
  }
  return {
    status: verified ? (transfer ? "transferred" : "updated") : "not_confirmed",
    ...(edited && edited["booking_id"] !== record["SpaceBookingID"]
      ? { replaced_by: { booking_id: edited["booking_id"], reference: edited["reference"] } }
      : {}),
    ...(message ? { message } : {}),
    fbs_response: response,
    bookings,
  };
}

export async function editBooking(client: FbsClient, input: EditBookingInput): Promise<Rec> {
  await ownedBooking(client, input.bookingId);
  const data = await client.dataAction(
    "MyBookingFlow/MyBookingEdit/DataActionFetchSpaceBookingValues",
    MY_BOOKINGS_VIEW,
    {
      SpaceBookingID: input.bookingId,
    },
  );
  const result = wrapper(data, "EditResponseOut")["ResultObject"] as Rec;
  const models = listOf(result?.["CalendarProcessModels"]);
  if (models.length !== 1) throw new FbsApiError("FBS returned no single booking to edit.");
  const current = models[0]!;
  const record: Rec = { ...current, SpaceBookingID: input.bookingId };
  const options = bookingOptions({ result, models });
  for (const [value, key, nameKey, choices] of [
    [input.useType, "UseType", "UseTypeName", options.use_types],
    [input.bookingUsage, "BookingUsage", "BookingUsageName", options.booking_usages],
    [input.courseCode, "CourseCode", "CourseCodeName", options.course_codes],
    [input.event, "EventID", "EventCodeName", options.events],
  ] as const) {
    if (value !== undefined) {
      const option = resolveOption(choices, value, key);
      record[key] = option.id;
      record[nameKey] = option.name;
    }
  }
  if (input.purpose !== undefined) record["Purpose"] = input.purpose;
  if (input.sendCalendarInvite !== undefined) record["IsSendCalendarInvite"] = input.sendCalendarInvite;
  record["ReasonForEditing"] = input.reasonForEditing ?? "";
  const day = str(current["DateText"]).slice(0, 10);
  const start = input.startTime !== undefined ? normaliseTime(input.startTime) : str(current["StartTime"]);
  const end = input.endTime !== undefined ? normaliseTime(input.endTime) : str(current["EndTime"]);
  if (start !== current["StartTime"] || end !== current["EndTime"]) {
    const req = { date: day, spaceId: str(current["SpaceID"]), startTime: start, endTime: end };
    const room = (await getSchedule(client, [req.spaceId], day)).find((r) => r.spaceId === req.spaceId);
    if (!room) throw new Error("FBS returned no schedule for the booked room.");
    const currentStart = timeToIndex(str(current["StartTime"]));
    const currentEnd = timeToIndex(str(current["EndTime"]));
    selectSlots(
      {
        ...room,
        slots: room.slots.map((slot) =>
          slot.index >= currentStart && slot.index < currentEnd ? { ...slot, status: "free" as const } : slot,
        ),
      },
      req,
    );
    record["StartTime"] = start;
    record["EndTime"] = end;
    record["StartDateTimeText"] = `${day} ${start}`;
    record["EndDateTimeText"] = `${day} ${end}`;
    record["StartDateTime"] = new Date(`${day}T${start}:00+08:00`).toISOString();
    record["EndDateTime"] = new Date(`${day}T${end}:00+08:00`).toISOString();
  }
  if (input.coBookers !== undefined) {
    if (input.coBookers.length !== options.co_bookers_required) {
      throw new Error(`Exactly ${options.co_bookers_required} co_bookers required.`);
    }
    record["CoBookersList"] = { List: await resolveCoBookers(client, input.coBookers, record) };
  }
  const { clientToken } = await client.identity();
  const fee = wrapper(
    await client.serverAction("MyBookingFlow/MyBookingEdit/ActionMyBookingsGetCancelorEditFeeCS", MY_BOOKINGS_VIEW, {
      MyBookingsGetCancelorEditFeeRequestCS: { SpaceBookingIDs: { List: [input.bookingId] }, Type: "Zero" },
      ClientToken: clientToken,
    }),
    "MyBookingsGetCancelorEditFeeResponseCS",
  )["ResultObject"];
  const digest = proposalDigest({ record, fee });
  if (!input.confirm) return { status: "preview", current, proposed: record, edit_fees: fee, digest };
  assertUnchanged(digest, input.expected);
  return updateBooking(client, "MyBookingEdit", record);
}

export async function transferBooking(
  client: FbsClient,
  bookingId: string,
  person: string,
  confirm = false,
  expected?: string,
): Promise<Rec> {
  const current = await ownedBooking(client, bookingId);
  const { clientToken } = await client.identity();
  const base = "MyBookingFlow/MyBookingTransfer/";
  const users = wrapper(
    await client.serverAction(base + "ActionBookingForOtherUsersCS", MY_BOOKINGS_VIEW, {
      BookingForOtherUsersRequestType: "Staff",
      BookingForOtherUsersRequestSearchValue: person,
      ClientToken: clientToken,
    }),
    "BookingForOtherResponseCS",
  );
  const user = resolveOption(toOptions(users["ResultObject"]), person, "recipient");
  const result = wrapper(
    await client.serverAction(base + "ActionMyBookingsEditGetCS", MY_BOOKINGS_VIEW, {
      MyBookingEditRequestCS: bookingId,
      bookingForCS: user.id,
      ClientToken: clientToken,
    }),
    "MyBookingEditResponseCS",
  )["ResultObject"] as Rec;
  const models = listOf(result?.["CalendarProcessModels"]);
  if (models.length !== 1) throw new FbsApiError("FBS returned no single booking to transfer.");
  const record = {
    ...models[0]!,
    SpaceBookingID: bookingId,
    BookingForID: user.id,
    BookingFor: user.id,
    BookingForName: user.name,
    BookingForNameValue: user.name,
    Status: "Transferred",
  };
  const digest = proposalDigest(record);
  if (!confirm) return { status: "preview", current, recipient: user, proposed: record, digest };
  assertUnchanged(digest, expected);
  return updateBooking(client, "MyBookingTransfer", record);
}

export async function listTasks(client: FbsClient, search = ""): Promise<Rec[]> {
  const { clientToken } = await client.identity();
  const request: Rec = {};
  for (const key of [
    "StartDateTime",
    "EndDateTime",
    "BookingCreatedDate",
    "BuildingID",
    "FloorID",
    "FacilityTypeID",
    "FacilityID",
    "BookedBy",
    "BookedFor",
    "EventID",
    "CourseID",
    "Purpose",
    "Status",
    "UseTypeID",
    "TypeOfTransaction",
    "TypeOfBookings",
    "SearchType",
    "TypeOfRequest",
    "TypeOfServiceRequest",
    "StartDateTimeText",
    "EndDateTimeText",
    "Day",
  ]) {
    request[key] = "";
  }
  const data = await client.serverAction(
    "TaskListFlow/TaskListDetails/ActionMyTaskSearchPostCS",
    "TaskListFlow.TaskList",
    {
      MyTaskSearchRequestCS: { ...request, Search: search, DateTime: new Date().toISOString() },
      ClientToken: clientToken,
    },
  );
  return listOf(wrapper(data, "MyTaskSearchResponseCS")["ResultObject"]);
}

/** The fields of a pending task worth showing; free text from the requester is flattened and capped. */
export function describeTask(t: Rec): Rec {
  const out: Rec = {
    activity_id: str(t["ActivityID"]),
    booking_id: str(t["AttachedObjectID"]),
    reference: str(t["ReferenceNo"]),
    task: clip(t["TaskName"], 120),
    request_type: clip(t["TaskRequestType"], 120),
    facility: clip(t["SpaceName"], 120),
    building: clip(t["BuildingName"], 120),
    floor: clip(t["FloorName"], 120),
    date: str(t["Date"]),
    start: str(t["StartTime"]),
    end: str(t["EndTime"]),
    requested_by: clip(t["RequestedBy"], 120),
    status: str(t["Status"]),
    use_type: clip(t["UseType"], 120),
    details: clip(t["TaskDetails"]),
    remarks: clip(t["Remarks"]),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== ""));
}

export async function respondToTask(
  client: FbsClient,
  activityId: string,
  action: "confirm" | "reject",
  comments = "",
  confirm = false,
  expected?: string,
): Promise<Rec> {
  const task = (await listTasks(client)).find((t) => t["ActivityID"] === activityId);
  if (!task) throw new Error(`Task ${activityId} is not in your pending tasks.`);
  const request = {
    Comments: comments,
    MyTaskActionList: {
      List: [
        {
          ActivityID: activityId,
          SpaceBookingID: str(task["AttachedObjectID"]),
          ReferenceNo: str(task["ReferenceNo"]),
        },
      ],
    },
  };
  const digest = proposalDigest({ action, request });
  if (!confirm) return { status: "preview", action, task: describeTask(task), comments, digest };
  assertUnchanged(digest, expected);
  const { clientToken } = await client.identity();
  const verb = action === "confirm" ? "Confirm" : "Cancel";
  const data = await client.serverAction(
    `TaskListFlow/TaskListDetails/ActionMyTask${verb}CS`,
    "TaskListFlow.TaskList",
    {
      [`MyTask${verb}RequestCS`]: request,
      ClientToken: clientToken,
    },
    { write: true },
  );
  const response = data[`MyTask${verb}ResponseCS`] as Rec | undefined;
  if (!response) throw new FbsApiError("FBS returned no task response; check fbs_list_tasks before retrying.");
  if (response["IsSuccess"] === false) throw new FbsApiError(str(response["ResultMessage"]));
  return {
    status: "submitted",
    fbs_response: response,
    pending_tasks: (await listTasks(client)).map(describeTask),
  };
}
