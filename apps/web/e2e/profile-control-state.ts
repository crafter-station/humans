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

export type ProfileControlContract = {
  deploymentUrl: string;
  memberId: string;
  observationId: string;
  profileId: string;
  release: string;
};

export type ProfileControlState = ProfileControlContract & {
  version: 1;
  environment: "production";
  originalSearchability: boolean;
  recordedAt: string;
};

const defaultProfileControlStateFile = resolve(
  "playwright/.clerk/profile-control-rollback.json",
);

export const profileControlContractFromEnvironment =
  (): ProfileControlContract => {
    const release = requiredEnvironment("E2E_RELEASE_SHA");
    if (!/^[0-9a-f]{40}$/.test(release)) {
      throw new Error("E2E_RELEASE_SHA must be a full Git commit SHA");
    }
    return {
      deploymentUrl: deploymentUrl("production").href,
      memberId: requiredClerkId("E2E_PROFILE_OWNER_MEMBER_ID", "user"),
      observationId: requiredUuid("E2E_PROFILE_CONTROL_OBSERVATION_ID"),
      profileId: requiredUuid("E2E_PROFILE_CONTROL_PROFILE_ID"),
      release,
    };
  };

export const parseProfileControlState = (
  value: unknown,
): ProfileControlState => {
  if (!isRecord(value))
    throw new Error("Profile control rollback state is invalid");
  const expectedKeys = new Set([
    "deploymentUrl",
    "environment",
    "memberId",
    "observationId",
    "originalSearchability",
    "profileId",
    "recordedAt",
    "release",
    "version",
  ]);
  if (Object.keys(value).some((key) => !expectedKeys.has(key))) {
    throw new Error("Profile control rollback state has unexpected fields");
  }
  if (
    value.version !== 1 ||
    value.environment !== "production" ||
    typeof value.deploymentUrl !== "string" ||
    !isClerkUserId(value.memberId) ||
    !isUuid(value.profileId) ||
    !isUuid(value.observationId) ||
    typeof value.originalSearchability !== "boolean" ||
    typeof value.release !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.release) ||
    !isIsoTimestamp(value.recordedAt)
  ) {
    throw new Error("Profile control rollback state is invalid");
  }
  let url: URL;
  try {
    url = new URL(value.deploymentUrl);
  } catch {
    throw new Error("Profile control rollback state is invalid");
  }
  if (url.href !== value.deploymentUrl) {
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
  if (
    state.deploymentUrl !== contract.deploymentUrl ||
    state.memberId !== contract.memberId ||
    state.observationId !== contract.observationId ||
    state.profileId !== contract.profileId ||
    state.release !== contract.release
  ) {
    throw new Error(
      "Profile control rollback state belongs to a different Production fixture",
    );
  }
  return state;
};

export const writeProfileControlState = (
  contract: ProfileControlContract,
  originalSearchability: boolean,
  file = defaultProfileControlStateFile,
) => {
  if (privateFileExists(file)) {
    throw new Error("Unrestored Profile control rollback state already exists");
  }
  const state = parseProfileControlState({
    ...contract,
    version: 1,
    environment: "production",
    originalSearchability,
    recordedAt: new Date().toISOString(),
  });
  writePrivateJsonAtomically(file, state);
};

export const removeProfileControlState = (
  file = defaultProfileControlStateFile,
) => removePrivateFile(file);

const isClerkUserId = (value: unknown) =>
  typeof value === "string" && /^user_[A-Za-z0-9_-]+$/.test(value);

const isUuid = (value: unknown) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

const isIsoTimestamp = (value: unknown) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
