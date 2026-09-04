# Humans v1 release

This runbook is the release gate for Humans v1. Complete it separately for
preview and production. Record service identifiers and evidence links, never
secret values.

## Environment inventory

Local, preview, and production must not share service instances, databases,
branches, API credentials, webhook secrets, or encryption/signing secrets.

| Service | Local | Preview | Production |
| --- | --- | --- | --- |
| Clerk instance ID | Local development instance | `ins_3InRqXS3sKxXPyqqiOMQ75PhGQx` | `ins_3InStOBNOMbj1uRVtQCN0GLX3tt` |
| Clerk webhook endpoint | Local listener | `ep_3InUXE23pr40O0RjqGLbf2nlKWi` | `ep_3InUe0OhgKQtJXkVkkSNi7LVmIN` |
| Neon project and branch | Local database | `autumn-base-48692547` / `br-silent-heart-audvpz7y` | `autumn-base-48692547` / `br-spring-haze-autqf4gr` |
| Trigger.dev project/environment | `proj_umusurvkybxuonbiopal` / Development | `proj_bzchfkbbyztlvsntroom` / Production (`Humans Preview`) | `proj_umusurvkybxuonbiopal` / Production (`Humans`) |
| Cloudflare Worker | `humans-api-local` | `humans-api-preview` / `d011be97-1b8c-4600-8ac7-5724a2a55b95` | `humans-api-production` / `6ce29841-eff4-4605-a00a-8ac1a1b696ca` |
| Vercel project/environment | Local | `prj_1rRwDoknIk65eWIHIScwyuuHDthI` / Preview / `dpl_6kpu7sXEZukyEpLCEREbiB3oH2U5` | `prj_1rRwDoknIk65eWIHIScwyuuHDthI` / Production / `dpl_AjaXzBaBodtu15qGWWdoSAirmF3J` |
| Polar organization/environment | Sandbox | Pending / Sandbox | Pending / Production |
| OpenAI credential ID | Local credential | Pending | Pending |
| GitHub enrichment credential ID | Local credential | Pending | Pending |
| GitHub sign-in OAuth app | Clerk shared development credential | Clerk shared development credential | `cuevaio/Humans` / application `3833647` |
| TikHub credential ID | Local credential | Pending | Pending |
| Deepline credential ID | Local credential | Pending | Pending |
| Sentry project/environment | Local | `cueva/humans-preview` (`4512020599144448`) / Preview | `cueva/humans` (`4512020552089600`) / Production |

The production web application is `https://humans.crafter.run`. The HTTP API,
MCP endpoint, Scalar documentation, and OpenAPI contract are available at
`https://api.humans.crafter.run`. Spaceship DNS points both hostnames to Vercel;
the API hostname is host-gated at the Vercel edge and rewritten to the production
Cloudflare Worker. The API continues to execute entirely on Cloudflare Workers,
without delegating or modifying the parent `crafter.run` nameservers. Staging
uses the Clerk development instance; production uses the Clerk production
instance.

Vercel Preview must call
`https://humans-api-preview.hi-541.workers.dev`; Vercel Production must call
`https://humans-api-production.hi-541.workers.dev`. These exact hosts are pinned
in application validation so Clerk and web-proxy credentials cannot be sent to
another Workers account.

Before deployment, verify every populated preview identifier differs from its
production counterpart. A credential ID may be its dashboard label or last four
characters, but must not be the credential itself.

Both Clerk instances must enable automatic Organization creation with the
`My Organization` fallback, disable email-domain detection and name templates,
and keep forced Organization selection enabled. This gives an uninvited Member
one personal Organization without allowing an email domain to define ownership.

### Cloudflare secrets

Set each value independently in both deployed Worker environments:

- `CLERK_BOT_PROTECTION_ENABLED=true` after confirming Clerk bot protection is
  enabled for that instance
