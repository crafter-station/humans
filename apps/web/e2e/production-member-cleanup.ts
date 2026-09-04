import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  privateFileExists,
  readPrivateJson,
  removePrivateFile,
  writePrivateJsonAtomically,
} from "./private-state";

export const productionClerkInstanceId =
  "ins_3InStOBNOMbj1uRVtQCN0GLX3tt" as const;

export type ProductionMemberCleanupContract = {
  clerkInstanceId: typeof productionClerkInstanceId;
  email: string;
  memberId: string;
  organizationId: string;
  profileOwnerMemberId: string;
  release: string;
  runId: string;
  runStartedAt: string;
};

export type ProductionMemberCleanupInput = {
  contract: ProductionMemberCleanupContract;
  secretKey: string;
};

type ProductionMemberCleanupState = ProductionMemberCleanupContract & {
  environment: "production";
  memberCreatedAt: string;
  organizationCreatedAt: string;
  validatedAt: string;
  version: 2;
};

type Environment = Record<string, string | undefined>;
type ProjectionTarget = Pick<
  ProductionMemberCleanupContract,
  "memberId" | "organizationId" | "release"
> & { environment: "production" };

type CleanupOptions = {
  environment?: Environment;
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<unknown>;
  stateFile?: string;
  verifyProjection?: (target: ProjectionTarget) => Promise<void>;
};

const cleanupValidationLifetimeMilliseconds = 5 * 60 * 1000;
const disposableRunLifetimeMilliseconds = 24 * 60 * 60 * 1000;
const maximumClockSkewMilliseconds = 60 * 1000;
const defaultCleanupStateFile = resolve(
  "playwright/.clerk/production-member-cleanup.json",
);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const productionMemberCleanupConfirmation = (
  target: ProductionMemberCleanupContract,
) => {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        clerkInstanceId: target.clerkInstanceId,
        email: target.email,
        memberId: target.memberId,
        organizationId: target.organizationId,
        profileOwnerMemberId: target.profileOwnerMemberId,
        release: target.release,
        runId: target.runId,
        runStartedAt: target.runStartedAt,
      }),
    )
    .digest("hex");
  return `production-cleanup:${target.release}:${target.runId}:sha256:${digest}`;
};

export const productionMemberCleanupInputFromEnvironment = (
  environment: Environment = process.env,
  now = Date.now(),
): ProductionMemberCleanupInput => {
  const memberId = requiredClerkId(
    environment,
    "E2E_PRODUCTION_MEMBER_ID",
    "user",
  );
  const organizationId = requiredClerkId(
    environment,
    "E2E_PRODUCTION_ORGANIZATION_ID",
    "org",
  );
  const profileOwnerMemberId = requiredClerkId(
    environment,
    "E2E_PROFILE_OWNER_MEMBER_ID",
    "user",
  );
  if (memberId === profileOwnerMemberId) {
    throw new Error(
      "Production core and Profile-owner fixtures must be distinct Members",
    );
  }
  const release = requiredEnvironment(environment, "E2E_RELEASE_SHA");
  if (!/^[0-9a-f]{40}$/.test(release)) {
    throw new Error("E2E_RELEASE_SHA must be a full Git commit SHA");
  }
  const email = requiredEnvironment(environment, "E2E_PRODUCTION_MEMBER_EMAIL");
  const runId = requiredEnvironment(environment, "E2E_PRODUCTION_RUN_ID");
  const marker = parseDisposableEmail(email, "production");
  if (marker === null || marker.runId !== runId || !uuidPattern.test(runId)) {
    throw new Error(
      "Production Member must use the run-bound disposable email",
    );
  }
  assertFreshTimestamp(
    marker.startedAt,
    now,
    "Production fixture creation state",
  );
  const secretKey = requiredEnvironment(environment, "CLERK_SECRET_KEY");
  if (!/^sk_live_[A-Za-z0-9_-]+$/.test(secretKey)) {
    throw new Error(
      "Production Member cleanup requires a Clerk Production secret key",
    );
  }
  const contract: ProductionMemberCleanupContract = {
    clerkInstanceId: productionClerkInstanceId,
    email,
    memberId,
    organizationId,
    profileOwnerMemberId,
    release,
    runId,
    runStartedAt: new Date(marker.startedAt).toISOString(),
  };
  if (
    requiredEnvironment(environment, "E2E_PRODUCTION_CLEANUP_CONFIRMATION") !==
    productionMemberCleanupConfirmation(contract)
  ) {
    throw new Error("Production Member cleanup confirmation is invalid");
  }
  return { contract, secretKey };
};

