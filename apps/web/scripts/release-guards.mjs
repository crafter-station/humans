import {
  RELEASE_RECORD_MAX_AGE_MS,
  assertPrivateFileMode,
  assertReleaseLineage,
} from "../../../scripts/release-manifest.mjs";

export const VERCEL_PROJECT_ID = "prj_1rRwDoknIk65eWIHIScwyuuHDthI";
export const VERCEL_OWNER_ID = "team_aWZAJNYntEQ3eN0NdKiQnf6v";
export const PRODUCTION_ACCEPTANCE_URL =
  "https://acceptance.humans.crafter.run/";
const productionAcceptanceHostname = new URL(PRODUCTION_ACCEPTANCE_URL)
  .hostname;
export const PUBLIC_PRODUCTION_ALIASES = Object.freeze([
  "api.humans.crafter.run",
  "humans.crafter.run",
]);

export const requiredVercelEnvironmentKeys = Object.freeze([
  "CLERK_SECRET_KEY",
  "HUMANS_API_URL",
  "HUMANS_PROXY_SECRET",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_ENVIRONMENT",
  "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_DSN",
  "TURNSTILE_SECRET_KEY",
]);

const generatedReleaseKeys = [
  "HUMANS_RELEASE",
  "HUMANS_RELEASE_ENVIRONMENT",
  "SENTRY_RELEASE",
  "SKIP_ENV_VALIDATION",
];
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const assertVercelReleaseGuard = (project, configuration) => {
  if (
    project?.id !== VERCEL_PROJECT_ID ||
    project?.accountId !== VERCEL_OWNER_ID ||
    project?.name !== "humans" ||
    project?.rootDirectory !== "apps/web" ||
    project?.autoExposeSystemEnvs !== true ||
    (project?.git !== undefined && project.git !== null) ||
    project?.gitProviderOptions?.createDeployments !== "disabled" ||
    project?.link?.type !== "github" ||
    project?.link?.org !== "crafter-station" ||
    project?.link?.repo !== "humans" ||
    project?.link?.repoId !== 1_318_774_404 ||
    project?.link?.productionBranch !== "main" ||
    !Array.isArray(project?.link?.deployHooks) ||
    project.link.deployHooks.length !== 0 ||
    configuration?.git?.deploymentEnabled !== false
  ) {
    throw new Error("The Vercel project release guard is not configured");
  }
};

export const assertVercelEnvironmentInventory = (inventory) => {
  if (
    !Array.isArray(inventory?.envs) ||
    inventory?.hiddenProductionEnvCount !== 0
  ) {
    throw new Error("The Vercel environment inventory is unavailable");
  }
  if (
    inventory.envs.some(
      (variable) =>
        generatedReleaseKeys.includes(variable?.key) ||
        (requiredVercelEnvironmentKeys.includes(variable?.key) &&
          (!Array.isArray(variable?.target) ||
            variable.target.length !== 1 ||
            (variable.target[0] !== "preview" &&
              variable.target[0] !== "production") ||
            variable.gitBranch != null)),
    )
  ) {
    throw new Error("The Vercel environment variables are not isolated");
  }
  for (const environment of ["preview", "production"]) {
    for (const key of requiredVercelEnvironmentKeys) {
      const matches = inventory.envs.filter(
        (variable) =>
          variable?.key === key && variable.target?.[0] === environment,
      );
      if (matches.length !== 1) {
        throw new Error("The Vercel environment variables are incomplete");
      }
    }
  }
};

export const assertPreviewAcceptance = (
  receipt,
  release,
  { mode, now = Date.now() },
) => {
  try {
    assertAcceptanceReceipt(receipt, {
      environment: "preview",
      mode,
      now,
      release,
    });
  } catch {
    throw new Error(
      "Production staging requires recent Preview acceptance for this release",
    );
  }
};

export const assertProductionAcceptance = (
  receipt,
  verified,
  { mode, now = Date.now() },
) => {
  try {
    assertAcceptanceReceipt(receipt, {
      environment: "production",
      mode,
      now,
      release: verified.release,
    });
    if (
      receipt.deploymentCreatedAt !== verified.deploymentCreatedAt ||
      receipt.deploymentId !== verified.deploymentId ||
      receipt.deploymentUrl !== verified.deploymentUrl
    ) {
      throw new Error("The web deployment changed");
    }
  } catch {
    throw new Error(
      "Production acceptance does not match the staged deployment",
    );
  }
  return receipt;
};

