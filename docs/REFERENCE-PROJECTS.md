# Reference projects: Xitter and Meowcord

Two other projects that serve a company's genuine web client over a separately
written backend were read at the source level for techniques this project
could use. The two projects are not built the same way, and neither works
the way this project does. Every claim below cites the file it was read
from. Revisions read: Xitter `Xittered/xitter@14b2804` and Meowcord
`meowcorded/meowcord@ae7e096`. Both were read in local clones
(`.scratch/refs/`, not committed). No acquisition was run for this study, and
nothing was copied from either project.

## Side by side

| Topic | Xitter (x.com client, Bun) | Meowcord (Discord client, Spacebar fork, Bun) | This project |
| --- | --- | --- | --- |
| Genuine client or recreated UI | Genuine: x.com bundles served from `client/abs` and patched at serve time (`src/patch.ts`) | Genuine: Discord's `/app` index and assets (`scripts/client.js`) | Genuine: one pinned Instagram revision |
| Runtime loading or pinned snapshot | **Fetches upstream on a cache miss at runtime**: `getClientFile(cdnPath, allowFetch = true)` calls `fetch(CDN_ORIGIN + cdnPath)` (`src/client-cache.ts:22-27`). `client/build.json` records the build (`scripts/fetch-client.ts`), but no file hashes | A pinned release: `client/release.json` (`buildNumber`, `versionHash`, `indexSha256`, `assetCount`, `assetsSha256`) is committed and `verify()` rejects anything else as an "Unreviewed client release" (`scripts/client-release.js:25-28`). But `scripts/client.js:95-104` **falls back to the current `discord.com/app`** when the pinned index URL fails, and `discordClientAssets = true` by default (`src/util/config/types/ExternalRequestConfiguration.ts:4`) | Pinned only. A miss is an explicit error. `src/server.js` never loads the upstream client, and the tests refuse every non-local request (`test/pinned-client.test.js`) |
| Separate backend | Its own TypeScript server answering x.com's GraphQL by operation name (`src/graphql.ts`). Unknown endpoints get `{}` and are counted at `/_debug/unknown` (`src/server.ts:287`) | Spacebar's API, gateway and CDN (`src/`) | `src/backend` and `src/clone` answer the client's own contracts. An unknown operation is an explicit 501, not `{}` |
| Routing and compatibility layers | Serve-time JS patches (`src/patch.ts`); GraphQL dispatch keyed on operation name | Client patches under `client/*-patches`; Spacebar routes | Module-scoped bundle patcher; Relay contract completion from the client's own operation ASTs (`src/runtime/graphqlContract.js`) |
| Asset storage | Plain paths under `client/abs`, gitignored (`.gitignore`: "proprietary client bundle, fetched by script") | Cache directory plus `release-manifest.json`; the index comes from a GitHub release asset (`pinnedIndexUrl()`, `scripts/client-release.js:31-35`) | Content-addressed blobs (`blobs/<aa>/<sha256>`), with a manifest of documents, answers and assets per snapshot |
| Updates and rollback | `src/client-update.ts` (`rollbackClient()`, line 86) | A new `release.json` and a new release | `client:acquire`, then `build`, `verify --browser` and `activate`; `client:rollback` |
| Setup and deployment | `bun install` plus a fetch script. No `.env.example`, no `engines`, no port handling | `.env.example`, `Dockerfile`, `docker-compose.yml`. `docker/entrypoint.sh:13,23` runs `client-release.js --check` before starting. `scripts/dev/worktree-setup.sh:20-27,93` refuses a port already in use (lsof) | Before this change: offline `client:setup` from `client/`, which needed `client/blobs/` copied by hand. No `.env.example`, `engines >=18`, raw `EADDRINUSE` stack |
| Testing | `scripts/test-*.ts` end-to-end scripts against a running server, plus CDP drive scripts (`scripts/drive.ts`). No CI | About 263 `node:test` files and Playwright smoke scripts (`scripts/dev/*-smoke.mjs`), with CI in `.github/workflows/ci.yml` and `release-validation.yml` | 364 `node:test` tests with every upstream request refused, plus the genuine-browser checks (`scripts/*-check.js`) |
| License | AGPL-3.0-only (`LICENSE`) | AGPL-3.0-only (`LICENSE`) | Not chosen yet (see README §11). Neither project's license applies here |

## What was applied, and why it fits

1. **A pinned release artifact with a committed checksum.** This is
   Meowcord's idea of a reviewed release plus a GitHub release asset, made
   stricter here.
   - `client/bundle.json` `artifact` pins the artifact's name, size and
     sha256. `npm run client:setup` downloads it when `client/blobs/` is
     absent (`scripts/client-bundle.js` `fetchBlobs`,
     `scripts/lib/client-artifact.js`).
   - Unlike Meowcord there is **no fallback to upstream**. The file has to
     match the pin, every record is checked against the committed manifest,
     and Instagram and Meta hosts are refused by name.
   - The download goes to staging and is installed by a rename. An existing
     valid installation is never replaced.
   - Tests: `test/client-artifact.test.js`.
2. **An integrity gate before serving** (like Meowcord's
   `entrypoint.sh` `--check`). This was already present: setup re-verifies
   the bundle, and the server only serves a snapshot that validates. Setup
   now also prints the hosts it contacted.
3. **Operational checks.** The repos use different mechanisms (Meowcord
   refuses a busy port with lsof); this one is server-side.
   - `src/server.js` reports `EADDRINUSE` and `EACCES` in one line naming
     the port and `PORT`, and exits 1. Other errors are rethrown.
   - `src/nodeVersion.js` refuses a Node without `node:sqlite` before
     anything loads.
   - `engines.node` is `>=22.13.0`.
   - Tests: `test/startup.test.js`.
4. **`.env.example`**, as Meowcord has one. It lists only the variables the
   code actually reads, with their defaults.

## Considered and not applied

- **Xitter's runtime fetch on a miss, and Meowcord's `discord.com` fallback
  and default upstream assets.** These contradict pinned-only serving.
- **Xitter's permissive `{}` for unknown endpoints.** It hides missing
  contracts. This project answers 501, and the browser checks treat that as
  a failure to fix.
- **Docker and CI.** Not requested, and nothing here depends on them. The
  setup is `npm ci` and `npm run client:setup` on Node 22.13+.
- **AGPL.** Neither project's license choice is evidence of what this
  project's owner intends.
