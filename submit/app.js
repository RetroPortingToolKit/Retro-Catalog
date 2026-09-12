import { CONFIG } from "./config.js";
import { countCueTracks, cueBinaryFiles, hashRomFile } from "./hash.js";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "retcomm_submit_session";

const state = {
  user: null,
  fieldSources: {},
  /**
   * Platform registry from platform-defaults.json: label, media (cart | disc),
   * catalog_dir, rom_extensions, … Keyed by catalog `platform` slug. The
   * Worker bundles the same file, so form and API agree on what exists.
   */
  platformDefaults: null,
  /** Probe-inferred Retro build recipe (included when f_build_enabled). */
  probedBuild: null,
  /** True after the user successfully hashed a local ROM/disc dump. */
  romChecksumDone: false,
  romChecksumFile: "",
  /** PSX two-step: cue parsed before Track 01 .bin hash. Disc 1 of the set. */
  psxCueOk: false,
  psxCueName: "",
  psxFirstBin: "", // basename expected for digests
  psxTrackCount: 0,
  /** Basename while digests are computing (disc bin slot status). */
  romHashingFile: "",
  /**
   * Multi-disc sets: one entry per disc, index 0 = disc 1. Each disc carries
   * its own cue parse and Track 01 digests — a 3-disc game is only owned when
   * all three match, so they can never share a slot.
   */
  discCount: 1,
  discs: [],
};

/** Blank per-disc slot state. */
function newDiscState(index) {
  return {
    index,
    cueOk: false,
    cueName: "",
    firstBin: "",
    trackCount: 0,
    hashing: "",
    done: false,
    file: "",
    serial: "",
    crc32: "",
    md5: "",
    sha1: "",
    sha256: "",
    size: 0,
    filenames: [],
    /** Prefilled from repo metadata (disc_probe.json) rather than a local hash. */
    fromRepo: false,
  };
}

/** Grow/shrink state.discs to n, preserving what the user already hashed. */
function setDiscCount(n) {
  const want = Math.max(1, Math.min(9, Number(n) || 1));
  state.discCount = want;
  while (state.discs.length < want) state.discs.push(newDiscState(state.discs.length + 1));
  if (state.discs.length > want) state.discs.length = want;
  state.discs.forEach((d, i) => (d.index = i + 1));
  return want;
}

function discState(i) {
  if (!state.discs[i]) setDiscCount(i + 1);
  return state.discs[i];
}

/** True when every disc in the set has been hashed locally. */
function allDiscsHashed() {
  if (!state.discs.length) return false;
  return state.discs.every((d) => d.done);
}

function getSessionToken() {
  return sessionStorage.getItem(TOKEN_KEY) || "";
}

