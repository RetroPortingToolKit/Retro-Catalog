# Retro Catalog

Official title catalog for [Retro Launcher](https://github.com/RetroPortingToolKit/Retro-Launcher).

JSON manifests listing supported recomp/decomp titles, ROM/BIOS identity, and
GitHub release asset patterns. The launcher downloads this catalog independently
of app updates.

## Layout

```
index.json                    # platform registry, title id lists, platform BIOS defaults
titles/<platform>/<id>.json   # one manifest per title, one folder per platform
titles/psx/                   #   Sony PlayStation (psxrecomp)
titles/snes/                  #   Super Nintendo (snesrecomp)
SCHEMA.md                     # field documentation
submit/                       # GitHub Pages submission form
submit/platform-defaults.json # platform registry shared by the form and the Worker
worker/                       # Cloudflare Worker (OAuth, probe, email, issues)
docs/SUBMIT_SETUP.md
```

Titles are grouped by platform on disk so anything that consumes a catalog
release can list one system at a time: read `index.json` → `platforms.<p>.dir`
+ `platforms.<p>.titles` and resolve `<dir>/<id>.json`. The flat
`index.json` → `titles` list is still published (every id, platform order) for
readers that only want ids.

## Propose a title

Use the [submission form](https://retroportingtoolkit.github.io/Retro-Catalog/submit/)
(GitHub login required). It asks for the platform first (PSX, SNES, …), probes
the source repo for digests/release assets,
lets you complete or override fields, then opens an approval issue and emails
human contributors listed in [`submit/contributors.json`](submit/contributors.json)
(plus repo collaborators). Maintainers add the **`approved`** label to merge the
title and publish a new `catalog.zip`. Setup notes:
[docs/SUBMIT_SETUP.md](docs/SUBMIT_SETUP.md).

If you have a bulk submission request or a submission request that is not maintained on GH and isn't compatible with the tool, please contact us directly, or open an issue on this repo, and we can make arrangements to have it added manually somehow.

Ban abusers via [`submit/banned-users.json`](submit/banned-users.json).

## Releases

Catalog releases use **date/time tags** (`vYYYY.MM.DD.HHMMSS…`). Approving a
submission or tagging `v*` / running **Publish catalog** stamps `catalog_date`
(UTC ISO-8601) + `release_tag` into `index.json`, packs `catalog.zip`, and
publishes a GitHub Release (not a draft). Retro checks that release identity /
stamp on startup and downloads the zip only when the remote catalog is newer:

`https://github.com/RetroPortingToolKit/Retro-Catalog/releases/latest/download/catalog.zip`

## Local check

```sh
python3 .github/scripts/validate_catalog.py
```

Checks `index.json` against `titles/<platform>/<id>.json`: every listed id
exists in its platform folder, its `platform` field matches the folder, ids are
unique, the flat `titles` list matches the per-platform lists, and nothing is
left at the legacy flat `titles/<id>.json` location. CI runs the same script
before every publish.
