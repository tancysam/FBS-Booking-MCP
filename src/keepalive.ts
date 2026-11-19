import type { FbsClient } from "./client.js";
import { SessionError } from "./session.js";

const RETRY_MS = 60_000;

export interface KeepAliveOptions {
  intervalMs: number;
  /** Stop pinging once no tool has used FBS for this long; 0 or undefined keeps pinging. */
  maxIdleMs?: number;
  log?: (message: string) => void;
}

/**
 * Pings FBS whenever the server has been idle for `intervalMs`, so the login
 * outlives FBS's idle timeout while the server runs. A rejected session
 * is left alone until a user tool reestablishes it.
 * Pings stop after `maxIdleMs` without real use, so a forgotten server does
 * not hold a login open for ever, and resume with the next tool call.
 */
export function startKeepAlive(client: FbsClient, opts: KeepAliveOptions): () => void {
  const log = opts.log ?? ((m: string) => console.error(`[fbs keep-alive] ${m}`));
  const session = client.session;
  let expired: number | undefined;
  let lastError: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let failures = 0;
  let usedAt = Date.now();
  let ownActivityAt = client.lastActivityAt;
  let lapsed = false;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(tick, Math.max(delayMs, 1000));
    timer.unref();
  };

  const tick = async () => {
    const idleFor = Date.now() - client.lastActivityAt;
    if (client.lastActivityAt !== ownActivityAt) {
      // Something other than a ping reached FBS, so the session is in use.
      usedAt = ownActivityAt = client.lastActivityAt;
      lapsed = false;
    }
    if (idleFor < opts.intervalMs) return schedule(opts.intervalMs - idleFor);
    if (opts.maxIdleMs && Date.now() - usedAt >= opts.maxIdleMs) {
      if (!lapsed) log("No FBS tool has been used for a while, so the session is no longer being kept alive.");
      lapsed = true;
      return schedule(opts.intervalMs);
    }
    // Only an open window with a verified sign-in is pinged; the window is never opened to ping.
    const ready = client.browser.isOpen && Boolean(session.data.clientToken);
    const sessionKey = client.successfulCalls;
    let next = opts.intervalMs;
    if (ready && sessionKey !== expired) {
      try {
        if (await client.ping()) {
          if (lastError) log("FBS session is reachable again.");
          lastError = undefined;
        }
        failures = 0;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof SessionError) {
          expired = client.successfulCalls;
        }
        // A network blip must not push the next ping past FBS's idle timeout,
        // but a site that stays down is not polled every minute for ever.
        else next = Math.min(opts.intervalMs, RETRY_MS * 2 ** Math.min(failures++, 10));
        if (message !== lastError) log(`Ping failed: ${message}`);
        lastError = message;
      }
    }
    ownActivityAt = client.lastActivityAt;
    schedule(next);
  };

  // The saved session may already have been idle for a while, so check it right away.
  schedule(0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
