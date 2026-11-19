import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import vm from "node:vm";
import { DedicatedBrowser, resolveBrowser, type BrowserChoice } from "../src/browser.js";
import { ANONYMOUS_CSRF, BASE } from "../src/config.js";
import { SessionError } from "../src/session.js";

const CHROME: BrowserChoice = { id: "chrome", name: "Chrome", channel: "chrome" };

function fixture(t: TestContext, restoredUrl?: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fbs-browser-"));
  const previous = process.env.FBS_MCP_HOME;
  process.env.FBS_MCP_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.FBS_MCP_HOME;
    else process.env.FBS_MCP_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  let url = restoredUrl ?? "about:blank", nextUrl = BASE, cookie = "nr2Users=crf%3Dx%3Buid%3D5", navigations = 0, focuses = 0;
  let settledUrl: string | undefined;
  const requests: RequestInit[] = [];
  let onClose: (() => void) | undefined;
  const context = {
    pages: () => restoredUrl ? [{ url: () => "about:blank" }, page] : [page],
    on: (_event: string, cb: () => void) => { onClose = cb; },
    close: async () => { onClose?.(); },
  };
  const page = {
    context: () => context,
    url: () => url,
    goto: async (target: string, opts: { referer: string }) => {
      assert.equal(target, BASE);
      assert.equal(opts.referer, "https://fbs.intranet.smu.edu.sg/home.aspx");
      navigations++;
      url = nextUrl;
    },
    bringToFront: async () => { focuses++; },
    waitForURL: async (matches: (url: URL) => boolean) => {
      if (settledUrl) url = settledUrl;
      if (!matches(new URL(url))) throw new Error("not signed in");
    },
    once: () => {},
    evaluate: async (fn: unknown, args: unknown) => vm.runInNewContext(`(${fn})(args)`, {
      args, AbortSignal, location: { href: url }, document: { cookie },
      fetch: async (_target: string, init: RequestInit) => {
        requests.push(init);
        return Response.json({ data: {} });
      },
    }),
  };
  const launch = async (profile: string, options: { args?: string[] }) => {
    assert.equal(profile, path.join(home, "chrome"));
    assert.ok(options.args?.includes("--restore-last-session"));
    return context;
  };
  return {
    browser: new DedicatedBrowser(launch as unknown as ConstructorParameters<typeof DedicatedBrowser>[0], () => CHROME),
    requests,
    navigations: () => navigations,
    focuses: () => focuses,
    setNextUrl: (target: string) => { nextUrl = target; },
    settleOn: (target: string) => { settledUrl = target; },
    setCookie: (value: string) => { cookie = value; },
  };
}

test("Chrome sends only same-origin requests with its own cookies and in-page CSRF", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.browser.fetch(BASE + "test", {}), SessionError);
  assert.equal(f.navigations(), 0, "fetching does not open Chrome in the background");
  await f.browser.openForSignIn();
  const response = await f.browser.fetch(BASE + "screenservices/FBSMobile_UI/test", {
    method: "POST",
    headers: { Cookie: "must-not-be-forwarded=1", "X-CSRFToken": "must-not-be-forwarded" },
    body: "{}",
  });
  assert.deepEqual(await response.json(), { data: {} });
  const request = f.requests[0]!;
  assert.equal(request.credentials, "same-origin");
  assert.equal(request.redirect, "manual");
  assert.equal(new Headers(request.headers).get("X-CSRFToken"), "x");
  assert.equal(new Headers(request.headers).has("Cookie"), false);
  await assert.rejects(f.browser.fetch(BASE + "../outside", {}), /only supports the FBS Mobile app/);
  f.setCookie(`nr2Users=crf=${ANONYMOUS_CSRF}`);
  await assert.rejects(f.browser.fetch(BASE + "test", { method: "POST" }), SessionError);
  assert.equal(f.requests.length, 1);
});

test("Chrome reuses the restored FBS tab rather than opening FBS again in a blank tab", async (t) => {
  const f = fixture(t, BASE + "DashBoard");
  await f.browser.openForSignIn();
  assert.equal(f.navigations(), 1);
  assert.equal(f.focuses(), 1);
});

test("Opening sign-in refreshes an existing FBS tab but does not restart SMU sign-in", async (t) => {
  const f = fixture(t);
  await f.browser.openForSignIn();
  assert.equal(f.navigations(), 1);
  f.setNextUrl("https://login.microsoftonline.com/");
  await f.browser.openForSignIn();
  await assert.rejects(f.browser.renew(), SessionError);
  await f.browser.openForSignIn();
  assert.equal(f.navigations(), 2);
  assert.equal(f.focuses(), 3);
  await assert.rejects(f.browser.fetch(BASE + "test", { method: "POST" }), SessionError);
  assert.equal(f.requests.length, 0);
});

test("Renewal waits for the signed-in dashboard after the SSO redirect", async (t) => {
  const f = fixture(t);
  f.setNextUrl("https://login.microsoftonline.com/");
  f.settleOn(BASE + "DashBoard");
  await f.browser.renew();
  await f.browser.fetch(BASE + "test", { method: "POST" });
  assert.equal(f.navigations(), 1);
  assert.equal(f.requests.length, 1);
});

