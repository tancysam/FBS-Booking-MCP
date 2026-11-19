import type { BrowserSession } from "./browser.js";
import {
  BASE,
  MIN_REQUEST_GAP_MS,
  ORIGIN,
  REQUEST_TIMEOUT_MS,
  SCREEN_PREFIX,
  debug,
} from "./config.js";
import { LOGIN_HINT, Session, SessionError } from "./session.js";
import { ApiVersions } from "./versions.js";

export type Json = Record<string, unknown>;

export class FbsApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FbsApiError";
  }
}

interface CallOptions {
  /** Write calls are never sent twice, even when the endpoint hash turns out stale. */
  write?: boolean;
  inputParameters?: Json;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOGIN_VIEW = "Common.InitializeUserSession";
const LOGIN_SCREEN = "Common/InitializeUserSession/";
const WRITE_NOT_RETRIED = "The booking change was not retried. Check My Bookings or Tasks before trying again.";
const WRITE_UNKNOWN =
  "It is not known whether FBS applied the change, and it was not retried. " +
  "Check fbs_list_my_bookings or fbs_list_tasks before trying again.";

/**
 * Speaks the OutSystems "screenservices" protocol the FBSM web app uses.
 * Every request is sent by the dedicated browser, with the browser's own
 * cookies: this class never sees them.
 */
export class FbsClient {
  readonly versions: ApiVersions;
  private queue: Promise<unknown> = Promise.resolve();
  private operationQueue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private browserUsername?: string;
  /** When FBS last answered a screenservices call, which is what keeps its login alive. */
  lastActivityAt = 0;
  successfulCalls = 0;

  readonly session = new Session();

  constructor(
    readonly browser: BrowserSession,
    /** Smallest gap between two requests. Only tests against a stand-in site shorten it. */
    private readonly minRequestGapMs = MIN_REQUEST_GAP_MS,
  ) {
    this.versions = new ApiVersions((url) => this.getText(url));
  }

  private scheduleOperation<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(fn);
    this.operationQueue = run.catch(() => undefined);
    return run;
  }

  /** Retries a whole read so it rebuilds every request with the new backend token. */
  withSession<T>(fn: () => Promise<T>, write = false): Promise<T> {
    const browser = this.browser;
    return this.scheduleOperation(async () => {
      let started = false;
      try {
        if (write) {
          if (this.browserUsername) await this.getUsername();
          await this.identity();
        }
        started = true;
        return await fn();
      } catch (err) {
        if (!(err instanceof SessionError)) throw err;
        this.session.clearIdentity();
        try {
          await browser.renew();
          await this.identity();
        } catch (renewalError) {
          if (write && started) {
            const message = renewalError instanceof SessionError ? renewalError.message : "Could not renew the FBS session.";
            throw new SessionError(`${message} ${WRITE_NOT_RETRIED}`);
          }
          throw renewalError;
        }
        if (write && started) throw new SessionError(WRITE_NOT_RETRIED);
        return fn();
      }
    });
  }

