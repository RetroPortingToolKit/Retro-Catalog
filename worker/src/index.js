/**
 * Retro catalog submission API (Cloudflare Worker).
 *
 * Routes:
 *   GET  /api/health
 *   GET  /auth/login
 *   GET  /auth/callback
 *   GET  /auth/me
 *   POST /auth/logout
 *   POST /api/probe
 *   POST /api/submit
 */

import PLATFORM_DEFAULTS from "../../submit/platform-defaults.json";

const SESSION_COOKIE = "retcomm_submit_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 7;

/* ── Platform registry ───────────────────────────────────────── */

/**
 * One registry for form and API: submit/platform-defaults.json is bundled
 * into the Worker at deploy, so the picker, the validator, and the probe
 * cannot disagree about which platforms exist or where their titles live.
 */
function platformRegistry() {
  const out = {};
  for (const [k, v] of Object.entries(PLATFORM_DEFAULTS || {})) {
    if (k.startsWith("_") || !v || typeof v !== "object") continue;
    out[k] = v;
  }
  return out;
}

function platformInfo(platform) {
  return platformRegistry()[String(platform || "").trim()] || null;
}

function knownPlatforms() {
  return Object.keys(platformRegistry());
}

/** titles/<platform>/<id>.json — the folder is the platform slug. */
function catalogTitlePath(platform, id) {
  const dir = platformInfo(platform)?.catalog_dir || `titles/${platform}`;
  return `${dir}/${id}.json`;
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      console.error(err);
      const status = Number(err.status) || 500;
      return json({ error: err.message || "Internal error" }, status, request, env);
    }
  },
};

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";

  if (request.method === "OPTIONS") {
    return cors(new Response(null, { status: 204 }), request, env);
  }

  if (path === "/api/health" && request.method === "GET") {
    return json({ ok: true }, 200, request, env);
  }

  if (path === "/auth/login" && request.method === "GET") {
    return startLogin(url, env, request);
  }
  if (path === "/auth/callback" && request.method === "GET") {
    return finishLogin(url, env, request);
  }
  if (path === "/auth/me" && request.method === "GET") {
    return me(request, env);
  }
  if (path === "/auth/logout" && request.method === "POST") {
    return logout(request, env);
  }
  if (path === "/api/probe" && request.method === "POST") {
    return probe(request, env);
  }
  if (path === "/api/submit" && request.method === "POST") {
    return submit(request, env);
  }

  return json({ error: "Not found" }, 404, request, env);
}

/* ── CORS / JSON ─────────────────────────────────────────────── */

function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  const pages = (env.PAGES_ORIGIN || "").replace(/\/$/, "");
  const extras = (env.EXTRA_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allow = new Set([
    pages,
    `${pages}/Retro-Catalog`,
    "http://localhost:8787",
    "http://127.0.0.1:8787",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "http://localhost:4173",
    ...extras,
  ]);
  if (origin && allow.has(origin)) return origin;
  // GitHub project Pages path origins are just the host; allow host match.
  if (origin && pages && origin === pages) return origin;
  if (origin.endsWith(".github.io") && pages && origin === pages) return origin;
  return pages || origin || "*";
}

function cors(res, request, env) {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", allowedOrigin(request, env));
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  headers.set("Vary", "Origin");
  return new Response(res.body, { status: res.status, headers });
}

function json(body, status, request, env, extraHeaders = {}) {
  return cors(
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        ...extraHeaders,
      },
    }),
    request,
    env
  );
}

/* ── Session (HMAC-signed) ───────────────────────────────────── */

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function b64url(bytes) {
  let bin = "";
  const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj) {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

function fromB64url(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function signSession(payload, env) {
  const body = b64urlJson(payload);
  const key = await hmacKey(env.SESSION_SECRET);
  const sig = b64url(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
  );
  return `${body}.${sig}`;
}

async function verifySession(token, env) {
  if (!token || !env.SESSION_SECRET) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const key = await hmacKey(env.SESSION_SECRET);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    fromB64url(sig),
    new TextEncoder().encode(body)
  );
  if (!ok) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function cookieAttrs(request) {
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  // Cross-site Pages → Worker needs SameSite=None; Secure. Local wrangler uses Lax.
  const parts = [
    "Path=/",
    "HttpOnly",
    secure ? "SameSite=None" : "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SEC}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function setSessionCookie(token, env, request) {
  return `${SESSION_COOKIE}=${token}; ${cookieAttrs(request)}`;
}

function clearSessionCookie(env, request) {
  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  const parts = ["Path=/", "HttpOnly", "Max-Age=0"];
  parts.push(secure ? "SameSite=None" : "SameSite=Lax");
  if (secure) parts.push("Secure");
  return `${SESSION_COOKIE}=; ${parts.join("; ")}`;
}

function readCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

/** Prefer Authorization Bearer (GitHub Pages ↔ Worker); cookie is legacy fallback. */
function readSessionToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(\S+)/i);
  if (m) return m[1];
  return readCookie(request, SESSION_COOKIE);
}

async function requireUser(request, env) {
  const session = await verifySession(readSessionToken(request), env);
  if (!session?.login) {
    const err = new Error("GitHub login required");
    err.status = 401;
    throw err;
  }
  return session;
}

/* ── Auth ────────────────────────────────────────────────────── */

function pagesReturnUrl(env, next) {
  const base = (env.PAGES_ORIGIN || "").replace(/\/$/, "");
  const path = env.PAGES_PATH || "/Retro-Catalog/submit/";
  const url = new URL(path, base + "/");
  if (next) url.searchParams.set("next", next);
  return url.toString();
}

async function startLogin(url, env, request) {
  if (!env.GITHUB_CLIENT_ID) {
    return json({ error: "GITHUB_CLIENT_ID not configured" }, 500, request, env);
  }
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const returnTo = url.searchParams.get("return_to") || pagesReturnUrl(env);
  const statePayload = await signSession(
    {
      state,
      return_to: returnTo,
      exp: Math.floor(Date.now() / 1000) + 600,
    },
    env
  );

  const gh = new URL("https://github.com/login/oauth/authorize");
  gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  gh.searchParams.set(
    "redirect_uri",
    `${url.origin}/auth/callback`
  );
  gh.searchParams.set("scope", "read:user");
  gh.searchParams.set("state", statePayload);

  return cors(
    new Response(null, {
      status: 302,
      headers: { Location: gh.toString() },
    }),
    request,
    env
  );
}

async function finishLogin(url, env, request) {
  const code = url.searchParams.get("code");
  const stateTok = url.searchParams.get("state");
  const state = await verifySession(stateTok, env);
  if (!code || !state?.state) {
    return json({ error: "Invalid OAuth state" }, 400, request, env);
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/auth/callback`,
    }),
  });
  const tokenJson = await tokenRes.json();
  if (!tokenJson.access_token) {
    return json(
      { error: "OAuth token exchange failed", detail: tokenJson },
      400,
      request,
      env
    );
  }

  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tokenJson.access_token}`,
      "User-Agent": "retcomm-catalog-submit",
    },
  });
  if (!userRes.ok) {
    return json({ error: "Failed to load GitHub user" }, 400, request, env);
  }
  const user = await userRes.json();
  const login = String(user.login || "");

  if (await isBanned(login, env)) {
    const dest = new URL(state.return_to || pagesReturnUrl(env));
    dest.searchParams.set("error", "banned");
    return cors(
      new Response(null, { status: 302, headers: { Location: dest.toString() } }),
      request,
      env
    );
  }

  const session = await signSession(
    {
      login,
      id: user.id,
      name: user.name || login,
      avatar: user.avatar_url || "",
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC,
    },
    env
  );

  // Return token in the URL hash so GitHub Pages can store it in sessionStorage.
  // Cross-site cookies (github.io → workers.dev) are blocked by modern browsers.
  const dest = new URL(state.return_to || pagesReturnUrl(env));
  dest.searchParams.set("logged_in", "1");
  dest.hash = "session=" + encodeURIComponent(session);

  return cors(
    new Response(null, {
      status: 302,
      headers: {
        Location: dest.toString(),
        // Best-effort cookie for same-site / local testing; Pages uses Bearer.
        "Set-Cookie": setSessionCookie(session, env, request),
      },
    }),
    request,
    env
  );
}

async function me(request, env) {
  const session = await verifySession(readSessionToken(request), env);
  if (!session?.login) {
    return json({ user: null }, 200, request, env);
  }
  if (await isBanned(session.login, env)) {
    return json({ user: null, error: "banned" }, 200, request, env, {
      "Set-Cookie": clearSessionCookie(env, request),
    });
  }
  return json(
    {
      user: {
        login: session.login,
        name: session.name,
        avatar: session.avatar,
      },
    },
    200,
    request,
    env
  );
}

async function logout(request, env) {
  return json({ ok: true }, 200, request, env, {
    "Set-Cookie": clearSessionCookie(env, request),
  });
}

/* ── Ban list ────────────────────────────────────────────────── */

async function isBanned(login, env) {
  const needle = String(login || "").toLowerCase();
  if (!needle) return true;

  const fromEnv = (env.BANNED_USERS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (fromEnv.includes(needle)) return true;

  const url = env.BANNED_USERS_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "retcomm-catalog-submit", Accept: "application/json" },
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    if (!res.ok) return false;
    const data = await res.json();
    const users = (data.users || []).map((u) => String(u).toLowerCase());
    return users.includes(needle);
  } catch {
    return false;
  }
}

/* ── Probe GitHub repo ───────────────────────────────────────── */

