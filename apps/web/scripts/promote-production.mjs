import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import {
  assertEnvironmentValidationEnabled,
  reattestReleaseLineage,
} from "../../../scripts/release-manifest.mjs";
import {
  acceptanceReceiptPath,
  readVercelAlias,
  readVercelAliasInventory,
  readVercelProject,
  removeVercelAlias,
  verifyDeployment,
} from "./verify-deployment.mjs";
import {
  PUBLIC_PRODUCTION_ALIASES,
  VERCEL_PROJECT_ID,
  assertPreviewAcceptance,
  assertProductionAcceptance,
  assertPublicReleaseResponses,
  assertTemporaryAliasAvailable,
  assertTemporaryAliasIdentity,
} from "./release-guards.mjs";

const scope = "crafter-station";
const vercelVersion = "50.39.0";
const repositoryDirectory = new URL("../../..", import.meta.url);
assertEnvironmentValidationEnabled(process.env);
const verified = verifyDeployment("production", { allowPromoted: true });
const previewReceiptPath = acceptanceReceiptPath("preview");
assertPreviewAcceptance(
  JSON.parse(readFileSync(previewReceiptPath, "utf8")),
  verified.release,
  { mode: statSync(previewReceiptPath).mode },
);
const receiptPath = acceptanceReceiptPath("production");
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
const acceptedAt = Date.parse(receipt.acceptedAt);
assertProductionAcceptance(receipt, verified, {
  mode: statSync(receiptPath).mode,
});
assertTemporaryAliasAvailable(
  readVercelAliasInventory(receipt.acceptanceAlias.hostname),
  receipt.acceptanceAlias.hostname,
);

// This is the final read-only provider check before any public alias can move.
await reattestReleaseLineage(receipt.lineage, {
  accessToken: process.env.TRIGGER_ACCESS_TOKEN?.trim(),
});

if (!productionAliasesMatch()) {
  let promotion = readVercelProject().lastAliasRequest;
  if (!isCurrentPromotion(promotion)) {
    const requestedAt = Date.now();
    runVercel([
      "api",
      `/v10/projects/${VERCEL_PROJECT_ID}/promote/${verified.deploymentId}`,
      "--scope",
      scope,
      "--method",
      "POST",
      "--input",
      "-",
      "--silent",
    ]);
    promotion = null;

    const promotionDeadline = Date.now() + 5 * 60_000;
    for (;;) {
      if (Date.now() >= promotionDeadline) {
        throw new Error("Vercel Production promotion timed out");
      }
      promotion = readVercelProject().lastAliasRequest;
      if (
        !isMatchingPromotion(promotion) ||
        promotion.requestedAt < requestedAt - 5_000
      ) {
        await delay(250);
        continue;
      }
      if (
        promotion.jobStatus === "succeeded" ||
        promotion.jobStatus === "skipped"
      )
        break;
      if (
        promotion.jobStatus !== "pending" &&
        promotion.jobStatus !== "in-progress"
      ) {
        throw new Error(
          `Vercel Production promotion ${promotion.jobStatus ?? "failed"}`,
        );
      }
      await delay(250);
    }
  } else {
    const promotionDeadline = Date.now() + 5 * 60_000;
    while (
      promotion.jobStatus === "pending" ||
      promotion.jobStatus === "in-progress"
    ) {
      if (Date.now() >= promotionDeadline) {
        throw new Error("Vercel Production promotion timed out");
      }
      await delay(250);
      promotion = readVercelProject().lastAliasRequest;
      if (!isMatchingPromotion(promotion)) {
        throw new Error("Vercel Production promotion identity changed");
      }
    }
    if (
      promotion.jobStatus !== "succeeded" &&
      promotion.jobStatus !== "skipped"
    ) {
      throw new Error(
        `Vercel Production promotion ${promotion.jobStatus ?? "failed"}`,
      );
    }
  }
}

