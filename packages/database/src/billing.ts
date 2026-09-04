import { Pool } from "@neondatabase/serverless";
import {
  and,
  asc,
  count,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";

import {
  confirmPaidCreditPeriodInTransaction,
  rolloverCreditPeriodInTransaction,
} from "./credits";
import * as schema from "./schema";
import {
  creditAccounts,
  creditReconciliations,
  creditUsageOutbox,
  memberFreeCreditClaims,
  members,
  organizationEntitlements,
  organizationMemberships,
  organizations,
  polarCustomers,
  polarWebhookEvents,
} from "./schema";
import type { DrizzleDatabase, Transaction } from "./service/types";

export const CREDIT_USAGE_DELIVERY_MAX_ATTEMPTS = 8;
export type BillingDatabase = DrizzleDatabase;

export type PolarSubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

export type PolarOrderProjection = {
  orderId: string;
  status: "paid" | "partially_refunded" | "refunded";
  billingReason:
    | "subscription_create"
    | "subscription_cycle"
    | "subscription_update"
    | "subscription_meter_cycle";
  currency: string;
  totalAmount: number;
  refundedAmount: number;
  refundedTaxAmount: number;
};

export type PolarSubscriptionProjection = {
  eventId: string;
  eventType: string;
  occurredAt: Date;
  organizationId: string;
  polarCustomerId: string;
  polarSubscriptionId: string;
  status: PolarSubscriptionStatus;
  periodStart: Date;
  periodEnd: Date;
  cancelAtPeriodEnd: boolean;
  order?: PolarOrderProjection;
  now?: Date;
};

export type PolarOrderRefundProjection = {
  eventId: string;
  eventType: "order.refunded";
  occurredAt: Date;
  organizationId: string;
  polarCustomerId: string;
  polarSubscriptionId: string;
  order: PolarOrderProjection;
  now?: Date;
};

export type CreditUsageDelivery = {
  id: string;
  idempotencyKey: string;
  organizationId: string;
  occurredAt: Date;
  attempts: number;
};

export type CreditReconciliationTarget = {
  organizationId: string;
  startAt: Date;
  endAt: Date;
};

export type CreditMeterReader = (
  target: CreditReconciliationTarget,
) => Promise<number>;

export class BillingStoreError extends Error {
  constructor(
    readonly code:
      | "billing_checkout_claim_lost"
      | "billing_customer_conflict"
      | "billing_event_conflict"
      | "billing_identity_unavailable"
      | "billing_order_conflict"
      | "billing_period_unavailable"
      | "billing_subscription_conflict"
      | "invalid_billing_input"
      | "usage_lease_lost",
  ) {
    super(code);
    this.name = "BillingStoreError";
  }
}

type QueryableDatabase = DrizzleDatabase | Transaction;

const validDate = (value: Date) => !Number.isNaN(value.getTime());

const validatePolarOrder = (order: PolarOrderProjection) => {
  if (
    !order.orderId.trim() ||
    !/^[a-z]{3}$/.test(order.currency) ||
    !Number.isSafeInteger(order.totalAmount) ||
    order.totalAmount < 0 ||
    !Number.isSafeInteger(order.refundedAmount) ||
    order.refundedAmount < 0 ||
    !Number.isSafeInteger(order.refundedTaxAmount) ||
    order.refundedTaxAmount < 0
  )
    throw new BillingStoreError("invalid_billing_input");
};

const polarOrderValues = (order: PolarOrderProjection) => ({
  orderId: order.orderId,
  orderStatus: order.status,
  orderBillingReason: order.billingReason,
  orderCurrency: order.currency,
  orderTotalAmount: order.totalAmount,
  orderRefundedAmount: order.refundedAmount,
  orderRefundedTaxAmount: order.refundedTaxAmount,
});

const validatePeriod = (startAt: Date, endAt: Date) => {
  if (
    !validDate(startAt) ||
    !validDate(endAt) ||
    startAt.getTime() >= endAt.getTime()
  )
    throw new BillingStoreError("invalid_billing_input");
};

const lockBillingMappings = async (
  database: QueryableDatabase,
  keys: readonly string[],
) => {
  for (const key of [...new Set(keys)].sort())
    await database.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`billing:${key}`}))`,
    );
};

const recordPolarCustomerInTransaction = async (
  database: QueryableDatabase,
  input: { organizationId: string; polarCustomerId: string },
) => {
  if (!input.organizationId.trim() || !input.polarCustomerId.trim())
    throw new BillingStoreError("invalid_billing_input");
  await database.insert(polarCustomers).values(input).onConflictDoNothing();
  const [organizationMapping] = await database
    .select()
    .from(polarCustomers)
    .where(eq(polarCustomers.organizationId, input.organizationId))
    .limit(1);
  const [customerMapping] = await database
    .select()
    .from(polarCustomers)
    .where(eq(polarCustomers.polarCustomerId, input.polarCustomerId))
    .limit(1);
  if (
    organizationMapping?.polarCustomerId !== input.polarCustomerId ||
    customerMapping?.organizationId !== input.organizationId
  )
    throw new BillingStoreError("billing_customer_conflict");
  return organizationMapping;
};

export const recordPolarCustomer = (
  database: DrizzleDatabase,
  input: { organizationId: string; polarCustomerId: string },
) =>
  database.transaction(async (tx) => {
    await lockBillingMappings(tx, [
      `customer:${input.polarCustomerId}`,
      `organization:${input.organizationId}`,
    ]);
    return recordPolarCustomerInTransaction(tx, input);
  });

export const getBillingCustomerSeed = async (
  database: DrizzleDatabase,
  input: { memberId: string; organizationId: string },
) => {
  const [identity] = await database
    .select({ name: organizations.name })
    .from(organizationMemberships)
    .innerJoin(members, eq(members.clerkId, organizationMemberships.memberId))
    .innerJoin(
      organizations,
      eq(organizations.clerkId, organizationMemberships.organizationId),
    )
    .where(
      and(
        eq(organizationMemberships.memberId, input.memberId),
        eq(organizationMemberships.organizationId, input.organizationId),
        eq(organizationMemberships.active, true),
        inArray(organizationMemberships.role, ["admin", "org:admin"]),
        eq(members.active, true),
        eq(organizations.active, true),
      ),
    )
    .limit(1);
  if (!identity?.name.trim())
    throw new BillingStoreError("billing_identity_unavailable");
  return identity;
};

const checkoutClaimLeaseMilliseconds = 5 * 60_000;
const checkoutReconciliationQuarantineMilliseconds =
  checkoutClaimLeaseMilliseconds;

export const claimPolarCheckout = (
  database: DrizzleDatabase,
  input: { organizationId: string; now?: Date },
) =>
  database.transaction(async (tx) => {
    const now = input.now ?? new Date();
    if (!input.organizationId.trim() || !validDate(now))
      throw new BillingStoreError("invalid_billing_input");
    await lockBillingMappings(tx, [`organization:${input.organizationId}`]);
    const [customer] = await tx
      .select()
      .from(polarCustomers)
      .where(eq(polarCustomers.organizationId, input.organizationId))
      .limit(1)
      .for("update");
    if (!customer) throw new BillingStoreError("billing_identity_unavailable");

    if (
      customer.checkoutClaimId &&
      customer.checkoutId &&
      customer.checkoutUrl &&
      customer.checkoutExpiresAt &&
      customer.checkoutExpiresAt.getTime() > now.getTime()
    ) {
      return {
        state: "open" as const,
        claimId: customer.checkoutClaimId,
        checkout: {
          id: customer.checkoutId,
          url: customer.checkoutUrl,
          expiresAt: customer.checkoutExpiresAt,
        },
      };
    }
    if (customer.checkoutClaimId && customer.checkoutClaimExpiresAt === null)
      return {
        state: "reconcile" as const,
        claimId: customer.checkoutClaimId,
        checkoutId: customer.checkoutId,
      };
    if (
      customer.checkoutClaimId &&
      customer.checkoutClaimExpiresAt &&
      customer.checkoutClaimExpiresAt.getTime() > now.getTime()
    )
      return { state: "pending" as const };

    const claimId = crypto.randomUUID();
    await tx
      .update(polarCustomers)
      .set({
        checkoutClaimId: claimId,
        checkoutClaimExpiresAt: new Date(
          now.getTime() + checkoutClaimLeaseMilliseconds,
        ),
        checkoutId: null,
        checkoutUrl: null,
        checkoutExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(polarCustomers.organizationId, input.organizationId));
    return { state: "claimed" as const, claimId };
  });

export const beginPolarCheckoutCreation = async (
  database: DrizzleDatabase,
  input: { organizationId: string; claimId: string; now?: Date },
) => {
  const now = input.now ?? new Date();
  if (!input.organizationId.trim() || !input.claimId.trim() || !validDate(now))
    throw new BillingStoreError("invalid_billing_input");
  const [started] = await database
    .update(polarCustomers)
    .set({
      // Null makes a started claim sticky because Polar may have received the POST.
      checkoutClaimExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(polarCustomers.organizationId, input.organizationId),
        eq(polarCustomers.checkoutClaimId, input.claimId),
        gt(polarCustomers.checkoutClaimExpiresAt, now),
      ),
    )
    .returning({ organizationId: polarCustomers.organizationId });
  return started !== undefined;
};

export const completePolarCheckout = (
  database: DrizzleDatabase,
  input: {
    organizationId: string;
    claimId: string;
    checkout: { id: string; url: string; expiresAt: Date };
    now?: Date;
  },
) =>
  database.transaction(async (tx) => {
    const now = input.now ?? new Date();
    if (
      !input.organizationId.trim() ||
      !input.claimId.trim() ||
      !input.checkout.id.trim() ||
      !input.checkout.url.trim() ||
      !validDate(input.checkout.expiresAt) ||
      !validDate(now)
    )
      throw new BillingStoreError("invalid_billing_input");
    await lockBillingMappings(tx, [`organization:${input.organizationId}`]);
    const [completed] = await tx
      .update(polarCustomers)
      .set({
        checkoutClaimId: input.claimId,
        checkoutClaimExpiresAt: null,
        checkoutId: input.checkout.id,
        checkoutUrl: input.checkout.url,
        checkoutExpiresAt: input.checkout.expiresAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(polarCustomers.organizationId, input.organizationId),
          eq(polarCustomers.checkoutClaimId, input.claimId),
        ),
      )
      .returning({ organizationId: polarCustomers.organizationId });
    if (!completed) throw new BillingStoreError("billing_checkout_claim_lost");
    return input.checkout;
  });

export const clearPolarCheckoutClaim = async (
  database: DrizzleDatabase,
  input: {
    organizationId: string;
    claimId: string;
    checkoutId?: string | null;
    now?: Date;
  },
) => {
  const now = input.now ?? new Date();
  if (
    !input.organizationId.trim() ||
    !input.claimId.trim() ||
    (input.checkoutId !== undefined &&
      input.checkoutId !== null &&
      !input.checkoutId.trim()) ||
    !validDate(now)
  )
    throw new BillingStoreError("invalid_billing_input");
  const [cleared] = await database
    .update(polarCustomers)
    .set({
      checkoutClaimId: null,
      checkoutClaimExpiresAt: null,
      checkoutId: null,
      checkoutUrl: null,
      checkoutExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(polarCustomers.organizationId, input.organizationId),
        eq(polarCustomers.checkoutClaimId, input.claimId),
        ...(input.checkoutId === undefined
          ? []
          : [
              input.checkoutId === null
                ? isNull(polarCustomers.checkoutId)
                : eq(polarCustomers.checkoutId, input.checkoutId),
            ]),
      ),
    )
    .returning({ organizationId: polarCustomers.organizationId });
  return cleared !== undefined;
};

export const releaseExpiredPolarCheckoutReconciliation = async (
  database: DrizzleDatabase,
  input: { organizationId: string; claimId: string; now?: Date },
) => {
  const now = input.now ?? new Date();
  if (!input.organizationId.trim() || !input.claimId.trim() || !validDate(now))
    throw new BillingStoreError("invalid_billing_input");
  const [released] = await database
    .update(polarCustomers)
    .set({
      checkoutClaimId: null,
      checkoutClaimExpiresAt: null,
      checkoutId: null,
      checkoutUrl: null,
      checkoutExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(polarCustomers.organizationId, input.organizationId),
        eq(polarCustomers.checkoutClaimId, input.claimId),
        isNull(polarCustomers.checkoutClaimExpiresAt),
        isNull(polarCustomers.checkoutId),
        lte(
          polarCustomers.updatedAt,
          new Date(
            now.getTime() - checkoutReconciliationQuarantineMilliseconds,
          ),
        ),
      ),
    )
    .returning({ organizationId: polarCustomers.organizationId });
  return released !== undefined;
};

export const releasePolarCheckoutLease = async (
  database: DrizzleDatabase,
  input: { organizationId: string; claimId: string; now?: Date },
) => {
  const now = input.now ?? new Date();
  if (!input.organizationId.trim() || !input.claimId.trim() || !validDate(now))
    throw new BillingStoreError("invalid_billing_input");
  const [released] = await database
    .update(polarCustomers)
    .set({
      checkoutClaimId: null,
      checkoutClaimExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(polarCustomers.organizationId, input.organizationId),
        eq(polarCustomers.checkoutClaimId, input.claimId),
        isNotNull(polarCustomers.checkoutClaimExpiresAt),
      ),
    )
    .returning({ organizationId: polarCustomers.organizationId });
  return released !== undefined;
};

export const getOrganizationBillingOverview = (
  database: DrizzleDatabase,
  organizationId: string,
  now = new Date(),
) =>
  database.transaction(async (tx) => {
    const entitlement = await rolloverCreditPeriodInTransaction(
      tx,
      organizationId,
      now,
    );
    if (!entitlement) throw new BillingStoreError("billing_period_unavailable");
    const [account] = await tx
      .select({ balance: creditAccounts.balance })
      .from(creditAccounts)
      .where(eq(creditAccounts.organizationId, organizationId))
      .limit(1);
    return {
      plan: entitlement.tier === "pro" ? ("pro" as const) : ("free" as const),
      availableCredits: account?.balance ?? 0,
      status:
        entitlement.tier === "pro" &&
        entitlement.status === "active" &&
        entitlement.polarStatus
          ? entitlement.polarStatus
          : entitlement.status,
      chargeable: entitlement.status === "active",
      renewalBoundary: entitlement.periodEnd,
      cancelAtPeriodEnd: entitlement.cancelAtPeriodEnd,
    };
  });

const polarStatusPriority: Record<PolarSubscriptionStatus, number> = {
  incomplete: 1,
  active: 2,
  trialing: 2,
  past_due: 3,
  incomplete_expired: 4,
  canceled: 4,
  unpaid: 4,
  paused: 4,
};

const terminalPolarStatus = (status: PolarSubscriptionStatus | null) =>
  status === "incomplete_expired" ||
  status === "canceled" ||
  status === "unpaid" ||
  status === "paused";

const schedulesFreeDowngrade = (
  status: PolarSubscriptionStatus,
  cancelAtPeriodEnd: boolean,
  eventType: string,
) =>
  cancelAtPeriodEnd ||
  eventType === "subscription.revoked" ||
  status === "past_due" ||
  status === "canceled" ||
  status === "unpaid" ||
  status === "paused" ||
  status === "incomplete_expired";

const shouldProjectPolarState = (
  current: typeof organizationEntitlements.$inferSelect | undefined,
  currentEventType: string | null,
  input: PolarSubscriptionProjection,
) => {
  if (
    current?.tier === "free" &&
    current.status === "active" &&
    current.periodStart !== null &&
    current.periodStart.getTime() >= input.periodEnd.getTime()
  )
    return false;
  if (!current?.polarEventAt) return true;
  const ordering = input.occurredAt.getTime() - current.polarEventAt.getTime();
  if (ordering !== 0) return ordering > 0;
  if (input.eventType === "subscription.revoked") return true;
  if (currentEventType === "subscription.revoked") return false;
  const currentStatus = current.polarStatus as PolarSubscriptionStatus | null;
  const incomingTerminal = terminalPolarStatus(input.status);
  const currentTerminal = terminalPolarStatus(currentStatus);
  if (incomingTerminal !== currentTerminal) return incomingTerminal;
  if (input.cancelAtPeriodEnd !== current.cancelAtPeriodEnd)
    return input.cancelAtPeriodEnd;
  if (input.eventType === "order.paid") return true;
  if (currentEventType === "order.paid") return false;
  return (
    currentStatus === null ||
    polarStatusPriority[input.status] >
      (polarStatusPriority[currentStatus] ?? 0)
  );
};

const assertPolarSubscriptionMapping = async (
  tx: Transaction,
  input: Pick<
    PolarSubscriptionProjection,
    "organizationId" | "polarSubscriptionId"
  >,
) => {
  const [[entitlementMapping], [eventMapping]] = await Promise.all([
    tx
      .select({ organizationId: organizationEntitlements.organizationId })
      .from(organizationEntitlements)
      .where(
        eq(
          organizationEntitlements.polarSubscriptionId,
          input.polarSubscriptionId,
        ),
      )
      .limit(1),
    tx
      .select({ organizationId: polarWebhookEvents.organizationId })
      .from(polarWebhookEvents)
      .where(
        and(
          eq(polarWebhookEvents.subscriptionId, input.polarSubscriptionId),
          isNotNull(polarWebhookEvents.organizationId),
          ne(polarWebhookEvents.organizationId, input.organizationId),
        ),
      )
      .limit(1),
  ]);
  if (
    entitlementMapping?.organizationId !== undefined &&
    entitlementMapping.organizationId !== input.organizationId
  )
    throw new BillingStoreError("billing_subscription_conflict");
  if (eventMapping)
    throw new BillingStoreError("billing_subscription_conflict");
};

const assertPolarOrderMapping = async (
  tx: Transaction,
  input: Pick<
    PolarOrderRefundProjection,
    "organizationId" | "polarSubscriptionId" | "order"
  >,
) => {
  const [mapping] = await tx
    .select({
      organizationId: polarWebhookEvents.organizationId,
      subscriptionId: polarWebhookEvents.subscriptionId,
    })
    .from(polarWebhookEvents)
    .where(eq(polarWebhookEvents.orderId, input.order.orderId))
    .limit(1);
  if (
    mapping &&
    (mapping.organizationId !== input.organizationId ||
      mapping.subscriptionId !== input.polarSubscriptionId)
  )
    throw new BillingStoreError("billing_order_conflict");
};

const assertOrderReplay = (
  event: typeof polarWebhookEvents.$inferSelect,
  order: PolarOrderProjection,
) => {
  if (
    event.orderId !== order.orderId ||
    event.orderStatus !== order.status ||
    event.orderBillingReason !== order.billingReason ||
    event.orderCurrency !== order.currency ||
    event.orderTotalAmount !== order.totalAmount ||
    event.orderRefundedAmount !== order.refundedAmount ||
    event.orderRefundedTaxAmount !== order.refundedTaxAmount
  )
    throw new BillingStoreError("billing_event_conflict");
};

const hasEmptyOrderAudit = (event: typeof polarWebhookEvents.$inferSelect) =>
  event.orderId === null &&
  event.orderStatus === null &&
  event.orderBillingReason === null &&
  event.orderCurrency === null &&
  event.orderTotalAmount === null &&
  event.orderRefundedAmount === null &&
  event.orderRefundedTaxAmount === null;

const assertExactWebhookIdentityReplay = (
  event: typeof polarWebhookEvents.$inferSelect,
  input: PolarSubscriptionProjection,
) => {
  if (
    event.organizationId !== input.organizationId ||
    event.subscriptionId !== input.polarSubscriptionId ||
    event.eventType !== input.eventType ||
    event.status !== input.status ||
    event.occurredAt?.getTime() !== input.occurredAt.getTime()
  )
    throw new BillingStoreError("billing_event_conflict");
};

const hydrateLegacyOrderAudit = async (
  tx: Transaction,
  event: typeof polarWebhookEvents.$inferSelect,
  input: PolarSubscriptionProjection & { order: PolarOrderProjection },
) => {
  assertExactWebhookIdentityReplay(event, input);
  const [hydrated] = await tx
    .update(polarWebhookEvents)
    .set(polarOrderValues(input.order))
    .where(
      and(
        eq(polarWebhookEvents.id, input.eventId),
        eq(polarWebhookEvents.organizationId, input.organizationId),
        eq(polarWebhookEvents.subscriptionId, input.polarSubscriptionId),
        eq(polarWebhookEvents.eventType, input.eventType),
        eq(polarWebhookEvents.status, input.status),
        eq(polarWebhookEvents.occurredAt, input.occurredAt),
        isNull(polarWebhookEvents.orderId),
        isNull(polarWebhookEvents.orderStatus),
        isNull(polarWebhookEvents.orderBillingReason),
        isNull(polarWebhookEvents.orderCurrency),
        isNull(polarWebhookEvents.orderTotalAmount),
        isNull(polarWebhookEvents.orderRefundedAmount),
        isNull(polarWebhookEvents.orderRefundedTaxAmount),
      ),
    )
    .returning();
  if (hydrated) return hydrated;
  const [concurrentReplay] = await tx
    .select()
    .from(polarWebhookEvents)
    .where(eq(polarWebhookEvents.id, input.eventId))
    .limit(1);
  if (!concurrentReplay) throw new Error("polar_webhook_event_not_found");
  return concurrentReplay;
};

const assertWebhookReplay = (
  event: typeof polarWebhookEvents.$inferSelect,
  input: PolarSubscriptionProjection,
) => {
  if (
    (event.organizationId !== null &&
      event.organizationId !== input.organizationId) ||
    (event.subscriptionId !== null &&
      event.subscriptionId !== input.polarSubscriptionId) ||
    (event.eventType !== null && event.eventType !== input.eventType) ||
    (event.status !== null && event.status !== input.status) ||
    (event.occurredAt !== null &&
      event.occurredAt.getTime() !== input.occurredAt.getTime())
  )
    throw new BillingStoreError("billing_event_conflict");
  if (input.eventType === "order.paid" && input.order)
    assertOrderReplay(event, input.order);
};

export const projectPolarSubscriptionEvent = (
  database: DrizzleDatabase,
  input: PolarSubscriptionProjection,
) =>
  database.transaction(async (tx) => {
    validatePeriod(input.periodStart, input.periodEnd);
    if (
      !validDate(input.occurredAt) ||
      !input.eventId.trim() ||
      !input.eventType.trim() ||
      !input.organizationId.trim() ||
      !input.polarCustomerId.trim() ||
      !input.polarSubscriptionId.trim()
    )
      throw new BillingStoreError("invalid_billing_input");
    if (input.eventType === "order.paid") {
      if (input.order?.status !== "paid")
        throw new BillingStoreError("invalid_billing_input");
      validatePolarOrder(input.order);
    } else if (input.order !== undefined) {
      throw new BillingStoreError("invalid_billing_input");
    }
    const now = input.now ?? new Date();
    if (!validDate(now)) throw new BillingStoreError("invalid_billing_input");
    await lockBillingMappings(tx, [
      `customer:${input.polarCustomerId}`,
      `organization:${input.organizationId}`,
      `subscription:${input.polarSubscriptionId}`,
      ...(input.order ? [`order:${input.order.orderId}`] : []),
    ]);
    await recordPolarCustomerInTransaction(tx, {
      organizationId: input.organizationId,
      polarCustomerId: input.polarCustomerId,
    });
    await assertPolarSubscriptionMapping(tx, input);
    if (input.order)
      await assertPolarOrderMapping(tx, {
        organizationId: input.organizationId,
        polarSubscriptionId: input.polarSubscriptionId,
        order: input.order,
      });
    const [event] = await tx
      .insert(polarWebhookEvents)
      .values({
        id: input.eventId,
        organizationId: input.organizationId,
        subscriptionId: input.polarSubscriptionId,
        eventType: input.eventType,
        status: input.status,
        ...(input.order ? polarOrderValues(input.order) : {}),
        occurredAt: input.occurredAt,
      })
      .onConflictDoNothing()
      .returning();
    if (!event) {
      const [existing] = await tx
        .select()
        .from(polarWebhookEvents)
        .where(eq(polarWebhookEvents.id, input.eventId))
        .limit(1);
      if (!existing) throw new Error("polar_webhook_event_not_found");
      const replay =
        input.eventType === "order.paid" &&
        input.order !== undefined &&
        hasEmptyOrderAudit(existing)
          ? await hydrateLegacyOrderAudit(tx, existing, {
              ...input,
              order: input.order,
            })
          : existing;
      assertWebhookReplay(replay, input);
      return { processed: false, applied: replay.applied };
    }

    const [current] = await tx
      .select()
      .from(organizationEntitlements)
      .where(eq(organizationEntitlements.organizationId, input.organizationId))
      .limit(1);
    const [currentEvent] = current?.polarEventId
      ? await tx
          .select({ eventType: polarWebhookEvents.eventType })
          .from(polarWebhookEvents)
          .where(eq(polarWebhookEvents.id, current.polarEventId))
          .limit(1)
      : [];
    const projectsState = shouldProjectPolarState(
      current,
      currentEvent?.eventType ?? null,
      input,
    );
    if (projectsState) {
      const [freeClaim] = await tx
        .select({ memberId: memberFreeCreditClaims.memberId })
        .from(memberFreeCreditClaims)
        .where(eq(memberFreeCreditClaims.organizationId, input.organizationId))
        .limit(1);
      const pendingFreeAtPeriodEnd =
        freeClaim !== undefined &&
        schedulesFreeDowngrade(
          input.status,
          input.cancelAtPeriodEnd,
          input.eventType,
        );
      await tx
        .insert(organizationEntitlements)
        .values({
          organizationId: input.organizationId,
          tier: "pro",
          status:
            input.eventType !== "subscription.revoked" &&
            (input.status === "active" || input.status === "trialing")
              ? "payment_pending"
              : "blocked",
          polarSubscriptionId: input.polarSubscriptionId,
          polarStatus: input.status,
          polarEventId: input.eventId,
          polarEventAt: input.occurredAt,
          cancelAtPeriodEnd: input.cancelAtPeriodEnd,
          pendingFreeAtPeriodEnd,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: organizationEntitlements.organizationId,
          set: {
            tier: "pro",
            status:
              input.eventType !== "subscription.revoked" &&
              (input.status === "active" || input.status === "trialing")
                ? "payment_pending"
                : "blocked",
            polarSubscriptionId: input.polarSubscriptionId,
            polarStatus: input.status,
            polarEventId: input.eventId,
            polarEventAt: input.occurredAt,
            cancelAtPeriodEnd: input.cancelAtPeriodEnd,
            pendingFreeAtPeriodEnd,
            updatedAt: now,
          },
        });
    }

    let paymentApplied = false;
    if (
      input.eventType === "order.paid" &&
      input.periodEnd.getTime() > now.getTime()
    ) {
      const [latest] = await tx
        .select()
        .from(organizationEntitlements)
        .where(
          eq(organizationEntitlements.organizationId, input.organizationId),
        )
        .limit(1);
      const supersededSubscription =
        latest !== undefined &&
        latest.polarSubscriptionId !== null &&
        latest.polarSubscriptionId !== input.polarSubscriptionId &&
        latest.polarEventAt !== null &&
        latest.polarEventAt.getTime() > input.occurredAt.getTime();
      const supersededPeriod =
        latest !== undefined &&
        latest.periodStart !== null &&
        latest.periodStart.getTime() > input.periodStart.getTime();
      if (!supersededSubscription && !supersededPeriod) {
        await confirmPaidCreditPeriodInTransaction(tx, {
          organizationId: input.organizationId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          actor: { type: "polar", id: input.eventId },
          operation: "billing.pro.paid-period",
        });
        paymentApplied = true;
      }
    }

    await rolloverCreditPeriodInTransaction(tx, input.organizationId, now);
    const applied = projectsState || paymentApplied;
    if (applied)
      await tx
        .update(polarWebhookEvents)
        .set({ applied: true })
        .where(eq(polarWebhookEvents.id, input.eventId));
    return { processed: true, applied };
  });

/** Records refunds for audit without changing Credits or subscription access. */
export const recordPolarOrderRefund = (
  database: DrizzleDatabase,
  input: PolarOrderRefundProjection,
) =>
  database.transaction(async (tx) => {
    const now = input.now ?? new Date();
    if (
      !input.eventId.trim() ||
      !validDate(input.occurredAt) ||
      !validDate(now) ||
      !input.organizationId.trim() ||
      !input.polarCustomerId.trim() ||
      !input.polarSubscriptionId.trim() ||
      input.order.status === "paid" ||
      input.order.refundedAmount < 1
    )
      throw new BillingStoreError("invalid_billing_input");
    validatePolarOrder(input.order);
    await lockBillingMappings(tx, [
      `customer:${input.polarCustomerId}`,
      `order:${input.order.orderId}`,
      `organization:${input.organizationId}`,
      `subscription:${input.polarSubscriptionId}`,
    ]);
    await recordPolarCustomerInTransaction(tx, {
      organizationId: input.organizationId,
      polarCustomerId: input.polarCustomerId,
    });
    await assertPolarSubscriptionMapping(tx, input);
    await assertPolarOrderMapping(tx, input);

    const [event] = await tx
      .insert(polarWebhookEvents)
      .values({
        id: input.eventId,
        organizationId: input.organizationId,
        subscriptionId: input.polarSubscriptionId,
        eventType: input.eventType,
        occurredAt: input.occurredAt,
        processedAt: now,
        ...polarOrderValues(input.order),
      })
      .onConflictDoNothing()
      .returning();
    if (event) return { processed: true, applied: false };

    const [existing] = await tx
      .select()
      .from(polarWebhookEvents)
      .where(eq(polarWebhookEvents.id, input.eventId))
      .limit(1);
    if (!existing) throw new Error("polar_webhook_event_not_found");
    if (
      existing.organizationId !== input.organizationId ||
      existing.subscriptionId !== input.polarSubscriptionId ||
      existing.eventType !== input.eventType ||
      existing.occurredAt?.getTime() !== input.occurredAt.getTime()
    )
      throw new BillingStoreError("billing_event_conflict");
    assertOrderReplay(existing, input.order);
    return { processed: false, applied: false };
  });

/** Materializes usage missing from the pre-release consumption ledger. */
export const backfillFinalizedCreditUsage = async (
  database: QueryableDatabase,
  limit = 100,
) => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
    throw new BillingStoreError("invalid_billing_input");
  await database.execute(sql`
    with missing_consumptions as (
      select
        consumption.id,
        consumption.organization_id,
        consumption.idempotency_key,
        consumption.created_at,
        reservation.amount
      from credit_ledger_entries consumption
      join credit_ledger_entries reservation
        on reservation.organization_id = consumption.organization_id
       and reservation.reference_id is not distinct from consumption.reference_id
       and reservation.kind = 'reservation'
       and (
         consumption.idempotency_key = reservation.idempotency_key || ':consumption'
         or consumption.idempotency_key = regexp_replace(
           reservation.idempotency_key,
           ':reservation$',
           ':consumption'
         )
       )
      where consumption.kind = 'consumption'
        and not exists (
          select 1 from credit_usage_outbox outbox
          where outbox.consumption_entry_id = consumption.id
        )
      order by consumption.created_at, consumption.id
      limit ${limit}
    )
    insert into credit_usage_outbox (
      consumption_entry_id,
      ordinal,
      idempotency_key,
      organization_id,
      occurred_at
    )
    select
      consumption.id,
      ordinal,
      consumption.organization_id || ':' || consumption.idempotency_key || ':credit:' || ordinal,
      consumption.organization_id,
      consumption.created_at
    from missing_consumptions consumption
    cross join lateral generate_series(1, abs(consumption.amount)) ordinal
    on conflict (consumption_entry_id, ordinal) do nothing
  `);
};

const validateDeliveryOptions = (options: {
  leaseOwner: string;
  now: Date;
  limit: number;
  leaseMilliseconds: number;
}) => {
  if (
    !options.leaseOwner.trim() ||
    !validDate(options.now) ||
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100 ||
    !Number.isSafeInteger(options.leaseMilliseconds) ||
    options.leaseMilliseconds < 1
  )
    throw new BillingStoreError("invalid_billing_input");
};

export const claimCreditUsage = async (
  database: DrizzleDatabase,
  input: {
    leaseOwner: string;
    now?: Date;
    limit?: number;
    leaseMilliseconds?: number;
  },
) => {
  const options = {
    leaseOwner: input.leaseOwner,
    now: input.now ?? new Date(),
    limit: input.limit ?? 100,
    leaseMilliseconds: input.leaseMilliseconds ?? 10 * 60_000,
  };
  validateDeliveryOptions(options);
  return database.transaction(async (tx) => {
    await backfillFinalizedCreditUsage(tx);
    await tx
      .update(creditUsageOutbox)
      .set({
        state: "failed",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: sql`coalesce(${creditUsageOutbox.lastErrorCode}, 'attempts_exhausted')`,
        updatedAt: options.now,
      })
      .where(
        and(
          eq(creditUsageOutbox.state, "pending"),
          gte(creditUsageOutbox.attempts, CREDIT_USAGE_DELIVERY_MAX_ATTEMPTS),
        ),
      );
    const candidates = await tx
      .select({ id: creditUsageOutbox.id })
      .from(creditUsageOutbox)
      .where(
        and(
          eq(creditUsageOutbox.state, "pending"),
          lte(creditUsageOutbox.availableAt, options.now),
          lt(creditUsageOutbox.attempts, CREDIT_USAGE_DELIVERY_MAX_ATTEMPTS),
        ),
      )
      .orderBy(
        asc(creditUsageOutbox.availableAt),
        asc(creditUsageOutbox.createdAt),
      )
      .limit(options.limit)
      .for("update", { of: creditUsageOutbox, skipLocked: true });
    if (candidates.length === 0) return [];
    const rows = await tx
      .update(creditUsageOutbox)
      .set({
        state: "leased",
        leaseOwner: options.leaseOwner,
        leaseExpiresAt: new Date(
          options.now.getTime() + options.leaseMilliseconds,
        ),
        attempts: sql`${creditUsageOutbox.attempts} + 1`,
        updatedAt: options.now,
      })
      .where(
        and(
          inArray(
            creditUsageOutbox.id,
            candidates.map(({ id }) => id),
          ),
          eq(creditUsageOutbox.state, "pending"),
        ),
      )
      .returning();
    return rows
      .map(
        (row): CreditUsageDelivery => ({
          id: row.id,
          idempotencyKey: row.idempotencyKey,
          organizationId: row.organizationId,
          occurredAt: row.occurredAt,
          attempts: row.attempts,
        }),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
  });
};

const validateDeliveryIds = (ids: readonly string[], leaseOwner: string) => {
  if (
    ids.length === 0 ||
    ids.length > 100 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !id.trim()) ||
    !leaseOwner.trim()
  )
    throw new BillingStoreError("invalid_billing_input");
};

export const markCreditUsageDelivered = async (
  database: DrizzleDatabase,
  input: { ids: readonly string[]; leaseOwner: string; deliveredAt?: Date },
) => {
  const deliveredAt = input.deliveredAt ?? new Date();
  validateDeliveryIds(input.ids, input.leaseOwner);
  if (!validDate(deliveredAt))
    throw new BillingStoreError("invalid_billing_input");
  await database.transaction(async (tx) => {
    const delivered = await tx
      .update(creditUsageOutbox)
      .set({
        state: "delivered",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        deliveredAt,
        updatedAt: deliveredAt,
      })
      .where(
        and(
          inArray(creditUsageOutbox.id, [...input.ids]),
          eq(creditUsageOutbox.state, "leased"),
          eq(creditUsageOutbox.leaseOwner, input.leaseOwner),
        ),
      )
      .returning({
        id: creditUsageOutbox.id,
        organizationId: creditUsageOutbox.organizationId,
        occurredAt: creditUsageOutbox.occurredAt,
      });
    if (delivered.length !== input.ids.length)
      throw new BillingStoreError("usage_lease_lost");
    for (const item of delivered) {
      let periods = await tx
        .select()
        .from(creditReconciliations)
        .where(
          and(
            eq(creditReconciliations.organizationId, item.organizationId),
            lte(creditReconciliations.periodStart, item.occurredAt),
            gt(creditReconciliations.periodEnd, item.occurredAt),
          ),
        );
      if (periods.length === 0) {
        const [entitlement] = await tx
          .select({
            periodStart: organizationEntitlements.periodStart,
            periodEnd: organizationEntitlements.periodEnd,
          })
          .from(organizationEntitlements)
          .where(
            eq(organizationEntitlements.organizationId, item.organizationId),
          )
          .limit(1);
        if (
          entitlement?.periodStart &&
          entitlement.periodEnd &&
          entitlement.periodStart.getTime() <= item.occurredAt.getTime() &&
          item.occurredAt.getTime() < entitlement.periodEnd.getTime()
        ) {
          await tx
            .insert(creditReconciliations)
            .values({
              organizationId: item.organizationId,
              localCredits: 0,
              polarCredits: 0,
              status: "pending",
              periodStart: entitlement.periodStart,
              periodEnd: entitlement.periodEnd,
            })
            .onConflictDoNothing();
          periods = await tx
            .select()
            .from(creditReconciliations)
            .where(
              and(
                eq(creditReconciliations.organizationId, item.organizationId),
                lte(creditReconciliations.periodStart, item.occurredAt),
                gt(creditReconciliations.periodEnd, item.occurredAt),
              ),
            );
        }
      }
      const [period] = periods;
      if (periods.length !== 1 || !period)
        throw new BillingStoreError("billing_period_unavailable");
      await tx
        .update(creditReconciliations)
        .set({ status: "pending", resolvedAt: null })
        .where(eq(creditReconciliations.id, period.id));
    }
  });
};

export const releaseCreditUsage = async (
  database: DrizzleDatabase,
  input: {
    ids: readonly string[];
    leaseOwner: string;
    errorCode: string;
    availableAt?: Date;
    now?: Date;
  },
) => {
  const now = input.now ?? new Date();
  const availableAt = input.availableAt ?? new Date(now.getTime() + 60_000);
  validateDeliveryIds(input.ids, input.leaseOwner);
  if (
    !validDate(availableAt) ||
    !validDate(now) ||
    !/^[a-z0-9:_-]{1,100}$/i.test(input.errorCode)
  )
    throw new BillingStoreError("invalid_billing_input");
  await database.transaction(async (tx) => {
    const released = await tx
      .update(creditUsageOutbox)
      .set({
        state: sql`case when ${creditUsageOutbox.attempts} >= ${CREDIT_USAGE_DELIVERY_MAX_ATTEMPTS} then 'failed' else 'pending' end`,
        availableAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: input.errorCode,
        updatedAt: now,
      })
      .where(
        and(
          inArray(creditUsageOutbox.id, [...input.ids]),
          eq(creditUsageOutbox.state, "leased"),
          eq(creditUsageOutbox.leaseOwner, input.leaseOwner),
        ),
      )
      .returning({ id: creditUsageOutbox.id });
    if (released.length !== input.ids.length)
      throw new BillingStoreError("usage_lease_lost");
  });
};

export const recoverCreditUsageLeases = async (
  database: DrizzleDatabase,
  now = new Date(),
) => {
  if (!validDate(now)) throw new BillingStoreError("invalid_billing_input");
  const recovered = await database
    .update(creditUsageOutbox)
    .set({
      state: sql`case when ${creditUsageOutbox.attempts} >= ${CREDIT_USAGE_DELIVERY_MAX_ATTEMPTS} then 'failed' else 'pending' end`,
      availableAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: "lease_expired",
      updatedAt: now,
    })
    .where(
      and(
        eq(creditUsageOutbox.state, "leased"),
        lte(creditUsageOutbox.leaseExpiresAt, now),
      ),
    )
    .returning({ id: creditUsageOutbox.id, state: creditUsageOutbox.state });
  return {
    recovered: recovered.filter(({ state }) => state === "pending").length,
    failed: recovered.filter(({ state }) => state === "failed").length,
  };
};

export type CreditUsageDeadLetter = {
  id: string;
  consumptionEntryId: string;
  idempotencyKey: string;
  organizationId: string;
  occurredAt: Date;
  attempts: number;
  lastErrorCode: string | null;
  failedAt: Date;
};

export const listCreditUsageDeadLetters = async (
  database: DrizzleDatabase,
  options: { limit?: number; afterId?: string } = {},
) => {
  const limit = options.limit ?? 100;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (options.afterId !== undefined && !options.afterId.trim())
  )
    throw new BillingStoreError("invalid_billing_input");
  const rows = await database
    .select({
      id: creditUsageOutbox.id,
      consumptionEntryId: creditUsageOutbox.consumptionEntryId,
      idempotencyKey: creditUsageOutbox.idempotencyKey,
      organizationId: creditUsageOutbox.organizationId,
      occurredAt: creditUsageOutbox.occurredAt,
      attempts: creditUsageOutbox.attempts,
      lastErrorCode: creditUsageOutbox.lastErrorCode,
      failedAt: creditUsageOutbox.updatedAt,
    })
    .from(creditUsageOutbox)
    .where(
      and(
        eq(creditUsageOutbox.state, "failed"),
        options.afterId === undefined
          ? undefined
          : gt(creditUsageOutbox.id, options.afterId),
      ),
    )
    .orderBy(asc(creditUsageOutbox.id))
    .limit(limit);
  return rows satisfies CreditUsageDeadLetter[];
};

export const redriveCreditUsage = async (
  database: QueryableDatabase,
  input: { ids: readonly string[]; now?: Date },
) => {
  const now = input.now ?? new Date();
  if (
    input.ids.length === 0 ||
    input.ids.length > 100 ||
    new Set(input.ids).size !== input.ids.length ||
    input.ids.some((id) => !id.trim()) ||
    !validDate(now)
  )
    throw new BillingStoreError("invalid_billing_input");
  return database
    .update(creditUsageOutbox)
    .set({
      state: "pending",
      attempts: 0,
      availableAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        inArray(creditUsageOutbox.id, [...input.ids]),
        eq(creditUsageOutbox.state, "failed"),
      ),
    )
    .returning({ id: creditUsageOutbox.id });
};

const safeProviderErrorCode = (error: unknown) => {
  if (typeof error !== "object" || error === null || !("code" in error))
    return "provider_error";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" &&
    [
      "unauthorized",
      "forbidden",
      "not_found",
      "conflict",
      "invalid_request",
      "rate_limited",
      "server_error",
      "network_error",
      "malformed_response",
    ].includes(code)
    ? code
    : "provider_error";
};

const reconciliationPeriod = async (
  database: QueryableDatabase,
  reconciliationId: string,
) => {
  const [reconciliation] = await database
    .select()
    .from(creditReconciliations)
    .where(eq(creditReconciliations.id, reconciliationId))
    .limit(1);
  if (!reconciliation) return null;
  if (reconciliation.periodStart && reconciliation.periodEnd)
    return reconciliation;
  throw new BillingStoreError("billing_period_unavailable");
};

const getOrCreateReconciliation = async (
  database: DrizzleDatabase,
  input:
    | { reconciliationId: string }
    | { organizationId: string; startAt: Date; endAt: Date },
) => {
  if ("reconciliationId" in input) {
    if (!input.reconciliationId.trim())
      throw new BillingStoreError("invalid_billing_input");
    return reconciliationPeriod(database, input.reconciliationId);
  }
  if (!input.organizationId.trim())
    throw new BillingStoreError("invalid_billing_input");
  validatePeriod(input.startAt, input.endAt);
  await database
    .insert(creditReconciliations)
    .values({
      organizationId: input.organizationId,
      localCredits: 0,
      polarCredits: 0,
      status: "pending",
      periodStart: input.startAt,
      periodEnd: input.endAt,
    })
    .onConflictDoNothing();
  const [reconciliation] = await database
    .select()
    .from(creditReconciliations)
    .where(
      and(
        eq(creditReconciliations.organizationId, input.organizationId),
        eq(creditReconciliations.periodStart, input.startAt),
        eq(creditReconciliations.periodEnd, input.endAt),
      ),
    )
    .limit(1);
  return reconciliation ?? null;
};

export const reconcileCreditUsage = async (
  database: DrizzleDatabase,
  input:
    | { reconciliationId: string; now?: Date }
    | {
        organizationId: string;
        startAt: Date;
        endAt: Date;
        now?: Date;
      },
  readMeter: CreditMeterReader,
) => {
  const now = input.now ?? new Date();
  if (!validDate(now)) throw new BillingStoreError("invalid_billing_input");
  const reconciliation = await getOrCreateReconciliation(database, input);
  if (!reconciliation) return null;
  if (!reconciliation.periodStart || !reconciliation.periodEnd)
    throw new BillingStoreError("billing_period_unavailable");
  const target = {
    organizationId: reconciliation.organizationId,
    startAt: reconciliation.periodStart,
    endAt: reconciliation.periodEnd,
  };
  const [usage] = await database
    .select({ total: count() })
    .from(creditUsageOutbox)
    .where(
      and(
        eq(creditUsageOutbox.organizationId, target.organizationId),
        eq(creditUsageOutbox.state, "delivered"),
        gte(creditUsageOutbox.occurredAt, target.startAt),
        lt(creditUsageOutbox.occurredAt, target.endAt),
      ),
    );
  const localCredits = Number(usage?.total ?? 0);
  await database
    .update(creditReconciliations)
    .set({
      localCredits,
      status: "pending",
      attempts: sql`${creditReconciliations.attempts} + 1`,
      checkedAt: now,
      lastError: null,
    })
    .where(eq(creditReconciliations.id, reconciliation.id));

  let polarCredits: number;
  try {
    polarCredits = await readMeter(target);
    if (!Number.isSafeInteger(polarCredits) || polarCredits < 0)
      throw new BillingStoreError("invalid_billing_input");
  } catch (error) {
    const [failed] = await database
      .update(creditReconciliations)
      .set({
        status: "error",
        lastError: safeProviderErrorCode(error),
        resolvedAt: null,
      })
      .where(eq(creditReconciliations.id, reconciliation.id))
      .returning();
    return failed ?? null;
  }
  const status = localCredits === polarCredits ? "matched" : "drift";
  const [completed] = await database
    .update(creditReconciliations)
    .set({
      polarCredits,
      status,
      lastError: null,
      resolvedAt: status === "matched" ? now : null,
    })
    .where(eq(creditReconciliations.id, reconciliation.id))
    .returning();
  return completed ?? null;
};

type CreditReconciliationCursor = {
  organizationId: string;
  startAt: Date;
  endAt: Date;
};

const decodeCreditReconciliationCursor = (
  value: string | undefined,
): CreditReconciliationCursor | null => {
  if (value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      typeof parsed[0] !== "string" ||
      !parsed[0].trim() ||
      typeof parsed[1] !== "string" ||
      typeof parsed[2] !== "string"
    )
      throw new Error("invalid_cursor");
    const startAt = new Date(parsed[1]);
    const endAt = new Date(parsed[2]);
    validatePeriod(startAt, endAt);
    return { organizationId: parsed[0], startAt, endAt };
  } catch {
    throw new BillingStoreError("invalid_billing_input");
  }
};

const encodeCreditReconciliationCursor = (target: CreditReconciliationTarget) =>
  JSON.stringify([
    target.organizationId,
    target.startAt.toISOString(),
    target.endAt.toISOString(),
  ]);

const afterCreditReconciliationCursor = (
  cursor: CreditReconciliationCursor | null,
) =>
  cursor === null
    ? undefined
    : or(
        gt(creditReconciliations.organizationId, cursor.organizationId),
        and(
          eq(creditReconciliations.organizationId, cursor.organizationId),
          gt(creditReconciliations.periodStart, cursor.startAt),
        ),
        and(
          eq(creditReconciliations.organizationId, cursor.organizationId),
          eq(creditReconciliations.periodStart, cursor.startAt),
          gt(creditReconciliations.periodEnd, cursor.endAt),
        ),
      );

const afterEntitlementCursor = (cursor: CreditReconciliationCursor | null) =>
  cursor === null
    ? undefined
    : or(
        gt(organizationEntitlements.organizationId, cursor.organizationId),
        and(
          eq(organizationEntitlements.organizationId, cursor.organizationId),
          gt(organizationEntitlements.periodStart, cursor.startAt),
        ),
        and(
          eq(organizationEntitlements.organizationId, cursor.organizationId),
          eq(organizationEntitlements.periodStart, cursor.startAt),
          gt(organizationEntitlements.periodEnd, cursor.endAt),
        ),
      );

export const reconcileCreditPeriodPage = async (
  database: DrizzleDatabase,
  readMeter: CreditMeterReader,
  options: {
    limit?: number;
    now?: Date;
    after?: string;
  } = {},
) => {
  const limit = options.limit ?? 50;
  const now = options.now ?? new Date();
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !validDate(now)
  )
    throw new BillingStoreError("invalid_billing_input");
  const cursor = decodeCreditReconciliationCursor(options.after);
  const currentPeriods = await database
    .select({
      organizationId: organizationEntitlements.organizationId,
      startAt: organizationEntitlements.periodStart,
      endAt: organizationEntitlements.periodEnd,
    })
    .from(organizationEntitlements)
    .innerJoin(
      polarCustomers,
      eq(
        polarCustomers.organizationId,
        organizationEntitlements.organizationId,
      ),
    )
    .where(
      and(
        isNotNull(organizationEntitlements.periodStart),
        isNotNull(organizationEntitlements.periodEnd),
        afterEntitlementCursor(cursor),
      ),
    )
    .orderBy(
      organizationEntitlements.organizationId,
      organizationEntitlements.periodStart,
      organizationEntitlements.periodEnd,
    )
    .limit(limit + 1);
  const exactCurrentPeriods = currentPeriods.filter(
    (
      period,
    ): period is {
      organizationId: string;
      startAt: Date;
      endAt: Date;
    } => period.startAt !== null && period.endAt !== null,
  );
  if (exactCurrentPeriods.length > 0)
    await database
      .insert(creditReconciliations)
      .values(
        exactCurrentPeriods.map((period) => ({
          organizationId: period.organizationId,
          localCredits: 0,
          polarCredits: 0,
          periodStart: period.startAt,
          periodEnd: period.endAt,
          status: "pending",
        })),
      )
      .onConflictDoNothing();
  const candidates = await database
    .select({
      id: creditReconciliations.id,
      organizationId: creditReconciliations.organizationId,
      startAt: creditReconciliations.periodStart,
      endAt: creditReconciliations.periodEnd,
    })
    .from(creditReconciliations)
    .innerJoin(
      polarCustomers,
      eq(polarCustomers.organizationId, creditReconciliations.organizationId),
    )
    .leftJoin(
      organizationEntitlements,
      and(
        eq(
          organizationEntitlements.organizationId,
          creditReconciliations.organizationId,
        ),
        eq(
          organizationEntitlements.periodStart,
          creditReconciliations.periodStart,
        ),
        eq(organizationEntitlements.periodEnd, creditReconciliations.periodEnd),
      ),
    )
    .where(
      and(
        isNotNull(creditReconciliations.periodStart),
        isNotNull(creditReconciliations.periodEnd),
        or(
          ne(creditReconciliations.status, "matched"),
          isNotNull(organizationEntitlements.organizationId),
        ),
        afterCreditReconciliationCursor(cursor),
      ),
    )
    .orderBy(
      creditReconciliations.organizationId,
      creditReconciliations.periodStart,
      creditReconciliations.periodEnd,
    )
    .limit(limit + 1);
  const page = candidates.slice(0, limit);
  const results = [];
  for (const candidate of page) {
    if (!candidate.startAt || !candidate.endAt) continue;
    results.push(
      await reconcileCreditUsage(
        database,
        {
          reconciliationId: candidate.id,
          now,
        },
        readMeter,
      ),
    );
  }
  const lastCandidate = page.at(-1);
  return {
    reconciliations: results,
    nextCursor:
      candidates.length > limit && lastCandidate?.startAt && lastCandidate.endAt
        ? encodeCreditReconciliationCursor({
            organizationId: lastCandidate.organizationId,
            startAt: lastCandidate.startAt,
            endAt: lastCandidate.endAt,
          })
        : null,
  };
};

export const reconcileCurrentCreditPeriods = async (
  database: DrizzleDatabase,
  readMeter: CreditMeterReader,
  options: {
    limit?: number;
    now?: Date;
    after?: string;
  } = {},
) =>
  (await reconcileCreditPeriodPage(database, readMeter, options))
    .reconciliations;

/** Opens and closes one raw Neon pool around a single billing task invocation. */
export const withNeonBillingDatabase = async <Value>(
  databaseUrl: string,
  operation: (database: DrizzleDatabase) => Promise<Value>,
) => {
  if (!databaseUrl.trim()) throw new BillingStoreError("invalid_billing_input");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    return await operation(drizzle(pool, { schema }));
  } finally {
    await pool.end();
  }
};