- `DATABASE_URL`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `CLERK_WEBHOOK_SIGNING_SECRET`
- `SEARCH_CURSOR_SECRET`
- `WEB_PROXY_SECRET`
- `OPENAI_API_KEY` when natural-language search is enabled
- `OPENAI_MODEL` when natural-language search is enabled
- `POLAR_ACCESS_TOKEN` when billing is enabled
- `POLAR_BASE_URL` when billing is enabled
- `POLAR_ORGANIZATION_ID` when billing is enabled
- `POLAR_PRO_PRODUCT_ID` when billing is enabled
- `POLAR_CUSTOMER_OWNER_EMAIL` when billing is enabled; use an operator-managed
  service mailbox, never an Organization Member's address
- `POLAR_USAGE_METER_ID` when billing is enabled
- `POLAR_USAGE_EVENT_NAME` when billing is enabled
- `POLAR_WEBHOOK_SECRET` when billing is enabled
- `BILLING_APP_ORIGIN` when billing is enabled
- `BILLING_APP_ORIGIN_ATTESTATION` in Preview only; never enter it manually
- `BILLING_APP_ORIGIN_ATTESTATION_KEY` in Preview only; generated and rotated
  atomically with the attestation, never enter it manually
- `SENTRY_DSN`

The Worker deploy command injects `SENTRY_RELEASE` from the clean Git `HEAD`.
Do not set or override it manually.

The committed Preview and Production Worker configuration sets
`BILLING_REQUIRED=true`. `/health` fails closed unless every Polar setting,
Clerk setting, signing secret, web-proxy secret, Sentry setting, and release SHA
is present and structurally valid; local development may omit Polar entirely.

From `apps/api`, use `bunx wrangler secret put <NAME> --env preview` or
`bunx wrangler secret put <NAME> --env production`. `WEB_PROXY_SECRET` must
match the corresponding Vercel environment and no other environment.

Vercel requires `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`,
`HUMANS_API_URL`, `HUMANS_PROXY_SECRET`, `SENTRY_AUTH_TOKEN`, `SENTRY_DSN`,
`NEXT_PUBLIC_SENTRY_DSN`, and `NEXT_PUBLIC_SENTRY_ENVIRONMENT` in separate
Preview and Production scopes. Configure `apps/web` as the Vercel project root;
a Vercel build must use the matching direct `humans-api-<environment>.*.workers.dev`
origin and never the public API alias, the other environment, or the local API
URL default.

`BILLING_APP_ORIGIN` is environment-bound. Production must use
`https://humans.crafter.run`; Preview must use the immutable
`https://humans-<deployment>-crafter-station.vercel.app` URL from the candidate
Preview deployment. The API rejects a deployed Preview origin outside that
exact project hostname pattern and rejects any Production origin other than the
public Humans hostname. Preview must use Polar Sandbox, while Production must
use Polar Production.

Set the Preview origin only with `bun run configure:api:preview-origin` after
`bun run verify:web:preview`. The command verifies the Vercel project, Preview
target, immutable URL, and frozen SHA before writing both the origin and its
release-bound signed attestation to Cloudflare. It rotates the HMAC key in the
same atomic secret update. The attestation expires after seven days, and the
command only attests a deployment created within the previous 24 hours.
Preview readiness rejects a missing, expired, modified, Production-target, or
different-deployment attestation; deploy a new Preview candidate rather than
renewing an old attestation.

Trigger.dev Preview uses the Production environment of the isolated
`Humans Preview` project because the Free plan has no Staging environment.
Production uses only the Production environment of the separate `Humans`
project. Each requires its own `DATABASE_URL`, `GITHUB_ENRICHMENT_TOKEN`,
`OPENAI_API_KEY`, `OPENAI_MODEL`, `TIKHUB_API_KEY`, `DEEPLINE_API_KEY`, Polar,
and Sentry settings. The explicit deploy scripts reject a dirty worktree and
inject the clean Git `HEAD` as `SENTRY_RELEASE` and Trigger external ID.
Polar webhooks and Clerk webhooks must target only the Worker URL from their own
environment.

