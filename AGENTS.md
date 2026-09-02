# Humans

## Domain and decisions

- Read `CONTEXT.md` and the relevant `docs/adr/` records before changing behavior. Use the glossary's canonical terms, including its capitalization, and do not silently contradict an ADR. See `docs/agents/domain.md`.
- Issues and specs live in `crafter-station/humans`; use `gh issue`, not pull requests, as the triage surface. See `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`.

## Toolchain and commands

- Use Bun 1.3.14 and Node.js 24 or newer. Install with `bun install`; this is a Bun/Turborepo workspace, not an npm or pnpm workspace.
- Full verification is `bun run check-types`, `bun run lint`, `bun run test`, then `bun run build`. Type checks intentionally use the native TypeScript 7 binary configured by each workspace script.
- Run one workspace directly with `bun run --cwd <workspace> <script>`, for example `bun run --cwd apps/api check-types`.
- Run one Vitest file with `bun run --cwd <workspace> test -- <path>`, for example `bun run --cwd packages/github-enrichment test -- test/workflow.test.ts`.
- `bun run dev` starts all persistent workspace dev tasks. Use `bun run dev:web` for Next.js on port 3000 or `bun run dev:api` for the Worker on port 8787; the docs app uses port 3001.

## Boundaries

- `apps/api` is the Cloudflare Worker. `src/index.ts` supplies the Neon database layer to the Hono/OpenAPI app in `src/app.ts`.
- `apps/web` is the product UI. Its `app/api/**` route handlers authenticate with Clerk and proxy to the Worker; keep database access behind the API rather than importing database internals into the web app.
- `packages/database` owns Drizzle schemas, migrations, data operations, and the Effect `Database` service boundary. Production uses Neon; integration tests inject the Node PostgreSQL adapter at that same boundary.
- `packages/github-enrichment` and `packages/tikhub-enrichment` contain independently retryable Trigger.dev workflows. Their tests use in-memory provider/store fakes and need no external service.

## Database and tests

- API local development reads `apps/api/.dev.vars`; copy `.dev.vars.example`, provide a pgvector-capable `DATABASE_URL` and Clerk values, then run `bun run --cwd packages/database --env-file=../../apps/api/.dev.vars db:migrate` before `bun run dev:api`.
- Web environment validation happens during Next startup/build. Copy `apps/web/.env.example` to `.env.local`; `HUMANS_API_URL` defaults to `http://localhost:8787`.
- Database tests and `apps/api/test/health.test.ts` start `pgvector/pgvector:pg17` with Testcontainers, apply committed migrations, and require a running Docker daemon. Timeouts are deliberately five minutes for API tests.
- Change schema under `packages/database/src/schema/`, then run `bun run --cwd packages/database db:generate`. Drizzle SQL and metadata under `packages/database/drizzle/` are generated review artifacts; do not edit migration SQL by hand.