export const cleanupProductionMember = async (
  input = productionMemberCleanupInputFromEnvironment(),
  options: CleanupOptions = {},
) => {
  const now = options.now ?? Date.now;
  assertCleanupInput(input, now());
  const fetcher = options.fetcher ?? fetch;
  const stateFile = options.stateFile ?? defaultCleanupStateFile;
  const priorValidation = readCleanupState(input.contract, stateFile, now());

  await assertClerkInstance(
    input.secretKey,
    productionClerkInstanceId,
    "production",
    fetcher,
  );

  const [member, organization, matchingMemberIds] = await Promise.all([
    readClerkMember(input.contract.memberId, input.secretKey, fetcher),
    readClerkOrganization(
      input.contract.organizationId,
      input.secretKey,
      fetcher,
    ),
    findClerkUsers(input.contract.email, input.secretKey, fetcher),
  ]);

  if (priorValidation === null) {
    if (
      member === null &&
      organization === null &&
      matchingMemberIds.length === 0
    ) {
      await verifyHumansProjection(input.contract, options, fetcher);
      removePrivateFile(stateFile);
      return;
    }
    if (member === null || organization === null) {
      throw new Error("Production fixture is already partially deleted");
    }
    const [memberOrganizations, organizationMembers] = await Promise.all([
      listClerkMemberOrganizations(member.id, input.secretKey, fetcher),
      listClerkOrganizationMembers(organization.id, input.secretKey, fetcher),
    ]);
    validateLiveFixture(
      input.contract,
      member,
      organization,
      matchingMemberIds,
      memberOrganizations,
      organizationMembers,
      now(),
    );
    writeCleanupState(input.contract, member, organization, stateFile, now());
  } else {
    validateResumableFixture(
      input.contract,
      priorValidation,
      member,
      organization,
      matchingMemberIds,
      await listResumeInventories(
        member,
        organization,
        input.secretKey,
        fetcher,
      ),
      now(),
    );
  }

  if (organization !== null) {
    await deleteClerkResource(
      "organizations",
      input.contract.organizationId,
      input.secretKey,
      fetcher,
    );
  }
  await verifyClerkResourceMissing(
    "organizations",
    input.contract.organizationId,
    input.secretKey,
    fetcher,
    options.sleep,
  );

  if (member !== null) {
    await deleteClerkResource(
      "users",
      input.contract.memberId,
      input.secretKey,
      fetcher,
    );
  }
  await verifyClerkResourceMissing(
    "users",
    input.contract.memberId,
    input.secretKey,
    fetcher,
    options.sleep,
  );
  if (
    (await findClerkUsers(input.contract.email, input.secretKey, fetcher))
      .length !== 0
  ) {
    throw new Error("Production Member deletion could not be verified");
  }
  await verifyHumansProjection(input.contract, options, fetcher);
  removePrivateFile(stateFile);
};

const validateLiveFixture = (
  contract: ProductionMemberCleanupContract,
  member: ClerkMember,
  organization: ClerkOrganization,
  matchingMemberIds: string[],
  memberOrganizations: ClerkInventory,
  organizationMembers: ClerkInventory,
  now: number,
) => {
  validateMember(contract, member, matchingMemberIds, now);
  if (
    organization.createdBy !== contract.memberId ||
    memberOrganizations.totalCount !== 1 ||
    memberOrganizations.ids[0] !== contract.organizationId ||
    organizationMembers.totalCount !== 1 ||
    organizationMembers.ids[0] !== contract.memberId
  ) {
    throw new Error(
      "Production Organization ownership or membership validation failed",
    );
  }
  validateResourceTimestamp(contract, organization.createdAt, now);
  if (
    organization.createdAt + maximumClockSkewMilliseconds <
    member.createdAt
  ) {
    throw new Error("Production fixture creation state validation failed");
  }
};

