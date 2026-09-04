import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  TRIGGER_TARGETS,
  assertEnvironmentValidationEnabled,
  assertGitReleaseProvenance,
  assertReleaseManifest,
  parseTriggerDeployOutput,
  readCloudflareRelease,
  readTriggerRelease,
  writeReleaseManifest,
} from "../../../scripts/release-manifest.mjs";

const release = "a".repeat(40);
const now = Date.parse("2026-09-03T12:00:00.000Z");
const deployedAt = "2026-09-03T11:59:00.000Z";
const cloudflareDeploymentId = "11111111-1111-4111-8111-111111111111";
const cloudflareVersionId = "22222222-2222-4222-8222-222222222222";
const triggerDeploymentId = "deployment_Release123";
const triggerVersion = "20260903.1";
const triggerShortCode = "release123";
const temporaryDirectories = [];

const apiProvider = {
  accountId: "541e1e926ecd3c40c0b204180978349f",
  deployedAt,
  deploymentId: cloudflareDeploymentId,
  name: "cloudflare-workers",
  versionId: cloudflareVersionId,
};

const triggerProvider = {
  deployedAt,
  deploymentId: triggerDeploymentId,
  deploymentShortCode: triggerShortCode,
  deploymentVersion: triggerVersion,
  externalId: release,
  name: "trigger.dev",
  projectId: "internal_project_123",
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("release manifests", () => {
  it("rejects disabled environment validation for every deployment", () => {
    expect(() =>
      assertEnvironmentValidationEnabled({ SKIP_ENV_VALIDATION: "1" }),
    ).toThrow("environment validation disabled");
    expect(() =>
      assertEnvironmentValidationEnabled({ SKIP_ENV_VALIDATION: "0" }),
    ).not.toThrow();
  });

  it("rejects disabled environment validation before API deployment", () => {
    const result = spawnSync(
      "node",
      ["scripts/deploy-with-sentry.mjs", "preview", "humans-preview"],
      {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: { ...process.env, SKIP_ENV_VALIDATION: "1" },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("environment validation disabled");
  });

  it("requires clean crafter-station/humans main provenance", () => {
    const provenance = {
      branch: "main",
      release,
      remoteUrl: "https://github.com/crafter-station/humans.git",
      status: "",
      upstream: "origin/main",
    };
    expect(() => assertGitReleaseProvenance(provenance)).not.toThrow();
    expect(() =>
      assertGitReleaseProvenance({ ...provenance, status: " M app.ts" }),
    ).toThrow("dirty worktree");
    expect(() =>
      assertGitReleaseProvenance({ ...provenance, branch: "release" }),
    ).toThrow("crafter-station/humans@main");
  });

  it("writes an atomic mode-600, secret-free provider record", () => {
    const root = makeTemporaryDirectory();
    const path = new URL("api.json", pathUrl(root));
    const manifest = writeReleaseManifest({
      attestedAt: new Date(now).toISOString(),
      environment: "preview",
      path,
      provider: apiProvider,
      release,
      service: "api",
    });

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(manifest);
    expect(() =>
      assertReleaseManifest(manifest, {
        environment: "preview",
        mode: statSync(path).mode,
        now: now + 24 * 60 * 60_000 + 1,
        release,
        service: "api",
      }),
    ).toThrow("older than 24 hours");
    expect(() =>
      assertReleaseManifest(manifest, {
        environment: "preview",
        mode: 0o100400,
        now,
        release,
        service: "api",
      }),
    ).toThrow("mode 600");
    expect(() =>
      writeReleaseManifest({
        attestedAt: new Date(now).toISOString(),
        environment: "preview",
        path: new URL("unsafe.json", pathUrl(root)),
        provider: { ...apiProvider, token: "secret" },
        release,
        service: "api",
      }),
    ).toThrow("unexpected or missing fields");
  });

  it("uses only Cloudflare read APIs and binds deployment to version", () => {
    const calls = [];
    const deployment = cloudflareDeployment();
    const version = cloudflareVersion();
    const provider = readCloudflareRelease(
      { environment: "preview", release },
      {
        runWrangler(arguments_) {
          calls.push(arguments_);
          return calls.length === 1 ? deployment : version;
        },
      },
    );

    expect(provider).toEqual(apiProvider);
    expect(calls).toEqual([
      [
        "deployments",
        "status",
        "--env",
        "preview",
        "--name",
        "humans-api-preview",
        "--json",
      ],
      [
        "versions",
        "view",
        cloudflareVersionId,
        "--env",
        "preview",
        "--name",
        "humans-api-preview",
        "--json",
      ],
    ]);
    expect(() =>
      readCloudflareRelease(
        {
          environment: "preview",
          expectedProvider: {
            ...apiProvider,
            deploymentId: "33333333-3333-4333-8333-333333333333",
          },
          release,
        },
        {
          runWrangler: (arguments_) =>
            arguments_[0] === "deployments" ? deployment : version,
        },
      ),
    ).toThrow("changed after attestation");
  });

  it("binds Trigger deploy output to the selected project and external SHA", () => {
    const target = TRIGGER_TARGETS.preview;
    expect(
      parseTriggerDeployOutput({
        environmentOutput: triggerEnvironmentOutput(target),
        output: `Version ${triggerVersion} deployed with 4 detected tasks`,
        release,
        target,
      }),
    ).toEqual({
      deploymentShortCode: triggerShortCode,
      deploymentVersion: triggerVersion,
    });
    expect(() =>
      parseTriggerDeployOutput({
        environmentOutput: triggerEnvironmentOutput(TRIGGER_TARGETS.production),
        output: `Version ${triggerVersion} deployed with 4 detected tasks`,
        release,
        target,
      }),
    ).toThrow("unambiguous");
  });

  it("revalidates Trigger project, environment, current version, and deployment with GET", async () => {
    const calls = [];
    const responses = [
      {
        externalRef: TRIGGER_TARGETS.preview,
        id: triggerProvider.projectId,
        name: "Humans Preview",
      },
      {
        apiKey: "tr_prod_environment_key",
        apiUrl: "https://api.trigger.dev",
        name: "Humans Preview",
        projectId: triggerProvider.projectId,
      },
      triggerCurrent(),
      {
        commitSHA: release,
        id: triggerDeploymentId,
        shortCode: triggerShortCode,
        status: "DEPLOYED",
        version: triggerVersion,
      },
    ];
    const provider = await readTriggerRelease(
      {
        accessToken: "tr_pat_release_operator",
        deploymentShortCode: triggerShortCode,
        deploymentVersion: triggerVersion,
        environment: "preview",
        release,
      },
      {
        async fetchImplementation(url, init) {
          calls.push({
            authorization: init.headers.authorization,
            method: init.method,
            path: url.pathname,
          });
          return new Response(JSON.stringify(responses[calls.length - 1]));
        },
      },
    );

    expect(provider).toEqual(triggerProvider);
    expect(calls.map((call) => call.method)).toEqual([
      "GET",
      "GET",
      "GET",
      "GET",
    ]);
    expect(calls.map((call) => call.path)).toEqual([
      `/api/v1/projects/${TRIGGER_TARGETS.preview}`,
      `/api/v1/projects/${TRIGGER_TARGETS.preview}/prod`,
      "/api/v1/deployments/current",
      `/api/v1/deployments/${triggerDeploymentId}`,
    ]);
    expect(calls[0].authorization).toBe("Bearer tr_pat_release_operator");
    expect(calls[2].authorization).toBe("Bearer tr_prod_environment_key");
  });
});

function cloudflareDeployment() {
  return {
    annotations: {
      "workers/message": `humans-release:preview:${release}`,
    },
    created_on: deployedAt,
    id: cloudflareDeploymentId,
    source: "wrangler",
    strategy: "percentage",
    versions: [{ percentage: 100, version_id: cloudflareVersionId }],
  };
}

function cloudflareVersion() {
  return {
    annotations: {
      "workers/message": `humans-release:preview:${release}`,
    },
    id: cloudflareVersionId,
    metadata: { source: "wrangler" },
    resources: { script: { last_deployed_from: "wrangler" } },
  };
}

function triggerCurrent() {
  return {
    deployedAt,
    git: {
      commitRef: "main",
      commitSha: release,
      dirty: false,
      remoteUrl: "https://github.com/crafter-station/humans.git",
      source: "local",
    },
    id: triggerDeploymentId,
    shortCode: triggerShortCode,
    status: "DEPLOYED",
    version: triggerVersion,
  };
}

function triggerEnvironmentOutput(target) {
  return [
    `TRIGGER_DEPLOYMENT_VERSION=${triggerVersion}`,
    `TRIGGER_VERSION=${triggerVersion}`,
    `TRIGGER_DEPLOYMENT_SHORT_CODE=${triggerShortCode}`,
    `TRIGGER_DEPLOYMENT_URL=https://cloud.trigger.dev/projects/v3/${target}/deployments/${triggerShortCode}`,
    "TRIGGER_TEST_URL=https://cloud.trigger.dev/test",
  ].join("\n");
}

function makeTemporaryDirectory() {
  const parent = fileURLToPath(
    new URL("../../../scripts/release-manifests/", import.meta.url),
  );
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(`${parent}test-`);
  temporaryDirectories.push(directory);
  return directory;
}

function pathUrl(directory) {
  return new URL(`file://${directory}/`);
}
