import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  deploymentUrl,
  requiredClerkId,
  requiredEnvironment,
  requiredUuid,
} from "./deployment";
import {
  privateFileExists,
  readPrivateJson,
  removePrivateFile,
  writePrivateJsonAtomically,
} from "./private-state";

export type ProfileControlRunPhase = "post-promotion" | "staged-claim";

export type ProfileControlContract = {
  deploymentUrl: string;
  memberId: string;
  observationId: string;
  organizationId: string;
  profileId: string;
  release: string;
  runPhase: ProfileControlRunPhase;
  searcherMemberId: string;
  searcherOrganizationId: string;
};

export type ProfileControlState = ProfileControlContract & {
  version: 2;
  environment: "production";
  originalSearchability: boolean;
  profileIdentityFingerprint: string;
  recordedAt: string;
};

export type ProfileControlClaimReceipt = {
  version: 1;
  environment: "production";
  memberId: string;
  observationId: string;
  organizationId: string;
  profileId: string;
  profileIdentityFingerprint: string;
  release: string;
  sourceDeploymentUrl: string;
  recordedAt: string;
};

const publicProductionUrl = "https://humns.co/";
const productionAcceptanceUrl = "https://acceptance.humns.co/";
const defaultProfileControlStateFile = resolve(
  "playwright/.clerk/profile-control-rollback.json",
);
const profileControlClaimFile = (release: string) =>
  resolve(`playwright/.clerk/profile-control-claim-${release}.json`);

export const profileControlContractFromEnvironment =
  (): ProfileControlContract => {
    const release = requiredEnvironment("E2E_RELEASE_SHA");
    if (!/^[0-9a-f]{40}$/.test(release)) {
      throw new Error("E2E_RELEASE_SHA must be a full Git commit SHA");
    }
    const productionUrl = deploymentUrl("production").href;
    // These IDs and E2E_PROFILE_CONTROL_QUERY are durable across staged and
    // public checks; only their one-use impersonation URLs are refreshed.
    const memberId = requiredClerkId("E2E_PROFILE_OWNER_MEMBER_ID", "user");
    const organizationId = requiredClerkId(
      "E2E_PROFILE_OWNER_ORGANIZATION_ID",
      "org",
    );
    const profileId = requiredUuid("E2E_PROFILE_CONTROL_PROFILE_ID");
    const searcherMemberId = requiredClerkId(
      "E2E_PROFILE_SEARCHER_MEMBER_ID",
      "user",
    );
    const searcherOrganizationId = requiredClerkId(
      "E2E_PROFILE_SEARCHER_ORGANIZATION_ID",
      "org",
    );
    const disposableMemberId = requiredClerkId(
      "E2E_PRODUCTION_MEMBER_ID",
      "user",
    );
    const disposableOrganizationId = requiredClerkId(
      "E2E_PRODUCTION_ORGANIZATION_ID",
      "org",
    );
    if (
      memberId === searcherMemberId ||
      organizationId === searcherOrganizationId ||
      memberId === disposableMemberId ||
      organizationId === disposableOrganizationId ||
      searcherMemberId === disposableMemberId ||
      searcherOrganizationId === disposableOrganizationId ||
      profileId === requiredUuid("HUMANS_ACCEPTANCE_PROFILE_ID")
    ) {
      throw new Error(
        "Profile control requires durable, distinct owner, searcher, and search fixtures",
      );
    }

    // The dedicated owner and searcher survive staged acceptance. The public
    // check must not reuse the deleted core Member or treat its claim as fresh.
    return {
      deploymentUrl: productionUrl,
      memberId,
      observationId: requiredUuid("E2E_PROFILE_CONTROL_OBSERVATION_ID"),
      organizationId,
      profileId,
      release,
      runPhase:
        productionUrl === publicProductionUrl
          ? "post-promotion"
          : "staged-claim",
      searcherMemberId,
      searcherOrganizationId,
    };
  };

export const profileControlQueryFromEnvironment = () =>
  requiredEnvironment("E2E_PROFILE_CONTROL_QUERY");

export const profileIdentityFingerprint = (
  profileId: string,
  githubAccountId: string,
) =>
  createHash("sha256").update(`${profileId}\0${githubAccountId}`).digest("hex");

export const parseProfileControlState = (
  value: unknown,
): ProfileControlState => {
  if (!isRecord(value)) {
    throw new Error("Profile control rollback state is invalid");
  }
  const expectedKeys = new Set([
    "deploymentUrl",
    "environment",
    "memberId",
    "observationId",
    "organizationId",
    "originalSearchability",
    "profileId",
    "profileIdentityFingerprint",
    "recordedAt",
    "release",
    "runPhase",
    "searcherMemberId",
    "searcherOrganizationId",
    "version",
  ]);
  if (Object.keys(value).some((key) => !expectedKeys.has(key))) {
    throw new Error("Profile control rollback state has unexpected fields");
  }
  if (
    value.version !== 2 ||
    value.environment !== "production" ||
    !isCanonicalUrl(value.deploymentUrl) ||
    !isClerkId(value.memberId, "user") ||
    !isClerkId(value.organizationId, "org") ||
    !isClerkId(value.searcherMemberId, "user") ||
    !isClerkId(value.searcherOrganizationId, "org") ||
    value.memberId === value.searcherMemberId ||
    value.organizationId === value.searcherOrganizationId ||
    !isUuid(value.profileId) ||
    !isUuid(value.observationId) ||
    typeof value.originalSearchability !== "boolean" ||
    !isFingerprint(value.profileIdentityFingerprint) ||
    typeof value.release !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.release) ||
    !isRunPhase(value.runPhase) ||
    !isIsoTimestamp(value.recordedAt)
  ) {
    throw new Error("Profile control rollback state is invalid");
  }
  return value as ProfileControlState;
};

