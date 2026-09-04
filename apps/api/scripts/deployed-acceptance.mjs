import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createClerkClient } from "@clerk/backend";
import { isClerkAPIResponseError } from "@clerk/backend/errors";

const creditSpend = 17;
const maximumRateLimitProbes = 75;
const maximumRequests = 180;
const runTimeoutMilliseconds = 10 * 60_000;
const requestTimeoutMilliseconds = 20_000;
const maximumCleanupRequests = 30;
const cleanupTimeoutMilliseconds = 2 * 60_000;
const maximumFixtureCleanupRequests = 4;
const fixtureCleanupTimeoutMilliseconds = 2 * 60_000;
const apiKeyLifetimeSeconds = 15 * 60;
const expectedTools = [
  "get_profile",
  "list_search_facets",
  "reveal_profile_email",
  "reveal_profile_phone",
  "search_profiles",
];

const requiredEnvironment = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const canonicalJson = (value) => {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  return value;
};

const sameJson = (left, right) =>
  JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value, keys) =>
  isRecord(value) && sameJson(Object.keys(value).sort(), [...keys].sort());

const mediaType = (response) =>
  response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase() ?? null;

const hardSafetyBounds = Object.freeze({
  maximumRequests,
  runTimeoutMilliseconds,
  requestTimeoutMilliseconds,
  maximumCleanupRequests,
  cleanupTimeoutMilliseconds,
  maximumFixtureCleanupRequests,
  fixtureCleanupTimeoutMilliseconds,
});

const resolveSafetyBounds = (overrides) => {
  if (overrides === undefined) return { ...hardSafetyBounds };
  if (!isRecord(overrides))
    throw new Error("Acceptance safety bounds are invalid");
  const unknown = Object.keys(overrides).filter(
    (name) => !Object.hasOwn(hardSafetyBounds, name),
  );
  if (unknown.length > 0)
    throw new Error("Acceptance safety bounds are invalid");
  const resolved = { ...hardSafetyBounds };
  for (const [name, hardMaximum] of Object.entries(hardSafetyBounds)) {
    const value = overrides[name];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1 || value > hardMaximum) {
      throw new Error("Acceptance safety bounds may only be lowered");
    }
    resolved[name] = value;
  }
  return resolved;
};

const acceptanceMutationManifest = ({
  environment,
  release,
  expectedWorkerVersionId,
  runId,
  organizationId,
  memberId,
  query,
  profileId,
  emailObservationId,
  phoneObservationId,
  safetyBounds,
}) => {
  const prefix = `release:${release}:${runId}`;
  const keyNamePrefix = `humans-v1-${release.slice(0, 8)}-${runId}`;
  const suspensionReason = `Humans v1 ${environment} acceptance ${runId}`;
  const keyDescription = `Disposable Humans v1 ${environment} acceptance key`;
  return {
    version: 1,
    target: {
      environment,
      release,
      workerVersionId: expectedWorkerVersionId,
      runId,
      organizationId,
      memberId,
    },
    fixture: {
      query,
      profileId,
      observations: {
        professionalEmail: emailObservationId,
        directProfessionalPhone: phoneObservationId,
      },
    },
    safetyBounds: {
      creditSpend,
      maximumRateLimitProbes,
      ...safetyBounds,
    },
    apiKeys: {
      prefix: keyNamePrefix,
      lifetimeSeconds: apiKeyLifetimeSeconds,
      create: [
        {
          kind: "active",
          name: `${keyNamePrefix}-active`,
          description: keyDescription,
          scopes: ["profiles:read", "contacts:reveal"],
          secondsUntilExpiration: apiKeyLifetimeSeconds,
        },
        {
          kind: "no-credit",
          name: `${keyNamePrefix}-no-credit`,
          description: keyDescription,
          scopes: ["profiles:read", "contacts:reveal"],
          secondsUntilExpiration: apiKeyLifetimeSeconds,
        },
        {
          kind: "read-only",
          name: `${keyNamePrefix}-read-only`,
          description: keyDescription,
          scopes: ["profiles:read"],
          secondsUntilExpiration: apiKeyLifetimeSeconds,
        },
        {
          kind: "suspension",
          name: `${keyNamePrefix}-suspension`,
          description: keyDescription,
          scopes: ["profiles:read"],
          secondsUntilExpiration: apiKeyLifetimeSeconds,
        },
        {
          kind: "revocation",
          name: `${keyNamePrefix}-revocation`,
          description: keyDescription,
          scopes: ["profiles:read"],
          secondsUntilExpiration: apiKeyLifetimeSeconds,
        },
      ],
      cleanup: "revoke every run-owned key",
    },
    credits: {
      temporaryAdjustments: [
        {
          amount: -100,
          organizationId,
          idempotencyKey: `${prefix}:adjustment:remove-for-zero-credit`,
          reason: suspensionReason,
        },
        {
          amount: 100,
          organizationId,
          idempotencyKey: `${prefix}:adjustment:restore-after-zero-credit`,
          reason: suspensionReason,
        },
      ],
      searches: [
        {
          idempotencyKey: `${prefix}:search-http-first`,
          request: { filters: { query }, pageSize: 100 },
          firstTransport: "http",
          replayTransport: "mcp",
        },
        {
          idempotencyKey: `${prefix}:search-mcp-first`,
          request: { filters: { query }, pageSize: 100 },
          firstTransport: "mcp",
          replayTransport: "http",
        },
      ],
      searchConflict: {
        idempotencyKey: `${prefix}:search-http-first`,
        query: `${query} conflict`,
        transports: ["http", "mcp"],
      },
      deniedOperations: [
        {
          kind: "forbidden-contact-reveal",
          profileId,
          observationId: emailObservationId,
          idempotencyKey: `${prefix}:forbidden-email`,
          transports: ["http", "mcp"],
        },
        {
          kind: "zero-credit-search",
          query,
          idempotencyKeys: [
            `${prefix}:zero-http-search`,
            `${prefix}:zero-mcp-search`,
          ],
        },
        {
          kind: "zero-credit-contact-reveal",
          profileId,
          observationId: emailObservationId,
          idempotencyKeys: [
            `${prefix}:zero-http-reveal`,
            `${prefix}:zero-mcp-reveal`,
          ],
        },
      ],
      contactReveals: [
        {
          type: "professional-email",
          profileId,
          observationId: emailObservationId,
          idempotencyKey: `${prefix}:email-http-first`,
          firstTransport: "http",
          replayTransport: "mcp",
          reopenIdempotencyKey: `${prefix}:email-mcp-reopen`,
          price: 5,
        },
        {
          type: "direct-professional-phone",
          profileId,
          observationId: phoneObservationId,
          idempotencyKey: `${prefix}:phone-mcp-first`,
          firstTransport: "mcp",
          replayTransport: "http",
          reopenIdempotencyKey: `${prefix}:phone-http-reopen`,
          price: 10,
        },
      ],
      expectedPermanentSpend: creditSpend,
    },
    suspension: {
      principalType: "api_key",
      principalKeyKind: "suspension",
      reason: suspensionReason,
      cleanup: "revoke every matching active suspension",
    },
    rateLimitProbe: {
      principalKeyKind: "no-credit",
      transports: ["http", "mcp"],
      maximumProbes: maximumRateLimitProbes,
    },
    fixtureCleanup: {
      order: ["organization", "member"],
      resources: {
        organization: { id: organizationId, delete: true, verifyAbsent: true },
        member: { id: memberId, delete: true, verifyAbsent: true },
      },
    },
  };
};

export const productionAcceptanceConfirmation = (input) => {
  const safetyBounds = resolveSafetyBounds(input.safetyBounds);
  const manifest = acceptanceMutationManifest({ ...input, safetyBounds });
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalJson(manifest)))
    .digest("hex");
  return `production:${input.release}:${input.organizationId}:${input.runId}:sha256:${digest}`;
};

const validAuthorization = (value) =>
  typeof value === "string" && /^Bearer [^\s]+$/.test(value);

