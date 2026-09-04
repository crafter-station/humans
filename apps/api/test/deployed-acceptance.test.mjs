import { describe, expect, it } from "vitest";

import {
  productionAcceptanceConfirmation,
  runDeployedAcceptance,
} from "../scripts/deployed-acceptance.mjs";

const release = "a".repeat(40);
const runId = "11111111-1111-4111-8111-111111111111";
const organizationId = "org_release";
const memberId = "user_release";
const workerVersionId = "66666666-6666-4666-8666-666666666666";
const otherWorkerVersionId = "77777777-7777-4777-8777-777777777777";
const profileId = "profile_one";
const emailObservationId = "22222222-2222-4222-8222-222222222222";
const phoneObservationId = "33333333-3333-4333-8333-333333333333";
const query = "Unique Release Profile";

const input = (overrides = {}) => {
  let organizationPresent = true;
  let memberPresent = true;
  return {
    apiUrl: "https://humans-api-preview.hi-541.workers.dev",
    environment: "preview",
    release,
    expectedWorkerVersionId: workerVersionId,
    runId,
    organizationId,
    memberId,
    query,
    profileId,
    emailObservationId,
    phoneObservationId,
    getAdminAuthorization: async () => "Bearer admin_session",
    getOperatorAuthorization: async () => "Bearer operator_session",
    getOrganizationMembershipInventory: async () => ({
      memberIds: [memberId],
      totalCount: 1,
    }),
    deleteOrganization: async () => {
      organizationPresent = false;
    },
    deleteMember: async () => {
      memberPresent = false;
    },
    organizationExists: async () => organizationPresent,
    memberExists: async () => memberPresent,
    ...overrides,
  };
};

const json = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers });

const error = (status, code, headers = {}) =>
  json(
    {
      error: {
        code,
        message:
          code === "unauthorized"
            ? "Authentication is required"
            : code === "forbidden"
              ? "Organization access is denied"
              : code === "rate_limited"
                ? "The Organization request limit was exceeded"
                : code === "idempotency_conflict"
                  ? "The idempotency key was already used"
                  : "The Organization has insufficient Credits",
      },
    },
    status,
    headers,
  );

const profileResult = {
  profileId,
  name: "Release Profile",
  headline: "Builds reliable systems",
  currentResidence: "Bogota, Colombia",
  primaryRole: "Platform Engineer",
  skills: ["TypeScript"],
  currentCompany: "Release Company",
  seniority: "senior",
  experienceYears: 8,
  opportunityStatus: "open",
  freshness: "2026-09-01T00:00:00.000Z",
  evidence: "strong",
};

const contactDetails = () => [
  {
    observationId: emailObservationId,
    type: "professional-email",
    maskedValue: "p***@e***.test",
    sourceCategory: "professional-network",
    collectedAt: "2026-09-01T00:00:00.000Z",
    confidence: 0.99,
    price: 5,
    previouslyPurchased: false,
  },
  {
    observationId: phoneObservationId,
    type: "direct-professional-phone",
    maskedValue: "+* *** ****",
    sourceCategory: "professional-network",
    collectedAt: "2026-09-01T00:00:00.000Z",
    confidence: 0.98,
    price: 10,
    previouslyPurchased: false,
  },
];

const facetsBody = {
  facets: {
    roles: ["Platform Engineer"],
    skills: ["TypeScript"],
    currentResidences: ["Bogota, Colombia"],
    companies: ["Release Company"],
    seniorities: ["senior"],
    opportunityStatuses: ["open"],
  },
};

const openApiOperation = (operationId, requestBody = false) => ({
  operationId,
  ...(requestBody
    ? {
        requestBody: {
          content: { "application/json": { schema: { type: "object" } } },
        },
      }
    : {}),
  responses: {
    200: { content: { "application/json": { schema: { type: "object" } } } },
  },
});

const openApiDocument = () => ({
  openapi: "3.1.0",
  info: { title: "Humans API", version: "1.0.0" },
  paths: {
    "/health": { get: openApiOperation("getHealth") },
    "/v1/profiles": { get: openApiOperation("listProfiles") },
    "/v1/profiles/{profileId}": { get: openApiOperation("getProfile") },
    "/v1/search/facets": { get: openApiOperation("listSearchFacets") },
    "/v1/search": { post: openApiOperation("searchProfiles", true) },
    "/v1/profiles/{profileId}/reveal-email": {
      post: openApiOperation("revealProfileEmail", true),
    },
    "/v1/profiles/{profileId}/reveal-phone": {
      post: openApiOperation("revealProfilePhone", true),
    },
  },
  components: {
    securitySchemes: {
      OrganizationApiKey: { type: "http", scheme: "bearer" },
    },
  },
});

const tool = (name, required, properties, annotations) => ({
  name,
  title: name,
  description: `${name} contract`,
  inputSchema: {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  },
  annotations: { ...annotations, openWorldHint: false },
  execution: { taskSupport: "forbidden" },
});

