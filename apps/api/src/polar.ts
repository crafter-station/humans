import {
  type CreatePolarBillingClientOptions,
  createPolarBillingClient,
  type EnsurePolarCustomerInput,
  type GetMeterQuantitiesInput,
  POLAR_PRODUCTION_BASE_URL,
  POLAR_SANDBOX_BASE_URL,
  PolarBillingError,
  type PolarCheckoutSession,
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
  orderId: string;
  billingReason: (typeof subscriptionPaymentReasons)[number];
};

export type PolarBillingEvent =
  | PolarSubscriptionEvent
  | PolarSubscriptionPaymentEvent;

const polarDateTime = z.iso.datetime({ offset: true });

export type PolarBoundary = {
  billingConfigured(bindings: Bindings | undefined): boolean;
  ensureCustomer(
    input: EnsurePolarCustomerInput,
    bindings: Bindings,
  ): Promise<PolarCustomer>;
  createProCheckout(
    organizationId: string,
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

const billingConfigurationNames = [
  "POLAR_ACCESS_TOKEN",
  "POLAR_BASE_URL",
  "POLAR_ORGANIZATION_ID",
  "POLAR_PRO_PRODUCT_ID",
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
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new PolarBillingError("invalid_configuration", {
      field: "BILLING_APP_ORIGIN",
    });
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
  const options = {
    accessToken: requiredBinding(bindings, "POLAR_ACCESS_TOKEN"),
    baseUrl,
    organizationId: requiredBinding(bindings, "POLAR_ORGANIZATION_ID"),
    proProductId: requiredBinding(bindings, "POLAR_PRO_PRODUCT_ID"),
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

  if (envelope.type !== "order.paid") return null;
  const event = orderPaidEvent.parse(verified);
  if (!isSubscriptionPaymentReason(event.data.billing_reason)) return null;
  const subscription = event.data.subscription;
  if (subscription === null || event.data.subscription_id === null)
    throw new Error("Polar paid subscription Order mapping is invalid");
  if (
    event.data.subscription_id !== subscription.id ||
    event.data.customer_id !== subscription.customer_id ||
    (event.data.product_id !== null &&
      event.data.product_id !== subscription.product_id)
  )
    throw new Error("Polar paid subscription Order mapping is invalid");
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
  const period = validPeriod(
    subscription.current_period_start,
    subscription.current_period_end,
  );
  return {
    eventId,
    eventType: event.type,
    occurredAt: new Date(event.timestamp),
    organizationId,
    polarCustomerId: event.data.customer_id,
    subscriptionId: subscription.id,
    status: subscription.status,
    ...period,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    orderId: event.data.id,
    billingReason: event.data.billing_reason,
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

  createProCheckout(organizationId, bindings) {
    const origin = applicationOrigin(bindings);
    return billingClient(bindings, fetch).createProCheckout({
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
    return event?.eventType === "order.paid" ? null : event;
  },

  verifyBillingWebhook(request, bindings) {
    return verifyBillingWebhook(request, bindings);
  },
});

export const polarBoundary = createPolarBoundary();
