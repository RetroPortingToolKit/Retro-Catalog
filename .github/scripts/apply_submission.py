#!/usr/bin/env python3
"""Apply an approved catalog-submission issue body to titles/<platform>/ + index.json.

Prints one machine-readable line last: `<added|updated>:<id>:<relative path>`.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TITLES = ROOT / "titles"
INDEX = ROOT / "index.json"

ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
PLATFORM_RE = re.compile(r"^[a-z0-9]+$")
JSON_FENCE_RE = re.compile(
    r"```json\s*\n(.*?)```",
    re.DOTALL | re.IGNORECASE,
)

# Display names for the index `platforms` registry. A platform missing here
# still works — it is registered with its slug as the name.
PLATFORM_NAMES = {
    "psx": "Sony PlayStation",
    "snes": "Super Nintendo Entertainment System",
    "gba": "Game Boy Advance",
    "n64": "Nintendo 64",
    "genesis": "Sega Genesis / Mega Drive",
}


def extract_manifest(body: str) -> dict:
    matches = list(JSON_FENCE_RE.finditer(body or ""))
    if not matches:
        raise SystemExit("No ```json ... ``` block found in issue body")
    # Prefer the last json fence (proposed manifest); ignore accidental earlier ones.
    raw = matches[-1].group(1).strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise SystemExit(f"Invalid JSON in issue body: {e}") from e
    if not isinstance(data, dict):
        raise SystemExit("Manifest JSON must be an object")
    return data


def validate(manifest: dict) -> None:
    errors: list[str] = []
    tid = str(manifest.get("id") or "").strip()
    if not tid or not ID_RE.match(tid):
        errors.append("id must be a lowercase slug (e.g. megaman-x-snes)")
    if not str(manifest.get("name") or "").strip():
        errors.append("name is required")
    kind = manifest.get("kind")
    if kind not in ("recomp", "decomp"):
        errors.append('kind must be "recomp" or "decomp"')
    platform = str(manifest.get("platform") or "").strip()
    if not platform:
        errors.append("platform is required")
    elif not PLATFORM_RE.match(platform):
        errors.append(
            f"platform {platform!r} must be a lowercase slug (it names titles/<platform>/)"
        )

    release = manifest.get("release") or {}
    if not isinstance(release, dict) or not str(release.get("github") or "").strip():
        errors.append("release.github is required")
    glob = (release.get("asset_glob") or {}) if isinstance(release, dict) else {}
    if not isinstance(glob, dict) or not any(
        str(glob.get(k) or "").strip() for k in ("linux", "windows", "macos")
    ):
        errors.append("release.asset_glob needs at least one OS pattern")

    if not str(manifest.get("install_dir_name") or "").strip():
        errors.append("install_dir_name is required")

    launch = manifest.get("launch") or {}
    if not isinstance(launch, dict) or not any(
        str(launch.get(k) or "").strip() for k in ("linux", "windows", "macos")
    ):
        errors.append("launch needs at least one OS binary name")

    ri = manifest.get("rom_identity") or {}
    if not isinstance(ri, dict):
        errors.append("rom_identity must be an object")
    else:
        has = any(
            isinstance(ri.get(k), list) and len(ri.get(k)) > 0
            for k in ("crc32", "md5", "sha1", "sha256", "disc_serials")
        )
        if not has:
            errors.append(
                "rom_identity needs at least one digest or disc_serial"
            )
        tc = ri.get("track_counts")
        if tc is not None:
            if not isinstance(tc, list) or not all(
                isinstance(n, int) and not isinstance(n, bool) and n >= 1
                for n in tc
            ):
                errors.append(
                    "rom_identity.track_counts must be a list of integers >= 1"
                )

    netplay = manifest.get("netplay")
    if isinstance(netplay, dict) and netplay.get("supported"):
        stack = str(netplay.get("stack") or "").strip()
        if stack and stack != "recomp-net":
            errors.append('netplay.stack must be "recomp-net" when supported')
        if not str(netplay.get("game_name") or "").strip():
            errors.append("netplay.game_name is required when netplay is supported")
        if netplay.get("game_version") is None or str(netplay.get("game_version")).strip() == "":
            errors.append(
                "netplay.game_version is required when netplay is supported"
            )

    if errors:
        raise SystemExit("Validation failed:\n- " + "\n- ".join(errors))


def existing_locations(tid: str) -> list[Path]:
    """Every place a manifest with this id already lives (any platform, or legacy flat)."""
    found: list[Path] = []
    legacy = TITLES / f"{tid}.json"
    if legacy.is_file():
        found.append(legacy)
    for p in sorted(TITLES.glob(f"*/{tid}.json")):
        if p.is_file():
            found.append(p)
    return found


def register_in_index(tid: str, platform: str, *, moved_from: str | None) -> None:
    idx = json.loads(INDEX.read_text(encoding="utf-8"))
    if int(idx.get("schema_version") or 0) < 2:
        idx["schema_version"] = 2
    platforms = idx.get("platforms")
    if not isinstance(platforms, dict):
        platforms = {}

    # A title changing platform on approved-update leaves its old list.
    for plat, entry in platforms.items():
        if plat == platform or not isinstance(entry, dict):
            continue
        ids = entry.get("titles") or []
        if tid in ids:
            entry["titles"] = [i for i in ids if i != tid]

    entry = platforms.get(platform)
    if not isinstance(entry, dict):
        entry = {
            "name": PLATFORM_NAMES.get(platform, platform),
            "dir": f"titles/{platform}",
            "titles": [],
        }
        platforms[platform] = entry
    entry.setdefault("name", PLATFORM_NAMES.get(platform, platform))
    entry["dir"] = f"titles/{platform}"
    ids = list(entry.get("titles") or [])
    if tid not in ids:
        ids.append(tid)
    entry["titles"] = ids

    # Flat list stays the concatenation of the platform lists — that is the
    # contract validate_catalog.py enforces and older readers consume.
    flat: list[str] = []
    for plat_entry in platforms.values():
        for i in plat_entry.get("titles") or []:
            if i not in flat:
                flat.append(i)

    # Rebuild with a stable key order so diffs stay readable.
    out = {
        "schema_version": idx["schema_version"],
        "name": idx.get("name", "Retro supported titles"),
    }
    if "platform_defaults" in idx:
        out["platform_defaults"] = idx["platform_defaults"]
    out["platforms"] = platforms
    out["titles"] = flat
    for k, v in idx.items():
        if k not in out:
            out[k] = v
    INDEX.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def apply_manifest(manifest: dict, *, allow_update: bool) -> str:
    validate(manifest)
    tid = str(manifest["id"]).strip()
    platform = str(manifest["platform"]).strip()
    # Keep id/platform in sync with object
    manifest["id"] = tid
    manifest["platform"] = platform

    path = TITLES / platform / f"{tid}.json"
    others = existing_locations(tid)
    existed = bool(others)
    if existed and not allow_update:
        where = ", ".join(str(p.relative_to(ROOT)) for p in others)
        raise SystemExit(
            f"{where} already exists; remove `approved` and use "
            "`approved-update` only if intentionally replacing the entry"
        )

    moved_from = None
    for old in others:
        if old != path:
            moved_from = str(old.relative_to(ROOT))
            old.unlink()
            print(f"Removed {moved_from} (id now lives under titles/{platform}/)", file=sys.stderr)

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    register_in_index(tid, platform, moved_from=moved_from)

    if not path.is_file():
        raise SystemExit(f"failed to write {path}")
    rel = path.relative_to(ROOT).as_posix()
    return f"{'updated' if existed else 'added'}:{tid}:{rel}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--body-file", required=True, help="Path to issue body markdown")
    ap.add_argument(
        "--allow-update",
        action="store_true",
        help="Overwrite an existing titles/<platform>/<id>.json",
    )
    args = ap.parse_args()
    body = Path(args.body_file).read_text(encoding="utf-8")
    manifest = extract_manifest(body)
    result = apply_manifest(manifest, allow_update=args.allow_update)
    print(f"Wrote {result.split(':', 2)[2]}", file=sys.stderr)
    print(result)


if __name__ == "__main__":
    main()