const validateResumableFixture = (
  contract: ProductionMemberCleanupContract,
  state: ProductionMemberCleanupState,
  member: ClerkMember | null,
  organization: ClerkOrganization | null,
  matchingMemberIds: string[],
  inventories: {
    memberOrganizations: ClerkInventory | null;
    organizationMembers: ClerkInventory | null;
  },
  now: number,
) => {
  if (member === null && organization !== null) {
    throw new Error("Production cleanup state does not match deletion order");
  }
  if (member !== null) {
    validateMember(contract, member, matchingMemberIds, now);
    if (new Date(state.memberCreatedAt).getTime() !== member.createdAt) {
      throw new Error("Production cleanup validation state no longer matches");
    }
  } else if (matchingMemberIds.length !== 0) {
    throw new Error("Production Member email validation failed");
  }
  if (organization !== null) {
    if (
      member === null ||
      inventories.memberOrganizations === null ||
      inventories.organizationMembers === null
    ) {
      throw new Error("Production cleanup validation state no longer matches");
    }
    validateLiveFixture(
      contract,
      member,
      organization,
      matchingMemberIds,
      inventories.memberOrganizations,
      inventories.organizationMembers,
      now,
    );
    if (
      new Date(state.organizationCreatedAt).getTime() !== organization.createdAt
    ) {
      throw new Error("Production cleanup validation state no longer matches");
    }
  } else if (
    member !== null &&
    (inventories.memberOrganizations === null ||
      inventories.memberOrganizations.totalCount !== 0)
  ) {
    throw new Error("Production Member has another Organization membership");
  }
};

const validateMember = (
  contract: ProductionMemberCleanupContract,
  member: ClerkMember,
  matchingMemberIds: string[],
  now: number,
) => {
  if (
    member.email !== contract.email ||
    matchingMemberIds.length !== 1 ||
    matchingMemberIds[0] !== contract.memberId
  ) {
    throw new Error("Production Member email validation failed");
  }
  validateResourceTimestamp(contract, member.createdAt, now);
};

const validateResourceTimestamp = (
  contract: ProductionMemberCleanupContract,
  createdAt: number,
  now: number,
) => {
  const startedAt = new Date(contract.runStartedAt).getTime();
  if (
    createdAt < startedAt - maximumClockSkewMilliseconds ||
    createdAt > now + maximumClockSkewMilliseconds ||
    now - createdAt > disposableRunLifetimeMilliseconds
  ) {
    throw new Error("Production fixture creation state validation failed");
  }
};

const listResumeInventories = async (
  member: ClerkMember | null,
  organization: ClerkOrganization | null,
  secretKey: string,
  fetcher: typeof fetch,
) => {
  const [memberOrganizations, organizationMembers] = await Promise.all([
    member === null
      ? null
      : listClerkMemberOrganizations(member.id, secretKey, fetcher),
    organization === null
      ? null
      : listClerkOrganizationMembers(organization.id, secretKey, fetcher),
  ]);
  return { memberOrganizations, organizationMembers };
};

const assertCleanupInput = (
  input: ProductionMemberCleanupInput,
  now: number,
) => {
  const marker = parseDisposableEmail(input.contract.email, "production");
  if (
    !/^sk_live_[A-Za-z0-9_-]+$/.test(input.secretKey) ||
    input.contract.clerkInstanceId !== productionClerkInstanceId ||
    marker === null ||
    marker.runId !== input.contract.runId ||
    new Date(marker.startedAt).toISOString() !== input.contract.runStartedAt ||
    !isClerkId(input.contract.memberId, "user") ||
    !isClerkId(input.contract.organizationId, "org") ||
    !isClerkId(input.contract.profileOwnerMemberId, "user") ||
    input.contract.memberId === input.contract.profileOwnerMemberId ||
    !/^[0-9a-f]{40}$/.test(input.contract.release)
  ) {
    throw new Error("Production Member cleanup input is invalid");
  }
  assertFreshTimestamp(
    marker.startedAt,
    now,
    "Production fixture creation state",
  );
};

