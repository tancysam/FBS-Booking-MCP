import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import { ANONYMOUS_CSRF, BASE, REQUEST_TIMEOUT_MS, USER_AGENT, debug, homeDir } from "./config.js";
import { LOGIN_HINT, SessionError } from "./session.js";

export interface BrowserSession {
  /** The browser's everyday name, for messages: "Chrome", "Edge" or "Brave". */
  readonly name: string;
  readonly isOpen: boolean;
  fetch(url: string, init: RequestInit): Promise<Response>;
  renew(): Promise<void>;
  openForSignIn(): Promise<void>;
}

const LEGACY_HOME = "https://fbs.intranet.smu.edu.sg/home.aspx";
const SSO_GRACE_MS = 8_000;
const DASHBOARD = new URL("DashBoard", BASE);

export type BrowserId = "chrome" | "edge" | "brave";

export interface BrowserChoice {
  id: BrowserId;
  name: string;
  /** Path to the browser, when this server located it or was told it. */
  executablePath?: string;
  /** Playwright's own lookup name, used when no path is known. Brave has none. */
  channel?: string;
}

const BROWSERS: Record<BrowserId, { name: string; channel?: string }> = {
  chrome: { name: "Chrome", channel: "chrome" },
  edge: { name: "Edge", channel: "msedge" },
  brave: { name: "Brave" },
};
const SEARCH_ORDER: BrowserId[] = ["chrome", "edge", "brave"];

/** The usual install locations of each browser on this platform. */
function installPaths(id: BrowserId, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "darwin") {
    const app = { chrome: "Google Chrome", edge: "Microsoft Edge", brave: "Brave Browser" }[id];
    return [`/Applications/${app}.app/Contents/MacOS/${app}`];
  }
  if (platform === "win32") {
    const tail = {
      chrome: ["Google", "Chrome", "Application", "chrome.exe"],
      edge: ["Microsoft", "Edge", "Application", "msedge.exe"],
      brave: ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
    }[id];
    return [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env["LOCALAPPDATA"]]
      .filter((root): root is string => Boolean(root))
      .map((root) => path.win32.join(root, ...tail));
  }
  return {
    chrome: ["/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"],
    edge: ["/opt/microsoft/msedge/msedge", "/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"],
    brave: ["/usr/bin/brave-browser", "/usr/bin/brave", "/opt/brave.com/brave/brave-browser", "/snap/bin/brave"],
  }[id];
}

/**
 * Picks the browser to sign in with. FBS_BROWSER names one of chrome, edge or
 * brave; without it the first of those found installed is used. FBS_BROWSER_EXECUTABLE
 * points at a browser in a nonstandard location.
 */
export function resolveBrowser(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = fs.existsSync,
): BrowserChoice {
  const wanted = env["FBS_BROWSER"]?.trim().toLowerCase();
  if (wanted && !(wanted in BROWSERS)) {
    throw new SessionError(`FBS_BROWSER must be chrome, edge or brave, not "${wanted}".`);
  }
  const override = (env["FBS_BROWSER_EXECUTABLE"] ?? env["FBS_CHROME_EXECUTABLE"])?.trim();
  const found = (id: BrowserId) => installPaths(id, platform, env).find(exists);
  const choice = (id: BrowserId, executablePath?: string): BrowserChoice => ({
    id,
    name: BROWSERS[id].name,
    ...(executablePath ? { executablePath } : BROWSERS[id].channel ? { channel: BROWSERS[id].channel } : {}),
  });

  if (wanted) {
    const id = wanted as BrowserId;
    const executablePath = override || found(id);
    if (!executablePath && !BROWSERS[id].channel) {
      throw new SessionError(
        `${BROWSERS[id].name} was not found in its usual location. Set FBS_BROWSER_EXECUTABLE to its path.`,
      );
    }
    return choice(id, executablePath);
  }
  if (override) {
    // The path decides which profile folder is used, so a Brave profile is never opened by Chrome.
    const id: BrowserId = /brave/i.test(override) ? "brave" : /edge/i.test(override) ? "edge" : "chrome";
    return choice(id, override);
  }
  for (const id of SEARCH_ORDER) {
    const executablePath = found(id);
    if (executablePath) return choice(id, executablePath);
  }
  // Nothing in the usual places: let Playwright look for Chrome and report what is missing.
  return choice("chrome");
}

/**
 * Lets Chrome, Edge or Brave send its own cookies, from a profile used only
 * for FBS. This is the only way the server signs in: it takes no cookie input.
 */
export class DedicatedBrowser implements BrowserSession {
  private page?: Promise<Page>;
  private closed = false;
  private choice?: BrowserChoice;

  constructor(
    private readonly launch = chromium.launchPersistentContext.bind(chromium),
    private readonly resolve: () => BrowserChoice = resolveBrowser,
  ) {}

  private get browser(): BrowserChoice {
    return (this.choice ??= this.resolve());
  }

  get name(): string {
    try {
      return this.browser.name;
    } catch {
      return "browser";
    }
  }

