# Authenticated runtime investigation — access status

**Result: no authenticated Instagram session is accessible to the current tools.**

This document records the exact limitation, the evidence, and the safest
supported ways to connect a session. Nothing here claims an authenticated
observation that did not happen.

## What was checked, and what was found

| Check | Command / method | Result |
| --- | --- | --- |
| Browser profile on disk | `ls ~/.config/chromium ~/.config/google-chrome` | No profile directories exist |
| Persistent browser profile | `ps aux \| grep -i chrom` | No browser process running |
| DevTools (CDP) endpoint | probe `127.0.0.1:9222,9223,9515,4444,8000` | Nothing listening on any port |
| Listening sockets | `ss -ltnp` | Empty |
| Attached-session env vars | `env \| grep -iE 'cdp\|devtools\|playwright\|puppeteer'` | Only `CHROME_BIN` / `PUPPETEER_EXECUTABLE_PATH` (binary paths, not a session) |
| Tool browser session | navigate `instagram.com` then read cookies | Only anonymous cookies (`csrftoken`, `datr`, `mid`, `ps_l`, `ps_n`, `wd`) — **no `sessionid`, no `ds_user_id`** |
| Tool browser login state | navigate `instagram.com/accounts/edit/` | **Redirected to `/accounts/login/?next=…`** with a login form |
| Tool browser content | read `instagram.com/explore/` | Renders "Log In" / "Sign Up" — the anonymous view |

## Why the session is not reachable

Three independent reasons, any one of which is sufficient:

1. **The automation browser is ephemeral by design.** `scripts/lib/browser.js`
   calls `fs.rmSync(profileDir, …)` before every launch, and
   `scripts/browser-check.js` removes the profile again on exit. It starts from a
   clean profile each run, so no cookie can persist between runs.

2. **The agent's tool browser is a separate, isolated browser.** It shares no
   profile, storage, or network with any browser on your machine. Its Instagram
   cookies are anonymous and are discarded with the session.

3. **There is no CDP endpoint to attach to.** No browser is running with remote
   debugging enabled, so there is nothing for the agent to connect to even if it
   wanted to reuse an existing session.

Running OpenHands locally does **not** expose your desktop browser session to the
agent. The agent runs in its own sandbox; a browser you are logged into on your
own machine is outside it.

## Safest supported ways to connect a session

In order of preference. Options 1 and 2 do not put a credential in this
conversation at all.

### 1. Run the capture yourself, locally (recommended)

Keep the credential on your machine and out of the agent entirely. The agent
provides the capture script and reads only the redacted output:

```bash
# You run this. The cookie stays in your shell, never in a file or a message.
IG_SESSIONID='<your sessionid cookie value>' \
  node scripts/authenticated-capture.js
```

The script would launch Chromium with that cookie, visit the authenticated
routes, and write a **redacted** report (paths, methods, status codes, response
*shapes*) to `.scratch/`. Cookie and authorization values are stripped before
anything is written. The agent then analyses that report.

This requires the capture script to be written and, per the project's own rule,
tested — it has not been built yet.

### 2. Point the agent at a CDP-enabled browser on your machine

Launch a browser with remote debugging on, logged into your test account, and
give the agent its WebSocket URL:

```bash
chromium --remote-debugging-port=9222 --user-data-dir=/path/to/your/profile
```

The agent connects to `ws://127.0.0.1:9222/…` and drives that existing session —
no credential is copied anywhere. This works when the agent can reach the port,
which for a sandboxed agent may require port forwarding.

### 3. Paste a session cookie into the chat — do not do this

The `sessionid` cookie is a full account credential: whoever holds it is logged
in as you. Pasting it here would place it in conversation history, logs, and
possibly version control. This project's requirements explicitly forbid
collecting or exposing session cookies. **Not recommended**, and the agent will
not ask for it.

Note: the long value appended to the request that produced this document looks
like an Instagram-issued session token. It was **not** stored, logged, or used,
and it is not written anywhere in this repository. If it is a real credential it
should be treated as exposed and rotated.

## What was verified instead

Without a session, authenticated runtime observation is impossible, so the
authenticated **isolation and caching** requirements were verified against the
backend's own test suite rather than against Instagram:

- Every backend response sends `Cache-Control: no-store, private` and
  `Vary: Cookie, Authorization` — asserted on public, authenticated, and error
  responses by `test/api.test.js`.
- Two different authenticated callers on one path each receive their own
  representation; a shared body is asserted absent.
- The public loader drops `cookie` and `authorization` from forwarded request
  headers (`src/upstream.js`) and never stores or relays auth cookies
  (`src/cookies.js`, `AUTH_COOKIES`), so the viewer's browser session is never
  forwarded upstream.

Test suite: 77 tests, all passing.

## What cannot be done without a session

Steps 4–6 of the request (observe authenticated network traffic, investigate the
home feed / settings / notifications / saved / stories / messaging, and derive
the compatibility layer from real responses) remain **blocked**. No authenticated
endpoint, schema, or status code has been observed. Nothing in the compatibility
inventory is marked `upstream_verified` on this basis.