function setSessionToken(token) {
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

/** Capture `#session=…` from OAuth redirect and persist for Bearer auth. */
function captureSessionFromHash() {
  const raw = (window.location.hash || "").replace(/^#/, "");
  if (!raw) return false;
  const hash = new URLSearchParams(raw);
  const token = hash.get("session");
  if (!token) return false;
  setSessionToken(token);
  const url = new URL(window.location.href);
  url.hash = "";
  history.replaceState({}, "", url.pathname + url.search);
  return true;
}

async function api(path, opts = {}) {
  const headers = {
    Accept: "application/json",
    ...(opts.body ? { "Content-Type": "application/json" } : {}),
    ...(opts.headers || {}),
  };
  const token = getSessionToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${CONFIG.API_BASE}${path}`, {
    credentials: "include",
    ...opts,
    headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data.error ||
      (data.errors && data.errors.join("; ")) ||
      `HTTP ${res.status}`;
    // The worker returns GitHub's own reply in detail/first/labeled. Showing
    // only `error` hid the actual cause ("Bad credentials", "Resource not
    // accessible", …) and made every failure look the same.
    const err = new Error(msg + apiErrorDetail(data));
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Pull GitHub's message out of an error payload. The worker forwards raw
 * response bodies, which are JSON strings like {"message":"Bad credentials"}.
 */
function apiErrorDetail(data) {
  const seen = [];
  for (const key of ["detail", "first", "labeled"]) {
    const raw = data?.[key];
    if (!raw || typeof raw !== "string") continue;
    let text = raw;
    try {
      const parsed = JSON.parse(raw);
      text = parsed?.message || raw;
      if (Array.isArray(parsed?.errors) && parsed.errors.length) {
        const extra = parsed.errors
          .map((e) => e.message || e.code || e.field)
          .filter(Boolean)
          .join(", ");
        if (extra) text += ` (${extra})`;
      }
    } catch {
      /* not JSON — show as-is */
    }
    text = String(text).trim().slice(0, 300);
    if (text && !seen.includes(text)) seen.push(text);
  }
  return seen.length ? ` — GitHub said: ${seen.join(" / ")}` : "";
}

function showBanner(kind, html) {
  const el = $("banner");
  el.className = `banner ${kind}`;
  el.innerHTML = html;
}

function hideBanner() {
  const el = $("banner");
  el.className = "banner hidden";
  el.textContent = "";
}

function setLoggedIn(user) {
  state.user = user;
  const slot = $("userSlot");
  const actions = $("authActions");
  const root = $("appRoot");
  if (!user) {
    root.classList.add("locked");
    slot.innerHTML = `<span>Sign in with GitHub to probe repos and submit.</span>`;
    actions.innerHTML = `<button type="button" class="primary" id="loginBtn">Sign in with GitHub</button>`;
    $("loginBtn").onclick = () => {
      const returnTo = window.location.href.split("?")[0] + window.location.hash;
      window.location.href = `${CONFIG.API_BASE}/auth/login?return_to=${encodeURIComponent(returnTo)}`;
    };
    $("submitBtn").disabled = true;
    return;
  }
  root.classList.remove("locked");
  slot.innerHTML = `
    <img src="${user.avatar}" alt="" width="36" height="36" />
    <div>
      <strong>@${user.login}</strong>
      <div class="hint" style="margin:0">${user.name || ""}</div>
    </div>`;
  actions.innerHTML = `<button type="button" id="logoutBtn">Sign out</button>`;
  $("logoutBtn").onclick = async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    setSessionToken("");
    setLoggedIn(null);
  };
  $("submitBtn").disabled = false;
}

function csvGet(id) {
  return $(id)
    .value.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function csvSet(id, arr) {
  $(id).value = (arr || []).join(", ");
}

function numCsvGet(id) {
  return csvGet(id)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** Registry entry for a platform slug (null when unknown / not chosen). */
function platformInfo(platform = $("f_platform").value) {
  const d = state.platformDefaults?.[platform];
  return d && typeof d === "object" ? d : null;
}

/** Ordered platform slugs for the picker (registry order, `_notes` skipped). */
function platformSlugs() {
  return Object.keys(state.platformDefaults || {}).filter(
    (k) => !k.startsWith("_") && platformInfo(k)
  );
}

/** Where an approved title lands: titles/<platform>/<id>.json. */
function catalogPath(platform, id) {
  const dir = platformInfo(platform)?.catalog_dir || `titles/${platform || "<platform>"}`;
  return `${dir}/${id || "<id>"}.json`;
}

/** Status line shown before any local hash for the current platform. */
function pendingChecksumMessage(platform = $("f_platform").value) {
  if (!platform) return "Pick a platform first, then hash your local dump here.";
  if (isDiscPlatform(platform)) {
    return state.discCount > 1
      ? `${state.discCount}-disc set detected — add the .cue and Track 01 .bin for each of the ${state.discCount} discs below. Submit stays blocked until every disc is hashed.`
      : `${platformShort(platform)}: add the .cue sheet, then hash Track 01 .bin (or drop a self-contained .car image — does both) — submit stays blocked until both succeed.`;
  }
  const exts = (platformInfo(platform)?.rom_extensions || []).join(" / ");
  return `No ROM hashed yet — drop your ${exts || "ROM"} dump. Submit stays blocked until this step succeeds.`;
}

function platformShort(platform = $("f_platform").value) {
  return platformInfo(platform)?.short || String(platform || "").toUpperCase();
}

/** Build the step-1 cards from the registry. */
function renderPlatformPicker() {
  const host = $("platformPicker");
  if (!host) return;
  host.innerHTML = platformSlugs()
    .map((p) => {
      const d = platformInfo(p);
      return `
      <label class="platform-card" data-platform="${esc(p)}">
        <input type="radio" name="platform" value="${esc(p)}" />
        <span class="platform-short">${esc(d.short || p)}</span>
        <span class="platform-label">${esc(d.label || p)}</span>
        <span class="platform-blurb">${esc(d.blurb || "")}</span>
        <span class="platform-dir">${esc(d.catalog_dir || `titles/${p}`)}/</span>
      </label>`;
    })
    .join("");
  for (const input of host.querySelectorAll("input[name=platform]")) {
    input.addEventListener("change", () => {
      if (input.checked) setPlatform(input.value);
    });
  }
  syncPlatformPicker();
}

function syncPlatformPicker() {
  const cur = $("f_platform").value;
  for (const card of document.querySelectorAll(".platform-card")) {
    const p = card.getAttribute("data-platform");
    const on = !!cur && p === cur;
    card.classList.toggle("selected", on);
    const input = card.querySelector("input");
    if (input) input.checked = on;
  }
  $("appRoot")?.classList.toggle("no-platform", !cur);
  const disp = $("f_platform_display");
  if (disp) disp.value = cur;
  const hint = $("platformHint");
  if (hint) {
    const d = platformInfo(cur);
    hint.innerHTML = d
      ? `<strong>${esc(d.label)}</strong> — approved titles land in <code>${esc(d.catalog_dir || `titles/${cur}`)}/</code>.`
      : "No platform chosen yet — the rest of the form unlocks once you pick one.";
  }
}

/**
 * Re-suffix a probed/typed id when the platform changes (tomba-psx → tomba-snes).
 * Any known platform suffix is stripped first — the id may have been typed or
 * probed before a platform was chosen, so the previous choice alone is not
 * enough to know what is already on the end.
 */
function resuffixId(oldPlatform, newPlatform) {
  const el = $("f_id");
  let v = el.value.trim();
  if (!v || !newPlatform) return;
  if (v === newPlatform || v.endsWith(`-${newPlatform}`)) return;
  for (const p of [oldPlatform, ...platformSlugs()]) {
    if (p && v.endsWith(`-${p}`)) {
      v = v.slice(0, -(p.length + 1));
      break;
    }
  }
  el.value = v ? `${v}-${newPlatform}` : "";
}

/** Platform-specific copy around the checksum block and ROM identity fields. */
function refreshPlatformCopy() {
  const p = $("f_platform").value;
  const d = platformInfo(p);
  const ri = $("romIdentityHint");
  const dropLabel = $("romDropLabel");
  if (ri) {
    if (!d) ri.textContent = "";
    else if (d.media === "disc")
      ri.innerHTML =
        `${esc(d.short)}: <code>.cue</code> then Track&nbsp;01 <code>.bin</code>, or a self-contained <code>.car</code> image (official re-releases) — <code>.iso</code> / <code>.chd</code> are rejected.`;
    else
      ri.innerHTML =
        `${esc(d.label)}: one ${(d.rom_extensions || []).map((e) => `<code>${esc(e)}</code>`).join(" / ")} dump (unzip archives first).` +
        (p === "snes"
          ? " A 512-byte copier header is stripped before hashing, so headered and headerless dumps yield the same digests."
          : "");
  }
  if (dropLabel) {
    dropLabel.textContent = d && d.media !== "disc"
      ? `Drop your ${(d.rom_extensions || []).join(" / ")} dump here`
      : "Drop a ROM here";
  }
}

/**
 * Step 1: the submitter chooses the platform. Everything platform-shaped
 * (checksum slots, defaults, id suffix, catalog path) follows from it.
 */
function setPlatform(platform, { fromProbe = false } = {}) {
  const prev = $("f_platform").value;
  const next = platformInfo(platform) ? platform : "";
  $("f_platform").value = next;
  if (prev !== next) {
    state.romChecksumDone = false;
    state.romChecksumFile = "";
    state.romHashingFile = "";
    resetPsxCueState();
    if (!fromProbe) {
      // A new platform means a different dump — never carry hashes across.
      state.discs = [];
      setDiscCount(1);
      const sel = $("f_disc_count");
      if (sel) sel.value = "1";
      resuffixId(prev, next);
      if (!isDiscPlatform(next)) {
        csvSet("f_track_counts", []);
        $("f_require_cue").checked = false;
      }
      // Extensions / RomM slugs are platform facts, not repo facts.
      csvSet("f_rom_extensions", []);
      csvSet("f_romm_platforms", []);
    }
  }
  applyPlatformDefaults(next);
  syncPlatformPicker();
  refreshPlatformCopy();
  syncChecksumSlots();
  setChecksumUi("pending", pendingChecksumMessage(next));
  refreshPreview();
}

function applyPlatformDefaults(platform) {
  const d = state.platformDefaults?.[platform];
  if (!d) return;
  if (!$("f_rom_extensions").value && d.rom_extensions) {
    csvSet("f_rom_extensions", d.rom_extensions);
  }
  if (platform === "psx") {
    const exts = csvGet("f_rom_extensions").filter(
      (e) => !/\.(iso|chd)$/i.test(e)
    );
    if (!exts.includes(".cue")) exts.unshift(".cue");
    if (!exts.includes(".bin")) exts.push(".bin");
    csvSet("f_rom_extensions", exts);
  }
  if (!$("f_romm_platforms").value && d.romm_platforms) {
    csvSet("f_romm_platforms", d.romm_platforms);
  }
}

function readManifest() {
  const manifest = {
    id: $("f_id").value.trim(),
    name: $("f_name").value.trim(),
    kind: $("f_kind").value,
    platform: $("f_platform").value,
    description: $("f_description").value.trim(),
    homepage: $("f_homepage").value.trim(),
    rom_identity: {
      crc32: csvGet("f_crc32").map((s) => s.toLowerCase()),
      md5: csvGet("f_md5").map((s) => s.toLowerCase()),
      sha1: csvGet("f_sha1").map((s) => s.toLowerCase()),
      sha256: csvGet("f_sha256").map((s) => s.toLowerCase()),
      disc_serials: csvGet("f_disc_serials"),
      sizes: numCsvGet("f_sizes"),
      filenames: csvGet("f_filenames"),
      track_counts: numCsvGet("f_track_counts").filter((n) => n >= 1),
      require_cue:
        $("f_require_cue").checked ||
        numCsvGet("f_track_counts").some((n) => n > 1),
      ...(readDiscsForManifest() ? { discs: readDiscsForManifest() } : {}),
    },
    rom_extensions: csvGet("f_rom_extensions"),
    release: {
      github: $("f_release_github").value.trim(),
      asset_glob: {
        linux: $("f_glob_linux").value.trim(),
        windows: $("f_glob_windows").value.trim(),
        macos: $("f_glob_macos").value.trim(),
      },
    },
    install_dir_name: $("f_install_dir_name").value.trim(),
    launch: {
      linux: $("f_launch_linux").value.trim(),
      windows: $("f_launch_windows").value.trim(),
      macos: $("f_launch_macos").value.trim(),
    },
  };
  if ($("f_allow_prerelease").checked) {
    manifest.release.allow_prerelease = true;
  }
  const romm = csvGet("f_romm_platforms");
  if (romm.length) manifest.romm = { platforms: romm };
  if ($("f_netplay_supported").checked) {
    const maxRaw = $("f_netplay_max_slots").value.trim();
    let max_slots = maxRaw ? Number(maxRaw) : 2;
    if (!Number.isFinite(max_slots) || max_slots < 2) max_slots = 2;
    const netplay = {
      supported: true,
      stack: "recomp-net",
      game_name: $("f_netplay_game_name").value.trim(),
      game_version: $("f_netplay_game_version").value.trim(),
      max_slots,
    };
    const transports = csvGet("f_netplay_transports");
    if (transports.length) netplay.transports = transports;
    const schema = $("f_netplay_match_caps").value.trim();
    if (schema) netplay.match_caps_schema = schema;
    manifest.netplay = netplay;
  }
  if ($("f_build_enabled")?.checked && state.probedBuild?.enabled) {
    manifest.build = state.probedBuild;
  }
  const author_notes = $("f_author_notes").value.trim();
  if (author_notes) manifest.author_notes = author_notes;
  const notes = $("f_notes").value.trim();
  if (notes) manifest.notes = notes;
  if (!manifest.description) delete manifest.description;
  if (!manifest.homepage) delete manifest.homepage;
  return manifest;
}

function fillForm(draft, meta = {}) {
  state.fieldSources = meta.field_sources || {};
  for (const el of document.querySelectorAll("[data-src]")) {
    const key = el.getAttribute("data-src");
    el.textContent = state.fieldSources[key]
      ? `← ${state.fieldSources[key]}`
      : "";
  }

  // The platform was chosen in step 1 and sent with the probe; the draft
  // echoes it back. Only adopt the draft's guess when nothing was chosen.
  const platform = $("f_platform").value || draft.platform || "";
  if (platform !== $("f_platform").value) setPlatform(platform, { fromProbe: true });

  $("f_id").value = draft.id || "";
  $("f_name").value = draft.name || "";
  $("f_kind").value = draft.kind || "recomp";
  $("f_description").value = draft.description || "";
  $("f_homepage").value = draft.homepage || "";
  $("f_release_github").value = draft.release?.github || "";
  $("f_install_dir_name").value = draft.install_dir_name || "";
  $("f_glob_linux").value = draft.release?.asset_glob?.linux || "";
  $("f_glob_windows").value = draft.release?.asset_glob?.windows || "";
  $("f_glob_macos").value = draft.release?.asset_glob?.macos || "";
  $("f_allow_prerelease").checked = !!draft.release?.allow_prerelease;
  $("f_launch_linux").value = draft.launch?.linux || "";
  $("f_launch_windows").value = draft.launch?.windows || "";
  $("f_launch_macos").value = draft.launch?.macos || "";

  const ri = draft.rom_identity || {};
  // Multi-disc: adopt the detected count and per-disc metadata. Digests that
  // came from the repo are shown but do NOT count as hashed — the submitter
  // still proves ownership of every disc locally.
  applyDraftDiscs(ri.discs);
  csvSet("f_crc32", ri.crc32);
  csvSet("f_md5", ri.md5);
  csvSet("f_sha1", ri.sha1);
  csvSet("f_sha256", ri.sha256);
  csvSet("f_disc_serials", ri.disc_serials);
  csvSet("f_sizes", ri.sizes);
  csvSet("f_filenames", ri.filenames);
  csvSet("f_track_counts", ri.track_counts);
  $("f_require_cue").checked = !!(
    ri.require_cue || (ri.track_counts || []).some((n) => Number(n) > 1)
  );
  csvSet("f_rom_extensions", draft.rom_extensions);
  csvSet("f_romm_platforms", draft.romm?.platforms);

  state.probedBuild = draft.build?.enabled ? draft.build : null;
  const buildChk = $("f_build_enabled");
  const buildPrev = $("f_build_preview");
  if (buildChk) {
    buildChk.checked = !!state.probedBuild;
  }
  if (buildPrev) {
    if (state.probedBuild) {
      buildPrev.style.display = "block";
      buildPrev.textContent = JSON.stringify(state.probedBuild, null, 2);
    } else {
      buildPrev.style.display = "none";
      buildPrev.textContent = "";
    }
  }

  const np = draft.netplay || {};
  $("f_netplay_supported").checked = !!(np.supported && np.stack !== "none");
  $("f_netplay_game_name").value = np.game_name || "";
  $("f_netplay_game_version").value = np.game_version || "";
  $("f_netplay_max_slots").value =
    np.max_slots != null && np.max_slots !== "" ? String(np.max_slots) : "";
  $("f_netplay_match_caps").value = np.match_caps_schema || "";
  csvSet("f_netplay_transports", np.transports);
  $("f_author_notes").value = draft.author_notes || "";
  $("f_notes").value = draft.notes || "";

  applyPlatformDefaults(platform);
  syncPlatformPicker();
  refreshPlatformCopy();

  // Probe does not carry client-side hashes — reset checksum UI for the platform.
  state.romChecksumDone = false;
  state.romChecksumFile = "";
  state.romHashingFile = "";
  resetPsxCueState();
  syncChecksumSlots();
  // Unless the repository itself carries the identity: a cartridge port
  // scaffolded by snesrecomp's wizard commits rom_identity.txt with every
  // digest (crc32, md5, sha1, sha256), the size and the dump's filename, of
  // the bare image. The worker verified the file is complete
  // (meta.identity_from_repo), so the local hash becomes an optional
  // re-check rather than the gate.
  const repoIdentity =
    !!meta.identity_from_repo &&
    !isDiscPlatform(platform) &&
    ["crc32", "md5", "sha1", "sha256"].every((k) => (ri[k] || []).length);
  if (repoIdentity) {
    state.romChecksumDone = true;
    state.romChecksumFile = "rom_identity.txt (from the repository)";
    setChecksumUi(
      "ok",
      "Identity taken from the repository's rom_identity.txt (crc32, md5, sha1, sha256, size). " +
        "Hashing your own dump here is optional and only re-checks those digests. You can submit."
    );
  } else {
    setChecksumUi("pending", pendingChecksumMessage(platform));
  }

  const chips = $("assetChips");
  chips.innerHTML = "";
  for (const a of meta.assets || []) {
    const span = document.createElement("span");
    span.className = "chip";
    span.textContent = a;
    chips.appendChild(span);
  }

  const parts = [];
  if (meta.release_tag) parts.push(`release ${meta.release_tag}`);
  if (meta.digest_sources?.length) {
    parts.push(`digests from ${meta.digest_sources.join(", ")}`);
  }
  if (repoIdentity) parts.push("identity complete in rom_identity.txt (local hash optional)");
  $("metaLine").textContent = parts.length
    ? `Auto-filled: ${parts.join(" · ")}. Edit anything before submitting.`
    : "Draft loaded. Fill missing fields before submitting.";

  refreshPreview();
}

function refreshPreview() {
  const m = readManifest();
  $("preview").textContent = JSON.stringify(m, null, 2);
  const line = $("pathLine");
  if (line) {
    line.innerHTML = m.platform
      ? `Lands at <code>${esc(catalogPath(m.platform, m.id))}</code> once approved.`
      : "";
  }
}

/** Mirror worker validateManifest so required fields fail before the API call. */
/**
 * True when a ROM basename carries no identifying information.
 *
 * filenames are the hub's search hints when a title has no local match, and
 * they seed the Libretro boxart lookup, which is named No-Intro/Redump style.
 * mortal-kombat-4-psx shipped ["disc1.cue","disc1.bin"] — the submitter's own
 * file names — so the hub told users to look for "disc1.cue" and the cover
 * never resolved. Digests still matched, which is why nothing caught it.
 */
function looksLikePlaceholderRomName(name) {
  const stem = String(name || "")
    .split(/[/\\]/).pop()
    .replace(/\.[^.]+$/, "")
    .trim()
    .toLowerCase();
  if (!stem) return false;
  // A real dump name is the game's title, usually with a region in parens.
  return /^(disc|cd|track|game|rom|image|dump|output|data|title|iso|bin|cue)[\s._-]*\d*$/.test(stem);
}

function validateManifest(m) {
  const errors = [];
  if (!m?.id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(m.id)) {
    errors.push("id must be a lowercase slug (e.g. megaman-x-snes)");
  }
  if (!m?.name) errors.push("name is required");
  if (!m?.kind || !["recomp", "decomp"].includes(m.kind)) {
    errors.push('kind must be "recomp" or "decomp"');
  }
  if (!m?.platform) errors.push("platform is required — pick one in step 1");
  else if (!platformInfo(m.platform)) {
    errors.push(
      `platform "${m.platform}" is not a catalog platform (${platformSlugs().join(", ")})`
    );
  }
  if (!m?.release?.github) errors.push("release.github is required");
  const glob = m?.release?.asset_glob || {};
  if (!glob.linux && !glob.windows && !glob.macos) {
    errors.push("release.asset_glob needs at least one OS pattern");
  }
  if (!m?.install_dir_name) errors.push("install_dir_name is required");
  const launch = m?.launch || {};
  if (!launch.linux && !launch.windows && !launch.macos) {
    errors.push("launch needs at least one OS binary name");
  }
  if (!state.romChecksumDone) {
    const missing =
      state.discCount > 1
        ? state.discs.filter((d) => !d.done).map((d) => `disc ${d.index}`)
        : [];
    errors.push(
      missing.length
        ? `Hash every disc before submitting — still missing: ${missing.join(", ")}`
        : "Rom Checksum Submission is required — hash your local ROM/disc dump with the file picker before submitting"
    );
  }
  const id = m?.rom_identity || {};
  const fnames = id.filenames || [];
  if (fnames.length && fnames.every(looksLikePlaceholderRomName)) {
    errors.push(
      "rom_identity.filenames looks like placeholder names (" +
        fnames.join(", ") +
        "). These are the search hints the hub shows when a user has no match, " +
        "and they drive the Libretro cover lookup — use the real dump names, " +
        'e.g. "' + (m?.name || "Game") + ' (USA).cue".'
    );
  }
  const hasDigest =
    id.crc32?.length || id.md5?.length || id.sha1?.length || id.sha256?.length;
  if (!hasDigest) {
    errors.push(
      "rom_identity needs digests from the local ROM hash (crc32 / md5 / sha1 / sha256)"
    );
  }
  if (m?.platform === "psx") {
    if (!state.psxCueOk) {
      errors.push(
        "PSX: drop the .cue sheet first (track count), then hash Track 01 .bin — " +
          "or drop a self-contained .car image (does both)"
      );
    }
    if (!id.track_counts?.length) {
      errors.push(
        "PSX: rom_identity.track_counts is required (from the .cue, or 1 for a .car)"
      );
    }
    const exts = m.rom_extensions || [];
    if (exts.some((e) => /\.(iso|chd)$/i.test(String(e)))) {
      errors.push(
        "PSX rom_extensions must not include .iso / .chd (.cue/.bin, plus .car for official single-file images)"
      );
    }
  }
  if (m?.netplay?.supported) {
    if (m.netplay.stack && m.netplay.stack !== "recomp-net") {
      errors.push('netplay.stack must be "recomp-net" when supported');
    }
    if (!m.netplay.game_name) {
      errors.push("netplay.game_name is required when netplay is supported");
    }
    if (m.netplay.game_version == null || m.netplay.game_version === "") {
      errors.push("netplay.game_version is required when netplay is supported");
    }
  }
  return errors;
}

function mergeUnique(id, values) {
  const cur = new Set(csvGet(id));
  for (const v of values) cur.add(v);
  csvSet(id, [...cur]);
}

/** Disc media = cue + Track 01 bin per disc; anything else is one cart file. */
function isDiscPlatform(platform = $("f_platform").value) {
  return platformInfo(platform)?.media === "disc";
}

function setSlotStatus(id, kind, message) {
  const el = $(id);
  if (!el) return;
  el.classList.remove("pending", "ok", "err");
  if (kind) el.classList.add(kind);
  el.textContent = message || "";
}

/**
 * Wire a drop zone + file input. `disc` is the 0-based index of the disc this
 * slot belongs to (undefined for the cart/single-file zone), so a drop lands on
 * the right disc of a multi-disc set.
 */
function bindDropZone(dropEl, fileInput, { acceptExt, disc } = {}) {
  if (!dropEl || !fileInput) return;
  fileInput.addEventListener("change", () => {
    onRomFile(fileInput.files?.[0], disc);
    fileInput.value = "";
  });
  dropEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!dropEl.classList.contains("drop-disabled")) dropEl.classList.add("drag");
  });
  dropEl.addEventListener("dragleave", () => dropEl.classList.remove("drag"));
  dropEl.addEventListener("drop", (e) => {
    e.preventDefault();
    dropEl.classList.remove("drag");
    if (dropEl.classList.contains("drop-disabled")) return;
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (acceptExt) {
      const lower = (file.name || "").toLowerCase();
      const ok = acceptExt.some((ext) => lower.endsWith(ext));
      if (!ok) {
        setChecksumUi(
          "err",
          `${file.name} rejected — this slot accepts ${acceptExt.join(" / ")} only.`
        );
        return;
      }
    }
    onRomFile(file, disc);
  });
}

/**
 * Rebuild the flat rom_identity fields from state.discs.
 *
 * discs[] is the truth for a multi-disc set; the flat lists exist so launchers
 * that predate discs[] still resolve the title. Disc 1 is emitted first so
 * first-match preference lands on the boot disc rather than mid-game.
 */
function syncFlatIdentityFromDiscs() {
  if (!state.discs.length) return;
  const ordered = [...state.discs].sort((a, b) => a.index - b.index);
  const crc = [], md5 = [], sha1 = [], sha256 = [], sizes = [], names = [], serials = [], tracks = [];
  const add = (arr, v) => {
    if (v == null || v === "" || arr.includes(v)) return;
    arr.push(v);
  };
  for (const d of ordered) {
    add(crc, d.crc32);
    add(md5, d.md5);
    add(sha1, d.sha1);
    add(sha256, d.sha256);
    if (d.size) add(sizes, String(d.size));
    if (d.trackCount) add(tracks, String(d.trackCount));
    add(serials, d.serial);
    for (const n of d.filenames || []) add(names, n);
  }
  csvSet("f_crc32", crc);
  csvSet("f_md5", md5);
  csvSet("f_sha1", sha1);
  csvSet("f_sha256", sha256);
  csvSet("f_sizes", sizes);
  csvSet("f_track_counts", tracks);
  // Serials and filenames may also come from repo metadata — merge, don't clobber.
  for (const v of serials) mergeUnique("f_disc_serials", [v]);
  for (const v of names) mergeUnique("f_filenames", [v]);
  if (tracks.some((n) => Number(n) > 1)) $("f_require_cue").checked = true;
  refreshPreview();
}

/** discs[] for the manifest — only meaningful for a real multi-disc set. */
function readDiscsForManifest() {
  if (state.discCount < 2) return null;
  return state.discs
    .slice(0, state.discCount)
    .map((d) => ({
      index: d.index,
      serial: d.serial || "",
      cue_name: d.cueName || "",
      bin_name: d.firstBin || "",
      crc32: d.crc32 ? [d.crc32] : [],
      md5: d.md5 ? [d.md5] : [],
      sha1: d.sha1 ? [d.sha1] : [],
      sha256: d.sha256 ? [d.sha256] : [],
      sizes: d.size ? [d.size] : [],
      track_counts: d.trackCount ? [d.trackCount] : [],
    }));
}

/**
 * Seed per-disc slots from a probed rom_identity.discs[].
 *
 * Repo metadata gives the shape of the set (count, serials, cue names) and
 * sometimes disc 1's digests. It is never accepted as proof of ownership:
 * every disc still has to be hashed locally, so `done` stays false.
 */
function applyDraftDiscs(discs) {
  const list = Array.isArray(discs) ? discs : [];
  const sel = $("f_disc_count");
  // A new probe is a different title — never carry a previous repo's hashes.
  state.discs = [];
  if (list.length < 2) {
    setDiscCount(1);
    if (sel) sel.value = "1";
    if (isDiscPlatform()) renderDiscSlots();
    return;
  }
  setDiscCount(list.length);
  if (sel) sel.value = String(list.length);
  list
    .slice()
    .sort((a, b) => Number(a.index || 0) - Number(b.index || 0))
    .forEach((src, i) => {
      const d = discState(i);
      d.serial = String(src.serial || "");
      d.cueName = String(src.cue_name || "");
      d.firstBin = String(src.bin_name || "");
      const tc = Number((src.track_counts || [])[0]);
      if (Number.isInteger(tc) && tc >= 1) d.trackCount = tc;
      d.filenames = [src.cue_name, src.bin_name].filter(Boolean);
      d.fromRepo = true;
      // Structure only — a local hash is what unlocks submit.
      d.cueOk = false;
      d.done = false;
    });
  const hint = $("discCountHint");
  if (hint) {
    hint.innerHTML =
      `Detected <strong>${list.length} discs</strong> from the repo's <code>disc_set.json</code>. ` +
      "Each still needs its own local Track&nbsp;01 hash below.";
  }
  if (isDiscPlatform()) renderDiscSlots();
}

/** Escape for injection into slot markup (cue/bin names come from files). */
function esc(v) {
  return String(v == null ? "" : v).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

/**
 * Build one cue+bin pair per disc. Ids are suffixed with the 1-based disc
 * number (cueDrop1, binDrop1, …) so every disc gets its own drop zones and
 * status lines.
 */
function renderDiscSlots() {
  const host = $("discSlotList");
  if (!host) return;
  const n = state.discCount;
  const multi = n > 1;

  host.innerHTML = state.discs
    .map((d, i) => {
      const k = i + 1;
      const title = multi ? `Disc ${k}` : "";
      const serial = d.serial ? ` <span class="disc-serial">${esc(d.serial)}</span>` : "";
      return `
      <div class="disc-group${multi ? " disc-group-multi" : ""}" id="discGroup${k}">
        ${multi ? `<h3 class="disc-group-title">${title}${serial}</h3>` : ""}
        <div class="disc-slot" id="cueSlot${k}">
          <h4 class="disc-slot-title">
            1. Cue sheet <code>.cue</code> (or <code>.car</code>)
          </h4>
          <p class="hint disc-slot-hint">
            Redump cue sheet — fills <code>track_counts</code> and the expected
            Track&nbsp;01 filename.${
              d.cueName && d.fromRepo
                ? ` Repo expects <strong>${esc(d.cueName)}</strong>.`
                : ""
            }
          </p>
          <div class="drop drop-required" id="cueDrop${k}">
            Drop the <code>.cue</code> (or <code>.car</code>) here, or
            <label class="file-pick">
              <strong>choose .cue</strong>
              <input id="cueFile${k}" type="file" accept=".cue,.car,text/plain" hidden />
            </label>
            <div id="cueHashStatus${k}" class="hint checksum-status"></div>
          </div>
        </div>
        <div class="disc-slot" id="binSlot${k}">
          <h4 class="disc-slot-title">2. Track&nbsp;01 binary <code>.bin</code></h4>
          <p class="hint disc-slot-hint" id="binSlotHint${k}"></p>
          <div class="drop drop-required drop-disabled" id="binDrop${k}">
            Drop Track&nbsp;01 <code>.bin</code> here, or
            <label class="file-pick">
              <strong>choose .bin</strong>
              <input id="binFile${k}" type="file" accept=".bin,.car,application/octet-stream" hidden disabled />
            </label>
            <div id="binHashStatus${k}" class="hint checksum-status"></div>
          </div>
        </div>
      </div>`;
    })
    .join("");

  // Freshly created nodes need their own listeners.
  state.discs.forEach((d, i) => {
    const k = i + 1;
    bindDropZone($(`cueDrop${k}`), $(`cueFile${k}`), {
      acceptExt: [".cue", ".car"],
      disc: i,
    });
    bindDropZone($(`binDrop${k}`), $(`binFile${k}`), {
      acceptExt: [".bin", ".car"],
      disc: i,
    });
  });

  refreshDiscSlotUi();
}

function refreshDiscSlotUi() {
  state.discs.forEach((d, i) => {
    const k = i + 1;
    const cueDrop = $(`cueDrop${k}`);
    const binDrop = $(`binDrop${k}`);
    const binFile = $(`binFile${k}`);
    const binHint = $(`binSlotHint${k}`);
    if (!cueDrop || !binDrop) return;

    cueDrop.classList.toggle("hashed", !!d.cueOk);
    binDrop.classList.toggle("drop-disabled", !d.cueOk);
    binDrop.classList.toggle("hashed", !!d.done && !!d.cueOk);
    if (binFile) binFile.disabled = !d.cueOk;

    if (binHint) {
      binHint.innerHTML = d.firstBin
        ? `Hash <strong>${esc(d.firstBin)}</strong> (first BINARY / Track&nbsp;01 from the cue). Digests come from this file, not the cue.`
        : "Hash the first BINARY track named in the cue (usually Track&nbsp;01). Digests come from this file, not the cue.";
    }

    setSlotStatus(
      `cueHashStatus${k}`,
      d.cueOk ? "ok" : "",
      d.cueOk ? `${d.cueName}: ${d.trackCount} track(s)` : ""
    );

    if (d.done && d.cueOk) {
      setSlotStatus(`binHashStatus${k}`, "ok", `Hashed ${d.file}`);
    } else if (d.hashing && d.cueOk) {
      setSlotStatus(`binHashStatus${k}`, "pending", `Hashing ${d.hashing}…`);
    } else if (d.cueOk) {
      setSlotStatus(
        `binHashStatus${k}`,
        "pending",
        d.firstBin ? `Waiting for “${d.firstBin}”` : "Waiting for Track 01 .bin"
      );
    } else {
      setSlotStatus(`binHashStatus${k}`, "", "");
    }
  });

  const hint = $("discCountHint");
  if (hint && state.discCount > 1) {
    const done = state.discs.filter((d) => d.done).length;
    hint.innerHTML =
      `<strong>${done} of ${state.discCount}</strong> discs hashed. ` +
      "All of them are required — the catalog entry records one identity per disc.";
  }
}

/** Show cart (single) or disc (cue + bin) checksum slots from platform. */
function syncChecksumSlots() {
  const disc = isDiscPlatform();
  const cart = $("cartChecksumSlots");
  const discSlots = $("discChecksumSlots");
  const lede = $("checksumLede");
  const block = $("checksumBlock");

  cart?.classList.toggle("hidden", disc);
  discSlots?.classList.toggle("hidden", !disc);
  block?.classList.toggle("disc-mode", disc);

  if (lede) {
    lede.innerHTML = disc
      ? state.discCount > 1
        ? `This is a ${state.discCount}-disc set — each disc needs its own <code>.cue</code> and Track&nbsp;01 <code>.bin</code>. Nothing is uploaded, only digests.`
        : "PSX / disc titles need two local files: the Redump <code>.cue</code>, then Track&nbsp;01 <code>.bin</code>. Nothing is uploaded — only digests are filled."
      : "Drop your ROM below. The file never leaves your browser — only digests are filled into the form.";
  }

  if (disc) {
    if (!state.discs.length) setDiscCount(state.discCount || 1);
    renderDiscSlots();
  } else {
    $("romDrop")?.classList.toggle("hashed", !!state.romChecksumDone);
  }
}

function setChecksumUi(kind, message) {
  const status = $("romHashStatus");
  const block = $("checksumBlock");
  status.classList.remove("pending", "ok", "err");
  if (kind) status.classList.add(kind);
  status.textContent = message;
  const done = kind === "ok";
  block?.classList.toggle("done", done);

  if (isDiscPlatform()) {
    refreshDiscSlotUi();
  } else {
    $("romDrop")?.classList.toggle("hashed", done);
  }
}

function resetPsxCueState() {
  state.psxCueOk = false;
  state.psxCueName = "";
  state.psxFirstBin = "";
  state.psxTrackCount = 0;
}

function basenameLower(name) {
  return String(name || "")
    .split(/[/\\]/)
    .pop()
    .toLowerCase();
}

async function onRomFile(file, discIdx) {
  if (!file) return;
  const lower = (file.name || "").toLowerCase();
  const platform = $("f_platform").value;
  const isPsx = platform === "psx";
  // Cart platforms have no disc slots; disc platforms default to disc 1.
  const di = Number.isInteger(discIdx) ? discIdx : 0;
  const d = isDiscPlatform() ? discState(di) : null;

  if (/\.(iso|chd)$/i.test(lower)) {
    setChecksumUi(
      "err",
      `${file.name} rejected — use a Redump .cue + Track 01 .bin (not .iso/.chd).`
    );
    return;
  }

  /* Cart platforms hash exactly one dump file. Gate on the platform's own
     extension list so a .zip or a wrong-system dump is refused up front
     (digests of a zip would never match the game's gate). */
  const info = platformInfo(platform);
  if (info && info.media !== "disc") {
    const exts = info.rom_extensions || [];
    if (exts.length && !exts.some((e) => lower.endsWith(String(e).toLowerCase()))) {
      setChecksumUi(
        "err",
        `${file.name} rejected — ${info.label} dumps are ${exts.join(" / ")}. Unzip archives first.`
      );
      return;
    }
  }

  /* .cue sheets are TOC metadata — parse TRACK count; digests come from Track 01. */
  if (lower.endsWith(".cue")) {
    try {
      const text = await file.text();
      const tracks = countCueTracks(text);
      const bins = cueBinaryFiles(text);
      if (tracks < 1) {
        setChecksumUi(
          "err",
          `${file.name} has no TRACK lines — is this a valid cue sheet?`
        );
        return;
      }
      if (!bins.length) {
        setChecksumUi(
          "err",
          `${file.name} has no FILE … BINARY lines — cannot locate Track 01.`
        );
        return;
      }
      if (d) {
        d.cueOk = true;
        d.cueName = file.name;
        d.firstBin = bins[0];
        d.trackCount = tracks;
        d.fromRepo = false;
        /* Re-dropping a cue invalidates that disc's digests — the bin must be
           re-hashed against the new TOC. */
        d.done = false;
        d.file = "";
        d.crc32 = d.md5 = d.sha1 = d.sha256 = "";
        d.size = 0;
        d.filenames = [file.name, ...bins.slice(0, 3)];
      }
      state.psxCueOk = true;
      state.psxCueName = file.name;
      state.psxFirstBin = bins[0];
      state.psxTrackCount = tracks;
      if (isPsx) {
        state.romChecksumDone = allDiscsHashed();
        if (!state.romChecksumDone) state.romChecksumFile = "";
      }
      mergeUnique("f_track_counts", [String(tracks)]);
      mergeUnique("f_filenames", [file.name, ...bins.slice(0, 3)]);
      if (tracks > 1) $("f_require_cue").checked = true;
      if (isPsx) {
        const exts = csvGet("f_rom_extensions").filter(
          (e) => !/\.(iso|chd)$/i.test(e)
        );
        if (!exts.includes(".cue")) exts.push(".cue");
        if (!exts.includes(".bin")) exts.push(".bin");
        csvSet("f_rom_extensions", exts);
      }
      setChecksumUi(
        "pending",
        `Cue ${file.name}: ${tracks} track(s). Next: hash “${bins[0]}” ` +
          `(first BINARY / Track 01) — digests are not taken from the .cue.`
      );
      refreshPreview();
    } catch (err) {
      setChecksumUi("err", `Cue parse failed: ${err.message}`);
    }
    return;
  }

  /* Self-contained official re-release image (.car — e.g. Steam Tomba!
     Special Edition's t_data_u.car): a complete single-track raw disc image
     with no cue sheet. It stands in for the cue (one track) AND is the
     hashed payload — one drop satisfies both PSX slots. */
  if (isPsx && lower.endsWith(".car")) {
    if (d) {
      d.cueOk = true;
      d.cueName = file.name;
      d.firstBin = file.name;
      d.trackCount = 1;
      d.fromRepo = false;
      d.filenames = [file.name];
    }
    state.psxCueOk = true;
    state.psxCueName = file.name;
    state.psxFirstBin = file.name;
    state.psxTrackCount = 1;
    mergeUnique("f_track_counts", ["1"]);
    const exts = csvGet("f_rom_extensions").filter(
      (e) => !/\.(iso|chd)$/i.test(e)
    );
    if (!exts.includes(".cue")) exts.push(".cue");
    if (!exts.includes(".bin")) exts.push(".bin");
    if (!exts.includes(".car")) exts.push(".car");
    csvSet("f_rom_extensions", exts);
    /* fall through to the generic hashing below */
  } else if (isPsx) {
    if (!state.psxCueOk || !state.psxFirstBin) {
      setChecksumUi(
        "err",
        "PSX: drop the .cue sheet first (or a self-contained .car image), " +
          "then the Track 01 .bin named in that cue."
      );
      return;
    }
    if (!/\.(bin|car)$/.test(lower)) {
      setChecksumUi(
        "err",
        `PSX digests must come from “${state.psxFirstBin}” (.bin), not ${file.name}.`
      );
      return;
    }
    if (basenameLower(file.name) !== basenameLower(state.psxFirstBin)) {
      setChecksumUi(
        "err",
        `Expected “${state.psxFirstBin}” (cue’s first BINARY). Got ${file.name}.`
      );
      return;
    }
  }

  state.romChecksumDone = false;
  state.romChecksumFile = "";
  state.romHashingFile = file.name;
  if (d) {
    d.hashing = file.name;
    d.done = false;
  }
  setChecksumUi("pending", `Hashing ${file.name}…`);
  try {
    const h = await hashRomFile(file);
    if (d) {
      // Per-disc identity. The flat form fields are rebuilt from these so the
      // two can never disagree.
      d.crc32 = h.crc32 || "";
      d.md5 = h.md5 || "";
      d.sha1 = h.sha1 || "";
      d.sha256 = h.sha256 || "";
      d.size = Number(h.hashed_size) || 0;
      d.filenames = [...new Set([...(d.filenames || []), h.filename])];
      d.done = true;
      d.file = file.name;
      d.hashing = "";
      d.fromRepo = false;
      syncFlatIdentityFromDiscs();
    } else {
      mergeUnique("f_crc32", [h.crc32]);
      mergeUnique("f_md5", [h.md5]);
      mergeUnique("f_sha1", [h.sha1]);
      mergeUnique("f_sha256", [h.sha256]);
      mergeUnique("f_sizes", [String(h.hashed_size)]);
      mergeUnique("f_filenames", [h.filename]);
    }
    state.romChecksumDone = d ? allDiscsHashed() : true;
    state.romChecksumFile = file.name;
    state.romHashingFile = "";
    const tracksHint = isPsx
      ? ` Cue ${state.psxCueName}: ${state.psxTrackCount} track(s).`
      : numCsvGet("f_track_counts").length
        ? ` track_counts=${numCsvGet("f_track_counts").join(",")}.`
        : "";
    const remaining = d ? state.discs.filter((x) => !x.done).length : 0;
    const setHint =
      state.discCount > 1
        ? remaining === 0
          ? ` All ${state.discCount} discs hashed.`
          : ` ${state.discCount - remaining} of ${state.discCount} discs hashed — ${remaining} to go.`
        : "";
    const canSubmit = state.romChecksumDone ? " You can submit." : "";
    setChecksumUi(
      remaining === 0 ? "ok" : "pending",
      h.header_stripped
        ? `Hashed ${file.name} (stripped 512-byte SMC header). Digests filled.${tracksHint}${setHint}${canSubmit}`
        : `Hashed ${file.name}. Digests filled.${tracksHint}${setHint} File was not uploaded.${canSubmit}`
    );
    refreshPreview();
  } catch (err) {
    if (d) {
      d.done = false;
      d.hashing = "";
      d.file = "";
    }
    state.romChecksumDone = d ? allDiscsHashed() : false;
    state.romChecksumFile = "";
    state.romHashingFile = "";
    setChecksumUi("err", `Hash failed: ${err.message}`);
  }
}

async function init() {
  // Load platform defaults from this repo (static)
  try {
    state.platformDefaults = await fetch("./platform-defaults.json").then((r) =>
      r.json()
    );
  } catch {
    state.platformDefaults = {};
  }
  renderPlatformPicker();
  refreshPlatformCopy();

  const gotSession = captureSessionFromHash();
  const params = new URLSearchParams(window.location.search);
  if (params.get("error") === "banned") {
    setSessionToken("");
    showBanner(
      "danger",
      "This GitHub account is banned from catalog submissions."
    );
    history.replaceState({}, "", window.location.pathname);
  } else if (params.get("logged_in") === "1" || gotSession) {
    history.replaceState({}, "", window.location.pathname);
  }

  try {
    const me = await api("/auth/me");
    if (me.error === "banned") {
      setSessionToken("");
      showBanner(
        "danger",
        "This GitHub account is banned from catalog submissions."
      );
      setLoggedIn(null);
    } else if (me.user) {
      setLoggedIn(me.user);
      if (gotSession || params.get("logged_in") === "1") {
        showBanner("ok", `Signed in as <strong>@${me.user.login}</strong>.`);
      }
    } else {
      setLoggedIn(null);
      if (params.get("logged_in") === "1" || gotSession) {
        showBanner(
          "warn",
          "Sign-in finished but the session was not accepted. Try signing in again; if it persists, redeploy the Worker with the latest auth fix."
        );
      }
    }
  } catch (err) {
    setLoggedIn(null);
    showBanner(
      "warn",
      `API unreachable at <code>${CONFIG.API_BASE}</code>. Deploy the Worker and update <code>submit/config.js</code>. (${err.message})`
    );
  }

  for (const id of [
    "f_id",
    "f_name",
    "f_kind",
    "f_description",
    "f_build_enabled",
    "f_homepage",
    "f_release_github",
    "f_install_dir_name",
    "f_glob_linux",
    "f_glob_windows",
    "f_glob_macos",
    "f_allow_prerelease",
    "f_launch_linux",
    "f_launch_windows",
    "f_launch_macos",
    "f_crc32",
    "f_md5",
    "f_sha1",
    "f_sha256",
    "f_disc_serials",
    "f_sizes",
    "f_filenames",
    "f_track_counts",
    "f_require_cue",
    "f_rom_extensions",
    "f_romm_platforms",
    "f_netplay_supported",
    "f_netplay_game_name",
    "f_netplay_game_version",
    "f_netplay_max_slots",
    "f_netplay_match_caps",
    "f_netplay_transports",
    "f_author_notes",
    "f_notes",
  ]) {
    $(id).addEventListener("input", refreshPreview);
    $(id).addEventListener("change", refreshPreview);
  }

  $("probeBtn").onclick = async () => {
    hideBanner();
    const platform = $("f_platform").value;
    if (!platform) {
      showBanner("warn", "Pick a platform in step 1 before probing a repo.");
      return;
    }
    $("probeBtn").disabled = true;
    try {
      const data = await api("/api/probe", {
        method: "POST",
        body: JSON.stringify({ repo: $("repoInput").value, platform }),
      });
      fillForm(data.draft, data.meta);
      const warnings = (data.meta?.warnings || []).map((w) => `<li>${esc(w)}</li>`);
      showBanner(
        warnings.length ? "warn" : "ok",
        "Repo probed. Review fields, then hash your local ROM under <strong>Rom Checksum Submission</strong> before submitting." +
          (warnings.length ? `<ul>${warnings.join("")}</ul>` : "")
      );
    } catch (err) {
      showBanner("danger", err.message);
    } finally {
      $("probeBtn").disabled = false;
    }
  };

  $("submitBtn").onclick = async () => {
    hideBanner();
    const manifest = readManifest();
    const localErrors = validateManifest(manifest);
    if (localErrors.length) {
      showBanner(
        "danger",
        `Missing or invalid required fields:<ul>${localErrors
          .map((e) => `<li>${e}</li>`)
          .join("")}</ul>`
      );
      return;
    }
    $("submitBtn").disabled = true;
    try {
      const data = await api("/api/submit", {
        method: "POST",
        body: JSON.stringify({
          manifest,
          submitter_note: $("f_submitter_note").value.trim(),
        }),
      });
      const emailNote = data.email?.sent
        ? ` Email sent to ${data.email.to.join(", ")}.`
        : data.email?.reason
          ? ` Email: ${data.email.reason}.`
          : "";
      showBanner(
        "ok",
        `Submitted. Approval issue: <a href="${data.issue_url}" target="_blank" rel="noopener">${data.issue_url}</a>.${emailNote}`
      );
    } catch (err) {
      const extra =
        err.data?.errors?.length > 0
          ? `<ul>${err.data.errors.map((e) => `<li>${e}</li>`).join("")}</ul>`
          : "";
      showBanner("danger", `${err.message}${extra}`);
    } finally {
      $("submitBtn").disabled = !state.user;
    }
  };

  $("downloadBtn").onclick = () => {
    const m = readManifest();
    const blob = new Blob([JSON.stringify(m, null, 2) + "\n"], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${m.id || "title"}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  $("copyBtn").onclick = async () => {
    await navigator.clipboard.writeText(
      JSON.stringify(readManifest(), null, 2) + "\n"
    );
    showBanner("ok", "JSON copied to clipboard.");
  };

    bindDropZone($("romDrop"), $("romFile"));

  $("f_disc_count")?.addEventListener("change", (e) => {
    setDiscCount(e.target.value);
    state.romChecksumDone = isDiscPlatform() ? allDiscsHashed() : state.romChecksumDone;
    syncChecksumSlots();
    syncFlatIdentityFromDiscs();
    refreshPreview();
  });

  syncChecksumSlots();
  syncPlatformPicker();
  setChecksumUi("pending", pendingChecksumMessage());

  refreshPreview();
}

init();
