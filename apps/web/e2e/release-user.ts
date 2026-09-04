import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  privateFileExists,
  readPrivateJson,
  removePrivateFile,
  writePrivateJsonAtomically,
} from "./private-state";

export const previewClerkInstanceId =
  "ins_3InRqXS3sKxXPyqqiOMQ75PhGQx" as const;

export type ReleaseMember = {
  email: string;
  organizationId?: string;
  userId?: string;
};

export type ReleaseUserCredentials = {
  publishableKey: string;
  secretKey: string;
};

export type ReleaseUserRecord = ReleaseMember & {
  clerkEnvironment: "development";
  clerkInstanceId: typeof previewClerkInstanceId;
  createdAt: string;
  memberCreatedAt?: string;
  organizationCreatedAt?: string;
  release: string;
  releaseEnvironment: "preview";
  runId: string;
  runStartedAt: string;
  validatedAt?: string;
  version: 2;
};

type Environment = Record<string, string | undefined>;
type ProjectionTarget = {
  environment: "preview";
  memberId: string;
  organizationId: string;
  release: string;
};
type CleanupOptions = {
  environment?: Environment;
  fetcher?: typeof fetch;
  file?: string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<unknown>;
  verifyProjection?: (target: ProjectionTarget) => Promise<void>;
};

const cleanupValidationLifetimeMilliseconds = 5 * 60 * 1000;
const disposableRunLifetimeMilliseconds = 24 * 60 * 60 * 1000;
const maximumClockSkewMilliseconds = 60 * 1000;
const defaultReleaseUserFile = resolve("playwright/.clerk/release-user.json");
const legacyPreviewStorageStateFile = resolve("playwright/.clerk/preview.json");
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const removeLegacyPreviewStorageState = () =>
  removePrivateFile(legacyPreviewStorageStateFile);

export const releaseUserCredentialsFromEnvironment =
  (): ReleaseUserCredentials => {
    const publishableKey = process.env.CLERK_PUBLISHABLE_KEY?.trim();
    const secretKey = process.env.CLERK_SECRET_KEY?.trim();
    if (!publishableKey) {
      throw new Error(
        "CLERK_PUBLISHABLE_KEY is required for browser acceptance",
      );
    }
    if (!secretKey) {
      throw new Error("CLERK_SECRET_KEY is required for browser acceptance");
    }
    const credentials = { publishableKey, secretKey };
    assertCredentialShape(credentials);
    return credentials;
  };

export const parseReleaseUser = (value: unknown): ReleaseUserRecord => {
  if (!isRecord(value)) throw new Error("Release Member state is invalid");
  const allowedKeys = new Set([
    "clerkEnvironment",
    "clerkInstanceId",
    "createdAt",
    "email",
    "memberCreatedAt",
    "organizationCreatedAt",
    "organizationId",
    "release",
    "releaseEnvironment",
    "runId",
    "runStartedAt",
    "userId",
    "validatedAt",
    "version",
  ]);
  const validationFields = [
    value.memberCreatedAt,
    value.organizationCreatedAt,
    value.validatedAt,
  ];
  const marker = parsePreviewDisposableEmail(value.email);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("Release Member state contains unexpected fields");
  }
  if (
    value.version !== 2 ||
    value.releaseEnvironment !== "preview" ||
    value.clerkEnvironment !== "development" ||
    value.clerkInstanceId !== previewClerkInstanceId ||
    marker === null ||
    marker.runId !== value.runId ||
    new Date(marker.startedAt).toISOString() !== value.runStartedAt ||
    !isIsoTimestamp(value.createdAt) ||
    typeof value.release !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.release) ||
    !isOptionalClerkId(value.userId, "user") ||
    !isOptionalClerkId(value.organizationId, "org") ||
    (value.organizationId !== undefined && value.userId === undefined) ||
    (!validationFields.every((field) => field === undefined) &&
      !validationFields.every(isIsoTimestamp)) ||
    (value.validatedAt !== undefined && value.organizationId === undefined)
  ) {
    throw new Error("Release Member state is invalid");
  }
  return value as ReleaseUserRecord;
};

export const readReleaseUser = (
  credentials = releaseUserCredentialsFromEnvironment(),
  file = defaultReleaseUserFile,
  environment: Environment = process.env,
  now = Date.now(),
): ReleaseUserRecord | null => {
  if (!privateFileExists(file)) return null;
  assertCredentialShape(credentials);
  const record = parseReleaseUser(readPrivateJson(file));
  assertRunBinding(record, environment, now);
  return record;
};