  /** Launches the browser, putting the real reason in the debug log when it cannot start. */
  private async launchLogged(...args: Parameters<typeof chromium.launchPersistentContext>) {
    try {
      return await this.launch(...args);
    } catch (err) {
      debug(`${this.name} launch failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  get isOpen(): boolean {
    return this.page !== undefined && !this.closed;
  }

  private async open(): Promise<Page> {
    let context;
    const browser = this.browser;
    try {
      // One profile folder per browser: they do not read each other's profiles reliably.
      const profile = path.join(homeDir(), browser.id);
      fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
      context = await this.launchLogged(profile, {
        ...(browser.executablePath ? { executablePath: browser.executablePath } : { channel: browser.channel! }),
        args: ["--restore-last-session"],
        chromiumSandbox: true,
        headless: false,
        timeout: REQUEST_TIMEOUT_MS,
        userAgent: USER_AGENT,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const locked =
        /ProcessSingleton|SingletonLock|Opening in existing browser session|profile (?:appears to be|is) in use|user data directory is already in use/i
          .test(detail);
      throw new SessionError(
        locked
          ? `The FBS ${browser.name} profile is already open in another fbs-mcp server, usually a second MCP client. ` +
            "Close that client, or give this one its own profile by setting a different FBS_MCP_HOME."
          : `Could not open ${browser.name} for FBS. Check that Chrome, Edge or Brave is installed and can open a ` +
            "window on this machine. Set FBS_BROWSER to choose one, or FBS_BROWSER_EXECUTABLE if it is in a " +
            "nonstandard location.",
      );
    }
    context.on("close", () => { this.page = undefined; });
    try {
      const pages = context.pages();
      const page = pages.find((p) => p.url().startsWith(BASE))
        ?? pages.find((p) => p.url() === "about:blank")
        ?? await context.newPage();
      page.once("close", () => { void context.close().catch(() => undefined); });
      await this.navigate(page);
      return page;
    } catch (err) {
      await context.close().catch(() => undefined);
      throw err;
    }
  }

  private async getPage(): Promise<Page> {
    if (this.closed) throw new Error("The FBS browser session is closed.");
    this.page ??= this.open().catch((err) => {
      this.page = undefined;
      throw err;
    });
    return this.page;
  }

  private async navigate(page: Page): Promise<void> {
    try {
      await page.goto(BASE, { referer: LEGACY_HOME, waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT_MS });
    } catch {
      throw new SessionError(`Could not open FBS in ${this.name}. Check that it can reach the SMU intranet and try again.`);
    }
  }

  async renew(): Promise<void> {
    const alreadyOpened = this.isOpen;
    const page = await this.getPage();
    // Do not interrupt an SMU sign-in already in progress.
    if (alreadyOpened && page.url().startsWith(BASE)) await this.navigate(page);
    try {
      await page.waitForURL(
        (url) => url.origin === DASHBOARD.origin && url.pathname.toLowerCase() === DASHBOARD.pathname.toLowerCase(),
        { waitUntil: "domcontentloaded", timeout: SSO_GRACE_MS },
      );
    } catch {
      throw new SessionError(LOGIN_HINT);
    }
  }

  async openForSignIn(): Promise<void> {
    const alreadyOpened = this.page !== undefined;
    const page = await this.getPage();
    await page.bringToFront();
    if (alreadyOpened && page.url().startsWith(BASE)) await this.navigate(page);
  }

  async close(): Promise<void> {
    this.closed = true;
    const page = await this.page;
    if (page) await page.context().close();
  }

  async fetch(url: string, init: RequestInit): Promise<Response> {
    const target = new URL(url).href;
    if (!target.startsWith(BASE)) throw new Error("The browser transport only supports the FBS Mobile app.");
    if (this.closed) throw new Error("The FBS browser session is closed.");
    const page = await this.page;
    if (!page) throw new SessionError(LOGIN_HINT);
    if (!page.url().startsWith(BASE)) throw new SessionError(LOGIN_HINT);
    const headers = new Headers(init.headers);
    const method = init.method ?? "GET";
    const result = await page.evaluate(async ({ base, target, timeout, anonymousCsrf, method, accept, contentType, body }) => {
      if (!location.href.startsWith(base)) return null;
      const headers: Record<string, string> = { Accept: accept };
      if (method === "POST") {
        const cookie = /(?:^|;\s*)nr2Users=([^;]+)/.exec(document.cookie)?.[1] ?? "";
        let decoded = cookie;
        try {
          decoded = decodeURIComponent(cookie);
        } catch {
          // The platform accepts an unencoded cookie too.
        }
        const csrf = /crf=([^;]+)/.exec(decoded)?.[1];
        if (!csrf || csrf === anonymousCsrf) return null;
        headers["X-CSRFToken"] = csrf;
        if (contentType) headers["Content-Type"] = contentType;
      }
      const response = await fetch(target, {
        method,
        headers,
        body,
        credentials: "same-origin",
        redirect: "manual",
        signal: AbortSignal.timeout(timeout),
      });
      if (response.type === "opaqueredirect") return null;
      return { status: response.status, body: await response.text() };
    }, {
      base: BASE,
      target,
      timeout: REQUEST_TIMEOUT_MS,
      anonymousCsrf: ANONYMOUS_CSRF,
      method,
      accept: headers.get("Accept") ?? "*/*",
      contentType: headers.get("Content-Type"),
      body: typeof init.body === "string" ? init.body : undefined,
    }).catch(() => {
      if (page.isClosed() || page.url().startsWith(BASE)) throw new Error(`FBS request in ${this.name} failed.`);
      throw new SessionError(LOGIN_HINT);
    });
    if (!result) throw new SessionError(LOGIN_HINT);
    const { status, body } = result;
    return new Response([204, 205, 304].includes(status) ? null : body, { status });
  }
}