const postPromotion = verifyDeployment("production", { allowPromoted: true });
if (
  postPromotion.deploymentCreatedAt !== verified.deploymentCreatedAt ||
  postPromotion.deploymentId !== verified.deploymentId ||
  postPromotion.deploymentUrl !== verified.deploymentUrl ||
  postPromotion.release !== verified.release
) {
  throw new Error("Vercel rebuilt or replaced the accepted deployment");
}

const publicDeadline = Date.now() + 60_000;
for (;;) {
  let apiResponse;
  let webResponse;
  try {
    [webResponse, apiResponse] = await Promise.all([
      fetch("https://humans.crafter.run/", {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      }),
      fetch("https://api.humans.crafter.run/health", {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      }),
    ]);
    assertPublicReleaseResponses({
      api: apiResponse,
      release: verified.release,
      web: webResponse,
    });
    if (productionAliasesMatch()) break;
  } catch {
    // Alias propagation can briefly leave the previous deployment visible.
  } finally {
    await Promise.all([
      webResponse?.body?.cancel(),
      apiResponse?.body?.cancel(),
    ]);
  }
  if (Date.now() >= publicDeadline) {
    throw new Error(
      "The promoted release is not live on the Production domain",
    );
  }
  await delay(500);
}
removePromotedAcceptanceAlias(receipt.acceptanceAlias.hostname);
if (!productionAliasesMatch()) {
  throw new Error(
    "A public Production alias moved during acceptance canary cleanup",
  );
}
console.log(
  `Promoted Production deployment ${verified.deploymentId} (${verified.release})`,
);

function runVercel(arguments_) {
  const result = spawnSync("bunx", [`vercel@${vercelVersion}`, ...arguments_], {
    cwd: repositoryDirectory,
    encoding: "utf8",
    env: process.env,
    input: "{}",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Vercel promotion exited with status ${result.status}`);
  }
}

function isMatchingPromotion(promotion) {
  return (
    promotion?.type === "promote" &&
    promotion.toDeploymentId === verified.deploymentId &&
    typeof promotion.requestedAt === "number" &&
    Number.isSafeInteger(promotion.requestedAt)
  );
}

function isCurrentPromotion(promotion) {
  return (
    isMatchingPromotion(promotion) &&
    promotion.requestedAt >= acceptedAt &&
    (promotion.jobStatus === "pending" ||
      promotion.jobStatus === "in-progress" ||
      promotion.jobStatus === "succeeded" ||
      promotion.jobStatus === "skipped")
  );
}

function productionAliasesMatch() {
  return PUBLIC_PRODUCTION_ALIASES.every((name) => {
    const alias = readVercelAlias(name);
    return (
      alias.alias === name &&
      alias.projectId === VERCEL_PROJECT_ID &&
      alias.deploymentId === verified.deploymentId
    );
  });
}

function removePromotedAcceptanceAlias(hostname) {
  const inventory = readVercelAliasInventory(hostname);
  if (inventory?.aliases?.length === 0 && inventory?.pagination?.count === 0) {
    return;
  }
  const alias = inventory?.aliases?.[0];
  if (
    !Array.isArray(inventory?.aliases) ||
    inventory.aliases.length !== 1 ||
    inventory?.pagination?.count !== 1 ||
    alias?.alias !== hostname ||
    alias?.deploymentId !== verified.deploymentId ||
    alias?.projectId !== VERCEL_PROJECT_ID ||
    typeof alias?.uid !== "string" ||
    alias.uid.length === 0 ||
    alias?.deletedAt != null
  ) {
    throw new Error(
      "Refusing to remove a promoted Production acceptance alias whose identity changed",
    );
  }
  assertTemporaryAliasIdentity(readVercelAlias(hostname), {
    deploymentId: verified.deploymentId,
    hostname,
    projectId: VERCEL_PROJECT_ID,
    uid: alias.uid,
  });
  removeVercelAlias(alias.uid);
  assertTemporaryAliasAvailable(readVercelAliasInventory(hostname), hostname);
}
