import { createHmac } from "node:crypto";

import { POLAR_API_VERSION } from "@humans/polar-billing";
import { describe, expect, it } from "vitest";

import type { Bindings } from "../src/app";
import { createPolarBoundary, polarBoundary } from "../src/polar";

const POLAR_ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const PRO_PRODUCT_ID = "22222222-2222-4222-8222-222222222222";
const USAGE_METER_ID = "33333333-3333-4333-8333-333333333333";
const CUSTOMER_ID = "44444444-4444-4444-8444-444444444444";
const SUBSCRIPTION_ID = "55555555-5555-4555-8555-555555555555";
const ORDER_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_PRODUCT_ID = "77777777-7777-4777-8777-777777777777";
const ORGANIZATION_ID = "org_one";
const MEMBER_EXTERNAL_ID = "user_one";
const EVENT_TIMESTAMP = new Date("2026-09-02T12:00:00Z");
const PERIOD_START = new Date("2026-09-01T00:00:00Z");
const PERIOD_END = new Date("2026-10-01T00:00:00Z");
const WEBHOOK_SECRET = "whsec_ovyN6cPrTv56AApvzCaJno08SSmGJmgbWilb33N2JuK";

const bindings = {
  POLAR_ACCESS_TOKEN: "polar_oat_test_only",
  POLAR_BASE_URL: "https://api.polar.sh/v1",
  POLAR_ORGANIZATION_ID,
  POLAR_PRO_PRODUCT_ID: PRO_PRODUCT_ID,
  POLAR_USAGE_METER_ID: USAGE_METER_ID,
  POLAR_USAGE_EVENT_NAME: "credit.finalized",
  POLAR_WEBHOOK_SECRET: WEBHOOK_SECRET,
  BILLING_APP_ORIGIN: "https://app.humans.example",
} as Bindings;

type RecordedRequest = {
  url: string;
  method: string;
  body: unknown;
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Polar-Version": POLAR_API_VERSION,
    },
  });

const makeFetch = (responses: Response[]) => {
  const queue = [...responses];
  const requests: RecordedRequest[] = [];
  const fetchImplementation: typeof globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    requests.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const response = queue.shift();
    if (response === undefined) throw new Error("Unexpected test request");
    return response;
  };
  return { fetchImplementation, requests };
};

const customerMapping = (overrides: Record<string, unknown> = {}) => ({
  id: CUSTOMER_ID,
  external_id: ORGANIZATION_ID,
  organization_id: POLAR_ORGANIZATION_ID,
  type: "team",
  ...overrides,
});

const subscriptionData = (overrides: Record<string, unknown> = {}) => ({
  id: SUBSCRIPTION_ID,
  status: "active",
  product_id: PRO_PRODUCT_ID,
  customer_id: CUSTOMER_ID,
  current_period_start: PERIOD_START.toISOString(),
  current_period_end: PERIOD_END.toISOString(),
  cancel_at_period_end: false,
  metadata: { humansOrganizationId: ORGANIZATION_ID },
  customer: customerMapping(),
  ...overrides,
});

const subscriptionEnvelope = (
  type = "subscription.updated",
  dataOverrides: Record<string, unknown> = {},
) => ({
  type,
  timestamp: EVENT_TIMESTAMP.toISOString(),
  data: subscriptionData(dataOverrides),
});

const orderSubscription = (overrides: Record<string, unknown> = {}) => ({
  id: SUBSCRIPTION_ID,
  status: "active",
  product_id: PRO_PRODUCT_ID,
  customer_id: CUSTOMER_ID,
  current_period_start: PERIOD_START.toISOString(),
  current_period_end: PERIOD_END.toISOString(),
  cancel_at_period_end: false,
  metadata: { humansOrganizationId: ORGANIZATION_ID },
  ...overrides,
});

