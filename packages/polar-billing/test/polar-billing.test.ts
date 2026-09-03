import { describe, expect, it } from "vitest";

import {
  createPolarBillingClient,
  POLAR_API_VERSION,
  POLAR_PRODUCTION_BASE_URL,
  POLAR_SANDBOX_BASE_URL,
  PolarBillingError,
  type PolarBillingClock,
} from "../src/index.js";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const PRO_PRODUCT_ID = "22222222-2222-4222-8222-222222222222";
const USAGE_METER_ID = "33333333-3333-4333-8333-333333333333";
const CUSTOMER_ID = "44444444-4444-4444-8444-444444444444";
const CHECKOUT_ID = "55555555-5555-4555-8555-555555555555";
const SESSION_ID = "66666666-6666-4666-8666-666666666666";
const SUBSCRIPTION_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_PRODUCT_ID = "88888888-8888-4888-8888-888888888888";
const CLERK_ORGANIZATION_ID = "org_2xYZaBc123";
const OTHER_CLERK_ORGANIZATION_ID = "org_3aBCdEf456";
const MEMBER_EXTERNAL_ID = "user_2xYZaBc123";
const OWNER_EMAIL = "owner@acme.example";
const ACCESS_TOKEN = "polar_oat_test_only";
const NOW = new Date("2026-09-03T12:00:00.000Z");

type RecordedRequest = {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  redirect: RequestRedirect | undefined;
};

type QueuedResponse = Response | Error;

const responseHeaders = {
  "Content-Type": "application/json",
  "Polar-Version": POLAR_API_VERSION,
};

const jsonResponse = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...responseHeaders,
      ...Object.fromEntries(new Headers(headers)),
    },
  });

const errorResponse = (status: number, headers: HeadersInit = {}) =>
  jsonResponse(
    {
      detail: "customer@example.test",
      token: ACCESS_TOKEN,
      url: "https://polar.sh/portal/session_secret",
    },
    status,
    headers,
  );

const customerResponse = (overrides: Record<string, unknown> = {}) => ({
  id: CUSTOMER_ID,
  external_id: CLERK_ORGANIZATION_ID,
  organization_id: ORGANIZATION_ID,
  type: "team",
  ...overrides,
});

const checkoutResponse = (overrides: Record<string, unknown> = {}) => ({
  id: CHECKOUT_ID,
  status: "open",
  url: "https://polar.sh/checkout/checkout_secret",
  expires_at: "2026-09-03T13:00:00Z",
  success_url: "https://app.humans.example/settings/billing/success",
  organization_id: ORGANIZATION_ID,
  product_id: PRO_PRODUCT_ID,
  customer_id: CUSTOMER_ID,
  external_customer_id: CLERK_ORGANIZATION_ID,
  metadata: { humansOrganizationId: CLERK_ORGANIZATION_ID },
  ...overrides,
});

const portalResponse = (overrides: Record<string, unknown> = {}) => ({
  id: SESSION_ID,
  token: "polar_customer_session_secret",
  expires_at: "2026-09-03T12:30:00Z",
  return_url: "https://app.humans.example/settings/billing",
  customer_portal_url: "https://polar.sh/acme/portal?token=portal_secret",
  customer_id: CUSTOMER_ID,
  customer: customerResponse(),
  ...overrides,
});

const makeClock = (now = NOW) => {
  const sleeps: number[] = [];
  const clock: PolarBillingClock = {
    now: () => new Date(now),
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  };
  return { clock, sleeps };
};

const makeClient = (
  queuedResponses: QueuedResponse[],
  overrides: Partial<Parameters<typeof createPolarBillingClient>[0]> = {},
) => {
  const requests: RecordedRequest[] = [];
  const queue = [...queuedResponses];
  const fetchImplementation: typeof globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body,
      redirect: init?.redirect,
    });
    const next = queue.shift();
    if (next === undefined) throw new Error("Unexpected test request");
    if (next instanceof Error) throw next;
    return next;
  };
  const { clock, sleeps } = makeClock();
  const client = createPolarBillingClient({
    accessToken: ACCESS_TOKEN,
    baseUrl: POLAR_PRODUCTION_BASE_URL,
    organizationId: ORGANIZATION_ID,
    proProductId: PRO_PRODUCT_ID,
    usageMeterId: USAGE_METER_ID,
    usageEventName: "credit.finalized",
    successUrlAllowlist: [
      "https://app.humans.example",
      "http://localhost:3000",
    ],
    fetch: fetchImplementation,
    clock,
    ...overrides,
  });
  return { client, requests, sleeps };
};

