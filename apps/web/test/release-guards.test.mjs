import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  API_TARGETS,
  TRIGGER_TARGETS,
} from "../../../scripts/release-manifest.mjs";
import {
  PRODUCTION_ACCEPTANCE_URL,
  VERCEL_OWNER_ID,
  VERCEL_PROJECT_ID,
  apiAcceptanceEnvironment,
  assertFrozenDeployment,
  assertOnlyTemporaryDeploymentAlias,
  assertPreviewAcceptance,
  assertProductionAcceptance,
  assertProductionAcceptanceDomain,
  assertProductionAcceptanceUrl,
  assertPublicProductionAliasesUnchanged,
  assertPublicReleaseResponses,
  assertTemporaryAliasAssignment,
  assertTemporaryAliasAvailable,
  assertTemporaryAliasIdentity,
  assertVercelEnvironmentInventory,
  assertVercelReleaseGuard,
  requiredVercelEnvironmentKeys,
  selectVercelAliasInventory,
  snapshotPublicProductionAliases,
} from "../scripts/release-guards.mjs";

const release = "a".repeat(40);
const deploymentId = "dpl_ReleaseCandidate123";
const deploymentUrl = new URL(
  "https://humans-abcdef123-crafter-station.vercel.app/",
);
const productionAcceptanceHostname = new URL(PRODUCTION_ACCEPTANCE_URL)
  .hostname;
const acceptedAt = Date.parse("2026-09-03T12:00:00.000Z");
const attestedAt = "2026-09-03T11:59:00.000Z";
const deployment = {
  alias: [],
  aliasAssigned: true,
  autoAssignCustomDomains: null,
  createdAt: acceptedAt - 120_000,
  gitRepo: {
    defaultBranch: "main",
    path: "crafter-station/humans",
    repoId: 1_318_774_404,
  },
  id: deploymentId,
  meta: {
    githubCommitOrg: "crafter-station",
    githubCommitRef: "main",
    githubCommitRepo: "humans",
    githubCommitSha: release,
    humansEnvironment: "production",
    humansRelease: release,
  },
  name: "humans",
  oidcTokenClaims: {
    environment: "production",
    owner_id: VERCEL_OWNER_ID,
    project_id: VERCEL_PROJECT_ID,
  },
  ownerId: VERCEL_OWNER_ID,
  projectId: VERCEL_PROJECT_ID,
  readyState: "READY",
  source: "cli",
  target: "production",
  url: deploymentUrl.hostname,
};

