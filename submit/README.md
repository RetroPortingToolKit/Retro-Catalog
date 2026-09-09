# Catalog submission form

Static GitHub Pages app for proposing new `titles/<platform>/<id>.json` entries.

**Live URL (after Pages is enabled):**  
https://retroportingtoolkit.github.io/Retro-Catalog/submit/

## What it does

1. Requires **GitHub login** (OAuth via Cloudflare Worker)
2. Asks for the **platform** first. The picker is built from
   [`platform-defaults.json`](./platform-defaults.json) — one card per entry
   (label, blurb, media, catalog folder, ROM extensions, RomM slugs). The rest
   of the form stays locked until a platform is chosen, and the choice is sent
   with the probe so the Worker never has to guess it from the README
3. Probes a public recomp/decomp repo (`catalog_identity.json`, README, `DISC.md`, `game.toml`, `VERSION`, CMake, latest release assets; SNES ports also `rom_identity.txt`, `tools/regen.sh`, `scripts/package_release.sh`)
4. Auto-fills a catalog manifest — marketing **description**, PSX `track_counts` / `require_cue`, **netplay** lobby fields, and a RetComM **build** recipe when applicable (psxrecomp one-zip, or snesrecomp generate + cmake); submitter can edit every field
5. **Required** client-side ROM hashing under “Rom Checksum Submission” (file never uploaded; submit blocked until digests are generated). Cart platforms (SNES, GBA, …): one file drop, gated to the platform's extensions; SNES strips a 512-byte copier header first. PSX: two labeled slots — `.cue` (fills `track_counts` + expected Track&nbsp;01 name), then that first BINARY `.bin`. `.iso` / `.chd` are rejected
6. On submit:
   - Opens a GitHub issue (label `catalog-submission`) assigned to human contributors
   - Emails addresses from [`contributors.json`](./contributors.json) (Resend)
7. A maintainer adds label **`approved`** → CI writes
   `titles/<platform>/<id>.json`, registers the id under
   `index.json` → `platforms.<platform>.titles`, and publishes a new
   `catalog.zip` release
8. Abusers can be blocked by adding their GitHub login to [`banned-users.json`](./banned-users.json)

To add a platform, add an entry to `platform-defaults.json` (the Worker bundles
the same file, so redeploy it) — the form, the API validator, and the approve
script all read that one registry.

Keep [`contributors.json`](./contributors.json) updated when people join; fill each
`email` for Resend delivery.

## One-time setup

See [../docs/SUBMIT_SETUP.md](../docs/SUBMIT_SETUP.md) for OAuth App, Worker secrets, Resend, and Pages enablement.

After the Worker is deployed, set its URL in [`config.js`](./config.js):

```js
API_BASE: "https://retcomm-catalog-submit.<your-subdomain>.workers.dev",
```
