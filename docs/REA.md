# REA in this project

[REA](https://github.com/morluto/rea) (MIT, `rea-agents` on npm) is used as an
analysis CLI. It is installed outside the repository, without global changes:

```sh
mkdir -p ~/rea-cli && cd ~/rea-cli && npm init -y
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install rea-agents@6.5.0
~/rea-cli/node_modules/.bin/rea doctor
```

Prerequisites checked: Node 22.22 (REA needs >= 22.19), procps `ps`.
REA's MCP server is not registered: registration needs an agent restart, which
an ongoing session cannot do; every capability used here has a CLI equivalent.
Dependencies were reviewed (`package.json`): Babel parser, Playwright core,
MCP SDK, schema/serialisation libraries; no install scripts beyond `prebuild-install`.

## Commands used, and what they establish

| Command | Used for | Result here |
| --- | --- | --- |
| `analyze-javascript-application <dir>` | static graph of the stored bundles (397 JS files, 50 MB) | Works (~10 min, 451 MB Evidence). Records every `require("X")` with exact source ranges, but leaves them **unresolved**: REA does not model Meta's Haste registry (`__d("Name", deps, factory)`). |
| `inspect-web-page <cdp> <target>` | passive capture of the genuine page served by the loader (DOM, scripts, resources, console) | Works against the loader's offline page (`scripts/rea-live.js`). |
| `observe-web-execution <cdp> <target>` | precise execution coverage of a boot (used for the boot-stall comparison) | Changes timing/JIT behaviour by design (REA documents this). |
| `inspect-web-network-capture <har>` | offline inspection of saved captures | Available; no HAR of Instagram is used. |

Because REA leaves Haste references unresolved, `src/runtime/moduleIndex.js`
indexes the `__d` definitions in the stored bundles (module -> file, deps),
merged with the documents' `rsrcMap` / `compMap`. It reads only stored bytes.

All analysis inputs are local: the stored public bundles (`.cache/assets`),
the anonymous documents (`.cache/documents`) and stored bootloader answers
(`.cache/bootloader`). Evidence files are written to the session scratch area,
not to the repository.
