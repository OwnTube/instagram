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

## Signup and the verification code

No email provider exists. In development the code is not emailed and not
logged; open **http://localhost:12000/__clone/dev/outbox** in a browser on the
same machine to read it. The outbox is unavailable in production
(`NODE_ENV=production`), through a reverse proxy, and from other machines.

Passwords must be at least 10 characters with a letter and a number. This is
stricter than the form's own check, so a shorter password passes the form and
is then rejected with our message.

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
| `SIGNUP_REQUIRE_EMAIL_CODE` | on | `0` skips the code check on account creation |
| `CLONE_MAIL_TRANSPORT` | `outbox` (dev), `disabled` (prod) | `log` prints codes to the console |
| `SHELL_TEMPLATE_DIR` | `.cache/shell` | |
| `AUTH_RATE_LIMIT_MAX` | 20 per minute per IP | raise if testing hits 429 |
