import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  deploymentUrl,
  requiredClerkId,
  requiredEnvironment,
} from "./deployment";
import {
  privateFileExists,
  readPrivateJson,
  removePrivateFile,
  writePrivateJsonAtomically,
} from "./private-state";

export type OperatorControlContract = {
  deploymentUrl: string;
  operatorId: string;
  organizationId: string;
  release: string;
};

type PendingOperatorControlState = OperatorControlContract & {
  version: 1;
  adjustment: 1;
  environment: "preview";
  forwardIdempotencyKey: string;
  forwardReason: string;
  originalBalance: number;
  phase: "pending";
  recordedAt: string;
  rollbackIdempotencyKey: string;
  rollbackReason: string;
};

type AppliedOperatorControlState = Omit<
  PendingOperatorControlState,
  "phase"
> & {
  adjustedBalance: number;
  phase: "applied";
};

export type OperatorControlState =
  | AppliedOperatorControlState
  | PendingOperatorControlState;

const operatorControlStateFile = (contract: OperatorControlContract) => {
  const binding = createHash("sha256")
    .update(
      `${contract.release}\0${contract.operatorId}\0${contract.organizationId}`,
    )
    .digest("hex");
  return resolve(`playwright/.clerk/operator-credit-rollback-${binding}.json`);
};

export const operatorControlContractFromEnvironment = (
  organizationId: string,
): OperatorControlContract => {
  const release = requiredEnvironment("E2E_RELEASE_SHA");
  if (
    !/^[0-9a-f]{40}$/.test(release) ||
    !/^org_[A-Za-z0-9_-]+$/.test(organizationId)
  ) {
    throw new Error("Operator Credit adjustment contract is invalid");
  }
  return {
    deploymentUrl: deploymentUrl("preview").href,
    // The one-use Operator URL is accepted only after this stable ID matches.
    operatorId: requiredClerkId("E2E_OPERATOR_MEMBER_ID", "user"),
    organizationId,
    release,
  };
};

export const parseOperatorControlState = (
  value: unknown,
): OperatorControlState => {
  if (!isRecord(value)) {
    throw new Error("Operator Credit rollback state is invalid");
  }
  const expectedKeys = new Set([
    "adjustedBalance",
    "adjustment",
    "deploymentUrl",
    "environment",
    "forwardIdempotencyKey",
    "forwardReason",
    "operatorId",
    "organizationId",
    "originalBalance",
    "phase",
    "recordedAt",
    "release",
    "rollbackIdempotencyKey",
    "rollbackReason",
    "version",
  ]);
  if (Object.keys(value).some((key) => !expectedKeys.has(key))) {
    throw new Error("Operator Credit rollback state has unexpected fields");
  }
  const validBase =
    value.version === 1 &&
    value.adjustment === 1 &&
    value.environment === "preview" &&
    isCanonicalUrl(value.deploymentUrl) &&
    isClerkId(value.operatorId, "user") &&
    isClerkId(value.organizationId, "org") &&
    isBalance(value.originalBalance) &&
    isUuid(value.forwardIdempotencyKey) &&
    isUuid(value.rollbackIdempotencyKey) &&
    typeof value.forwardReason === "string" &&
    value.forwardReason.length > 0 &&
    value.forwardReason.length <= 500 &&
    typeof value.rollbackReason === "string" &&
    value.rollbackReason.length > 0 &&
    value.rollbackReason.length <= 500 &&
    typeof value.release === "string" &&
    /^[0-9a-f]{40}$/.test(value.release) &&
    isIsoTimestamp(value.recordedAt);
  const validPhase =
    (value.phase === "pending" && value.adjustedBalance === undefined) ||
    (value.phase === "applied" &&
      isBalance(value.adjustedBalance) &&
      value.adjustedBalance === (value.originalBalance as number) + 1);
  if (!validBase || !validPhase) {
    throw new Error("Operator Credit rollback state is invalid");
  }
  return value as OperatorControlState;
};

export const readOperatorControlState = (
  contract: OperatorControlContract,
  file = operatorControlStateFile(contract),
): OperatorControlState | null => {
  if (!privateFileExists(file)) return null;
  const state = parseOperatorControlState(readPrivateJson(file));
  if (
    state.deploymentUrl !== contract.deploymentUrl ||
    state.operatorId !== contract.operatorId ||
    state.organizationId !== contract.organizationId ||
    state.release !== contract.release
  ) {
    throw new Error(
      "Operator Credit rollback state belongs to a different Preview fixture",
    );
  }
  return state;
};

export const beginOperatorControl = (
  contract: OperatorControlContract,
  originalBalance: number,
  file = operatorControlStateFile(contract),
) => {
  if (!isBalance(originalBalance)) {
    throw new Error("Original Organization Credit balance is invalid");
  }
  if (privateFileExists(file)) {
    throw new Error("Unrestored Operator Credit rollback state already exists");
  }
  const runId = crypto.randomUUID();
  const state = parseOperatorControlState({
    ...contract,
    version: 1,
    adjustment: 1,
    environment: "preview",
    forwardIdempotencyKey: crypto.randomUUID(),
    forwardReason: `Preview browser acceptance ${runId}`,
    originalBalance,
    phase: "pending",
    recordedAt: new Date().toISOString(),
    rollbackIdempotencyKey: crypto.randomUUID(),
    rollbackReason: `Preview browser acceptance ${runId} restoration`,
  });
  writePrivateJsonAtomically(file, state);
  return state;
};

export const markOperatorControlApplied = (
  contract: OperatorControlContract,
  adjustedBalance: number,
  file = operatorControlStateFile(contract),
) => {
  const state = readOperatorControlState(contract, file);
  if (
    state === null ||
    state.phase !== "pending" ||
    adjustedBalance !== state.originalBalance + state.adjustment
  ) {
    throw new Error("Applied Operator Credit adjustment is invalid");
  }
  const applied = parseOperatorControlState({
    ...state,
    adjustedBalance,
    phase: "applied",
  });
  if (applied.phase !== "applied") {
    throw new Error("Applied Operator Credit adjustment is invalid");
  }
  writePrivateJsonAtomically(file, applied);
  return applied;
};

export const removeOperatorControlState = (
  contract: OperatorControlContract,
  file = operatorControlStateFile(contract),
) => removePrivateFile(file);

const isBalance = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const isClerkId = (value: unknown, prefix: "org" | "user") =>
  typeof value === "string" &&
  new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(value);

const isUuid = (value: unknown) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

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