const readCleanupState = (
  contract: ProductionMemberCleanupContract,
  stateFile: string,
  now: number,
) => {
  if (!privateFileExists(stateFile)) return null;
  const state = parseCleanupState(readPrivateJson(stateFile));
  if (
    state.clerkInstanceId !== contract.clerkInstanceId ||
    state.email !== contract.email ||
    state.memberId !== contract.memberId ||
    state.organizationId !== contract.organizationId ||
    state.profileOwnerMemberId !== contract.profileOwnerMemberId ||
    state.release !== contract.release ||
    state.runId !== contract.runId ||
    state.runStartedAt !== contract.runStartedAt
  ) {
    throw new Error(
      "Production Member cleanup state belongs to a different fixture",
    );
  }
  const validatedAt = new Date(state.validatedAt).getTime();
  if (
    validatedAt > now + maximumClockSkewMilliseconds ||
    now - validatedAt > cleanupValidationLifetimeMilliseconds
  ) {
    throw new Error("Production Member cleanup validation has expired");
  }
  return state;
};

const writeCleanupState = (
  contract: ProductionMemberCleanupContract,
  member: ClerkMember,
  organization: ClerkOrganization,
  stateFile: string,
  now: number,
) => {
  const state = parseCleanupState({
    ...contract,
    environment: "production",
    memberCreatedAt: new Date(member.createdAt).toISOString(),
    organizationCreatedAt: new Date(organization.createdAt).toISOString(),
    validatedAt: new Date(now).toISOString(),
    version: 2,
  });
  writePrivateJsonAtomically(stateFile, state);
};

const parseCleanupState = (value: unknown): ProductionMemberCleanupState => {
  if (!isRecord(value)) {
    throw new Error("Production Member cleanup state is invalid");
  }
  const expectedKeys = new Set([
    "clerkInstanceId",
    "email",
    "environment",
    "memberCreatedAt",
    "memberId",
    "organizationCreatedAt",
    "organizationId",
    "profileOwnerMemberId",
    "release",
    "runId",
    "runStartedAt",
    "validatedAt",
    "version",
  ]);
  if (
    Object.keys(value).some((key) => !expectedKeys.has(key)) ||
    value.version !== 2 ||
    value.environment !== "production" ||
    value.clerkInstanceId !== productionClerkInstanceId ||
    parseDisposableEmail(value.email, "production") === null ||
    !isClerkId(value.memberId, "user") ||
    !isClerkId(value.organizationId, "org") ||
    !isClerkId(value.profileOwnerMemberId, "user") ||
    value.memberId === value.profileOwnerMemberId ||
    typeof value.release !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.release) ||
    typeof value.runId !== "string" ||
    !uuidPattern.test(value.runId) ||
    !isIsoTimestamp(value.runStartedAt) ||
    !isIsoTimestamp(value.memberCreatedAt) ||
    !isIsoTimestamp(value.organizationCreatedAt) ||
    !isIsoTimestamp(value.validatedAt)
  ) {
    throw new Error("Production Member cleanup state is invalid");
  }
  return value as ProductionMemberCleanupState;
};

type ClerkMember = { createdAt: number; email: string; id: string };
type ClerkOrganization = { createdAt: number; createdBy: string; id: string };
type ClerkInventory = { ids: string[]; totalCount: number };

const assertClerkInstance = async (
  secretKey: string,
  expectedId: string,
  expectedEnvironment: "development" | "production",
  fetcher: typeof fetch,
) => {
  const response = await clerkFetch(
    fetcher,
    "https://api.clerk.com/v1/instance",
    { headers: clerkHeaders(secretKey) },
    "Clerk instance verification failed",
  );
  if (!response.ok) {
    await cancelBody(response);
    throw new Error("Clerk instance verification failed");
  }
  const value = await responseJson(
    response,
    "Clerk instance verification failed",
  );
  if (
    !isRecord(value) ||
    value.id !== expectedId ||
    value.environment_type !== expectedEnvironment
  ) {
    throw new Error("Clerk instance verification failed");
  }
};

