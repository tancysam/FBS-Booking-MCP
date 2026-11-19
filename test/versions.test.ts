import assert from "node:assert/strict";
import { test } from "node:test";
import { extractApiVersions, scriptNameFor } from "../src/versions.js";

test("extractApiVersions finds every kind of endpoint call", () => {
  const js = `
    return controller.callServerAction("SearchCS", "screenservices/FBSMobile_UI/BookingFlow/FacilitySearch/ActionSearchCS", "aaa+1", inputs);
    controller.callDataAction("DataActionBuildings", "screenservices/FBSMobile_UI/BookingFlow/FacilitySearch/DataActionBuildings", "bbb_2", fn);
    controller.callAggregateWithStartIndexAndClientVars("ScreenDataSetTimeList", "screenservices/FBSMobile_UI/BookingFlow/FacilitySearch/ScreenDataSetTimeList", "ccc", 1);`;
  assert.deepEqual(extractApiVersions(js), {
    "BookingFlow/FacilitySearch/ActionSearchCS": "aaa+1",
    "BookingFlow/FacilitySearch/DataActionBuildings": "bbb_2",
    "BookingFlow/FacilitySearch/ScreenDataSetTimeList": "ccc",
  });
});

test("scriptNameFor points at the screen's script", () => {
  assert.equal(
    scriptNameFor("BookingFlow/BookingDetails/ActionValidateAndCreateBookingCS"),
    "/FBSMobile_UI/scripts/FBSMobile_UI.BookingFlow.BookingDetails.mvc.js",
  );
});