Before recording either Polar product ID, verify the product is a fixed
`$20 USD` monthly subscription, maps only to the configured Humans usage meter,
and has no metered overage price. Confirm a successful subscription payment is
the authority for each 1,000-Credit Pro grant; subscription-state notifications
alone must not grant Credits. In both Polar environments, confirm **Allow
multiple subscriptions** is disabled; the checkout route also refuses to create
a session when Polar reports any nonterminal Pro subscription. Team Customers
must use the configured service mailbox as owner; no Clerk Member may be a Polar
owner or billing manager. Partial and full Order refunds are retained in the
immutable webhook audit, but do not claw back Credits or change access by
themselves; issue a corresponding Polar subscription cancellation or revocation
when a refund should end access.

## Release procedure

1. Disable Vercel automatic Git deployments before changing `main`; an
   unreviewed push to the Production branch must not bypass this gate. Record
   the commit SHA and complete the environment inventory.
2. Run `bun install --frozen-lockfile` with Bun 1.3.14 and Node.js 24 or newer.
3. Run `bun run check-types`, `bun run lint`, `bun run test`, and
   `SKIP_ENV_VALIDATION=1 bun run build`. The bypass is valid only for the local
   source build; every deployment command rejects it and every deployed build
   validates its environment-bound credentials.
4. Run `bun run --cwd packages/database db:rehearse`. This installs every
   migration into an empty pgvector database, upgrades the production-like
   previous schema, checks the `vector` extension, newest columns, and
   representative Profile and Credit data, then reruns the migrator to prove
   idempotency.
5. Create a Neon branch from the target database immediately before release.
   Apply the committed migrations to that branch and run application health and
   representative read checks. Do not continue if data, constraints, indexes,
   or the `vector` extension differ from the source.
6. Apply the reviewed migrations to the Preview database, then deploy
   Trigger.dev to the isolated Preview project with
   `bun run deploy:trigger:preview:dry-run`
   followed by `bun run deploy:trigger:preview`.
7. Run `bun run deploy:web:preview`. The Vercel command refuses a dirty tree,
   verifies automatic Git deployments remain disabled, targets Preview, and
   deploys from the repository root into the configured `apps/web` Root
   Directory. It injects the clean `HEAD` as `HUMANS_RELEASE` and explicitly
   binds the build and runtime to Preview. Record the
   immutable `humans-<deployment>-crafter-station.vercel.app` URL and deployment
   ID. Set `HUMANS_RELEASE_SHA`, `HUMANS_VERCEL_DEPLOYMENT_ID`, and
   `HUMANS_VERCEL_DEPLOYMENT_URL`, then run `bun run verify:web:preview`. This
   verifies the exact Vercel project, owner, Preview target, READY state, Git
   source SHA, and release metadata. Run
   `bun run configure:api:preview-origin`; do not set `BILLING_APP_ORIGIN`
   manually. Then run
   `bun run deploy:api:preview`. Confirm the web and Worker responses expose the
   same 40-character Git SHA in `X-Humans-Release`, and confirm the web response
   exposes `X-Humans-Environment: preview`; do not trust a mutable branch alias.
   This ordering resolves the Preview checkout-return URL without accepting a
   mutable or cross-project origin.
