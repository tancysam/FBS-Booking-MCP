import fs from "node:fs";
import { homeDir, ORIGIN, versionCachePath } from "./config.js";

/**
 * Every FBSM endpoint carries its own apiVersion hash, baked into the site's
 * JavaScript. The hashes change whenever SMU redeploys, so the ones below are
 * only a starting point: `refresh()` re-reads them from the live scripts.
 */
export const BAKED_MODULE_VERSION = "Lv9fcYdKqEVuoaj9K9DIyg";

export const BAKED_API_VERSIONS: Record<string, string> = {
  "MyBookingFlow/MyBookingEdit/ActionMyBookingsUpdateCS": "u_EEp3qsff+JvkUUQAjLHg",
  "MyBookingFlow/MyBookingEdit/ActionMyBookingsGetCancelorEditFeeCS": "Jk7ZqRcg6inTAVjKgbVCVw",
  "MyBookingFlow/MyBookingEdit/ActionBookingForOtherUsersCS": "VbOsNBc7NGlfDZnbZwp7Hg",
  "MyBookingFlow/MyBookingEdit/DataActionFetchSpaceBookingValues": "F2N20S2FiNHDq1c23408zg",
  "MyBookingFlow/MyBookingTransfer/ActionMyBookingsGetCancelorEditFeeCS": "Jk7ZqRcg6inTAVjKgbVCVw",
  "MyBookingFlow/MyBookingTransfer/ActionMyBookingsEditGetCS": "hw6L0zDHPH3TvWhxOJd1GA",
  "MyBookingFlow/MyBookingTransfer/ActionMyBookingsUpdateCS": "u_EEp3qsff+JvkUUQAjLHg",
  "MyBookingFlow/MyBookingTransfer/ActionBookingForOtherUsersCS": "VbOsNBc7NGlfDZnbZwp7Hg",
  "MyBookingFlow/MyBookingTransfer/DataActionFetchSpaceBookingValues": "F2N20S2FiNHDq1c23408zg",
  "TaskListFlow/TaskListDetails/ActionMyTaskSearchPostCS": "cwXRbHXQArEFsUGNcAenZQ",
  "TaskListFlow/TaskListDetails/ActionMyTaskCancelCS": "HFJtqX7x8oCgFqOoogNGFA",
  "TaskListFlow/TaskListDetails/ActionMyTaskConfirmCS": "J+X3c_IzgFq5yuGf1qaIfA",
  "Common/InitializeUserSession/ActionGetUsername": "tcyZHg7aNlk1MpXENIzD8g",
  "Common/InitializeUserSession/ActionLoginSSO": "z8HpBsI_Bojd8GPuzHQgOg",
  "Common/Profile/DataActionFetchCredits": "i5O2mn3aGvW4a0RLPc3gcw",
  "BookingFlow/FacilitySearch/DataActionBuildings": "zgmuaiDaAm2yx3h086x7Cg",
  "BookingFlow/FacilitySearch/DataActionLevels": "g8rx_mAmpaoolNVl+Te2ng",
  "BookingFlow/FacilitySearch/DataActionFacilityTypes": "c+1snxm5CTy2Z9FgbckfGQ",
  "BookingFlow/FacilitySearch/DataActionCapacitys": "AH6W0HiPxYAN9yTqubpalA",
  "BookingFlow/FacilitySearch/DataActionEquipments": "HaeDDS+LsXuEnHN2lhQrbg",
  "BookingFlow/FacilitySearch/ActionSearchCS": "sWpqqYYnfJt8tOLXnkT8iA",
  "BookingFlow/FacilitySearch/ActionSpaceDetails": "UQLae0R1jvEPGfECVvhsdA",
  "BookingFlow/BookingSchedule/ActionBookingScheduleCS": "fFPEcy3uIt1MBSGQah3Umg",
  "BookingFlow/BookingSchedule/ActionBookingScheduleCreditValidationCS": "VwSFbt73r+qXLHhtCag+jA",
  "BookingFlow/BookingDetails/DataActionFetchDataFromBookingDetails": "Wx6whGgV7L9rVbIu1cBk7g",
  "BookingFlow/BookingDetails/ActionGetBookingFeeCS": "XZbzDc4mNEqL_L8QpwBngg",
  "BookingFlow/BookingDetails/ActionGetCoBookerDetailsCS": "FO2HRGlWTHC2cL9BTvnvYQ",
  "BookingFlow/BookingDetails/ActionValidateAndCreateBookingCS": "fyof3Rv8DEUNJHGeyFAv7w",
  "MyBookingFlow/BookingsList/ActionMyBookingsSearchPostCS": "_8OegwvyrZjo9dpglwwNuQ",
  "MyBookingFlow/BookingsList/ActionMyBookingsGetCancelorEditFeeCS": "Jk7ZqRcg6inTAVjKgbVCVw",
  "MyBookingFlow/BookingsList/ActionMyBookingsCancelCS": "m7wBjjxTxckcWeYgz34nxg",
};