const findClerkUsers = async (
  email: string,
  secretKey: string,
  fetcher: typeof fetch,
) => {
  const url = new URL("https://api.clerk.com/v1/users");
  url.searchParams.set("email_address", email);
  url.searchParams.set("limit", "2");
  const response = await clerkFetch(
    fetcher,
    url,
    { headers: clerkHeaders(secretKey) },
    "Clerk Production Member lookup failed",
  );
  if (!response.ok) throw new Error("Clerk Production Member lookup failed");
  const value = await responseJson(
    response,
    "Clerk Production Member lookup failed",
  );
  if (
    !Array.isArray(value) ||
    value.some((item) => !isClerkResource(item, "user"))
  ) {
    throw new Error(
      "Clerk Production Member lookup returned an invalid response",
    );
  }
  return value.map(({ id }) => id);
};

const readClerkMember = async (
  memberId: string,
  secretKey: string,
  fetcher: typeof fetch,
): Promise<ClerkMember | null> => {
  const response = await clerkFetch(
    fetcher,
    `https://api.clerk.com/v1/users/${encodeURIComponent(memberId)}`,
    { headers: clerkHeaders(secretKey) },
    "Clerk Production Member lookup failed",
  );
  if (response.status === 404) {
    await cancelBody(response);
    return null;
  }
  if (!response.ok) throw new Error("Clerk Production Member lookup failed");
  const value = await responseJson(
    response,
    "Clerk Production Member lookup failed",
  );
  if (
    !isRecord(value) ||
    value.id !== memberId ||
    !Number.isSafeInteger(value.created_at) ||
    !Array.isArray(value.email_addresses) ||
    typeof value.primary_email_address_id !== "string"
  ) {
    throw new Error(
      "Clerk Production Member lookup returned an invalid response",
    );
  }
  const primary = value.email_addresses.find(
    (item) => isRecord(item) && item.id === value.primary_email_address_id,
  );
  if (!isRecord(primary) || typeof primary.email_address !== "string") {
    throw new Error(
      "Clerk Production Member lookup returned an invalid response",
    );
  }
  return {
    createdAt: value.created_at as number,
    email: primary.email_address,
    id: memberId,
  };
};

const readClerkOrganization = async (
  organizationId: string,
  secretKey: string,
  fetcher: typeof fetch,
): Promise<ClerkOrganization | null> => {
  const response = await clerkFetch(
    fetcher,
    `https://api.clerk.com/v1/organizations/${encodeURIComponent(organizationId)}`,
    { headers: clerkHeaders(secretKey) },
    "Clerk Production Organization lookup failed",
  );
  if (response.status === 404) {
    await cancelBody(response);
    return null;
  }
  if (!response.ok)
    throw new Error("Clerk Production Organization lookup failed");
  const value = await responseJson(
    response,
    "Clerk Production Organization lookup failed",
  );
  if (
    !isRecord(value) ||
    value.id !== organizationId ||
    !isClerkId(value.created_by, "user") ||
    !Number.isSafeInteger(value.created_at)
  ) {
    throw new Error(
      "Clerk Production Organization lookup returned an invalid response",
    );
  }
  return {
    createdAt: value.created_at as number,
    createdBy: value.created_by as string,
    id: organizationId,
  };
};

const listClerkMemberOrganizations = (
  memberId: string,
  secretKey: string,
  fetcher: typeof fetch,
) =>
  readInventory(
    `https://api.clerk.com/v1/users/${encodeURIComponent(memberId)}/organization_memberships`,
    secretKey,
    fetcher,
    "Clerk Production Member Organization lookup failed",
    (item) =>
      isRecord(item) &&
      isRecord(item.organization) &&
      isClerkId(item.organization.id, "org")
        ? (item.organization.id as string)
        : null,
  );

