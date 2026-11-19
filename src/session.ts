/** What the FBS backend told this server about the signed-in user. Held in memory only. */
export interface SessionData {
  clientToken?: string;
  userType?: string;
  allowedMenus?: string;
  username?: string;
}

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export const LOGIN_HINT =
  "Sign in to FBS in the dedicated browser window, then try again. Use fbs_login to open the window.";

/**
 * The backend identity for the browser's current sign-in. The sign-in itself
 * (cookies, SSO) lives only in the browser profile: this server never reads,
 * accepts or stores a cookie.
 */
export class Session {
  data: SessionData = {};

  clearIdentity(): void {
    this.data = {};
  }
}