function parseRepoSlug(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  let slug = raw;
  const m = raw.match(
    /github\.com[/:]([^/]+)\/([^/#?]+)/i
  );
  if (m) slug = `${m[1]}/${m[2]}`;
  slug = slug.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) return null;
  return slug;
}

function guessPlatform(text) {
  const t = text.toLowerCase();
  if (/\b(snes|super.?nintendo|snesrecomp)\b/.test(t)) return "snes";
  if (/\b(gba|game.?boy.?advance|gbarecomp)\b/.test(t)) return "gba";
  if (/\b(psx|playstation|ps1|psxrecomp)\b/.test(t)) return "psx";
  if (/\b(n64|nintendo.?64)\b/.test(t)) return "n64";
  if (/\b(genesis|megadrive|sega.?genesis|segagenesis)\b/.test(t)) {
    return "genesis";
  }
  return "";
}

function slugifyId(name, platform) {
  let s = String(name || "")
    .replace(/Recomp$/i, "")
    .replace(/Decomp$/i, "")
    // MegaManXSNESRecomp → mega-man-x-snes, not mega-man-xsnes-snes.
    .replace(/(SNES|PSX|PS1|GBA|N64|Genesis)$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  if (platform && !s.endsWith(`-${platform}`)) s = `${s}-${platform}`;
  return s;
}

function displayNameFromRepo(repoName) {
  return String(repoName || "")
    .replace(/Recomp$/i, "")
    .replace(/Decomp$/i, "")
    // MetalWarriorsSNESRecomp → "Metal Warriors", not "Metal Warriors SNES".
    .replace(/(SNES|PSX|PS1|GBA|N64|Genesis)$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

function extractDigests(text) {
  const out = {
    crc32: new Set(),
    md5: new Set(),
    sha1: new Set(),
    sha256: new Set(),
    disc_serials: new Set(),
    sizes: new Set(),
    filenames: new Set(),
    sources: [],
  };
  if (!text) return out;

  const lower = text;

  // Labeled digests. `|` covers README tables ("| CRC32 | `0xf2ab92d4` |"),
  // which SNES ports use for their Expected ROM block.
  const labeled = [
    [/sha-?256\s*[:=|]\s*`?([a-f0-9]{64})`?/gi, "sha256"],
    [/sha-?1\s*[:=|]\s*`?([a-f0-9]{40})`?/gi, "sha1"],
    [/md5\s*[:=|]\s*`?([a-f0-9]{32})`?/gi, "md5"],
    [/crc-?32\s*[:=|]\s*`?(0x)?([a-f0-9]{8})`?/gi, "crc32"],
  ];
  for (const [re, key] of labeled) {
    let m;
    const r = new RegExp(re.source, re.flags);
    while ((m = r.exec(lower))) {
      const hex = (m[2] || m[1] || "").toLowerCase().replace(/^0x/, "");
      if (hex) out[key].add(hex);
    }
  }

  // Markdown tables / bare hex near baserom context
  if (/baserom|rom.?identity|expected|checksum|hash/i.test(text)) {
    for (const m of text.matchAll(/\b([a-fA-F0-9]{64})\b/g)) {
      out.sha256.add(m[1].toLowerCase());
    }
    for (const m of text.matchAll(/\b([a-fA-F0-9]{40})\b/g)) {
      out.sha1.add(m[1].toLowerCase());
    }
    for (const m of text.matchAll(/\b([a-fA-F0-9]{32})\b/g)) {
      out.md5.add(m[1].toLowerCase());
    }
    for (const m of text.matchAll(/\b(?:0x)?([a-fA-F0-9]{8})\b/g)) {
      // skip years / small numbers that look like CRC only near CRC labels already handled
      if (/crc/i.test(text)) out.crc32.add(m[1].toLowerCase());
    }
  }

  for (const m of text.matchAll(
    /\b((?:SLUS|SLES|SLPS|SCUS|SCES|SCPS|SLPM)-?\d{4,5})\b/gi
  )) {
    const serial = m[1].toUpperCase().replace(/^(SLUS|SLES|SLPS|SCUS|SCES|SCPS|SLPM)(\d)/, "$1-$2");
    out.disc_serials.add(serial.includes("-") ? serial : serial.replace(/([A-Z]+)(\d+)/, "$1-$2"));
  }

  for (const m of text.matchAll(
    /[`'"]([A-Za-z0-9][^`'"]+\.(?:sfc|smc|gba|z64|n64|md|gen|bin|cue|car|iso|chd))[`'"]/gi
  )) {
    out.filenames.add(m[1]);
  }

  for (const m of text.matchAll(
    /\b(\d{3,4})\s*MiB\b/gi
  )) {
    out.sizes.add(Number(m[1]) * 1024 * 1024);
  }
  for (const m of text.matchAll(
    /\b(\d{6,})\s*(?:bytes|byte)\b/gi
  )) {
    out.sizes.add(Number(m[1]));
  }

  return out;
}

function mergeDigestSets(...parts) {
  const keys = [
    "crc32",
    "md5",
    "sha1",
    "sha256",
    "disc_serials",
    "sizes",
    "filenames",
  ];
  const out = Object.fromEntries(keys.map((k) => [k, []]));
  const sources = [];
  for (const p of parts) {
    if (!p) continue;
    if (p.sources) sources.push(...p.sources);
    for (const k of keys) {
      const vals = p[k];
      if (!vals) continue;
      const iter = vals instanceof Set ? vals : vals;
      for (const v of iter) {
        if (!out[k].includes(v)) out[k].push(v);
      }
    }
  }
  out.sources = sources;
  return out;
}

function inferAssetGlobs(assetNames) {
  const globs = { linux: "", windows: "", macos: "" };
  const names = assetNames || [];
  const first = (re) => names.find((n) => re.test(n)) || "";

  const win = first(/windows|win64|win-?x64|win_x64|win32|(?:^|[^a-z])win(?:[^a-z]|$)/i);
  if (win) {
    if (/windows/i.test(win)) globs.windows = "*windows*";
    else if (/win-?x64|win_x64/i.test(win)) globs.windows = "*win*x64*";
    else if (/win64/i.test(win)) globs.windows = "*win64*";
    else if (/win32/i.test(win)) globs.windows = "*win32*";
    else globs.windows = "*-win*"; // hyphenated token; avoid bare *win* (matches "wine")
  }

  const lin = first(/linux|appimage/i);
  if (lin) {
    if (/appimage/i.test(lin)) globs.linux = "*appimage*";
    else globs.linux = "*linux*";
  }

  const mac = first(/macos|osx|darwin|(?:^|[^a-z])mac(?:[^a-z]|$)/i);
  if (mac) {
    if (/darwin/i.test(mac)) globs.macos = "*darwin*";
    else if (/osx/i.test(mac)) globs.macos = "*osx*";
    else if (/macos/i.test(mac)) globs.macos = "*macos*";
    else globs.macos = "*mac*";
  }

  // Do not invent globs for OSes with no matching assets (Windows-only releases).
  return globs;
}

/** CMake string(MAKE_C_IDENTIFIER …) for WINDOW_TITLE → OUTPUT_NAME. */
function cmakeMakeCIdentifier(title) {
  let s = String(title || "").replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(s)) s = `_${s}`;
  return s;
}

function isJunkLaunchName(name) {
  const base = String(name || "").split(/[/\\]/).pop() || "";
  const lower = base.toLowerCase();
  if (!base || base.startsWith(".")) return true;
  if (
    [
      "license",
      "makefile",
      "readme",
      "version",
      "vagrantfile",
      "cmakeLists.txt",
      "ctors",
      "asm64",
      "hello_32",
      "uninstall.exe",
    ].includes(lower)
  )
    return true;
  if (lower.startsWith("crash-")) return true;
  if (/\.(md|txt|json|toml|cmake|in|yml|yaml)$/i.test(base)) return true;
  return false;
}

function isLikelyRomFilename(name) {
  const base = String(name || "").split(/[/\\]/).pop() || "";
  if (!base || /[/\\]/.test(String(name || ""))) return false;
  const lower = base.toLowerCase();
  if (/\.(md|txt|json|toml|cmake|yml|yaml|c|h|cpp|hpp)$/i.test(base)) return false;
  if (/^scph\d+/i.test(base) || lower === "bios.bin" || lower === "gba_bios.bin")
    return false;
  if (lower === "disc.md" || lower === "issues.md" || lower === "readme.md") return false;
  // Genesis dumps use .md — require a game-like basename so markdown files stay out.
  if (lower.endsWith(".md")) {
    return /\(|usa|eur|jpn|japan|europe|sonic|genesis/i.test(base);
  }
  return /\.(sfc|smc|gba|z64|n64|v64|gen|bin|cue|car|iso|chd|nds)$/i.test(base);
}

function scoreLaunchCandidate(name, { wantExe = false } = {}) {
  const base = String(name || "").split(/[/\\]/).pop() || "";
  if (isJunkLaunchName(base)) return -100;
  // Prefer archive root entries (no nested path).
  if (String(name).includes("/")) return -50;
  const lower = base.toLowerCase();
  const isExe = lower.endsWith(".exe");
  if (wantExe && !isExe) return -40;
  if (!wantExe && isExe) return -40;
  if (!wantExe && base.includes(".")) return -20;
  let score = 10;
  if (/recompiled/i.test(base)) score += 50;
  if (/recomp$/i.test(base.replace(/\.exe$/i, ""))) score += 5;
  return score;
}

function pickBestLaunchName(names, { wantExe = false } = {}) {
  let best = "";
  let bestScore = 0;
  for (const n of names || []) {
    const base = String(n).split(/[/\\]/).pop() || "";
    const score = scoreLaunchCandidate(base, { wantExe });
    if (score > bestScore) {
      bestScore = score;
      best = base;
    }
  }
  return bestScore >= 40 ? best : bestScore >= 10 && (names || []).length === 1 ? best : "";
}

/**
 * The game executable target from a snesrecomp-style CMakeLists.txt:
 * `add_executable(MetalWarriorsSNESRecomp …)`. Test helpers and `${VAR}`
 * targets are skipped; `project(Name …)` is the fallback.
 */
function inferCmakeExecutableTarget(cmakeText) {
  if (!cmakeText) return "";
  for (const m of cmakeText.matchAll(/\badd_executable\s*\(\s*([^\s)]+)/gi)) {
    const name = m[1];
    if (name.startsWith("$")) continue;
    if (/test|bench|tool|helper/i.test(name)) continue;
    return name;
  }
  const proj = cmakeText.match(/\bproject\s*\(\s*([A-Za-z0-9_.-]+)/i);
  return proj?.[1] || "";
}

function inferLaunchFromCmake(cmakeText) {
  if (!cmakeText) return "";
  const exe = cmakeText.match(/\bEXE_NAME\s+"([^"]+)"/i);
  if (exe?.[1]) return cmakeMakeCIdentifier(exe[1]);
  const win = cmakeText.match(/\bWINDOW_TITLE\s+"([^"]+)"/i);
  if (win?.[1]) return cmakeMakeCIdentifier(win[1]);
  // psxrecomp declares the runtime via psxrecomp_add_game_runtime(); a bare
  // add_executable is the snesrecomp convention, where the target IS the binary.
  const target = inferCmakeExecutableTarget(cmakeText);
  if (target && !/^psx-runtime$/i.test(target)) return target;
  return "";
}

function inferLaunchFromPackageScript(text) {
  if (!text) return "";
  const m = text.match(/--exe-name\s+(\S+)/i);
  if (m?.[1]) return m[1].replace(/^["']|["']$/g, "");
  // snesrecomp ports: scripts/package_release.sh sets EXE_NAME="…".
  const exe = text.match(/^\s*EXE_NAME\s*=\s*["']?([A-Za-z0-9._-]+)["']?/im);
  return exe?.[1] || "";
}

/**
 * rom_identity.txt — the StarFox-style `key = value` file some SNES ports
 * treat as their single source of truth (CMake, regen.sh, and CI read it).
 */
function parseRomIdentityTxt(text) {
  const out = {
    ok: false,
    crc32: [],
    md5: [],
    sha1: [],
    sha256: [],
    filenames: [],
    display_name: "",
  };
  if (!text || typeof text !== "string") return out;
  const kv = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    kv[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  if (!Object.keys(kv).length) return out;
  out.ok = true;
  const hex = (v, len) => {
    const s = String(v || "").toLowerCase().replace(/^0x/, "");
    return new RegExp(`^[a-f0-9]{${len}}$`).test(s) ? s : "";
  };
  const crc = hex(kv.expected_crc32 || kv.crc32, 8);
  const md5 = hex(kv.expected_md5 || kv.md5, 32);
  const sha1 = hex(kv.expected_sha1 || kv.sha1, 40);
  const sha256 = hex(kv.expected_sha256 || kv.sha256, 64);
  if (crc) out.crc32.push(crc);
  if (md5) out.md5.push(md5);
  if (sha1) out.sha1.push(sha1);
  if (sha256) out.sha256.push(sha256);
  if (kv.rom_file) out.filenames.push(kv.rom_file);
  if (kv.display_name) out.display_name = kv.display_name;
  return out;
}

/**
 * tools/regen.sh — snesrecomp ports pin the expected digests and the
 * generate arguments here. `EXPECTED_CRC32="${SNESRECOMP_EXPECTED_CRC32:-f2ab92d4}"`,
 * `for cand in "Metal Warriors (USA).sfc" …`, `--cfg-dir recomp --out-dir src/gen`.
 */
function parseRegenScript(text) {
  const out = {
    ok: false,
    crc32: [],
    sha256: [],
    filenames: [],
    cfg_dir: "",
    out_dir: "",
    funcs_h: "",
    cfg_roots: false,
  };
  if (!text || typeof text !== "string") return out;
  out.ok = /snesrecomp_cli|generate/i.test(text);
  const grab = (key, len) => {
    const m = text.match(
      new RegExp(`${key}\\s*=\\s*["']?(?:\\$\\{[A-Z0-9_]+:-)?([a-fA-F0-9]{${len}})["'}]?`, "i")
    );
    return m ? m[1].toLowerCase() : "";
  };
  const crc = grab("EXPECTED_CRC32", 8);
  const sha = grab("EXPECTED_SHA256", 64);
  if (crc) out.crc32.push(crc);
  if (sha) out.sha256.push(sha);
  for (const m of text.matchAll(/"([^"]+\.(?:sfc|smc|fig|swc))"/gi)) {
    if (!out.filenames.includes(m[1])) out.filenames.push(m[1]);
  }
  const arg = (flag) => {
    const m = text.match(new RegExp(`${flag}\\s+["']?([^\\s"']+)`, "i"));
    // A shell variable ("$cfg_dir") is not a path we can put in the catalog.
    return m && !m[1].startsWith("$") ? m[1] : "";
  };
  out.cfg_dir = arg("--cfg-dir");
  out.out_dir = arg("--out-dir");
  out.funcs_h = arg("--funcs-h");
  out.cfg_roots = /--cfg-roots/.test(text);
  return out;
}

function inferLaunchFromReadmeSetup(text) {
  if (!text) return "";
  // "2. Run TwistedMetal4_Recompiled." / "Run `Bomberman_Party_Edition_Recompiled`."
  const m =
    text.match(/^\s*\d+\.\s*Run\s+`?([A-Za-z0-9][A-Za-z0-9._-]*)`?/im) ||
    text.match(/\bRun\s+`([A-Za-z0-9][A-Za-z0-9._-]*)`/i);
  return m?.[1] && !isJunkLaunchName(m[1]) ? m[1] : "";
}

/** Guess OUTPUT_NAME when only the repo folder is known (psxrecomp convention). */
function inferLaunchFromRepoName(repoName) {
  const base = String(repoName || "").replace(/[^A-Za-z0-9._-]/g, "");
  if (!base) return "";
  // TwistedMetal4Recomp → TwistedMetal4_Recompiled
  const stripped = base.replace(/Recomp$/i, "").replace(/Decomp$/i, "");
  if (stripped && stripped !== base) {
    return `${stripped}_Recompiled`;
  }
  return base;
}

/**
 * Read top-level ZIP entry names via a Range fetch of the central directory.
 * Falls back quietly when the CDN rejects Range or the archive is huge.
 */
async function listZipTopLevelNames(downloadUrl, env) {
  if (!downloadUrl) return [];
  try {
    const headers = {
      "User-Agent": "retcomm-catalog-submit",
      Range: "bytes=-262144",
    };
    if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
    const res = await fetch(downloadUrl, { headers, redirect: "follow" });
    if (!(res.ok || res.status === 206)) return [];
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length < 22) return [];

    // EOCD signature 0x06054b50
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
      if (
        buf[i] === 0x50 &&
        buf[i + 1] === 0x4b &&
        buf[i + 2] === 0x05 &&
        buf[i + 3] === 0x06
      ) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return [];
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const cdSize = view.getUint32(eocd + 12, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    const totalSize = cdOffset + cdSize + (buf.length - eocd);
    // If our window does not include the full CD, re-fetch exactly.
    let cd = buf;
    let cdStartInBuf = eocd - cdSize;
    if (cdStartInBuf < 0 || cdSize > buf.length) {
      const from = Math.max(0, totalSize - cdSize - 256);
      const exact = await fetch(downloadUrl, {
        headers: {
          ...headers,
          Range: `bytes=${from}-${totalSize - 1}`,
        },
        redirect: "follow",
      });
      if (!(exact.ok || exact.status === 206)) return [];
      cd = new Uint8Array(await exact.arrayBuffer());
      // locate EOCD again
      eocd = -1;
      for (let i = cd.length - 22; i >= 0; i--) {
        if (
          cd[i] === 0x50 &&
          cd[i + 1] === 0x4b &&
          cd[i + 2] === 0x05 &&
          cd[i + 3] === 0x06
        ) {
          eocd = i;
          break;
        }
      }
      if (eocd < 0) return [];
      cdStartInBuf = eocd - cdSize;
      if (cdStartInBuf < 0) return [];
    }

    const names = [];
    let p = cdStartInBuf;
    const cdView = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    while (p + 46 <= eocd) {
      if (
        cd[p] !== 0x50 ||
        cd[p + 1] !== 0x4b ||
        cd[p + 2] !== 0x01 ||
        cd[p + 3] !== 0x02
      )
        break;
      const nameLen = cdView.getUint16(p + 28, true);
      const extraLen = cdView.getUint16(p + 30, true);
      const commentLen = cdView.getUint16(p + 32, true);
      const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
      const name = new TextDecoder("utf-8", { fatal: false }).decode(nameBytes);
      if (name && !name.endsWith("/")) names.push(name.replace(/\\/g, "/"));
      p += 46 + nameLen + extraLen + commentLen;
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * Release zips often wrap everything in one "<slug>-<ver>-<os>/" folder, so
 * every entry carries that prefix and pickBestLaunchName sees no root-level
 * binary. Peel the wrapper (repeatedly) when ALL entries share it.
 */
function stripZipWrapperDir(names) {
  let out = (names || []).slice();
  for (let depth = 0; depth < 4 && out.length; depth++) {
    const first = out[0].split("/")[0];
    if (!first || !out.every((n) => n.startsWith(`${first}/`))) break;
    out = out.map((n) => n.slice(first.length + 1)).filter(Boolean);
  }
  return out;
}

function assetMatchesGlob(name, glob) {
  if (!glob) return false;
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i").test(name);
}

async function inferLaunch(repoName, assetGlobs, opts = {}) {
  const {
    cmakeText = "",
    packageScript = "",
    readmeSetup = "",
    releaseAssets = [],
    env = {},
  } = opts;

  let source = "guessed";
  let base =
    inferLaunchFromPackageScript(packageScript) ||
    inferLaunchFromCmake(cmakeText) ||
    inferLaunchFromReadmeSetup(readmeSetup);

  if (base) {
    source = packageScript && inferLaunchFromPackageScript(packageScript)
      ? "package script"
      : cmakeText && inferLaunchFromCmake(cmakeText)
        ? "cmake WINDOW_TITLE"
        : "README-SETUP";
  }

  // Prefer a real top-level binary from the linux (then windows) release zip.
  const pickAsset = (glob) =>
    (releaseAssets || []).find((a) => assetMatchesGlob(a.name, glob));
  for (const [osKey, wantExe] of [
    ["linux", false],
    ["windows", true],
    ["macos", false],
  ]) {
    const glob = assetGlobs[osKey];
    if (!glob) continue;
    const asset = pickAsset(glob);
    if (!asset?.browser_download_url) continue;
    const names = stripZipWrapperDir(
      await listZipTopLevelNames(asset.browser_download_url, env)
    );
    // snesrecomp ports name the exe after the CMake project, which is the repo
    // name (GundamWingEndlessDuelSNESRecomp). That form scores below the
    // *_Recompiled threshold in pickBestLaunchName, so match it explicitly.
    const repoLower = String(repoName || "").toLowerCase();
    const exact = names.find(
      (n) => !n.includes("/") && n.replace(/\.exe$/i, "").toLowerCase() === repoLower
    );
    const hit = exact || pickBestLaunchName(names, { wantExe });
    if (hit) {
      base = hit.replace(/\.exe$/i, "");
      source = `release zip (${osKey})`;
      break;
    }
  }

  if (!base) {
    base = inferLaunchFromRepoName(repoName);
    source = "repo name → *_Recompiled";
  }

  const stem = String(base).replace(/\.exe$/i, "");
  return {
    launch: {
      linux: assetGlobs.linux ? stem : "",
      windows: assetGlobs.windows ? `${stem}.exe` : "",
      macos: assetGlobs.macos ? stem : "",
    },
    source,
  };
}

async function ghApi(path, env, opts = {}) {
  const { anon = false, ...init } = opts;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "retcomm-catalog-submit",
    ...(opts.headers || {}),
  };
  if (env.GITHUB_TOKEN && !anon) {
    headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  }
  const res = await fetch(`https://api.github.com${path}`, { ...init, headers });
  return res;
}

/**
 * Read a repo we do not control (a submitter's game repo).
 *
 * GITHUB_TOKEN is a fine-grained PAT scoped to the catalog repo, and such a
 * token returns 404 for every repo outside its selection — public repos
 * included. An expired token (401) and a rate-limited one (403) look the same
 * from here. So a failure under the token is not evidence about the repo; retry
 * anonymously, which is all a public repo ever needed.
 */
async function ghApiForeign(path, env, opts = {}) {
  const res = await ghApi(path, env, opts);
  if (res.ok || !env.GITHUB_TOKEN) return res;
  if (res.status !== 401 && res.status !== 403 && res.status !== 404) return res;
  return ghApi(path, env, { ...opts, anon: true });
}

/** Create catalog submission labels if missing (idempotent; ignores 422 exists). */
async function ensureSubmissionLabels(env, catalogRepo) {
  const labels = [
    {
      name: "catalog-submission",
      color: "5319E7",
      description: "New title submission from the catalog form",
    },
    {
      name: "approved",
      color: "0E8A16",
      description: "Approve submission: merge title and publish catalog.zip",
    },
    {
      name: "approved-update",
      color: "1D76DB",
      description: "Approve and overwrite an existing titles/<platform>/<id>.json",
    },
  ];
  for (const label of labels) {
    const res = await ghApi(`/repos/${catalogRepo}/labels`, env, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(label),
    });
    if (res.ok || res.status === 422) {
      // 422 = already exists
      continue;
    }
    // Best-effort: token may lack label-admin; form can still work if labels exist.
    await res.text().catch(() => {});
  }
}

async function addIssueLabel(env, catalogRepo, issueNumber, labelName) {
  const res = await ghApi(
    `/repos/${catalogRepo}/issues/${issueNumber}/labels`,
    env,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: [labelName] }),
    }
  );
  return res.ok;
}

async function fetchRepoText(slug, path, env) {
  const res = await ghApiForeign(
    `/repos/${slug}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
    env
  );
  if (!res.ok) return null;
  const data = await res.json();
  if (data.encoding === "base64" && data.content) {
    try {
      return atob(data.content.replace(/\n/g, ""));
    } catch {
      return null;
    }
  }
  if (data.download_url) {
    const t = await fetch(data.download_url, {
      headers: { "User-Agent": "retcomm-catalog-submit" },
    });
    if (t.ok) return await t.text();
  }
  return null;
}

function tomlSection(text, name) {
  const re = new RegExp(
    `\\[${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]([^\\[]*)`,
    "i"
  );
  const m = text.match(re);
  return m ? m[1] : "";
}

function tomlString(section, key) {
  const m = section.match(
    new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`, "im")
  );
  return m ? m[1] : "";
}

function tomlInt(section, key) {
  const m = section.match(new RegExp(`^\\s*${key}\\s*=\\s*(-?\\d+)`, "im"));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Strip trailing " Recompiled" / similar from WINDOW_TITLE for lobby game_name. */
function netplayNameFromWindowTitle(title) {
  let s = String(title || "").trim();
  if (!s) return "";
  s = s.replace(/\s+Recompiled\s*$/i, "").replace(/\s+Recomp\s*$/i, "").trim();
  return s;
}

/** Pull [netplay] / [prepare_disc] / [game] / [runtime] from game.toml. */
function extractGameTomlDisc(text) {
  const out = {
    track_counts: [],
    require_cue: false,
    md5: [],
    sha1: [],
    sizes: [],
    filenames: [],
    disc_serials: [],
    players: null,
    game_name: "",
    window_title: "",
    has_netplay_section: false,
    sources: [],
  };
  if (!text || typeof text !== "string") return out;

  const np = tomlSection(text, "netplay");
  if (np) {
    out.has_netplay_section = true;
    const tr = np.match(/required_tracks\s*=\s*(\d+)/i);
    if (tr) {
      const n = Number(tr[1]);
      if (Number.isFinite(n) && n >= 1) out.track_counts.push(n);
    }
    if (/require_cue\s*=\s*true/i.test(np)) out.require_cue = true;
    if (out.track_counts.some((n) => n > 1)) out.require_cue = true;
    if (out.track_counts.length || out.require_cue) out.sources.push("game.toml[netplay]");
  }

  const pd = tomlSection(text, "prepare_disc");
  if (pd) {
    const arr = (key) => {
      const m = pd.match(new RegExp(`${key}\\s*=\\s*\\[([^\\]]*)\\]`, "i"));
      if (!m) return [];
      return m[1]
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    };
    out.md5.push(...arr("known_md5").map((s) => s.toLowerCase()));
    out.sha1.push(...arr("known_sha1").map((s) => s.toLowerCase()));
    out.sizes.push(
      ...arr("known_sizes")
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n) && n > 0)
    );
    const cue = pd.match(/cue_name\s*=\s*["']([^"']+)["']/i);
    if (cue) out.filenames.push(cue[1]);
    if (out.md5.length || out.sha1.length || out.sizes.length || out.filenames.length)
      out.sources.push("game.toml[prepare_disc]");
  }

  const game = tomlSection(text, "game");
  if (game) {
    const id = tomlString(game, "id");
    if (id) out.disc_serials.push(id);
    const name = tomlString(game, "name");
    if (name) out.game_name = name;
    const players = tomlInt(game, "players");
    if (players != null && players >= 1) out.players = players;
    const disc = tomlString(game, "disc");
    if (disc && /\.cue$/i.test(disc)) {
      const base = disc.split(/[/\\]/).pop();
      if (base && !out.filenames.includes(base)) out.filenames.push(base);
    }
  }

  const runtime = tomlSection(text, "runtime");
  if (runtime) {
    const wt = tomlString(runtime, "window_title");
    if (wt) out.window_title = wt;
  }

  return out;
}

/** Parse setup-wizard catalog_identity.json (marketing + digests). */
function parseCatalogIdentity(text) {
  const out = {
    description: "",
    publisher: "",
    year: "",
    region: "",
    players: null,
    game_name: "",
    crc32: [],
    md5: [],
    sha1: [],
    sha256: [],
    sizes: [],
    filenames: [],
    track_counts: [],
    require_cue: false,
    disc_serials: [],
    ok: false,
  };
  if (!text || typeof text !== "string") return out;
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return out;
  }
  if (!j || typeof j !== "object") return out;
  out.ok = true;
  const m = j.marketing || {};
  out.description = String(m.description || "").trim();
  out.publisher = String(m.publisher || "").trim();
  out.year = String(m.year || "").trim();
  out.region = String(m.region || "").trim();
  if (Number.isFinite(Number(m.players)) && Number(m.players) >= 1)
    out.players = Number(m.players);
  if (j.game?.name) out.game_name = String(j.game.name).trim();
  if (j.game?.id) out.disc_serials.push(String(j.game.id).trim());
  const ri = j.rom_identity || {};
  if (ri.cue_name) out.filenames.push(String(ri.cue_name));
  if (ri.bin_name) out.filenames.push(String(ri.bin_name));
  if (Array.isArray(ri.track_counts)) {
    out.track_counts = ri.track_counts
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1);
  }
  out.require_cue = !!ri.require_cue || out.track_counts.some((n) => n > 1);
  const dt = ri.data_track || {};
  // Read every digest the probe tool writes. crc32 was previously dropped here,
  // so titles that publish it still showed an empty crc32 on the form.
  if (dt.crc32) out.crc32.push(String(dt.crc32).toLowerCase());
  if (dt.md5) out.md5.push(String(dt.md5).toLowerCase());
  if (dt.sha1) out.sha1.push(String(dt.sha1).toLowerCase());
  if (dt.sha256) out.sha256.push(String(dt.sha256).toLowerCase());
  if (Number.isFinite(Number(dt.size)) && Number(dt.size) > 0)
    out.sizes.push(Number(dt.size));
  return out;
}

/**
 * Per-disc identity for a multi-disc title.
 *
 * `disc_set.json` (written by verify_disc_set.py) names the discs and their
 * serials; `disc_probe.json` / `disc_probe.<N>.json` carry each disc's
 * data-track digests. Disc 1 lives in `disc_probe.json` — there is no
 * `disc_probe.1.json`.
 */
function discProbeFileName(index) {
  return index <= 1 ? "disc_probe.json" : `disc_probe.${index}.json`;
}

/** Shape of one entry in rom_identity.discs[]. */
function emptyDisc(index) {
  return {
    index,
    serial: "",
    cue_name: "",
    bin_name: "",
    crc32: [],
    md5: [],
    sha1: [],
    sha256: [],
    sizes: [],
    track_counts: [],
  };
}

/** disc_set.json → ordered disc stubs (no digests yet). */
function parseDiscSet(text) {
  const out = { ok: false, disc_count: 0, discs: [], warnings: [] };
  if (!text || typeof text !== "string") return out;
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return out;
  }
  if (!j || typeof j !== "object" || !Array.isArray(j.discs)) return out;
  out.ok = true;
  if (Array.isArray(j.warnings)) out.warnings = j.warnings.map(String);

  j.discs.forEach((d, i) => {
    const index = Number.isInteger(Number(d?.index)) ? Number(d.index) : i + 1;
    const disc = emptyDisc(index);
    if (d?.serial) disc.serial = String(d.serial).trim();
    if (d?.cue_name) disc.cue_name = String(d.cue_name).trim();
    const tc = Number(d?.track_count);
    if (Number.isInteger(tc) && tc >= 1) disc.track_counts.push(tc);
    out.discs.push(disc);
  });
  out.discs.sort((a, b) => a.index - b.index);
  // Trust the disc list, not a disc_count that disagrees with it.
  out.disc_count = out.discs.length;
  const declared = Number(j.disc_count);
  if (Number.isInteger(declared) && declared !== out.discs.length) {
    out.warnings.push(
      `disc_set.json declares disc_count=${declared} but lists ${out.discs.length} discs`
    );
  }
  return out;
}

/** Fold one disc_probe.json into its disc entry (digests are the point). */
function mergeDiscProbe(disc, text) {
  if (!text || typeof text !== "string") return disc;
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return disc;
  }
  if (!j || typeof j !== "object") return disc;
  const push = (arr, v) => {
    const s = String(v || "").trim().toLowerCase();
    if (s && !arr.includes(s)) arr.push(s);
  };
  if (j.data_track_crc32) push(disc.crc32, j.data_track_crc32);
  if (j.data_track_md5) push(disc.md5, j.data_track_md5);
  if (j.data_track_sha1) push(disc.sha1, j.data_track_sha1);
  if (j.data_track_sha256) push(disc.sha256, j.data_track_sha256);
  const size = Number(j.data_track_size);
  if (Number.isFinite(size) && size > 0 && !disc.sizes.includes(size))
    disc.sizes.push(size);
  if (j.cue_name && !disc.cue_name) disc.cue_name = String(j.cue_name).trim();
  if (j.bin_name && !disc.bin_name) disc.bin_name = String(j.bin_name).trim();
  if (j.serial && !disc.serial) disc.serial = String(j.serial).trim();
  const tc = Number(j.track_count);
  if (Number.isInteger(tc) && tc >= 1 && !disc.track_counts.includes(tc))
    disc.track_counts.push(tc);
  return disc;
}

/**
 * Read the whole disc set for a repo: disc_set.json plus one disc_probe per
 * disc. Returns [] when the repo is single-disc or publishes neither file —
 * callers then fall back to the flat single-disc identity.
 */
async function fetchDiscSet(slug, env) {
  const setText = await fetchRepoText(slug, "disc_set.json", env);
  const set = parseDiscSet(setText || "");
  if (!set.ok || set.discs.length < 2) return { discs: [], warnings: set.warnings };

  // Bounded: a PS1 set is at most a handful of discs, and each probe is a
  // separate API read.
  const discs = set.discs.slice(0, 9);
  await Promise.all(
    discs.map(async (disc) => {
      const text = await fetchRepoText(slug, discProbeFileName(disc.index), env);
      mergeDiscProbe(disc, text || "");
    })
  );
  return { discs, warnings: set.warnings };
}

/**
 * Flatten discs[] into the legacy rom_identity arrays.
 *
 * Launchers that predate discs[] match on any single digest, so the flat lists
 * stay a union of every disc — that keeps an old launcher able to bind and
 * launch the set. Disc 1 is emitted first so first-match preference lands on
 * the boot disc rather than mid-game.
 */
function unionDiscIdentity(discs, base) {
  const out = {
    crc32: [...(base?.crc32 || [])],
    md5: [...(base?.md5 || [])],
    sha1: [...(base?.sha1 || [])],
    sha256: [...(base?.sha256 || [])],
    disc_serials: [...(base?.disc_serials || [])],
    sizes: [...(base?.sizes || [])],
    filenames: [...(base?.filenames || [])],
    track_counts: [...(base?.track_counts || [])],
  };
  const add = (arr, v) => {
    if (v == null || v === "") return;
    if (!arr.includes(v)) arr.push(v);
  };
  for (const d of [...discs].sort((a, b) => a.index - b.index)) {
    for (const v of d.crc32) add(out.crc32, v);
    for (const v of d.md5) add(out.md5, v);
    for (const v of d.sha1) add(out.sha1, v);
    for (const v of d.sha256) add(out.sha256, v);
    for (const v of d.sizes) add(out.sizes, v);
    for (const v of d.track_counts) add(out.track_counts, v);
    add(out.disc_serials, d.serial);
    add(out.filenames, d.cue_name);
    add(out.filenames, d.bin_name);
  }
  return out;
}

function detectNetplaySupported(cmakeText, tomlDisc, platform = "") {
  if (cmakeText && platform === "snes") {
    // snesrecomp ports bake SNES_GAME_VERSION for lobby matching; a port
    // without it has no recomp-net wire identity to advertise.
    return /\bSNES_GAME_VERSION\b/.test(cmakeText);
  }
  if (cmakeText) {
    // An explicit opt-out wins over the weak game.toml [netplay] heuristic
    // below: single-player psxrecomp scaffolds still ship a [netplay] disc gate.
    if (/set\s*\(\s*PSX_NETPLAY\s+OFF\b/i.test(cmakeText)) return false;
    if (/\bENABLE_NETPLAY_IF_PRESENT\b/i.test(cmakeText)) return true;
    if (/set\s*\(\s*PSX_NETPLAY\s+ON\b/i.test(cmakeText)) return true;
    if (/PSX_NETPLAY\s+ON\s+CACHE/i.test(cmakeText)) return true;
  }
  // Disc TOC gate without CMake opt-in is weak — still treat as netplay-ready
  // for psxrecomp titles that ship [netplay] required_tracks.
  if (tomlDisc?.has_netplay_section && tomlDisc.track_counts?.length) return true;
  return false;
}

function stripVersionV(tag) {
  let s = String(tag || "").trim();
  if ((s[0] === "v" || s[0] === "V") && s.length > 1 && /\d/.test(s[1]))
    s = s.slice(1);
  return s;
}

function inferPsxBuildRecipe(slug, launchLinux) {
  return {
    enabled: true,
    source: {
      github: slug,
      ref: "main",
    },
    toolchain: {
      id: "cmake-clang-v1",
      github: "RetroPortingToolKit/RetroPorting-Toolchains",
      min_version: "1.0.3",
      asset_glob: {
        linux: "*cmake-clang-v1*linux*",
        windows: "*cmake-clang-v1*windows*",
        macos: "*cmake-clang-v1*macos*",
      },
    },
    generate: {
      engine: "psxrecomp",
      config: "game.toml",
    },
    cmake: {
      build_dir: "build",
      // psxrecomp_add_game_runtime(psx-runtime …); OUTPUT_NAME is launch binary.
      target: "psx-runtime",
      config: "Release",
    },
    // Stash for notes only — not a catalog field.
    _launch_hint: launchLinux || "",
  };
}

/** snesrecomp generate + cmake recipe (see SCHEMA.md `build`). */
function inferSnesBuildRecipe(slug, target, regen) {
  return {
    enabled: true,
    source: {
      github: slug,
      ref: "main",
    },
    // Emitters are harvested from the game release zip's vendored snesrecomp/.
    sdk: { id: "snesrecomp-tools" },
    toolchain: {
      id: "cmake-clang-v1",
      github: "RetroPortingToolKit/RetroPorting-Toolchains",
      min_version: "1.0.3",
      asset_glob: {
        linux: "*cmake-clang-v1*linux*",
        windows: "*cmake-clang-v1*windows*",
        macos: "*cmake-clang-v1*macos*",
      },
    },
    generate: {
      engine: "snesrecomp",
      cfg_dir: regen?.cfg_dir || "recomp",
      out_dir: regen?.out_dir || "src/gen",
      funcs_h: regen?.funcs_h || "recomp/funcs.h",
      cfg_roots: regen?.cfg_roots ?? true,
    },
    cmake: {
      build_dir: "build",
      target,
      config: "Release",
    },
  };
}

async function probe(request, env) {
  const session = await requireUser(request, env);
  if (await isBanned(session.login, env)) {
    return json({ error: "You are banned from submitting" }, 403, request, env);
  }

  const body = await request.json().catch(() => ({}));
  const slug = parseRepoSlug(body.repo);
  if (!slug) {
    return json({ error: "Invalid GitHub repo (use owner/repo or URL)" }, 400, request, env);
  }
  // The form asks for the platform first; it is authoritative over any guess
  // from the README because it decides the catalog folder and the hash flow.
  const chosenPlatform = String(body.platform || "").trim();
  if (chosenPlatform && !platformInfo(chosenPlatform)) {
    return json(
      {
        error: `Unknown platform "${chosenPlatform}" — catalog platforms are ${knownPlatforms().join(", ")}`,
      },
      400,
      request,
      env
    );
  }

  const repoRes = await ghApiForeign(`/repos/${slug}`, env);
  if (!repoRes.ok) {
    // Report the status we actually got. The old message asserted "not found",
    // which sent people hunting for a permissions problem on public repos.
    const why =
      repoRes.status === 404
        ? "no such repo, or it is private"
        : repoRes.status === 403
          ? "GitHub rate limit or access blocked"
          : `GitHub returned HTTP ${repoRes.status}`;
    return json(
      { error: `Cannot read GitHub repo ${slug} — ${why}.` },
      repoRes.status === 404 ? 404 : 502,
      request,
      env
    );
  }
  const repo = await repoRes.json();

  let release = null;
  let allowPrerelease = false;
  let assets = [];

  const latestRes = await ghApiForeign(`/repos/${slug}/releases/latest`, env);
  if (latestRes.ok) {
    release = await latestRes.json();
  } else {
    const listRes = await ghApiForeign(`/repos/${slug}/releases?per_page=5`, env);
    if (listRes.ok) {
      const list = await listRes.json();
      const pre = list.find((r) => !r.draft);
      if (pre) {
        release = pre;
        allowPrerelease = !!pre.prerelease;
      }
    }
  }
  let releaseAssets = [];
  if (release?.assets) {
    assets = release.assets.map((a) => a.name);
    releaseAssets = release.assets.map((a) => ({
      name: a.name,
      browser_download_url: a.browser_download_url,
    }));
  }

  const readmeRes = await ghApiForeign(`/repos/${slug}/readme`, env);
  let readme = "";
  if (readmeRes.ok) {
    const rd = await readmeRes.json();
    if (rd.content) {
      try {
        readme = atob(rd.content.replace(/\n/g, ""));
      } catch {
        readme = "";
      }
    }
  }
  const discMd = (await fetchRepoText(slug, "DISC.md", env)) || "";
  const gameToml = (await fetchRepoText(slug, "game.toml", env)) || "";
  const cmakeText = (await fetchRepoText(slug, "CMakeLists.txt", env)) || "";
  const versionText = (await fetchRepoText(slug, "VERSION", env)) || "";

  // Platform: the submitter's choice wins; the README guess only fills in
  // when nothing was chosen (Download JSON without the picker) and is
  // reported back as a warning when the two disagree.
  const blob = `${repo.name} ${repo.description || ""} ${readme.slice(0, 2000)}`;
  const guessedPlatform = guessPlatform(blob) || (gameToml ? "psx" : "");
  const platform = chosenPlatform || guessedPlatform;
  const warnings = [];
  if (chosenPlatform && guessedPlatform && guessedPlatform !== chosenPlatform) {
    warnings.push(
      `The repo reads like a ${guessedPlatform} port but you chose ${chosenPlatform} — double-check the platform before submitting.`
    );
  }
  const isPsx = platform === "psx";
  const isSnes = platform === "snes";

  // psxrecomp: package_setup_release.sh / README-SETUP.txt / catalog_identity.
  // snesrecomp: package_release.sh / rom_identity.txt / tools/regen.sh.
  const packageScript =
    (await fetchRepoText(slug, "scripts/package_setup_release.sh", env)) ||
    (isPsx ? "" : (await fetchRepoText(slug, "scripts/package_release.sh", env)) || "");
  const readmeSetup = (await fetchRepoText(slug, "README-SETUP.txt", env)) || "";
  const catalogIdentityText =
    (await fetchRepoText(slug, "catalog_identity.json", env)) || "";
  // Multi-disc sets publish disc_set.json + one disc_probe per disc; empty for
  // single-disc titles (and every cart platform), which keep using the flat
  // identity below.
  const discSet = isPsx || !platform
    ? await fetchDiscSet(slug, env)
    : { discs: [], warnings: [] };
  const romIdentityTxt = isPsx
    ? parseRomIdentityTxt("")
    : parseRomIdentityTxt((await fetchRepoText(slug, "rom_identity.txt", env)) || "");
  const regen = isPsx
    ? parseRegenScript("")
    : parseRegenScript((await fetchRepoText(slug, "tools/regen.sh", env)) || "");

  const catalogId = parseCatalogIdentity(catalogIdentityText);
  const tomlDisc = extractGameTomlDisc(gameToml);
  const digests = mergeDigestSets(
    { ...extractDigests(readme), sources: readme ? ["README"] : [] },
    { ...extractDigests(discMd), sources: discMd ? ["DISC.md"] : [] },
    romIdentityTxt.ok
      ? { ...romIdentityTxt, sources: ["rom_identity.txt"] }
      : null,
    regen.crc32.length || regen.sha256.length || regen.filenames.length
      ? { ...regen, sources: ["tools/regen.sh"] }
      : null
  );
  // prepare_disc / catalog_identity digests are authoritative for psxrecomp.
  if (tomlDisc.md5.length) digests.md5 = [...new Set([...tomlDisc.md5, ...digests.md5])];
  if (tomlDisc.sha1.length) digests.sha1 = [...new Set([...tomlDisc.sha1, ...digests.sha1])];
  if (tomlDisc.sizes.length)
    digests.sizes = [...new Set([...tomlDisc.sizes, ...digests.sizes])];
  if (tomlDisc.filenames.length)
    digests.filenames = [...new Set([...tomlDisc.filenames, ...digests.filenames])];
  if (tomlDisc.disc_serials.length)
    digests.disc_serials = [
      ...new Set([...tomlDisc.disc_serials, ...digests.disc_serials]),
    ];
  if (tomlDisc.sources.length)
    digests.sources = [...new Set([...digests.sources, ...tomlDisc.sources])];
  if (catalogId.ok) {
    if (catalogId.crc32.length)
      digests.crc32 = [...new Set([...catalogId.crc32, ...digests.crc32])];
    if (catalogId.sha256.length)
      digests.sha256 = [...new Set([...catalogId.sha256, ...digests.sha256])];
    if (catalogId.md5.length)
      digests.md5 = [...new Set([...catalogId.md5, ...digests.md5])];
    if (catalogId.sha1.length)
      digests.sha1 = [...new Set([...catalogId.sha1, ...digests.sha1])];
    if (catalogId.sizes.length)
      digests.sizes = [...new Set([...catalogId.sizes, ...digests.sizes])];
    if (catalogId.filenames.length)
      digests.filenames = [
        ...new Set([...catalogId.filenames, ...digests.filenames]),
      ];
    if (catalogId.disc_serials.length)
      digests.disc_serials = [
        ...new Set([...catalogId.disc_serials, ...digests.disc_serials]),
      ];
    digests.sources = [...new Set([...digests.sources, "catalog_identity.json"])];
  }

  // Drop doc/source paths that leaked into digest filename scrapes.
  digests.filenames = (digests.filenames || []).filter(isLikelyRomFilename);

  const track_counts = [
    ...new Set([
      ...(catalogId.track_counts || []),
      ...(tomlDisc.track_counts || []),
    ]),
  ];
  const require_cue =
    !!catalogId.require_cue ||
    !!tomlDisc.require_cue ||
    track_counts.some((n) => n > 1);

  const asset_glob = inferAssetGlobs(assets);
  const install_dir_name = repo.name;
  const inferred = await inferLaunch(install_dir_name, asset_glob, {
    cmakeText,
    packageScript,
    readmeSetup,
    releaseAssets,
    env,
  });

  // Description: setup-wizard marketing blurb beats GitHub repo description.
  let description = "";
  let descriptionSrc = "missing";
  if (catalogId.description) {
    description = catalogId.description;
    descriptionSrc = "catalog_identity.marketing";
  } else if (repo.description) {
    description = repo.description;
    descriptionSrc = "repo";
  }

  const displayName = romIdentityTxt.display_name || displayNameFromRepo(repo.name);
  const players =
    catalogId.players != null
      ? catalogId.players
      : tomlDisc.players != null
        ? tomlDisc.players
        : null;

  const draft = {
    id: slugifyId(repo.name, platform || "game"),
    name: displayName,
    kind: /decomp/i.test(repo.name + (repo.description || "")) ? "decomp" : "recomp",
    platform: platform || "",
    description,
    homepage: repo.html_url,
    rom_identity: (() => {
      const flat = {
        crc32: digests.crc32,
        md5: digests.md5,
        sha1: digests.sha1,
        sha256: digests.sha256,
        disc_serials: digests.disc_serials,
        sizes: digests.sizes,
        filenames: digests.filenames,
        track_counts,
      };
      if (!discSet.discs.length) return { ...flat, require_cue };
      // Per-disc truth wins; the flat lists become the union so launchers that
      // predate discs[] still resolve the set.
      const merged = unionDiscIdentity(discSet.discs, flat);
      return {
        ...merged,
        require_cue: require_cue || merged.track_counts.some((n) => n > 1),
        discs: discSet.discs,
      };
    })(),
    rom_extensions:
      platformInfo(platform)?.rom_extensions ||
      (isPsx || track_counts.length ? [".cue", ".bin"] : []),
    release: {
      github: slug,
      allow_prerelease: allowPrerelease,
      asset_glob,
    },
    install_dir_name,
    launch: inferred.launch,
    romm: { platforms: platformInfo(platform)?.romm_platforms || [] },
    notes: digests.sources.length
      ? `Digests auto-extracted from ${digests.sources.join(", ")}.`
      : "Fill rom_identity from the project's baserom / gate docs.",
  };

  // Drop allow_prerelease if false to match most catalog entries
  if (!allowPrerelease) delete draft.release.allow_prerelease;

  const field_sources = {
    "release.github": "repo",
    homepage: "repo",
    description: descriptionSrc,
    name: romIdentityTxt.display_name ? "rom_identity.txt" : "guessed",
    id: "guessed",
    platform: chosenPlatform ? "submitter" : platform ? "guessed" : "missing",
    rom_identity: digests.sources.length ? digests.sources.join("+") : "missing",
    "release.asset_glob": assets.length ? "release assets" : "default",
    launch: inferred.source,
  };

  // Netplay: CMake opt-in / game.toml [netplay] + lobby identity strings.
  const netplayOn = detectNetplaySupported(cmakeText, tomlDisc, platform);
  let netplaySrc = "missing";
  if (netplayOn) {
    const fromTitle = netplayNameFromWindowTitle(tomlDisc.window_title);
    const game_name =
      fromTitle ||
      catalogId.game_name ||
      tomlDisc.game_name ||
      displayName;
    let game_version = "";
    if (release?.tag_name) {
      game_version = stripVersionV(release.tag_name);
      netplaySrc = "release tag + game.toml/cmake";
    } else if (versionText.trim()) {
      game_version = stripVersionV(versionText.split(/\r?\n/)[0]);
      netplaySrc = "VERSION + game.toml/cmake";
    } else {
      game_version = "0.1.0";
      netplaySrc = "game.toml/cmake (version defaulted)";
    }
    let max_slots = players != null ? players : 2;
    if (!Number.isFinite(max_slots) || max_slots < 2) max_slots = 2;
    draft.netplay = {
      supported: true,
      stack: "recomp-net",
      game_name,
      game_version,
      max_slots,
      transports: ["lan", "ice"],
      match_caps_schema:
        platformInfo(platform)?.match_caps_schema || (gameToml ? "psx-v1" : ""),
    };
    if (!draft.netplay.match_caps_schema) delete draft.netplay.match_caps_schema;
    field_sources.netplay = netplaySrc;
    field_sources["netplay.game_name"] = fromTitle
      ? "game.toml[runtime].window_title"
      : catalogId.game_name
        ? "catalog_identity.game.name"
        : "guessed";
    field_sources["netplay.max_slots"] =
      catalogId.players != null
        ? "catalog_identity.marketing.players"
        : tomlDisc.players != null
          ? "game.toml[game].players"
          : "default";
  }

  // Local Build & Install recipe: one-zip psxrecomp titles, or snesrecomp
  // ports whose tools/regen.sh + CMakeLists.txt name the generate inputs.
  if (
    (isPsx || (!platform && !!gameToml)) &&
    gameToml &&
    Object.values(asset_glob).some(Boolean)
  ) {
    const build = inferPsxBuildRecipe(slug, inferred.launch.linux);
    delete build._launch_hint;
    draft.build = build;
    field_sources.build = "psxrecomp one-zip defaults";
  } else if (isSnes && Object.values(asset_glob).some(Boolean)) {
    const target = inferCmakeExecutableTarget(cmakeText);
    const usesSnesrecomp = regen.ok || /snesrecomp/i.test(cmakeText);
    if (target && usesSnesrecomp) {
      draft.build = inferSnesBuildRecipe(slug, target, regen.ok ? regen : null);
      field_sources.build = regen.ok
        ? "tools/regen.sh + CMakeLists.txt"
        : "snesrecomp defaults + CMakeLists.txt";
    }
  }

  return json(
    {
      draft,
      meta: {
        submitter: session.login,
        repo: slug,
        release_tag: release?.tag_name || null,
        assets,
        digest_sources: digests.sources,
        field_sources,
        warnings: [...warnings, ...(discSet.warnings || [])],
        catalog_path: platform ? catalogTitlePath(platform, draft.id) : "",
      },
    },
    200,
    request,
    env
  );
}

/* ── Submit ──────────────────────────────────────────────────── */

/**
 * A ROM basename with no identifying information ("disc1", "track01", "game").
 *
 * rom_identity.filenames are the hub's search hints for an unmatched title and
 * seed the Libretro cover lookup, which uses No-Intro/Redump names. A
 * placeholder passes every digest check and still leaves users hunting for
 * "disc1.cue" with no box art.
 */
function looksLikePlaceholderRomName(name) {
  const stem = String(name || "")
    .split(/[/\\]/).pop()
    .replace(/\.[^.]+$/, "")
    .trim()
    .toLowerCase();
  if (!stem) return false;
  return /^(disc|cd|track|game|rom|image|dump|output|data|title|iso|bin|cue)[\s._-]*\d*$/.test(stem);
}

function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== "object") return ["Manifest required"];
  if (!m.id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(m.id)) {
    errors.push("id must be a lowercase slug (e.g. megaman-x-snes)");
  }
  if (!m.name) errors.push("name is required");
  if (!m.kind || !["recomp", "decomp"].includes(m.kind)) {
    errors.push('kind must be "recomp" or "decomp"');
  }
  if (!m.platform) errors.push("platform is required");
  else if (!platformInfo(m.platform)) {
    errors.push(
      `platform "${m.platform}" is not a catalog platform (${knownPlatforms().join(", ")})`
    );
  }
  if (!m.release?.github || !parseRepoSlug(m.release.github)) {
    errors.push("release.github must be owner/repo");
  }
  const glob = m.release?.asset_glob || {};
  if (!glob.linux && !glob.windows && !glob.macos) {
    errors.push("release.asset_glob needs at least one OS pattern");
  }
  if (!m.install_dir_name) errors.push("install_dir_name is required");
  const launch = m.launch || {};
  if (!launch.linux && !launch.windows && !launch.macos) {
    errors.push("launch needs at least one OS binary name");
  }
  const id = m.rom_identity || {};
  // Submissions must include digests from hashing a local dump (form requires
  // the browser file hasher). disc_serial alone is not enough.
  const hasDigest =
    (id.crc32 && id.crc32.length) ||
    (id.md5 && id.md5.length) ||
    (id.sha1 && id.sha1.length) ||
    (id.sha256 && id.sha256.length);
  if (!hasDigest) {
    errors.push(
      "rom_identity needs at least one digest (crc32 / md5 / sha1 / sha256) from a local ROM hash"
    );
  }
  const fnames = id.filenames || [];
  if (fnames.length && fnames.every(looksLikePlaceholderRomName)) {
    errors.push(
      "rom_identity.filenames are placeholders (" +
        fnames.join(", ") +
        ") — use the real dump basenames (No-Intro / Redump), e.g. \"" +
        (m.name || "Game") +
        " (USA).cue\". They are the hub's search hints and drive cover lookup."
    );
  }
  const tc = id.track_counts;
  if (tc != null) {
    if (
      !Array.isArray(tc) ||
      !tc.every((n) => Number.isInteger(n) && n >= 1)
    ) {
      errors.push("rom_identity.track_counts must be integers >= 1");
    }
  }
  // Multi-disc: every disc listed is required to own the title, so every disc
  // must carry its own digest. A half-filled discs[] would silently let one
  // disc stand in for the set.
  if (id.discs != null) {
    if (!Array.isArray(id.discs)) {
      errors.push("rom_identity.discs must be an array");
    } else if (id.discs.length === 1) {
      errors.push(
        "rom_identity.discs needs 2+ entries — use the flat fields for a single-disc title"
      );
    } else {
      const seen = new Set();
      id.discs.forEach((d, i) => {
        const label = `rom_identity.discs[${i}]`;
        const n = Number(d?.index);
        if (!Number.isInteger(n) || n < 1) {
          errors.push(`${label}.index must be an integer >= 1`);
        } else if (seen.has(n)) {
          errors.push(`${label}.index ${n} is duplicated`);
        } else {
          seen.add(n);
        }
        const has =
          (d?.crc32 || []).length ||
          (d?.md5 || []).length ||
          (d?.sha1 || []).length ||
          (d?.sha256 || []).length;
        if (!has) {
          errors.push(
            `${label} (disc ${d?.index ?? i + 1}) needs at least one digest — hash that disc's Track 01`
          );
        }
      });
    }
  }
  if (m.platform === "psx") {
    const exts = m.rom_extensions || [];
    if (exts.some((e) => /\.(iso|chd)$/i.test(String(e)))) {
      errors.push("PSX rom_extensions must not include .iso or .chd");
    }
  }
  if (m.netplay && m.netplay.supported) {
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

function normalizeManifest(m) {
  const ri = m.rom_identity || {};
  const emptyArr = (v) => (Array.isArray(v) ? v : []);
  const out = {
    id: String(m.id || "").trim(),
    name: String(m.name || "").trim(),
    kind: m.kind === "decomp" ? "decomp" : "recomp",
    platform: String(m.platform || "").trim(),
    description: String(m.description || "").trim(),
    homepage: String(m.homepage || "").trim(),
    rom_identity: (() => {
      const hex = (v) => emptyArr(v).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
      const nums = (v) =>
        emptyArr(v).map(Number).filter((n) => Number.isFinite(n) && n > 0);
      const ints = (v) =>
        emptyArr(v).map(Number).filter((n) => Number.isInteger(n) && n >= 1);

      // discs[] is the per-disc truth for multi-disc sets. Every disc listed is
      // required to own the title; a single-disc entry is meaningless here, so
      // drop it and let the flat fields stand alone.
      const discs = emptyArr(ri.discs)
        .map((d, i) => ({
          index: Number.isInteger(Number(d?.index)) ? Number(d.index) : i + 1,
          serial: String(d?.serial || "").trim(),
          cue_name: String(d?.cue_name || "").trim(),
          bin_name: String(d?.bin_name || "").trim(),
          crc32: hex(d?.crc32),
          md5: hex(d?.md5),
          sha1: hex(d?.sha1),
          sha256: hex(d?.sha256),
          sizes: nums(d?.sizes),
          track_counts: ints(d?.track_counts),
        }))
        .sort((a, b) => a.index - b.index);

      const flat = {
        crc32: hex(ri.crc32),
        md5: hex(ri.md5),
        sha1: hex(ri.sha1),
        sha256: hex(ri.sha256),
        disc_serials: emptyArr(ri.disc_serials).map(String),
        sizes: nums(ri.sizes),
        filenames: emptyArr(ri.filenames).map(String),
        track_counts: ints(ri.track_counts),
      };

      if (discs.length < 2) {
        // A lone discs[] entry is just a single-disc title described the long
        // way — fold its digests into the flat fields rather than dropping them.
        const merged = discs.length ? unionDiscIdentity(discs, flat) : flat;
        return {
          ...merged,
          require_cue: !!ri.require_cue || merged.track_counts.some((n) => n > 1),
        };
      }
      // Re-derive the flat union from discs[] so the two can never drift.
      const merged = unionDiscIdentity(discs, {
        filenames: flat.filenames,
        disc_serials: [],
      });
      return {
        ...merged,
        require_cue: !!ri.require_cue || merged.track_counts.some((n) => n > 1),
        discs,
      };
    })(),
    rom_extensions: (() => {
      let exts = emptyArr(m.rom_extensions).map(String);
      const plat = String(m.platform || "").trim();
      if (plat === "psx") {
        exts = exts.filter((e) => !/\.(iso|chd)$/i.test(e));
      }
      // Empty means "whatever the platform scans" — pin it from the registry
      // so the launcher never sees a title with no scan filter.
      if (!exts.length) exts = [...(platformInfo(plat)?.rom_extensions || [])];
      return exts;
    })(),
    release: {
      github: parseRepoSlug(m.release?.github) || String(m.release?.github || ""),
      asset_glob: {
        linux: String(m.release?.asset_glob?.linux || ""),
        windows: String(m.release?.asset_glob?.windows || ""),
        macos: String(m.release?.asset_glob?.macos || ""),
      },
    },
    install_dir_name: String(m.install_dir_name || m.id || "").trim(),
    launch: {
      linux: String(m.launch?.linux || ""),
      windows: String(m.launch?.windows || ""),
      macos: String(m.launch?.macos || ""),
    },
  };
  if (m.release?.allow_prerelease) out.release.allow_prerelease = true;
  if (m.romm && (m.romm.platforms?.length || m.romm.igdb_ids?.length)) {
    out.romm = {};
    if (m.romm.platforms?.length) out.romm.platforms = m.romm.platforms;
    if (m.romm.igdb_ids?.length) out.romm.igdb_ids = m.romm.igdb_ids;
  }
  if (m.saves && Object.keys(m.saves).length) out.saves = m.saves;
  if (m.netplay && m.netplay.supported) {
    let max_slots = Number(m.netplay.max_slots);
    if (!Number.isFinite(max_slots) || max_slots < 2) max_slots = 2;
    const netplay = {
      supported: true,
      stack: "recomp-net",
      game_name: String(m.netplay.game_name || "").trim(),
      game_version: String(m.netplay.game_version ?? "").trim(),
      max_slots,
    };
    const transports = emptyArr(m.netplay.transports).map(String).filter(Boolean);
    if (transports.length) netplay.transports = transports;
    const schema = String(m.netplay.match_caps_schema || "").trim();
    if (schema) netplay.match_caps_schema = schema;
    const lobby = String(m.netplay.lobby_url || "").trim();
    if (lobby) netplay.lobby_url = lobby;
    out.netplay = netplay;
  }
  if (m.author_notes) out.author_notes = String(m.author_notes);
  if (m.notes) out.notes = String(m.notes);
  if (m.bios_identity === null) out.bios_identity = null;
  else if (m.bios_identity && typeof m.bios_identity === "object") {
    out.bios_identity = m.bios_identity;
  }
  if (m.build && m.build.enabled) {
    // Pass through probe-inferred Retro local-build recipe (validated lightly).
    const b = m.build;
    out.build = {
      enabled: true,
      source: {
        github: String(b.source?.github || out.release.github || "").trim(),
        ref: String(b.source?.ref || "main").trim() || "main",
      },
      toolchain: b.toolchain && typeof b.toolchain === "object" ? b.toolchain : undefined,
      generate: b.generate && typeof b.generate === "object" ? b.generate : undefined,
      cmake: b.cmake && typeof b.cmake === "object" ? b.cmake : undefined,
      sdk: b.sdk && typeof b.sdk === "object" ? b.sdk : undefined,
    };
    if (!out.build.toolchain) delete out.build.toolchain;
    if (!out.build.generate) delete out.build.generate;
    if (!out.build.cmake) delete out.build.cmake;
    if (!out.build.sdk) delete out.build.sdk;
  }
  // Drop empty homepage
  if (!out.homepage) delete out.homepage;
  if (!out.description) delete out.description;
  return out;
}

async function submit(request, env) {
  const session = await requireUser(request, env);
  if (await isBanned(session.login, env)) {
    return json({ error: "You are banned from submitting" }, 403, request, env);
  }

  const body = await request.json().catch(() => ({}));
  const manifest = normalizeManifest(body.manifest || body);
  const submitter_note = String(body.submitter_note || "").slice(0, 2000);
  const errors = validateManifest(manifest);
  if (errors.length) {
    return json({ error: "Validation failed", errors }, 400, request, env);
  }

  if (!env.GITHUB_TOKEN) {
    return json(
      { error: "Server missing GITHUB_TOKEN; cannot open approval issue" },
      500,
      request,
      env
    );
  }

  const catalogRepo = env.CATALOG_REPO || "RetroPortingToolKit/Retro-Catalog";
  const approvers = await resolveApprovers(env, catalogRepo);
  // GitHub allows at most 10 assignees per issue.
  const assignees = approvers.logins.slice(0, 10);

  const title = `[catalog submission] ${manifest.platform}/${manifest.id} from @${session.login}`;
  const titlePath = catalogTitlePath(manifest.platform, manifest.id);
  const jsonBlock = JSON.stringify(manifest, null, 2);
  const notifyLine = approvers.logins.length
    ? approvers.logins.map((l) => `@${l}`).join(" ")
    : "_no human contributors resolved_";
  const issueBody = [
    `## Catalog title submission`,
    ``,
    `| | |`,
    `|---|---|`,
    `| **Submitter** | @${session.login} |`,
    `| **Proposed id** | \`${manifest.id}\` |`,
    `| **Source** | https://github.com/${manifest.release.github} |`,
    `| **Platform** | ${manifest.platform} (${platformInfo(manifest.platform)?.label || manifest.platform}) |`,
    `| **Path** | \`${titlePath}\` |`,
    `| **Notify** | ${notifyLine} |`,
    ``,
    submitter_note ? `### Note from submitter\n\n${submitter_note}\n` : "",
    `### Proposed \`${titlePath}\``,
    ``,
    "```json",
    jsonBlock,
    "```",
    ``,
    `### Maintainer checklist`,
    ``,
    `- [ ] Digests match the game's ownership gate / No-Intro / Redump`,
    `- [ ] Release asset globs match real assets`,
    `- [ ] Launch binary names verified`,
    `- [ ] Add label \`approved\` to merge into the catalog and publish \`catalog.zip\` (use \`approved-update\` only to overwrite an existing id)`,
    ``,
    `_Submitted via the catalog submission form._`,
  ]
    .filter((l) => l !== undefined)
    .join("\n");

  await ensureSubmissionLabels(env, catalogRepo);

  const issueRes = await ghApi(`/repos/${catalogRepo}/issues`, env, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      body: issueBody,
      labels: ["catalog-submission"],
      assignees,
    }),
  });

  let issue = null;
  let issueWarning = null;
  if (!issueRes.ok) {
    const detail = await issueRes.text();
    // Assignees often fail for non-collaborators — retry with label only.
    const retryLabeled = await ghApi(`/repos/${catalogRepo}/issues`, env, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        body: issueBody,
        labels: ["catalog-submission"],
      }),
    });
    if (retryLabeled.ok) {
      issue = await retryLabeled.json();
      issueWarning =
        "Issue created without assignees (add submit/contributors or collaborators).";
    } else {
      // Last resort: bare issue, then attach catalog-submission.
      const retry = await ghApi(`/repos/${catalogRepo}/issues`, env, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body: issueBody }),
      });
      if (!retry.ok) {
        return json(
          {
            error: "Failed to create GitHub issue",
            detail: await retry.text(),
            first: detail,
            labeled: await retryLabeled.text(),
          },
          502,
          request,
          env
        );
      }
      issue = await retry.json();
      const labeled = await addIssueLabel(
        env,
        catalogRepo,
        issue.number,
        "catalog-submission"
      );
      issueWarning = labeled
        ? "Issue created; catalog-submission label applied after create."
        : "Issue created without catalog-submission label; approve workflow will add it.";
    }
  } else {
    issue = await issueRes.json();
  }

  // Belt-and-suspenders: ensure the submission label is present.
  const hasLabel = Array.isArray(issue.labels)
    ? issue.labels.some((l) => (l.name || l) === "catalog-submission")
    : false;
  if (!hasLabel && issue.number) {
    await addIssueLabel(env, catalogRepo, issue.number, "catalog-submission");
  }

  const emailResult = await sendApproverEmail(env, {
    submitter: session.login,
    manifest,
    issueUrl: issue.html_url,
    submitter_note,
    emails: approvers.emails,
    logins: approvers.logins,
  });

  return json(
    {
      ok: true,
      issue_url: issue.html_url,
      issue_number: issue.number,
      approvers: approvers.logins,
      email: emailResult,
      warning: issueWarning,
    },
    200,
    request,
    env
  );
}