const orderEnvelope = (dataOverrides: Record<string, unknown> = {}) => ({
  type: "order.paid",
  timestamp: EVENT_TIMESTAMP.toISOString(),
  data: {
    id: ORDER_ID,
    status: "paid",
    paid: true,
    billing_reason: "subscription_cycle",
    customer_id: CUSTOMER_ID,
    product_id: PRO_PRODUCT_ID,
    subscription_id: SUBSCRIPTION_ID,
    metadata: { humansOrganizationId: ORGANIZATION_ID },
    customer: customerMapping(),
    subscription: orderSubscription(),
    ...dataOverrides,
  },
});

const signedRequest = (payload: unknown, eventId = "polar_event_one") => {
  const body = JSON.stringify(payload);
  const signedAt = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${eventId}.${signedAt}.${body}`)
    .digest("base64");
  return new Request("http://localhost/webhooks/polar", {
    method: "POST",
    body,
    headers: {
      "webhook-id": eventId,
      "webhook-signature": `v1,${signature}`,
      "webhook-timestamp": String(signedAt),
    },
  });
};

describe("Polar configuration boundary", () => {
  const configurationNames = [
    "POLAR_ACCESS_TOKEN",
    "POLAR_BASE_URL",
    "POLAR_ORGANIZATION_ID",
    "POLAR_PRO_PRODUCT_ID",
    "POLAR_USAGE_METER_ID",
    "POLAR_USAGE_EVENT_NAME",
    "POLAR_WEBHOOK_SECRET",
    "BILLING_APP_ORIGIN",
  ] as const;

  it("reports billing disabled only when no billing configuration is present", () => {
    expect(polarBoundary.billingConfigured(undefined)).toBe(false);
    expect(polarBoundary.billingConfigured({} as Bindings)).toBe(false);
    expect(polarBoundary.billingConfigured(bindings)).toBe(true);
  });

  it.each(configurationNames)(
    "requires %s whenever billing is partially configured",
    (name) => {
      const partial = { ...bindings };
      delete partial[name];

      expect(() => polarBoundary.billingConfigured(partial)).toThrowError(
        expect.objectContaining({
          code: "invalid_configuration",
          details: { field: name },
        }),
      );
    },
  );

  it("rejects a blank webhook secret during readiness", () => {
    expect(() =>
      polarBoundary.billingConfigured({
        ...bindings,
        POLAR_WEBHOOK_SECRET: " ",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_configuration",
        details: { field: "POLAR_WEBHOOK_SECRET" },
      }),
    );
  });
});

describe("Polar provider boundary", () => {
  it("creates a Team Customer with a Member owner and no Customer email", async () => {
    const { fetchImplementation, requests } = makeFetch([
      jsonResponse({}, 404),
      jsonResponse(
        {
          ...customerMapping(),
          type: "team",
        },
        201,
      ),
    ]);
    const boundary = createPolarBoundary(fetchImplementation);

    await boundary.ensureCustomer(
      {
        clerkOrganizationId: ORGANIZATION_ID,
        name: "Acme",
        owner: {
          externalId: MEMBER_EXTERNAL_ID,
          email: "owner@acme.example",
        },
      },
      bindings,
    );

    expect(requests[1]).toMatchObject({
      method: "POST",
      body: {
        type: "team",
        external_id: ORGANIZATION_ID,
        name: "Acme",
        organization_id: POLAR_ORGANIZATION_ID,
        owner: {
          external_id: MEMBER_EXTERNAL_ID,
          email: "owner@acme.example",
        },
      },
    });
    expect(requests[1]?.body).not.toHaveProperty("email");
  });

  it("exposes authoritative active Pro subscription state", async () => {
    const { fetchImplementation, requests } = makeFetch([
      jsonResponse({
        ...customerMapping(),
        type: "team",
        active_subscriptions: [
          {
            id: SUBSCRIPTION_ID,
            status: "active",
            product_id: PRO_PRODUCT_ID,
            current_period_start: PERIOD_START.toISOString(),
            current_period_end: PERIOD_END.toISOString(),
            cancel_at_period_end: false,
          },
        ],
      }),
    ]);
    const boundary = createPolarBoundary(fetchImplementation);

    await expect(
      boundary.getCustomerState(ORGANIZATION_ID, bindings),
    ).resolves.toEqual({
      customer: {
        id: CUSTOMER_ID,
        clerkOrganizationId: ORGANIZATION_ID,
        type: "team",
      },
      proSubscription: {
        id: SUBSCRIPTION_ID,
        status: "active",
        currentPeriodStart: PERIOD_START,
        currentPeriodEnd: PERIOD_END,
        cancelAtPeriodEnd: false,
      },
    });
    expect(requests).toEqual([
      expect.objectContaining({
        method: "GET",
        url: `https://api.polar.sh/v1/customers/external/${ORGANIZATION_ID}/state`,
      }),
    ]);
  });
});

