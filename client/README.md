# Packaged pinned client

One verified snapshot of the original Instagram web client, in the snapshot
store's own layout (src/clientSnapshot.js), for `npm run client:setup` to
install into `.cache/client/` without contacting Instagram.

| Path | What it is |
| --- | --- |
| `bundle.json` | snapshot id, revision, sha256 of the manifest, blob count, total bytes, `contentsSha256` (sha256 of the sorted `<sha256> <bytes>` lines of every blob) |
| `snapshots/<id>/manifest.json` | the snapshot's manifest, byte for byte as the store wrote it: documents, bootloader answers and assets with their sha256, routes, patches, validation and browser-check record, acquisition provenance |
| `blobs/<aa>/<sha256>` | the bodies, named by their sha256 (not committed; see below) |
| `bundle.json` `artifact` | the packed artifact holding the manifest and every blob: `name`, `bytes`, `sha256`, `urls` |
| `dist/<name>` | the packed artifact, written by `npm run client:pack` (not committed) |

What is in it: only the anonymous public documents, bootloader answers and
static assets of that one revision, as acquired by `npm run client:acquire`.
What is not: no other snapshot, no legacy `.cache/assets`/`.cache/documents`
stores, no database, no account, cookie or session data. The documents still
hold the per-visit values Instagram put in an anonymous page (an anonymous
CSRF and LSD token, which the server replaces on every response, and an
anonymous `machine_id`/`device_id`); they are left as acquired so every
sha256 stays the store's own.

Commands:

```bash
npm run client:bundle-check          # validate this directory (needs blobs/)
npm run client:setup                 # get blobs/ if absent, then install, activate if nothing valid is active
npm run client:setup -- --activate   # install it and serve it even if another valid snapshot is active
npm run client:fetch                 # only get blobs/ from the pinned artifact
npm run client:fetch -- --artifact ./client-<id>.igrl.gz   # ... from a local copy of it
npm run client:fetch -- --replace    # replace an invalid blobs/ (moved aside to blobs.invalid-<time>/)
npm run client:bundle                # (maintainers) replace it with the active snapshot of .cache/client
npm run client:pack                  # (maintainers) write dist/<name> and pin it in bundle.json
```

`client:setup` fails, installing nothing, when `bundle.json` is missing or
unreadable, the manifest does not match it, or any blob is missing or does not
hash to its name. It never fetches anything from Instagram.

## Getting the bodies: the pinned artifact

`bundle.json` and the manifest are committed; `blobs/` (Instagram's
proprietary client files) is not. The bodies travel as one file, the
**client artifact** `client-<snapshot>.igrl.gz`, whose `name`, `bytes` and
`sha256` are pinned in `bundle.json` `artifact`, next to the snapshot id,
revision, manifest sha256 and `contentsSha256` it must reproduce.

Format: gzip (level 9, no timestamp) of one JSON header line
`{"format":"igrl-client-artifact","version":1,"snapshot",...}` followed by
records `"<manifest|blob> <sha256> <bytes>\n"` + exactly `<bytes>` bytes:
the manifest first, then every blob sorted by sha256. Packing is
deterministic: the same bundle always packs to the same sha256.

When `blobs/` is absent, `client:setup` (or `client:fetch`):

1. takes the source from `--artifact <url|file>`, else `CLIENT_ARTIFACT`,
   else `artifact.urls` in order (refusing Instagram/Meta hosts by name,
   including after a redirect);
2. streams it into `client/.staging-*/`, hashing as it goes; more bytes than
   pinned, fewer, or another sha256 is rejected;
3. unpacks it in staging, requiring the header to name this bundle, the
   manifest record to equal the committed manifest byte for byte, every blob
   to hash to its name with the manifest's size, no unreferenced or repeated
   blob, and no missing one;
4. renames the staged `blobs/` to `client/blobs/` (same filesystem, so the
   switch is atomic), re-validates the bundle, removes staging, and prints the
   hosts it contacted.

A valid `client/blobs/` is never replaced. An invalid one is left as it is
unless `--replace` is given; even then it is moved aside only after the new
artifact has fully verified.

### Publishing (required before a fresh clone can install unaided)

**Not done.** The artifact for the bundled revision is pinned:

| | |
| --- | --- |
| snapshot / revision | `rev1050722040-20261017T170808Z` / `1050722040` |
| file | `client-rev1050722040-20261017T170808Z.igrl.gz` |
| bytes | 58747347 |
| sha256 | `27ad50d0d5939791ba01f4142ada168656a5c0be7b7d747f743d9f9ec6ede9cf` |
| URL in `artifact.urls` | `https://github.com/vibecodeforever/instagram/releases/download/client-rev1050722040-20261017T170808Z/client-rev1050722040-20261017T170808Z.igrl.gz` |

but nothing is published at that URL, so `client:setup` on a fresh clone
stops with "download failed: HTTP 404 … is the artifact published at …?".
The file contains Instagram's proprietary client; whether, where and to whom
it may be distributed is the repository owner's decision, not something this
project's tooling assumes. To publish it once that is decided:

1. On a machine holding the snapshot: `npm run client:pack` (writes
   `client/dist/<name>`; check that the printed sha256 equals the one above).
2. Create a release whose tag is `client-<snapshot>` and attach the file
   under exactly its name (or host it anywhere else reachable over https,
   e.g. a private release or an internal file server, and put that URL in
   `artifact.urls`, or give it per machine with `CLIENT_ARTIFACT`).
3. From a fresh clone: `npm ci && npm run client:setup`.

The URL is only a location: whatever it serves is accepted only if it is
byte for byte the pinned file. Keep the release asset immutable; a new
client is a new snapshot, a new artifact name and a new pin.

Without a published artifact, copy the file (or an exported `blobs/`
directory) from a machine that has the snapshot and run
`npm run client:setup -- --artifact /path/to/file` (or put the directory at
`client/blobs/`); both are verified exactly as a download is.