/** Human contributors from submit/contributors.json ∪ GitHub collaborators (bots excluded). */
async function resolveApprovers(env, catalogRepo) {
  const byLogin = new Map(); // lower -> { login, email }

  const remember = (login, email = "") => {
    const raw = String(login || "").trim();
    if (!raw || isBotLogin(raw)) return;
    const key = raw.toLowerCase();
    const prev = byLogin.get(key);
    byLogin.set(key, {
      // Keep first-seen login casing (contributors.json is loaded first).
      login: prev?.login || raw,
      email: String(email || "").trim() || prev?.email || "",
    });
  };

  // 1) Repo file (source of truth for emails + explicit human list)
  const contributorsUrl =
    env.CONTRIBUTORS_URL ||
    `https://raw.githubusercontent.com/${catalogRepo}/main/submit/contributors.json`;
  try {
    const res = await fetch(contributorsUrl, {
      headers: {
        "User-Agent": "retcomm-catalog-submit",
        Accept: "application/json",
      },
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    if (res.ok) {
      const data = await res.json();
      for (const c of data.contributors || []) {
        if (c.bot || c.type === "Bot") continue;
        remember(c.login, c.email);
      }
    }
  } catch (err) {
    console.error("contributors.json fetch failed", err);
  }

  // 2) Live collaborators with repo access (humans only)
  try {
    const collabRes = await ghApi(
      `/repos/${catalogRepo}/collaborators?affiliation=all&per_page=100`,
      env
    );
    if (collabRes.ok) {
      const collabs = await collabRes.json();
      for (const c of collabs) {
        if (c.type && c.type !== "User") continue;
        if (c.login && isBotLogin(c.login)) continue;
        remember(c.login);
      }
    }
  } catch (err) {
    console.error("collaborators fetch failed", err);
  }

  // 3) Optional extras from Worker env (comma-separated), not required
  for (const login of (env.EXTRA_APPROVER_LOGINS || "").split(",")) {
    remember(login.trim());
  }
  for (const email of (env.EXTRA_APPROVER_EMAILS || "").split(",")) {
    const e = email.trim();
    if (e && e.includes("@")) {
      // Email-only extras (no login) — attach under synthetic key
      const key = `email:${e.toLowerCase()}`;
      if (![...byLogin.values()].some((v) => v.email.toLowerCase() === e.toLowerCase())) {
        byLogin.set(key, { login: "", email: e });
      }
    }
  }

  const people = [...byLogin.values()];
  const logins = [
    ...new Set(people.map((p) => p.login).filter(Boolean)),
  ];
  const emails = [
    ...new Set(
      people
        .map((p) => p.email)
        .filter((e) => e && e.includes("@") && !e.endsWith("@users.noreply.github.com"))
    ),
  ];
  return { logins, emails, people };
}

function isBotLogin(login) {
  const l = String(login).toLowerCase();
  return (
    l.endsWith("[bot]") ||
    l.endsWith("-bot") ||
    l === "github-actions" ||
    l === "dependabot" ||
    l === "renovate" ||
    l === "ghost"
  );
}

async function sendApproverEmail(
  env,
  { submitter, manifest, issueUrl, submitter_note, emails, logins }
) {
  const to = [...new Set((emails || []).filter(Boolean))];
  if (!to.length) {
    return {
      sent: false,
      reason:
        "No contributor emails resolved (add email fields in submit/contributors.json). Issue assignees still notified on GitHub.",
      logins: logins || [],
    };
  }
  if (!env.RESEND_API_KEY) {
    return {
      sent: false,
      reason:
        "RESEND_API_KEY not set (GitHub issue still created; assignees get GitHub notifications)",
      to,
      logins: logins || [],
    };
  }

  const from = env.FROM_EMAIL || "Retro Catalog <onboarding@resend.dev>";
  const subject = `[Retro catalog] New submission: ${manifest.id} (@${submitter})`;
  const text = [
    `New catalog submission from GitHub user @${submitter}`,
    ``,
    `Title id: ${manifest.id}`,
    `Name: ${manifest.name}`,
    `Platform: ${manifest.platform}`,
    `Path: ${catalogTitlePath(manifest.platform, manifest.id)}`,
    `Source: https://github.com/${manifest.release.github}`,
    `Issue: ${issueUrl}`,
    submitter_note ? `\nSubmitter note:\n${submitter_note}` : "",
    ``,
    `Manifest:`,
    JSON.stringify(manifest, null, 2),
  ].join("\n");

  const html = `
    <p>New catalog submission from GitHub user <strong>@${escapeHtml(submitter)}</strong></p>
    <ul>
      <li><strong>Title id:</strong> ${escapeHtml(manifest.id)}</li>
      <li><strong>Name:</strong> ${escapeHtml(manifest.name)}</li>
      <li><strong>Platform:</strong> ${escapeHtml(manifest.platform)} → <code>${escapeHtml(catalogTitlePath(manifest.platform, manifest.id))}</code></li>
      <li><strong>Source:</strong> <a href="https://github.com/${escapeHtml(manifest.release.github)}">${escapeHtml(manifest.release.github)}</a></li>
      <li><strong>Approval issue:</strong> <a href="${escapeHtml(issueUrl)}">${escapeHtml(issueUrl)}</a></li>
    </ul>
    ${submitter_note ? `<p><strong>Note:</strong> ${escapeHtml(submitter_note)}</p>` : ""}
    <pre style="background:#f4f4f4;padding:12px;overflow:auto">${escapeHtml(JSON.stringify(manifest, null, 2))}</pre>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      text,
      html,
    }),
  });

  if (!res.ok) {
    return { sent: false, reason: await res.text(), to, logins: logins || [] };
  }
  const data = await res.json();
  return { sent: true, id: data.id, to, logins: logins || [] };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