describe("Vercel release guards", () => {
  it.each([
    ["staging", "scripts/deploy.mjs", ["preview"]],
    ["promotion", "scripts/promote-production.mjs", []],
  ])(
    "rejects disabled environment validation before web %s",
    (_label, script, arguments_) => {
      const result = spawnSync("node", [script, ...arguments_], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: { ...process.env, SKIP_ENV_VALIDATION: "1" },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("environment validation disabled");
    },
  );

  it("requires the exact Git link and both automatic deployment controls", () => {
    const project = {
      accountId: VERCEL_OWNER_ID,
      autoExposeSystemEnvs: true,
      git: null,
      gitProviderOptions: { createDeployments: "disabled" },
      id: VERCEL_PROJECT_ID,
      link: {
        deployHooks: [],
        org: "crafter-station",
        productionBranch: "main",
        repo: "humans",
        repoId: 1_318_774_404,
        type: "github",
      },
      name: "humans",
      rootDirectory: "apps/web",
    };
    expect(() =>
      assertVercelReleaseGuard(project, {
        git: { deploymentEnabled: false },
      }),
    ).not.toThrow();
    expect(() =>
      assertVercelReleaseGuard(project, {
        git: { deploymentEnabled: true },
      }),
    ).toThrow("release guard");
    expect(() =>
      assertVercelReleaseGuard(
        { ...project, link: { ...project.link, productionBranch: "develop" } },
        { git: { deploymentEnabled: false } },
      ),
    ).toThrow("release guard");
    expect(() =>
      assertVercelReleaseGuard(
        { ...project, git: { deploymentEnabled: true } },
        { git: { deploymentEnabled: false } },
      ),
    ).toThrow("release guard");
  });

  it("requires exact Preview and Production environment scopes and keys", () => {
    const envs = ["preview", "production"].flatMap((environment) =>
      requiredVercelEnvironmentKeys.map((key) => ({
        gitBranch: null,
        key,
        target: [environment],
      })),
    );
    const inventory = { envs, hiddenProductionEnvCount: 0 };
    expect(() => assertVercelEnvironmentInventory(inventory)).not.toThrow();
    expect(requiredVercelEnvironmentKeys).toContain(
      "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
    );
    expect(requiredVercelEnvironmentKeys).toContain("TURNSTILE_SECRET_KEY");
    expect(() =>
      assertVercelEnvironmentInventory({
        ...inventory,
        envs: envs.filter(
          (variable) =>
            variable.key !== "CLERK_SECRET_KEY" ||
            variable.target[0] !== "preview",
        ),
      }),
    ).toThrow("incomplete");
    expect(() =>
      assertVercelEnvironmentInventory({
        ...inventory,
        envs: envs.map((variable) =>
          variable.key === "CLERK_SECRET_KEY" &&
          variable.target[0] === "preview"
            ? { ...variable, target: ["preview", "production"] }
            : variable,
        ),
      }),
    ).toThrow("not isolated");
    expect(() =>
      assertVercelEnvironmentInventory({
        envs,
        hiddenProductionEnvCount: 1,
      }),
    ).toThrow("unavailable");
    expect(() =>
      assertVercelEnvironmentInventory({
        ...inventory,
        envs: [...envs, { key: "SENTRY_RELEASE", target: ["production"] }],
      }),
    ).toThrow("not isolated");
  });

  it("binds Production staging to recent complete Preview lineage", () => {
    const receipt = acceptanceReceipt("preview");
    expect(() =>
      assertPreviewAcceptance(receipt, release, {
        mode: 0o100600,
        now: acceptedAt + 60_000,
      }),
    ).not.toThrow();
    expect(() =>
      assertPreviewAcceptance(receipt, "b".repeat(40), {
        mode: 0o100600,
        now: acceptedAt + 60_000,
      }),
    ).toThrow("Preview acceptance");
    expect(() =>
      assertPreviewAcceptance(receipt, release, {
        mode: 0o100644,
        now: acceptedAt + 60_000,
      }),
    ).toThrow("Preview acceptance");
    expect(() =>
      assertPreviewAcceptance(
        {
          ...receipt,
          lineage: {
            ...receipt.lineage,
            trigger: {
              ...receipt.lineage.trigger,
              release: "b".repeat(40),
            },
          },
        },
        release,
        { mode: 0o100600, now: acceptedAt + 60_000 },
      ),
    ).toThrow("Preview acceptance");
  });

  it("binds Production acceptance to its web and provider identities", () => {
    const receipt = acceptanceReceipt("production");
    const verified = {
      deploymentCreatedAt: deployment.createdAt,
      deploymentId,
      deploymentUrl: deploymentUrl.href,
      release,
    };
    expect(() =>
      assertProductionAcceptance(receipt, verified, {
        mode: 0o100600,
        now: acceptedAt + 60_000,
      }),
    ).not.toThrow();
    expect(() =>
      assertProductionAcceptance(
        receipt,
        { ...verified, deploymentId: "dpl_Different" },
        { mode: 0o100600, now: acceptedAt + 60_000 },
      ),
    ).toThrow("staged deployment");
  });

  it("accepts only unused non-public owned Production acceptance origins", () => {
    expect(
      assertProductionAcceptanceUrl(PRODUCTION_ACCEPTANCE_URL).hostname,
    ).toBe("acceptance.humans.crafter.run");
    expect(() =>
      assertProductionAcceptanceUrl("https://humans.crafter.run/"),
    ).toThrow("fixed Production acceptance URL");
    expect(() =>
      assertProductionAcceptanceUrl(
        "https://humans-acceptance.crafter.run/path",
      ),
    ).toThrow("fixed Production acceptance URL");
    expect(() =>
      assertProductionAcceptanceUrl(
        "https://another.acceptance.humans.crafter.run/",
      ),
    ).toThrow("fixed Production acceptance URL");
    expect(() =>
      assertProductionAcceptanceUrl("https://acceptance.humans.crafter.run"),
    ).toThrow("fixed Production acceptance URL");
    expect(() =>
      assertTemporaryAliasAvailable(
        {
          aliases: [{ alias: productionAcceptanceHostname }],
          pagination: { count: 1 },
        },
        productionAcceptanceHostname,
      ),
    ).toThrow("in use");

    const inventory = selectVercelAliasInventory(
      [
        { alias: "unrelated.crafter.run" },
        { alias: productionAcceptanceHostname },
      ],
      productionAcceptanceHostname,
    );
    expect(inventory.pagination.count).toBe(1);
    expect(() =>
      assertTemporaryAliasAvailable(inventory, productionAcceptanceHostname),
    ).toThrow("in use");
  });

  it("requires the fixed canary to be an unbound verified project domain", () => {
    const domain = {
      apexName: "crafter.run",
      customEnvironmentId: null,
      gitBranch: null,
      name: productionAcceptanceHostname,
      projectId: VERCEL_PROJECT_ID,
      redirect: null,
      redirectStatusCode: null,
      verified: true,
    };
    expect(() => assertProductionAcceptanceDomain(domain)).not.toThrow();
    expect(() =>
      assertProductionAcceptanceDomain({ ...domain, verified: false }),
    ).toThrow("canary domain");
    expect(() =>
      assertProductionAcceptanceDomain({
        ...domain,
        customEnvironmentId: "env_other",
      }),
    ).toThrow("canary domain");
    expect(() =>
      assertProductionAcceptanceDomain({
        ...domain,
        gitBranch: "main",
      }),
    ).toThrow("canary domain");
    expect(() =>
      assertProductionAcceptanceDomain({
        ...domain,
        redirect: "humans.crafter.run",
        redirectStatusCode: 308,
      }),
    ).toThrow("canary domain");
    expect(() =>
      assertProductionAcceptanceDomain({
        ...domain,
        projectId: "prj_other",
      }),
    ).toThrow("canary domain");
  });

  it("overrides the API acceptance Worker version with the manifest identity", () => {
    const versionId = "11111111-1111-4111-8111-111111111111";
    expect(
      apiAcceptanceEnvironment(
        { HUMANS_ACCEPTANCE_WORKER_VERSION_ID: "caller-value" },
        versionId,
      ).HUMANS_ACCEPTANCE_WORKER_VERSION_ID,
    ).toBe(versionId);
  });

  it("binds the temporary alias UID to only the staged deployment", () => {
    const identity = assertTemporaryAliasAssignment(
      {
        alias: productionAcceptanceHostname,
        uid: "alias_uid",
      },
      {
        deploymentId,
        hostname: productionAcceptanceHostname,
      },
    );
    const alias = {
      alias: identity.hostname,
      deletedAt: null,
      deployment: { id: deploymentId },
      deploymentId,
      projectId: VERCEL_PROJECT_ID,
      uid: identity.uid,
    };
    expect(() =>
      assertTemporaryAliasIdentity(alias, {
        ...identity,
        projectId: VERCEL_PROJECT_ID,
      }),
    ).not.toThrow();
    expect(() =>
      assertOnlyTemporaryDeploymentAlias(
        { aliases: [{ alias: identity.hostname, uid: identity.uid }] },
        identity,
      ),
    ).not.toThrow();
    expect(() =>
      assertTemporaryAliasAssignment(
        { ...alias, oldDeploymentId: "dpl_Public" },
        identity,
      ),
    ).toThrow("moved");
  });

  it("detects any public alias movement during staged acceptance", () => {
    const records = [
      publicAlias("api.humans.crafter.run", "alias_api"),
      publicAlias("humans.crafter.run", "alias_web"),
    ];
    const before = snapshotPublicProductionAliases(records, VERCEL_PROJECT_ID);
    expect(() =>
      assertPublicProductionAliasesUnchanged(before, [...before]),
    ).not.toThrow();
    expect(() =>
      assertPublicProductionAliasesUnchanged(before, [
        { ...before[0], deploymentId },
        before[1],
      ]),
    ).toThrow("moved");
  });

  it("requires release and environment headers from public web and API", () => {
    const response = {
      headers: new Headers({
        "x-humans-environment": "production",
        "x-humans-release": release,
      }),
      status: 200,
    };
    expect(() =>
      assertPublicReleaseResponses({ api: response, release, web: response }),
    ).not.toThrow();
    expect(() =>
      assertPublicReleaseResponses({
        api: { ...response, status: 404 },
        release,
        web: response,
      }),
    ).toThrow("public Production API");
  });

  it("rejects staged Production deployments with any alias", () => {
    const input = frozenDeploymentInput();
    expect(() => assertFrozenDeployment(input)).not.toThrow();
    expect(() =>
      assertFrozenDeployment({
        ...input,
        deployment: { ...deployment, alias: ["humans.crafter.run"] },
      }),
    ).toThrow("frozen release");
    expect(() =>
      assertFrozenDeployment({
        ...input,
        deploymentAliases: { aliases: [{ alias: "humans.crafter.run" }] },
      }),
    ).toThrow("frozen release");
    expect(() =>
      assertFrozenDeployment({
        ...input,
        deployment: {
          ...deployment,
          meta: { ...deployment.meta, gitDirty: "1" },
        },
      }),
    ).toThrow("frozen release");
    expect(() =>
      assertFrozenDeployment({
        ...input,
        deployment: { ...deployment, source: "git" },
      }),
    ).toThrow("frozen release");
  });

  it("requires repository and OIDC data explicitly requested from Vercel", () => {
    const input = frozenDeploymentInput();
    expect(() =>
      assertFrozenDeployment({
        ...input,
        deployment: { ...deployment, gitRepo: null },
      }),
    ).toThrow("frozen release");
    expect(() =>
      assertFrozenDeployment({
        ...input,
        deployment: {
          ...deployment,
          oidcTokenClaims: {
            ...deployment.oidcTokenClaims,
            environment: "preview",
          },
        },
      }),
    ).toThrow("frozen release");
  });
});

function acceptanceReceipt(environment) {
  return {
    acceptedAt: new Date(acceptedAt).toISOString(),
    ...(environment === "production"
      ? {
          acceptanceAlias: {
            deploymentId,
            hostname: productionAcceptanceHostname,
            uid: "alias_uid",
          },
        }
      : {}),
    deploymentCreatedAt: deployment.createdAt,
    deploymentId,
    deploymentUrl: deploymentUrl.href,
    environment,
    lineage: {
      api: releaseManifest("api", environment),
      trigger: releaseManifest("trigger", environment),
    },
    release,
    version: 2,
  };
}

function releaseManifest(service, environment) {
  return {
    attestedAt,
    environment,
    kind: "humans-release-provider",
    provider:
      service === "api"
        ? {
            accountId: "541e1e926ecd3c40c0b204180978349f",
            deployedAt: attestedAt,
            deploymentId: "11111111-1111-4111-8111-111111111111",
            name: "cloudflare-workers",
            versionId: "22222222-2222-4222-8222-222222222222",
          }
        : {
            deployedAt: attestedAt,
            deploymentId: "deployment_Release123",
            deploymentShortCode: "release123",
            deploymentVersion: "20260903.1",
            externalId: release,
            name: "trigger.dev",
            projectId: "internal_project_123",
          },
    release,
    service,
    target:
      service === "api"
        ? API_TARGETS[environment]
        : TRIGGER_TARGETS[environment],
    version: 1,
  };
}

function frozenDeploymentInput() {
  return {
    allowPromoted: false,
    deployment,
    deploymentAliases: { aliases: [] },
    deploymentId,
    deploymentUrl,
    environment: "production",
    ownerId: VERCEL_OWNER_ID,
    projectId: VERCEL_PROJECT_ID,
    release,
  };
}

function publicAlias(alias, uid) {
  return {
    alias,
    deletedAt: null,
    deploymentId: "dpl_CurrentPublic",
    projectId: VERCEL_PROJECT_ID,
    uid,
  };
}
