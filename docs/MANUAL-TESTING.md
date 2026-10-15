# Manual testing

## Start

```sh
npm ci
npm start            # http://localhost:12000/   (PORT=... to change)
```

The machine running the server must reach `www.instagram.com` and
`static.cdninstagram.com`: the original client's page and code are fetched from
there anonymously. Nothing else about Instagram is used. There is no Instagram
account, cookie or session anywhere in the server.

## Data

- SQLite at `.data/backend.db` (`BACKEND_DB` to move it). Migrations run on every
  start and only apply what is missing; data survives restarts.
- Uploaded media in `.data/media/`, the password-encryption keypair in
  `.data/keys/` (mode 0600). Keep the key: if it changes, open pages must be
  reloaded before login works.
- Reset everything by stopping the server and deleting `.data/`.

## Signup

An account needs only a **username and a password**. No email and no
verification code are required; the account is created and signed in at once.
An email is optional: if one is given it must be valid and not already used,
and it can then be used to log in.

Passwords must be at least 10 characters with a letter and a number. This is
stricter than the form's own check, so a shorter password passes the form and
is then rejected with our message.

Instagram's own signup form may still insist on its "mobile number or email"
field or show a confirmation-code screen; that is the form's behaviour, not a
server requirement. If it shows a code screen, the code is at
**http://localhost:12000/__clone/dev/outbox** (same machine, development only).

## Why the page should no longer hang on the loading screen

The server serves Instagram's anonymous page as-is, keeping the page's own
prefetched (anonymous) data that it renders from, and only swaps in our
encryption key, CSRF token and the viewer. It does NOT strip that data, which
earlier left the client waiting on a query we cannot answer. If a page still
hangs, check `http://localhost:12000/__clone/health` (same machine) for GraphQL
operations or REST paths the client called that are unimplemented: those return
`501` immediately rather than hanging, and are listed there as the work queue.

## What to expect after logging in

Instagram only renders the signed-in app (feed, inbox, settings) for a signed-in
Instagram session. Without a signed-in **template**, a clone user who logs in is
served Instagram's logged-out page again, which looks like login failed. The
session itself works (`/api/v1/accounts/current_user/` answers for that user).

To create the template, once:

1. In your own browser, sign in to instagram.com, open `view-source:https://www.instagram.com/`
   and save it as a file.
2. Run `node scripts/snapshot-shell.js --kind home --file <saved.html> --user-id <your numeric id> --username <your username> --full-name "<your name>"`.
   It replaces your identity with placeholders, removes your prefetched data and
   tokens, and refuses to write if anything identifying remains. The file lands
   in `.cache/shell/home.html` (gitignored). Repeat with `--kind profile`,
   `direct`, `explore`, `accounts_edit` for those pages.
3. Restart is not needed; templates are picked up on the next request.

Your Instagram session is never given to the server: the tool reads a saved file.

## When something fails

- `http://localhost:12000/__clone/health` (from this machine): for each recent page,
  whether our encryption key, CSRF token and viewer were substituted; counts of
  password-decryption failures by reason; GraphQL operations and REST paths the
  client called that are not implemented yet.
- A login error "This page is out of date" means the page encrypted to a key
  that is not ours, i.e. the key substitution missed this page. The server log
  also warns when a page mentions a public key that was not replaced.
- `http://localhost:12000/__loader/health`: upstream fetch failures, templates loaded.

## Settings you may need

| Variable | Default | When |
| --- | --- | --- |
| `PORT` / `HOST` | `12000` / `0.0.0.0` | |
| `BACKEND_SECURE_COOKIES` | off | set `1` when served over HTTPS |
| `CLONE_MAIL_TRANSPORT` | `outbox` (dev), `disabled` (prod) | `log` prints codes to the console |
| `SHELL_TEMPLATE_DIR` | `.cache/shell` | |
| `SHELL_DROP_PREFETCHES` | off | debug only: `1` strips Relay prefetches from every page |
| `AUTH_RATE_LIMIT_MAX` | 20 per minute per IP | raise if testing hits 429 |
