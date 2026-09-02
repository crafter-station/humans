# Humans

Humans is a protected directory for discovering people in Latin America who
build with code. The monorepo uses Bun and Turborepo.

## Requirements

- Bun 1.3.14
- Node.js 24 or newer
- Docker for the PostgreSQL integration test
- PostgreSQL with pgvector for local API development

Install the workspace dependencies:

```sh
bun install
```

## Local Development

Start the Next.js web application at <http://localhost:3000>:

```sh
bun run dev:web
```

Create `apps/api/.dev.vars` from `apps/api/.dev.vars.example`. Set its
`DATABASE_URL` to a pgvector-capable database and add the Clerk keys and webhook
signing secret for the environment. Apply the migrations, then start the
Cloudflare Worker at <http://localhost:8787>:

```sh
bun run --cwd packages/database --env-file=../../apps/api/.dev.vars db:migrate
bun run dev:api
```

The API exposes:

- `GET /health`: API, database, and pgvector readiness
- `GET /openapi.json`: OpenAPI 3.1 contract
- `GET /docs`: Scalar API reference

Run all persistent development tasks together with `bun run dev`.

## Database

Drizzle Kit writes reviewable migrations to `packages/database/drizzle`.

```sh
bun run --cwd packages/database db:generate
bun run --cwd packages/database --env-file=../../apps/api/.dev.vars db:migrate
```

`db:generate` creates the initial pgvector extension migration from a declared
extension list because Drizzle has no extension schema primitive. Migration SQL
is generated and should not be edited by hand.

Production database access uses Drizzle's transactional Neon serverless adapter
behind an Effect service. The integration test supplies Drizzle's Node
PostgreSQL adapter to the same service boundary.

## Configuration

No secrets are committed. The API requires `DATABASE_URL`, `CLERK_SECRET_KEY`,
`CLERK_PUBLISHABLE_KEY`, and `CLERK_WEBHOOK_SIGNING_SECRET`. The web application
requires `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`; set
`HUMANS_API_URL` when the API is not available at `http://localhost:8787`.

| Environment | Cloudflare environment | Worker name             | Secret source                    |
| ----------- | ---------------------- | ----------------------- | -------------------------------- |
| Local       | default                | `humans-api-local`      | `apps/api/.dev.vars`             |
| Preview     | `preview`              | `humans-api-preview`    | Cloudflare secret `DATABASE_URL` |
| Production  | `production`           | `humans-api-production` | Cloudflare secret `DATABASE_URL` |

Set deployed secrets from `apps/api` without writing their values to files:

```sh
bunx wrangler secret put DATABASE_URL --env preview
bunx wrangler secret put DATABASE_URL --env production
```

Use separate Neon databases or branches for local, preview, and production.
Configure Clerk to deliver Member, Organization, and Organization membership
events to `/webhooks/clerk` in each environment.

## Profile Imports

Validate the fixed `humans-profiles-v1` CSV contract without writing:

```sh
bun run --cwd packages/database --env-file=../../apps/api/.dev.vars profiles:import -- \
  --file fixtures/imported-profiles-v1.csv \
  --contract humans-profiles-v1 \
  --environment local
```

Add `--apply` to execute the reported plan. Every valid row commits independently,
so rerunning the same command safely resumes an interrupted import. Invalid rows
are reported and skipped. Production requires `HUMANS_ENV=production`,
`--environment production`, `--apply`, and the command's interactive
confirmation phrase.

## Verification

```sh
bun run check-types
bun run lint
bun run test
bun run build
```

Type checks run on TypeScript 7. Compiler-API tools such as typescript-eslint
resolve TypeScript 6 until TypeScript 7 provides the required stable API.
