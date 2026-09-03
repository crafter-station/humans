# Humans v1 release

This runbook is the release gate for Humans v1. Complete it separately for
preview and production. Record service identifiers and evidence links, never
secret values.

## Environment inventory

Local, preview, and production must not share service instances, databases,
branches, API credentials, webhook secrets, or encryption/signing secrets.

| Service | Local | Preview | Production |
| --- | --- | --- | --- |
| Clerk instance ID | Local development instance | | |
| Neon project and branch | | | |
| Trigger.dev project/environment | Development | Staging | Production |
| Cloudflare Worker | `humans-api-local` | `humans-api-preview` | `humans-api-production` |
| Vercel project/environment | Local | Preview | Production |
| Polar organization/environment | Sandbox | Sandbox | Production |
| OpenAI credential ID | | | |
| GitHub credential ID | | | |
| TikHub credential ID | | | |
| Deepline credential ID | | | |
| Sentry project/environment | Local | Preview | Production |

Before deployment, verify every populated preview identifier differs from its
production counterpart. A credential ID may be its dashboard label or last four
characters, but must not be the credential itself.

### Cloudflare secrets

Set each value independently in both deployed Worker environments:

- `DATABASE_URL`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `CLERK_WEBHOOK_SIGNING_SECRET`
- `SEARCH_CURSOR_SECRET`
- `WEB_PROXY_SECRET`
- `OPENAI_API_KEY` when natural-language search is enabled
- `POLAR_WEBHOOK_SECRET` when billing is enabled

From `apps/api`, use `bunx wrangler secret put <NAME> --env preview` or
`bunx wrangler secret put <NAME> --env production`. `WEB_PROXY_SECRET` must
match the corresponding Vercel environment and no other environment.

Vercel requires `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`,
`HUMANS_API_URL`, and `HUMANS_PROXY_SECRET` in separate Preview and Production
scopes. Configure `apps/web` as the Vercel project root.

Trigger.dev requires a distinct `TRIGGER_PROJECT_REF` and provider credentials
for each environment. Polar webhooks and Clerk webhooks must target only the
Worker URL from their own environment.

## Release procedure

1. Record the commit SHA and complete the environment inventory.
2. Run `bun install --frozen-lockfile` with Bun 1.3.14 and Node.js 24 or newer.
3. Run `bun run check-types`, `bun run lint`, `bun run test`, and
   `bun run build`.
4. Run `bun run --cwd packages/database db:rehearse`. This installs every
   migration into an empty pgvector database, upgrades the production-like
   previous schema, checks the `vector` extension, newest columns, and
   representative Profile and Credit data, then reruns the migrator to prove
   idempotency.
5. Create a Neon branch from the target database immediately before release.
   Apply the committed migrations to that branch and run application health and
   representative read checks. Do not continue if data, constraints, indexes,
   or the `vector` extension differ from the source.
6. Deploy Trigger.dev to staging with `bun run deploy:trigger:preview:dry-run`
   followed by `bun run deploy:trigger:preview`.
7. Deploy the Worker with `bun run deploy:api:preview` and deploy the web app to
   a Vercel preview from the same commit.
8. Verify `/health`, `/openapi.json`, `/docs`, `/mcp`, the protected web app,
   the representative CSV journey, API/MCP acceptance, and browser acceptance
   in preview. Attach sanitized logs and test results to the release record.
9. Apply migrations to production, run
   `bun run deploy:trigger:production:dry-run` followed by
   `bun run deploy:trigger:production`, then run
   `bun run deploy:api:production` and promote the verified Vercel deployment.
   Stop on any version or commit mismatch.
10. Repeat the bounded health, API/MCP, indexing, and browser checks in
    production. Roll back application deployments on failure; restore data only
    through a reviewed Neon recovery procedure.

Live provider smoke tests must require explicit opt-in, use one known-safe
identity, cap requests and retries, have a short timeout, and log no Contact
Details or provider payloads. They must never run from the default `test`
command.

## Representative journey

Use only `packages/database/fixtures/imported-profiles-v1.csv` or an equivalently
sanitized fixture.

- [ ] Dry-run reports the expected plan and writes nothing.
- [ ] Apply succeeds, and an identical rerun creates no duplicate Profile or Observation.
- [ ] GitHub, TikHub, and fallback enrichment stages reach expected terminal states.
- [ ] An authenticated Member finds the imported Profile through protected search.
- [ ] The represented Member claims the Profile with an auditable review.
- [ ] Searchability opt-in and immediate opt-out both take effect.
- [ ] Suppression removes the Profile from search and a later import does not recreate it.

## MCP Inspector

1. Create a short-lived, Organization-scoped Clerk API key with only the scopes
   required by the checks.
2. Run `bunx @modelcontextprotocol/inspector` and connect with Streamable HTTP to
   the environment's `/mcp` URL using `Authorization: Bearer <key>`.
3. Confirm initialization and `tools/list` expose only the documented tools.
4. Run one bounded search and compare its normalized result and one-Credit
   charge with the HTTP API.
5. Read one returned Profile and perform one permitted Contact Reveal. Confirm
   the first Reveal charge and the zero-Credit repeat behavior match the API.
6. Verify missing scope, insufficient Credit, rate-limit, and suspended-principal
   errors match the API without exposing Profile data.
7. Revoke the API key and confirm another request is denied. Record the date,
   environment, commit SHA, Inspector version, and sanitized results.

## Security and scope signoff

- [ ] Unauthenticated requests cannot access the app, Profile routes, API, or MCP Profile data.
- [ ] Responses containing Profile data use `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`.
- [ ] `/robots.txt` disallows all crawlers and no public Profile route or sitemap exists.
- [ ] Deployment logs, telemetry, and test artifacts contain no secrets or Contact Details.
- [ ] No outreach or messaging automation shipped.
- [ ] No CRM synchronization shipped.
- [ ] No arbitrary CSV mapping shipped; only the fixed versioned contract is accepted.
- [ ] No private Organization-owned Profile dataset shipped.
- [ ] No bulk Profile or Contact Detail export shipped.
- [ ] No inferred or unverified Contact Detail shipped.
- [ ] No externally accessible or indexable Profile shipped.

Release commit: __________

Preview evidence: __________

Production evidence: __________

Verified by and date: __________
