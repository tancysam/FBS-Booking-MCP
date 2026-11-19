import assert from "node:assert/strict";
import { test } from "node:test";
import { FbsClient } from "../src/client.js";
import { startKeepAlive } from "../src/keepalive.js";
import { fakeBrowser } from "./helpers.js";

const MIN = 60_000;
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
};

function fixture(reply: () => Response, signedIn = true) {
  const sent: string[] = [];
  const client = new FbsClient(fakeBrowser((async (url: string) => {
    sent.push(String(url));
    return reply();
  }) as typeof fetch));
  // Keep-alive only pings a sign-in that a tool has already verified.
  if (signedIn) client.session.data.clientToken = "TOK";
  const logs: string[] = [];
  return { client, session: client.session, sent, logs };
}

const ok = () => new Response('{"data":{"Username":"jane"}}', { status: 200 });

test("pings FBS once per idle interval", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  const f = fixture(ok);
  const stop = startKeepAlive(f.client, { intervalMs: 20 * MIN, log: (m) => f.logs.push(m) });
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(f.sent.length, 1, "pings at startup, since the saved session may already be idle");
  assert.match(f.sent[0]!, /ActionGetUsername$/);
  t.mock.timers.tick(19 * MIN);
  await flush();
  assert.equal(f.sent.length, 1);
  t.mock.timers.tick(MIN);
  await flush();
  assert.equal(f.sent.length, 2);
  stop();
  t.mock.timers.tick(60 * MIN);
  await flush();
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.logs, []);
});

test("skips the ping while tool calls keep the session busy", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  const f = fixture(ok);
  const stop = startKeepAlive(f.client, { intervalMs: 20 * MIN, log: (m) => f.logs.push(m) });
  t.mock.timers.tick(1000);
  await flush();
  t.mock.timers.tick(15 * MIN);
  await f.client.ping();
  const before = f.sent.length;
  t.mock.timers.tick(5 * MIN);
  await flush();
  assert.equal(f.sent.length, before);
  t.mock.timers.tick(15 * MIN);
  await flush();
  assert.equal(f.sent.length, before + 1);
  stop();
});

test("stops pinging a rejected sign-in until a tool call succeeds again", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  let username = "";
  const f = fixture(() => new Response(JSON.stringify({ data: { Username: username } }), { status: 200 }));
  const stop = startKeepAlive(f.client, { intervalMs: 20 * MIN, log: (m) => f.logs.push(m) });
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(f.sent.length, 1);
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0]!, /expired/);
  t.mock.timers.tick(40 * MIN);
  await flush();
  assert.equal(f.sent.length, 1);

  username = "jane";
  await f.client.serverAction("Common/InitializeUserSession/ActionGetUsername", "view", {});
  t.mock.timers.tick(20 * MIN);
  await flush();
  assert.equal(f.sent.length, 3, "one tool call, then the ping it re-enabled");
  assert.match(f.logs.at(-1)!, /reachable again/);
  stop();
});

test("does nothing until a tool has verified the sign-in", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  const f = fixture(ok, false);
  const stop = startKeepAlive(f.client, { intervalMs: 20 * MIN, log: (m) => f.logs.push(m) });
  t.mock.timers.tick(60 * MIN);
  await flush();
  assert.equal(f.sent.length, 0);
  stop();
});

test("retries a failed ping within a minute instead of a full interval", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  let fail = true;
  const f = fixture(() => {
    if (fail) throw new TypeError("fetch failed");
    return ok();
  });
  const stop = startKeepAlive(f.client, { intervalMs: 20 * MIN, log: (m) => f.logs.push(m) });
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(f.sent.length, 1);
  assert.match(f.logs[0]!, /fetch failed/);
  fail = false;
  t.mock.timers.tick(MIN);
  await flush();
  assert.equal(f.sent.length, 2);
  assert.match(f.logs.at(-1)!, /reachable again/);
  stop();
});

