import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

export const RELEASE_RECORD_VERSION = 1;
export const RELEASE_RECORD_MAX_AGE_MS = 24 * 60 * 60_000;

export const API_TARGETS = Object.freeze({
  preview: "humans-api-preview",
  production: "humans-api-production",
});

export const TRIGGER_TARGETS = Object.freeze({
  preview: "proj_bzchfkbbyztlvsntroom",
  production: "proj_umusurvkybxuonbiopal",
});

export const assertEnvironmentValidationEnabled = (environment) => {
  if (environment?.SKIP_ENV_VALIDATION === "1") {
    throw new Error("Refusing to deploy with environment validation disabled");
  }
};

const triggerProjectNames = Object.freeze({
  preview: "Humans Preview",
  production: "Humans",
});
const cloudflareAccountId = "541e1e926ecd3c40c0b204180978349f";
const repositoryDirectory = new URL("../", import.meta.url);
const apiDirectory = new URL("../apps/api/", import.meta.url);
const manifestDirectory = new URL("./release-manifests/", import.meta.url);
const fullShaPattern = /^[0-9a-f]{40}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const triggerDeploymentIdPattern = /^deployment_[A-Za-z0-9]+$/;
const triggerIdentifierPattern = /^[A-Za-z0-9._-]{1,128}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR sequences start with ESC.
const ansiEscapePattern = /\x1b\[[0-9;]*m/g;

export const releaseManifestPath = (service, environment) => {
  assertServiceEnvironment(service, environment);
  return new URL(`${environment}-${service}.json`, manifestDirectory);
};

export const assertPrivateFileMode = (mode, label = "Release record") => {
  if (!Number.isInteger(mode) || (mode & 0o777) !== 0o600) {
    throw new Error(`${label} must have mode 600`);
  }
};

export const writePrivateJson = (path, value) => {
  const directory = new URL(".", path);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const temporary = new URL(
    `.${pathName(path)}.${process.pid}.${randomUUID()}.tmp`,
    directory,
  );
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
};

export const readPrivateJson = (path, label = "Release record") => {
  const mode = statSync(path).mode;
  assertPrivateFileMode(mode, label);
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  return { mode, value };
};

export const assertGitReleaseProvenance = ({
  branch,
  release,
  remoteUrl,
  status,
  upstream,
}) => {
  if (!fullShaPattern.test(release ?? "")) {
    throw new Error("Git HEAD is not a full commit SHA");
  }
  if (status !== "") {
    throw new Error("Refusing to release from a dirty worktree");
  }
  if (
    branch !== "main" ||
    upstream !== "origin/main" ||
    !isHumansRepositoryUrl(remoteUrl)
  ) {
    throw new Error(
      "Releases require clean CLI provenance from crafter-station/humans@main",
    );
  }
  return release;
};

export const withoutAutomaticGitMetadata = (environment) => {
  const sanitized = { ...environment };
  for (const key of [
    "GITHUB_ACTIONS",
    "GITHUB_EVENT_NAME",
    "GITHUB_EVENT_PATH",
    "GITHUB_HEAD_COMMIT_AUTHOR_NAME",
    "GITHUB_HEAD_COMMIT_MESSAGE",
    "GITHUB_HEAD_COMMIT_SHA",
    "GITHUB_PULL_REQUEST_NUMBER",
    "GITHUB_PULL_REQUEST_STATE",
    "GITHUB_PULL_REQUEST_TITLE",
    "GITHUB_REF",
    "GITHUB_REPOSITORY",
    "GITHUB_REPOSITORY_URL",
    "GITHUB_SERVER_URL",
    "GITHUB_SHA",
    "GITHUB_USERNAME",
    "TRIGGER_GITHUB_APP",
  ]) {
    delete sanitized[key];
  }
  return sanitized;
};

export const cloudflareReleaseMessage = (environment, release) => {
  assertEnvironment(environment);
  if (!fullShaPattern.test(release ?? "")) {
    throw new Error("The Cloudflare release must be a full Git commit SHA");
  }
  return `humans-release:${environment}:${release}`;
};

export const assertCloudflareRelease = ({
  deployment,
  environment,
  expectedProvider,
  release,
  version,
}) => {
  assertEnvironment(environment);
  const versionId = deployment?.versions?.[0]?.version_id;
  const deployedAt = deployment?.created_on;
  const expectedMessage = cloudflareReleaseMessage(environment, release);
  if (
    !uuidPattern.test(deployment?.id ?? "") ||
    deployment?.source !== "wrangler" ||
    deployment?.strategy !== "percentage" ||
    !Array.isArray(deployment?.versions) ||
    deployment.versions.length !== 1 ||
    !uuidPattern.test(versionId ?? "") ||
    deployment.versions[0].percentage !== 100 ||
    deployment?.annotations?.["workers/message"] !== expectedMessage ||
    !isIsoDate(deployedAt) ||
    version?.id !== versionId ||
    version?.metadata?.source !== "wrangler" ||
    version?.resources?.script?.last_deployed_from !== "wrangler" ||
    version?.annotations?.["workers/message"] !== expectedMessage
  ) {
    throw new Error(
      "Cloudflare does not report the expected immutable Worker release",
    );
  }

  const provider = {
    accountId: cloudflareAccountId,
    deployedAt,
    deploymentId: deployment.id,
    name: "cloudflare-workers",
    versionId,
  };
  assertExpectedProvider(provider, expectedProvider, "Cloudflare");
  return provider;
};

export const readCloudflareRelease = (
  { environment, expectedProvider, release },
  { runWrangler = defaultWranglerJson } = {},
) => {
  const target = API_TARGETS[environment];
  if (!target) throw new Error("Unknown Cloudflare release environment");
  const deployment = runWrangler([
    "deployments",
    "status",
    "--env",
    environment,
    "--name",
    target,
    "--json",
  ]);
  const versionId = deployment?.versions?.[0]?.version_id;
  if (!uuidPattern.test(versionId ?? "")) {
    throw new Error("Cloudflare did not return one immutable Worker version");
  }
  const version = runWrangler([
    "versions",
    "view",
    versionId,
    "--env",
    environment,
    "--name",
    target,
    "--json",
  ]);
  return assertCloudflareRelease({
    deployment,
    environment,
    expectedProvider,
    release,
    version,
  });
};

export const parseTriggerDeployOutput = ({
  environmentOutput,
  output,
  release,
  target,
}) => {
  const values = parseKeyValueOutput(environmentOutput);
  const deploymentVersion = values.get("TRIGGER_DEPLOYMENT_VERSION");
  const triggerVersion = values.get("TRIGGER_VERSION");
  const deploymentShortCode = values.get("TRIGGER_DEPLOYMENT_SHORT_CODE");
  const deploymentUrl = values.get("TRIGGER_DEPLOYMENT_URL");
  if (
    !triggerIdentifierPattern.test(deploymentVersion ?? "") ||
    triggerVersion !== deploymentVersion ||
    !triggerIdentifierPattern.test(deploymentShortCode ?? "") ||
    !isTriggerDeploymentUrl(deploymentUrl, target, deploymentShortCode) ||
    !triggerDeploySucceeded(output, deploymentVersion, release)
  ) {
    throw new Error(
      "Trigger.dev did not emit an unambiguous deployment/version result",
    );
  }
  return { deploymentShortCode, deploymentVersion };
};

export const assertTriggerRelease = ({
  current,
  deployment,
  deploymentShortCode,
  deploymentVersion,
  environment,
  environmentProject,
  expectedProvider,
  project,
  release,
  target,
}) => {
  assertEnvironment(environment);
  if (
    project?.externalRef !== target ||
    project?.name !== triggerProjectNames[environment] ||
    typeof project?.id !== "string" ||
    project.id.length === 0 ||
    environmentProject?.projectId !== project.id ||
    environmentProject?.name !== triggerProjectNames[environment] ||
    environmentProject?.apiUrl !== "https://api.trigger.dev" ||
    !/^tr_prod_[A-Za-z0-9_-]+$/.test(environmentProject?.apiKey ?? "") ||
    !triggerDeploymentIdPattern.test(current?.id ?? "") ||
    current?.status !== "DEPLOYED" ||
    current?.version !== deploymentVersion ||
    current?.shortCode !== deploymentShortCode ||
    !isIsoDate(current?.deployedAt) ||
    current?.git?.source !== "local" ||
    current?.git?.commitRef !== "main" ||
    current?.git?.commitSha !== release ||
    current?.git?.dirty !== false ||
    !isHumansRepositoryUrl(current?.git?.remoteUrl) ||
    deployment?.id !== current.id ||
    deployment?.status !== "DEPLOYED" ||
    deployment?.version !== deploymentVersion ||
    deployment?.shortCode !== deploymentShortCode ||
    deployment?.commitSHA !== release
  ) {
    throw new Error(
      "Trigger.dev does not report the expected immutable deployment/version",
    );
  }

  const provider = {
    deployedAt: new Date(current.deployedAt).toISOString(),
    deploymentId: current.id,
    deploymentShortCode,
    deploymentVersion,
    externalId: release,
    name: "trigger.dev",
    projectId: project.id,
  };
  assertExpectedProvider(provider, expectedProvider, "Trigger.dev");
  return provider;
};

export const readTriggerRelease = async (
  {
    accessToken,
    deploymentShortCode,
    deploymentVersion,
    environment,
    expectedProvider,
    release,
  },
  { fetchImplementation = fetch } = {},
) => {
  const target = TRIGGER_TARGETS[environment];
  if (!target) throw new Error("Unknown Trigger.dev release environment");
  if (!/^tr_pat_[A-Za-z0-9_-]+$/.test(accessToken ?? "")) {
    throw new Error(
      "TRIGGER_ACCESS_TOKEN must be a Trigger.dev personal access token",
    );
  }

  const project = await triggerJson(
    `/api/v1/projects/${encodeURIComponent(target)}`,
    accessToken,
    fetchImplementation,
  );
  const environmentProject = await triggerJson(
    `/api/v1/projects/${encodeURIComponent(target)}/prod`,
    accessToken,
    fetchImplementation,
  );
  const providerToken = environmentProject?.apiKey;
  if (!/^tr_prod_[A-Za-z0-9_-]+$/.test(providerToken ?? "")) {
    throw new Error("Trigger.dev did not return the target Production scope");
  }
  const current = await triggerJson(
    "/api/v1/deployments/current",
    providerToken,
    fetchImplementation,
    environmentProject.apiUrl,
  );
  const deployment = await triggerJson(
    `/api/v1/deployments/${encodeURIComponent(current?.id ?? "")}`,
    providerToken,
    fetchImplementation,
    environmentProject.apiUrl,
  );
  return assertTriggerRelease({
    current,
    deployment,
    deploymentShortCode:
      deploymentShortCode ?? expectedProvider?.deploymentShortCode,
    deploymentVersion: deploymentVersion ?? expectedProvider?.deploymentVersion,
    environment,
    environmentProject,
    expectedProvider,
    project,
    release,
    target,
  });
};

export const writeReleaseManifest = ({
  attestedAt = new Date().toISOString(),
  environment,
  path,
  provider,
  release,
  service,
}) => {
  const target = targetFor(service, environment);
  const manifest = {
    attestedAt,
    environment,
    kind: "humans-release-provider",
    provider,
    release,
    service,
    target,
    version: RELEASE_RECORD_VERSION,
  };
  assertReleaseManifest(manifest, {
    environment,
    now: Date.parse(attestedAt),
    release,
    service,
  });
  writePrivateJson(path ?? releaseManifestPath(service, environment), manifest);
  return manifest;
};

export const assertReleaseManifest = (
  manifest,
  { environment, mode, now = Date.now(), release, service },
) => {
  assertServiceEnvironment(service, environment);
  if (mode !== undefined) {
    assertPrivateFileMode(mode, `${service} release manifest`);
  }
  assertExactKeys(
    manifest,
    [
      "attestedAt",
      "environment",
      "kind",
      "provider",
      "release",
      "service",
      "target",
      "version",
    ],
    `${service} release manifest`,
  );
  if (
    manifest.version !== RELEASE_RECORD_VERSION ||
    manifest.kind !== "humans-release-provider" ||
    manifest.service !== service ||
    manifest.environment !== environment ||
    manifest.release !== release ||
    manifest.target !== targetFor(service, environment) ||
    !fullShaPattern.test(manifest.release ?? "")
  ) {
    throw new Error(`${service} release manifest does not match the release`);
  }
  assertRecentTime(manifest.attestedAt, now, `${service} attestation`);
  assertProviderShape(manifest.provider, service);
  assertRecentTime(manifest.provider.deployedAt, now, `${service} deployment`);
  if (
    Date.parse(manifest.attestedAt) + 5_000 <
    Date.parse(manifest.provider.deployedAt)
  ) {
    throw new Error(`${service} release manifest predates the deployment`);
  }
  return manifest;
};

export const readReleaseManifest = (
  service,
  environment,
  release,
  { now = Date.now(), path = releaseManifestPath(service, environment) } = {},
) => {
  const { mode, value } = readPrivateJson(path, `${service} release manifest`);
  return assertReleaseManifest(value, {
    environment,
    mode,
    now,
    release,
    service,
  });
};

export const assertReleaseLineage = (
  lineage,
  { environment, now = Date.now(), release },
) => {
  assertExactKeys(lineage, ["api", "trigger"], "Release lineage");
  assertReleaseManifest(lineage?.api, {
    environment,
    now,
    release,
    service: "api",
  });
  assertReleaseManifest(lineage?.trigger, {
    environment,
    now,
    release,
    service: "trigger",
  });
  return lineage;
};

export const readReleaseLineage = (
  environment,
  release,
  { now = Date.now() } = {},
) => ({
  api: readReleaseManifest("api", environment, release, { now }),
  trigger: readReleaseManifest("trigger", environment, release, { now }),
});

export const reattestReleaseLineage = async (
  lineage,
  {
    accessToken,
    fetchImplementation = fetch,
    now = Date.now(),
    runWrangler = defaultWranglerJson,
  } = {},
) => {
  const environment = lineage?.api?.environment;
  const release = lineage?.api?.release;
  assertReleaseLineage(lineage, { environment, now, release });
  const api = readCloudflareRelease(
    {
      environment,
      expectedProvider: lineage.api.provider,
      release,
    },
    { runWrangler },
  );
  const trigger = await readTriggerRelease(
    {
      accessToken,
      environment,
      expectedProvider: lineage.trigger.provider,
      release,
    },
    { fetchImplementation },
  );
  return { api, trigger };
};

const assertProviderShape = (provider, service) => {
  if (service === "api") {
    assertExactKeys(
      provider,
      ["accountId", "deployedAt", "deploymentId", "name", "versionId"],
      "Cloudflare provider identity",
    );
    if (
      provider?.name !== "cloudflare-workers" ||
      provider?.accountId !== cloudflareAccountId ||
      !uuidPattern.test(provider?.deploymentId ?? "") ||
      !uuidPattern.test(provider?.versionId ?? "")
    ) {
      throw new Error("Cloudflare provider identity is invalid");
    }
    return;
  }

  assertExactKeys(
    provider,
    [
      "deployedAt",
      "deploymentId",
      "deploymentShortCode",
      "deploymentVersion",
      "externalId",
      "name",
      "projectId",
    ],
    "Trigger.dev provider identity",
  );
  if (
    provider?.name !== "trigger.dev" ||
    !triggerDeploymentIdPattern.test(provider?.deploymentId ?? "") ||
    !triggerIdentifierPattern.test(provider?.deploymentShortCode ?? "") ||
    !triggerIdentifierPattern.test(provider?.deploymentVersion ?? "") ||
    !fullShaPattern.test(provider?.externalId ?? "") ||
    typeof provider?.projectId !== "string" ||
    provider.projectId.length === 0
  ) {
    throw new Error("Trigger.dev provider identity is invalid");
  }
};

const assertExpectedProvider = (actual, expected, label) => {
  if (expected === undefined) return;
  if (
    Object.keys(actual).length !== Object.keys(expected ?? {}).length ||
    Object.entries(actual).some(([key, value]) => expected?.[key] !== value)
  ) {
    throw new Error(`${label} release identity changed after attestation`);
  }
};

const assertRecentTime = (value, now, label) => {
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    timestamp > now + 5_000 ||
    now - timestamp > RELEASE_RECORD_MAX_AGE_MS
  ) {
    throw new Error(
      `${label} is missing, future-dated, or older than 24 hours`,
    );
  }
};

