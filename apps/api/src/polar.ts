import { createHmac, timingSafeEqual } from "node:crypto";

import {
  type CreatePolarBillingClientOptions,
  createPolarBillingClient,
  type EnsurePolarCustomerInput,
  type GetMeterQuantitiesInput,
  POLAR_PRODUCTION_BASE_URL,
  POLAR_SANDBOX_BASE_URL,
  PolarBillingError,
  type PolarCheckoutSession,
  type PolarCheckout,
  type PolarCustomer,
  type PolarCustomerPortalSession,
  type PolarCustomerState,
  type PolarMeterQuantities,
} from "@humans/polar-billing";
import { Webhook } from "standardwebhooks";
import { z } from "zod";

import type { Bindings } from "./app";

const subscriptionStatuses = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
] as const;

const subscriptionEventTypes = [
  "subscription.created",
  "subscription.active",
  "subscription.updated",
  "subscription.canceled",
  "subscription.uncanceled",
  "subscription.cycled",
  "subscription.revoked",
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
] as const;

const orderBillingReasons = [
  "purchase",
  "subscription_create",
  "subscription_cycle",
  "subscription_update",
  "subscription_meter_cycle",
] as const;

const subscriptionPaymentReasons = [
  "subscription_create",
  "subscription_cycle",
  "subscription_update",
  "subscription_meter_cycle",
] as const;

type PolarSubscriptionState = {
  eventId: string;
  occurredAt: Date;
  organizationId: string;
  polarCustomerId: string;
  subscriptionId: string;
  status: (typeof subscriptionStatuses)[number];
  periodStart: Date;
  periodEnd: Date;
  cancelAtPeriodEnd: boolean;
};

export type PolarSubscriptionEvent = PolarSubscriptionState & {
  eventType: (typeof subscriptionEventTypes)[number];
};

export type PolarSubscriptionPaymentEvent = PolarSubscriptionState & {
  eventType: "order.paid";
  order: PolarOrderState;
};

type PolarOrderState = {
  orderId: string;
  status: "paid" | "partially_refunded" | "refunded";
  billingReason: (typeof subscriptionPaymentReasons)[number];
  currency: string;
  totalAmount: number;
  refundedAmount: number;
  refundedTaxAmount: number;
};

export type PolarOrderRefundEvent = PolarSubscriptionState & {
  eventType: "order.refunded";
  order: PolarOrderState & { status: "partially_refunded" | "refunded" };
};

export type PolarBillingEvent =
  | PolarSubscriptionEvent
  | PolarSubscriptionPaymentEvent
  | PolarOrderRefundEvent;

const polarDateTime = z.iso.datetime({ offset: true });

export type PolarBoundary = {
  billingConfigured(bindings: Bindings | undefined): boolean;
  ensureCustomer(
    input: EnsurePolarCustomerInput,
    bindings: Bindings,
  ): Promise<PolarCustomer>;
  findOpenProCheckout(
    organizationId: string,
    bindings: Bindings,
  ): Promise<PolarCheckoutSession | null>;
  findProCheckoutByClaim(
    claimId: string,
    organizationId: string,
    bindings: Bindings,
  ): Promise<PolarCheckout | null>;
  getProCheckout(
    checkoutId: string,
    organizationId: string,
    bindings: Bindings,
  ): Promise<PolarCheckout>;
  createProCheckout(
    organizationId: string,
    claimId: string,
    bindings: Bindings,
  ): Promise<PolarCheckoutSession>;
  createCustomerPortalSession(
    organizationId: string,
    bindings: Bindings,
  ): Promise<PolarCustomerPortalSession>;
  getCustomerState(
    organizationId: string,
    bindings: Bindings,
  ): Promise<PolarCustomerState>;
  getMeterQuantities(
    input: GetMeterQuantitiesInput,
    bindings: Bindings,
  ): Promise<PolarMeterQuantities>;
  verifySubscriptionWebhook(
    request: Request,
    bindings: Bindings,
  ): Promise<PolarSubscriptionEvent | null>;
  verifyBillingWebhook(
    request: Request,
    bindings: Bindings,
  ): Promise<PolarBillingEvent | null>;
};

const customerMapping = z.object({
  id: z.uuid(),
  external_id: z.string().regex(/^org_[A-Za-z0-9_-]+$/),
  organization_id: z.uuid(),
  type: z.enum(["individual", "team"]),
});