const listClerkOrganizationMembers = (
  organizationId: string,
  secretKey: string,
  fetcher: typeof fetch,
) =>
  readInventory(
    `https://api.clerk.com/v1/organizations/${encodeURIComponent(organizationId)}/memberships`,
    secretKey,
    fetcher,
    "Clerk Production Organization membership lookup failed",
    (item) =>
      isRecord(item) &&
      isRecord(item.organization) &&
      item.organization.id === organizationId &&
      isRecord(item.public_user_data) &&
      isClerkId(item.public_user_data.user_id, "user")
        ? (item.public_user_data.user_id as string)
        : null,
  );

const readInventory = async (
  endpoint: string,
  secretKey: string,
  fetcher: typeof fetch,
  failureMessage: string,
  readId: (item: unknown) => string | null,
): Promise<ClerkInventory> => {
  const url = new URL(endpoint);
  url.searchParams.set("limit", "2");
  url.searchParams.set("offset", "0");
  const response = await clerkFetch(
    fetcher,
    url,
    { headers: clerkHeaders(secretKey) },
    failureMessage,
  );
  if (!response.ok) throw new Error(failureMessage);
  const value = await responseJson(response, failureMessage);
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.total_count) ||
    (value.total_count as number) < 0 ||
    !Array.isArray(value.data) ||
    value.data.length !== Math.min(value.total_count as number, 2)
  ) {
    throw new Error(`${failureMessage} returned an invalid response`);
  }
  const ids = value.data.map(readId);
  if (ids.some((id) => id === null) || new Set(ids).size !== ids.length) {
    throw new Error(`${failureMessage} returned an invalid response`);
  }
  return { ids: ids as string[], totalCount: value.total_count as number };
};

const deleteClerkResource = async (
  resource: "organizations" | "users",
  id: string,
  secretKey: string,
  fetcher: typeof fetch,
) => {
  const response = await clerkFetch(
    fetcher,
    `https://api.clerk.com/v1/${resource}/${encodeURIComponent(id)}`,
    { method: "DELETE", headers: clerkHeaders(secretKey) },
    `Clerk Production ${resource} cleanup failed`,
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Clerk Production ${resource} cleanup failed`);
  }
  await cancelBody(response);
};

const verifyClerkResourceMissing = async (
  resource: "organizations" | "users",
  id: string,
  secretKey: string,
  fetcher: typeof fetch,
  sleep: (milliseconds: number) => Promise<unknown> = delay,
) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await clerkFetch(
      fetcher,
      `https://api.clerk.com/v1/${resource}/${encodeURIComponent(id)}`,
      { headers: clerkHeaders(secretKey) },
      `Clerk Production ${resource} verification failed`,
    );
    if (response.status === 404) {
      await cancelBody(response);
      return;
    }
    if (!response.ok) {
      throw new Error(`Clerk Production ${resource} verification failed`);
    }
    await cancelBody(response);
    await sleep(250);
  }
  throw new Error(
    `Clerk Production ${resource} deletion could not be verified`,
  );
};

const verifyHumansProjection = async (
  contract: ProductionMemberCleanupContract,
  options: CleanupOptions,
  fetcher: typeof fetch,
) => {
  const target: ProjectionTarget = {
    environment: "production",
    memberId: contract.memberId,
    organizationId: contract.organizationId,
    release: contract.release,
  };
  if (options.verifyProjection !== undefined) {
    await options.verifyProjection(target);
    return;
  }
  await pollHumansProjection(
    target,
    options.environment ?? process.env,
    fetcher,
    options.sleep,
  );
};