const CALL_RE =
  /call(?:ServerAction|DataAction|AggregateWithStartIndexAndClientVars)\("[^"]+",\s*"screenservices\/FBSMobile_UI\/([^"]+)",\s*"([^"]+)"/g;

/** Finds every `endpoint path -> apiVersion` pair in one of the site's screen scripts. */
export function extractApiVersions(script: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const m of script.matchAll(CALL_RE)) {
    found[m[1]!] = m[2]!;
  }
  return found;
}

/** `BookingFlow/BookingDetails/ActionX` lives in `FBSMobile_UI.BookingFlow.BookingDetails.mvc.js`. */
export function scriptNameFor(endpoint: string): string {
  const [flow, block] = endpoint.split("/");
  return `/FBSMobile_UI/scripts/FBSMobile_UI.${flow}.${block}.mvc.js`;
}

export type Fetcher = (url: string) => Promise<string>;

interface Cache {
  moduleVersion: string;
  versions: Record<string, string>;
}

export class ApiVersions {
  moduleVersion = BAKED_MODULE_VERSION;
  private versions: Record<string, string> = { ...BAKED_API_VERSIONS };

  constructor(private readonly fetchText: Fetcher) {
    try {
      const cache = JSON.parse(fs.readFileSync(versionCachePath(), "utf8")) as Cache;
      if (cache.moduleVersion && cache.versions) {
        this.moduleVersion = cache.moduleVersion;
        this.versions = { ...BAKED_API_VERSIONS, ...cache.versions };
      }
    } catch {
      // no cache yet
    }
  }

  get(endpoint: string): string {
    const v = this.versions[endpoint];
    if (!v) throw new Error(`No apiVersion known for endpoint ${endpoint}`);
    return v;
  }

  /** Re-reads the module version and every endpoint hash from the live site. */
  async refresh(): Promise<void> {
    const info = JSON.parse(
      await this.fetchText(`${ORIGIN}/FBSMobile_UI/moduleservices/moduleinfo`),
    ) as { manifest?: { versionToken?: string; urlVersions?: Record<string, string> } };
    const urlVersions = info.manifest?.urlVersions ?? {};
    const scripts = new Set(Object.keys(BAKED_API_VERSIONS).map(scriptNameFor));
    const fresh: Record<string, string> = {};
    for (const script of scripts) {
      const suffix = urlVersions[script];
      if (suffix === undefined) continue;
      const url = ORIGIN + script + suffix.replace(/\+/g, "%2B");
      Object.assign(fresh, extractApiVersions(await this.fetchText(url)));
    }
    const missing = Object.keys(BAKED_API_VERSIONS).filter((e) => !fresh[e]);
    if (missing.length === Object.keys(BAKED_API_VERSIONS).length) {
      throw new Error("Could not read any apiVersion from the FBSM scripts; the site layout may have changed.");
    }
    this.versions = { ...this.versions, ...fresh };
    if (info.manifest?.versionToken) this.moduleVersion = info.manifest.versionToken;
    try {
      fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
      const cache: Cache = { moduleVersion: this.moduleVersion, versions: this.versions };
      fs.writeFileSync(versionCachePath(), JSON.stringify(cache, null, 2));
    } catch {
      // the cache is only an optimisation
    }
  }
}