export const writeReleaseUser = (
  member: ReleaseMember,
  credentials = releaseUserCredentialsFromEnvironment(),
  file = defaultReleaseUserFile,
  environment: Environment = process.env,
  now = Date.now(),
) => {
  assertCredentialShape(credentials);
  const marker = parsePreviewDisposableEmail(member.email);
  if (marker === null) {
    throw new Error("Release Member must use a disposable Clerk test email");
  }
  assertFreshTimestamp(marker.startedAt, now, "Release Member creation state");
  const release = requiredRelease(environment);
  const existing = readReleaseUser(credentials, file, environment, now);
  if (existing?.validatedAt !== undefined) {
    throw new Error(
      "Release Member state cannot change after cleanup validation",
    );
  }
  if (
    existing !== null &&
    (existing.email !== member.email ||
      existing.runId !== marker.runId ||
      (existing.userId !== undefined &&
        member.userId !== undefined &&
        existing.userId !== member.userId) ||
      (existing.organizationId !== undefined &&
        member.organizationId !== undefined &&
        existing.organizationId !== member.organizationId))
  ) {
    throw new Error("Release Member identity changed during acceptance");
  }
  const record = parseReleaseUser({
    clerkEnvironment: "development",
    clerkInstanceId: previewClerkInstanceId,
    createdAt: existing?.createdAt ?? new Date(now).toISOString(),
    email: member.email,
    release,
    releaseEnvironment: "preview",
    runId: marker.runId,
    runStartedAt: new Date(marker.startedAt).toISOString(),
    version: 2,
    ...(existing?.userId === undefined ? {} : { userId: existing.userId }),
    ...(existing?.organizationId === undefined
      ? {}
      : { organizationId: existing.organizationId }),
    ...(member.userId === undefined ? {} : { userId: member.userId }),
    ...(member.organizationId === undefined
      ? {}
      : { organizationId: member.organizationId }),
  });
  writePrivateJsonAtomically(file, record);
};

export const cleanupReleaseUser = async (
  credentials:
    | ReleaseUserCredentials
    | string = releaseUserCredentialsFromEnvironment(),
  options: CleanupOptions = {},
) => {
  if (typeof credentials === "string") {
    throw new Error(
      "Release Member cleanup requires Clerk instance-bound credentials",
    );
  }
  assertCredentialShape(credentials);
  const file = options.file ?? defaultReleaseUserFile;
  const environment = options.environment ?? process.env;
  const now = options.now ?? Date.now;
  const tracked = readReleaseUser(credentials, file, environment, now());
  if (tracked === null) return;
  const fetcher = options.fetcher ?? fetch;

  await assertClerkInstance(credentials.secretKey, fetcher);
  const matchingMemberIds = await findClerkUsers(
    tracked.email,
    credentials.secretKey,
    fetcher,
  );
  if (tracked.userId === undefined) {
    if (matchingMemberIds.length === 0) {
      removePrivateFile(file);
      return;
    }
    throw new Error("Release Member creation state is incomplete");
  }
  if (tracked.organizationId === undefined) {
    throw new Error("Release Member creation state is incomplete");
  }

  const [member, organization] = await Promise.all([
    readClerkMember(tracked.userId, credentials.secretKey, fetcher),
    readClerkOrganization(
      tracked.organizationId,
      credentials.secretKey,
      fetcher,
    ),
  ]);

  if (tracked.validatedAt === undefined) {
    if (member === null || organization === null) {
      throw new Error("Release Member fixture is already partially deleted");
    }
    const [memberOrganizations, organizationMembers] = await Promise.all([
      listClerkMemberOrganizations(member.id, credentials.secretKey, fetcher),
      listClerkOrganizationMembers(
        organization.id,
        credentials.secretKey,
        fetcher,
      ),
    ]);
    validateLiveFixture(
      tracked,
      member,
      organization,
      matchingMemberIds,
      memberOrganizations,
      organizationMembers,
      now(),
    );
    writeValidatedReleaseUser(tracked, member, organization, file, now());
  } else {
    const [memberOrganizations, organizationMembers] = await Promise.all([
      member === null
        ? null
        : listClerkMemberOrganizations(
            member.id,
            credentials.secretKey,
            fetcher,
          ),
      organization === null
        ? null
        : listClerkOrganizationMembers(
            organization.id,
            credentials.secretKey,
            fetcher,
          ),
    ]);
    validateResumableFixture(
      tracked,
      member,
      organization,
      matchingMemberIds,
      { memberOrganizations, organizationMembers },
      now(),
    );
  }

  if (organization !== null) {
    await deleteClerkResource(
      "organizations",
      tracked.organizationId,
      credentials.secretKey,
      fetcher,
    );
  }
  await verifyClerkResourceMissing(
    "organizations",
    tracked.organizationId,
    credentials.secretKey,
    fetcher,
    options.sleep,
  );
  if (member !== null) {
    await deleteClerkResource(
      "users",
      tracked.userId,
      credentials.secretKey,
      fetcher,
    );
  }
  await verifyClerkResourceMissing(
    "users",
    tracked.userId,
    credentials.secretKey,
    fetcher,
    options.sleep,
  );
  if (
    (await findClerkUsers(tracked.email, credentials.secretKey, fetcher))
      .length !== 0
  ) {
    throw new Error("Disposable Clerk Member deletion could not be verified");
  }
  await verifyHumansProjection(
    {
      ...tracked,
      organizationId: tracked.organizationId,
      userId: tracked.userId,
    },
    options,
    fetcher,
  );
  removePrivateFile(file);
};

