# Trigger.dev monorepo layout

## Current state

This repository has no `trigger.config.ts` file. Trigger.dev task factories currently live in:

- `packages/github-enrichment/src/trigger.ts`
- `packages/tikhub-enrichment/src/trigger.ts`

Those modules export factory functions, not concrete task instances. Trigger.dev discovers JavaScript and TypeScript files under the configured `dirs`, but these factories do not call `task()` until supplied with production stage handlers. Pointing `dirs` at the existing package directories would therefore not provide the required deployment composition root.

Source: [Trigger.dev config `dirs`](https://trigger.dev/docs/config/config-file#dirs)

## Recommendation

Create one `packages/tasks` workspace with one Trigger.dev project and one deployment containing both enrichment task graphs:

```text
packages/tasks/
|-- package.json
|-- trigger.config.ts
`-- src/trigger/
    |-- github.ts
    |-- tikhub.ts
    `-- index.ts
```

The files under `src/trigger` should construct concrete production handlers, invoke the existing enrichment factories at module scope, and export the resulting task instances. `apps/api` should trigger public orchestration tasks with `tasks.trigger()` and type-only task imports so it does not bundle the task implementation.

Trigger.dev's current v4 monorepo guidance uses a dedicated tasks package when tasks are shared or consumed across applications. It places the config and task entrypoints in that package. The first-party Turborepo example uses the same composition-root architecture, although some files in the example repository still use v3 package versions.

Sources:

- [Manual setup: monorepos](https://trigger.dev/docs/manual-setup#monorepo-setup)
- [First-party Turborepo tasks-package example](https://trigger.dev/docs/guides/example-projects/turborepo-monorepo-prisma)
- [Triggering tasks from a backend](https://trigger.dev/docs/triggering#triggering-from-your-backend)

`apps/trigger` would work technically, but `packages/tasks` better communicates this workspace's two roles: it is the deployment composition root and it exposes task types to backend consumers. An app workspace generally should not be imported as a library.

## Initial config

The config belongs at the root of the Trigger.dev project, which in this layout means `packages/tasks/trigger.config.ts`, not necessarily the repository root:

```ts
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "<project-ref>",
  dirs: ["./src/trigger"],
  runtime: "node-24",
});
```

Use Node 24 for deployed tasks. Trigger.dev officially supports its Node runtimes while its Bun runtime is experimental; Bun can remain the repository package manager.

Sources:

- [Config file](https://trigger.dev/docs/config/config-file)
- [Runtime configuration](https://trigger.dev/docs/config/config-file#runtime)

## Why one deployment

A Trigger.dev deployment creates one version of all tasks it discovers, and each environment has one current version. The existing orchestrators use `triggerAndWait()`, which locks child runs to the parent's exact deployment version. Both enrichment orchestrators and all of their child stages should consequently be built and promoted together.

Multiple config files targeting the same Trigger.dev project would not merge independently deployed subsets. Each deployment would create and promote a new project version from its own discovered task set. Multiple Trigger.dev projects would add credentials, environments, releases, and client configuration while weakening the simple same-version boundary around each enrichment graph.

Separate projects are warranted only for a real isolation boundary such as different ownership, credentials, billing, region, or release cadence. Source package boundaries alone are not such a boundary.

Sources:

- [Deployment versions](https://trigger.dev/docs/deployment/overview#versions)
- [Child task version locking](https://trigger.dev/docs/deployment/overview#child-tasks-and-auto-version-locking)
- [Multiple Trigger clients](https://trigger.dev/docs/management/multiple-clients)

## Alternatives

### Root config with multiple directories

The `dirs` option supports multiple paths, so one root config could scan several packages. It is a poor fit here because the existing files only export task factories, production handler composition would remain unclear, and the repository root would become the implicit deployment package. A central tasks workspace provides an explicit composition root without moving the reusable enrichment workflow code.

### Tasks in each enrichment package

Giving each enrichment package its own config and deploy script would couple reusable workflow code to independent deployment units. It would also complicate atomic versioning and CI without providing a current operational isolation requirement.

### Dedicated Trigger app

`apps/trigger` has equivalent runtime behavior and is defensible if the workspace is treated strictly as a standalone service that no other workspace imports. For Humans, typed triggering from `apps/api` and the official tasks-package monorepo convention make `packages/tasks` the clearer boundary.

## Deployment workflow

For Trigger.dev's GitHub integration, set the repository-relative config path explicitly:

```text
packages/tasks/trigger.config.ts
```

The integration can auto-detect one config anywhere in the repository, but an explicit path prevents future ambiguity. Install and pre-build commands execute from the repository root, which is compatible with the Bun workspace.

Source: [GitHub integration](https://trigger.dev/docs/github-integration#setup)

Pin all Trigger.dev packages participating in the deployment to the same exact version. The repository currently uses SDK `4.5.15`, so the initial tasks package should use:

```json
{
  "dependencies": {
    "@trigger.dev/sdk": "4.5.15"
  },
  "devDependencies": {
    "trigger.dev": "4.5.15"
  }
}
```

Add `@trigger.dev/build` at `4.5.15` only when build extensions are needed. Use package scripts for local and CI commands rather than an unpinned `bunx trigger.dev@latest`, and commit `bun.lock`.

Sources:

- [Manual setup: version pinning](https://trigger.dev/docs/manual-setup#version-pinning)
- [GitHub Actions: CLI version pinning](https://trigger.dev/docs/github-actions#cli-version-pinning)

Add `.trigger` to the repository `.gitignore`; Trigger.dev uses it for local development and build artifacts.

Source: [Manual setup: Git config](https://trigger.dev/docs/manual-setup#git-config)

## Application and task release skew

Task version locking does not by itself coordinate a newly deployed API with separately deployed tasks. Trigger.dev `4.5.15` supports external deployment IDs. Deploy tasks with the application release identifier and provide the same identifier to the running API:

```bash
trigger deploy --external-id "$GITHUB_SHA"
```

```text
TRIGGER_EXTERNAL_DEPLOYMENT_ID=<same commit SHA>
```

If the matching task deployment is still building, a run waits for it and then executes against that version. If no matching deployment arrives, the run expires after one hour.

Do not path-filter Trigger.dev deployments when using the current commit SHA unless both the API and task deploy derive the same last-task-changing commit. An API-only release that sends a SHA for which no task deployment exists would cause protected runs to wait and expire. Also remove stale `TRIGGER_VERSION` values because an explicit version takes precedence over the external deployment ID.

Sources:

- [Version skew protection](https://trigger.dev/docs/deployment/version-skew-protection)
- [Missing deployment failure mode](https://trigger.dev/docs/deployment/version-skew-protection#when-nothing-ever-lands)
- [Version precedence](https://trigger.dev/docs/deployment/version-skew-protection#precedence)

## Decision summary

Keep provider workflow logic in `packages/github-enrichment` and `packages/tikhub-enrichment`. Add `packages/tasks` as the sole production composition and deployment root, instantiate both concrete task graphs there, and deploy them through one config to one Trigger.dev project. This is simpler than separate app/package deployments and preserves atomic versions for every orchestrator and child stage.