const subscriptionEvent = z.object({
  type: z.enum(subscriptionEventTypes),
  timestamp: polarDateTime,
  data: z.object({
    id: z.uuid(),
    status: z.enum(subscriptionStatuses),
    product_id: z.uuid(),
    customer_id: z.uuid(),
    current_period_start: polarDateTime,
    current_period_end: polarDateTime,
    cancel_at_period_end: z.boolean(),
    metadata: z.record(z.string(), z.unknown()),
    customer: customerMapping,
  }),
});

const orderPaidEvent = z.object({
  type: z.literal("order.paid"),
  timestamp: polarDateTime,
  data: z.object({
    id: z.uuid(),
    status: z.literal("paid"),
    paid: z.literal(true),
    billing_reason: z.enum(orderBillingReasons),
    currency: z.string().regex(/^[a-z]{3}$/),
    total_amount: z.number().int().nonnegative(),
    refunded_amount: z.number().int().nonnegative(),
    refunded_tax_amount: z.number().int().nonnegative(),
    customer_id: z.uuid(),
    product_id: z.uuid().nullable(),
    subscription_id: z.uuid().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    customer: customerMapping,
    subscription: z
      .object({
        id: z.uuid(),
        status: z.enum(subscriptionStatuses),
        product_id: z.uuid(),
        customer_id: z.uuid(),
        current_period_start: polarDateTime,
        current_period_end: polarDateTime,
        cancel_at_period_end: z.boolean(),
        metadata: z.record(z.string(), z.unknown()),
      })
      .nullable(),
  }),
});

const orderRefundedEvent = orderPaidEvent.extend({
  type: z.literal("order.refunded"),
  data: orderPaidEvent.shape.data.extend({
    status: z.enum(["partially_refunded", "refunded"]),
    refunded_amount: z.number().int().positive(),
  }),
});

const billingConfigurationNames = [
  "POLAR_ACCESS_TOKEN",
  "POLAR_BASE_URL",
  "POLAR_ORGANIZATION_ID",
  "POLAR_PRO_PRODUCT_ID",
  "POLAR_CUSTOMER_OWNER_EMAIL",
  "POLAR_USAGE_METER_ID",
  "POLAR_USAGE_EVENT_NAME",
  "POLAR_WEBHOOK_SECRET",
  "BILLING_APP_ORIGIN",
] as const;

const requiredBinding = (bindings: Bindings, name: string) => {
  const value = bindings[name as keyof Bindings];
  if (typeof value !== "string" || !value.trim())
    throw new PolarBillingError("invalid_configuration", { field: name });
  return value.trim();
};

const isLoopbackHostname = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "[::1]" ||
  /^127(?:\.\d{1,3}){3}$/.test(hostname);

export const polarCheckoutCreationMayHaveSucceeded = (error: unknown) =>
  !(error instanceof PolarBillingError) ||
  error.code === "network_error" ||
  error.code === "server_error" ||
  error.code === "malformed_response";

export const polarCheckoutNotFound = (error: unknown) =>
  error instanceof PolarBillingError && error.code === "not_found";

const webhookVerifier = (bindings: Bindings) => {
  const secret = requiredBinding(bindings, "POLAR_WEBHOOK_SECRET");
  // Polar signs with the literal provider secret, not its decoded payload.
  return new Webhook(new TextEncoder().encode(secret), { format: "raw" });
};