const validateLiveFixture = (
  tracked: ReleaseUserRecord,
  member: ClerkMember,
  organization: ClerkOrganization,
  matchingMemberIds: string[],
  memberOrganizations: ClerkInventory,
  organizationMembers: ClerkInventory,
  now: number,
) => {
  validateMember(tracked, member, matchingMemberIds, now);
  if (
    organization.createdBy !== tracked.userId ||
    memberOrganizations.totalCount !== 1 ||
    memberOrganizations.ids[0] !== tracked.organizationId ||
    organizationMembers.totalCount !== 1 ||
    organizationMembers.ids[0] !== tracked.userId
  ) {
    throw new Error(
      "Release Organization ownership or membership validation failed",
    );
  }
  validateResourceTimestamp(tracked, organization.createdAt, now);
  if (
    organization.createdAt + maximumClockSkewMilliseconds <
    member.createdAt
  ) {
    throw new Error("Release Member creation state validation failed");
  }
};

const validateResumableFixture = (
  tracked: ReleaseUserRecord,
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
    throw new Error(
      "Release Member cleanup state does not match deletion order",
    );
  }
  if (member !== null) {
    validateMember(tracked, member, matchingMemberIds, now);
    if (new Date(tracked.memberCreatedAt ?? 0).getTime() !== member.createdAt) {
      throw new Error(
        "Release Member cleanup validation state no longer matches",
      );
    }
  } else if (matchingMemberIds.length !== 0) {
    throw new Error("Release Member email validation failed");
  }
  if (organization !== null) {
    if (
      member === null ||
      inventories.memberOrganizations === null ||
      inventories.organizationMembers === null
    ) {
      throw new Error(
        "Release Member cleanup validation state no longer matches",
      );
    }
    validateLiveFixture(
      tracked,
      member,
      organization,
      matchingMemberIds,
      inventories.memberOrganizations,
      inventories.organizationMembers,
      now,
    );
    if (
      new Date(tracked.organizationCreatedAt ?? 0).getTime() !==
      organization.createdAt
    ) {
      throw new Error(
        "Release Member cleanup validation state no longer matches",
      );
    }
  } else if (
    member !== null &&
    (inventories.memberOrganizations === null ||
      inventories.memberOrganizations.totalCount !== 0)
  ) {
    throw new Error("Release Member has another Organization membership");
  }
};

const validateMember = (
  tracked: ReleaseUserRecord,
  member: ClerkMember,
  matchingMemberIds: string[],
  now: number,
) => {
  if (
    member.email !== tracked.email ||
    matchingMemberIds.length !== 1 ||
    matchingMemberIds[0] !== tracked.userId
  ) {
    throw new Error("Release Member email validation failed");
  }
  validateResourceTimestamp(tracked, member.createdAt, now);
};

const validateResourceTimestamp = (
  tracked: ReleaseUserRecord,
  createdAt: number,
  now: number,
) => {
  const startedAt = new Date(tracked.runStartedAt).getTime();
  if (
    createdAt < startedAt - maximumClockSkewMilliseconds ||
    createdAt > now + maximumClockSkewMilliseconds ||
    now - createdAt > disposableRunLifetimeMilliseconds
  ) {
    throw new Error("Release Member creation state validation failed");
  }
};

