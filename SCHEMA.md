# Catalog schema

Retro ships a directory of JSON manifests. `index.json` registers the
platforms and lists title ids per platform; each
`titles/<platform>/<id>.json` describes one supported recomp/decomp.

## Layout

```
index.json
titles/psx/tomba-psx.json
titles/psx/final-fantasy-vii-psx.json
titles/snes/metal-warriors-snes.json
```

One folder per platform, named by the catalog `platform` slug. A manifest's
`platform` field must equal its folder name (CI rejects a mismatch), so a
consumer can trust either. Consumers that want one system at a time read
`platforms.<p>.dir` + `platforms.<p>.titles` from the index and resolve
`<dir>/<id>.json`; consumers that only want ids still get the flat `titles`
list. `schema_version` 1 (everything under `titles/<id>.json`, ids only)
is retired — loaders should treat a missing `platforms` map as schema 1 and
fall back to `titles/<id>.json`.

## `index.json`

```json
{
  "schema_version": 2,
  "name": "Retro supported titles",
  "platform_defaults": {
    "gba": { "bios_identity": { "required": true, "crc32": ["81977335"], "…": "…" } },
    "psx": { "bios_identity": { "required": true, "crc32": ["37157331"], "…": "…" } }
  },
  "platforms": {
    "psx":  { "name": "Sony PlayStation", "dir": "titles/psx",  "titles": ["tomba-psx", "..."] },
    "snes": { "name": "Super Nintendo Entertainment System", "dir": "titles/snes", "titles": ["metal-warriors-snes"] }
  },
  "titles": ["tomba-psx", "...", "metal-warriors-snes"],
  "parked": {
    "reason": "why these are unlisted, and what un-parks them",
    "since": "2026-09-10",
    "titles": {
      "some-title-psx": { "platform": "psx", "manifest": "titles/psx/some-title-psx.json" }
    }
  },
  "catalog_date": "2026-07-29T18:41:00Z",
  "release_tag": "v2026.07.29.184100.12"
}
```

| Field | Type | Notes |
|---|---|---|
| `schema_version` | number | `2` = per-platform folders (this document). `1` = legacy flat `titles/<id>.json` |
| `catalog_date` | string | UTC stamp from publish CI: `YYYY-MM-DDTHH:MM:SSZ` (preferred) or legacy `YYYY-MM-DD` |
| `release_tag` | string | GitHub release tag (e.g. `v2026.07.29.184100.12` = date + `HHMMSS` + issue) |
| `platforms` | object | Platform registry keyed by catalog `platform` slug (`psx`, `snes`, …). Iteration order is the catalog's platform order |
| `platforms.<platform>.name` | string | Display name for the system |
| `platforms.<platform>.dir` | string | Folder holding that platform's manifests, relative to the catalog root; always `titles/<platform>` |
| `platforms.<platform>.titles` | string[] | Ids on that platform; each resolves to `<dir>/<id>.json` |
| `titles` | string[] | Every id, platform lists concatenated in `platforms` order. Kept for id-only readers; must match the per-platform lists exactly |
| `platform_defaults` | object | Optional per-platform defaults keyed by catalog `platform` |
| `platform_defaults.<platform>.bios_identity` | object | Applied to titles on that platform that omit `bios_identity` |
| `parked` | object | Optional. Manifests kept on disk but deliberately left out of the published lists |
| `parked.reason` | string | Required when `parked` is present: why they are unlisted and what un-parks them |
| `parked.since` | string | `YYYY-MM-DD` the parking started |
| `parked.titles.<id>` | object | `platform` + `manifest` (path from the catalog root) for one parked id |

**Parking a title.** Withdrawing a title deletes its manifest; parking one
keeps it. Drop the id from `platforms.<p>.titles` (rebuild `titles[]` to
match) and add it under `parked`. The manifest stays where it is and still
ships inside `catalog.zip`, but no launcher offers it: readers load titles by
id from the published lists and never scan the folder. `validate_catalog.py`
enforces that a parked id names a manifest that exists and appears in no
published list, so a parked title cannot rot unnoticed or come back by
accident. Un-parking is the same diff in reverse.


A platform appears in `platforms` once it has a folder; the approve workflow
adds the entry the first time a title for a new platform is merged. The
submission form's own platform list (label, media, extensions) lives in
[`submit/platform-defaults.json`](submit/platform-defaults.json), which the
submit Worker bundles so form and API agree.

Title manifests may still set `bios_identity` to override the default, or
`"bios_identity": null` to opt out of inheritance.

