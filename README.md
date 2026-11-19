# SMU FBS Booking MCP

A Model Context Protocol (MCP) server that lets an AI assistant take the place of a web interface to search, check, and manage SMU facility bookings through using your own signed-in session. Installed locally.

>[!Important]
>This is something that I created when procrastinating for finals, and I have not tested it out that thoroughly yet. So be prepared to encounter bugs or issues.

## Prerequisites

Before you set up the server, make sure you have:

- **Git and Node.js 20.18.1 or newer**
- **SMU intranet access** so your machine can reach `fbsm.intranet.smu.edu.sg` (on campus or over the SMU VPN)
- **Google Chrome, Microsoft Edge, or Brave** installed on the same machine, with a desktop display where it can open a window

## Choose an installation method

| Client | Branch | Install using |
|---|---|---|
| Claude Code | `claude` | [Claude Code marketplace setup](https://github.com/tancysam/SMU-FBS-Booking-MCP/tree/claude#install-in-claude-code) |
| Codex CLI or ChatGPT desktop in a local thread | `codex` | [Codex and ChatGPT desktop marketplace setup](https://github.com/tancysam/SMU-FBS-Booking-MCP/tree/codex#install-in-codex-or-chatgpt-desktop) |
| Claude Desktop or any client that supports local stdio MCP | `main` | [Manual setup](#manual-setup) |

The marketplace setup commands build both plugins from the same server source and install the one for your client. Each installation runs the server on your computer. ChatGPT in a browser and cloud-only threads require a remote MCP endpoint. See [OpenAI's desktop-only plugin documentation](https://developers.openai.com/plugins/deploy/desktop-only).

### Manual setup

1. Clone `main` and install the locked dependencies. This also builds the server.

   ```sh
   git clone --branch main --single-branch https://github.com/tancysam/SMU-FBS-Booking-MCP.git
   cd SMU-FBS-Booking-MCP
   npm ci
   ```

2. In Claude Desktop or another client that uses `mcpServers` configuration, add the following entry. Replace `/ABS/PATH/TO/SMU-FBS-Booking-MCP` with the full path to your checkout. If you already have an `mcpServers` object, add `fbs` to it.

   ```json
   {
     "mcpServers": {
       "fbs": {
         "command": "node",
         "args": ["/ABS/PATH/TO/SMU-FBS-Booking-MCP/dist/index.js"]
       }
     }
   }
   ```

3. Restart your client and [sign in to FBS](#sign-in-to-fbs).

## Sign in to FBS

Sign-in happens only inside a dedicated Chrome, Edge, or Brave browser window managed by the server. The server never asks for, reads, stores, or accepts pasted cookies or tokens; your credentials stay inside the dedicated browser profile at `~/.config/fbs-mcp/`.

1. Ask your assistant to run `fbs_login`.
2. In the browser window that opens, complete any SMU sign-in prompts, including your password and MFA.
3. Ask your assistant to run `fbs_session_status` to confirm that your session is active.

### Session behavior

- **Browser selection:** By default, the server launches the first installed browser it finds in the order Chrome, Edge, Brave. Set `FBS_BROWSER` to choose a specific browser. Switching browsers requires signing in again because each browser uses its own profile directory.
- **Session keep-alive:** FBS signs you out after roughly 30 minutes of inactivity. While running, the server sends a lightweight read-only check every 20 minutes of inactivity to keep your session alive, and stops after 8 hours without tool use. Adjust these intervals with `FBS_KEEPALIVE_MINUTES` and `FBS_KEEPALIVE_MAX_HOURS`.
- **After restarting your client:** Run `fbs_session_status` to reopen the dedicated profile and verify the FBS session. Keep the same `FBS_BROWSER` and `FBS_MCP_HOME` to reuse the profile. If SMU prompts for sign-in again, run `fbs_login` and complete the prompt.
- **One server per profile:** Each MCP client starts its own server process. To run two clients at the same time, give the second client a separate `FBS_MCP_HOME` directory and sign in there.

## How safety works

Every booking change uses a two-step preview-and-confirm workflow so your assistant cannot modify a booking without your approval:

1. **Preview:** Tools that create, edit, cancel, transfer, or respond to bookings (`fbs_book_facility`, `fbs_edit_booking`, `fbs_cancel_booking`, `fbs_transfer_booking`, `fbs_respond_to_task`) are read-only. They return the exact proposed details—room, time, use type, fee, and co-bookers—along with a single-use `confirm_token` that expires after 10 minutes.
2. **Confirm:** `fbs_confirm` is the only tool that writes changes. Before submitting, it re-checks the booking state and refuses the action if anything changed since the preview (for example, if a fee changed or cannot be verified).

Because of this split, you can auto-approve every `fbs_*` tool except `fbs_confirm` in your MCP client and still review every change before it is submitted.

## Tools

The server exposes 15 tools across session management, facility search, bookings, and pending tasks:

| Tool | Purpose | Modifies FBS? |
|---|---|---|
| `fbs_login` | Opens SMU sign-in in the dedicated browser window | No (opens browser) |
| `fbs_session_status` | Checks the active FBS sign-in and shows the signed-in user | No |
| `fbs_list_filters` | Lists buildings, levels, facility types, capacities, and equipment | No |
| `fbs_search_facilities` | Searches for rooms on a date with optional filters and time window | No |
| `fbs_facility_details` | Shows capacity, operating hours, and charges for a room | No |
| `fbs_check_availability` | Shows free and taken 30-minute slots for up to 10 rooms on a date | No |
| `fbs_search_co_bookers` | Finds eligible co-bookers for a slot | No |
| `fbs_list_my_bookings` | Lists your current bookings | No |
| `fbs_list_tasks` | Lists pending co-booker or approval requests with `activity_id` | No |
| `fbs_book_facility` | Previews a new booking and returns a `confirm_token` | No |
| `fbs_cancel_booking` | Previews a cancellation and any applicable fee | No |
| `fbs_edit_booking` | Previews edits to purpose, use type, co-bookers, or same-day times | No |
| `fbs_transfer_booking` | Resolves an eligible staff recipient and previews a transfer | No |
| `fbs_respond_to_task` | Previews confirming or rejecting a pending request | No |
| `fbs_confirm` | Executes a previewed change using its `confirm_token` | **Yes** |

## Configuration

All environment variables are optional:

| Variable | Description | Default |
|---|---|---|
| `FBS_BROWSER` | Browser to use: `chrome`, `edge`, or `brave` | First installed browser found |
| `FBS_BROWSER_EXECUTABLE` | Path to a browser executable in a nonstandard location (`FBS_CHROME_EXECUTABLE` also works) | Auto-detected |
| `FBS_MCP_HOME` | Directory for the dedicated browser profile and version cache | `~/.config/fbs-mcp` |
| `FBS_KEEPALIVE_MINUTES` | Minutes of inactivity before sending a keep-alive ping (`0` disables) | `20` |
| `FBS_KEEPALIVE_MAX_HOURS` | Hours without tool use before stopping keep-alive pings (`0` removes the limit) | `8` |
| `FBS_DEBUG` | Set to `1` to log FBS requests, timings, and browser launch errors to `stderr` with tokens redacted | Off |

## Limitations and behavior

- **Automatic endpoint sync:** When SMU redeploys FBS, endpoint version hashes change. If FBS rejects a hash, the server downloads the updated client scripts, refreshes its cached hashes, and retries read requests once. Write requests are never retried automatically.
- **Rate limiting and search limits:** Requests run sequentially at least 0.4 seconds apart. Search filters are cached for 10 minutes, and `fbs_search_facilities` makes at most 30 requests per call (returning `truncated: true` if you need narrower filters).
- **Booking list size:** `fbs_list_my_bookings` expects FBS to return all bookings in a single response. Behavior with accounts that have a very large number of bookings has not been verified.
- **Legacy session file:** If you upgraded from an older version that left `~/.config/fbs-mcp/session.json` behind, delete that file; the server no longer reads it, and it still contains cookies.

## Development

Run the type checker, test suite (which runs against a local mock FBS server), or build with npm:

```sh
npm run typecheck
npm test
npm run build
```

After installing dependencies with `npm ci`, run `npm run build:plugins` to build both marketplace packages without registering either client. The generated runtimes and machine-specific MCP configs live under `plugin-package/`.