export const assertProductionAcceptanceUrl = (value) => {
  if (value !== PRODUCTION_ACCEPTANCE_URL) {
    throw new Error(
      `HUMANS_PRODUCTION_ACCEPTANCE_URL must equal the fixed Production acceptance URL ${PRODUCTION_ACCEPTANCE_URL}`,
    );
  }
  return new URL(PRODUCTION_ACCEPTANCE_URL);
};

export const assertProductionAcceptanceDomain = (domain) => {
  if (
    domain?.name !== productionAcceptanceHostname ||
    domain?.apexName !== "crafter.run" ||
    domain?.projectId !== VERCEL_PROJECT_ID ||
    domain?.verified !== true ||
    domain?.redirect !== null ||
    domain?.redirectStatusCode !== null ||
    domain?.gitBranch !== null ||
    domain?.customEnvironmentId !== null
  ) {
    throw new Error(
      "The Production acceptance canary domain is not verified and unbound on the Humans Vercel project",
    );
  }
  return domain;
};

export const apiAcceptanceEnvironment = (environment, workerVersionId) => {
  if (!uuidPattern.test(workerVersionId ?? "")) {
    throw new Error("The API acceptance Worker version is invalid");
  }
  return {
    ...environment,
    HUMANS_ACCEPTANCE_WORKER_VERSION_ID: workerVersionId,
  };
};

export const assertTemporaryAliasAvailable = (inventory, hostname) => {
  if (
    !Array.isArray(inventory?.aliases) ||
    inventory.aliases.length !== 0 ||
    inventory?.pagination?.count !== 0
  ) {
    throw new Error(
      `Temporary Production acceptance alias ${hostname} is in use`,
    );
  }
};

export const selectVercelAliasInventory = (aliases, hostname) => {
  if (!Array.isArray(aliases)) {
    throw new Error("The Vercel alias inventory is unavailable");
  }
  const matches = aliases.filter((alias) => alias?.alias === hostname);
  return {
    aliases: matches,
    pagination: { count: matches.length },
  };
};

export const assertTemporaryAliasAssignment = (
  assignment,
  { deploymentId, hostname },
) => {
  if (
    typeof assignment?.uid !== "string" ||
    assignment.uid.length === 0 ||
    assignment?.alias !== hostname ||
    assignment?.oldDeploymentId != null
  ) {
    throw new Error(
      "Vercel moved or returned an invalid Production acceptance alias",
    );
  }
  return {
    deploymentId,
    hostname,
    uid: assignment.uid,
  };
};

export const assertTemporaryAliasIdentity = (
  alias,
  { deploymentId, hostname, projectId, uid },
) => {
  if (
    alias?.alias !== hostname ||
    alias?.uid !== uid ||
    alias?.deploymentId !== deploymentId ||
    alias?.deployment?.id !== deploymentId ||
    alias?.projectId !== projectId ||
    alias?.deletedAt != null
  ) {
    throw new Error(
      "The temporary Production acceptance alias identity changed",
    );
  }
  return { deploymentId, hostname, uid };
};

export const assertOnlyTemporaryDeploymentAlias = (inventory, identity) => {
  const aliases = inventory?.aliases;
  if (
    !Array.isArray(aliases) ||
    aliases.length !== 1 ||
    aliases[0]?.alias !== identity.hostname ||
    aliases[0]?.uid !== identity.uid
  ) {
    throw new Error(
      "The staged Production deployment has aliases beyond its temporary acceptance alias",
    );
  }
};

export const snapshotPublicProductionAliases = (aliases, projectId) => {
  if (!Array.isArray(aliases) || aliases.length !== 2) {
    throw new Error("The public Production aliases are unavailable");
  }
  const snapshot = aliases
    .map((alias) => {
      if (
        !PUBLIC_PRODUCTION_ALIASES.includes(alias?.alias) ||
        alias?.projectId !== projectId ||
        typeof alias?.deploymentId !== "string" ||
        !/^dpl_[A-Za-z0-9]+$/.test(alias.deploymentId) ||
        typeof alias?.uid !== "string" ||
        alias.uid.length === 0 ||
        alias?.deletedAt != null
      ) {
        throw new Error("The public Production aliases are invalid");
      }
      return {
        alias: alias.alias,
        deploymentId: alias.deploymentId,
        projectId: alias.projectId,
        uid: alias.uid,
      };
    })
    .sort((left, right) => left.alias.localeCompare(right.alias));
  if (
    snapshot.some(
      (alias, index) => alias.alias !== PUBLIC_PRODUCTION_ALIASES[index],
    )
  ) {
    throw new Error("The public Production aliases are incomplete");
  }
  return snapshot;
};

export const assertPublicProductionAliasesUnchanged = (before, after) => {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("A public Production alias moved during staged acceptance");
  }
};