const expectSanitized = (error: unknown) => {
  expect(error).toBeInstanceOf(PolarBillingError);
  const rendered = `${String(error)} ${JSON.stringify(error)}`;
  expect(rendered).not.toContain(ACCESS_TOKEN);
  expect(rendered).not.toContain("customer@example.test");
  expect(rendered).not.toContain("session_secret");
  expect(rendered).not.toContain("portal_secret");
};

describe("configuration", () => {
  it("accepts only the documented production and sandbox base URLs", () => {
    const { client: production } = makeClient([]);
    const { client: sandbox } = makeClient([], {
      baseUrl: POLAR_SANDBOX_BASE_URL,
    });

    expect(production).toBeDefined();
    expect(sandbox).toBeDefined();
    expect(() =>
      makeClient([], { baseUrl: "https://proxy.example/v1" as never }),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_configuration",
        details: { field: "baseUrl" },
      }),
    );
  });

  it("routes sandbox requests to the versioned sandbox API base URL", async () => {
    const { client, requests } = makeClient(
      [jsonResponse(customerResponse())],
      {
        baseUrl: POLAR_SANDBOX_BASE_URL,
      },
    );

    await client.getCustomer(CLERK_ORGANIZATION_ID);

    expect(requests[0]?.url).toBe(
      `${POLAR_SANDBOX_BASE_URL}/customers/external/${CLERK_ORGANIZATION_ID}`,
    );
  });

  it("requires an OAT, UUID configuration, event name, and origin allowlist", () => {
    const invalidOptions: Array<
      [Partial<Parameters<typeof createPolarBillingClient>[0]>, string]
    > = [
      [{ accessToken: "customer_token" }, "accessToken"],
      [{ organizationId: "not-a-uuid" }, "organizationId"],
      [{ proProductId: "not-a-uuid" }, "proProductId"],
      [{ usageMeterId: "not-a-uuid" }, "usageMeterId"],
      [{ usageEventName: "" }, "usageEventName"],
      [{ successUrlAllowlist: [] }, "successUrlAllowlist"],
      [
        { successUrlAllowlist: ["https://app.humans.example/path"] },
        "successUrlAllowlist",
      ],
    ];

    for (const [override, field] of invalidOptions) {
      expect(() => makeClient([], override)).toThrowError(
        expect.objectContaining({
          code: "invalid_configuration",
          details: { field },
        }),
      );
    }
  });
});