export const readProfileControlState = (
  contract: ProfileControlContract,
  file = defaultProfileControlStateFile,
): ProfileControlState | null => {
  if (!privateFileExists(file)) return null;
  const state = parseProfileControlState(readPrivateJson(file));
  if (!matchesContract(state, contract)) {
    throw new Error(
      "Profile control rollback state belongs to a different Production fixture",
    );
  }
  return state;
};

export const writeProfileControlState = (
  contract: ProfileControlContract,
  originalSearchability: boolean,
  profileIdentity: string,
  file = defaultProfileControlStateFile,
) => {
  if (privateFileExists(file)) {
    throw new Error("Unrestored Profile control rollback state already exists");
  }
  const state = parseProfileControlState({
    ...contract,
    version: 2,
    environment: "production",
    originalSearchability,
    profileIdentityFingerprint: profileIdentity,
    recordedAt: new Date().toISOString(),
  });
  writePrivateJsonAtomically(file, state);
};

export const removeProfileControlState = (
  file = defaultProfileControlStateFile,
) => removePrivateFile(file);

export const parseProfileControlClaimReceipt = (
  value: unknown,
): ProfileControlClaimReceipt => {
  if (!isRecord(value)) {
    throw new Error("Profile control claim receipt is invalid");
  }
  const expectedKeys = new Set([
    "environment",
    "memberId",
    "observationId",
    "organizationId",
    "profileId",
    "profileIdentityFingerprint",
    "recordedAt",
    "release",
    "sourceDeploymentUrl",
    "version",
  ]);
  if (
    Object.keys(value).some((key) => !expectedKeys.has(key)) ||
    value.version !== 1 ||
    value.environment !== "production" ||
    !isClerkId(value.memberId, "user") ||
    !isClerkId(value.organizationId, "org") ||
    !isUuid(value.profileId) ||
    !isUuid(value.observationId) ||
    !isFingerprint(value.profileIdentityFingerprint) ||
    typeof value.release !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.release) ||
    value.sourceDeploymentUrl !== productionAcceptanceUrl ||
    !isIsoTimestamp(value.recordedAt)
  ) {
    throw new Error("Profile control claim receipt is invalid");
  }
  return value as ProfileControlClaimReceipt;
};

export const readProfileControlClaimReceipt = (
  contract: ProfileControlContract,
  file = profileControlClaimFile(contract.release),
): ProfileControlClaimReceipt | null => {
  if (!privateFileExists(file)) return null;
  const receipt = parseProfileControlClaimReceipt(readPrivateJson(file));
  if (
    receipt.memberId !== contract.memberId ||
    receipt.organizationId !== contract.organizationId ||
    receipt.observationId !== contract.observationId ||
    receipt.profileId !== contract.profileId ||
    receipt.release !== contract.release
  ) {
    throw new Error(
      "Profile control claim receipt belongs to a different Production fixture",
    );
  }
  return receipt;
};

export const writeProfileControlClaimReceipt = (
  contract: ProfileControlContract,
  profileIdentity: string,
  file = profileControlClaimFile(contract.release),
) => {
  if (contract.runPhase !== "staged-claim") {
    throw new Error("Only staged acceptance may record a Profile claim");
  }
  if (privateFileExists(file)) {
    throw new Error("A Profile control claim receipt already exists");
  }
  const receipt = parseProfileControlClaimReceipt({
    version: 1,
    environment: "production",
    memberId: contract.memberId,
    observationId: contract.observationId,
    organizationId: contract.organizationId,
    profileId: contract.profileId,
    profileIdentityFingerprint: profileIdentity,
    release: contract.release,
    sourceDeploymentUrl: contract.deploymentUrl,
    recordedAt: new Date().toISOString(),
  });
  writePrivateJsonAtomically(file, receipt);
};

const matchesContract = (
  state: ProfileControlState,
  contract: ProfileControlContract,
) =>
  state.deploymentUrl === contract.deploymentUrl &&
  state.memberId === contract.memberId &&
  state.observationId === contract.observationId &&
  state.organizationId === contract.organizationId &&
  state.profileId === contract.profileId &&
  state.release === contract.release &&
  state.runPhase === contract.runPhase &&
  state.searcherMemberId === contract.searcherMemberId &&
  state.searcherOrganizationId === contract.searcherOrganizationId;

const isClerkId = (value: unknown, prefix: "org" | "user") =>
  typeof value === "string" &&
  new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(value);

const isUuid = (value: unknown) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

const isFingerprint = (value: unknown) =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

const isRunPhase = (value: unknown): value is ProfileControlRunPhase =>
  value === "post-promotion" || value === "staged-claim";

const isCanonicalUrl = (value: unknown) => {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).href === value;
  } catch {
    return false;
  }
};

const isIsoTimestamp = (value: unknown) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