const applicationOrigin = (bindings: Bindings) => {
  const value = requiredBinding(bindings, "BILLING_APP_ORIGIN");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PolarBillingError("invalid_configuration", {
      field: "BILLING_APP_ORIGIN",
    });
  }
  const validDeployedOrigin =
    bindings.SENTRY_ENVIRONMENT === "preview"
      ? /^humans-[a-z0-9]{9}-crafter-station\.vercel\.app$/i.test(url.hostname)
      : bindings.SENTRY_ENVIRONMENT === "production"
        ? url.hostname === "humans.crafter.run"
        : true;
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) ||
    ((bindings.SENTRY_ENVIRONMENT === "preview" ||
      bindings.SENTRY_ENVIRONMENT === "production") &&
      (url.protocol !== "https:" || url.port || !validDeployedOrigin))
  )
    throw new PolarBillingError("invalid_configuration", {
      field: "BILLING_APP_ORIGIN",
    });
  if (bindings.SENTRY_ENVIRONMENT === "preview") {
    let attestation: unknown;
    try {
      attestation = JSON.parse(
        requiredBinding(bindings, "BILLING_APP_ORIGIN_ATTESTATION"),
      );
    } catch {
      throw new PolarBillingError("invalid_configuration", {
        field: "BILLING_APP_ORIGIN_ATTESTATION",
      });
    }
    const key = requiredBinding(bindings, "BILLING_APP_ORIGIN_ATTESTATION_KEY");
    const now = Date.now();
    if (
      typeof attestation !== "object" ||
      attestation === null ||
      Array.isArray(attestation) ||
      Object.keys(attestation).sort().join(",") !==
        "deploymentCreatedAt,deploymentId,deploymentUrl,environment,expiresAt,issuedAt,projectId,release,signature,target" ||
      !("deploymentId" in attestation) ||
      typeof attestation.deploymentId !== "string" ||
      !/^dpl_[A-Za-z0-9]+$/.test(attestation.deploymentId) ||
      !("deploymentCreatedAt" in attestation) ||
      typeof attestation.deploymentCreatedAt !== "number" ||
      !Number.isSafeInteger(attestation.deploymentCreatedAt) ||
      !("deploymentUrl" in attestation) ||
      attestation.deploymentUrl !== url.origin ||
      !("environment" in attestation) ||
      attestation.environment !== "preview" ||
      !("expiresAt" in attestation) ||
      typeof attestation.expiresAt !== "number" ||
      !Number.isSafeInteger(attestation.expiresAt) ||
      !("issuedAt" in attestation) ||
      typeof attestation.issuedAt !== "number" ||
      !Number.isSafeInteger(attestation.issuedAt) ||
      !("projectId" in attestation) ||
      attestation.projectId !== "prj_1rRwDoknIk65eWIHIScwyuuHDthI" ||
      !("release" in attestation) ||
      attestation.release !== bindings.SENTRY_RELEASE ||
      !("signature" in attestation) ||
      typeof attestation.signature !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(attestation.signature) ||
      !("target" in attestation) ||
      attestation.target !== null ||
      !/^[A-Za-z0-9_-]{43}$/.test(key) ||
      attestation.issuedAt < attestation.deploymentCreatedAt ||
      attestation.issuedAt > now + 5 * 60_000 ||
      attestation.expiresAt <= attestation.issuedAt ||
      attestation.expiresAt - attestation.issuedAt > 7 * 24 * 60 * 60_000 ||
      attestation.expiresAt <= now
    )
      throw new PolarBillingError("invalid_configuration", {
        field: "BILLING_APP_ORIGIN_ATTESTATION",
      });
    const payload = JSON.stringify({
      deploymentCreatedAt: attestation.deploymentCreatedAt,
      deploymentId: attestation.deploymentId,
      deploymentUrl: attestation.deploymentUrl,
      environment: attestation.environment,
      expiresAt: attestation.expiresAt,
      issuedAt: attestation.issuedAt,
      projectId: attestation.projectId,
      release: attestation.release,
      target: attestation.target,
    });
    const expected = createHmac("sha256", key)
      .update(payload)
      .digest("base64url");
    if (
      !timingSafeEqual(
        Buffer.from(attestation.signature),
        Buffer.from(expected),
      )
    )
      throw new PolarBillingError("invalid_configuration", {
        field: "BILLING_APP_ORIGIN_ATTESTATION",
      });
  }
  return url.origin;
};

