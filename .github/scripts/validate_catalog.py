#!/usr/bin/env python3
"""Validate the catalog tree: index.json + titles/<platform>/<id>.json.

Checks (all fatal):
  - index.json parses and has schema_version >= 2 with a `platforms` map
  - every platform key is a lowercase slug and its `dir` is titles/<platform>
  - every id listed under a platform has <dir>/<id>.json whose `id` and
    `platform` fields match the index
  - ids are unique across platforms
  - the flat `titles` list equals the concatenation of the platform lists
    (that list is what older readers still consume)
  - no manifest on disk is missing from the index, and nothing is left at
    the legacy flat location titles/<id>.json
  - `parked` ids (unlisted on purpose) name a manifest that exists on disk and
    do NOT appear in any published list
  - every manifest carries a non-empty `launch` name for linux, windows and
    macos

Run from anywhere: paths resolve relative to the repo root.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INDEX = ROOT / "index.json"
TITLES = ROOT / "titles"

PLATFORM_RE = re.compile(r"^[a-z0-9]+$")
ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise SystemExit(f"{path.relative_to(ROOT)}: invalid JSON: {e}") from e


LAUNCH_OSES = ("linux", "windows", "macos")


def launch_errors(rel: Path, manifest: dict) -> list[str]:
    """`launch.<os>` must name the executable the build actually produces.

    An empty string is not "unsupported here" to any reader: the launcher asks
    for the host's name, gets "", and only finds out when staging looks for a
    file called "" -- after a full generate + compile has already succeeded.
    The build is then discarded and the hub reports the install folder as
    having no launch binary, while the exe sits in the build tree working fine.
    Cheaper to refuse the manifest.
    """
    launch = manifest.get("launch")
    if not isinstance(launch, dict):
        return [f"{rel}: `launch` object is required"]
    out = []
    for os_ in LAUNCH_OSES:
        if os_ not in launch:
            out.append(f"{rel}: launch.{os_} is required")
        elif not isinstance(launch[os_], str) or not launch[os_].strip():
            out.append(
                f"{rel}: launch.{os_} is empty -- name the executable the build "
                f"produces (psxrecomp uses EXE_NAME, else MAKE_C_IDENTIFIER of "
                f"WINDOW_TITLE; every other title's linux name is its windows "
                f"name without '.exe')"
            )
    return out


def main() -> None:
    errors: list[str] = []
    idx = load_json(INDEX)

    if int(idx.get("schema_version") or 0) < 2:
        errors.append("index.json schema_version must be >= 2 (platform layout)")
    platforms = idx.get("platforms")
    if not isinstance(platforms, dict) or not platforms:
        raise SystemExit("index.json: `platforms` map is required (schema_version 2)")

    seen: dict[str, str] = {}  # id -> platform
    ordered: list[str] = []
    on_disk: set[Path] = {
        p.relative_to(ROOT) for p in TITLES.rglob("*.json") if p.is_file()
    }
    listed: set[Path] = set()

    for plat, entry in platforms.items():
        if not PLATFORM_RE.match(plat):
            errors.append(f"platform key {plat!r} must be a lowercase slug")
            continue
        if not isinstance(entry, dict):
            errors.append(f"platforms.{plat} must be an object")
            continue
        want_dir = f"titles/{plat}"
        if entry.get("dir") != want_dir:
            errors.append(f"platforms.{plat}.dir must be {want_dir!r} (got {entry.get('dir')!r})")
        ids = entry.get("titles")
        if not isinstance(ids, list):
            errors.append(f"platforms.{plat}.titles must be a list")
            continue
        for tid in ids:
            if not isinstance(tid, str) or not ID_RE.match(tid):
                errors.append(f"platforms.{plat}: bad title id {tid!r}")
                continue
            if tid in seen:
                errors.append(f"title id {tid!r} listed under both {seen[tid]} and {plat}")
                continue
            seen[tid] = plat
            ordered.append(tid)
            rel = Path(want_dir) / f"{tid}.json"
            listed.add(rel)
            path = ROOT / rel
            if not path.is_file():
                errors.append(f"{rel}: listed in index.json but missing on disk")
                continue
            m = load_json(path)
            if not isinstance(m, dict):
                errors.append(f"{rel}: manifest must be a JSON object")
                continue
            if m.get("id") != tid:
                errors.append(f"{rel}: manifest id {m.get('id')!r} != filename id {tid!r}")
            if m.get("platform") != plat:
                errors.append(
                    f"{rel}: manifest platform {m.get('platform')!r} != folder platform {plat!r}"
                )
            errors.extend(launch_errors(rel, m))

    # Parked: a manifest kept on disk (and in catalog.zip) but deliberately
    # left out of the published lists, so no launcher offers it. Withdrawing a
    # title deletes it; parking one keeps the record and the diff to undo.
    parked_rel: set[Path] = set()
    parked = idx.get("parked") or {}
    if parked:
        if not isinstance(parked, dict):
            errors.append("index.json `parked` must be an object")
        else:
            if not str(parked.get("reason") or "").strip():
                errors.append("index.json parked.reason is required (say why)")
            entries = parked.get("titles")
            if not isinstance(entries, dict):
                errors.append("index.json parked.titles must be an object of id -> entry")
                entries = {}
            for tid, entry in entries.items():
                if not isinstance(tid, str) or not ID_RE.match(tid):
                    errors.append(f"parked: bad title id {tid!r}")
                    continue
                if tid in seen:
                    errors.append(f"parked title {tid!r} is still listed under {seen[tid]}")
                    continue
                if not isinstance(entry, dict):
                    errors.append(f"parked.titles.{tid} must be an object")
                    continue
                rel = Path(str(entry.get("manifest") or ""))
                if not str(rel) or not (ROOT / rel).is_file():
                    errors.append(f"parked.titles.{tid}: manifest {str(rel)!r} not on disk")
                    continue
                parked_rel.add(rel)
                # Held to the same manifest rules as a listed title, so a park
                # is a pause and not a place for a broken manifest to hide
                # until someone un-parks it.
                errors.extend(launch_errors(rel, load_json(ROOT / rel)))

    flat = idx.get("titles")
    if not isinstance(flat, list):
        errors.append("index.json `titles` must be a list")
    elif list(flat) != ordered:
        errors.append(
            "index.json `titles` must equal the platform lists concatenated in "
            f"platform order (expected {len(ordered)} ids: {ordered[:3]}…)"
        )

    for rel in sorted(on_disk - listed - parked_rel):
        if rel.parent == Path("titles"):
            errors.append(f"{rel}: legacy flat location — move to titles/<platform>/")
        else:
            errors.append(f"{rel}: on disk but not listed in index.json")

    if errors:
        raise SystemExit("Catalog validation failed:\n- " + "\n- ".join(errors))

    per = ", ".join(f"{p}={len(e.get('titles') or [])}" for p, e in platforms.items())
    note = f"; {len(parked_rel)} parked" if parked_rel else ""
    print(
        f"{len(ordered)} titles ok ({per}){note}; catalog_date={idx.get('catalog_date')} "
        f"release_tag={idx.get('release_tag')}"
    )


if __name__ == "__main__":
    main()
