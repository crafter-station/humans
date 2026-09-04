import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import process from "node:process";

import { assertProductionDeployConfirmation } from "../../../scripts/release-confirmation.mjs";
import {
  API_TARGETS,
  assertEnvironmentValidationEnabled,
  assertGitReleaseProvenance,
  cloudflareReleaseMessage,
  readCloudflareRelease,
  withoutAutomaticGitMetadata,
  writeReleaseManifest,
} from "../../../scripts/release-manifest.mjs";

const [environment, project] = process.argv.slice(2);
if (!environment || !project) {
  throw new Error("Usage: deploy-with-sentry.mjs <environment> <project>");
}
const sentryProjects = {
  preview: "humans-preview",
  production: "humans",
};
if (sentryProjects[environment] !== project) {
  throw new Error("The Worker environment and Sentry project do not match");
}
assertEnvironmentValidationEnabled(process.env);
if (!process.env.SENTRY_AUTH_TOKEN?.trim()) {
  throw new Error("SENTRY_AUTH_TOKEN is required to upload Worker source maps");
}
const release = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
assertGitReleaseProvenance({
  branch: run("git", ["branch", "--show-current"], { capture: true }).trim(),
  release,
  remoteUrl: run("git", ["remote", "get-url", "origin"], {
    capture: true,
  }).trim(),
  status: run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    capture: true,
  }).trim(),
  upstream: run(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { capture: true },
  ).trim(),
});
assertProductionDeployConfirmation({
  confirmation: process.env.HUMANS_PRODUCTION_DEPLOY_CONFIRMATION?.trim(),
  environment,
  release,
  service: "api",
  target: `humans-api-${environment}`,
});
const outputDirectory = "dist";
const releaseMessage = cloudflareReleaseMessage(environment, release);
const providerEnvironment = withoutAutomaticGitMetadata(process.env);
rmSync(outputDirectory, { force: true, recursive: true });

try {
  run(
    "bunx",
    [
      "wrangler",
      "deploy",
      "--dry-run",
      "--env",
      environment,
      "--outdir",
      outputDirectory,
      "--upload-source-maps",
      "--message",
      releaseMessage,
      "--var",
      `SENTRY_RELEASE:${release}`,
    ],
    { env: providerEnvironment },
  );
  const releaseInfo = run(
    "bunx",
    [
      "sentry-cli",
      "releases",
      "info",
      "--quiet",
      "--org",
      "cueva",
      "--project",
      project,
      release,
    ],
    { allowFailure: true },
  );
  if (releaseInfo.status !== 0) {
    run("bunx", [
      "sentry-cli",
      "releases",
      "new",
      "--org",
      "cueva",
      "--project",
      project,
      release,
    ]);
  }
  run("bunx", [
    "sentry-cli",
    "sourcemaps",
    "upload",
    "--org",
    "cueva",
    "--project",
    project,
    "--release",
    release,
    "--strict",
    "--validate",
    "--wait",
    "--strip-prefix",
    `${outputDirectory}/..`,
    outputDirectory,
  ]);
  // Publish the artifact Sentry validated rather than rebuilding different bytes.
  run(
    "bunx",
    [
      "wrangler",
      "deploy",
      `${outputDirectory}/index.js`,
      "--no-bundle",
      "--strict",
      "--env",
      environment,
      "--upload-source-maps",
      "--message",
      releaseMessage,
      "--var",
      `SENTRY_RELEASE:${release}`,
    ],
    { env: providerEnvironment },
  );
  const provider = readCloudflareRelease({ environment, release });
  writeReleaseManifest({
    environment,
    provider,
    release,
    service: "api",
  });
  console.log(
    `Recorded ${API_TARGETS[environment]} deployment ${provider.deploymentId} / version ${provider.versionId}`,
  );
} finally {
  rmSync(outputDirectory, { force: true, recursive: true });
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return options.capture ? (result.stdout ?? "") : result;
}