const pollHumansProjection = async (
  target: ProjectionTarget,
  environment: Environment,
  fetcher: typeof fetch,
  sleep: (milliseconds: number) => Promise<unknown> = delay,
) => {
  const api = approvedApiUrl(environment, "production");
  const proxySecret = requiredEnvironment(environment, "HUMANS_PROXY_SECRET");
  if (proxySecret.length < 16) {
    throw new Error("Humans projection verification configuration is invalid");
  }
  const endpoint = new URL("/v1/internal/clerk-projections", api);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await clerkFetch(
      fetcher,
      endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Humans-Web-Proxy": proxySecret,
        },
        body: JSON.stringify({
          memberId: target.memberId,
          organizationId: target.organizationId,
        }),
      },
      "Humans projection verification failed",
    );
    if (response.status === 200) {
      const value = await responseJson(
        response,
        "Humans projection verification failed",
      );
      if (
        response.headers.get("x-humans-environment") === target.environment &&
        response.headers.get("x-humans-release") === target.release &&
        isInactiveProjection(value)
      ) {
        return;
      }
    } else {
      await cancelBody(response);
    }
    await sleep(250);
  }
  throw new Error("Humans projection deletion could not be verified");
};

const isInactiveProjection = (value: unknown) =>
  isRecord(value) &&
  (value.member === "inactive" || value.member === "absent") &&
  (value.organization === "inactive" || value.organization === "absent") &&
  (value.membership === "inactive" || value.membership === "absent") &&
  Object.keys(value).every((key) =>
    ["member", "membership", "organization"].includes(key),
  );

const approvedApiUrl = (
  environment: Environment,
  target: "preview" | "production",
) => {
  const value = requiredEnvironment(environment, "HUMANS_ACCEPTANCE_API_URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Humans projection verification configuration is invalid");
  }
  const hosts =
    target === "preview"
      ? new Set(["humans-api-preview.hi-541.workers.dev"])
      : new Set([
          "humans-api-production.hi-541.workers.dev",
          "api.humans.crafter.run",
        ]);
  if (
    url.protocol !== "https:" ||
    !hosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Humans projection verification configuration is invalid");
  }
  return url;
};

const clerkFetch = async (
  fetcher: typeof fetch,
  input: string | URL,
  init: RequestInit,
  failureMessage: string,
) => {
  try {
    return await fetcher(input, init);
  } catch {
    throw new Error(failureMessage);
  }
};

const responseJson = async (response: Response, failureMessage: string) => {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error(failureMessage);
  }
};

const cancelBody = async (response: Response) => {
  try {
    await response.body?.cancel();
  } catch {
    throw new Error("Clerk response cleanup failed");
  }
};

const clerkHeaders = (secretKey: string) => ({
  accept: "application/json",
  authorization: `Bearer ${secretKey}`,
});

const parseDisposableEmail = (
  value: unknown,
  target: "preview" | "production",
) => {
  if (typeof value !== "string" || value !== value.toLowerCase()) return null;
  const pattern =
    target === "preview"
      ? /^humans-release-(\d{13})-([0-9a-f-]{36})\+clerk_test@example\.com$/
      : /^humans-release-(\d{13})-([0-9a-f-]{36})@([^@\s]+)$/;
  const match = pattern.exec(value);
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    !uuidPattern.test(match[2]) ||
    (target === "production" &&
      (match[3] === undefined || match[3].endsWith("example.com")))
  ) {
    return null;
  }
  const startedAt = Number(match[1]);
  return Number.isSafeInteger(startedAt)
    ? { runId: match[2], startedAt }
    : null;
};

const assertFreshTimestamp = (
  timestamp: number,
  now: number,
  label: string,
) => {
  if (
    timestamp > now + maximumClockSkewMilliseconds ||
    now - timestamp > disposableRunLifetimeMilliseconds
  ) {
    throw new Error(`${label} has expired`);
  }
};

const requiredEnvironment = (environment: Environment, name: string) => {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for Production cleanup`);
  return value;
};

const requiredClerkId = (
  environment: Environment,
  name: string,
  prefix: "org" | "user",
) => {
  const value = requiredEnvironment(environment, name);
  if (!isClerkId(value, prefix)) {
    throw new Error(`${name} is not a valid Clerk identifier`);
  }
  return value;
};

const isClerkResource = (
  value: unknown,
  prefix: "org" | "user",
): value is { id: string } => isRecord(value) && isClerkId(value.id, prefix);

const isClerkId = (value: unknown, prefix: "org" | "user") =>
  typeof value === "string" &&
  new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(value);

const isIsoTimestamp = (value: unknown) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