describe("Customers", () => {
  it("gets one Customer by immutable Clerk Organization ID with exact headers", async () => {
    const { client, requests } = makeClient([jsonResponse(customerResponse())]);

    await expect(client.getCustomer(CLERK_ORGANIZATION_ID)).resolves.toEqual({
      id: CUSTOMER_ID,
      clerkOrganizationId: CLERK_ORGANIZATION_ID,
      type: "team",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: `${POLAR_PRODUCTION_BASE_URL}/customers/external/${CLERK_ORGANIZATION_ID}`,
      method: "GET",
      body: undefined,
      redirect: "manual",
    });
    expect(Object.fromEntries(requests[0]?.headers ?? [])).toEqual({
      accept: "application/json",
      authorization: `Bearer ${ACCESS_TOKEN}`,
      "polar-version": POLAR_API_VERSION,
    });
  });

  it("returns an existing Customer without creating another", async () => {
    const { client, requests } = makeClient([jsonResponse(customerResponse())]);

    await client.ensureCustomer({
      clerkOrganizationId: CLERK_ORGANIZATION_ID,
      name: "Acme",
      owner: {
        externalId: MEMBER_EXTERNAL_ID,
        email: OWNER_EMAIL,
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
  });

  it("creates a team Customer after a not-found lookup", async () => {
    const { client, requests } = makeClient([
      errorResponse(404),
      jsonResponse(customerResponse(), 201),
    ]);

    await expect(
      client.ensureCustomer({
        clerkOrganizationId: CLERK_ORGANIZATION_ID,
        name: "Acme",
        owner: {
          externalId: MEMBER_EXTERNAL_ID,
          email: OWNER_EMAIL,
        },
      }),
    ).resolves.toMatchObject({ id: CUSTOMER_ID });

    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      url: `${POLAR_PRODUCTION_BASE_URL}/customers/`,
      method: "POST",
      body: {
        type: "team",
        external_id: CLERK_ORGANIZATION_ID,
        name: "Acme",
        organization_id: ORGANIZATION_ID,
        owner: {
          external_id: MEMBER_EXTERNAL_ID,
          email: OWNER_EMAIL,
        },
      },
    });
    expect(Object.fromEntries(requests[1]?.headers ?? [])).toEqual({
      accept: "application/json",
      authorization: `Bearer ${ACCESS_TOKEN}`,
      "content-type": "application/json",
      "polar-version": POLAR_API_VERSION,
    });
  });

  it.each([409, 422])(
    "recovers a concurrent duplicate Customer after status %s",
    async (status) => {
      const { client, requests } = makeClient([
        errorResponse(404),
        errorResponse(status),
        jsonResponse(customerResponse()),
      ]);

      await expect(
        client.ensureCustomer({
          clerkOrganizationId: CLERK_ORGANIZATION_ID,
          name: "Acme",
          owner: {
            externalId: MEMBER_EXTERNAL_ID,
            email: OWNER_EMAIL,
          },
        }),
      ).resolves.toMatchObject({ id: CUSTOMER_ID });

      expect(requests.map(({ method }) => method)).toEqual([
        "GET",
        "POST",
        "GET",
      ]);
    },
  );

  it("does not mistake an unrelated 422 for duplicate recovery", async () => {
    const { client } = makeClient([
      errorResponse(404),
      errorResponse(422),
      errorResponse(404),
    ]);

    const promise = client.ensureCustomer({
      clerkOrganizationId: CLERK_ORGANIZATION_ID,
      name: "Acme",
      owner: {
        externalId: MEMBER_EXTERNAL_ID,
        email: OWNER_EMAIL,
      },
    });
    await expect(promise).rejects.toMatchObject({
      code: "invalid_request",
      details: { operation: "create_customer", statusCode: 422 },
    });
  });

  it("allows one Member email to own multiple Team Customers", async () => {
    const otherCustomerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const { client, requests } = makeClient([
      errorResponse(404),
      jsonResponse(customerResponse(), 201),
      errorResponse(404),
      jsonResponse(
        customerResponse({
          id: otherCustomerId,
          external_id: OTHER_CLERK_ORGANIZATION_ID,
        }),
        201,
      ),
    ]);

    await client.ensureCustomer({
      clerkOrganizationId: CLERK_ORGANIZATION_ID,
      name: "Acme",
      owner: { externalId: MEMBER_EXTERNAL_ID, email: OWNER_EMAIL },
    });
    await client.ensureCustomer({
      clerkOrganizationId: OTHER_CLERK_ORGANIZATION_ID,
      name: "Another Team",
      owner: { externalId: MEMBER_EXTERNAL_ID, email: OWNER_EMAIL },
    });

    const createBodies = requests
      .filter(({ method }) => method === "POST")
      .map(({ body }) => body);
    expect(createBodies).toEqual([
      {
        type: "team",
        external_id: CLERK_ORGANIZATION_ID,
        name: "Acme",
        organization_id: ORGANIZATION_ID,
        owner: {
          external_id: MEMBER_EXTERNAL_ID,
          email: OWNER_EMAIL,
        },
      },
      {
        type: "team",
        external_id: OTHER_CLERK_ORGANIZATION_ID,
        name: "Another Team",
        organization_id: ORGANIZATION_ID,
        owner: {
          external_id: MEMBER_EXTERNAL_ID,
          email: OWNER_EMAIL,
        },
      },
    ]);
    expect(createBodies.every((body) => !("email" in (body as object)))).toBe(
      true,
    );
  });

  it.each([
    [
      {
        clerkOrganizationId: CLERK_ORGANIZATION_ID,
        name: "Acme",
        owner: { externalId: "", email: OWNER_EMAIL },
      },
      "owner.externalId",
    ],
    [
      {
        clerkOrganizationId: CLERK_ORGANIZATION_ID,
        name: "Acme",
        owner: { externalId: MEMBER_EXTERNAL_ID, email: "not-an-email" },
      },
      "owner.email",
    ],
    [
      {
        clerkOrganizationId: CLERK_ORGANIZATION_ID,
        name: "Acme",
        owner: {
          externalId: MEMBER_EXTERNAL_ID,
          email: OWNER_EMAIL,
          name: "Unexpected",
        },
      },
      "owner",
    ],
  ])("rejects an invalid Team Customer owner at %s", async (input, field) => {
    const { client, requests } = makeClient([]);

    await expect(client.ensureCustomer(input as never)).rejects.toMatchObject({
      code: "invalid_input",
      details: { field },
    });
    expect(requests).toHaveLength(0);
  });

  it("rejects a non-Team Customer returned for an Organization", async () => {
    const { client } = makeClient([
      jsonResponse(customerResponse({ type: "individual" })),
    ]);

    await expect(
      client.getCustomer(CLERK_ORGANIZATION_ID),
    ).rejects.toMatchObject({
      code: "malformed_response",
      details: { operation: "get_customer" },
    });
  });
});

describe("Pro checkout", () => {
  it("pins one product and exposes no price, amount, unit, seat, or overage input", async () => {
    const successUrl =
      "https://app.humans.example/settings/billing/success?checkout_id={CHECKOUT_ID}";
    const { client, requests } = makeClient([
      jsonResponse(checkoutResponse({ success_url: successUrl }), 201),
    ]);

    await expect(
      client.createProCheckout({
        clerkOrganizationId: CLERK_ORGANIZATION_ID,
        successUrl,
      }),
    ).resolves.toEqual({
      id: CHECKOUT_ID,
      url: "https://polar.sh/checkout/checkout_secret",
      expiresAt: new Date("2026-09-03T13:00:00Z"),
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: `${POLAR_PRODUCTION_BASE_URL}/checkouts/`,
      method: "POST",
      body: {
        products: [PRO_PRODUCT_ID],
        external_customer_id: CLERK_ORGANIZATION_ID,
        success_url: successUrl,
        allow_discount_codes: false,
        allow_trial: false,
        metadata: { humansOrganizationId: CLERK_ORGANIZATION_ID },
      },
    });
    expect(Object.keys(requests[0]?.body as object).sort()).toEqual([
      "allow_discount_codes",
      "allow_trial",
      "external_customer_id",
      "metadata",
      "products",
      "success_url",
    ]);
    expect(JSON.stringify(requests[0]?.body)).not.toMatch(
      /amount|meter|overage|price|seat|unit/i,
    );
  });

  it("allows paths on an allowlisted origin and rejects lookalike origins", async () => {
    const { client, requests } = makeClient([
      jsonResponse(checkoutResponse(), 201),
    ]);

    await client.createProCheckout({
      clerkOrganizationId: CLERK_ORGANIZATION_ID,
      successUrl: "https://app.humans.example/settings/billing/success",
    });
    await expect(
      client.createProCheckout({
        clerkOrganizationId: CLERK_ORGANIZATION_ID,
        successUrl: "https://app.humans.example.evil.test/success",
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      details: { field: "successUrl" },
    });
    expect(requests).toHaveLength(1);
  });

  it("rejects caller-supplied product and price fields at runtime", async () => {
    const { client, requests } = makeClient([]);

    await expect(
      client.createProCheckout({
        clerkOrganizationId: CLERK_ORGANIZATION_ID,
        successUrl: "https://app.humans.example/success",
        productId: OTHER_PRODUCT_ID,
        priceId: "99999999-9999-4999-8999-999999999999",
      } as never),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(requests).toHaveLength(0);
  });

  it("fails closed if Polar responds with a different selected product", async () => {
    const secretUrl = "https://polar.sh/checkout/do_not_expose_this_secret";
    const { client } = makeClient([
      jsonResponse(
        checkoutResponse({ product_id: OTHER_PRODUCT_ID, url: secretUrl }),
        201,
      ),
    ]);

    const promise = client.createProCheckout({
      clerkOrganizationId: CLERK_ORGANIZATION_ID,
      successUrl: "https://app.humans.example/settings/billing/success",
    });
    const error = await promise.catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "malformed_response" });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(
      secretUrl,
    );
  });
});

describe("Customer Portal", () => {
  it("creates a short-lived portal session without exposing its raw token", async () => {
    const { client, requests } = makeClient([
      jsonResponse(portalResponse(), 201),
    ]);

    const session = await client.createCustomerPortalSession({
      clerkOrganizationId: CLERK_ORGANIZATION_ID,
      returnUrl: "https://app.humans.example/settings/billing",
    });

    expect(session).toEqual({
      id: SESSION_ID,
      url: "https://polar.sh/acme/portal?token=portal_secret",
      expiresAt: new Date("2026-09-03T12:30:00Z"),
    });
    expect(session).not.toHaveProperty("token");
    expect(requests[0]).toMatchObject({
      url: `${POLAR_PRODUCTION_BASE_URL}/customer-sessions/`,
      method: "POST",
      body: {
        external_customer_id: CLERK_ORGANIZATION_ID,
        return_url: "https://app.humans.example/settings/billing",
      },
    });
  });

  it("applies the redirect allowlist to the portal return URL", async () => {
    const { client, requests } = makeClient([]);

    await expect(
      client.createCustomerPortalSession({
        clerkOrganizationId: CLERK_ORGANIZATION_ID,
        returnUrl: "https://attacker.example/return",
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      details: { field: "returnUrl" },
    });
    expect(requests).toHaveLength(0);
  });
});

describe("Customer state", () => {
  it("reads the pinned Pro subscription status and billing period", async () => {
    const { client, requests } = makeClient([
      jsonResponse({
        ...customerResponse(),
        active_subscriptions: [
          {
            id: SUBSCRIPTION_ID,
            status: "active",
            product_id: PRO_PRODUCT_ID,
            current_period_start: "2026-09-01T00:00:00Z",
            current_period_end: "2026-10-01T00:00:00Z",
            cancel_at_period_end: false,
          },
          {
            id: "99999999-9999-4999-8999-999999999999",
            status: "trialing",
            product_id: OTHER_PRODUCT_ID,
            current_period_start: "2026-09-01T00:00:00Z",
            current_period_end: "2026-09-15T00:00:00Z",
            cancel_at_period_end: true,
          },
        ],
      }),
    ]);

    await expect(
      client.getCustomerState(CLERK_ORGANIZATION_ID),
    ).resolves.toEqual({
      customer: {
        id: CUSTOMER_ID,
        clerkOrganizationId: CLERK_ORGANIZATION_ID,
        type: "team",
      },
      proSubscription: {
        id: SUBSCRIPTION_ID,
        status: "active",
        currentPeriodStart: new Date("2026-09-01T00:00:00Z"),
        currentPeriodEnd: new Date("2026-10-01T00:00:00Z"),
        cancelAtPeriodEnd: false,
      },
    });
    expect(requests[0]?.url).toBe(
      `${POLAR_PRODUCTION_BASE_URL}/customers/external/${CLERK_ORGANIZATION_ID}/state`,
    );
  });

  it("represents no active pinned subscription as Free state", async () => {
    const { client } = makeClient([
      jsonResponse({ ...customerResponse(), active_subscriptions: [] }),
    ]);

    await expect(
      client.getCustomerState(CLERK_ORGANIZATION_ID),
    ).resolves.toMatchObject({ proSubscription: null });
  });
});

describe("finalized Credit usage", () => {
  it("uses Polar event external_id for event-level idempotency", async () => {
    const finalizedAt = new Date("2026-09-03T11:30:00.000Z");
    const { client, requests } = makeClient([
      jsonResponse({ inserted: 2, duplicates: 0 }),
      jsonResponse({ inserted: 0, duplicates: 2 }),
    ]);
    const events = [
      {
        idempotencyKey: "search:request_123:consumption",
        clerkOrganizationId: CLERK_ORGANIZATION_ID,
        occurredAt: finalizedAt,
      },
      {
        idempotencyKey: "search:request_124:consumption",
        clerkOrganizationId: CLERK_ORGANIZATION_ID,
        occurredAt: new Date("2026-09-03T11:31:00.000Z"),
      },
    ];

    await expect(client.ingestFinalizedCreditUsage(events)).resolves.toEqual({
      inserted: 2,
      duplicates: 0,
    });
    await expect(client.ingestFinalizedCreditUsage(events)).resolves.toEqual({
      inserted: 0,
      duplicates: 2,
    });

    expect(requests[0]?.body).toEqual({
      events: [
        {
          name: "credit.finalized",
          external_customer_id: CLERK_ORGANIZATION_ID,
          external_id: "search:request_123:consumption",
          timestamp: "2026-09-03T11:30:00.000Z",
          organization_id: ORGANIZATION_ID,
        },
        {
          name: "credit.finalized",
          external_customer_id: CLERK_ORGANIZATION_ID,
          external_id: "search:request_124:consumption",
          timestamp: "2026-09-03T11:31:00.000Z",
          organization_id: ORGANIZATION_ID,
        },
      ],
    });
    expect(requests[1]?.body).toEqual(requests[0]?.body);
    expect(JSON.stringify(requests[0]?.body)).not.toMatch(
      /amount|overage|price|quantity/i,
    );
  });

  it("uses the injected clock and rejects duplicate keys in one batch", async () => {
    const { client, requests } = makeClient([jsonResponse({ inserted: 1 })]);

    await expect(
      client.ingestFinalizedCreditUsage([
        {
          idempotencyKey: "contact:reveal_123:consumption",
          clerkOrganizationId: CLERK_ORGANIZATION_ID,
        },
      ]),
    ).resolves.toEqual({ inserted: 1, duplicates: 0 });
    expect(requests[0]?.body).toMatchObject({
      events: [{ timestamp: NOW.toISOString() }],
    });

    await expect(
      client.ingestFinalizedCreditUsage([
        {
          idempotencyKey: "duplicate",
          clerkOrganizationId: CLERK_ORGANIZATION_ID,
        },
        {
          idempotencyKey: "duplicate",
          clerkOrganizationId: CLERK_ORGANIZATION_ID,
        },
      ]),
    ).rejects.toMatchObject({
      code: "invalid_input",
      details: { field: "idempotencyKey" },
    });
    expect(requests).toHaveLength(1);
  });
});

describe("meter reconciliation", () => {
  it("reads quantities for one external Customer in UTC", async () => {
    const { client, requests } = makeClient([
      jsonResponse({
        quantities: [
          { timestamp: "2026-09-01T00:00:00Z", quantity: 41 },
          { timestamp: "2026-09-02T00:00:00Z", quantity: 17 },
        ],
        total: 58,
      }),
    ]);

    await expect(
      client.getMeterQuantities({
        clerkOrganizationId: CLERK_ORGANIZATION_ID,
        startAt: new Date("2026-09-01T00:00:00Z"),
        endAt: new Date("2026-10-01T00:00:00Z"),
        interval: "day",
      }),
    ).resolves.toEqual({
      quantities: [
        { timestamp: new Date("2026-09-01T00:00:00Z"), quantity: 41 },
        { timestamp: new Date("2026-09-02T00:00:00Z"), quantity: 17 },
      ],
      total: 58,
    });

    expect(requests[0]?.url).toBe(
      `${POLAR_PRODUCTION_BASE_URL}/meters/${USAGE_METER_ID}/quantities?start_timestamp=2026-09-01T00%3A00%3A00.000Z&end_timestamp=2026-10-01T00%3A00%3A00.000Z&interval=day&timezone=UTC&external_customer_id=${CLERK_ORGANIZATION_ID}`,
    );
    expect(requests[0]?.method).toBe("GET");
  });
});

describe("sanitized errors and retries", () => {
  it.each([
    [401, "unauthorized", false],
    [403, "forbidden", false],
    [404, "not_found", false],
    [409, "conflict", false],
    [422, "invalid_request", false],
  ] as const)(
    "maps status %s to %s without retaining the response body",
    async (status, code, retryable) => {
      const { client } = makeClient([errorResponse(status)]);

      const error = await client
        .getCustomer(CLERK_ORGANIZATION_ID)
        .catch((cause: unknown) => cause);
      expect(error).toMatchObject({
        code,
        retryable,
        details: { operation: "get_customer", statusCode: status },
      });
      expectSanitized(error);
    },
  );

  it("honors Retry-After seconds on 429 and exposes only the safe delay", async () => {
    const { client, requests, sleeps } = makeClient([
      errorResponse(429, { "Retry-After": "3" }),
      errorResponse(429, { "Retry-After": "3" }),
      errorResponse(429, { "Retry-After": "3" }),
    ]);

    const error = await client
      .getCustomer(CLERK_ORGANIZATION_ID)
      .catch((cause: unknown) => cause);
    expect(requests).toHaveLength(3);
    expect(sleeps).toEqual([3000, 3000]);
    expect(error).toMatchObject({
      code: "rate_limited",
      retryable: true,
      details: {
        operation: "get_customer",
        statusCode: 429,
        retryAfterMs: 3000,
      },
    });
    expectSanitized(error);
  });

  it("honors an HTTP-date Retry-After on 5xx before retrying", async () => {
    const { clock, sleeps } = makeClock();
    const { client, requests } = makeClient(
      [
        errorResponse(503, {
          "Retry-After": "Thu, 03 Sep 2026 12:00:05 GMT",
        }),
        jsonResponse(customerResponse()),
      ],
      { clock },
    );

    await expect(
      client.getCustomer(CLERK_ORGANIZATION_ID),
    ).resolves.toMatchObject({ id: CUSTOMER_ID });
    expect(requests).toHaveLength(2);
    expect(sleeps).toEqual([5000]);
  });

  it("uses bounded fallback backoff and returns a typed 5xx error", async () => {
    const { client, requests, sleeps } = makeClient([
      errorResponse(500),
      errorResponse(502),
      errorResponse(503),
    ]);

    const error = await client
      .getCustomer(CLERK_ORGANIZATION_ID)
      .catch((cause: unknown) => cause);
    expect(requests).toHaveLength(3);
    expect(sleeps).toEqual([250, 500]);
    expect(error).toMatchObject({
      code: "server_error",
      retryable: true,
      details: { operation: "get_customer", statusCode: 503 },
    });
    expectSanitized(error);
  });

  it("sanitizes network failures without retaining their cause", async () => {
    const dangerousCause = new Error(
      `${ACCESS_TOKEN} customer@example.test https://polar.sh/session_secret`,
    );
    const { client } = makeClient([dangerousCause]);

    const error = await client
      .getCustomer(CLERK_ORGANIZATION_ID)
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: "network_error",
      retryable: true,
      details: { operation: "get_customer" },
    });
    expectSanitized(error);
    expect(error).not.toHaveProperty("cause");
  });

  it.each([
    new Response("not-json", {
      status: 200,
      headers: responseHeaders,
    }),
    new Response(JSON.stringify(customerResponse()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    new Response(JSON.stringify(customerResponse()), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Polar-Version": "2026-10",
      },
    }),
    new Response(JSON.stringify(customerResponse()), {
      status: 200,
      headers: {
        "Content-Type": "text/plain",
        "Polar-Version": POLAR_API_VERSION,
      },
    }),
    jsonResponse(customerResponse({ organization_id: "wrong" })),
  ])("fails closed on a malformed or unpinned response", async (response) => {
    const { client } = makeClient([response]);

    const error = await client
      .getCustomer(CLERK_ORGANIZATION_ID)
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: "malformed_response",
      retryable: false,
      details: { operation: "get_customer" },
    });
    expectSanitized(error);
  });
});
