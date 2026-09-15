@AGENTS.md

## Derived repo state

<!-- context:project-context:start -->
Agent-facing derived state lives in `.claude/context/PROJECT_CONTEXT.md`:
entry points, the chat/tool-calling module map, which spec currently governs,
recent changes and open questions. It is regenerated each sync — read it, do
not hand-edit it.

Applications: `backend/` (Express, entry `backend/src/app.ts`), `frontend/`
(Next.js, entry `frontend/src/app/`), `word-addin/` (Word task pane, entry
`word-addin/src/taskpane/`), plus root `e2e/` Playwright tests. Node.js 22+.

Governing spec: `docs/superpowers/specs/2026-09-15-web-search-design.md`
(web search via Gemini grounding + a `read_page` primitive). Design only as of
2026-09-15 — no implementation has landed, so every `backend/src/lib/webSearch/`
path it names is a forward reference.

Conventions, structure rules and verification commands are in `AGENTS.md`
above; this block never restates them.
<!-- context:project-context:end -->