const writeValidatedReleaseUser = (
  tracked: ReleaseUserRecord,
  member: ClerkMember,
  organization: ClerkOrganization,
  file: string,
  now: number,
) => {
  const record = parseReleaseUser({
    ...tracked,
    memberCreatedAt: new Date(member.createdAt).toISOString(),
    organizationCreatedAt: new Date(organization.createdAt).toISOString(),
    validatedAt: new Date(now).toISOString(),
  });
  writePrivateJsonAtomically(file, record);
};

const assertRunBinding = (
  record: ReleaseUserRecord,
  environment: Environment,
  now: number,
) => {
  if (record.release !== requiredRelease(environment)) {
    throw new Error(
      "Release Member state belongs to a different acceptance run",
    );
  }
  const marker = parsePreviewDisposableEmail(record.email);
  if (marker === null || marker.runId !== record.runId) {
    throw new Error("Release Member state is invalid");
  }
  assertFreshTimestamp(marker.startedAt, now, "Release Member creation state");
  const createdAt = new Date(record.createdAt).getTime();
  if (
    createdAt < marker.startedAt - maximumClockSkewMilliseconds ||
    createdAt > now + maximumClockSkewMilliseconds
  ) {
    throw new Error("Release Member creation state is invalid");
  }
  if (record.validatedAt !== undefined) {
    const validatedAt = new Date(record.validatedAt).getTime();
    if (
      validatedAt > now + maximumClockSkewMilliseconds ||
      now - validatedAt > cleanupValidationLifetimeMilliseconds
    ) {
      throw new Error("Release Member cleanup validation has expired");
    }
  }
};

const assertCredentialShape = (credentials: ReleaseUserCredentials) => {
  if (!/^pk_test_[A-Za-z0-9_-]+$/.test(credentials.publishableKey)) {
    throw new Error(
      "Preview browser acceptance requires a Clerk test instance",
    );
  }
  if (!/^sk_test_[A-Za-z0-9_-]+$/.test(credentials.secretKey)) {
    throw new Error("Preview cleanup requires a Clerk test instance");
  }
};

type ClerkMember = { createdAt: number; email: string; id: string };
type ClerkOrganization = { createdAt: number; createdBy: string; id: string };
type ClerkInventory = { ids: string[]; totalCount: number };

