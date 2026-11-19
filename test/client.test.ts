import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { BrowserSession } from "../src/browser.js";
import { redact } from "../src/config.js";
import { FbsClient } from "../src/client.js";
import { SessionError } from "../src/session.js";
import { fakeBrowser } from "./helpers.js";

const endpoint = "Common/InitializeUserSession/ActionGetUsername";
function fixture(status: number, body: string) {
  let sends = 0, refreshes = 0;
  const client = new FbsClient(fakeBrowser((async () => {
    sends++;
    return new Response(body, { status });
  }) as typeof fetch));
  client.versions.refresh = async () => { refreshes++; };
  return { client, session: client.session, sends: () => sends, refreshes: () => refreshes };
}

test("debug output masks cookies, CSRF and backend tokens", () => {
  const line = redact(
    'Cookie: nr1Users=lid%3dabc; nr2Users=crf%3dSECRET%3buid%3d5 X-CSRFToken: SECRET2 {"ClientToken":"TOK123","Username":"jane"}',
  );
  for (const secret of ["abc", "SECRET", "SECRET2", "TOK123"]) assert.equal(line.includes(secret), false, line);
  assert.match(line, /"Username":"jane"/);
});

test("FBS_DEBUG logs requests to stderr without their headers or body", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "error", (m: string) => { lines.push(m); });
  const f = fixture(200, '{"data":{"Username":"jane"}}');
  await f.client.serverAction(endpoint, "view", {});
  assert.deepEqual(lines, [], "silent unless asked");
  process.env.FBS_DEBUG = "1";
  t.after(() => { delete process.env.FBS_DEBUG; });
  await f.client.serverAction(endpoint, "view", {});
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^\[fbs debug\] POST \/FBSMobile_UI\/screenservices\/.*ActionGetUsername -> HTTP 200 in \d+ ms$/);
});

for (const body of ["<html>missing</html>", '{"data":{"Username":"wrong"}}']) {
  test("404 reports a changed screen regardless of body", async () => {
    const f = fixture(404, body);
    await assert.rejects(f.client.serverAction(endpoint, "view", {}), /screen.*changed/i);
    assert.equal(f.sends(), 1);
  });
}
for (const status of [201, 401, 403, 500]) {
  test(`HTTP ${status} never counts as success`, async () => {
    const f = fixture(status, '{"data":{"Username":"wrong"}}');
    await assert.rejects(f.client.serverAction(endpoint, "view", {}), new RegExp(`HTTP ${status}`));
  });
}
for (const status of [200, 503]) {
  test(`HTTP ${status} processes the JSON envelope`, async () => {
    const f = fixture(status, '{"data":{"Username":"jane"}}');
    assert.deepEqual(await f.client.serverAction(endpoint, "view", {}), { Username: "jane" });
  });
}
for (const flags of [
  { hasApiVersionChanged: true },
  { hasModuleVersionChanged: true },
  { hasApiVersionChanged: true, hasModuleVersionChanged: false },
]) {
  test(`a single version flag is accepted: ${JSON.stringify(flags)}`, async () => {
    const f = fixture(200, JSON.stringify({ versionInfo: flags, data: { Username: "jane" } }));
    assert.deepEqual(await f.client.serverAction(endpoint, "view", {}), { Username: "jane" });
    assert.equal(f.sends(), 1);
    assert.equal(f.refreshes(), 0);
  });
}
for (const write of [false, true]) {
  test(`an apiVersion flag without data is stale, not an empty success (write=${write})`, async () => {
    const f = fixture(200, JSON.stringify({ versionInfo: { hasApiVersionChanged: true } }));
    await assert.rejects(f.client.serverAction(endpoint, "view", {}, { write }), write ? /not accepted/ : /keeps rejecting/);
    assert.equal(f.sends(), write ? 1 : 2);
    assert.equal(f.refreshes(), 1);
  });
}
for (const write of [false, true]) {
  test(`both flags refresh but only reads retry (write=${write})`, async () => {
    const f = fixture(503, JSON.stringify({ versionInfo: { hasApiVersionChanged: true, hasModuleVersionChanged: true } }));
    await assert.rejects(f.client.serverAction(endpoint, "view", {}, { write }));
    assert.equal(f.sends(), write ? 1 : 2);
    assert.equal(f.refreshes(), 1);
  });
}
test("a write that fails in transit says the outcome is unknown, a read does not", async () => {
  for (const [error, expected] of [
    [new TypeError("fetch failed"), /Could not reach FBS.*not known whether FBS applied the change/],
    [new DOMException("The operation was aborted due to timeout", "TimeoutError"), /did not answer .* within 30 seconds.*not known whether/],
  ] as const) {
    const client = new FbsClient(fakeBrowser((async () => { throw error; }) as unknown as typeof fetch));
    await assert.rejects(client.serverAction(endpoint, "view", {}, { write: true }), expected);
    await assert.rejects(client.serverAction(endpoint, "view", {}), (err: Error) => !/not known whether/.test(err.message));
  }
  const failed = fixture(500, "oops");
  await assert.rejects(failed.client.serverAction(endpoint, "view", {}, { write: true }), /HTTP 500.*fbs_list_my_bookings/);
  const exception = fixture(200, JSON.stringify({ exception: { name: "ServerException", message: "boom" } }));
  await assert.rejects(exception.client.serverAction(endpoint, "view", {}, { write: true }), /boom.*not known whether/);
});