8. Verify `/health`, `/openapi.json`, `/docs`, `/mcp`, the protected web app,
   the representative CSV journey, API/MCP acceptance, and browser acceptance
   in Preview. Attach sanitized logs and test results to the release record.
   Provision a new verified Member whose personal Organization is Free, active,
   has one Member, exactly 100 Credits, no existing API keys, and no prior
   Contact Reveals. Keep the system Operator separate. Use one consented or
   synthetic searchable Profile that is uniquely selected by the structured
   query and has one unpurchased professional-email Observation and one
   unpurchased direct-professional-phone Observation.

   Set `HUMANS_ACCEPTANCE_API_URL`,
   `HUMANS_ACCEPTANCE_ENVIRONMENT=preview`, `HUMANS_ACCEPTANCE_RELEASE`,
   `HUMANS_ACCEPTANCE_RUN_ID` (a fresh UUID),
   `HUMANS_ACCEPTANCE_ORGANIZATION_ID`,
   `HUMANS_ACCEPTANCE_PROFILE_QUERY`, `HUMANS_ACCEPTANCE_PROFILE_ID`,
   `HUMANS_ACCEPTANCE_EMAIL_OBSERVATION_ID`,
   `HUMANS_ACCEPTANCE_PHONE_OBSERVATION_ID`,
   `HUMANS_ACCEPTANCE_ADMIN_SESSION_ID`,
   `HUMANS_ACCEPTANCE_OPERATOR_SESSION_ID`, and the Preview
   `CLERK_SECRET_KEY`. The script mints short-lived session tokens, creates five
   15-minute scoped Organization API keys, proves HTTP/MCP read, debit, replay,
   insufficient-Credit, Contact Reveal, suspension, revocation, and rate-limit
   parity, restores its temporary zero-Credit adjustment, and revokes every
   run-owned key in `finally`. It spends exactly 17 Credits and permanently
   purchases both fixture Contact Reveals, so delete the disposable Member and
   Organization after the run; never reuse a partial-run fixture.

   Run `bun run accept:web:preview` with the Preview Clerk test keys, immutable
   `PLAYWRIGHT_PREVIEW_URL`, a sanitized `E2E_PROFILE_QUERY`, and
   `E2E_RELEASE_SHA` set to the frozen commit. Supply ephemeral
   `E2E_OPERATOR_IMPERSONATION_URL` and `VERCEL_AUTOMATION_BYPASS_SECRET`
   values. Playwright sends the bypass only in the initial Preview request,
   proves ordinary-Member Operator isolation, then impersonates the Operator to
   enter the control room and apply and reverse an audited Credit adjustment on
   the disposable browser Organization. The command first re-verifies the
   deployment, runs deployed API/MCP acceptance and the complete dependent
   Preview browser projects, then writes a mode-`600` receipt containing only
   the accepted deployment identity. It logs no key, query, Profile result, or
   Contact Detail. Confirm teardown deletes the disposable browser Member and
   Organization, then revoke the bypass and impersonation URLs and delete local
   browser artifacts.
9. Apply migrations to Production. Set
   `HUMANS_PRODUCTION_DEPLOY_CONFIRMATION=production:trigger:proj_umusurvkybxuonbiopal:<SHA>`,
   run `bun run deploy:trigger:production:dry-run` followed by
   `bun run deploy:trigger:production`, then replace the confirmation with
   `production:api:humans-api-production:<SHA>` and run
   `bun run deploy:api:production`. Each command rejects a confirmation for a
   different service, target, or release. Verify Production `HUMANS_API_URL` is the
   direct Production Worker origin, then run
   `bun run deploy:web:production:stage`. This creates a Production-target
   deployment with `--skip-domain`, Production variables, and the same frozen
   Git SHA without changing public domains. Record and accept its immutable URL
   and deployment ID. Set `HUMANS_RELEASE_SHA`,
   `HUMANS_VERCEL_DEPLOYMENT_ID`, and `HUMANS_VERCEL_DEPLOYMENT_URL`, then run
   `bun run verify:web:production`. The verifier additionally requires a
   Production target with no assigned aliases, preventing a Preview rebuild or
   old Production artifact from entering promotion. Accept that exact URL,
   including `X-Humans-Environment: production`, the release header, protected
   browser journey, and deployed API/MCP suite with
   `HUMANS_ACCEPTANCE_ENVIRONMENT=production` and
   `HUMANS_ACCEPTANCE_PRODUCTION_CONFIRMATION=production:<SHA>:<ORGANIZATION_ID>:<RUN_ID>:17:75`
   by running
   `bun run accept:web:production`. The command runs the deployed API/MCP suite
   and `production-profile-control` Playwright journey and writes the exact
   Production acceptance receipt only if both pass.
   Supply the temporary Vercel bypass only for the immutable deployment URL.