const billingClient = (bindings: Bindings, fetch?: typeof globalThis.fetch) => {
  const baseUrl = requiredBinding(bindings, "POLAR_BASE_URL");
  if (
    baseUrl !== POLAR_PRODUCTION_BASE_URL &&
    baseUrl !== POLAR_SANDBOX_BASE_URL
  )
    throw new PolarBillingError("invalid_configuration", {
      field: "POLAR_BASE_URL",
    });
  if (
    (bindings.SENTRY_ENVIRONMENT === "preview" &&
      baseUrl !== POLAR_SANDBOX_BASE_URL) ||
    (bindings.SENTRY_ENVIRONMENT === "production" &&
      baseUrl !== POLAR_PRODUCTION_BASE_URL)
  )
    throw new PolarBillingError("invalid_configuration", {
      field: "POLAR_BASE_URL",
    });
  const options = {
    accessToken: requiredBinding(bindings, "POLAR_ACCESS_TOKEN"),
    baseUrl,
    organizationId: requiredBinding(bindings, "POLAR_ORGANIZATION_ID"),
    proProductId: requiredBinding(bindings, "POLAR_PRO_PRODUCT_ID"),
    customerOwnerEmail: requiredBinding(bindings, "POLAR_CUSTOMER_OWNER_EMAIL"),
    usageMeterId: requiredBinding(bindings, "POLAR_USAGE_METER_ID"),
    usageEventName: requiredBinding(bindings, "POLAR_USAGE_EVENT_NAME"),
    successUrlAllowlist: [applicationOrigin(bindings)],
    ...(fetch ? { fetch } : {}),
  } satisfies CreatePolarBillingClientOptions;
  return createPolarBillingClient(options);
};

const mappedOrganizationId = (
  metadata: Record<string, unknown>,
  customer: z.infer<typeof customerMapping>,
  expectedCustomerId: string,
  bindings: Bindings,
) => {
  const organizationId = metadata.humansOrganizationId;
  if (
    typeof organizationId !== "string" ||
    organizationId !== customer.external_id ||
    customer.id !== expectedCustomerId ||
    customer.type !== "team" ||
    customer.organization_id !==
      requiredBinding(bindings, "POLAR_ORGANIZATION_ID")
  )
    throw new Error("Polar billing Customer mapping is invalid");
  return organizationId;
};

const validPeriod = (start: string, end: string) => {
  const periodStart = new Date(start);
  const periodEnd = new Date(end);
  if (periodStart.getTime() >= periodEnd.getTime())
    throw new Error("Polar subscription period is invalid");
  return { periodStart, periodEnd };
};

const isSubscriptionEventType = (
  value: string,
): value is (typeof subscriptionEventTypes)[number] =>
  subscriptionEventTypes.some((eventType) => eventType === value);

const isSubscriptionPaymentReason = (
  value: (typeof orderBillingReasons)[number],
): value is (typeof subscriptionPaymentReasons)[number] =>
  subscriptionPaymentReasons.some((reason) => reason === value);

const subscriptionOrderState = (
  event: z.infer<typeof orderPaidEvent> | z.infer<typeof orderRefundedEvent>,
  bindings: Bindings,
  billingReason: (typeof subscriptionPaymentReasons)[number],
) => {
  const subscription = event.data.subscription;
  if (subscription === null || event.data.subscription_id === null)
    throw new Error("Polar subscription Order mapping is invalid");
  if (
    event.data.subscription_id !== subscription.id ||
    event.data.customer_id !== subscription.customer_id ||
    (event.data.product_id !== null &&
      event.data.product_id !== subscription.product_id)
  )
    throw new Error("Polar subscription Order mapping is invalid");
  if (
    subscription.product_id !==
    requiredBinding(bindings, "POLAR_PRO_PRODUCT_ID")
  )
    return null;
  const organizationId = mappedOrganizationId(
    subscription.metadata,
    event.data.customer,
    event.data.customer_id,
    bindings,
  );
  return {
    occurredAt: new Date(event.timestamp),
    organizationId,
    polarCustomerId: event.data.customer_id,
    subscriptionId: subscription.id,
    status: subscription.status,
    ...validPeriod(
      subscription.current_period_start,
      subscription.current_period_end,
    ),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    order: {
      orderId: event.data.id,
      status: event.data.status,
      billingReason,
      currency: event.data.currency,
      totalAmount: event.data.total_amount,
      refundedAmount: event.data.refunded_amount,
      refundedTaxAmount: event.data.refunded_tax_amount,
    },
  };
};

