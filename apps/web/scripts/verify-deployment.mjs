import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { assertGitReleaseProvenance } from "../../../scripts/release-manifest.mjs";
import {
  VERCEL_OWNER_ID,
  VERCEL_PROJECT_ID,
  assertFrozenDeployment,
  assertVercelEnvironmentInventory,
  assertVercelReleaseGuard,
  selectVercelAliasInventory,
} from "./release-guards.mjs";

const scope = "crafter-station";
const vercelVersion = "50.39.0";
const repositoryDirectory = new URL("../../..", import.meta.url);

export const verifyDeployment = (
  environment,
  { allowPromoted = false } = {},
) => {
  if (environment !== "preview" && environment !== "production") {
    throw new Error("Usage: verify-deployment.mjs <preview|production>");
  }
  const deploymentId = requiredEnvironment("HUMANS_VERCEL_DEPLOYMENT_ID");
  const deploymentUrl = new URL(
    requiredEnvironment("HUMANS_VERCEL_DEPLOYMENT_URL"),
  );
  const release = requiredEnvironment("HUMANS_RELEASE_SHA");
  if (!/^dpl_[A-Za-z0-9]+$/.test(deploymentId)) {
    throw new Error("HUMANS_VERCEL_DEPLOYMENT_ID is invalid");
  }
  if (
    deploymentUrl.protocol !== "https:" ||
    !/^humans-[a-z0-9]{9}-crafter-station\.vercel\.app$/i.test(
      deploymentUrl.hostname,
    ) ||
    deploymentUrl.username ||
    deploymentUrl.password ||
    deploymentUrl.port ||
    deploymentUrl.pathname !== "/" ||
    deploymentUrl.search ||
    deploymentUrl.hash
  ) {
    throw new Error("HUMANS_VERCEL_DEPLOYMENT_URL is not immutable");
  }
  if (!/^[0-9a-f]{40}$/.test(release)) {
    throw new Error("HUMANS_RELEASE_SHA must be a full Git commit SHA");
  }
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
  const head = run("git", ["rev-parse", "HEAD"]).trim();
  if (head !== release) {
    throw new Error("HUMANS_RELEASE_SHA does not match Git HEAD");
  }
  assertGitReleaseProvenance({
    branch: run("git", ["branch", "--show-current"]).trim(),
    release: head,
    remoteUrl: run("git", ["remote", "get-url", "origin"]).trim(),
    status: run("git", [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]).trim(),
    upstream: run("git", [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]).trim(),
  });

  const project = vercelJson(`/v9/projects/${VERCEL_PROJECT_ID}`);
  const configuration = JSON.parse(
    readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
  );
  assertVercelReleaseGuard(project, configuration);
  const environmentInventory = vercelJson(
    `/v10/projects/${VERCEL_PROJECT_ID}/env`,
  );
  assertVercelEnvironmentInventory(environmentInventory);

  const deployment = vercelJson(
    `/v13/deployments/${deploymentId}?withGitRepoInfo=true`,
  );
  const deploymentAliases = vercelJson(
    `/v2/deployments/${deploymentId}/aliases`,
  );
  assertFrozenDeployment({
    allowPromoted,
    deployment,
    deploymentAliases,
    deploymentId,
    deploymentUrl,
    environment,
    ownerId: VERCEL_OWNER_ID,
    projectId: VERCEL_PROJECT_ID,
    release,
  });

  return {
    deploymentCreatedAt: deployment.createdAt,
    deploymentId,
    deploymentUrl: deploymentUrl.href,
    release,
  };
};

export const readVercelProject = () =>
  vercelJson(`/v9/projects/${VERCEL_PROJECT_ID}`);

export const readVercelAlias = (alias) =>
  vercelJson(`/v4/aliases/${encodeURIComponent(alias)}`);

export const readVercelProjectDomain = (domain) =>
  vercelJson(
    `/v9/projects/${VERCEL_PROJECT_ID}/domains/${encodeURIComponent(domain)}`,
  );

export const readVercelAliasInventory = (alias) =>
  selectVercelAliasInventory(
    vercelJson("/v4/aliases?domain=crafter.run&limit=100", {
      paginate: true,
    }),
    alias,
  );

export const readVercelDeploymentAliases = (deploymentId) =>
  vercelJson(`/v2/deployments/${deploymentId}/aliases`);

export const assignVercelAlias = (deploymentId, alias) =>
  vercelJson(`/v2/deployments/${deploymentId}/aliases`, {
    input: { alias },
    method: "POST",
  });

export const removeVercelAlias = (uid) => {
  vercelRequest(`/v2/aliases/${encodeURIComponent(uid)}`, {
    dangerouslySkipPermissions: true,
    method: "DELETE",
  });
};

export const acceptanceReceiptPath = (environment) =>
  new URL(`../.vercel/accepted-${environment}.json`, import.meta.url);

const requiredEnvironment = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const vercelJson = (path, options) => {
  const output = vercelRequest(path, options);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("Vercel returned invalid JSON");
  }
};

const vercelRequest = (
  path,
  { dangerouslySkipPermissions = false, input, method, paginate = false } = {},
) =>
  run(
    "bunx",
    [
      `vercel@${vercelVersion}`,
      "api",
      path,
      "--scope",
      scope,
      ...(method ? ["--method", method] : []),
      ...(input ? ["--input", "-"] : []),
      ...(paginate ? ["--paginate"] : []),
      ...(dangerouslySkipPermissions ? ["--dangerously-skip-permissions"] : []),
      "--raw",
    ],
    input === undefined ? undefined : JSON.stringify(input),
  );

const run = (command, arguments_, input) => {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryDirectory,
    encoding: "utf8",
    env: process.env,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return result.stdout ?? "";
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const verified = verifyDeployment(process.argv[2]);
  console.log(JSON.stringify({ environment: process.argv[2], ...verified }));
}
