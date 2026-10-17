# Packaged pinned client

One verified snapshot of the original Instagram web client, in the snapshot
store's own layout (src/clientSnapshot.js), for `npm run client:setup` to
install into `.cache/client/` without contacting Instagram.

| Path | What it is |
| --- | --- |
| `bundle.json` | snapshot id, revision, sha256 of the manifest, blob count, total bytes, `contentsSha256` (sha256 of the sorted `<sha256> <bytes>` lines of every blob) |
| `snapshots/<id>/manifest.json` | the snapshot's manifest, byte for byte as the store wrote it: documents, bootloader answers and assets with their sha256, routes, patches, validation and browser-check record, acquisition provenance |
| `blobs/<aa>/<sha256>` | the bodies, named by their sha256 |

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
npm run client:bundle-check          # validate this directory
npm run client:setup                 # install it (offline), activate if nothing valid is active
npm run client:setup -- --activate   # install it and serve it even if another valid snapshot is active
npm run client:bundle                # (maintainers) replace it with the active snapshot of .cache/client
```

`client:setup` fails, installing nothing, when `bundle.json` is missing or
unreadable, the manifest does not match it, or any blob is missing or does not
hash to its name; restore the directory (`git checkout -- client`) or re-export
it. It never fetches a replacement.