const verifyBillingWebhook = async (
  request: Request,
  bindings: Bindings,
): Promise<PolarBillingEvent | null> => {
  const eventId = request.headers.get("webhook-id");
  if (!eventId) throw new Error("Polar webhook ID is missing");
  const verified = webhookVerifier(bindings).verify(
    await request.text(),
    Object.fromEntries(request.headers),
  );
  const envelope = z.object({ type: z.string() }).parse(verified);

  if (isSubscriptionEventType(envelope.type)) {
    const event = subscriptionEvent.parse(verified);
    if (
      event.data.product_id !==
      requiredBinding(bindings, "POLAR_PRO_PRODUCT_ID")
    )
      return null;
    const organizationId = mappedOrganizationId(
      event.data.metadata,
      event.data.customer,
      event.data.customer_id,
      bindings,
    );
    const period = validPeriod(
      event.data.current_period_start,
      event.data.current_period_end,
    );
    return {
      eventId,
      eventType: event.type,
      occurredAt: new Date(event.timestamp),
      organizationId,
      polarCustomerId: event.data.customer_id,
      subscriptionId: event.data.id,
      status: event.data.status,
      ...period,
      cancelAtPeriodEnd: event.data.cancel_at_period_end,
    };
  }

  if (envelope.type !== "order.paid" && envelope.type !== "order.refunded")
    return null;
  const event =
    envelope.type === "order.paid"
      ? orderPaidEvent.parse(verified)
      : orderRefundedEvent.parse(verified);
  const billingReason = event.data.billing_reason;
  if (!isSubscriptionPaymentReason(billingReason)) return null;
  const state = subscriptionOrderState(event, bindings, billingReason);
  if (state === null) return null;
  return event.type === "order.paid"
    ? {
        eventId,
        eventType: "order.paid",
        ...state,
        order: { ...state.order, status: "paid" },
      }
    : {
        eventId,
        eventType: "order.refunded",
        ...state,
        order: { ...state.order, status: event.data.status },
      };
};

export const createPolarBoundary = (
  fetch?: typeof globalThis.fetch,
): PolarBoundary => ({
  billingConfigured(bindings) {
    if (bindings === undefined) return false;
    const configured = billingConfigurationNames.filter((name) => {
      const value = bindings[name];
      return typeof value === "string" && value.trim() !== "";
    });
    if (configured.length === 0) return false;
    if (configured.length !== billingConfigurationNames.length) {
      const missing = billingConfigurationNames.find(
        (name) => !configured.includes(name),
      );
      throw new PolarBillingError("invalid_configuration", { field: missing });
    }
    billingClient(bindings, fetch);
    webhookVerifier(bindings);
    return true;
  },

  ensureCustomer(input, bindings) {
    return billingClient(bindings, fetch).ensureCustomer(input);
  },

  findOpenProCheckout(organizationId, bindings) {
    const origin = applicationOrigin(bindings);
    return billingClient(bindings, fetch).findOpenProCheckout({
      clerkOrganizationId: organizationId,
      successUrl: `${origin}/workspace?billing=success`,
    });
  },

  findProCheckoutByClaim(claimId, organizationId, bindings) {
    const origin = applicationOrigin(bindings);
    return billingClient(bindings, fetch).findProCheckoutByClaim({
      checkoutClaimId: claimId,
      clerkOrganizationId: organizationId,
      successUrl: `${origin}/workspace?billing=success`,
    });
  },

  getProCheckout(checkoutId, organizationId, bindings) {
    const origin = applicationOrigin(bindings);
    return billingClient(bindings, fetch).getProCheckout({
      checkoutId,
      clerkOrganizationId: organizationId,
      successUrl: `${origin}/workspace?billing=success`,
    });
  },

  createProCheckout(organizationId, claimId, bindings) {
    const origin = applicationOrigin(bindings);
    return billingClient(bindings, fetch).createProCheckout({
      checkoutClaimId: claimId,
      clerkOrganizationId: organizationId,
      successUrl: `${origin}/workspace?billing=success`,
    });
  },

  createCustomerPortalSession(organizationId, bindings) {
    const origin = applicationOrigin(bindings);
    return billingClient(bindings, fetch).createCustomerPortalSession({
      clerkOrganizationId: organizationId,
      returnUrl: `${origin}/workspace`,
    });
  },

  getCustomerState(organizationId, bindings) {
    return billingClient(bindings, fetch).getCustomerState(organizationId);
  },

  getMeterQuantities(input, bindings) {
    return billingClient(bindings, fetch).getMeterQuantities(input);
  },

  async verifySubscriptionWebhook(request, bindings) {
    const event = await verifyBillingWebhook(request, bindings);
    return event?.eventType === "order.paid" ||
      event?.eventType === "order.refunded"
      ? null
      : event;
  },

  verifyBillingWebhook(request, bindings) {
    return verifyBillingWebhook(request, bindings);
  },
});

export const polarBoundary = createPolarBoundary();
