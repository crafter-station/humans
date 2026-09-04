import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

import {
  assertEnvironmentValidationEnabled,
  assertGitReleaseProvenance,
  readReleaseLineage,
  reattestReleaseLineage,
  withoutAutomaticGitMetadata,
} from "../../../scripts/release-manifest.mjs";
import {
  VERCEL_OWNER_ID,
  VERCEL_PROJECT_ID,
  assertPreviewAcceptance,
  assertVercelEnvironmentInventory,
  assertVercelReleaseGuard,
} from "./release-guards.mjs";

const [environment] = process.argv.slice(2);
if (environment !== "preview" && environment !== "production") {
  throw new Error("Usage: deploy.mjs <preview|production>");
}

const scope = "crafter-station";
const vercelVersion = "50.39.0";
const repositoryDirectory = new URL("../../..", import.meta.url);

assertEnvironmentValidationEnabled(process.env);

const release = run(
  "git",
  ["rev-parse", "HEAD"],
  repositoryDirectory,
  true,
).trim();
assertGitReleaseProvenance({
  branch: run(
    "git",
    ["branch", "--show-current"],
    repositoryDirectory,
    true,
  ).trim(),
  release,
  remoteUrl: run(
    "git",
    ["remote", "get-url", "origin"],
    repositoryDirectory,
    true,
  ).trim(),
  status: run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    repositoryDirectory,
    true,
  ).trim(),
  upstream: run(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    repositoryDirectory,
    true,
  ).trim(),
});

const link = JSON.parse(
  readFileSync(new URL("../.vercel/project.json", import.meta.url), "utf8"),
);
if (
  link.projectId !== VERCEL_PROJECT_ID ||
  link.orgId !== VERCEL_OWNER_ID ||
  link.projectName !== "humans"
) {
  throw new Error("The linked Vercel project is not Humans");
}
const project = JSON.parse(
  run(
    "bunx",
    [
      `vercel@${vercelVersion}`,
      "api",
      `/v9/projects/${VERCEL_PROJECT_ID}`,
      "--scope",
      scope,
      "--raw",
    ],
    repositoryDirectory,
    true,
  ),
);
const configuration = JSON.parse(
  readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
);
assertVercelReleaseGuard(project, configuration);
const environmentInventory = JSON.parse(
  run(
    "bunx",
    [
      `vercel@${vercelVersion}`,
      "api",
      `/v10/projects/${VERCEL_PROJECT_ID}/env`,
      "--scope",
      scope,
      "--raw",
    ],
    repositoryDirectory,
    true,
  ),
);
assertVercelEnvironmentInventory(environmentInventory);
if (environment === "production") {
  const receiptPath = new URL(
    "../.vercel/accepted-preview.json",
    import.meta.url,
  );
  assertPreviewAcceptance(
    JSON.parse(readFileSync(receiptPath, "utf8")),
    release,
    { mode: statSync(receiptPath).mode },
  );
  const lineage = readReleaseLineage(environment, release);
  await reattestReleaseLineage(lineage, {
    accessToken: process.env.TRIGGER_ACCESS_TOKEN?.trim(),
  });
}

run(
  "bunx",
  [
    `vercel@${vercelVersion}`,
    "deploy",
    "--yes",
    "--scope",
    scope,
    ...(environment === "preview"
      ? ["--target", "preview", "--skip-domain", "--force"]
      : ["--prod", "--skip-domain", "--force"]),
    "--build-env",
    `HUMANS_RELEASE=${release}`,
    "--build-env",
    `SENTRY_RELEASE=${release}`,
    "--build-env",
    `HUMANS_RELEASE_ENVIRONMENT=${environment}`,
    "--env",
    `SENTRY_RELEASE=${release}`,
    "--env",
    `HUMANS_RELEASE_ENVIRONMENT=${environment}`,
    "--meta",
    `humansRelease=${release}`,
    "--meta",
    `humansEnvironment=${environment}`,
  ],
  repositoryDirectory,
  false,
  deploymentEnvironment({
    ...process.env,
    VERCEL_ORG_ID: VERCEL_OWNER_ID,
    VERCEL_PROJECT_ID,
  }),
);

function run(command, arguments_, cwd, capture, env = process.env) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env,
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return capture ? (result.stdout ?? "") : "";
}

function deploymentEnvironment(environment_) {
  return withoutAutomaticGitMetadata(environment_);
}