const mcpTools = () => [
  tool(
    "search_profiles",
    ["idempotencyKey"],
    {
      query: { type: "string" },
      filters: { type: "object" },
      idempotencyKey: { type: "string" },
    },
    { readOnlyHint: false },
  ),
  tool(
    "get_profile",
    ["profileId"],
    { profileId: { type: "string" } },
    { readOnlyHint: true },
  ),
  tool("list_search_facets", [], {}, { readOnlyHint: true }),
  tool(
    "reveal_profile_email",
    ["profileId", "idempotencyKey"],
    {
      profileId: { type: "string" },
      observationId: { type: "string" },
      idempotencyKey: { type: "string" },
    },
    { readOnlyHint: false, destructiveHint: true },
  ),
  tool(
    "reveal_profile_phone",
    ["profileId", "idempotencyKey"],
    {
      profileId: { type: "string" },
      observationId: { type: "string" },
      idempotencyKey: { type: "string" },
    },
    { readOnlyHint: false, destructiveHint: true },
  ),
];

const scalarDocument = `<!doctype html><html><head><title>Humans API Reference</title></head><body><script>Scalar.createApiReference('#app', { "url": "/openapi.json" })</script></body></html>`;

const makeAcceptanceServer = (options = {}) => {
  let balance = 100;
  let keySequence = 0;
  let suspensionSequence = 0;
  let noCreditFacetRequests = 0;
  const searches = new Map();
  const purchased = new Set();
  const revealResponses = new Map();
  const keys = new Map();
  const suspensions = new Map();
  const requests = [];
  const rateLimitReset = String(Math.floor(Date.now() / 1000) + 60);
  const rateHeaders = {
    "RateLimit-Limit": "60",
    "RateLimit-Remaining": "42",
    "RateLimit-Reset": rateLimitReset,
  };
  if (options.preexistingApiKey) {
    keySequence += 1;
    keys.set("api_key_preexisting", {
      id: "api_key_preexisting",
      secret: "preexisting_secret",
      name: "pre-existing",
      scopes: ["profiles:read"],
      revoked: false,
      expired: false,
    });
  }

  const apiKey = (authorization) => {
    const secret = authorization?.replace(/^Bearer /, "");
    return [...keys.values()].find((key) => key.secret === secret) ?? null;
  };

  const domain = (status, body, headers = rateHeaders) => ({
    status,
    body,
    headers,
  });

  const authenticate = (key) => {
    if (!key || key.revoked) return domain(401, errorBody("unauthorized"), {});
    if (
      [...suspensions.values()].some(
        (suspension) =>
          suspension.principalId === key.id && !suspension.revoked,
      )
    )
      return domain(403, errorBody("forbidden"));
    return null;
  };

  const errorBody = (code) => ({
    error: {
      code,
      message:
        code === "unauthorized"
          ? "Authentication is required"
          : code === "forbidden"
            ? "Organization access is denied"
            : code === "rate_limited"
              ? "The Organization request limit was exceeded"
              : code === "idempotency_conflict"
                ? "The idempotency key was already used"
                : "The Organization has insufficient Credits",
    },
  });

  const search = (key, idempotencyKey, searchQuery) => {
    const denied = authenticate(key);
    if (denied) return denied;
    if (!key.scopes.includes("profiles:read"))
      return domain(403, errorBody("forbidden"));
    if (balance < 1) return domain(402, errorBody("insufficient_credits"));
    const existing = searches.get(idempotencyKey);
    if (existing && existing.query !== searchQuery)
      return domain(409, errorBody("idempotency_conflict"));
    if (existing) return domain(200, existing.page);
    const page = options.searchPage ?? {
      results: [{ ...profileResult }],
      nextCursor: null,
    };
    searches.set(idempotencyKey, { query: searchQuery, page });
    balance -= 1;
    return domain(200, page);
  };

  const reveal = (key, type, observationId, idempotencyKey) => {
    const denied = authenticate(key);
    if (denied) return denied;
    if (
      !key.scopes.includes("profiles:read") ||
      !key.scopes.includes("contacts:reveal")
    )
      return domain(403, errorBody("forbidden"));
    const price = type === "email" ? 5 : 10;
    if (!purchased.has(type) && balance < price)
      return domain(402, errorBody("insufficient_credits"));
    const existing = revealResponses.get(idempotencyKey);
    if (existing) {
      if (existing.type !== type || existing.observationId !== observationId)
        return domain(409, errorBody("idempotency_conflict"));
      return domain(200, existing.body);
    }
    const previouslyPurchased = purchased.has(type);
    if (!previouslyPurchased) {
      purchased.add(type);
      balance -= price;
    }
    const body = options.revealBody ?? {
      reveal: {
        observationId,
        type:
          type === "email" ? "professional-email" : "direct-professional-phone",
        value: type === "email" ? "private@example.test" : "+1 555 0100",
        price: previouslyPurchased ? 0 : price,
        previouslyPurchased,
      },
    };
    revealResponses.set(idempotencyKey, { type, observationId, body });
    return domain(200, body);
  };

  const facets = (key) => {
    const denied = authenticate(key);
    if (denied) return denied;
    if (key.name.endsWith("-no-credit")) {
      noCreditFacetRequests += 1;
      if (noCreditFacetRequests >= 3)
        return domain(429, errorBody("rate_limited"), {
          "RateLimit-Limit": "60",
          "RateLimit-Remaining": "0",
          "RateLimit-Reset": rateLimitReset,
          "Retry-After": String(
            Math.max(1, Number(rateLimitReset) - Math.floor(Date.now() / 1000)),
          ),
        });
    }
    return domain(200, options.facetsBody ?? facetsBody);
  };

  const mcp = (key, body) => {
    if (!key || key.revoked) return error(401, "unauthorized");
    if (body.method === "initialize")
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: options.mcpInitialization ?? {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "Humans", version: "1.0.0" },
        },
      });
    if (body.method === "tools/list")
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: options.mcpTools ?? mcpTools() },
      });
    const { name, arguments: arguments_ } = body.params;
    let outcome;
    if (name === "get_profile")
      outcome = domain(
        200,
        options.mcpProfileBody ??
          options.profileBody ?? {
            profile: {
              ...profileResult,
              links: ["https://github.com/release-profile"],
              contactDetails: contactDetails().map((contact) =>
                options.leakUnrevealedValue
                  ? { ...contact, value: "leaked-contact-detail" }
                  : contact,
              ),
            },
          },
      );
    else if (name === "list_search_facets") outcome = facets(key);
    else if (name === "search_profiles")
      outcome = search(
        key,
        arguments_.idempotencyKey,
        arguments_.filters.query,
      );
    else
      outcome = reveal(
        key,
        name.endsWith("email") ? "email" : "phone",
        arguments_.observationId,
        arguments_.idempotencyKey,
      );
    const rateLimit = {
      limit: outcome.headers["RateLimit-Limit"] ?? null,
      remaining:
        outcome.status < 400 && options.mcpSuccessRateLimitRemaining
          ? options.mcpSuccessRateLimitRemaining
          : (outcome.headers["RateLimit-Remaining"] ?? null),
      reset:
        outcome.status === 429 && options.mcpRateLimitResetOffset
          ? String(
              Number(outcome.headers["RateLimit-Reset"]) +
                options.mcpRateLimitResetOffset,
            )
          : (outcome.headers["RateLimit-Reset"] ?? null),
    };
    const structuredContent =
      outcome.status >= 400
        ? {
            ...outcome.body,
            httpStatus: outcome.status,
            retryAfter:
              outcome.status === 429 && options.mcpRateLimitRetryAfter
                ? options.mcpRateLimitRetryAfter
                : (outcome.headers["Retry-After"] ?? null),
            rateLimit,
          }
        : { ...outcome.body, rateLimit };
    const text = JSON.stringify(structuredContent);
    const envelope = {
      jsonrpc: "2.0",
      id: body.id,
      result: {
        content: [{ type: "text", text }],
        isError: outcome.status >= 400,
        structuredContent,
      },
    };
    return json(
      options.transformMcpToolEnvelope
        ? options.transformMcpToolEnvelope(envelope, name)
        : envelope,
    );
  };

  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const authorization = headers.get("authorization");
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    requests.push({
      path: url.pathname,
      method,
      hasQuery: url.search.length > 0,
      idempotencyKey: headers.get("idempotency-key"),
      mcpMethod: body?.method ?? null,
      toolName: body?.params?.name ?? null,
      toolIdempotencyKey: body?.params?.arguments?.idempotencyKey ?? null,
    });

    if (url.pathname === "/health")
      return json(
        options.healthBody ?? {
          checks: { database: "ok", pgvector: "ok" },
          status: "ok",
          worker: { versionId: workerVersionId },
        },
        200,
        {
          "X-Humans-Release": release,
          "X-Humans-Environment": "preview",
        },
      );
    if (url.pathname === "/openapi.json")
      return options.openApiResponse ?? json(openApiDocument());
    if (url.pathname === "/docs")
      return (
        options.scalarResponse ??
        new Response(scalarDocument, {
          headers: { "content-type": "text/html; charset=UTF-8" },
        })
      );
    if (!authorization)
      return options.unauthenticatedBody
        ? json(options.unauthenticatedBody, 401)
        : error(401, "unauthorized");

    if (url.pathname === "/mcp") return mcp(apiKey(authorization), body);

    if (authorization === "Bearer admin_session") {
      if (url.pathname.endsWith("/workspace"))
        return json({ organizationId, role: "org:admin" });
      if (url.pathname === "/v1/billing")
        return json({
          plan: "free",
          status: "active",
          chargeable: true,
          availableCredits: balance,
          renewalBoundary: new Date(Date.now() + 60 * 60_000).toISOString(),
          canManageBilling: true,
        });
      if (url.pathname === "/v1/organization/api-keys" && method === "GET")
        return json({
          apiKeys: [...keys.values()].map(({ secret: _, ...key }) => key),
        });
      if (url.pathname === "/v1/organization/api-keys" && method === "POST") {
        keySequence += 1;
        const key = {
          id: `api_key_${keySequence}`,
          secret: `secret_${keySequence}`,
          name: body.name,
          scopes: body.scopes,
          revoked: false,
          expired: false,
        };
        keys.set(key.id, key);
        return json({ apiKey: key }, 201);
      }
      if (
        url.pathname.startsWith("/v1/organization/api-keys/") &&
        method === "DELETE"
      ) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1));
        const key = keys.get(id);
        if (!key) return error(404, "not_found");
        if (
          !options.ignoreCleanupKeyRevocations ||
          key.name.endsWith("-revocation")
        ) {
          key.revoked = true;
        }
        return json({ apiKey: key });
      }
    }

    if (authorization === "Bearer operator_session") {
      if (url.pathname === "/v1/operator/overview")
        return json({
          abuse: {
            suspensions: [...suspensions.values()].filter(
              (suspension) => !suspension.revoked,
            ),
          },
        });
      if (url.pathname === "/v1/operator/credit-adjustments") {
        balance += body.amount;
        return json({ applied: true });
      }
      if (url.pathname === "/v1/operator/suspensions" && method === "POST") {
        suspensionSequence += 1;
        const suspension = {
          id: `suspension_${suspensionSequence}`,
          principalType: body.principalType,
          principalId: body.principalId,
          reason: body.reason,
          revoked: false,
        };
        suspensions.set(suspension.id, suspension);
        return json({ suspension }, 201);
      }
      if (
        url.pathname.startsWith("/v1/operator/suspensions/") &&
        method === "DELETE"
      ) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1));
        const suspension = suspensions.get(id);
        if (!suspension) return error(404, "not_found");
        suspension.revoked = true;
        return json({ suspension });
      }
    }

    const key = apiKey(authorization);
    const denied = authenticate(key);
    if (denied) return json(denied.body, denied.status, denied.headers);
    let outcome;
    if (url.pathname === `/v1/profiles/${profileId}`)
      outcome = domain(
        200,
        options.profileBody ?? {
          profile: {
            ...profileResult,
            links: ["https://github.com/release-profile"],
            contactDetails: contactDetails().map((contact) =>
              options.leakUnrevealedValue
                ? { ...contact, value: "leaked-contact-detail" }
                : contact,
            ),
          },
        },
      );
    else if (url.pathname === "/v1/search/facets") outcome = facets(key);
    else if (url.pathname === "/v1/search")
      outcome = search(key, headers.get("idempotency-key"), body.filters.query);
    else if (url.pathname.endsWith("/reveal-email"))
      outcome = reveal(
        key,
        "email",
        body.observationId,
        headers.get("idempotency-key"),
      );
    else if (url.pathname.endsWith("/reveal-phone"))
      outcome = reveal(
        key,
        "phone",
        body.observationId,
        headers.get("idempotency-key"),
      );
    else
      throw new Error(
        `Unexpected acceptance request: ${method} ${url.pathname}`,
      );
    return json(outcome.body, outcome.status, outcome.headers);
  };

  return {
    fetch,
    requests,
    state: () => ({
      balance,
      keys: [...keys.values()],
      suspensions: [...suspensions.values()],
    }),
  };
};