export const assertPublicReleaseResponses = ({ api, release, web }) => {
  for (const [name, response] of [
    ["web", web],
    ["API", api],
  ]) {
    if (
      response?.status !== 200 ||
      response?.headers?.get("x-humans-release") !== release ||
      response?.headers?.get("x-humans-environment") !== "production"
    ) {
      throw new Error(`The public Production ${name} identity is not current`);
    }
  }
};

export const assertFrozenDeployment = ({
  allowPromoted,
  deployment,
  deploymentAliases,
  deploymentId,
  deploymentUrl,
  environment,
  ownerId,
  projectId,
  release,
}) => {
  const expectedTarget = environment === "preview" ? null : "production";
  const aliases = deploymentAliases?.aliases;
  if (
    deployment?.id !== deploymentId ||
    deployment?.projectId !== projectId ||
    deployment?.ownerId !== ownerId ||
    deployment?.name !== "humans" ||
    deployment?.target !== expectedTarget ||
    deployment?.readyState !== "READY" ||
    !Number.isSafeInteger(deployment?.createdAt) ||
    deployment?.url !== deploymentUrl.hostname ||
    deployment?.source !== "cli" ||
    deployment?.meta?.humansRelease !== release ||
    deployment?.meta?.humansEnvironment !== environment ||
    deployment?.meta?.githubCommitSha !== release ||
    deployment?.meta?.githubCommitOrg !== "crafter-station" ||
    deployment?.meta?.githubCommitRepo !== "humans" ||
    deployment?.meta?.githubCommitRef !== "main" ||
    Object.hasOwn(deployment?.meta ?? {}, "gitDirty") ||
    deployment?.gitRepo?.repoId !== 1_318_774_404 ||
    deployment?.gitRepo?.path !== "crafter-station/humans" ||
    deployment?.gitRepo?.defaultBranch !== "main" ||
    deployment?.oidcTokenClaims?.owner_id !== ownerId ||
    deployment?.oidcTokenClaims?.project_id !== projectId ||
    deployment?.oidcTokenClaims?.environment !== environment ||
    !Array.isArray(deployment?.alias) ||
    !Array.isArray(aliases) ||
    (!allowPromoted && (deployment.alias.length !== 0 || aliases.length !== 0))
  ) {
    throw new Error("The Vercel deployment does not match the frozen release");
  }
};

const assertAcceptanceReceipt = (
  receipt,
  { environment, mode, now, release },
) => {
  assertPrivateFileMode(mode, `${environment} acceptance receipt`);
  assertExactKeys(
    receipt,
    [
      "acceptedAt",
      ...(environment === "production" ? ["acceptanceAlias"] : []),
      "deploymentCreatedAt",
      "deploymentId",
      "deploymentUrl",
      "environment",
      "lineage",
      "release",
      "version",
    ],
    `${environment} acceptance receipt`,
  );
  const acceptedAt = Date.parse(receipt?.acceptedAt);
  if (
    receipt?.version !== 2 ||
    receipt?.environment !== environment ||
    receipt?.release !== release ||
    !/^dpl_[A-Za-z0-9]+$/.test(receipt?.deploymentId ?? "") ||
    !Number.isSafeInteger(receipt?.deploymentCreatedAt) ||
    !/^https:\/\/humans-[a-z0-9]{9}-crafter-station\.vercel\.app\/$/i.test(
      receipt?.deploymentUrl ?? "",
    ) ||
    !Number.isFinite(acceptedAt) ||
    acceptedAt < receipt.deploymentCreatedAt ||
    acceptedAt > now + 5_000 ||
    now - acceptedAt > RELEASE_RECORD_MAX_AGE_MS
  ) {
    throw new Error(`${environment} acceptance receipt is invalid or stale`);
  }
  assertReleaseLineage(receipt.lineage, { environment, now, release });
  if (
    acceptedAt < Date.parse(receipt.lineage.api.attestedAt) ||
    acceptedAt < Date.parse(receipt.lineage.trigger.attestedAt)
  ) {
    throw new Error(`${environment} acceptance predates provider attestation`);
  }
  if (environment === "production") {
    assertExactKeys(
      receipt.acceptanceAlias,
      ["deploymentId", "hostname", "uid"],
      "Production acceptance alias",
    );
    assertProductionAcceptanceUrl(
      `https://${receipt.acceptanceAlias?.hostname ?? ""}/`,
    );
    if (
      receipt.acceptanceAlias.deploymentId !== receipt.deploymentId ||
      typeof receipt.acceptanceAlias.uid !== "string" ||
      receipt.acceptanceAlias.uid.length === 0
    ) {
      throw new Error("Production acceptance alias is invalid");
    }
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
