# Submission form setup

The form is static files under [`submit/`](../submit/), published with GitHub Pages.
Login, repo probing, ban checks, issue creation, and email run on a small
[Cloudflare Worker](../worker/).

## Who gets notified

Approvers are resolved at submit time (bots excluded):

1. Human entries in [`submit/contributors.json`](../submit/contributors.json) (emails + logins)
2. Plus anyone with collaborator access on this repo (GitHub API)

Each submission:

- Opens an issue assigned to those logins (and `@`-mentions them)
- Emails every address listed in `contributors.json` (via Resend)

When you add someone (e.g. mstan, JRickey), put them in `contributors.json` and
invite them as a repo collaborator. Fill their `email` field for Resend; without
it they still get GitHub issue notifications when assigned.

## 1. Enable GitHub Pages

1. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**
2. Merge/push so [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) runs
3. Confirm: https://retroportingtoolkit.github.io/Retro-Catalog/submit/

## 2. Create labels

These labels are created automatically by the approve workflow and (when the
Worker token allows) by the submit Worker. You can also seed them once:

```sh
export GITHUB_REPOSITORY=RetroPortingToolKit/Retro-Catalog
bash .github/scripts/ensure_submission_labels.sh
```

| Label | Purpose |
|---|---|
| `catalog-submission` | Applied by the form on new issues (auto-applied on approve if missing) |
| `approved` | Maintainer adds this → merge title + publish `catalog.zip` |
| `approved-update` | Same, but overwrites an existing `titles/<platform>/<id>.json` (also when a title moves between platform folders) |

Only users with **write** (or higher) on the repo can successfully approve.
Rejecting a submission is just closing the issue (no special label).

## 3. GitHub OAuth App

1. GitHub → **Settings → Developer settings → OAuth Apps → New**
2. **Homepage URL:** `https://retroportingtoolkit.github.io/Retro-Catalog/submit/`
3. **Authorization callback URL:**  
   `https://retcomm-catalog-submit.<subdomain>.workers.dev/auth/callback`  
   (use your real Worker URL after the first deploy)
4. Copy **Client ID** and generate a **Client secret**

## 4. GitHub token for the Worker

Create a fine-grained PAT (or classic with `repo` scope) that can:

- Create issues on `RetroPortingToolKit/Retro-Catalog`
- Assign collaborators on issues
- Read collaborators (for the human-approver merge)

Invite contributor accounts as collaborators so assignment succeeds.

## 5. Deploy the Worker

```sh
cd worker
npm install
npx wrangler login
npx wrangler deploy
```

Put secrets:

```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET          # long random string
npx wrangler secret put GITHUB_TOKEN            # PAT from step 4
npx wrangler secret put RESEND_API_KEY          # from https://resend.com
```

Edit [`worker/wrangler.toml`](../worker/wrangler.toml) vars if needed:

| Var | Purpose |
|---|---|
| `PAGES_ORIGIN` | `https://retroportingtoolkit.github.io` |
| `FROM_EMAIL` | Verified Resend sender |
| `CONTRIBUTORS_URL` | Raw URL of `submit/contributors.json` |
| `BANNED_USERS_URL` | Raw URL of `submit/banned-users.json` |
| `EXTRA_APPROVER_LOGINS` | Optional comma-separated logins |
| `EXTRA_APPROVER_EMAILS` | Optional comma-separated emails |

Then set the Worker URL in [`submit/config.js`](../submit/config.js) `API_BASE` and push.

Update the OAuth App callback URL to match the deployed Worker.

## 6. Resend email

1. Create a [Resend](https://resend.com) account
2. For production, verify a domain (e.g. `technicallycomputers.ca`) and set `FROM_EMAIL` to that domain
3. Keep contributor emails current in [`submit/contributors.json`](../submit/contributors.json)

Until Resend is configured, submissions still create a GitHub issue and assign
human contributors (GitHub notification email if watching/assigned).

## Approving a submission

1. Review the issue’s JSON and checklist.
2. Add label **`approved`** (or **`approved-update`** to replace an existing id).
3. [`.github/workflows/approve-submission.yml`](../.github/workflows/approve-submission.yml)
   writes `titles/<platform>/<id>.json`, registers the id under
   `index.json` → `platforms.<platform>.titles` (plus the flat `titles` list),
   pushes to the default branch,
   creates a dated `vYYYY.MM.DD.HHMMSS.<issue>` release with `catalog.zip`, comments,
   and closes the issue.

Launchers pick up the new zip on the next catalog sync / auto-update.

## Banning abusers

Add lowercase GitHub logins to [`submit/banned-users.json`](../submit/banned-users.json) on `main`:

```json
{
  "users": ["bad-actor"],
  "notes": "…"
}
```

The Worker reloads this file on each submit (short cache). You can also set a
comma-separated `BANNED_USERS` Worker secret for an emergency block without a
commit.

## Auth note (GitHub Pages)

The form cannot rely on cross-site cookies (`github.io` → `workers.dev`). After
OAuth, the Worker redirects with `#session=<token>`; the page stores it in
`sessionStorage` and sends `Authorization: Bearer …` on API calls.
`SESSION_SECRET` stays only on the Worker (never in the frontend).

## Local development

```sh
# terminal 1
cd worker && npm install && npx wrangler dev

# terminal 2 — any static server for submit/
cd submit && python3 -m http.server 5500
```

Point `submit/config.js` `API_BASE` at `http://127.0.0.1:8787` and add that
origin via `EXTRA_ORIGINS` if needed. OAuth callback for local use requires a
second redirect URI on the OAuth App (`http://127.0.0.1:8787/auth/callback`).