  /** Runs requests one at a time with a small gap between them. */
  private schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastRequestAt + this.minRequestGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      return fn();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const started = Date.now();
    const label = `${init.method ?? "GET"} ${url.replace(ORIGIN, "")}`;
    try {
      const res = await this.browser.fetch(url, init);
      debug(`${label} -> HTTP ${res.status} in ${Date.now() - started} ms`);
      return res;
    } catch (err) {
      debug(`${label} failed after ${Date.now() - started} ms: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
      throw err;
    } finally {
      // The gap is measured from when the browser was last asked to send something.
      this.lastRequestAt = Date.now();
    }
  }

  private async getText(url: string): Promise<string> {
    return this.schedule(async () => {
      // The web firewall rejects script downloads that ask for JSON.
      const res = await this.send(url, {
        headers: { Accept: "*/*" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      if (!res.ok || /<title>Request Rejected<\/title>/i.test(text)) {
        throw new FbsApiError(`Could not download ${url} (HTTP ${res.status}).`);
      }
      return text;
    });
  }

  private async post(endpoint: string, body: Json): Promise<Json> {
    return this.schedule(async () => {
      // The browser adds its own cookies and the CSRF token from them.
      const res = await this.send(BASE + SCREEN_PREFIX + endpoint, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      this.lastActivityAt = Date.now();
      const redirected = res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
      if (res.status === 401 || res.status === 403 || redirected) {
        const rejected = await res.text().catch(() => "");
        if (/Request Rejected/i.test(rejected)) {
          throw new FbsApiError(
            `FBS request for ${endpoint} was blocked by the SMU web firewall (HTTP ${res.status}).`,
          );
        }
        const what = redirected ? `redirected to sign-in (HTTP ${res.status})` : `rejected (HTTP ${res.status})`;
        throw new SessionError(`FBS session expired or was ${what}. ${LOGIN_HINT}`);
      }
      if (res.status === 404) {
        throw new FbsApiError(`FBS screen changed for ${endpoint} (HTTP 404). Update the server before trying again.`);
      }
      if (res.status !== 200 && res.status !== 503) {
        throw new FbsApiError(`FBS request failed for ${endpoint}: HTTP ${res.status}.`);
      }
      const text = await res.text();
      let json: Json;
      try {
        json = JSON.parse(text) as Json;
      } catch {
        const hint = /Request Rejected/i.test(text) ? " (blocked by the SMU web firewall)" : "";
        if (!hint && /<html[\s>]|<!doctype html/i.test(text.slice(0, 2000))) {
          throw new SessionError(
            `FBS returned a sign-in page instead of data, so the session has expired. ${LOGIN_HINT}`,
          );
        }
        throw new FbsApiError(
          `FBS returned a non-JSON reply for ${endpoint}: HTTP ${res.status}${hint}`,
        );
      }
      const flags = json["versionInfo"] as Record<string, unknown> | undefined;
      if (json["exception"] || flags?.["hasApiVersionChanged"] || flags?.["hasModuleVersionChanged"]) {
        debug(`${endpoint}: ${JSON.stringify({ versionInfo: flags, exception: json["exception"] })}`);
      }
      return json;
    });
  }

  private async call(
    endpoint: string,
    viewName: string,
    payload: Json,
    opts: CallOptions,
    retried = false,
  ): Promise<Json> {
    const body: Json = {
      versionInfo: {
        moduleVersion: this.versions.moduleVersion,
        apiVersion: this.versions.get(endpoint),
      },
      viewName,
      ...payload,
    };
    let json: Json;
    try {
      json = await this.post(endpoint, body);
    } catch (err) {
      // A session error is handled by withSession, which already says the write was not retried.
      if (!opts.write || err instanceof SessionError) throw err;
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      const reason = timedOut
        ? `FBS did not answer ${endpoint} within ${REQUEST_TIMEOUT_MS / 1000} seconds.`
        : err instanceof FbsApiError
          ? err.message
          : `Could not reach FBS for ${endpoint} (${err instanceof Error ? err.message : String(err)}).`;
      throw new FbsApiError(`${reason} ${WRITE_UNKNOWN}`);
    }
    const versionInfo = (json["versionInfo"] ?? {}) as { hasApiVersionChanged?: boolean; hasModuleVersionChanged?: boolean };
    const exception = json["exception"] as
      | { name?: string; specificType?: string; message?: string }
      | undefined;

    // A lone apiVersion flag is accepted only when FBS still answered with data;
    // without data the call was rejected and must not read as an empty success.
    const stale =
      versionInfo.hasApiVersionChanged === true &&
      (versionInfo.hasModuleVersionChanged === true || (json["data"] === undefined && !exception));
    if (stale) {
      if (opts.write) {
        await this.versions.refresh().catch(() => undefined);
        throw new FbsApiError(
          "FBS was updated since this server last synced, so the request was not accepted. " +
            "Nothing was retried automatically. Check My Bookings, then try again.",
        );
      }
      if (!retried) {
        await this.versions.refresh();
        return this.call(endpoint, viewName, payload, opts, true);
      }
      throw new FbsApiError(`FBS keeps rejecting the request format for ${endpoint}.`);
    }

    if (exception) {
      const label = `${exception.name ?? ""} ${exception.specificType ?? ""}`;
      if (/NotRegistered|Security|InvalidLogin|Unauthori/i.test(label)) {
        throw new SessionError(`FBS session expired or was rejected. ${LOGIN_HINT}`);
      }
      throw new FbsApiError(
        `FBS error on ${endpoint}: ${exception.message ?? exception.name ?? "unknown error"}` +
          (opts.write ? ` ${WRITE_UNKNOWN}` : ""),
      );
    }
    this.successfulCalls++;
    return (json["data"] ?? {}) as Json;
  }

  private async getUsername(): Promise<string> {
    const who = await this.serverAction(LOGIN_SCREEN + "ActionGetUsername", LOGIN_VIEW, {});
    const username = String(who["Username"] ?? "");
    if (!username) {
      throw new SessionError(`FBS session expired or is not signed in. ${LOGIN_HINT}`);
    }
    if (this.browserUsername && username !== this.browserUsername) {
      throw new SessionError("The FBS account in Chrome changed. Switch back, or restart fbs-mcp to use the new account.");
    }
    return username;
  }

  serverAction(endpoint: string, viewName: string, inputs: Json, opts: CallOptions = {}): Promise<Json> {
    return this.call(endpoint, viewName, { inputParameters: inputs }, opts);
  }

  /** Data actions take no inputs; the server reads the screen's variables instead. */
  async dataAction(endpoint: string, viewName: string, variables: Json): Promise<Json> {
    const id = await this.identity();
    return this.call(
      endpoint,
      viewName,
      {
        screenData: { variables },
        clientVariables: {
          ClientToken: id.clientToken,
          UserType: id.userType,
          Flow: "New",
          AllowedMenus: id.allowedMenus,
          Username: id.username,
          LastURL: "",
          FBSDateFormat: "dd MMM yyyy",
          FBSTimeFormat: "HH:mm",
          PopupTimeOutSeconds: 5000,
          APIDateFormat: "yyyy-MM-dd",
        },
      },
      {},
    );
  }

  /** Cheapest signed-in call FBS has. Resets its idle timer; throws SessionError once signed out. */
  ping(): Promise<string | undefined> {
    return this.scheduleOperation(async () => {
      if (!this.browser.isOpen || !this.session.data.clientToken) return;
      return this.getUsername();
    });
  }

  /**
   * Returns the FBS backend token for this session, signing in to the backend
   * the same way the site's InitializeUserSession screen does when needed.
   */
  async identity(force = false): Promise<{
    clientToken: string;
    userType: string;
    allowedMenus: string;
    username: string;
  }> {
    if (force) this.session.clearIdentity();
    if (!this.session.data.clientToken) {
      const username = await this.getUsername();
      const login = await this.serverAction(LOGIN_SCREEN + "ActionLoginSSO", LOGIN_VIEW, {
        LoginRequest: { LoginName: username, Password: "" },
      });
      const r = (login["LoginResponse"] ?? {}) as Record<string, unknown>;
      if (r["ErrorMessage"]) throw new FbsApiError(`FBS login failed: ${String(r["ErrorMessage"])}`);
      const token = String(r["Token"] ?? "");
      if (!token) throw new FbsApiError("FBS login returned no token.");
      Object.assign(this.session.data, {
        clientToken: token,
        userType: String(r["UserTypeText"] ?? ""),
        allowedMenus: String(r["AllowedMenus"] ?? ""),
        username,
      });
      this.browserUsername = username;
    }
    const d = this.session.data;
    return {
      clientToken: d.clientToken ?? "",
      userType: d.userType ?? "",
      allowedMenus: d.allowedMenus ?? "",
      username: d.username ?? "",
    };
  }
}