test("An in-flight tool cannot reopen Chrome after MCP shutdown", async (t) => {
  const f = fixture(t);
  await f.browser.openForSignIn();
  await f.browser.close();
  await assert.rejects(f.browser.fetch(BASE + "test", {}), /session is closed/);
  assert.equal(f.navigations(), 1);
});

test("a profile held by another server is reported as such, not as a missing Chrome", async () => {
  const locked = new DedicatedBrowser((async () => {
    throw new Error("Failed to create a ProcessSingleton for your profile directory.");
  }) as never, () => CHROME);
  await assert.rejects(locked.openForSignIn(), /already open in another fbs-mcp server.*FBS_MCP_HOME/);
  const missing = new DedicatedBrowser((async () => {
    throw new Error("Chromium distribution 'chrome' is not found");
  }) as never, () => CHROME);
  await assert.rejects(missing.openForSignIn(), /Check that Chrome, Edge or Brave is installed.*FBS_BROWSER/);
});

const MAC = {
  chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  edge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  brave: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
};
const installed = (...paths: string[]) => (file: string) => paths.includes(file);

test("without FBS_BROWSER the first installed of Chrome, Edge and Brave is used", () => {
  assert.deepEqual(resolveBrowser({}, "darwin", installed(MAC.chrome, MAC.edge, MAC.brave)),
    { id: "chrome", name: "Chrome", executablePath: MAC.chrome });
  assert.deepEqual(resolveBrowser({}, "darwin", installed(MAC.edge, MAC.brave)),
    { id: "edge", name: "Edge", executablePath: MAC.edge });
  assert.deepEqual(resolveBrowser({}, "darwin", installed(MAC.brave)),
    { id: "brave", name: "Brave", executablePath: MAC.brave });
  assert.deepEqual(resolveBrowser({}, "linux", installed("/usr/bin/brave-browser")),
    { id: "brave", name: "Brave", executablePath: "/usr/bin/brave-browser" });
  assert.deepEqual(resolveBrowser({}, "linux", installed()), { id: "chrome", name: "Chrome", channel: "chrome" });
});

test("FBS_BROWSER picks the browser even when another is installed", () => {
  const all = installed(MAC.chrome, MAC.edge, MAC.brave);
  assert.equal(resolveBrowser({ FBS_BROWSER: "brave" }, "darwin", all).executablePath, MAC.brave);
  assert.equal(resolveBrowser({ FBS_BROWSER: " Edge " }, "darwin", all).executablePath, MAC.edge);
  assert.deepEqual(resolveBrowser({ FBS_BROWSER: "edge" }, "darwin", installed()),
    { id: "edge", name: "Edge", channel: "msedge" }, "Playwright looks Edge up when it is not in the usual place");
  assert.throws(() => resolveBrowser({ FBS_BROWSER: "brave" }, "darwin", installed()), /Brave was not found.*FBS_BROWSER_EXECUTABLE/);
  assert.throws(() => resolveBrowser({ FBS_BROWSER: "firefox" }, "darwin", all), /must be chrome, edge or brave/);
});

test("Windows install folders and an explicit path are honoured", () => {
  const env = { PROGRAMFILES: "C:\\Program Files", "PROGRAMFILES(X86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
  const brave = "C:\\Users\\me\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
  const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  assert.deepEqual(resolveBrowser(env, "win32", installed(brave)), { id: "brave", name: "Brave", executablePath: brave });
  assert.deepEqual(resolveBrowser(env, "win32", installed(edge, brave)), { id: "edge", name: "Edge", executablePath: edge });

  assert.deepEqual(resolveBrowser({ FBS_BROWSER_EXECUTABLE: "/opt/brave/brave" }, "linux", installed()),
    { id: "brave", name: "Brave", executablePath: "/opt/brave/brave" });
  assert.deepEqual(resolveBrowser({ FBS_BROWSER: "edge", FBS_BROWSER_EXECUTABLE: "/custom/edge" }, "linux", installed()),
    { id: "edge", name: "Edge", executablePath: "/custom/edge" });
  assert.equal(resolveBrowser({ FBS_CHROME_EXECUTABLE: "/custom/chrome" }, "linux", installed()).executablePath, "/custom/chrome");
});

test("each browser is launched with its own profile folder", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fbs-browser-"));
  const previous = process.env.FBS_MCP_HOME;
  process.env.FBS_MCP_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.FBS_MCP_HOME;
    else process.env.FBS_MCP_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  for (const choice of [
    { id: "edge", name: "Edge", channel: "msedge" },
    { id: "brave", name: "Brave", executablePath: MAC.brave },
  ] as BrowserChoice[]) {
    let seen: { profile: string; options: Record<string, unknown> } | undefined;
    const browser = new DedicatedBrowser((async (profile: string, options: Record<string, unknown>) => {
      seen = { profile, options };
      throw new Error("stop here");
    }) as never, () => choice);
    assert.equal(browser.name, choice.name);
    await assert.rejects(browser.openForSignIn(), new RegExp(`Could not open ${choice.name} for FBS`));
    assert.equal(seen!.profile, path.join(home, choice.id));
    assert.equal(seen!.options["channel"], choice.channel);
    assert.equal(seen!.options["executablePath"], choice.executablePath);
    assert.equal(seen!.options["headless"], false);
  }
});