## `titles/<platform>/<id>.json`

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable slug; matches filename. Convention: `<game>-<platform>` (`tomba-psx`, `metal-warriors-snes`) |
| `name` | string | Display name |
| `kind` | `"recomp"` \| `"decomp"` | |
| `platform` | string | `snes`, `psx`, `n64`, `gba`, … Must equal the folder the manifest lives in (`titles/<platform>/`) and a key of `index.json` → `platforms` |
| `description` | string | Optional short blurb |
| `homepage` | string | Optional URL (hub “GitHub Source”; defaults to `https://github.com/<release.github>`) |
| `author_notes` | string | Optional message from the recomp/decomp author to users; shown in the hub as **Author's Notes** (any length) |
| `notes` | string | Optional catalog/maintainer footnotes (identity sources, pins); not shown in the hub |
| `release.github` owner | — | Hub shows as Recomp/Decomp Author (owner segment of `owner/repo`) |
| `rom_identity` | object | How we know the user owns the game (always include every digest field) |
| `rom_identity.crc32` | string[] | Hex, e.g. `"f2ab92d4"` (empty `[]` if unused) |
| `rom_identity.md5` | string[] | 32-char lowercase hex (common in recomp README tables) |
| `rom_identity.sha1` | string[] | 40-char lowercase hex |
| `rom_identity.sha256` | string[] | 64-char lowercase hex |
| `rom_identity.disc_serials` | string[] | PSX/etc, e.g. `"SLUS-00562"` |
| `rom_identity.sizes` | number[] | Optional byte lengths; when set, scan only hashes files of those sizes (disc dumps) |
| `rom_identity.filenames` | string[] | Suggested basenames for the hub when unmatched (No-Intro / Redump); search hints, not hard matching |
| `rom_identity.track_counts` | number[] | Optional exact cue `TRACK` counts (e.g. MotK Redump = `[17]`). Digests prove the data track; this proves full multi-track TOC. Empty / omit = no TOC gate |
| `rom_identity.require_cue` | bool | When `true`, Retro requires a `.cue` bind (auto-true when any `track_counts` entry is `> 1`). PSX titles use `.cue` + `.bin` — not `.iso`/`.chd`. A self-contained `.car` image (official re-releases, e.g. Steam Tomba!'s `t_data_u.car`) also satisfies the cue requirement for single-track titles: it is the whole disc in one file |
| `rom_identity.discs` | object[] | **Multi-disc sets only** (2+ entries). One entry per disc, each with its own digests. Every disc listed is required to own the title. Omit for single-disc titles |
| `rom_identity.discs[].index` | number | 1-based disc number; unique within the array |
| `rom_identity.discs[].serial` | string | That disc's own serial (each disc of a set differs, e.g. `SCUS-94163` / `-64` / `-65`) |
| `rom_identity.discs[].cue_name` / `.bin_name` | string | Redump basenames for that disc (hints, like `filenames`) |
| `rom_identity.discs[].crc32` / `md5` / `sha1` / `sha256` | string[] | Track 01 digests **for that disc**. At least one must be non-empty |
| `rom_identity.discs[].sizes` | number[] | That disc's Track 01 byte length |
| `rom_identity.discs[].track_counts` | number[] | That disc's cue TRACK count |
| `rom_extensions` | string[] | Scan filter, e.g. `[".sfc",".smc"]` |
| `bios_identity` | object | Optional host BIOS / firmware the title needs |
| `bios_identity.required` | bool | Default `true` when object present |
| `bios_identity.crc32` / `md5` / `sha1` / `sha256` | string[] | Preferred dump checksums (include all keys; unused = `[]`) |
| `bios_identity.sizes` | number[] | Byte lengths to consider while scanning |
| `bios_identity.filenames` | string[] | Basename hints (e.g. `SCPH1001.BIN`) |
| `release` | object | Where to fetch builds |
| `release.github` | string | `owner/repo` |
| `release.allow_prerelease` | bool | Allow GitHub pre-releases when no stable latest exists |
| `release.asset_glob` | object | Per-OS glob: `linux`, `windows`, `macos`. Prefer a pattern from the real asset name (`bpe-*linux*`, `*win64*`, …). The launcher treats Windows/Linux/macOS synonyms as matches and deprioritizes `*tools*` assets for non-tools globs. |
| `build` | object | Optional local generate + cmake recipe. When `enabled`, Retro **Install** prefers this path; omit for third-party zip-only titles. |
| `build.enabled` | bool | Primary install uses generate + toolchain packs |
| `build.source.github` | string | `owner/repo` for the source zipball (default: `release.github`) |
| `build.source.ref` | string | Tag / branch / commit pin for the source archive |
| `build.sdk` | object | Tools identity. Prefer harvesting emitters from the game release zip (`id` only). Optional `github` + `asset_glob.{linux,windows,macos}` remains a legacy fallback for a separate tools pack (e.g. snesrecomp). |
| `build.toolchain` | object | Prefer downloading `cmake-clang-v1` via `github` + `asset_glob` into the shared cache (`id` required; typically `RetroPortingToolKit/RetroPorting-Toolchains`). Set `min_version` to a semver floor against `retcomm-toolchain.json` / release tag (catalog build titles currently require `1.0.3+`). Optional harvest of a legacy game-zip `toolchain/` when download is unavailable. Offline: `RETCOMM_TOOLCHAIN_DIR`. |
| `build.generate` | object | Engine-specific generate args (see below) |
| `build.cmake` | object | `build_dir`, `target`, `config` (Release) |
| `install_dir_name` | string | Folder under `apps/` |
| `launch` | object | Relative binary names: `linux`, `windows`, `macos`. All three keys required; `""` means the title does not ship for that OS — see below |
| `romm` | object | Optional match hints |
| `romm.platforms` | string[] | RomM platform slugs |
| `romm.igdb_ids` | number[] | Optional |
| `saves` | object | Optional paths relative to install for sync later |
| `netplay` | object | Optional; omit when the title has no recomp-net lobby |
| `netplay.supported` | bool | Must be `true` to advertise in the hub lobby |
| `netplay.stack` | string | Currently only `"recomp-net"` |
| `netplay.game_name` | string | Exact WS `create`/`join`/`list` wire name (may differ from catalog `name` / `id`) |
| `netplay.game_version` | string | Lobby pin; align with baked `PSX_GAME_VERSION` / `SNES_GAME_VERSION` (empty → server `"dev"`) |
| `netplay.max_slots` | number | Optional; default `2` |
| `netplay.lobby_url` | string | Optional per-title WS override (else launcher `config.netplay.lobby_url`) |
| `netplay.transports` | string[] | Optional UI hints: `"lan"`, `"ice"`, `"direct"` |
| `netplay.match_caps_schema` | string | Optional host-settings family (`psx-v1`, `snes-v1`) |

A title is considered to have a ROM identity when **any** of `crc32`, `md5`,
`sha1`, `sha256`, or `disc_serials` is non-empty. Matching succeeds if **any**
configured digest matches the scanned file (authors may publish only the
algorithm their gate uses).

### `launch` names

All three of `launch.linux`, `launch.windows` and `launch.macos` must be
present. `""` is a valid value and means the title does not ship for that OS —
a Windows-only setup kit leaves `linux` and `macos` blank in both `launch` and
`release.asset_glob`, and the launcher declines it on those hosts up front.

What `validate_catalog.py` rejects is the mismatched pair: `asset_glob.<os>`
set while `launch.<os>` is blank. That combination makes the launcher accept
the install, generate and compile the entire title, and only then ask staging
to find a file named `""` — discarding a working build and reporting the
install folder as having no launch binary, with the executable sitting in the
build tree running fine by hand.

For a psxrecomp port the name is the `EXE_NAME` passed to
`psxrecomp_add_game_runtime`, or — when the port does not pass one — CMake's
`MAKE_C_IDENTIFIER` of its `WINDOW_TITLE` (each non-alphanumeric character
becomes `_`). In practice the Linux and macOS names are the Windows name
without `.exe`, which holds for every title in this catalog.

### Multi-disc titles

A PS1 set like Final Fantasy VII is three separate dumps, each with its own
serial and Track 01 digests. `rom_identity.discs[]` records them one per entry.

The flat `crc32` / `md5` / `sha1` / `sha256` / `disc_serials` / `sizes` /
`filenames` / `track_counts` lists stay populated as the **union** of every
disc, with disc 1 first. That is deliberate: launchers predating `discs[]`
match on any single digest, so the union keeps them able to bind and launch the
set, and disc-1-first makes their first-match land on the boot disc.

Consequently the flat fields alone cannot express "you need all three" — under
union semantics owning one disc matches. `discs[]` is the authoritative form:

- every entry is **required** — a set is owned only when each disc matches;
- each entry must carry at least one digest (submissions are rejected
  otherwise), so a half-filled set cannot masquerade as complete;
- one entry is not a set — `discs` with fewer than 2 entries is folded back
  into the flat fields on submit.

The submit form auto-detects the set from the repo when it publishes
`disc_set.json` (disc count, per-disc serial / cue name / track count) and
`disc_probe.json` / `disc_probe.<N>.json` (per-disc Track 01 digests). Detected
metadata only pre-fills the form — the submitter still hashes every disc
locally, since repo metadata is not proof of ownership.

Identity should mirror what each game passes into `recomp-ui`
(`known_sha1_hex` / `expected_crc` / MD5 tables / disc verify) so Retro and
the game agree on “verified.”

### `build` (local generate + cmake)

Omit the object for zip-only / third-party distribution. When present with
`enabled: true`, Retro obtains game source (preferring the host **release zip**
when it vendors engine/UI trees — otherwise the GitHub zipball at
`build.source.ref`), harvests tools from that zip when present (or downloads a
legacy `build.sdk` tools pack), fetches a toolchain pack from
[retcomm-toolchains](https://github.com/RetroPortingToolKit/RetroPorting-Toolchains),
runs the SDK CLI `generate` against the user's verified ROM/disc, then
`cmake --build`, and stages the launch binary into `apps/…/current`.

`build.generate.engine`: `"snesrecomp"` | `"psxrecomp"` | `"gbarecomp"`
(default from `platform`: SNES→snesrecomp, PSX→psxrecomp, GBA→gbarecomp).
SNES uses `cfg_dir` / `out_dir` / `funcs_h` / `cfg_roots`. PSX uses `config`
(default `game.toml`) and passes the library disc as `--disc`. GBA uses
`config` (per-binary symbols TOML), `out_dir` (cart `generated/`), and passes
the library ROM as `--rom` plus optional `--bios`.

```json
"build": {
  "enabled": true,
  "source": {
    "github": "TechnicallyComputers/MetalWarriorsSNESRecomp",
    "ref": "v0.1.0"
  },
  "sdk": {
    "id": "snesrecomp-tools",
    "github": "TechnicallyComputers/MetalWarriorsSNESRecomp",
    "asset_glob": {
      "linux": "*snesrecomp-tools*linux*",
      "windows": "*snesrecomp-tools*windows*",
      "macos": "*snesrecomp-tools*macos*"
    }
  },
  "toolchain": {
    "id": "cmake-clang-v1",
    "github": "RetroPortingToolKit/RetroPorting-Toolchains",
    "min_version": "1.0.3",
    "asset_glob": {
      "linux": "*cmake-clang-v1*linux*",
      "windows": "*cmake-clang-v1*windows*",
      "macos": "*cmake-clang-v1*macos*"
    }
  },
  "generate": {
    "engine": "snesrecomp",
    "cfg_dir": "recomp",
    "out_dir": "src/gen",
    "funcs_h": "recomp/funcs.h",
    "cfg_roots": true
  },
  "cmake": {
    "build_dir": "build",
    "target": "MetalWarriorsSNESRecomp",
    "config": "Release"
  }
}
```

Never put ROM bytes or generated `src/gen` / `generated/` into catalog or pack
artifacts. Keep `rom_identity` digests aligned with the game's generate gate.

### `netplay` (recomp-net)

Omit the object entirely when unsupported. When present with
`supported: true`, Retro may list the title in the multi-game lobby browser.
Rooms are still keyed by `game_name` + `game_version` on the lobby server —
peers must match exactly.

```json
"netplay": {
  "supported": true,
  "stack": "recomp-net",
  "game_name": "Star Wars: Masters of Teras Kasi",
  "game_version": "0.1.0",
  "max_slots": 2,
  "transports": ["lan", "ice"],
  "match_caps_schema": "psx-v1"
}
```

Do **not** put ICE/TURN secrets or full default `match_caps` in the catalog;
hosts choose match caps at create time. Keep `game_version` in sync with the
release pin baked into shipping binaries.

### Submission-ready `rom_identity` template

Always ship the full field set so future author self-submission can fill any
subset without schema churn:

```json
"rom_identity": {
  "crc32": [],
  "md5": [],
  "sha1": [],
  "sha256": [],
  "disc_serials": [],
  "sizes": [],
  "filenames": ["Game Name (USA).z64"],
  "track_counts": [],
  "require_cue": false
}
```

For multi-track PSX titles, set `track_counts` to match `game.toml` `[netplay]
required_tracks` (and usually `require_cue: true`) so Track-01-only dumps
cannot pass the library / Install gate.

## Adding a title

**Preferred:** use the [submission form](https://retroportingtoolkit.github.io/Retro-Catalog/submit/)
(GitHub login). It asks for the platform first, auto-fills digests and release
globs from the source repo, and opens a review issue. A maintainer with write
access adds the **`approved`** label to merge `titles/<platform>/<id>.json`,
register the id in `index.json`, and publish a new `catalog.zip` release (use
**`approved-update`** only to overwrite an existing id).

**Manual:**

1. Create `titles/<platform>/<id>.json` with `"platform": "<platform>"`.
2. Append `"<id>"` to `index.json` → `platforms.<platform>.titles` **and** to
   the flat `titles` list (same position relative to its platform). Add the
   `platforms.<platform>` entry (`name`, `dir: "titles/<platform>"`) if this is
   the first title on that platform.
3. Run `python3 .github/scripts/validate_catalog.py`.
4. Fill `rom_identity` from the game's launcher gate / README baserom table
   (prefer publishing every digest you know; leave unused keys as `[]`).
5. Point `release.github` at the shipping repo once releases exist.
6. For GBA/PSX, BIOS identity is inherited from `platform_defaults` unless
   the title sets its own `bios_identity` (or `null` to opt out).
7. Tag `v*` or run **Publish catalog** so launchers get a new zip.
