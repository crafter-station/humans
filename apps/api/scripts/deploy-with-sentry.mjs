import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import process from "node:process";

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
if (!process.env.SENTRY_AUTH_TOKEN?.trim()) {
  throw new Error("SENTRY_AUTH_TOKEN is required to upload Worker source maps");
}
if (run("git", ["status", "--porcelain"], { capture: true }).trim()) {
  throw new Error("Refusing to deploy a dirty worktree");
}

const release = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
const outputDirectory = "dist";
rmSync(outputDirectory, { force: true, recursive: true });

try {
  run("bunx", [
    "wrangler",
    "deploy",
    "--dry-run",
    "--env",
    environment,
    "--outdir",
    outputDirectory,
    "--upload-source-maps",
    "--var",
    `SENTRY_RELEASE:${release}`,
  ]);
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
  run("bunx", [
    "wrangler",
    "deploy",
    `${outputDirectory}/index.js`,
    "--no-bundle",
    "--env",
    environment,
    "--upload-source-maps",
    "--var",
    `SENTRY_RELEASE:${release}`,
  ]);
} finally {
  rmSync(outputDirectory, { force: true, recursive: true });
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: process.env,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return options.capture ? (result.stdout ?? "") : result;
}