10. Promote the accepted staged Production deployment with
    `bun run deploy:web:production:promote` with those same three identity
    variables. The command reruns the deployment verifier and calls only
    Vercel's direct Production alias endpoint; it refuses a missing, stale, or
    different-deployment acceptance receipt and never invokes the CLI path that
    rebuilds a Preview deployment. It polls the alias operation to success and
    verifies the frozen release and Production environment headers through
    `https://humans.crafter.run` before returning. Because the deployment
    already targets Production, promotion assigns domains without a second
    build. Preview and
    Production are necessarily separate builds because Clerk and public Sentry
    values are compiled into Next.js; the frozen SHA is the cross-environment
    identity, while the staged Production deployment is the artifact promoted
    unchanged. Fast-forward `main` to the same SHA only while automatic Git
    deployments remain disabled. Stop on any version, commit, environment, or
    deployment mismatch.
11. Repeat the bounded health, API/MCP, indexing, and browser checks through
      the public production domains. Roll back application deployments on failure; restore data only
     through a reviewed Neon recovery procedure.
     Generate a short-lived supported Clerk impersonation URL for the
     GitHub-connected represented Member and run
     `bun run test:browser -- --project=production-profile-control` with
     `PLAYWRIGHT_PRODUCTION_URL`, `E2E_PROFILE_OWNER_IMPERSONATION_URL`, and the
      same `E2E_RELEASE_SHA`. The pre-promotion run may use the immutable staged
      Production URL; the post-promotion run uses `https://humans.crafter.run`.
     Tracing is disabled for this project; confirm the suite restores the
     original Searchability and signs out the impersonation. Run this only for
     the intended represented Member: an initial successful claim is durable
     even though Searchability is restored.

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

Accepted release commit: none. The identities below are historical setup
evidence and are not accepted for the current candidate.

Preview evidence: Vercel `dpl_6kpu7sXEZukyEpLCEREbiB3oH2U5`; Worker code
`8e7f59e9-37ee-4677-a9f2-5c472a35afba`, with rotated-secret version
`d011be97-1b8c-4600-8ac7-5724a2a55b95`; health, OpenAPI, and docs returned
`200`; unauthenticated Profile and MCP requests returned `401`. A disposable
Member and Organization completed Organization API-key list, create, protected
HTTP, MCP `list_search_facets`, and revoke checks; the revoked key returned
`401`. The exposed Preview Clerk and web-proxy credentials were rotated and the
retired Clerk key was rejected.

Production evidence: Vercel `dpl_AjaXzBaBodtu15qGWWdoSAirmF3J`; Worker
`6ce29841-eff4-4605-a00a-8ac1a1b696ca`; Vercel certificate
`cert_tsCUhrgR628SZSgsMzc4RdZB` covers the web hostname, while
`cert_RXIyHRmGUm3ACkiDJqCjb0VR` and `cert_Htwkez7nFvuHNceXjKcy6FWn` cover the
API hostname. Health, OpenAPI, and docs returned `200`; unauthenticated Profile
and MCP requests returned `401`. GitHub sign-in, Clerk callback,
Organization creation/selection, and authenticated workspace reads completed.
A short-lived Organization API key completed list, create, protected HTTP, MCP
`list_search_facets`, and revoke checks through `api.humans.crafter.run`; the
revoked key returned `401`. The root response includes private/no-cache and
no-index headers, and `robots.txt` disallows all crawlers.

Verified by and date: automated release verification, 2026-09-02. Trigger.dev
task deployment, Polar, Sentry, the representative import journey, and live
provider checks remain pending.
