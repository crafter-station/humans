import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { assertProductionDeployConfirmation } from "../../../scripts/release-confirmation.mjs";
import {
  TRIGGER_TARGETS,
  assertEnvironmentValidationEnabled,
  assertGitReleaseProvenance,
  parseTriggerDeployOutput,
  readTriggerRelease,
  releaseManifestPath,
  withoutAutomaticGitMetadata,
  writeReleaseManifest,
} from "../../../scripts/release-manifest.mjs";

const packageDirectory = new URL("..", import.meta.url);
const repositoryDirectory = new URL("../../..", import.meta.url);

export const triggerDeployArguments = ({ dryRun, release, target }) => [
  "trigger",
  "deploy",
  "--env",
  "prod",
  "--project-ref",
  target,
  "--external-id",
  release,
  "--skip-update-check",
  "--skip-telemetry",
  "--build-logs",
  "full",
  ...(dryRun ? ["--dry-run"] : []),
];

export const main = async (
  arguments_ = process.argv.slice(2),
  environmentVariables = process.env,
) => {
  assertEnvironmentValidationEnabled(environmentVariables);
  const [environment, option] = arguments_;
  if (
    !environment ||
    !Object.hasOwn(TRIGGER_TARGETS, environment) ||
    (option && option !== "--dry-run")
  ) {
    throw new Error("Usage: deploy.mjs <preview|production> [--dry-run]");
  }
  const dryRun = option === "--dry-run";
  const target = TRIGGER_TARGETS[environment];
  const release = runGit(["rev-parse", "HEAD"]);
  assertGitReleaseProvenance({
    branch: runGit(["branch", "--show-current"]),
    release,
    remoteUrl: runGit(["remote", "get-url", "origin"]),
    status: runGit(["status", "--porcelain=v1", "--untracked-files=all"]),
    upstream: runGit([
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]),
  });
  assertProductionDeployConfirmation({
    confirmation:
      environmentVariables.HUMANS_PRODUCTION_DEPLOY_CONFIRMATION?.trim(),
    environment,
    release,
    service: "trigger",
    target,
  });

  const accessToken = environmentVariables.TRIGGER_ACCESS_TOKEN?.trim();
  if (!dryRun && !/^tr_pat_[A-Za-z0-9_-]+$/.test(accessToken ?? "")) {
    throw new Error(
      "TRIGGER_ACCESS_TOKEN is required to record an authoritative deployment",
    );
  }

  const manifest = releaseManifestPath("trigger", environment);
  const outputPath = new URL(
    `.trigger-cli-${process.pid}-${randomUUID()}.env`,
    new URL(".", manifest),
  );
  mkdirSync(new URL(".", outputPath), { mode: 0o700, recursive: true });
  writeFileSync(outputPath, "", { flag: "wx", mode: 0o600 });
  chmodSync(outputPath, 0o600);

  try {
    const providerEnvironment = withoutAutomaticGitMetadata({
      ...environmentVariables,
      GITHUB_ENV: outputPath.pathname,
      SENTRY_RELEASE: release,
      TRIGGER_PROJECT_REF: target,
    });
    const result = runDeploy(
      triggerDeployArguments({ dryRun, release, target }),
      providerEnvironment,
    );
    if (dryRun) return;

    const deployment = parseTriggerDeployOutput({
      environmentOutput: readFileSync(outputPath, "utf8"),
      output: `${result.stdout}\n${result.stderr}`,
      release,
      target,
    });
    const provider = await readTriggerRelease({
      accessToken,
      ...deployment,
      environment,
      release,
    });
    writeReleaseManifest({
      environment,
      provider,
      release,
      service: "trigger",
    });
    console.log(
      `Recorded ${target} deployment ${provider.deploymentId} / version ${provider.deploymentVersion}`,
    );
  } finally {
    rmSync(outputPath, { force: true });
  }
};

const runGit = (arguments_) => {
  const result = spawnSync("git", arguments_, {
    cwd: repositoryDirectory,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git exited with status ${result.status}`);
  }
  return (result.stdout ?? "").trim();
};

const runDeploy = (arguments_, environment) => {
  const result = spawnSync("bunx", arguments_, {
    cwd: packageDirectory,
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`bunx exited with status ${result.status}`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
