import type { BrowserSession } from "../src/browser.js";
import { LOGIN_HINT, SessionError } from "../src/session.js";

/**
 * A stand-in for the dedicated browser: `fetchImpl` plays the FBS site as seen
 * from a signed-in tab. Renewal fails as it does when SMU wants a fresh sign-in.
 */
export function fakeBrowser(fetchImpl: typeof fetch, overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    name: "Chrome",
    isOpen: true,
    fetch: (url, init) => fetchImpl(url, init),
    renew: async () => { throw new SessionError(LOGIN_HINT); },
    openForSignIn: async () => {},
    ...overrides,
  };
}
