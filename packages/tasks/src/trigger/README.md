# Trigger.dev task entrypoints

This directory is the single deployment composition root for Humans enrichment tasks.

The TypeScript modules in this directory register every concrete task at module scope. Runtime credentials and Neon connections are resolved only inside task invocations.

The deployment contains:

- GitHub, TikHub, and Deepline provider graphs.
- A leased enrichment dispatcher backed by the database outbox.
- Daily enrichment refresh production, lease recovery, raw-checkpoint cleanup, and inaccessible-GitHub suppression schedules.
- Frequent Polar usage delivery and recovery plus daily Credit reconciliation schedules.

All graphs deploy through `trigger.config.ts` as one Trigger.dev project version. Backend callers should use `tasks.trigger()` with type-only imports from this package.

The Trigger.dev Free plan does not provide Staging. Preview therefore uses the
Production environment of the isolated `Humans Preview` project, while the
`Humans` project remains Production-only. The repository deployment scripts pin
those project refs, attach the Git commit as the external deployment ID, and
sync that commit to the non-secret `SENTRY_RELEASE` runtime variable.

Runtime task settings are validated lazily: `DATABASE_URL`, `GITHUB_ENRICHMENT_TOKEN`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `TIKHUB_API_KEY`, `DEEPLINE_API_KEY`, `POLAR_ACCESS_TOKEN`, `POLAR_BASE_URL`, `POLAR_ORGANIZATION_ID`, `POLAR_PRO_PRODUCT_ID`, `POLAR_USAGE_METER_ID`, `POLAR_USAGE_EVENT_NAME`, and `BILLING_APP_ORIGIN`. Sentry is disabled unless `SENTRY_DSN` is set; `SENTRY_ENVIRONMENT` is optional. Deployment configuration supplies `TRIGGER_PROJECT_REF` and `SENTRY_RELEASE` and requires Trigger.dev authentication.
