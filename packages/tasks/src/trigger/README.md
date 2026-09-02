# Trigger.dev task entrypoints

This directory is the single deployment composition root for Humans enrichment tasks.

Do not add placeholder tasks. A task entrypoint is ready when it can construct its production dependencies and export concrete task instances at module scope.

The GitHub entrypoint will need:

- A production `GitHubProvider`.
- A production `EvidenceNormalizer`.
- A production `EnrichmentStore`.
- `createGitHubEnrichmentStages` composed with `createGitHubEnrichmentTasks`.

The TikHub entrypoint will need:

- A production `TikHubProvider`.
- A production `TikHubStore`.
- `createTikHubEnrichmentStages` composed with `createTikHubEnrichmentTasks`.

Both graphs belong in this package and deploy through `trigger.config.ts` as one Trigger.dev project version. Backend callers should use `tasks.trigger()` with type-only imports from this package once public orchestration tasks are exported.
