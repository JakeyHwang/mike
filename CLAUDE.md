@AGENTS.md

## Derived repo state

<!-- context:project-context:start -->
Applications: `backend/` (Express, entry `backend/src/app.ts`), `frontend/`
(Next.js, entry `frontend/src/app/`), `word-addin/` (Word task pane, entry
`word-addin/src/taskpane/`), plus root `e2e/` Playwright tests. Node.js 22+.

Chat tool-calling lives in `backend/src/lib/chat/`: `streaming.ts`
(`runLLMStream` — assembles the tool list and the per-turn tool state, emits
`AssistantEvent`s), `tools/toolDispatcher.ts` (`runToolCalls`, one branch per
tool), `contextBuilders.ts` (`spotlight()` untrusted-content fencing),
`prompts.ts` and `citations.ts` (prompt splicing, citation normalisation).

Web search is implemented, not planned — it landed on 2026-09-15 in
`backend/src/lib/webSearch/` (Gemini grounding, grounding-redirect
resolution, authority ranking, the `read_page` reader, per-jurisdiction source
profiles), `backend/src/lib/chat/tools/webSearchTools.ts` (tool schemas,
prompt block, enablement) and `backend/src/lib/http/guardedFetch.ts` (the
shared https-only, no-private-network outbound guard, moved here from
`lib/mcp/client.ts`). Frontend: `WebSearchBlock` in
`frontend/src/app/components/assistant/message/EventBlocks.tsx`, web citation
rows in `message/CitationSources.tsx`, status row in
`(pages)/settings/features/page.tsx`. Design and rationale:
`docs/superpowers/specs/2026-09-15-web-search-design.md`.

One install-wide key, `WEB_SEARCH_GEMINI_API_KEY` (see
`backend/.env.example`), enables it; it is deliberately separate from
`GEMINI_API_KEY`, which only selects Gemini as a chat model. With the key
absent the two tools are neither advertised nor callable and the app behaves
exactly as before.

The `updater` service in `docker-compose.yml:393-410` mounts
`${MIKE_UPDATER_AUTH_DIR:-./updater-auth}` read-only at `/root/.docker` so it
can pull the private updater image: a container cannot use the host's
credential store, so the installer writes a plain `config.json` there. An
absent or empty directory is fine for public images. The default source-build
directory `/updater-auth/` is gitignored (`.gitignore:53-54`).

Conventions, structure rules and verification commands are in `AGENTS.md`
above; this block never restates them.
<!-- context:project-context:end -->