const assertClerkInstance = async (
  secretKey: string,
  fetcher: typeof fetch,
) => {
  const response = await sanitizedFetch(
    fetcher,
    "https://api.clerk.com/v1/instance",
    { headers: clerkHeaders(secretKey) },
    "Clerk Preview instance verification failed",
  );
  if (!response.ok) {
    await cancelBody(response);
    throw new Error("Clerk Preview instance verification failed");
  }
  const value = await responseJson(
    response,
    "Clerk Preview instance verification failed",
  );
  if (
    !isRecord(value) ||
    value.id !== previewClerkInstanceId ||
    value.environment_type !== "development"
  ) {
    throw new Error("Clerk Preview instance verification failed");
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
  const response = await sanitizedFetch(
    fetcher,
    url,
    { headers: clerkHeaders(secretKey) },
    "Clerk Preview Member lookup failed",
  );
  if (!response.ok) throw new Error("Clerk Preview Member lookup failed");
  const value = await responseJson(
    response,
    "Clerk Preview Member lookup failed",
  );
  if (
    !Array.isArray(value) ||
    value.some((item) => !isClerkResource(item, "user"))
  ) {
    throw new Error("Clerk Preview Member lookup returned an invalid response");
  }
  return value.map(({ id }) => id);
};

const readClerkMember = async (
  memberId: string,
  secretKey: string,
  fetcher: typeof fetch,
): Promise<ClerkMember | null> => {
  const response = await sanitizedFetch(
    fetcher,
    `https://api.clerk.com/v1/users/${encodeURIComponent(memberId)}`,
    { headers: clerkHeaders(secretKey) },
    "Clerk Preview Member lookup failed",
  );
  if (response.status === 404) {
    await cancelBody(response);
    return null;
  }
  if (!response.ok) throw new Error("Clerk Preview Member lookup failed");
  const value = await responseJson(
    response,
    "Clerk Preview Member lookup failed",
  );
  if (
    !isRecord(value) ||
    value.id !== memberId ||
    !Number.isSafeInteger(value.created_at) ||
    !Array.isArray(value.email_addresses) ||
    typeof value.primary_email_address_id !== "string"
  ) {
    throw new Error("Clerk Preview Member lookup returned an invalid response");
  }
  const primary = value.email_addresses.find(
    (item) => isRecord(item) && item.id === value.primary_email_address_id,
  );
  if (!isRecord(primary) || typeof primary.email_address !== "string") {
    throw new Error("Clerk Preview Member lookup returned an invalid response");
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
  const response = await sanitizedFetch(
    fetcher,
    `https://api.clerk.com/v1/organizations/${encodeURIComponent(organizationId)}`,
    { headers: clerkHeaders(secretKey) },
    "Clerk Preview Organization lookup failed",
  );
  if (response.status === 404) {
    await cancelBody(response);
    return null;
  }
  if (!response.ok) throw new Error("Clerk Preview Organization lookup failed");
  const value = await responseJson(
    response,
    "Clerk Preview Organization lookup failed",
  );
  if (
    !isRecord(value) ||
    value.id !== organizationId ||
    !isClerkId(value.created_by, "user") ||
    !Number.isSafeInteger(value.created_at)
  ) {
    throw new Error(
      "Clerk Preview Organization lookup returned an invalid response",
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
    "Clerk Preview Member Organization lookup failed",
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
    "Clerk Preview Organization membership lookup failed",
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
  const response = await sanitizedFetch(
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
  const response = await sanitizedFetch(
    fetcher,
    `https://api.clerk.com/v1/${resource}/${encodeURIComponent(id)}`,
    { method: "DELETE", headers: clerkHeaders(secretKey) },
    `Clerk Preview ${resource} cleanup failed`,
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Clerk Preview ${resource} cleanup failed`);
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
    const response = await sanitizedFetch(
      fetcher,
      `https://api.clerk.com/v1/${resource}/${encodeURIComponent(id)}`,
      { headers: clerkHeaders(secretKey) },
      `Clerk Preview ${resource} verification failed`,
    );
    if (response.status === 404) {
      await cancelBody(response);
      return;
    }
    if (!response.ok) {
      throw new Error(`Clerk Preview ${resource} verification failed`);
    }
    await cancelBody(response);
    await sleep(250);
  }
  throw new Error(`Clerk Preview ${resource} deletion could not be verified`);
};

const verifyHumansProjection = async (
  tracked: ReleaseUserRecord & { organizationId: string; userId: string },
  options: CleanupOptions,
  fetcher: typeof fetch,
) => {
  const target: ProjectionTarget = {
    environment: "preview",
    memberId: tracked.userId,
    organizationId: tracked.organizationId,
    release: tracked.release,
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
  const api = approvedPreviewApiUrl(environment);
  const proxySecret = requiredEnvironment(environment, "HUMANS_PROXY_SECRET");
  if (proxySecret.length < 16) {
    throw new Error("Humans projection verification configuration is invalid");
  }
  const endpoint = new URL("/v1/internal/clerk-projections", api);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await sanitizedFetch(
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

const approvedPreviewApiUrl = (environment: Environment) => {
  const value = requiredEnvironment(environment, "HUMANS_ACCEPTANCE_API_URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Humans projection verification configuration is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "humans-api-preview.hi-541.workers.dev" ||
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

const isInactiveProjection = (value: unknown) =>
  isRecord(value) &&
  (value.member === "inactive" || value.member === "absent") &&
  (value.organization === "inactive" || value.organization === "absent") &&
  (value.membership === "inactive" || value.membership === "absent") &&
  Object.keys(value).every((key) =>
    ["member", "membership", "organization"].includes(key),
  );

const sanitizedFetch = async (
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

const parsePreviewDisposableEmail = (value: unknown) => {
  if (typeof value !== "string" || value !== value.toLowerCase()) return null;
  const match =
    /^humans-release-(\d{13})-([0-9a-f-]{36})\+clerk_test@example\.com$/.exec(
      value,
    );
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    !uuidPattern.test(match[2])
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

const requiredRelease = (environment: Environment) => {
  const release = environment.E2E_RELEASE_SHA?.trim();
  if (!release || !/^[0-9a-f]{40}$/.test(release)) {
    throw new Error("E2E_RELEASE_SHA must be a full Git commit SHA");
  }
  return release;
};

const requiredEnvironment = (environment: Environment, name: string) => {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for browser acceptance`);
  return value;
};

const isClerkResource = (
  value: unknown,
  prefix: "org" | "user",
): value is { id: string } => isRecord(value) && isClerkId(value.id, prefix);

const isOptionalClerkId = (value: unknown, prefix: "org" | "user") =>
  value === undefined || isClerkId(value, prefix);

const isClerkId = (value: unknown, prefix: "org" | "user") =>
  typeof value === "string" &&
  new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`).test(value);

const isIsoTimestamp = (value: unknown) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