const assertExactKeys = (value, expected, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} has an invalid shape`);
  }
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== keys[index])
  ) {
    throw new Error(`${label} contains unexpected or missing fields`);
  }
};

const assertEnvironment = (environment) => {
  if (environment !== "preview" && environment !== "production") {
    throw new Error("Unknown release environment");
  }
};

const assertServiceEnvironment = (service, environment) => {
  assertEnvironment(environment);
  if (service !== "api" && service !== "trigger") {
    throw new Error("Unknown release service");
  }
};

const targetFor = (service, environment) => {
  assertServiceEnvironment(service, environment);
  return service === "api"
    ? API_TARGETS[environment]
    : TRIGGER_TARGETS[environment];
};

const isIsoDate = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

const isHumansRepositoryUrl = (value) =>
  value === "https://github.com/crafter-station/humans.git" ||
  value === "git@github.com:crafter-station/humans.git" ||
  value === "ssh://git@github.com/crafter-station/humans.git";

const pathName = (path) => {
  const pathname = path instanceof URL ? path.pathname : String(path);
  return pathname.slice(pathname.lastIndexOf("/") + 1);
};

const parseKeyValueOutput = (contents) => {
  const values = new Map();
  for (const line of contents.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error("Trigger.dev emitted an invalid deployment output");
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (values.has(key)) {
      throw new Error("Trigger.dev emitted duplicate deployment outputs");
    }
    values.set(key, value);
  }
  return values;
};

const triggerDeploySucceeded = (output, version, release) => {
  const plain = output.replace(ansiEscapePattern, "");
  return (
    plain.includes(`Version ${version} deployed with `) ||
    plain.includes(`Version ${version} was deployed`) ||
    plain.includes(
      `Version ${version} was already deployed for --external-id ${release}`,
    )
  );
};

const isTriggerDeploymentUrl = (value, target, shortCode) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "cloud.trigger.dev" &&
      url.pathname ===
        `/projects/v3/${encodeURIComponent(target)}/deployments/${encodeURIComponent(shortCode)}` &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
};

const triggerJson = async (
  path,
  token,
  fetchImplementation,
  baseUrl = "https://api.trigger.dev",
) => {
  let response;
  try {
    response = await fetchImplementation(new URL(path, baseUrl), {
      headers: { authorization: `Bearer ${token}` },
      method: "GET",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Trigger.dev release revalidation request failed");
  }
  if (!response?.ok) {
    throw new Error(
      `Trigger.dev release revalidation returned HTTP ${response?.status ?? "unknown"}`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new Error("Trigger.dev release revalidation returned invalid JSON");
  }
};

const defaultWranglerJson = (arguments_) => {
  const result = spawnSync("bunx", ["wrangler", ...arguments_], {
    cwd: apiDirectory,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Wrangler read-back exited with status ${result.status}`);
  }
  try {
    return JSON.parse(result.stdout ?? "");
  } catch {
    throw new Error("Wrangler read-back returned invalid JSON");
  }
};

export const RELEASE_REPOSITORY_DIRECTORY = repositoryDirectory;