function browserFixture(t: TestContext) {
  let clock = 0;
  t.mock.method(Date, "now", () => (clock += 500));
  let expired = false, failRenewal = false, expireAtUsername = false;
  let username = "jane", renewals = 0, writes = 0;
  const sentTokens: unknown[] = [];
  const endpoint = "Common/Profile/DataActionFetchCredits";
  const writeEndpoint = "MyBookingFlow/BookingsList/ActionMyBookingsCancelCS";
  const expiredReply = () => Response.json({ exception: { name: "NotRegisteredException" } }, { status: 503 });
  const browser: BrowserSession = {
    name: "Chrome",
    isOpen: true,
    openForSignIn: async () => {},
    renew: async () => { renewals++; expired = failRenewal; expireAtUsername = failRenewal; },
    async fetch(url, init) {
      const headers = new Headers(init.headers);
      assert.equal(headers.has("Cookie"), false);
      assert.equal(headers.has("X-CSRFToken"), false);
      if (url.endsWith("/ActionGetUsername")) {
        if (expireAtUsername) return expiredReply();
        return Response.json({ data: { Username: username } });
      }
      if (url.endsWith("/ActionLoginSSO")) {
        return Response.json({ data: { LoginResponse: { Token: `token-${renewals}` } } });
      }
      if (url.endsWith(writeEndpoint)) {
        writes++;
        return expired ? expiredReply() : Response.json({ data: {} });
      }
      assert.ok(url.endsWith(endpoint));
      sentTokens.push(JSON.parse(String(init.body)).clientVariables.ClientToken);
      return expired ? expiredReply() : Response.json({ data: { credits: 5 } });
    },
  };
  const client = new FbsClient(browser);
  return {
    client, session: client.session, sentTokens,
    expire: (permanent = false) => { expired = true; failRenewal = permanent; },
    expireBeforeWrite: () => { expireAtUsername = true; },
    switchUser: () => { username = "someone else"; },
    renewals: () => renewals,
    writes: () => writes,
    getCredits: () => client.withSession(() => client.dataAction(endpoint, "view", {})),
    cancel: () => client.withSession(() => client.serverAction(writeEndpoint, "view", {}, { write: true }), true),
  };
}

test("Chrome renews an expired read and rebuilds it with a new backend token", async (t) => {
  const f = browserFixture(t);
  f.expire();
  assert.deepEqual(await f.getCredits(), { credits: 5 });
  assert.deepEqual(f.sentTokens, ["token-0", "token-1"]);
  assert.equal(f.renewals(), 1);
});

test("Chrome renewal and read retry are attempted only once", async (t) => {
  const f = browserFixture(t);
  f.expire(true);
  await assert.rejects(f.getCredits(), SessionError);
  assert.deepEqual(f.sentTokens, ["token-0"]);
  assert.equal(f.renewals(), 1);
});

test("Chrome renews before submitting a write when account preflight detects expiry", async (t) => {
  const f = browserFixture(t);
  f.expireBeforeWrite();
  await f.cancel();
  assert.equal(f.renewals(), 1);
  assert.equal(f.writes(), 1);
});

test("Chrome never resends a write that received an auth error", async (t) => {
  const f = browserFixture(t);
  await f.client.identity();
  f.expire();
  await assert.rejects(f.cancel(), /not retried.*Check My Bookings or Tasks/);
  assert.equal(f.renewals(), 1);
  assert.equal(f.writes(), 1);
  assert.equal(f.session.data.clientToken, "token-1");
});

test("Chrome refuses recovery into a different account", async (t) => {
  const f = browserFixture(t);
  await f.client.identity();
  f.switchUser();
  await assert.rejects(f.cancel(), /account in Chrome changed/);
  assert.equal(f.writes(), 0);
});

for (const [what, status, body] of [
  ["a redirect to sign-in", 302, ""],
  ["HTTP 403", 403, "<html>Forbidden</html>"],
  ["a sign-in page", 200, "<!DOCTYPE html><html><body><form>SMU Login</form></body></html>"],
] as const) {
  test(`${what} is reported as an expired session with the sign-in hint`, async () => {
    const f = fixture(status, body);
    await assert.rejects(f.client.serverAction(endpoint, "view", {}), (err: Error) => {
      assert.ok(err instanceof SessionError, err.message);
      assert.match(err.message, /dedicated browser window.*fbs_login/);
      return true;
    });
    assert.equal(f.sends(), 1);
  });
}

test("a firewall block is not mistaken for an expired session", async () => {
  for (const status of [200, 403]) {
    const f = fixture(status, "<html><head><title>Request Rejected</title></head></html>");
    await assert.rejects(f.client.serverAction(endpoint, "view", {}), (err: Error) => {
      assert.equal(err instanceof SessionError, false);
      assert.match(err.message, /firewall/);
      return true;
    });
  }
});
