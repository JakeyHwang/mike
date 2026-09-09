# AdminLess fork — how this repository is developed and shipped

This repository (`JakeyHwang/mike`, branch `adminless`) is AdminLess's fork of
[Open-Legal-Products/mike](https://github.com/Open-Legal-Products/mike). It is
public and licensed AGPL-3.0, like upstream. Everything in this document applies
on top of the upstream contributor rules in `AGENTS.md` and `CONTRIBUTING.md`,
which remain in force for the application code.

## What the fork is for

AdminLess installs Mike for law firms on a single machine (a lawyer's laptop or
an office box) with a one-click installer, points inference at an
OpenAI-compatible gateway, and keeps installed copies current through an
in-app updater. This repository holds the application side of that: the
changes to Mike itself, which are AGPL and public. The installer and the
updater sidecar are separate programs that only drive Docker and HTTP around
Mike; they are AdminLess's own tooling and live in a private repository.
Feature work (for example a web-search tool) is added here as ordinary
open-source code.

Differences from upstream, all of which must keep working after every change:

| Area | Fork behaviour | Where |
| --- | --- | --- |
| Inference | Default models are the gateway's (`ollama/qwen/qwen3.8-27b` for chat and tabular review, `ollama/liquid/lfm2.5-2.6b` for titles). The gateway is reached through the existing Ollama provider: `OLLAMA_BASE_URL` + `OLLAMA_API_KEY`. Speech and embedding models are hidden from the picker. | `backend/src/lib/llm/models.ts`, `backend/src/routes/models.ts`, `frontend/src/app/components/assistant/ModelToggle.tsx`, `frontend/src/app/hooks/useSelectedModel.ts`, `word-addin/src/taskpane/lib/modelCatalog.ts` |
| Auth | Google sign-in is off by default. | `docker-compose.yml` (`GOTRUE_EXTERNAL_GOOGLE_ENABLED`) |
| Images | `docker-compose.yml` pulls `ghcr.io/jakeyhwang/mike-{backend,frontend}:${MIKE_VERSION}` (public) and `ghcr.io/jakeyhwang/mikeoss-updater:${MIKE_VERSION}` (private; see below). `docker-compose.build.yml` is the source-build override for the application images. | `docker-compose.yml`, `docker-compose.build.yml`, `frontend/Dockerfile`, `frontend/Dockerfile.dockerignore` |
| Update API and UI | `GET/POST /system/update` and `/system/update/status` on the backend; Settings → Updates and the sidebar notice on the frontend. These talk to the updater sidecar at `http://updater:8085` over the compose network. | `backend/src/routes/system.ts`, `backend/src/lib/updates.ts`, `frontend/src/app/(pages)/settings/updates/`, `frontend/src/app/components/shared/SidebarUpdateNotice.tsx` |
| CI | Tag `v*` builds the two application images (amd64 + arm64) to GHCR and creates the GitHub Release whose tag and notes installed copies read. | `.github/workflows/release.yml` |

The private side (the installer and the updater image, kept by AdminLess
outside this repository) publishes the `mikeoss-updater` image for the same
tag; the launcher binaries ride inside that image. Installed copies pull it
with a per-firm read-only registry token entered once at install time
(`docker login ghcr.io`). Everything else in an update — the release check,
the source tarball, the application images — is public.

Building this repository from source without that token works: run
`docker compose -f docker-compose.yml -f docker-compose.build.yml up --build`
and either drop the `updater` service or point `MIKE_UPDATER_IMAGE` at your
own build of an updater that implements the contract in the design spec.

Design documents for fork features live in `docs/superpowers/specs/` next to
upstream's. They are open-source documentation; write them so a stranger can
read them.

## Layout of an installed copy

The installer creates `~/MikeOSS` (`%USERPROFILE%\MikeOSS` on Windows):

```
MikeOSS/
  bin/MikeOSS(.exe)        launcher; the updater stages MikeOSS.new(.exe) beside it
  app/                     this repository's release tarball (compose, schema, migrations)
    .env                   compose interpolation: ports, public URLs, MIKE_VERSION,
                           MIKE_HOST_* paths the updater needs, OLLAMA_BASE_URL
    backend/.env           secrets: signing/encryption secrets, OLLAMA_API_KEY
    updates/               status.json, <tag>.log, lock (written by the updater)
    backups/               <utc>_<fromTag>.sql.gz (pg_dump before each update)
```

Compose project name is `mikeoss`. Data lives in the `mikeoss_db_data`,
`mikeoss_storage_data` and `mikeoss_redis_data` volumes. Nothing in `app/`
other than the two env files, `updates/` and `backups/` survives an update; do
not rely on local edits there.

## How a change reaches a law firm

1. Commit on `adminless`. Keep upstream's conventions (tests at the lowest useful
   layer, no raw errors to the client, migrations per `AGENTS.md`).
2. Tag `vMAJOR.MINOR.PATCH` and push the tag. Tags are strict semver with a `v`
   prefix; the updater and launcher compare them numerically and ignore
   anything else.
3. `release.yml` publishes the three images (amd64 + arm64) and the installer
   binaries, and creates the GitHub Release. Release notes are generated from
   commits; edit them on GitHub if they need to read well for a lawyer, because
   the app shows them in Settings → Updates.
4. Installed copies notice the release within about an hour (backend cache) plus
   up to thirty minutes (UI poll), or immediately when the Updates page is
   opened. The lawyer clicks Update, or is offered it at the next launch. Nothing
   installs without a click.
5. The update replays every idempotent migration (`db-init` runs on each start)
   and re-syncs the workflow catalog, then restarts the application containers.
   A `pg_dump` is taken first; `MikeOSS rollback` reinstalls the previous tag and
   restores it.

Consequences for how to write changes:

- Every migration must be safe to re-run. `db-init` replays the whole forward
  list on every start of every installed copy.
- Never change the shape of `app/.env` or `backend/.env` without a migration
  path in the updater or installer: existing installs carry the old files.
- Never rename `MIKE_VERSION`, the compose project name, the volume names, or
  the updater's HTTP contract (`POST /apply`, `GET /status`, the status
  document — see the design spec) without versioning it; the running updater
  on a firm's machine is the *old* one when an update starts.
- A release that cannot come up will be noticed by the health check and left
  `failed`; the lawyer can roll back. Keep releases small so that is rare.
- Prerelease and draft releases are ignored by the update check. Use them to
  test CI without offering the build to firms.

## Syncing with upstream

`main` mirrors upstream; `adminless` carries the fork. To pick up upstream:

```bash
git remote add upstream https://github.com/Open-Legal-Products/mike.git   # once
git fetch upstream
git checkout adminless && git merge upstream/main
```

Expect conflicts only in the files listed in the table above. After merging,
run the backend and frontend suites, build the three images locally
(`docker compose -f docker-compose.yml -f docker-compose.build.yml build`),
then tag.

## Testing a release before firms see it

A real install exists for this purpose (see the private context for its
location). The sequence that has been used for every release so far:

1. Publish the tag on this repository, then the same tag on the private
   deployment repository; wait for both workflows to go green.
2. In the running install, open Settings → Updates (forces the check) and
   confirm the new version is offered.
3. Apply it from the UI; watch the seven steps complete; reload; confirm an
   earlier chat and document are still there.
4. `MikeOSS stop`, then launch from the shortcut to exercise the startup prompt
   on a further tag if the launcher changed.

## Secrets

The repository holds none and must never hold any: no gateway keys, no
service-account files, no `.env` beyond the `.env.example` templates. Harness
directories (`.omp/`, `.claude/`, …) and `*.private.md` are gitignored so
machine-local context cannot be committed by accident.
