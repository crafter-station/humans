import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";

import {
  readReleaseLineage,
  reattestReleaseLineage,
  writePrivateJson,
} from "../../../scripts/release-manifest.mjs";
import {
  acceptanceReceiptPath,
  assignVercelAlias,
  readVercelAlias,
  readVercelAliasInventory,
  readVercelDeploymentAliases,
  readVercelProjectDomain,
  removeVercelAlias,
  verifyDeployment,
} from "./verify-deployment.mjs";
import {
  PUBLIC_PRODUCTION_ALIASES,
  VERCEL_PROJECT_ID,
  apiAcceptanceEnvironment,
  assertOnlyTemporaryDeploymentAlias,
  assertPreviewAcceptance,
  assertProductionAcceptanceUrl,
  assertProductionAcceptanceDomain,
  assertPublicProductionAliasesUnchanged,
  assertTemporaryAliasAssignment,
  assertTemporaryAliasAvailable,
  assertTemporaryAliasIdentity,
  snapshotPublicProductionAliases,
} from "./release-guards.mjs";

const environment = process.argv[2];
if (environment !== "preview" && environment !== "production") {
  throw new Error("Usage: accept-deployment.mjs <preview|production>");
}

const repositoryDirectory = new URL("../../..", import.meta.url);
const verified = verifyDeployment(environment);
if (environment === "production") {
  const previewReceipt = acceptanceReceiptPath("preview");
  assertPreviewAcceptance(
    JSON.parse(readFileSync(previewReceipt, "utf8")),
    verified.release,
    { mode: statSync(previewReceipt).mode },
  );
}
const lineage = readReleaseLineage(environment, verified.release);
await reattestReleaseLineage(lineage, {
  accessToken: process.env.TRIGGER_ACCESS_TOKEN?.trim(),
});

const browserUrlName =
  environment === "preview"
    ? "PLAYWRIGHT_PREVIEW_URL"
    : "PLAYWRIGHT_PRODUCTION_URL";
let acceptanceUrl;
if (environment === "preview") {
  acceptanceUrl = new URL(requiredEnvironment(browserUrlName));
  if (acceptanceUrl.href !== verified.deploymentUrl) {
    throw new Error(`${browserUrlName} must match the verified deployment URL`);
  }
} else {
  acceptanceUrl = assertProductionAcceptanceUrl(
    requiredEnvironment("HUMANS_PRODUCTION_ACCEPTANCE_URL"),
  );
  if (requiredEnvironment(browserUrlName) !== acceptanceUrl.href) {
    throw new Error(
      `${browserUrlName} must match HUMANS_PRODUCTION_ACCEPTANCE_URL`,
    );
  }
}
if (requiredEnvironment("E2E_RELEASE_SHA") !== verified.release) {
  throw new Error("E2E_RELEASE_SHA must match the verified deployment release");
}
if (requiredEnvironment("HUMANS_ACCEPTANCE_ENVIRONMENT") !== environment) {
  throw new Error(
    "The API acceptance environment does not match the deployment",
  );
}
if (requiredEnvironment("HUMANS_ACCEPTANCE_RELEASE") !== verified.release) {
  throw new Error("The API acceptance release does not match the deployment");
}

const receiptPath = acceptanceReceiptPath(environment);
rmSync(receiptPath, { force: true });
let acceptanceAlias;
let publicAliasesBefore;
let temporaryAliasWasRequested = false;

try {
  if (environment === "production") {
    assertProductionAcceptanceDomain(
      readVercelProjectDomain(acceptanceUrl.hostname),
    );
    publicAliasesBefore = readPublicProductionAliases();
    assertTemporaryAliasAvailable(
      readVercelAliasInventory(acceptanceUrl.hostname),
      acceptanceUrl.hostname,
    );
    temporaryAliasWasRequested = true;
    acceptanceAlias = assertTemporaryAliasAssignment(
      assignVercelAlias(verified.deploymentId, acceptanceUrl.hostname),
      {
        deploymentId: verified.deploymentId,
        hostname: acceptanceUrl.hostname,
      },
    );
  }

  run(
    "bun",
    ["run", "--cwd", "apps/api", "acceptance:deployed"],
    apiAcceptanceEnvironment(process.env, lineage.api.provider.versionId),
  );
  if (acceptanceAlias) assertAcceptanceAliasStillFrozen(acceptanceAlias);
  run("bun", [
    "run",
    "--cwd",
    "apps/web",
    "test:browser",
    "--",
    `--project=${
      environment === "preview"
        ? "preview-operator"
        : "production-profile-control"
    }`,
  ]);
  if (acceptanceAlias) assertAcceptanceAliasStillFrozen(acceptanceAlias);
} finally {
  if (environment === "production" && temporaryAliasWasRequested) {
    removeTemporaryAcceptanceAlias(acceptanceUrl.hostname, acceptanceAlias);
    assertPublicProductionAliasesUnchanged(
      publicAliasesBefore,
      readPublicProductionAliases(),
    );
  }
}

writePrivateJson(receiptPath, {
  acceptedAt: new Date().toISOString(),
  ...(acceptanceAlias ? { acceptanceAlias } : {}),
  environment,
  ...verified,
  lineage,
  version: 2,
});
console.log(
  `Accepted ${environment} deployment ${verified.deploymentId} (${verified.release})`,
);

function assertAcceptanceAliasStillFrozen(identity) {
  assertTemporaryAliasIdentity(readVercelAlias(identity.hostname), {
    ...identity,
    projectId: VERCEL_PROJECT_ID,
  });
  assertOnlyTemporaryDeploymentAlias(
    readVercelDeploymentAliases(identity.deploymentId),
    identity,
  );
  assertPublicProductionAliasesUnchanged(
    publicAliasesBefore,
    readPublicProductionAliases(),
  );
}

function readPublicProductionAliases() {
  return snapshotPublicProductionAliases(
    PUBLIC_PRODUCTION_ALIASES.map((alias) => readVercelAlias(alias)),
    VERCEL_PROJECT_ID,
  );
}

function removeTemporaryAcceptanceAlias(hostname, identity) {
  const inventory = readVercelAliasInventory(hostname);
  if (inventory?.aliases?.length === 0 && inventory?.pagination?.count === 0) {
    if (identity) {
      throw new Error("The temporary Production acceptance alias disappeared");
    }
    return;
  }
  const alias = inventory?.aliases?.[0];
  if (
    !Array.isArray(inventory?.aliases) ||
    inventory.aliases.length !== 1 ||
    alias?.alias !== hostname ||
    alias?.deploymentId !== verified.deploymentId ||
    alias?.projectId !== VERCEL_PROJECT_ID ||
    typeof alias?.uid !== "string" ||
    alias.uid.length === 0 ||
    (identity && alias.uid !== identity.uid)
  ) {
    throw new Error(
      "Refusing to remove a Production acceptance alias whose identity changed",
    );
  }
  removeVercelAlias(alias.uid);
  assertTemporaryAliasAvailable(readVercelAliasInventory(hostname), hostname);
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function run(command, arguments_, environmentVariables = process.env) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryDirectory,
    encoding: "utf8",
    env: environmentVariables,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}