describe("Polar webhook boundary", () => {
  const subscriptionEventCases = [
    ["subscription.created", "incomplete"],
    ["subscription.active", "active"],
    ["subscription.updated", "active"],
    ["subscription.canceled", "active"],
    ["subscription.uncanceled", "active"],
    ["subscription.cycled", "active"],
    ["subscription.revoked", "canceled"],
    ["subscription.past_due", "past_due"],
    ["subscription.paused", "paused"],
    ["subscription.resumed", "active"],
  ] as const;

  it.each(subscriptionEventCases)(
    "parses signed %s state",
    async (eventType, status) => {
      const eventId = `polar_${eventType}`;

      await expect(
        polarBoundary.verifyBillingWebhook(
          signedRequest(subscriptionEnvelope(eventType, { status }), eventId),
          bindings,
        ),
      ).resolves.toEqual({
        eventId,
        eventType,
        occurredAt: EVENT_TIMESTAMP,
        organizationId: ORGANIZATION_ID,
        polarCustomerId: CUSTOMER_ID,
        subscriptionId: SUBSCRIPTION_ID,
        status,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        cancelAtPeriodEnd: false,
      });
    },
  );

  it.each([
    "incomplete",
    "incomplete_expired",
    "trialing",
    "active",
    "past_due",
    "canceled",
    "unpaid",
    "paused",
  ] as const)("preserves the pinned %s subscription status", async (status) => {
    await expect(
      polarBoundary.verifyBillingWebhook(
        signedRequest(subscriptionEnvelope("subscription.updated", { status })),
        bindings,
      ),
    ).resolves.toMatchObject({ status });
  });

  it("accepts RFC 3339 offsets from the pinned webhook contract", async () => {
    await expect(
      polarBoundary.verifyBillingWebhook(
        signedRequest({
          ...subscriptionEnvelope(),
          timestamp: "2026-09-02T07:00:00-05:00",
          data: subscriptionData({
            current_period_start: "2026-08-31T19:00:00-05:00",
            current_period_end: "2026-09-30T19:00:00-05:00",
          }),
        }),
        bindings,
      ),
    ).resolves.toMatchObject({
      occurredAt: EVENT_TIMESTAMP,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
  });

  it("retains the subscription-only verifier for the current route", async () => {
    await expect(
      polarBoundary.verifySubscriptionWebhook(
        signedRequest(subscriptionEnvelope()),
        bindings,
      ),
    ).resolves.toMatchObject({
      eventType: "subscription.updated",
      subscriptionId: SUBSCRIPTION_ID,
    });
    await expect(
      polarBoundary.verifySubscriptionWebhook(
        signedRequest(orderEnvelope()),
        bindings,
      ),
    ).resolves.toBeNull();
  });

  it.each([
    "subscription_create",
    "subscription_cycle",
    "subscription_update",
    "subscription_meter_cycle",
  ] as const)("parses a confirmed %s payment", async (billingReason) => {
    const eventId = `polar_order_${billingReason}`;

    await expect(
      polarBoundary.verifyBillingWebhook(
        signedRequest(
          orderEnvelope({ billing_reason: billingReason }),
          eventId,
        ),
        bindings,
      ),
    ).resolves.toEqual({
      eventId,
      eventType: "order.paid",
      occurredAt: EVENT_TIMESTAMP,
      organizationId: ORGANIZATION_ID,
      polarCustomerId: CUSTOMER_ID,
      subscriptionId: SUBSCRIPTION_ID,
      status: "active",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      cancelAtPeriodEnd: false,
      orderId: ORDER_ID,
      billingReason,
    });
  });

  it("maps a renewal through subscription metadata, not Order metadata", async () => {
    await expect(
      polarBoundary.verifyBillingWebhook(
        signedRequest(orderEnvelope({ metadata: {} })),
        bindings,
      ),
    ).resolves.toMatchObject({
      eventType: "order.paid",
      organizationId: ORGANIZATION_ID,
      billingReason: "subscription_cycle",
    });
  });

  it("ignores paid purchases and billing events for other products", async () => {
    await expect(
      polarBoundary.verifyBillingWebhook(
        signedRequest(
          orderEnvelope({
            billing_reason: "purchase",
            subscription_id: null,
            subscription: null,
          }),
        ),
        bindings,
      ),
    ).resolves.toBeNull();
    await expect(
      polarBoundary.verifyBillingWebhook(
        signedRequest(
          subscriptionEnvelope("subscription.updated", {
            product_id: OTHER_PRODUCT_ID,
          }),
        ),
        bindings,
      ),
    ).resolves.toBeNull();
    await expect(
      polarBoundary.verifyBillingWebhook(
        signedRequest(
          orderEnvelope({
            product_id: OTHER_PRODUCT_ID,
            subscription: orderSubscription({ product_id: OTHER_PRODUCT_ID }),
          }),
        ),
        bindings,
      ),
    ).resolves.toBeNull();
  });

  it("ignores signed webhook types outside the billing state machine", async () => {
    await expect(
      polarBoundary.verifyBillingWebhook(
        signedRequest({
          type: "customer.updated",
          timestamp: EVENT_TIMESTAMP.toISOString(),
          data: {},
        }),
        bindings,
      ),
    ).resolves.toBeNull();
  });

  it.each([
    [
      "subscription",
      subscriptionEnvelope("subscription.updated", {
        customer: customerMapping({ external_id: "org_other" }),
      }),
    ],
    [
      "Customer type",
      subscriptionEnvelope("subscription.updated", {
        customer: customerMapping({ type: "individual" }),
      }),
    ],
    [
      "paid Order Customer",
      orderEnvelope({ customer_id: "88888888-8888-4888-8888-888888888888" }),
    ],
    [
      "paid Order subscription",
      orderEnvelope({
        subscription_id: "88888888-8888-4888-8888-888888888888",
      }),
    ],
    ["paid Order product", orderEnvelope({ product_id: OTHER_PRODUCT_ID })],
    [
      "paid Order subscription product",
      orderEnvelope({
        subscription: orderSubscription({ product_id: OTHER_PRODUCT_ID }),
      }),
    ],
  ])("rejects a mismatched %s mapping", async (_label, payload) => {
    await expect(
      polarBoundary.verifyBillingWebhook(signedRequest(payload), bindings),
    ).rejects.toThrow(/mapping is invalid/);
  });

  it.each([
    { status: "pending" },
    { paid: false },
    {
      currentPeriod: orderSubscription({
        current_period_start: PERIOD_END.toISOString(),
        current_period_end: PERIOD_START.toISOString(),
      }),
    },
  ])("rejects malformed payment confirmation %#", async (override) => {
    const payload =
      "currentPeriod" in override
        ? orderEnvelope({ subscription: override.currentPeriod })
        : orderEnvelope(override);
    await expect(
      polarBoundary.verifyBillingWebhook(signedRequest(payload), bindings),
    ).rejects.toThrow();
  });

  it("rejects a forged billing event", async () => {
    await expect(
      polarBoundary.verifyBillingWebhook(
        new Request("http://localhost/webhooks/polar", {
          method: "POST",
          body: JSON.stringify(subscriptionEnvelope()),
          headers: {
            "webhook-id": "forged",
            "webhook-signature": "forged",
            "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
          },
        }),
        bindings,
      ),
    ).rejects.toThrow();
  });
});