const mutatingRequests = (requests) =>
  requests.filter(
    ({ method, path }) =>
      (path === "/v1/organization/api-keys" && method === "POST") ||
      path.startsWith("/v1/organization/api-keys/") ||
      path === "/v1/operator/credit-adjustments" ||
      path === "/v1/operator/suspensions" ||
      path.startsWith("/v1/operator/suspensions/"),
  );

const productionManifestInput = (overrides = {}) => ({
  environment: "production",
  release,
  expectedWorkerVersionId: workerVersionId,
  runId,
  organizationId,
  memberId,
  query,
  profileId,
  emailObservationId,
  phoneObservationId,
  ...overrides,
});

const rejectionMessages = (error_) => [
  error_ instanceof Error ? error_.message : String(error_),
  ...(error_ instanceof AggregateError
    ? error_.errors.flatMap(rejectionMessages)
    : []),
];

const expectRejectionContaining = async (pending, expected) => {
  let rejection;
  try {
    await pending;
  } catch (error_) {
    rejection = error_;
  }
  expect(rejection).toBeDefined();
  expect(
    rejectionMessages(rejection).some((message) => message.includes(expected)),
  ).toBe(true);
  return rejection;
};

describe("deployed API acceptance", () => {
  it("proves matching Worker identity and HTTP/MCP acceptance", async () => {
    const server = makeAcceptanceServer();

    const result = await runDeployedAcceptance(input({ fetch: server.fetch }));
    expect(result).toEqual({
      release,
      workerVersionId,
      profileCount: 1,
      creditsSpent: 17,
      cleanup: {
        verified: true,
        apiVerified: true,
        fixtureVerified: true,
        temporaryCreditsRestored: true,
        runSuspensionsRevoked: true,
        runApiKeysRevoked: true,
        finalCreditBalanceVerified: true,
        organizationAbsent: true,
        memberAbsent: true,
        requests: expect.any(Number),
        fixtureRequests: 4,
      },
    });

    const state = server.state();
    expect(state.balance).toBe(83);
    expect(state.keys).toHaveLength(5);
    expect(state.keys.every((key) => key.revoked)).toBe(true);
    expect(state.suspensions).toEqual([
      expect.objectContaining({ revoked: true, principalType: "api_key" }),
    ]);
    expect(server.requests.length).toBeLessThanOrEqual(180);
    expect(
      server.requests.find((request) => request.path === "/v1/profiles"),
    ).toMatchObject({ hasQuery: false });

    const emailHttp = server.requests.find(
      (request) =>
        request.path.endsWith("/reveal-email") &&
        request.idempotencyKey?.endsWith(":email-http-first"),
    );
    const emailMcp = server.requests.find(
      (request) =>
        request.toolName === "reveal_profile_email" &&
        request.toolIdempotencyKey?.endsWith(":email-http-first"),
    );
    const phoneMcp = server.requests.find(
      (request) =>
        request.toolName === "reveal_profile_phone" &&
        request.toolIdempotencyKey?.endsWith(":phone-mcp-first"),
    );
    const phoneHttp = server.requests.find(
      (request) =>
        request.path.endsWith("/reveal-phone") &&
        request.idempotencyKey?.endsWith(":phone-mcp-first"),
    );
    expect(emailHttp).toBeDefined();
    expect(emailMcp).toBeDefined();
    expect(phoneMcp).toBeDefined();
    expect(phoneHttp).toBeDefined();
    expect(emailHttp?.idempotencyKey).toBe(emailMcp?.toolIdempotencyKey);
    expect(phoneMcp?.toolIdempotencyKey).toBe(phoneHttp?.idempotencyKey);
  });

  it("restores temporary Credits and revokes keys after a partial failure", async () => {
    const server = makeAcceptanceServer();
    let interrupted = false;

    await expect(
      runDeployedAcceptance(
        input({
          fetch: async (request, init) => {
            const body =
              typeof init?.body === "string" ? JSON.parse(init.body) : null;
            if (
              !interrupted &&
              body?.params?.arguments?.idempotencyKey?.endsWith(
                ":zero-mcp-search",
              )
            ) {
              interrupted = true;
              throw new Error("simulated connection loss");
            }
            return server.fetch(request, init);
          },
        }),
      ),
    ).rejects.toThrow("Deployed acceptance failed");

    const state = server.state();
    expect(state.balance).toBe(100);
    expect(state.keys).toHaveLength(5);
    expect(state.keys.every((key) => key.revoked)).toBe(true);
  });

  it("withholds success when final key cleanup cannot be verified", async () => {
    const server = makeAcceptanceServer({ ignoreCleanupKeyRevocations: true });
    let fixtureDeletionCalled = false;

    await expectRejectionContaining(
      runDeployedAcceptance(
        input({
          fetch: server.fetch,
          deleteOrganization: async () => {
            fixtureDeletionCalled = true;
          },
          deleteMember: async () => {
            fixtureDeletionCalled = true;
          },
        }),
      ),
      "API key cleanup is incomplete",
    );
    expect(
      server
        .state()
        .keys.some((key) => !key.revoked && !key.name.endsWith("-revocation")),
    ).toBe(true);
    expect(fixtureDeletionCalled).toBe(false);
  });

  it("blocks success when fixture deletion fails after API cleanup", async () => {
    const server = makeAcceptanceServer();
    let memberPresent = true;
    const fixtureOperations = [];
    const apiCleanupObservations = [];
    const observeApiCleanup = () => {
      const state = server.state();
      apiCleanupObservations.push(
        state.balance === 83 &&
          state.keys.every((key) => key.revoked) &&
          state.suspensions.every((suspension) => suspension.revoked),
      );
    };

    const rejection = await expectRejectionContaining(
      runDeployedAcceptance(
        input({
          fetch: server.fetch,
          deleteOrganization: async () => {
            observeApiCleanup();
            fixtureOperations.push("delete Organization");
            throw new Error("raw Clerk failure with private fixture data");
          },
          deleteMember: async () => {
            observeApiCleanup();
            fixtureOperations.push("delete Member");
            memberPresent = false;
          },
          organizationExists: async () => {
            observeApiCleanup();
            fixtureOperations.push("verify Organization");
            return true;
          },
          memberExists: async () => {
            observeApiCleanup();
            fixtureOperations.push("verify Member");
            return memberPresent;
          },
        }),
      ),
      "Disposable Organization deletion failed",
    );

    expect(fixtureOperations).toEqual([
      "delete Organization",
      "delete Member",
      "verify Organization",
      "verify Member",
    ]);
    expect(apiCleanupObservations).toEqual([true, true, true, true]);
    expect(server.state().balance).toBe(83);
    expect(server.state().keys.every((key) => key.revoked)).toBe(true);
    expect(
      rejectionMessages(rejection).some((message) =>
        message.includes("private fixture data"),
      ),
    ).toBe(false);
  });

  it("bounds fixture cleanup independently of API cleanup", async () => {
    const server = makeAcceptanceServer();
    let fixtureCalls = 0;
    const fixtureCallback = async () => {
      fixtureCalls += 1;
      return false;
    };

    await expectRejectionContaining(
      runDeployedAcceptance(
        input({
          fetch: server.fetch,
          safetyBounds: { maximumFixtureCleanupRequests: 3 },
          deleteOrganization: fixtureCallback,
          deleteMember: fixtureCallback,
          organizationExists: fixtureCallback,
          memberExists: fixtureCallback,
        }),
      ),
      "fixture cleanup exceeded its safety bound",
    );

    expect(fixtureCalls).toBe(3);
    expect(server.state().balance).toBe(83);
    expect(server.state().keys.every((key) => key.revoked)).toBe(true);
  });

  it("uses an independent cleanup budget after exhausting the main request bound", async () => {
    const server = makeAcceptanceServer();

    await expect(
      runDeployedAcceptance(
        input({
          fetch: server.fetch,
          safetyBounds: { maximumRequests: 25 },
        }),
      ),
    ).rejects.toThrow("Deployed acceptance failed");

    const state = server.state();
    expect(state.balance).toBe(100);
    expect(state.keys).toHaveLength(5);
    expect(state.keys.every((key) => key.revoked)).toBe(true);
    expect(server.requests.length).toBeGreaterThan(25);
  });

  it("fails within the cleanup request bound when restoration cannot finish", async () => {
    const server = makeAcceptanceServer();

    await expect(
      runDeployedAcceptance(
        input({
          fetch: server.fetch,
          safetyBounds: {
            maximumRequests: 25,
            maximumCleanupRequests: 1,
          },
        }),
      ),
    ).rejects.toThrow("Deployed acceptance or cleanup failed");

    expect(server.requests).toHaveLength(26);
    expect(server.state().balance).toBe(0);
  });

  it("rediscovers and revokes a suspension after its creation response is lost", async () => {
    const server = makeAcceptanceServer();
    let responseLost = false;

    await expect(
      runDeployedAcceptance(
        input({
          fetch: async (request, init) => {
            const url = new URL(request);
            if (
              !responseLost &&
              url.pathname === "/v1/operator/suspensions" &&
              init?.method === "POST"
            ) {
              responseLost = true;
              await server.fetch(request, init);
              throw new Error("simulated lost suspension response");
            }
            return server.fetch(request, init);
          },
        }),
      ),
    ).rejects.toThrow("Deployed acceptance failed");

    const state = server.state();
    expect(state.suspensions).toEqual([
      expect.objectContaining({ revoked: true, principalType: "api_key" }),
    ]);
    expect(state.keys.every((key) => key.revoked)).toBe(true);
  });

  it.each([
    [
      "another membership",
      { memberIds: [memberId, "user_other"], totalCount: 2 },
    ],
    ["a different Member", { memberIds: ["user_other"], totalCount: 1 }],
  ])("refuses a fixture with %s before mutation", async (_, inventory) => {
    const server = makeAcceptanceServer();
    let fixtureDeletionCalled = false;

    await expectRejectionContaining(
      runDeployedAcceptance(
        input({
          fetch: server.fetch,
          getOrganizationMembershipInventory: async () => inventory,
          deleteOrganization: async () => {
            fixtureDeletionCalled = true;
          },
          deleteMember: async () => {
            fixtureDeletionCalled = true;
          },
        }),
      ),
      "exactly the configured Member",
    );
    expect(mutatingRequests(server.requests)).toEqual([]);
    expect(fixtureDeletionCalled).toBe(false);
  });

  it("refuses a fixture with a pre-existing API key before mutation", async () => {
    const server = makeAcceptanceServer({ preexistingApiKey: true });

    await expectRejectionContaining(
      runDeployedAcceptance(input({ fetch: server.fetch })),
      "no pre-existing API keys",
    );
    expect(mutatingRequests(server.requests)).toEqual([]);
    expect(server.state().keys).toEqual([
      expect.objectContaining({ name: "pre-existing", revoked: false }),
    ]);
  });

  it("rejects protected fields added to a denied response", async () => {
    const server = makeAcceptanceServer({
      unauthenticatedBody: {
        error: { code: "unauthorized", message: "Authentication is required" },
        results: [{ ...profileResult }],
      },
    });

    await expectRejectionContaining(
      runDeployedAcceptance(input({ fetch: server.fetch })),
      "exposed data",
    );
    expect(mutatingRequests(server.requests)).toEqual([]);
  });

  it("rejects an unpurchased Profile response containing a Contact Detail", async () => {
    const server = makeAcceptanceServer({ leakUnrevealedValue: true });

    await expectRejectionContaining(
      runDeployedAcceptance(input({ fetch: server.fetch })),
      "unrevealed Contact Detail",
    );
    expect(server.state().keys.every((key) => key.revoked)).toBe(true);
  });

  it.each([
    ["Profile", { profileBody: {} }, "invalid Profile envelope"],
    ["facet", { facetsBody: {} }, "invalid facet envelope"],
    ["search", { searchPage: {} }, "invalid search envelope"],
    ["Contact Reveal", { revealBody: {} }, "Contact Reveal result is invalid"],
  ])("rejects an empty successful %s envelope", async (_, options, message) => {
    const server = makeAcceptanceServer(options);

    await expectRejectionContaining(
      runDeployedAcceptance(input({ fetch: server.fetch })),
      message,
    );
    expect(server.state().keys.every((key) => key.revoked)).toBe(true);
  });

  it.each([
    [
      "OpenAPI document",
      { openApiResponse: json({}) },
      "OpenAPI returned an invalid document",
    ],
    [
      "OpenAPI Content-Type",
      {
        openApiResponse: new Response(JSON.stringify(openApiDocument()), {
          headers: { "content-type": "text/plain" },
        }),
      },
      "OpenAPI returned an invalid Content-Type",
    ],
    [
      "Scalar marker",
      {
        scalarResponse: new Response("not scalar", {
          headers: { "content-type": "text/html" },
        }),
      },
      "invalid API reference",
    ],
    [
      "Scalar Content-Type",
      {
        scalarResponse: new Response(scalarDocument, {
          headers: { "content-type": "text/plain" },
        }),
      },
      "Scalar docs returned an invalid Content-Type",
    ],
  ])("rejects an invalid %s", async (_, options, message) => {
    const server = makeAcceptanceServer(options);

    await expectRejectionContaining(
      runDeployedAcceptance(input({ fetch: server.fetch })),
      message,
    );
    expect(mutatingRequests(server.requests)).toEqual([]);
  });

  it.each([
    ["initialization", { mcpInitialization: {} }, "initialization contract"],
    [
      "tools/list",
      { mcpTools: [{ name: "search_profiles" }] },
      "tool contract",
    ],
    [
      "tools/call",
      {
        transformMcpToolEnvelope: (envelope, name) =>
          name === "get_profile"
            ? {
                ...envelope,
                result: {
                  isError: false,
                  structuredContent: envelope.result.structuredContent,
                },
              }
            : envelope,
      },
      "invalid tool result",
    ],
  ])("rejects an incomplete MCP %s envelope", async (_, options, message) => {
    const server = makeAcceptanceServer(options);

    await expectRejectionContaining(
      runDeployedAcceptance(input({ fetch: server.fetch })),
      message,
    );
    expect(server.state().keys.every((key) => key.revoked)).toBe(true);
  });

  it("compares every rate-limit metadata field across transports", async () => {
    const server = makeAcceptanceServer({ mcpRateLimitResetOffset: -1 });

    await expectRejectionContaining(
      runDeployedAcceptance(input({ fetch: server.fetch })),
      "Rate-limit metadata differs between HTTP and MCP",
    );
    expect(server.state().keys.every((key) => key.revoked)).toBe(true);
  });

  it("rejects Retry-After values that disagree with RateLimit-Reset", async () => {
    const server = makeAcceptanceServer({ mcpRateLimitRetryAfter: "999" });

    await expectRejectionContaining(
      runDeployedAcceptance(input({ fetch: server.fetch })),
      "invalid rate-limit metadata",
    );
    expect(server.state().keys.every((key) => key.revoked)).toBe(true);
  });

  it("allows successful rate-limit drift but still compares the complete domain body", async () => {
    const driftServer = makeAcceptanceServer({
      mcpSuccessRateLimitRemaining: "41",
    });

    await expect(
      runDeployedAcceptance(input({ fetch: driftServer.fetch })),
    ).resolves.toMatchObject({ cleanup: { verified: true } });

    const mismatchServer = makeAcceptanceServer({
      mcpSuccessRateLimitRemaining: "41",
      mcpProfileBody: {
        profile: {
          ...profileResult,
          name: "Different Profile",
          links: ["https://github.com/release-profile"],
          contactDetails: contactDetails(),
        },
      },
    });
    await expectRejectionContaining(
      runDeployedAcceptance(input({ fetch: mismatchServer.fetch })),
      "Profile read differs between HTTP and MCP",
    );
    expect(mismatchServer.state().keys.every((key) => key.revoked)).toBe(true);
  });

  it("rejects unapproved hosts before sending credentials", async () => {
    let called = false;

    await expect(
      runDeployedAcceptance(
        input({
          apiUrl: "https://humans-api-preview.attacker.workers.dev",
          fetch: async () => {
            called = true;
            return new Response();
          },
        }),
      ),
    ).rejects.toThrow("not an approved API host");
    expect(called).toBe(false);
  });

  it("rejects the other Humans environment before sending credentials", async () => {
    let called = false;

    await expect(
      runDeployedAcceptance(
        input({
          apiUrl: "https://humans-api-production.hi-541.workers.dev",
          fetch: async () => {
            called = true;
            return new Response();
          },
        }),
      ),
    ).rejects.toThrow("not an approved API host");
    expect(called).toBe(false);
  });

  it("requires an exact confirmation before mutating Production", async () => {
    let called = false;

    await expect(
      runDeployedAcceptance(
        input({
          apiUrl: "https://api.humans.crafter.run",
          environment: "production",
          productionConfirmation: "wrong",
          fetch: async () => {
            called = true;
            return new Response();
          },
        }),
      ),
    ).rejects.toThrow("Production acceptance confirmation is invalid");
    expect(called).toBe(false);
  });

  it.each([
    ["Worker version", { expectedWorkerVersionId: otherWorkerVersionId }],
    ["Member", { memberId: "user_other" }],
    ["Profile", { profileId: "profile_two" }],
    [
      "email Observation",
      { emailObservationId: "44444444-4444-4444-8444-444444444444" },
    ],
    [
      "phone Observation",
      { phoneObservationId: "55555555-5555-4555-8555-555555555555" },
    ],
  ])("binds Production confirmation to the selected %s", async (_, change) => {
    const confirmation = productionAcceptanceConfirmation(
      productionManifestInput(),
    );
    expect(
      productionAcceptanceConfirmation(productionManifestInput(change)),
    ).not.toBe(confirmation);
    let called = false;

    await expect(
      runDeployedAcceptance(
        input({
          apiUrl: "https://api.humans.crafter.run",
          environment: "production",
          productionConfirmation: confirmation,
          ...change,
          fetch: async () => {
            called = true;
            return new Response();
          },
        }),
      ),
    ).rejects.toThrow("Production acceptance confirmation is invalid");
    expect(called).toBe(false);
  });

  it("keeps fixture Profile and Contact Detail values out of confirmation", () => {
    const confirmation = productionAcceptanceConfirmation(
      productionManifestInput(),
    );

    expect(confirmation).toMatch(
      /^production:[0-9a-f]{40}:org_[A-Za-z0-9_-]+:[0-9a-f-]+:sha256:[0-9a-f]{64}$/,
    );
    expect(confirmation).not.toContain(query);
    expect(confirmation).not.toContain(memberId);
    expect(confirmation).not.toContain(profileId);
    expect(confirmation).not.toContain(emailObservationId);
    expect(confirmation).not.toContain(phoneObservationId);
  });

  it("does not allow test safety overrides to raise a hard bound", async () => {
    let called = false;

    await expect(
      runDeployedAcceptance(
        input({
          safetyBounds: { maximumRequests: 181 },
          fetch: async () => {
            called = true;
            return new Response();
          },
        }),
      ),
    ).rejects.toThrow("may only be lowered");
    expect(called).toBe(false);
  });

  it("rejects a deployment with a different release", async () => {
    await expect(
      runDeployedAcceptance(
        input({
          fetch: async () =>
            json(
              {
                checks: { database: "ok", pgvector: "ok" },
                status: "ok",
                worker: { versionId: workerVersionId },
              },
              200,
              {
                "X-Humans-Release": "b".repeat(40),
                "X-Humans-Environment": "preview",
              },
            ),
        }),
      ),
    ).rejects.toThrow("Deployed acceptance failed");
  });

  it.each([
    ["absent", undefined],
    ["malformed", "not-a-uuid"],
  ])(
    "rejects the expected Worker version ID when %s",
    async (_, expectedId) => {
      let called = false;

      await expect(
        runDeployedAcceptance(
          input({
            expectedWorkerVersionId: expectedId,
            fetch: async () => {
              called = true;
              return new Response();
            },
          }),
        ),
      ).rejects.toThrow("HUMANS_ACCEPTANCE_WORKER_VERSION_ID must be a UUID");
      expect(called).toBe(false);
    },
  );

  it("rejects a Worker artifact that does not match the expected version", async () => {
    const server = makeAcceptanceServer();

    await expectRejectionContaining(
      runDeployedAcceptance(
        input({
          expectedWorkerVersionId: otherWorkerVersionId,
          fetch: server.fetch,
        }),
      ),
      "Worker health response is invalid",
    );
    expect(mutatingRequests(server.requests)).toEqual([]);
  });

  it.each([
    [
      "an absent Worker version ID",
      { checks: { database: "ok", pgvector: "ok" }, status: "ok" },
    ],
    [
      "a malformed Worker version ID",
      {
        checks: { database: "ok", pgvector: "ok" },
        status: "ok",
        worker: { versionId: "not-a-uuid" },
      },
    ],
    [
      "an unexpected field",
      {
        checks: { database: "ok", pgvector: "ok" },
        extra: true,
        status: "ok",
        worker: { versionId: workerVersionId },
      },
    ],
  ])("rejects a health response with %s", async (_, healthBody) => {
    const server = makeAcceptanceServer({ healthBody });

    await expectRejectionContaining(
      runDeployedAcceptance(input({ fetch: server.fetch })),
      "Worker health response is invalid",
    );
    expect(mutatingRequests(server.requests)).toEqual([]);
  });

  it("rejects an unhealthy database before provisioning acceptance keys", async () => {
    await expect(
      runDeployedAcceptance(
        input({
          fetch: async () =>
            json(
              {
                checks: { database: "unavailable", pgvector: "unavailable" },
                status: "error",
                worker: { versionId: workerVersionId },
              },
              200,
              {
                "X-Humans-Release": release,
                "X-Humans-Environment": "preview",
              },
            ),
        }),
      ),
    ).rejects.toThrow("Deployed acceptance failed");
  });
});