test("Chrome keep-alive uses the signed-in tab and never renews in the background", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  let open = false, expired = false;
  let pings = 0, renewals = 0;
  const client = new FbsClient({
    name: "Chrome",
    get isOpen() { return open; },
    openForSignIn: async () => { open = true; },
    renew: async () => { renewals++; expired = false; },
    async fetch(url) {
      if (url.endsWith("/ActionGetUsername")) {
        pings++;
        return expired ? Response.json({ data: { Username: "" } }) : ok();
      }
      if (url.endsWith("/DataActionFetchCredits")) return Response.json({ data: {} });
      assert.match(url, /ActionLoginSSO$/);
      return Response.json({ data: { LoginResponse: { Token: "test-token" } } });
    },
  });
  const elapsed = async (ms: number) => {
    t.mock.timers.tick(ms);
    await flush();
  };
  const checkSignIn = async () => {
    const check = client.withSession(() => client.identity(true));
    for (let i = 0; i < 5; i++) await elapsed(500);
    await check;
  };
  const stop = startKeepAlive(client, { intervalMs: 20 * MIN, log: () => {} });
  await elapsed(1000);
  assert.equal(pings, 0, "must not open Chrome");
  await client.browser!.openForSignIn();
  await elapsed(20 * MIN);
  assert.equal(pings, 0, "must not make requests until a tool verifies sign-in");

  await checkSignIn();
  await elapsed(20 * MIN);
  assert.equal(pings, 2, "pings from the existing Chrome tab");
  expired = true;
  await elapsed(20 * MIN);
  assert.equal(pings, 3);
  await elapsed(20 * MIN);
  assert.equal(pings, 3, "does not keep pinging a rejected session");
  assert.equal(renewals, 0, "does not try to renew an idle session");

  expired = false;
  const read = client.withSession(() =>
    client.dataAction("Common/Profile/DataActionFetchCredits", "view", {}),
  );
  await flush();
  await read;
  await elapsed(20 * MIN);
  assert.equal(pings, 4, "pings resume after a successful read using the cached identity");
  assert.equal(renewals, 0, "a successful read does not need to renew");

  expired = true;
  await elapsed(20 * MIN);
  await checkSignIn();
  assert.equal(renewals, 1, "the next user tool renews");
  const afterSignIn = pings;
  await elapsed(20 * MIN);
  assert.equal(pings, afterSignIn + 1, "pings resume after the user tool renews");
  open = false;
  await elapsed(20 * MIN);
  assert.equal(pings, afterSignIn + 1, "never reopens a closed window to ping");
  stop();
});

test("stops keeping an unused session alive after the idle limit and resumes with the next tool call", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  const f = fixture(ok);
  const stop = startKeepAlive(f.client, { intervalMs: 20 * MIN, maxIdleMs: 60 * MIN, log: (m) => f.logs.push(m) });
  const elapsed = async (ms: number) => {
    t.mock.timers.tick(ms);
    await flush();
  };
  await elapsed(1000);
  for (let i = 0; i < 3; i++) await elapsed(20 * MIN);
  const pings = f.sent.length;
  assert.equal(pings, 3, "pings only until an hour has passed without use");
  await elapsed(120 * MIN);
  assert.equal(f.sent.length, pings);
  assert.equal(f.logs.filter((m) => /no longer being kept alive/.test(m)).length, 1);

  await f.client.ping();
  await elapsed(20 * MIN);
  assert.equal(f.sent.length, pings + 2, "a tool call restarts the keep-alive");
  stop();
});

test("backs off while FBS stays unreachable", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  const f = fixture(() => { throw new TypeError("fetch failed"); });
  const stop = startKeepAlive(f.client, { intervalMs: 20 * MIN, log: (m) => f.logs.push(m) });
  const elapsed = async (ms: number) => {
    t.mock.timers.tick(ms);
    await flush();
  };
  await elapsed(1000);
  const seen: number[] = [];
  for (let minute = 1; minute <= 60; minute++) {
    const before = f.sent.length;
    await elapsed(MIN);
    if (f.sent.length > before) seen.push(minute);
  }
  assert.deepEqual(seen, [1, 3, 7, 15, 31, 51], "retries after 1, 2, 4, 8 and 16 minutes, then every interval");
  stop();
});