const hasControlCharacter = (value) =>
  Array.from(value).some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code < 32 || code === 127);
  });

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const runDeployedAcceptance = async ({
  apiUrl,
  environment,
  release,
  expectedWorkerVersionId,
  runId,
  organizationId,
  memberId,
  query,
  profileId,
  emailObservationId,
  phoneObservationId,
  getAdminAuthorization,
  getOperatorAuthorization,
  getOrganizationMembershipInventory,
  deleteOrganization,
  deleteMember,
  organizationExists,
  memberExists,
  productionConfirmation,
  safetyBounds: safetyBoundOverrides,
  fetch: fetchImplementation = globalThis.fetch,
}) => {
  const approvedHosts = {
    preview: new Set(["humans-api-preview.hi-541.workers.dev"]),
    production: new Set([
      "humans-api-production.hi-541.workers.dev",
      "api.humans.crafter.run",
    ]),
  };
  if (!Object.hasOwn(approvedHosts, environment)) {
    throw new Error(
      "HUMANS_ACCEPTANCE_ENVIRONMENT must be preview or production",
    );
  }
  const baseUrl = new URL(apiUrl);
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.port ||
    baseUrl.pathname !== "/" ||
    baseUrl.search ||
    baseUrl.hash ||
    !approvedHosts[environment].has(baseUrl.hostname)
  ) {
    throw new Error("HUMANS_ACCEPTANCE_API_URL is not an approved API host");
  }
  if (!/^[0-9a-f]{40}$/.test(release)) {
    throw new Error("HUMANS_ACCEPTANCE_RELEASE must be a Git SHA");
  }
  if (
    typeof expectedWorkerVersionId !== "string" ||
    !uuidPattern.test(expectedWorkerVersionId)
  ) {
    throw new Error("HUMANS_ACCEPTANCE_WORKER_VERSION_ID must be a UUID");
  }
  if (!uuidPattern.test(runId)) {
    throw new Error("HUMANS_ACCEPTANCE_RUN_ID must be a UUID");
  }
  if (!/^org_[A-Za-z0-9_-]+$/.test(organizationId)) {
    throw new Error("HUMANS_ACCEPTANCE_ORGANIZATION_ID is invalid");
  }
  if (!/^user_[A-Za-z0-9_-]+$/.test(memberId)) {
    throw new Error("HUMANS_ACCEPTANCE_MEMBER_ID is invalid");
  }
  if (
    typeof query !== "string" ||
    query.trim() !== query ||
    query.length < 4 ||
    query.length > 500 ||
    hasControlCharacter(query) ||
    typeof profileId !== "string" ||
    profileId.length === 0 ||
    profileId.length > 200 ||
    !/^[0-9a-f-]{36}$/i.test(emailObservationId) ||
    !/^[0-9a-f-]{36}$/i.test(phoneObservationId) ||
    typeof getAdminAuthorization !== "function" ||
    typeof getOperatorAuthorization !== "function" ||
    typeof getOrganizationMembershipInventory !== "function" ||
    typeof deleteOrganization !== "function" ||
    typeof deleteMember !== "function" ||
    typeof organizationExists !== "function" ||
    typeof memberExists !== "function" ||
    typeof fetchImplementation !== "function"
  ) {
    throw new Error("Acceptance fixture input is invalid");
  }
  const safetyBounds = resolveSafetyBounds(safetyBoundOverrides);
  const manifest = acceptanceMutationManifest({
    environment,
    release,
    expectedWorkerVersionId,
    runId,
    organizationId,
    memberId,
    query,
    profileId,
    emailObservationId,
    phoneObservationId,
    safetyBounds,
  });
  const requiredConfirmation = productionAcceptanceConfirmation({
    environment,
    release,
    expectedWorkerVersionId,
    runId,
    organizationId,
    memberId,
    query,
    profileId,
    emailObservationId,
    phoneObservationId,
    safetyBounds,
  });
  if (
    environment === "production" &&
    productionConfirmation !== requiredConfirmation
  ) {
    throw new Error("Production acceptance confirmation is invalid");
  }

  const mainSafety = {
    deadline: Date.now() + safetyBounds.runTimeoutMilliseconds,
    maximumRequests: safetyBounds.maximumRequests,
    requestCount: 0,
  };
  let cleanupSafety = null;
  let fixtureCleanupSafety = null;
  let cleanupPhase = false;
  let rpcId = 0;
  const nextRpcId = () => {
    rpcId += 1;
    return rpcId;
  };
  const keyNamePrefix = manifest.apiKeys.prefix;
  const createdKeyIds = new Set();
  let keyCleanupNeeded = false;
  let zeroCreditAdjustmentPending = false;
  let suspensionApiKeyId = null;
  let suspendedKeyId = null;
  let suspensionCleanupNeeded = false;
  let fixtureCleanupNeeded = false;
  let result;
  let failure;

  const currentSafety = () => cleanupSafety ?? mainSafety;

  const safetyError = () =>
    new Error(
      cleanupPhase
        ? "Deployed acceptance cleanup exceeded its safety bound"
        : "Deployed acceptance exceeded its safety bound",
    );

  const assertRequestAvailable = () => {
    const safety = currentSafety();
    if (
      safety.requestCount >= safety.maximumRequests ||
      Date.now() >= safety.deadline
    ) {
      throw safetyError();
    }
    return safety;
  };

  const withinSafetyDeadline = async (safety, errorFactory, operation) => {
    const remaining = safety.deadline - Date.now();
    if (remaining <= 0) throw errorFactory();
    let timeout;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(errorFactory()), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };

  const withinDeadline = (operation) =>
    withinSafetyDeadline(currentSafety(), safetyError, operation);

  const fixtureCleanupBoundMessage =
    "Deployed acceptance fixture cleanup exceeded its safety bound";
  const fixtureCleanupError = () => new Error(fixtureCleanupBoundMessage);
  const sanitizedFixtureCleanupError = (error, fallbackMessage) =>
    error instanceof Error && error.message === fixtureCleanupBoundMessage
      ? error
      : new Error(fallbackMessage);

  const fixtureCleanupCall = (operation) => {
    if (
      fixtureCleanupSafety === null ||
      fixtureCleanupSafety.requestCount >=
        fixtureCleanupSafety.maximumRequests ||
      Date.now() >= fixtureCleanupSafety.deadline
    ) {
      throw fixtureCleanupError();
    }
    fixtureCleanupSafety.requestCount += 1;
    return withinSafetyDeadline(
      fixtureCleanupSafety,
      fixtureCleanupError,
      operation,
    );
  };

  const request = async (operation, path, init) => {
    const safety = assertRequestAvailable();
    safety.requestCount += 1;
    const timeout = Math.max(
      1,
      Math.min(
        safetyBounds.requestTimeoutMilliseconds,
        safety.deadline - Date.now(),
      ),
    );
    const response = await withinDeadline(() =>
      fetchImplementation(new URL(path, baseUrl), {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      }),
    );
    return { operation, response };
  };

  const sessionRequest = async (
    authorizationSupplier,
    operation,
    path,
    init,
  ) => {
    assertRequestAvailable();
    const authorization = await withinDeadline(authorizationSupplier);
    if (!validAuthorization(authorization)) {
      throw new Error(`${operation} received an invalid session authorization`);
    }
    const headers = new Headers(init?.headers);
    headers.set("authorization", authorization);
    return request(operation, path, { ...init, headers });
  };

  const keyRequest = (key, operation, path, init) => {
    if (typeof key !== "string" || key.length === 0)
      throw new Error(`${operation} received an invalid API key`);
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${key}`);
    return request(operation, path, { ...init, headers });
  };

  const expectStatus = ({ operation, response }, status) => {
    if (response.status !== status) {
      throw new Error(`${operation} returned HTTP ${response.status}`);
    }
    return response;
  };

  const json = async (operation, response) => {
    try {
      return await response.json();
    } catch {
      throw new Error(`${operation} returned invalid JSON`);
    }
  };

  const jsonRequest = async (pending, status) => {
    const { operation, response } = await pending;
    expectStatus({ operation, response }, status);
    return json(operation, response);
  };

  const expectContentType = (response, expected, operation) => {
    if (mediaType(response) !== expected) {
      throw new Error(`${operation} returned an invalid Content-Type`);
    }
  };

  const rateLimitInteger = (value) => {
    if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };

  const assertRateLimitMetadata = (outcome, operation) => {
    const values = [
      outcome.rateLimit?.limit,
      outcome.rateLimit?.remaining,
      outcome.rateLimit?.reset,
    ];
    const allMissing = values.every((value) => value === null);
    const allPresent = values.every((value) => typeof value === "string");
    const limit = rateLimitInteger(outcome.rateLimit?.limit);
    const remaining = rateLimitInteger(outcome.rateLimit?.remaining);
    const reset = rateLimitInteger(outcome.rateLimit?.reset);
    const retryAfter = rateLimitInteger(outcome.retryAfter);
    if (
      !exactKeys(outcome.rateLimit, ["limit", "remaining", "reset"]) ||
      (!allMissing && !allPresent) ||
      (allPresent &&
        (limit === null ||
          limit < 1 ||
          remaining === null ||
          remaining > limit ||
          reset === null ||
          reset < 1)) ||
      (outcome.status !== 429 && outcome.retryAfter !== null)
    ) {
      throw new Error(`${operation} returned invalid rate-limit metadata`);
    }
    if (outcome.status !== 429) return;
    const now = Math.floor(Date.now() / 1000);
    if (
      !allPresent ||
      remaining !== 0 ||
      reset === null ||
      reset < now - 2 ||
      retryAfter === null ||
      retryAfter < 1 ||
      Math.abs(Math.max(1, reset - now) - retryAfter) > 2
    ) {
      throw new Error(`${operation} returned invalid rate-limit metadata`);
    }
  };

  const normalizeHttp = async (pending) => {
    const { operation, response } = await pending;
    const body = await json(operation, response);
    const outcome = {
      ok: response.ok,
      status: response.status,
      body,
      rateLimit: {
        limit: response.headers.get("RateLimit-Limit"),
        remaining: response.headers.get("RateLimit-Remaining"),
        reset: response.headers.get("RateLimit-Reset"),
      },
      retryAfter: response.headers.get("Retry-After"),
    };
    assertRateLimitMetadata(outcome, operation);
    return outcome;
  };

  const mcpRequest = async (key, method, params) => {
    const id = nextRpcId();
    const pending = await keyRequest(key, `MCP ${method}`, "/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      }),
    });
    return { ...pending, rpcId: id };
  };

  const mcpEnvelope = async (pending, status, operation) => {
    const responseWithId = await pending;
    const response = expectStatus(responseWithId, status);
    expectContentType(response, "application/json", operation);
    const envelope = await json(operation, response);
    if (
      !exactKeys(envelope, ["id", "jsonrpc", "result"]) ||
      envelope.jsonrpc !== "2.0" ||
      envelope.id !== responseWithId.rpcId ||
      !isRecord(envelope.result)
    ) {
      throw new Error(`${operation} returned an invalid JSON-RPC envelope`);
    }
    return envelope;
  };

  const normalizeMcpTool = async (key, name, arguments_) => {
    const envelope = await mcpEnvelope(
      mcpRequest(key, "tools/call", { name, arguments: arguments_ }),
      200,
      `MCP ${name}`,
    );
    const toolResult = envelope.result;
    const structured = toolResult.structuredContent;
    if (
      !exactKeys(toolResult, ["content", "isError", "structuredContent"]) ||
      !isRecord(structured) ||
      typeof toolResult.isError !== "boolean" ||
      !Array.isArray(toolResult.content) ||
      toolResult.content.length !== 1 ||
      !exactKeys(toolResult.content[0], ["text", "type"]) ||
      toolResult.content[0].type !== "text" ||
      typeof toolResult.content[0].text !== "string"
    ) {
      throw new Error(`MCP ${name} returned an invalid tool result`);
    }
    let textContent;
    try {
      textContent = JSON.parse(toolResult.content[0].text);
    } catch {
      throw new Error(`MCP ${name} returned invalid text content`);
    }
    if (!sameJson(textContent, structured)) {
      throw new Error(`MCP ${name} returned inconsistent tool content`);
    }
    const { httpStatus, rateLimit, retryAfter, ...body } = structured;
    const status = toolResult.isError ? httpStatus : 200;
    if (
      !Number.isInteger(status) ||
      (toolResult.isError && status < 400) ||
      (!toolResult.isError &&
        (httpStatus !== undefined || retryAfter !== undefined)) ||
      !exactKeys(rateLimit, ["limit", "remaining", "reset"]) ||
      ![rateLimit.limit, rateLimit.remaining, rateLimit.reset].every(
        (value) => value === null || typeof value === "string",
      ) ||
      (toolResult.isError &&
        retryAfter !== null &&
        typeof retryAfter !== "string")
    ) {
      throw new Error(`MCP ${name} returned inconsistent error metadata`);
    }
    const outcome = {
      ok: !toolResult.isError,
      status,
      body,
      rateLimit,
      retryAfter: retryAfter ?? null,
    };
    assertRateLimitMetadata(outcome, `MCP ${name}`);
    return outcome;
  };

  const protectedResponseFields = new Set([
    "contactDetails",
    "maskedValue",
    "observationId",
    "profile",
    "profileId",
    "result",
    "results",
    "reveal",
    "value",
  ]);

  const protectedFieldIn = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const field = protectedFieldIn(item);
        if (field !== null) return field;
      }
      return null;
    }
    if (!isRecord(value)) return null;
    for (const [key, nested] of Object.entries(value)) {
      if (protectedResponseFields.has(key)) return key;
      const field = protectedFieldIn(nested);
      if (field !== null) return field;
    }
    return null;
  };

  const assertDeniedEnvelope = (body, operation) => {
    if (
      protectedFieldIn(body) !== null ||
      !exactKeys(body, ["error"]) ||
      !exactKeys(body.error, ["code", "message"]) ||
      typeof body.error.code !== "string" ||
      body.error.code.length === 0 ||
      typeof body.error.message !== "string" ||
      body.error.message.length === 0
    ) {
      throw new Error(`${operation} exposed data or returned an invalid error`);
    }
  };

  const assertOutcome = (outcome, status, code, operation) => {
    if (
      outcome.status !== status ||
      outcome.ok !== (status >= 200 && status < 300) ||
      (code !== undefined && outcome.body?.error?.code !== code)
    ) {
      throw new Error(`${operation} returned an unexpected outcome`);
    }
    if (status >= 400) assertDeniedEnvelope(outcome.body, operation);
  };

  const assertParity = (http, mcp, operation) => {
    const domainOutcome = ({ ok, status, body }) => ({ ok, status, body });
    if (!sameJson(domainOutcome(http), domainOutcome(mcp))) {
      throw new Error(`${operation} differs between HTTP and MCP`);
    }
  };

  const assertCompleteRateLimitParity = (http, mcp) => {
    const retryDifference = Math.abs(
      Number(http.retryAfter) - Number(mcp.retryAfter),
    );
    if (
      http.status !== 429 ||
      mcp.status !== 429 ||
      !sameJson(http.rateLimit, mcp.rateLimit) ||
      !Number.isFinite(retryDifference) ||
      retryDifference > 2
    ) {
      throw new Error("Rate-limit metadata differs between HTTP and MCP");
    }
  };

  const nonEmptyString = (value) =>
    typeof value === "string" && value.length > 0;
  const nullableString = (value) => value === null || nonEmptyString(value);
  const stringArray = (value) =>
    Array.isArray(value) && value.every(nonEmptyString);
  const opportunityStatus = (value) =>
    value === "open" || value === "not_open" || value === "unspecified";

  const profileCoreKeys = [
    "currentCompany",
    "currentResidence",
    "evidence",
    "experienceYears",
    "freshness",
    "headline",
    "name",
    "opportunityStatus",
    "primaryRole",
    "profileId",
    "seniority",
    "skills",
  ];
  const validProfileCore = (profile, additionalKeys = []) =>
    isRecord(profile) &&
    exactKeys(profile, [...profileCoreKeys, ...additionalKeys]) &&
    nonEmptyString(profile.profileId) &&
    nonEmptyString(profile.name) &&
    nullableString(profile.headline) &&
    nullableString(profile.currentResidence) &&
    nullableString(profile.primaryRole) &&
    stringArray(profile.skills) &&
    nullableString(profile.currentCompany) &&
    nullableString(profile.seniority) &&
    (profile.experienceYears === null ||
      (Number.isFinite(profile.experienceYears) &&
        profile.experienceYears >= 0 &&
        profile.experienceYears <= 100)) &&
    opportunityStatus(profile.opportunityStatus) &&
    nonEmptyString(profile.freshness) &&
    Number.isFinite(Date.parse(profile.freshness)) &&
    (profile.evidence === "member" ||
      profile.evidence === "strong" ||
      profile.evidence === "supported");

  const assertContactPreview = (contact, operation) => {
    if (
      !exactKeys(contact, [
        "collectedAt",
        "confidence",
        "maskedValue",
        "observationId",
        "previouslyPurchased",
        "price",
        "sourceCategory",
        "type",
      ]) ||
      !nonEmptyString(contact.observationId) ||
      (contact.type !== "professional-email" &&
        contact.type !== "direct-professional-phone") ||
      !nonEmptyString(contact.maskedValue) ||
      !nonEmptyString(contact.sourceCategory) ||
      !nonEmptyString(contact.collectedAt) ||
      !Number.isFinite(Date.parse(contact.collectedAt)) ||
      !Number.isFinite(contact.confidence) ||
      contact.confidence < 0 ||
      contact.confidence > 1 ||
      contact.price !== (contact.type === "professional-email" ? 5 : 10) ||
      contact.previouslyPurchased !== false ||
      Object.hasOwn(contact, "value")
    ) {
      throw new Error(`${operation} exposed an unrevealed Contact Detail`);
    }
  };

  const assertProfileEnvelope = (body, operation) => {
    const profile = body?.profile;
    if (
      !exactKeys(body, ["profile"]) ||
      !validProfileCore(profile, ["contactDetails", "links"]) ||
      profile.profileId !== profileId ||
      !stringArray(profile.links) ||
      !Array.isArray(profile.contactDetails)
    ) {
      throw new Error(`${operation} returned an invalid Profile envelope`);
    }
    for (const contact of profile.contactDetails)
      assertContactPreview(contact, operation);
    const selectedEmail = profile.contactDetails.filter(
      (contact) => contact.observationId === emailObservationId,
    );
    const selectedPhone = profile.contactDetails.filter(
      (contact) => contact.observationId === phoneObservationId,
    );
    if (
      selectedEmail.length !== 1 ||
      selectedEmail[0].type !== "professional-email" ||
      selectedPhone.length !== 1 ||
      selectedPhone[0].type !== "direct-professional-phone"
    ) {
      throw new Error(`${operation} is missing the selected Contact Details`);
    }
  };

  const assertSearchEnvelope = (body, operation) => {
    if (
      !exactKeys(body, ["nextCursor", "results"]) ||
      !Array.isArray(body.results) ||
      !body.results.every((profile) => validProfileCore(profile)) ||
      (body.nextCursor !== null && !nonEmptyString(body.nextCursor))
    ) {
      throw new Error(`${operation} returned an invalid search envelope`);
    }
  };

  const facetNames = [
    "companies",
    "currentResidences",
    "opportunityStatuses",
    "roles",
    "seniorities",
    "skills",
  ];
  const assertFacetEnvelope = (body, operation) => {
    if (
      !exactKeys(body, ["facets"]) ||
      !exactKeys(body.facets, facetNames) ||
      !facetNames.every((name) => stringArray(body.facets[name])) ||
      !body.facets.opportunityStatuses.every(opportunityStatus)
    ) {
      throw new Error(`${operation} returned an invalid facet envelope`);
    }
  };

  const assertRevealEnvelope = (
    body,
    type,
    observationId,
    price,
    previouslyPurchased,
  ) => {
    const reveal = body?.reveal;
    const expectedType =
      type === "email" ? "professional-email" : "direct-professional-phone";
    if (
      !exactKeys(body, ["reveal"]) ||
      !exactKeys(reveal, [
        "observationId",
        "previouslyPurchased",
        "price",
        "type",
        "value",
      ]) ||
      reveal.observationId !== observationId ||
      reveal.type !== expectedType ||
      !nonEmptyString(reveal.value) ||
      reveal.price !== price ||
      reveal.previouslyPurchased !== previouslyPurchased
    ) {
      throw new Error(`${type} Contact Reveal result is invalid`);
    }
    return reveal;
  };

  const requiredOpenApiOperations = [
    ["/health", "get", false],
    ["/v1/profiles", "get", false],
    ["/v1/profiles/{profileId}", "get", false],
    ["/v1/search/facets", "get", false],
    ["/v1/search", "post", true],
    ["/v1/profiles/{profileId}/reveal-email", "post", true],
    ["/v1/profiles/{profileId}/reveal-phone", "post", true],
  ];
  const assertOpenApi = (document) => {
    if (
      !isRecord(document) ||
      document.openapi !== "3.1.0" ||
      !isRecord(document.info) ||
      document.info.title !== "Humans API" ||
      document.info.version !== "1.0.0" ||
      !isRecord(document.paths)
    ) {
      throw new Error("OpenAPI returned an invalid document");
    }
    for (const [
      path,
      method,
      requestBodyRequired,
    ] of requiredOpenApiOperations) {
      const operation = document.paths[path]?.[method];
      const success = operation?.responses?.["200"];
      if (
        !isRecord(operation) ||
        !nonEmptyString(operation.operationId) ||
        !isRecord(success?.content?.["application/json"]?.schema) ||
        (requestBodyRequired &&
          !isRecord(
            operation.requestBody?.content?.["application/json"]?.schema,
          ))
      ) {
        throw new Error("OpenAPI is missing a required API operation");
      }
    }
    const apiKey = document.components?.securitySchemes?.OrganizationApiKey;
    if (
      !isRecord(apiKey) ||
      apiKey.type !== "http" ||
      apiKey.scheme !== "bearer"
    ) {
      throw new Error("OpenAPI is missing Organization API key security");
    }
  };

  const assertMcpInitialization = (result) => {
    if (
      !exactKeys(result, ["capabilities", "protocolVersion", "serverInfo"]) ||
      result.protocolVersion !== "2025-06-18" ||
      !exactKeys(result.serverInfo, ["name", "version"]) ||
      result.serverInfo.name !== "Humans" ||
      result.serverInfo.version !== "1.0.0" ||
      !isRecord(result.capabilities) ||
      !isRecord(result.capabilities.tools) ||
      result.capabilities.tools.listChanged !== true
    ) {
      throw new Error("MCP initialization contract is incomplete");
    }
  };

  const requiredToolArguments = {
    get_profile: ["profileId"],
    list_search_facets: [],
    reveal_profile_email: ["idempotencyKey", "profileId"],
    reveal_profile_phone: ["idempotencyKey", "profileId"],
    search_profiles: ["idempotencyKey"],
  };
  const assertMcpTools = (result) => {
    if (!exactKeys(result, ["tools"]) || !Array.isArray(result.tools)) {
      throw new Error("MCP tool contract is incomplete");
    }
    const names = [];
    for (const tool of result.tools) {
      if (
        !isRecord(tool) ||
        !nonEmptyString(tool.name) ||
        !nonEmptyString(tool.title) ||
        !nonEmptyString(tool.description) ||
        !isRecord(tool.inputSchema) ||
        tool.inputSchema.type !== "object" ||
        !isRecord(tool.inputSchema.properties) ||
        !isRecord(tool.annotations) ||
        tool.annotations.openWorldHint !== false ||
        !isRecord(tool.execution) ||
        tool.execution.taskSupport !== "forbidden"
      ) {
        throw new Error("MCP tool contract is incomplete");
      }
      const required = tool.inputSchema.required ?? [];
      const expectedArguments = requiredToolArguments[tool.name];
      if (
        expectedArguments === undefined ||
        !Array.isArray(required) ||
        !expectedArguments.every(
          (argument) =>
            required.includes(argument) &&
            isRecord(tool.inputSchema.properties[argument]),
        ) ||
        (tool.name === "search_profiles" &&
          (!isRecord(tool.inputSchema.properties.query) ||
            !isRecord(tool.inputSchema.properties.filters))) ||
        (tool.name.startsWith("reveal_profile_") &&
          !isRecord(tool.inputSchema.properties.observationId))
      ) {
        throw new Error("MCP tool input contract is incomplete");
      }
      names.push(tool.name);
    }
    if (!sameJson(names.sort(), expectedTools)) {
      throw new Error("MCP tool contract is incomplete");
    }
  };

  const adminJson = (operation, path, init, status) =>
    jsonRequest(
      sessionRequest(getAdminAuthorization, operation, path, init),
      status,
    );
  const operatorJson = (operation, path, init, status) =>
    jsonRequest(
      sessionRequest(getOperatorAuthorization, operation, path, init),
      status,
    );

  const readBilling = async () => {
    const billing = await adminJson(
      "billing balance",
      "/v1/billing",
      undefined,
      200,
    );
    if (!Number.isSafeInteger(billing?.availableCredits)) {
      throw new Error("Billing returned an invalid Credit balance");
    }
    return billing;
  };

  const adjustCredits = (adjustment, suffix) =>
    operatorJson(
      `Credit adjustment ${suffix}`,
      "/v1/operator/credit-adjustments",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(adjustment),
      },
      200,
    );

  const listOrganizationKeys = async () => {
    const listed = await adminJson(
      "API key inventory",
      "/v1/organization/api-keys",
      undefined,
      200,
    );
    if (!Array.isArray(listed?.apiKeys))
      throw new Error("API key inventory is invalid");
    if (
      !listed.apiKeys.every(
        (key) =>
          isRecord(key) &&
          nonEmptyString(key.id) &&
          nonEmptyString(key.name) &&
          typeof key.revoked === "boolean" &&
          typeof key.expired === "boolean",
      )
    ) {
      throw new Error("API key inventory is invalid");
    }
    return listed.apiKeys;
  };

  const listRunKeys = async () =>
    (await listOrganizationKeys()).filter((key) =>
      key.name.startsWith(`${keyNamePrefix}-`),
    );

  const revokeKey = async (id, operation = "API key cleanup") => {
    await adminJson(
      operation,
      `/v1/organization/api-keys/${encodeURIComponent(id)}`,
      { method: "DELETE" },
      200,
    );
    createdKeyIds.delete(id);
  };

  const cleanupRunKeys = async () => {
    const keys = await listRunKeys();
    for (const key of keys) {
      if (key.revoked !== true && key.expired !== true) await revokeKey(key.id);
      else createdKeyIds.delete(key.id);
    }
  };

  const listRunSuspensions = async () => {
    const overview = await operatorJson(
      "acceptance suspension inventory",
      "/v1/operator/overview",
      undefined,
      200,
    );
    const suspensions = overview?.abuse?.suspensions;
    if (!Array.isArray(suspensions)) {
      throw new Error("Suspension inventory is invalid");
    }
    return suspensions.filter(
      (suspension) =>
        isRecord(suspension) &&
        nonEmptyString(suspension.id) &&
        suspension.principalType === manifest.suspension.principalType &&
        suspension.principalId === suspensionApiKeyId &&
        suspension.reason === manifest.suspension.reason,
    );
  };

  const cleanupRunSuspensions = async () => {
    for (const suspension of await listRunSuspensions()) {
      await operatorJson(
        "revoke acceptance suspension during cleanup",
        `/v1/operator/suspensions/${encodeURIComponent(suspension.id)}`,
        { method: "DELETE" },
        200,
      );
      if (suspendedKeyId === suspension.id) suspendedKeyId = null;
    }
  };

  const createKey = async ({ kind, ...keyInput }) => {
    const created = await adminJson(
      `create ${kind} API key`,
      "/v1/organization/api-keys",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(keyInput),
      },
      201,
    );
    const apiKey = created?.apiKey;
    if (
      typeof apiKey?.id !== "string" ||
      !apiKey.id ||
      typeof apiKey?.secret !== "string" ||
      !apiKey.secret
    ) {
      throw new Error(`create ${kind} API key returned an invalid key`);
    }
    createdKeyIds.add(apiKey.id);
    return apiKey;
  };

  const httpSearch = (key, idempotencyKey, searchQuery = query) =>
    normalizeHttp(
      keyRequest(key, "HTTP search", "/v1/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          filters: { query: searchQuery },
          pageSize: 100,
        }),
      }),
    );

  const mcpSearch = (key, idempotencyKey, searchQuery = query) =>
    normalizeMcpTool(key, "search_profiles", {
      filters: { query: searchQuery },
      pageSize: 100,
      idempotencyKey,
    });

  const httpReveal = (key, type, observationId, idempotencyKey) =>
    normalizeHttp(
      keyRequest(
        key,
        `HTTP ${type} Contact Reveal`,
        `/v1/profiles/${encodeURIComponent(profileId)}/reveal-${type}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({ observationId }),
        },
      ),
    );

  const mcpReveal = (key, type, observationId, idempotencyKey) =>
    normalizeMcpTool(key, `reveal_profile_${type}`, {
      profileId,
      observationId,
      idempotencyKey,
    });

  const expectBalance = async (expected, operation) => {
    const billing = await readBilling();
    if (billing.availableCredits !== expected)
      throw new Error(`${operation} produced an unexpected Credit balance`);
    return billing;
  };

  const revealIdentity = (outcome, type, observationId, price, reopened) => {
    if (!outcome.ok || outcome.status !== 200) {
      throw new Error(`${type} Contact Reveal result is invalid`);
    }
    const reveal = assertRevealEnvelope(
      outcome.body,
      type,
      observationId,
      price,
      reopened,
    );
    return {
      observationId: reveal.observationId,
      type: reveal.type,
      value: reveal.value,
    };
  };

  const runChecks = async () => {
    const health = expectStatus(await request("health", "/health"), 200);
    expectContentType(health, "application/json", "health");
    if (
      health.headers.get("x-humans-release") !== release ||
      health.headers.get("x-humans-environment") !== environment
    ) {
      throw new Error("Worker identity does not match the frozen release");
    }
    const healthBody = await json("health", health);
    if (
      !exactKeys(healthBody, ["checks", "status", "worker"]) ||
      healthBody.status !== "ok" ||
      !exactKeys(healthBody.checks, ["database", "pgvector"]) ||
      healthBody.checks.database !== "ok" ||
      healthBody.checks.pgvector !== "ok" ||
      !exactKeys(healthBody.worker, ["versionId"]) ||
      !uuidPattern.test(healthBody.worker.versionId) ||
      healthBody.worker.versionId !== expectedWorkerVersionId
    ) {
      throw new Error("Worker health response is invalid");
    }
    const openApiResponse = expectStatus(
      await request("OpenAPI", "/openapi.json"),
      200,
    );
    expectContentType(openApiResponse, "application/json", "OpenAPI");
    assertOpenApi(await json("OpenAPI", openApiResponse));
    const scalarResponse = expectStatus(
      await request("Scalar docs", "/docs"),
      200,
    );
    expectContentType(scalarResponse, "text/html", "Scalar docs");
    const scalar = await scalarResponse.text();
    if (
      !scalar.includes("<title>Humans API Reference</title>") ||
      !scalar.includes("Scalar.createApiReference") ||
      !scalar.includes('"url": "/openapi.json"')
    ) {
      throw new Error("Scalar docs returned an invalid API reference");
    }

    const unauthenticatedHttp = await normalizeHttp(
      request("unauthenticated HTTP", "/v1/profiles"),
    );
    const unauthenticatedMcp = await normalizeHttp(
      request("unauthenticated MCP", "/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: nextRpcId(),
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: {
              name: "Humans release acceptance",
              version: "1.0.0",
            },
          },
        }),
      }),
    );
    assertOutcome(unauthenticatedHttp, 401, "unauthorized", "HTTP auth");
    assertParity(unauthenticatedHttp, unauthenticatedMcp, "authentication");

    const workspace = await adminJson(
      "Organization workspace",
      `/v1/organizations/${encodeURIComponent(organizationId)}/workspace`,
      undefined,
      200,
    );
    if (
      workspace?.organizationId !== organizationId ||
      workspace?.role !== "org:admin"
    ) {
      throw new Error("The acceptance session is not the fixture admin");
    }
    await operatorJson(
      "Operator authorization",
      "/v1/operator/overview",
      undefined,
      200,
    );

    let membershipInventory;
    try {
      membershipInventory = await withinDeadline(() =>
        getOrganizationMembershipInventory(organizationId),
      );
    } catch {
      throw new Error(
        "Unable to verify the acceptance Organization membership",
      );
    }
    if (
      !exactKeys(membershipInventory, ["memberIds", "totalCount"]) ||
      !Number.isSafeInteger(membershipInventory.totalCount) ||
      membershipInventory.totalCount < 0 ||
      !Array.isArray(membershipInventory.memberIds) ||
      !membershipInventory.memberIds.every(
        (id) => typeof id === "string" && /^user_[A-Za-z0-9_-]+$/.test(id),
      ) ||
      membershipInventory.memberIds.length > membershipInventory.totalCount
    ) {
      throw new Error("The acceptance Organization membership is invalid");
    }
    if (
      membershipInventory.totalCount !== 1 ||
      membershipInventory.memberIds.length !== 1 ||
      membershipInventory.memberIds[0] !== memberId
    ) {
      throw new Error(
        "The acceptance Organization must have exactly the configured Member and no other membership",
      );
    }
    const existingKeys = await listOrganizationKeys();
    if (existingKeys.length !== 0) {
      throw new Error(
        "The acceptance Organization must have no pre-existing API keys",
      );
    }
    const initialBilling = await expectBalance(100, "fixture validation");
    const renewalBoundary = Date.parse(initialBilling.renewalBoundary);
    if (
      initialBilling.plan !== "free" ||
      initialBilling.status !== "active" ||
      initialBilling.chargeable !== true ||
      initialBilling.canManageBilling !== true ||
      !Number.isFinite(renewalBoundary) ||
      renewalBoundary <= mainSafety.deadline
    ) {
      throw new Error(
        "The acceptance Organization is not a fresh Free fixture",
      );
    }

    fixtureCleanupNeeded = true;
    keyCleanupNeeded = true;
    const createdKeys = {};
    for (const key of manifest.apiKeys.create) {
      createdKeys[key.kind] = await createKey(key);
    }
    const activeKey = createdKeys.active;
    const noCreditKey = createdKeys["no-credit"];
    const readOnlyKey = createdKeys["read-only"];
    const suspensionKey = createdKeys.suspension;
    suspensionApiKeyId = suspensionKey.id;
    const revocationKey = createdKeys.revocation;

    const initialization = await mcpEnvelope(
      mcpRequest(activeKey.secret, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "Humans release acceptance",
          version: "1.0.0",
        },
      }),
      200,
      "MCP initialize",
    );
    assertMcpInitialization(initialization.result);
    const tools = await mcpEnvelope(
      mcpRequest(activeKey.secret, "tools/list", {}),
      200,
      "MCP tools/list",
    );
    assertMcpTools(tools.result);

    const httpProfile = await normalizeHttp(
      keyRequest(
        activeKey.secret,
        "HTTP Profile read",
        `/v1/profiles/${encodeURIComponent(profileId)}`,
      ),
    );
    const mcpProfile = await normalizeMcpTool(activeKey.secret, "get_profile", {
      profileId,
    });
    assertOutcome(httpProfile, 200, undefined, "HTTP Profile read");
    assertProfileEnvelope(httpProfile.body, "Profile read");
    assertParity(httpProfile, mcpProfile, "Profile read");

    const httpFacets = await normalizeHttp(
      keyRequest(activeKey.secret, "HTTP facets", "/v1/search/facets"),
    );
    const mcpFacets = await normalizeMcpTool(
      activeKey.secret,
      "list_search_facets",
      {},
    );
    assertOutcome(httpFacets, 200, undefined, "HTTP facets");
    assertFacetEnvelope(httpFacets.body, "search facets");
    assertParity(httpFacets, mcpFacets, "search facets");
    await expectBalance(100, "zero-Credit reads");

    const forbiddenKey = manifest.credits.deniedOperations[0].idempotencyKey;
    const forbiddenHttp = await httpReveal(
      readOnlyKey.secret,
      "email",
      emailObservationId,
      forbiddenKey,
    );
    const forbiddenMcp = await mcpReveal(
      readOnlyKey.secret,
      "email",
      emailObservationId,
      forbiddenKey,
    );
    assertOutcome(forbiddenHttp, 403, "forbidden", "HTTP reveal scope");
    assertParity(forbiddenHttp, forbiddenMcp, "Contact Reveal scope");
    await expectBalance(100, "forbidden Contact Reveals");

    zeroCreditAdjustmentPending = true;
    await adjustCredits(
      manifest.credits.temporaryAdjustments[0],
      "remove-for-zero-credit",
    );
    await expectBalance(0, "zero-Credit setup");
    const insufficientOutcomes = [
      await httpSearch(
        noCreditKey.secret,
        manifest.credits.deniedOperations[1].idempotencyKeys[0],
      ),
      await mcpSearch(
        noCreditKey.secret,
        manifest.credits.deniedOperations[1].idempotencyKeys[1],
      ),
      await httpReveal(
        noCreditKey.secret,
        "email",
        emailObservationId,
        manifest.credits.deniedOperations[2].idempotencyKeys[0],
      ),
      await mcpReveal(
        noCreditKey.secret,
        "email",
        emailObservationId,
        manifest.credits.deniedOperations[2].idempotencyKeys[1],
      ),
    ];
    for (const outcome of insufficientOutcomes) {
      assertOutcome(outcome, 402, "insufficient_credits", "zero-Credit check");
    }
    assertParity(
      insufficientOutcomes[0],
      insufficientOutcomes[1],
      "zero-Credit search",
    );
    assertParity(
      insufficientOutcomes[2],
      insufficientOutcomes[3],
      "zero-Credit Contact Reveal",
    );
    await expectBalance(0, "rejected zero-Credit operations");
    await adjustCredits(
      manifest.credits.temporaryAdjustments[1],
      "restore-after-zero-credit",
    );
    await expectBalance(100, "zero-Credit cleanup");
    zeroCreditAdjustmentPending = false;

    const httpFirstKey = manifest.credits.searches[0].idempotencyKey;
    const httpFirst = await httpSearch(activeKey.secret, httpFirstKey);
    assertOutcome(httpFirst, 200, undefined, "HTTP-first search");
    assertSearchEnvelope(httpFirst.body, "HTTP-first search");
    if (
      !Array.isArray(httpFirst.body?.results) ||
      httpFirst.body.results.length !== 1 ||
      httpFirst.body.results[0]?.profileId !== profileId ||
      httpFirst.body.nextCursor !== null
    ) {
      throw new Error("The acceptance Profile query is not unique");
    }
    await expectBalance(99, "HTTP search");
    const httpFirstReplay = await mcpSearch(activeKey.secret, httpFirstKey);
    assertParity(httpFirst, httpFirstReplay, "HTTP-first search replay");
    await expectBalance(99, "HTTP-first replay");

    const mcpFirstKey = manifest.credits.searches[1].idempotencyKey;
    const mcpFirst = await mcpSearch(activeKey.secret, mcpFirstKey);
    assertOutcome(mcpFirst, 200, undefined, "MCP-first search");
    assertParity(httpFirst, mcpFirst, "charged search result");
    await expectBalance(98, "MCP search");
    const mcpFirstReplay = await httpSearch(activeKey.secret, mcpFirstKey);
    assertParity(mcpFirstReplay, mcpFirst, "MCP-first search replay");
    await expectBalance(98, "MCP-first replay");

    const conflictingQuery = manifest.credits.searchConflict.query;
    const conflictHttp = await httpSearch(
      activeKey.secret,
      httpFirstKey,
      conflictingQuery,
    );
    const conflictMcp = await mcpSearch(
      activeKey.secret,
      httpFirstKey,
      conflictingQuery,
    );
    assertOutcome(
      conflictHttp,
      409,
      "idempotency_conflict",
      "HTTP idempotency conflict",
    );
    assertParity(conflictHttp, conflictMcp, "idempotency conflict");
    await expectBalance(98, "idempotency conflicts");

    const emailMutation = manifest.credits.contactReveals[0];
    const emailHttp = await httpReveal(
      activeKey.secret,
      "email",
      emailObservationId,
      emailMutation.idempotencyKey,
    );
    const emailHttpIdentity = revealIdentity(
      emailHttp,
      "email",
      emailObservationId,
      5,
      false,
    );
    await expectBalance(93, "email Contact Reveal");
    const emailMcpReplay = await mcpReveal(
      activeKey.secret,
      "email",
      emailObservationId,
      emailMutation.idempotencyKey,
    );
    const emailMcpReplayIdentity = revealIdentity(
      emailMcpReplay,
      "email",
      emailObservationId,
      5,
      false,
    );
    assertParity(emailHttp, emailMcpReplay, "email Contact Reveal replay");
    if (!sameJson(emailHttpIdentity, emailMcpReplayIdentity))
      throw new Error("Email Contact Reveal differs between HTTP and MCP");
    await expectBalance(93, "email Contact Reveal replay");
    const emailReopen = await mcpReveal(
      activeKey.secret,
      "email",
      emailObservationId,
      emailMutation.reopenIdempotencyKey,
    );
    const emailReopenIdentity = revealIdentity(
      emailReopen,
      "email",
      emailObservationId,
      0,
      true,
    );
    if (!sameJson(emailHttpIdentity, emailReopenIdentity))
      throw new Error("Email Contact Reveal reopen changed Contact Detail");
    await expectBalance(93, "email Contact Reveal reopen");

    const phoneMutation = manifest.credits.contactReveals[1];
    const phoneMcp = await mcpReveal(
      activeKey.secret,
      "phone",
      phoneObservationId,
      phoneMutation.idempotencyKey,
    );
    const phoneMcpIdentity = revealIdentity(
      phoneMcp,
      "phone",
      phoneObservationId,
      10,
      false,
    );
    await expectBalance(83, "phone Contact Reveal");
    const phoneHttpReplay = await httpReveal(
      activeKey.secret,
      "phone",
      phoneObservationId,
      phoneMutation.idempotencyKey,
    );
    const phoneHttpReplayIdentity = revealIdentity(
      phoneHttpReplay,
      "phone",
      phoneObservationId,
      10,
      false,
    );
    assertParity(phoneHttpReplay, phoneMcp, "phone Contact Reveal replay");
    if (!sameJson(phoneMcpIdentity, phoneHttpReplayIdentity))
      throw new Error("Phone Contact Reveal differs between HTTP and MCP");
    await expectBalance(83, "phone Contact Reveal replay");
    const phoneReopen = await httpReveal(
      activeKey.secret,
      "phone",
      phoneObservationId,
      phoneMutation.reopenIdempotencyKey,
    );
    const phoneReopenIdentity = revealIdentity(
      phoneReopen,
      "phone",
      phoneObservationId,
      0,
      true,
    );
    if (!sameJson(phoneMcpIdentity, phoneReopenIdentity))
      throw new Error("Phone Contact Reveal reopen changed Contact Detail");
    await expectBalance(83, "phone Contact Reveal reopen");

    suspensionCleanupNeeded = true;
    const suspension = await operatorJson(
      "suspend acceptance API key",
      "/v1/operator/suspensions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          principalType: manifest.suspension.principalType,
          principalId: suspensionKey.id,
          reason: manifest.suspension.reason,
        }),
      },
      201,
    );
    if (
      !nonEmptyString(suspension?.suspension?.id) ||
      suspension.suspension.principalType !==
        manifest.suspension.principalType ||
      suspension.suspension.principalId !== suspensionKey.id ||
      suspension.suspension.reason !== manifest.suspension.reason
    )
      throw new Error("Suspension creation returned an invalid identity");
    suspendedKeyId = suspension.suspension.id;
    const suspendedHttp = await normalizeHttp(
      keyRequest(
        suspensionKey.secret,
        "suspended HTTP key",
        "/v1/search/facets",
      ),
    );
    const suspendedMcp = await normalizeMcpTool(
      suspensionKey.secret,
      "list_search_facets",
      {},
    );
    assertOutcome(suspendedHttp, 403, "forbidden", "suspended HTTP key");
    assertParity(suspendedHttp, suspendedMcp, "suspended API key");
    await operatorJson(
      "revoke acceptance suspension",
      `/v1/operator/suspensions/${encodeURIComponent(suspendedKeyId)}`,
      { method: "DELETE" },
      200,
    );
    suspendedKeyId = null;

    await revokeKey(revocationKey.id, "revoke acceptance API key");
    const revokedHttp = await normalizeHttp(
      keyRequest(revocationKey.secret, "revoked HTTP key", "/v1/search/facets"),
    );
    const revokedMcp = await normalizeHttp(
      mcpRequest(revocationKey.secret, "tools/list", {}),
    );
    assertOutcome(revokedHttp, 401, "unauthorized", "revoked HTTP key");
    assertParity(revokedHttp, revokedMcp, "revoked API key");

    let limitedHttp = null;
    let limitedMcp = null;
    let pendingTerminalOutcome = null;
    for (let probe = 0; probe < maximumRateLimitProbes; probe += 1) {
      const transport = probe % 2 === 0 ? "http" : "mcp";
      const outcome =
        transport === "http"
          ? await normalizeHttp(
              keyRequest(
                noCreditKey.secret,
                "HTTP rate-limit probe",
                "/v1/search/facets",
              ),
            )
          : await normalizeMcpTool(
              noCreditKey.secret,
              "list_search_facets",
              {},
            );
      if (outcome.status === 429) {
        assertOutcome(
          outcome,
          429,
          "rate_limited",
          `${transport.toUpperCase()} rate limit`,
        );
        if (
          pendingTerminalOutcome &&
          pendingTerminalOutcome.transport !== transport
        ) {
          if (transport === "http") {
            limitedHttp = outcome;
            limitedMcp = pendingTerminalOutcome.outcome;
          } else {
            limitedHttp = pendingTerminalOutcome.outcome;
            limitedMcp = outcome;
          }
          break;
        }
        pendingTerminalOutcome = { transport, outcome };
      } else {
        assertOutcome(
          outcome,
          200,
          undefined,
          `${transport.toUpperCase()} rate-limit probe`,
        );
        assertFacetEnvelope(
          outcome.body,
          `${transport.toUpperCase()} rate-limit probe`,
        );
        pendingTerminalOutcome = null;
      }
    }
    if (!limitedHttp || !limitedMcp)
      throw new Error("The bounded rate-limit probes did not reach the limit");
    assertCompleteRateLimitParity(limitedHttp, limitedMcp);
    assertParity(limitedHttp, limitedMcp, "rate limiting");
    if (limitedHttp.rateLimit.limit !== "60") {
      throw new Error("Rate-limit metadata is invalid");
    }

    return {
      release,
      workerVersionId: healthBody.worker.versionId,
      profileCount: 1,
      creditsSpent: creditSpend,
    };
  };

  try {
    result = await runChecks();
  } catch (error) {
    failure = error;
  }

  cleanupPhase = true;
  cleanupSafety = {
    deadline: Date.now() + safetyBounds.cleanupTimeoutMilliseconds,
    maximumRequests: safetyBounds.maximumCleanupRequests,
    requestCount: 0,
  };
  const cleanupErrors = [];
  let temporaryCreditsRestored = !zeroCreditAdjustmentPending;
  let runSuspensionsRevoked = !suspensionCleanupNeeded;
  let runApiKeysRevoked = !keyCleanupNeeded && createdKeyIds.size === 0;
  let finalCreditBalanceVerified = result === undefined;
  if (zeroCreditAdjustmentPending) {
    try {
      const current = await readBilling();
      if (current.availableCredits === 0) {
        await adjustCredits(
          manifest.credits.temporaryAdjustments[1],
          "restore-after-zero-credit",
        );
        await expectBalance(100, "zero-Credit failure cleanup");
      } else if (current.availableCredits !== 100) {
        throw new Error("Refusing an ambiguous Credit cleanup");
      }
      zeroCreditAdjustmentPending = false;
      temporaryCreditsRestored = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (suspensionCleanupNeeded) {
    try {
      await cleanupRunSuspensions();
      if ((await listRunSuspensions()).length !== 0) {
        throw new Error("Acceptance suspension cleanup is incomplete");
      }
      suspendedKeyId = null;
      runSuspensionsRevoked = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (keyCleanupNeeded || createdKeyIds.size !== 0) {
    try {
      await cleanupRunKeys();
      const activeRunKeys = (await listRunKeys()).filter(
        (key) => key.revoked !== true && key.expired !== true,
      );
      if (createdKeyIds.size !== 0 || activeRunKeys.length !== 0)
        throw new Error("Acceptance API key cleanup is incomplete");
      runApiKeysRevoked = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (result !== undefined) {
    try {
      await expectBalance(
        100 - creditSpend,
        "final acceptance cleanup verification",
      );
      finalCreditBalanceVerified = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  const apiCleanupVerified =
    cleanupErrors.length === 0 &&
    temporaryCreditsRestored &&
    runSuspensionsRevoked &&
    runApiKeysRevoked &&
    finalCreditBalanceVerified;
  let organizationDeletionSucceeded = !fixtureCleanupNeeded;
  let memberDeletionSucceeded = !fixtureCleanupNeeded;
  let organizationAbsent = !fixtureCleanupNeeded;
  let memberAbsent = !fixtureCleanupNeeded;
  if (fixtureCleanupNeeded && apiCleanupVerified) {
    fixtureCleanupSafety = {
      deadline: Date.now() + safetyBounds.fixtureCleanupTimeoutMilliseconds,
      maximumRequests: safetyBounds.maximumFixtureCleanupRequests,
      requestCount: 0,
    };
    try {
      await fixtureCleanupCall(() => deleteOrganization(organizationId));
      organizationDeletionSucceeded = true;
    } catch (error) {
      cleanupErrors.push(
        sanitizedFixtureCleanupError(
          error,
          "Disposable Organization deletion failed",
        ),
      );
    }
    try {
      await fixtureCleanupCall(() => deleteMember(memberId));
      memberDeletionSucceeded = true;
    } catch (error) {
      cleanupErrors.push(
        sanitizedFixtureCleanupError(
          error,
          "Disposable Member deletion failed",
        ),
      );
    }
    try {
      const exists = await fixtureCleanupCall(() =>
        organizationExists(organizationId),
      );
      if (typeof exists !== "boolean")
        throw new Error("Invalid Organization existence result");
      organizationAbsent = !exists;
      if (!organizationAbsent)
        throw new Error("Disposable Organization still exists");
    } catch (error) {
      cleanupErrors.push(
        sanitizedFixtureCleanupError(
          error,
          "Disposable Organization absence verification failed",
        ),
      );
    }
    try {
      const exists = await fixtureCleanupCall(() => memberExists(memberId));
      if (typeof exists !== "boolean")
        throw new Error("Invalid Member existence result");
      memberAbsent = !exists;
      if (!memberAbsent) throw new Error("Disposable Member still exists");
    } catch (error) {
      cleanupErrors.push(
        sanitizedFixtureCleanupError(
          error,
          "Disposable Member absence verification failed",
        ),
      );
    }
  }
  const fixtureCleanupVerified =
    organizationDeletionSucceeded &&
    memberDeletionSucceeded &&
    organizationAbsent &&
    memberAbsent;

  if (failure || cleanupErrors.length > 0) {
    throw new AggregateError(
      [failure, ...cleanupErrors].filter(Boolean),
      cleanupErrors.length > 0
        ? "Deployed acceptance or cleanup failed"
        : "Deployed acceptance failed",
    );
  }
  const cleanup = {
    verified: apiCleanupVerified && fixtureCleanupVerified,
    apiVerified: apiCleanupVerified,
    fixtureVerified: fixtureCleanupVerified,
    temporaryCreditsRestored,
    runSuspensionsRevoked,
    runApiKeysRevoked,
    finalCreditBalanceVerified,
    organizationAbsent,
    memberAbsent,
    requests: cleanupSafety.requestCount,
    fixtureRequests: fixtureCleanupSafety?.requestCount ?? 0,
  };
  if (!cleanup.verified) {
    throw new Error("Deployed acceptance cleanup was not verified");
  }
  return { ...result, cleanup };
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const environment = requiredEnvironment("HUMANS_ACCEPTANCE_ENVIRONMENT");
  const clerkSecretKey = requiredEnvironment("CLERK_SECRET_KEY");
  if (
    (environment === "preview" && !clerkSecretKey.startsWith("sk_test_")) ||
    (environment === "production" && !clerkSecretKey.startsWith("sk_live_"))
  ) {
    throw new Error(
      "CLERK_SECRET_KEY does not match the acceptance environment",
    );
  }
  const clerk = createClerkClient({ secretKey: clerkSecretKey });
  const organizationId = requiredEnvironment(
    "HUMANS_ACCEPTANCE_ORGANIZATION_ID",
  );
  const memberId = requiredEnvironment("HUMANS_ACCEPTANCE_MEMBER_ID");
  const ignoreMissingClerkResource = async (operation) => {
    try {
      await operation();
    } catch (error) {
      if (!isClerkAPIResponseError(error) || error.status !== 404) throw error;
    }
  };
  const clerkResourceExists = async (operation) => {
    try {
      await operation();
      return true;
    } catch (error) {
      if (isClerkAPIResponseError(error) && error.status === 404) return false;
      throw error;
    }
  };
  const sessionAuthorization = (environmentName) => async () => {
    const token = await clerk.sessions.getToken(
      requiredEnvironment(environmentName),
      undefined,
      60,
    );
    return `Bearer ${token.jwt}`;
  };
  const result = await runDeployedAcceptance({
    apiUrl: requiredEnvironment("HUMANS_ACCEPTANCE_API_URL"),
    environment,
    release: requiredEnvironment("HUMANS_ACCEPTANCE_RELEASE"),
    expectedWorkerVersionId: requiredEnvironment(
      "HUMANS_ACCEPTANCE_WORKER_VERSION_ID",
    ),
    runId: requiredEnvironment("HUMANS_ACCEPTANCE_RUN_ID"),
    organizationId,
    memberId,
    query: requiredEnvironment("HUMANS_ACCEPTANCE_PROFILE_QUERY"),
    profileId: requiredEnvironment("HUMANS_ACCEPTANCE_PROFILE_ID"),
    emailObservationId: requiredEnvironment(
      "HUMANS_ACCEPTANCE_EMAIL_OBSERVATION_ID",
    ),
    phoneObservationId: requiredEnvironment(
      "HUMANS_ACCEPTANCE_PHONE_OBSERVATION_ID",
    ),
    getAdminAuthorization: sessionAuthorization(
      "HUMANS_ACCEPTANCE_ADMIN_SESSION_ID",
    ),
    getOperatorAuthorization: sessionAuthorization(
      "HUMANS_ACCEPTANCE_OPERATOR_SESSION_ID",
    ),
    getOrganizationMembershipInventory: async (targetOrganizationId) => {
      const memberships =
        await clerk.organizations.getOrganizationMembershipList({
          organizationId: targetOrganizationId,
          limit: 2,
          offset: 0,
        });
      if (
        !Number.isSafeInteger(memberships.totalCount) ||
        memberships.totalCount < 0 ||
        !Array.isArray(memberships.data) ||
        memberships.data.length !== Math.min(memberships.totalCount, 2)
      ) {
        throw new Error(
          "Clerk returned an invalid Organization membership inventory",
        );
      }
      const memberIds = memberships.data.map(
        (membership) => membership.publicUserData?.userId,
      );
      if (!memberIds.every((id) => typeof id === "string")) {
        throw new Error(
          "Clerk returned an invalid Organization membership inventory",
        );
      }
      return { memberIds, totalCount: memberships.totalCount };
    },
    deleteOrganization: (targetOrganizationId) =>
      ignoreMissingClerkResource(() =>
        clerk.organizations.deleteOrganization(targetOrganizationId),
      ),
    deleteMember: (targetMemberId) =>
      ignoreMissingClerkResource(() => clerk.users.deleteUser(targetMemberId)),
    organizationExists: (targetOrganizationId) =>
      clerkResourceExists(() =>
        clerk.organizations.getOrganization({
          organizationId: targetOrganizationId,
        }),
      ),
    memberExists: (targetMemberId) =>
      clerkResourceExists(() => clerk.users.getUser(targetMemberId)),
    productionConfirmation:
      process.env.HUMANS_ACCEPTANCE_PRODUCTION_CONFIRMATION?.trim(),
  });
  console.info(
    `Deployed API/MCP acceptance passed for ${result.release} (${result.profileCount} Profile, ${result.creditsSpent} Credits)`,
  );
}
