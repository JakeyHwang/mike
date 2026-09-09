# In-app updater — design

Date: 2026-09-09. Status: approved approach ("B", updater sidecar), details below.

## Goal

A lawyer running Mike from the AdminLess installer can update to the latest
published release without a terminal, two ways:

1. **Startup**: the launcher checks for a newer release before bringing the
   stack up, offers the update, applies it, then launches the app as usual.
2. **In-app**: while using Mike, the UI notices a newer release, shows a
   notification, and one click applies it with visible progress.

Updates are lawyer-led: nothing installs without a click, and a backup is
taken first.

## Release source

GitHub Releases of `JakeyHwang/mike` (env `MIKE_UPDATE_REPO`, default that).
"Latest" = `GET /repos/{repo}/releases/latest` (non-draft, non-prerelease).
A release ships: images `mike-backend`, `mike-frontend`, `mike-updater` at the
tag on GHCR; installer binaries as assets; the tag's source tarball (compose,
schema, migrations, nginx conf).

## Components

### `updater` service (new, `updater/` in the repo)

Image `ghcr.io/jakeyhwang/mike-updater:${MIKE_VERSION}` = `oven/bun:alpine` +
`docker-cli` + `docker-cli-compose` + `curl`/`tar`. Two entry points from one
`apply.ts`:

- `serve` (service default): HTTP on `:8085`, compose network only, no auth
  (the backend is the sole caller; nothing is published to the host).
  - `POST /apply {tag}` → 202, or 409 if an apply is running.
  - `GET /status` → contents of `updates/status.json`.
- `apply <tag>`: the update sequence (below). `POST /apply` does not run it
  in-process; it starts a **sibling one-off container**
  (`docker compose run -d --rm updater apply <tag>`) so the sequence survives
  the `updater` service being recreated by its own `compose up`.

Mounts (from compose): `/var/run/docker.sock`, and the project directory at
the daemon-visible host path so compose's client-side path resolution matches:
`${MIKE_HOST_PROJECT_DIR}:${MIKE_HOST_PROJECT_DIR}` and
`${MIKE_HOST_BIN_DIR}:/host-bin`. The installer writes both variables to
`.env` (Windows: `/run/desktop/mnt/host/c/Users/<u>/MikeOSS/app`; macOS: the
path as-is). Verified 2026-09-09 on Docker Desktop for Windows.

Apply sequence, each step recorded in `updates/status.json`
(`{state: running|done|failed, tag, fromTag, step, startedAt, finishedAt, error}`)
and appended to `updates/<tag>.log`; `updates/lock` prevents concurrent runs:

1. `backup` — `compose up -d db`, then `pg_dump` (via `compose exec -T db`)
   gzipped to `backups/<utc>_<fromTag>.sql.gz`.
2. `download` — fetch the tag's tarball from GitHub; extract over the project
   dir, preserving `.env`, `backend/.env`, `updates/`, `backups/`.
3. `configure` — set `MIKE_VERSION=<tag>` in `.env`.
4. `pull` — `compose pull`.
5. `start` — `compose up -d --remove-orphans` (recreates backend/frontend,
   re-runs `db-init`/`workflow-sync` one-shots which replay migrations).
6. `verify` — poll `http://frontend:3000` until 200 (10 min) → `done`.
7. `launcher` — download the tag's installer binary for this OS/arch to
   `/host-bin/MikeOSS.new(.exe)`; the launcher swaps it in on its next start.

Failure at any step → `failed` with the error; no automatic rollback.
`MikeOSS rollback` (launcher) = `apply <fromTag>` then restore the newest
backup for that tag (`compose exec -T db psql < backup`).

### Backend (`backend/src/routes/system.ts`, mounted at `/system`, `requireAuth`)

- `GET /system/update` → `{ current, latest, available, publishedAt, notes, url }`.
  GitHub result cached 1 h in memory; `?refresh=1` bypasses. `current` is
  `MIKE_VERSION` from env. Offline/rate-limited → `latest: null`, never an error.
- `POST /system/update` → forwards `{tag: latest}` to `${UPDATER_URL}/apply`; 202/409.
- `GET /system/update/status` → proxies updater `/status`; if the updater is
  unreachable (being recreated) → `{ state: "unknown" }`.

Any signed-in user may trigger (single-firm box; most accounts have no org
role to gate on).

### Frontend

- `useUpdateStatus` hook: `GET /system/update` on load and every 30 min.
- Sidebar notice above the account button when `available`: "Mike v1.1.0 is
  available — Update". Click → Settings › Updates.
- Settings › **Updates** page: current/latest version, release notes, "Update
  now" → confirm dialog ("Mike will be unavailable for about two minutes; a
  database backup is taken first") → progress view polling `/status` every
  3 s showing the step list; when `/system/update` reports `current === tag`
  → "Updated to v1.1.0", reload.

### Launcher (`installer/`)

- `launch`: after Docker is ready and before `compose up`, check latest
  (5 s timeout, silent on failure). If newer: `Update to vX.Y.Z now? [Y/n]`,
  30 s timeout → **No** (the app must still come up unattended; the in-app
  notice covers it). Yes → `compose run --rm updater apply <tag>` streaming
  its log, then the normal launch.
- `update` command: same without the prompt. `rollback` command as above.
- On every start: if `bin/MikeOSS.new(.exe)` exists, rename running binary to
  `.old`, move `.new` into place, delete `.old` on the following start.
- Installer writes `MIKE_HOST_PROJECT_DIR` / `MIKE_HOST_BIN_DIR` into `.env`.

### Compose / CI

- `updater` service (restart `unless-stopped`, no ports). Backend gets
  `UPDATER_URL=http://updater:8085` and `MIKE_VERSION`.
- `release.yml` builds and pushes `mike-updater` for amd64/arm64.

## Testing

- Unit: semver compare, status parsing, env editing, tarball overlay
  preserving the protected paths.
- Live on this PC: install `v1.1.0` (first release with the updater), then
  publish `v1.1.1` (docs-only) and verify: sidebar notice appears within the
  poll window; Update now → steps progress → version changes; the account,
  document and chat from before survive; `MikeOSS launch` swaps the new
  launcher binary; then publish `v1.1.2` and take the **startup** path.
- Phase 2 (web search release) repeats the in-app path for real.

## Security notes

The updater mounts the Docker socket (host-root equivalent). It is reachable
only on the compose network and only the backend calls it; the backend
requires a signed-in user. Documented in the runbook; never publish port 8085.

Release v1.1.1: updater live-test release (no functional change).
Release v1.1.2: startup-path live-test release (no functional change).
