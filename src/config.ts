import os from "node:os";
import path from "node:path";

export const ORIGIN = "https://fbsm.intranet.smu.edu.sg";
export const BASE = `${ORIGIN}/FBSMobile_UI/`;
export const SCREEN_PREFIX = "screenservices/FBSMobile_UI/";

/** The site sits behind a WAF that expects a phone browser. */
export const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/** CSRF token OutSystems uses when nobody is signed in. Seeing it means the session is gone. */
export const ANONYMOUS_CSRF = "T6C+9iB49TLra4jEsMeSckDMNhQ=";

export const NULL_DATETIME = "1900-01-01T00:00:00";

/** FBS runs on Singapore time, which has no daylight saving. */
export const SGT_OFFSET = "+08:00";

export const REQUEST_TIMEOUT_MS = 30_000;
/** Smallest gap between two requests, so the server never sees a burst. */
export const MIN_REQUEST_GAP_MS = 400;

/** FBS signs you out after about 30 idle minutes, so the server pings it more often than that. */
export const DEFAULT_KEEPALIVE_MINUTES = 20;

/** Minutes between keep-alive pings from FBS_KEEPALIVE_MINUTES; 0 turns them off. */
export function keepAliveMinutes(): number {
  const raw = process.env.FBS_KEEPALIVE_MINUTES?.trim();
  if (!raw) return DEFAULT_KEEPALIVE_MINUTES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_KEEPALIVE_MINUTES;
}

/** FBS_KEEPALIVE_MAX_HOURS: how long pings may hold an unused session open; 0 removes the limit. */
export const DEFAULT_KEEPALIVE_MAX_HOURS = 8;

export function keepAliveMaxHours(): number {
  const raw = process.env.FBS_KEEPALIVE_MAX_HOURS?.trim();
  if (!raw) return DEFAULT_KEEPALIVE_MAX_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_KEEPALIVE_MAX_HOURS;
}

export function homeDir(): string {
  return process.env.FBS_MCP_HOME ?? path.join(os.homedir(), ".config", "fbs-mcp");
}

/** Where versions before browser-only sign-in saved cookies. Never read; only reported if still present. */
export function legacySessionPath(): string {
  return path.join(homeDir(), "session.json");
}

export function versionCachePath(): string {
  return path.join(homeDir(), "api-versions.json");
}

const SECRETS =
  /((?:nr\dUsers|osVisitor|ASP\.NET_SessionId|ClientToken|X-CSRFToken|Cookie|Token|crf)["']?\s*(?:[:=]|%3d)\s*["']?)[^\s"';,&}]+/gi;

/** Masks cookie, CSRF and backend-token values so they never reach a log. */
export function redact(text: string): string {
  return text.replace(SECRETS, "$1[redacted]");
}

/** Writes a diagnostic line to stderr when FBS_DEBUG=1. stdout is the MCP channel and is never used. */
export function debug(message: string): void {
  if (!/^(1|true)$/i.test(process.env.FBS_DEBUG?.trim() ?? "")) return;
  console.error(`[fbs debug] ${redact(message)}`);
}
