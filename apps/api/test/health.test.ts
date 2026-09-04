import { fileURLToPath } from "node:url";
import {
  type ClerkProjectionEvent,
  type GitHubVerification,
  makeDatabaseLayer,
  type ProvisionedWorkspace,
} from "@humans/database";
import { applyCreditEntry, getCreditBalance } from "@humans/database/credits";
import { importProfiles } from "@humans/database/import-profiles";
import * as schema from "@humans/database/schema";
import { searchProfiles } from "@humans/database/search-profiles";
import { PolarBillingError } from "@humans/polar-billing";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { Webhook } from "standardwebhooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type Bindings, createApp } from "../src/app";
import {
  type ApiKeyIdentity,
  type ApiScope,
  clerkIdentityBoundary,
  type IdentityBoundary,
  type OrganizationApiKey,
  type SessionIdentity,
} from "../src/clerk";
import type { PolarBoundary } from "../src/polar";

describe("Humans API", () => {
  const resources: {
    container?: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
    pool?: Pool;
  } = {};
  let app: ReturnType<typeof createApp>;
  let identity: FakeIdentity;
  let database: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    resources.container = await new PostgreSqlContainer(
      "pgvector/pgvector:pg17",
    ).start();
    resources.pool = new Pool({
      connectionString: resources.container.getConnectionUri(),
    });

    database = drizzle(resources.pool, { schema });
    await migrate(database, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url),
      ),
    });
    identity = new FakeIdentity();
    app = createApp(() => makeDatabaseLayer(database), identity);
  });

  afterAll(async () => {
    await resources.pool?.end();
    await resources.container?.stop();
  });

  it("serves health and public API documentation from an initialized database", async () => {
    const release = "a".repeat(40);
    const workerVersionId = "11111111-1111-4111-8111-111111111111";
    const rateLimitBinding = { limit: async () => ({ success: true }) };
    const healthResponse = await app.request("/health", {}, {
      API_KEY_RATE_LIMITER: rateLimitBinding,
      BILLING_APP_ORIGIN: "https://humans.crafter.run",
      BILLING_REQUIRED: "true",
      CLERK_BOT_PROTECTION_ENABLED: "true",
      CLERK_PUBLISHABLE_KEY: `pk_live_${"a".repeat(24)}`,
      CLERK_SECRET_KEY: `sk_live_${"b".repeat(24)}`,
      CLERK_WEBHOOK_SIGNING_SECRET: `whsec_${"c".repeat(24)}`,
      CF_VERSION_METADATA: { id: workerVersionId },
      DATABASE_URL:
        "postgresql://humans:password@ep-jolly-night-au0ic7nb-pooler.c-10.us-east-1.aws.neon.tech/humans?sslmode=require",
      IP_RATE_LIMITER: rateLimitBinding,
      MEMBER_RATE_LIMITER: rateLimitBinding,
      NATURAL_SEARCH_RATE_LIMITER: rateLimitBinding,
      ORGANIZATION_RATE_LIMITER: rateLimitBinding,
      POLAR_ACCESS_TOKEN: "polar_oat_test_only",
      POLAR_BASE_URL: "https://api.polar.sh/v1",
      POLAR_CUSTOMER_OWNER_EMAIL: "billing@humans.example",
      POLAR_ORGANIZATION_ID: "22222222-2222-4222-8222-222222222222",
      POLAR_PRO_PRODUCT_ID: "33333333-3333-4333-8333-333333333333",
      POLAR_USAGE_EVENT_NAME: "humans_credit_usage",
      POLAR_USAGE_METER_ID: "44444444-4444-4444-8444-444444444444",
      POLAR_WEBHOOK_SECRET: "polar_webhook_secret",
      PUBLIC_PROFILE_REQUEST_RATE_LIMITER: rateLimitBinding,
      PUBLIC_PROFILE_VERIFICATION_RATE_LIMITER: rateLimitBinding,
      SEARCH_CURSOR_SECRET: "d".repeat(32),
      SENTRY_DSN: "https://public@o1.ingest.us.sentry.io/4512020552089600",
      SENTRY_ENVIRONMENT: "production",
      SENTRY_RELEASE: release,
      WEB_PROXY_SECRET: "e".repeat(32),
    } as Bindings);
    expect(healthResponse.status).toBe(200);
    expect(healthResponse.headers.get("x-humans-release")).toBe(release);
    expect(healthResponse.headers.get("x-humans-environment")).toBe(
      "production",
    );
    await expect(healthResponse.json()).resolves.toEqual({
      checks: {
        database: "ok",
        pgvector: "ok",
      },
      worker: { versionId: workerVersionId },
      status: "ok",
    });

    const openApiResponse = await app.request("/openapi.json");
    expect(openApiResponse.status).toBe(200);
    const openApi = await openApiResponse.json();
    expect(openApi).toMatchObject({
      info: { title: "Humans API", version: "1.0.0" },
      paths: {
        "/health": {},
        "/v1/profiles": { get: { operationId: "listProfiles" } },
        "/v1/profiles/{profileId}": {
          get: { operationId: "getProfile" },
        },
        "/v1/search/facets": {
          get: { operationId: "listSearchFacets" },
        },
        "/v1/search": { post: { operationId: "searchProfiles" } },
        "/v1/profiles/{profileId}/reveal-email": {
          post: { operationId: "revealProfileEmail" },
        },
        "/v1/profiles/{profileId}/reveal-phone": {
          post: { operationId: "revealProfilePhone" },
        },
      },
    });
    expect(openApi.components.securitySchemes).toHaveProperty(
      "OrganizationApiKey",
    );
    expect(
      openApi.paths["/v1/profiles"].get.responses["200"].content[
        "application/json"
      ].schema,
    ).toBeDefined();
    expect(
      openApi.paths["/v1/search"].post.requestBody.content["application/json"]
        .schema,
    ).toBeDefined();
    expect(
      openApi.paths["/v1/profiles/{profileId}/reveal-email"].post.parameters,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Idempotency-Key", in: "header" }),
      ]),
    );
    expect(JSON.stringify(openApi)).not.toContain("private@company.example");
    expect(JSON.stringify(openApi)).not.toContain("secret_key_1");

    const documentationResponse = await app.request("/docs");
    expect(documentationResponse.status).toBe(200);
    await expect(documentationResponse.text()).resolves.toContain(
      "Humans API Reference",
    );
  });

  it("projects Clerk events once and isolates Organization workspaces", async () => {
    const memberEvent: ClerkProjectionEvent = {
      id: "evt_member_a",
      sourceUpdatedAt: 1,
      type: "member.upsert",
      member: {
        clerkId: "member_a",
        email: "a@example.com",
        imageUrl: null,
        name: "Member A",
      },
    };
    const membershipEvent: ClerkProjectionEvent = {
      id: "evt_membership_a",
      sourceUpdatedAt: 2,
      type: "membership.upsert",
      member: memberEvent.member,
      membership: {
        clerkId: "membership_a",
        memberId: "member_a",
        organizationId: "organization_a",
        role: "org:admin",
      },
      organization: {
        clerkId: "organization_a",
        name: "Organization A",
        slug: "organization-a",
      },
    };

    await expect(postWebhook(app, memberEvent)).resolves.toMatchObject({
      processed: true,
    });
    await expect(postWebhook(app, membershipEvent)).resolves.toMatchObject({
      processed: true,
    });
    await expect(postWebhook(app, membershipEvent)).resolves.toMatchObject({
      processed: false,
    });

    identity.sessions.set("session_a", {
      memberId: "member_a",
      organizationId: "organization_a",
    });
    const ownWorkspace = await app.request(
      "/v1/organizations/organization_a/workspace",
      { headers: { authorization: "Bearer session_a" } },
    );
    expect(ownWorkspace.status).toBe(200);
    await expect(ownWorkspace.json()).resolves.toMatchObject({
      memberId: "member_a",
      organizationId: "organization_a",
    });

    const otherWorkspace = await app.request(
      "/v1/organizations/organization_b/workspace",
      { headers: { authorization: "Bearer session_a" } },
    );
    expect(otherWorkspace.status).toBe(403);
    await expect(otherWorkspace.json()).resolves.toEqual({
      error: {
        code: "forbidden",
        message: "Organization access is denied",
      },
    });

    await expect(
      postWebhook(app, {
        id: "evt_membership_deleted",
        sourceUpdatedAt: 4,
        type: "membership.delete",
        memberId: "member_a",
        organizationId: "organization_a",
      }),
    ).resolves.toMatchObject({ processed: true });
    await expect(
      postWebhook(app, {
        ...membershipEvent,
        id: "evt_membership_delayed",
        sourceUpdatedAt: 3,
      }),
    ).resolves.toMatchObject({ processed: true });

    const removedWorkspace = await app.request(
      "/v1/organizations/organization_a/workspace",
      { headers: { authorization: "Bearer session_a" } },
    );
    expect(removedWorkspace.status).toBe(403);

    identity.sessions.set("delete_first_session", {
      memberId: "delete_first_member",
      organizationId: "delete_first_organization",
    });
    const deleteFirstMembership: ClerkProjectionEvent = {
      id: "evt_delete_first",
      sourceUpdatedAt: 10,
      type: "membership.delete",
      memberId: "delete_first_member",
      organizationId: "delete_first_organization",
    };
    await postWebhook(app, deleteFirstMembership);
    await postWebhook(app, {
      id: "evt_delayed_create",
      sourceUpdatedAt: 9,
      type: "membership.upsert",
      member: {
        clerkId: "delete_first_member",
        email: null,
        imageUrl: null,
        name: "Removed Member",
      },
      membership: {
        clerkId: "delete_first_membership",
        memberId: "delete_first_member",
        organizationId: "delete_first_organization",
        role: "org:member",
      },
      organization: {
        clerkId: "delete_first_organization",
        name: "Removed Organization",
        slug: "removed-organization",
      },
    });
    const deleteFirstWorkspace = await app.request(
      "/v1/organizations/delete_first_organization/workspace",
      { headers: { authorization: "Bearer delete_first_session" } },
    );
    expect(deleteFirstWorkspace.status).toBe(403);
  });

  it("provisions one personal Organization and preserves invitation membership", async () => {
    identity.sessions.set("new_session", {
      memberId: "new_member",
      organizationId: null,
    });

    const first = await app.request("/v1/workspace", {
      method: "POST",
      headers: { authorization: "Bearer new_session" },
    });
    const retry = await app.request("/v1/workspace", {
      method: "POST",
      headers: { authorization: "Bearer new_session" },
    });
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      organizationId: "personal_new_member",
    });
    await expect(retry.json()).resolves.toMatchObject({
      organizationId: "personal_new_member",
    });
    expect(identity.personalOrganizationsCreated).toBe(1);

    const verificationIdentity = new FakeIdentity();
    const verificationApp = createApp(
      () => makeDatabaseLayer(database),
      verificationIdentity,
    );
    verificationIdentity.sessions.set("verification_session", {
      memberId: "verification_member",
      organizationId: null,
      emailVerified: false,
      botProtectionVerified: false,
    });
    const blocked = await verificationApp.request("/v1/workspace", {
      method: "POST",
      headers: { authorization: "Bearer verification_session" },
    });
    expect(blocked.status).toBe(403);
    verificationIdentity.sessions.set("verification_session", {
      memberId: "verification_member",
      organizationId: null,
      emailVerified: true,
      botProtectionVerified: true,
    });
    const verified = await verificationApp.request("/v1/workspace", {
      method: "POST",
      headers: { authorization: "Bearer verification_session" },
    });
    expect(verified.status).toBe(200);

    identity.sessions.set("invited_session", {
      memberId: "invited_member",
      organizationId: "inviting_organization",
    });
    identity.organizations.set("invited_member", invitedProjection);
    const invited = await app.request("/v1/workspace", {
      method: "POST",
      headers: { authorization: "Bearer invited_session" },
    });
    expect(invited.status).toBe(200);
    await expect(invited.json()).resolves.toMatchObject({
      organizationId: "inviting_organization",
    });
    expect(identity.personalOrganizationsCreated).toBe(1);
  });

  it("routes a past-due Pro subscription to recovery instead of another checkout", async () => {
    const billingIdentity = new FakeIdentity();
    billingIdentity.sessions.set("billing_session", {
      memberId: "billing_member",
      organizationId: null,
    });
    let subscriptionStatus: "active" | "past_due" | null = "past_due";
    const ensureCustomer = vi.fn(async (input) => ({
      id: "22222222-2222-4222-8222-222222222222",
      clerkOrganizationId: input.clerkOrganizationId,
      type: "team" as const,
    }));
    const checkoutSession = {
      id: "11111111-1111-4111-8111-111111111111",
      url: "https://polar.sh/checkout/test",
      expiresAt: new Date(Date.now() + 60_000),
    };
    let recoverableCheckout: typeof checkoutSession | null = null;
    const findOpenProCheckout = vi.fn(async () => recoverableCheckout);
    const findProCheckoutByClaim = vi.fn(async () =>
      recoverableCheckout
        ? { ...recoverableCheckout, status: "open" as const }
        : null,
    );
    let knownCheckoutStatus: "open" | "expired" | "succeeded" = "open";
    const getProCheckout = vi.fn(async () => ({
      ...checkoutSession,
      status: knownCheckoutStatus,
    }));
    const createProCheckout = vi.fn(async () => checkoutSession);
    const polar = {
      billingConfigured: () => true,
      ensureCustomer,
      findOpenProCheckout,
      findProCheckoutByClaim,
      getProCheckout,
      createProCheckout,
      createCustomerPortalSession: async () => ({
        id: "33333333-3333-4333-8333-333333333333",
        url: "https://polar.sh/portal/test",
        expiresAt: new Date("2026-09-04T00:00:00Z"),
      }),
      getCustomerState: async (clerkOrganizationId: string) => ({
        customer: {
          id: "22222222-2222-4222-8222-222222222222",
          clerkOrganizationId,
          type: "team" as const,
        },
        proSubscription: subscriptionStatus
          ? {
              id: "44444444-4444-4444-8444-444444444444",
              status: subscriptionStatus,
              currentPeriodStart: new Date("2026-09-01T00:00:00Z"),
              currentPeriodEnd: new Date("2026-10-01T00:00:00Z"),
              cancelAtPeriodEnd: false,
            }
          : null,
      }),
      getMeterQuantities: async () => ({ quantities: [], total: 0 }),
      verifySubscriptionWebhook: async () => null,
      verifyBillingWebhook: async () => null,
    } satisfies PolarBoundary;
    const billingApp = createApp(
      () => makeDatabaseLayer(database),
      billingIdentity,
      undefined,
      polar,
    );
    const provisioned = await billingApp.request("/v1/workspace", {
      method: "POST",
      headers: { authorization: "Bearer billing_session" },
    });
    expect(provisioned.status).toBe(200);
    expect(ensureCustomer).toHaveBeenCalledOnce();
    expect(ensureCustomer).toHaveBeenCalledWith(
      {
        clerkOrganizationId: "personal_billing_member",
        name: "Personal Organization",
      },
      undefined,
    );
    billingIdentity.sessions.set("billing_session", {
      memberId: "billing_member",
      organizationId: "personal_billing_member",
    });

    const duplicate = await billingApp.request("/v1/billing/checkout", {
      method: "POST",
      headers: { authorization: "Bearer billing_session" },
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({
      error: { code: "subscription_already_active" },
    });
    expect(createProCheckout).not.toHaveBeenCalled();

    subscriptionStatus = null;
    const checkout = await billingApp.request("/v1/billing/checkout", {
      method: "POST",
      headers: { authorization: "Bearer billing_session" },
    });
    expect(checkout.status).toBe(201);
    expect(createProCheckout).toHaveBeenCalledOnce();

    const replay = await billingApp.request("/v1/billing/checkout", {
      method: "POST",
      headers: { authorization: "Bearer billing_session" },
    });
    expect(replay.status).toBe(200);
    expect(createProCheckout).toHaveBeenCalledOnce();

    await database
      .update(schema.polarCustomers)
      .set({ checkoutExpiresAt: new Date(0) })
      .where(
        eq(schema.polarCustomers.organizationId, "personal_billing_member"),
      );
    const providerOpen = await billingApp.request("/v1/billing/checkout", {
      method: "POST",
      headers: { authorization: "Bearer billing_session" },
    });
    expect(providerOpen.status).toBe(200);
    expect(createProCheckout).toHaveBeenCalledOnce();

    knownCheckoutStatus = "expired";
    await database
      .update(schema.polarCustomers)
      .set({ checkoutExpiresAt: new Date(0) })
      .where(
        eq(schema.polarCustomers.organizationId, "personal_billing_member"),
      );
    const replacement = await billingApp.request("/v1/billing/checkout", {
      method: "POST",
      headers: { authorization: "Bearer billing_session" },
    });
    expect(replacement.status).toBe(201);
    expect(createProCheckout).toHaveBeenCalledTimes(2);
    expect(getProCheckout).toHaveBeenCalledTimes(3);

    await database
      .update(schema.polarCustomers)
      .set({
        checkoutClaimId: null,
        checkoutClaimExpiresAt: null,
        checkoutId: null,
        checkoutUrl: null,
        checkoutExpiresAt: null,
      })
      .where(
        eq(schema.polarCustomers.organizationId, "personal_billing_member"),
      );
    createProCheckout.mockRejectedValueOnce(new Error("response lost"));
    const failedCheckout = await billingApp.request("/v1/billing/checkout", {
      method: "POST",
      headers: { authorization: "Bearer billing_session" },
    });
    expect(failedCheckout.status).toBe(503);
    const blockedRetry = await billingApp.request("/v1/billing/checkout", {
      method: "POST",
      headers: { authorization: "Bearer billing_session" },
    });
    expect(blockedRetry.status).toBe(409);
    await expect(blockedRetry.json()).resolves.toMatchObject({
      error: { code: "checkout_in_progress" },
    });
    expect(createProCheckout).toHaveBeenCalledTimes(3);

    await database
      .update(schema.polarCustomers)
      .set({ updatedAt: new Date(Date.now() - 6 * 60_000) })
      .where(
        eq(schema.polarCustomers.organizationId, "personal_billing_member"),
      );
    const boundedRetry = await billingApp.request("/v1/billing/checkout", {
      method: "POST",
      headers: { authorization: "Bearer billing_session" },
    });
    expect(boundedRetry.status).toBe(201);
    expect(createProCheckout).toHaveBeenCalledTimes(4);

    await database
      .update(schema.polarCustomers)
      .set({
        checkoutClaimId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        checkoutClaimExpiresAt: null,
        checkoutId: null,
        checkoutUrl: null,
        checkoutExpiresAt: null,
      })
      .where(
        eq(schema.polarCustomers.organizationId, "personal_billing_member"),
      );
    recoverableCheckout = checkoutSession;
    const recovered = await billingApp.request("/v1/billing/checkout", {
      method: "POST",
      headers: { authorization: "Bearer billing_session" },
    });
    expect(recovered.status).toBe(200);
    await expect(recovered.json()).resolves.toMatchObject({
      url: checkoutSession.url,
    });
    expect(createProCheckout).toHaveBeenCalledTimes(4);
    expect(findOpenProCheckout).toHaveBeenCalledTimes(4);
    expect(findProCheckoutByClaim).toHaveBeenCalledTimes(3);

    knownCheckoutStatus = "succeeded";
    recoverableCheckout = null;
    await database
      .update(schema.polarCustomers)
      .set({ checkoutExpiresAt: new Date(0) })
      .where(
        eq(schema.polarCustomers.organizationId, "personal_billing_member"),
      );
    const afterSucceeded = await billingApp.request("/v1/billing/checkout", {
      method: "POST",
      headers: { authorization: "Bearer billing_session" },
    });
    expect(afterSucceeded.status).toBe(201);
    expect(createProCheckout).toHaveBeenCalledTimes(5);

    subscriptionStatus = "active";
    const activeSubscription = await billingApp.request(
      "/v1/billing/checkout",
      {
        method: "POST",
        headers: { authorization: "Bearer billing_session" },
      },
    );
    expect(activeSubscription.status).toBe(409);
    subscriptionStatus = null;

    findOpenProCheckout.mockRejectedValueOnce(new Error("preflight failed"));
    const failedPreflight = await billingApp.request("/v1/billing/checkout", {
      method: "POST",
      headers: { authorization: "Bearer billing_session" },
    });
    expect(failedPreflight.status).toBe(503);
    const afterPreflightFailure = await billingApp.request(
      "/v1/billing/checkout",
      {
        method: "POST",
        headers: { authorization: "Bearer billing_session" },
      },
    );
    expect(afterPreflightFailure.status).toBe(201);
    expect(createProCheckout).toHaveBeenCalledTimes(6);

    subscriptionStatus = "active";
    await billingApp.request("/v1/billing/checkout", {
      method: "POST",
      headers: { authorization: "Bearer billing_session" },
    });
    subscriptionStatus = null;
    createProCheckout.mockRejectedValueOnce(
      new PolarBillingError("forbidden", { operation: "create_checkout" }),
    );
    const rejectedCreation = await billingApp.request("/v1/billing/checkout", {
      method: "POST",
      headers: { authorization: "Bearer billing_session" },
    });
    expect(rejectedCreation.status).toBe(503);
    const afterRejectedCreation = await billingApp.request(
      "/v1/billing/checkout",
      {
        method: "POST",
        headers: { authorization: "Bearer billing_session" },
      },
    );
    expect(afterRejectedCreation.status).toBe(201);
    expect(createProCheckout).toHaveBeenCalledTimes(8);

    billingIdentity.sessions.set("billing_invited_session", {
      memberId: "billing_invited_member",
      organizationId: "billing_inviting_organization",
    });
    billingIdentity.organizations.set("billing_invited_member", {
      member: {
        clerkId: "billing_invited_member",
        email: "billing-invited@example.com",
        imageUrl: null,
        name: "Billing Invited Member",
      },
      membership: {
        clerkId: "billing_invited_membership",
        memberId: "billing_invited_member",
        organizationId: "billing_inviting_organization",
        role: "org:member",
      },
      organization: {
        clerkId: "billing_inviting_organization",
        name: "Billing Inviting Organization",
        slug: "billing-inviting-organization",
      },
    });
    const customerCallsBeforeInvited = ensureCustomer.mock.calls.length;
    const invited = await billingApp.request("/v1/workspace", {
      method: "POST",
      headers: { authorization: "Bearer billing_invited_session" },
    });
    expect(invited.status).toBe(200);
    expect(ensureCustomer).toHaveBeenCalledTimes(customerCallsBeforeInvited);
  });

  it("serializes concurrent Pro checkout requests", async () => {
    const billingIdentity = new FakeIdentity();
    billingIdentity.sessions.set("concurrent_billing_session", {
      memberId: "concurrent_billing_member",
      organizationId: null,
    });
    let checkoutStarted: (() => void) | undefined;
    let finishCheckout: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      checkoutStarted = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      finishCheckout = resolve;
    });
    const createProCheckout = vi.fn(async () => {
      checkoutStarted?.();
      await finish;
      return {
        id: "55555555-5555-4555-8555-555555555555",
        url: "https://polar.sh/checkout/concurrent",
        expiresAt: new Date(Date.now() + 60_000),
      };
    });
    const polar = {
      billingConfigured: () => true,
      ensureCustomer: async (input) => ({
        id: "66666666-6666-4666-8666-666666666666",
        clerkOrganizationId: input.clerkOrganizationId,
        type: "team" as const,
      }),
      findOpenProCheckout: async () => null,
      findProCheckoutByClaim: async () => null,
      getProCheckout: async () => ({
        id: "55555555-5555-4555-8555-555555555555",
        status: "open" as const,
        url: "https://polar.sh/checkout/concurrent",
        expiresAt: new Date(Date.now() + 60_000),
      }),
      createProCheckout,
      createCustomerPortalSession: async () => ({
        id: "77777777-7777-4777-8777-777777777777",
        url: "https://polar.sh/portal/concurrent",
        expiresAt: new Date(Date.now() + 60_000),
      }),
      getCustomerState: async (clerkOrganizationId: string) => ({
        customer: {
          id: "66666666-6666-4666-8666-666666666666",
          clerkOrganizationId,
          type: "team" as const,
        },
        proSubscription: null,
      }),
      getMeterQuantities: async () => ({ quantities: [], total: 0 }),
      verifySubscriptionWebhook: async () => null,
      verifyBillingWebhook: async () => null,
    } satisfies PolarBoundary;
    const billingApp = createApp(
      () => makeDatabaseLayer(database),
      billingIdentity,
      undefined,
      polar,
    );
    const provisioned = await billingApp.request("/v1/workspace", {
      method: "POST",
      headers: { authorization: "Bearer concurrent_billing_session" },
    });
    expect(provisioned.status).toBe(200);
    billingIdentity.sessions.set("concurrent_billing_session", {
      memberId: "concurrent_billing_member",
      organizationId: "personal_concurrent_billing_member",
    });

    const first = billingApp.request("/v1/billing/checkout", {
      method: "POST",
      headers: { authorization: "Bearer concurrent_billing_session" },
    });
    await started;
    const concurrent = await billingApp.request("/v1/billing/checkout", {
      method: "POST",
      headers: { authorization: "Bearer concurrent_billing_session" },
    });
    expect(concurrent.status).toBe(409);
    await expect(concurrent.json()).resolves.toMatchObject({
      error: { code: "checkout_in_progress" },
    });
    finishCheckout?.();
    expect((await first).status).toBe(201);
    expect(createProCheckout).toHaveBeenCalledOnce();
  });

  it("isolates billing reads and management by Organization role", async () => {
    const billingIdentity = new FakeIdentity();
    billingIdentity.sessions.set("role_admin_session", {
      memberId: "role_admin",
      organizationId: null,
    });
    const customerIds = new Map([
      ["personal_role_admin", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      ["role_secondary", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    ]);
    const ensureCustomer = vi.fn(async (input) => ({
      id: customerIds.get(input.clerkOrganizationId) ?? "customer_unexpected",
      clerkOrganizationId: input.clerkOrganizationId,
      type: "team" as const,
    }));
    const createProCheckout = vi.fn(async (organizationId: string) => ({
      id: "33333333-3333-4333-8333-333333333333",
      url: `https://polar.sh/checkout/${organizationId}`,
      expiresAt: new Date(Date.now() + 60_000),
    }));
    const createCustomerPortalSession = vi.fn(
      async (organizationId: string) => ({
        id: "44444444-4444-4444-8444-444444444444",
        url: `https://polar.sh/portal/${organizationId}`,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    const polar = {
      billingConfigured: () => true,
      ensureCustomer,
      findOpenProCheckout: async () => null,
      findProCheckoutByClaim: async () => null,
      getProCheckout: async () => ({
        id: "88888888-8888-4888-8888-888888888888",
        status: "open" as const,
        url: "https://polar.sh/checkout/member",
        expiresAt: new Date(Date.now() + 60_000),
      }),
      createProCheckout,
      createCustomerPortalSession,
      getCustomerState: async (clerkOrganizationId: string) => ({
        customer: {
          id: customerIds.get(clerkOrganizationId) ?? "customer_unexpected",
          clerkOrganizationId,
          type: "team" as const,
        },
        proSubscription: null,
      }),
      getMeterQuantities: async () => ({ quantities: [], total: 0 }),
      verifySubscriptionWebhook: async () => null,
      verifyBillingWebhook: async () => null,
    } satisfies PolarBoundary;
    const billingApp = createApp(
      () => makeDatabaseLayer(database),
      billingIdentity,
      undefined,
      polar,
    );

    expect(
      (
        await billingApp.request("/v1/workspace", {
          method: "POST",
          headers: { authorization: "Bearer role_admin_session" },
        })
      ).status,
    ).toBe(200);
    billingIdentity.sessions.set("role_admin_session", {
      memberId: "role_admin",
      organizationId: "personal_role_admin",
    });
    billingIdentity.sessions.set("role_member_session", {
      memberId: "role_member",
      organizationId: "personal_role_admin",
    });
    billingIdentity.organizations.set("role_member", {
      member: {
        clerkId: "role_member",
        email: "role-member@example.com",
        imageUrl: null,
        name: "Role Member",
      },
      membership: {
        clerkId: "role_member_membership",
        memberId: "role_member",
        organizationId: "personal_role_admin",
        role: "org:member",
      },
      organization: {
        clerkId: "personal_role_admin",
        name: "Personal Organization",
        slug: "personal-role-admin",
      },
    });
    expect(
      (
        await billingApp.request("/v1/workspace", {
          method: "POST",
          headers: { authorization: "Bearer role_member_session" },
        })
      ).status,
    ).toBe(200);

    const [adminOverview, memberOverview] = await Promise.all([
      billingApp.request("/v1/billing", {
        headers: { authorization: "Bearer role_admin_session" },
      }),
      billingApp.request("/v1/billing", {
        headers: { authorization: "Bearer role_member_session" },
      }),
    ]);
    expect(adminOverview.status).toBe(200);
    expect(memberOverview.status).toBe(200);
    await expect(adminOverview.json()).resolves.toMatchObject({
      plan: "free",
      availableCredits: 100,
      canManageBilling: true,
    });
    await expect(memberOverview.json()).resolves.toMatchObject({
      plan: "free",
      availableCredits: 100,
      canManageBilling: false,
    });
    for (const path of ["checkout", "portal"]) {
      const blocked = await billingApp.request(`/v1/billing/${path}`, {
        method: "POST",
        headers: { authorization: "Bearer role_member_session" },
      });
      expect(blocked.status).toBe(403);
    }
    expect(createProCheckout).not.toHaveBeenCalled();
    expect(createCustomerPortalSession).not.toHaveBeenCalled();

    const portal = await billingApp.request("/v1/billing/portal", {
      method: "POST",
      headers: { authorization: "Bearer role_admin_session" },
    });
    expect(portal.status).toBe(201);
    expect(createCustomerPortalSession).toHaveBeenCalledWith(
      "personal_role_admin",
      undefined,
    );

    billingIdentity.sessions.set("role_admin_session", {
      memberId: "role_admin",
      organizationId: "role_secondary",
    });
    billingIdentity.organizations.set("role_admin", {
      member: {
        clerkId: "role_admin",
        email: "role-admin@example.com",
        imageUrl: null,
        name: "Role Admin",
      },
      membership: {
        clerkId: "role_secondary_membership",
        memberId: "role_admin",
        organizationId: "role_secondary",
        role: "org:admin",
      },
      organization: {
        clerkId: "role_secondary",
        name: "Role Secondary",
        slug: "role-secondary",
      },
    });
    expect(
      (
        await billingApp.request("/v1/workspace", {
          method: "POST",
          headers: { authorization: "Bearer role_admin_session" },
        })
      ).status,
    ).toBe(200);
    const secondaryOverview = await billingApp.request("/v1/billing", {
      headers: { authorization: "Bearer role_admin_session" },
    });
    await expect(secondaryOverview.json()).resolves.toMatchObject({
      plan: "free",
      availableCredits: 0,
      status: "inactive",
      canManageBilling: true,
    });
    const secondaryCheckout = await billingApp.request("/v1/billing/checkout", {
      method: "POST",
      headers: { authorization: "Bearer role_admin_session" },
    });
    expect(secondaryCheckout.status).toBe(201);
    expect(createProCheckout).toHaveBeenCalledWith(
      "role_secondary",
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      undefined,
    );
    expect(
      ensureCustomer.mock.calls.map(([input]) => input.clerkOrganizationId),
    ).toEqual(
      expect.arrayContaining(["personal_role_admin", "role_secondary"]),
    );
  });

  it("returns a structured unauthorized response", async () => {
    const response = await app.request(
      "/v1/organizations/organization_a/workspace",
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });

    const search = await app.request("/v1/profiles/search");
    expect(search.status).toBe(401);
    const detail = await app.request("/v1/profiles/any-profile");
    expect(detail.status).toBe(401);
    const mcp = await app.request("/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(mcp.status).toBe(401);
  });

  it("lets only Organization admins create, list, and revoke scoped API keys", async () => {
    await database
      .insert(schema.members)
      .values({ clerkId: "api_admin", name: "API Admin" })
      .onConflictDoNothing();
    await database
      .insert(schema.organizations)
      .values({ clerkId: "api_organization", name: "API Organization" })
      .onConflictDoNothing();
    await database
      .insert(schema.organizationMemberships)
      .values({
        clerkId: "api_admin_membership",
        memberId: "api_admin",
        organizationId: "api_organization",
        role: "org:admin",
      })
      .onConflictDoNothing();
    identity.sessions.set("api_admin_session", {
      memberId: "api_admin",
      organizationId: "api_organization",
    });
    const created = await app.request("/v1/organization/api-keys", {
      method: "POST",
      headers: {
        authorization: "Bearer api_admin_session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Recruiting integration",
        scopes: ["profiles:read", "contacts:reveal"],
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({
      apiKey: {
        name: "Recruiting integration",
        scopes: ["profiles:read", "contacts:reveal"],
        secret: expect.stringMatching(/^secret_/),
      },
    });

    const listed = await app.request("/v1/organization/api-keys", {
      headers: { authorization: "Bearer api_admin_session" },
    });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody.apiKeys).toHaveLength(1);
    expect(listedBody.apiKeys[0]).not.toHaveProperty("secret");

    const invalidScopes = await app.request("/v1/organization/api-keys", {
      method: "POST",
      headers: {
        authorization: "Bearer api_admin_session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Unsafe", scopes: ["contacts:reveal"] }),
    });
    expect(invalidScopes.status).toBe(422);

    const revoked = await app.request(
      `/v1/organization/api-keys/${createdBody.apiKey.id}`,
      {
        method: "DELETE",
        headers: { authorization: "Bearer api_admin_session" },
      },
    );
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toMatchObject({
      apiKey: { revoked: true },
    });
  });

  it("creates an eligible Profile only after explicit Member opt-in", async () => {
    identity.sessions.set("profile_session", {
      memberId: "member_a",
      organizationId: "organization_a",
    });
    identity.github.set("member_a", githubVerification());

    const draft = await putProfile(app, "profile_session", {
      ...validProfile,
      searchable: false,
    });
    expect(draft.status).toBe(200);
    expect(draft.headers.get("cache-control")).toBe("private, no-store");
    expect(draft.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    await expect(draft.json()).resolves.toMatchObject({
      profile: {
        eligibilityBasis: "owned_repository",
        githubAccountId: "12345",
        searchable: false,
        searchabilityReason: "member_opt_out",
      },
    });

    const publish = await putProfile(app, "profile_session", {
      ...validProfile,
      searchable: true,
    });
    expect(publish.status).toBe(200);
    await expect(publish.json()).resolves.toMatchObject({
      profile: { searchable: true, searchabilityReason: "member_opt_in" },
    });

    const disable = await app.request("/v1/profile/searchability", {
      method: "PATCH",
      headers: {
        authorization: "Bearer profile_session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ searchable: false }),
    });
    expect(disable.status).toBe(200);
    expect(disable.headers.get("cache-control")).toBe("private, no-store");
    expect(disable.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    await expect(disable.json()).resolves.toMatchObject({
      profile: { searchable: false, searchabilityReason: "member_opt_out" },
    });

    const reenable = await app.request("/v1/profile/searchability", {
      method: "PATCH",
      headers: {
        authorization: "Bearer profile_session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ searchable: true }),
    });
    expect(reenable.status).toBe(200);
    await expect(reenable.json()).resolves.toMatchObject({
      profile: { searchable: true, searchabilityReason: "member_opt_in" },
    });

    const ownerRead = await app.request("/v1/profile", {
      headers: { authorization: "Bearer profile_session" },
    });
    expect(ownerRead.status).toBe(200);
    expect(ownerRead.headers.get("cache-control")).toBe("private, no-store");
    expect(ownerRead.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    const protectedRead = await app.request("/v1/profile");
    expect(protectedRead.status).toBe(401);
  });

  it("accepts recent public contributions and private-account attestation", async () => {
    identity.github.set("member_a", {
      ...githubVerification(),
      ownsNonForkRepository: false,
      contributedPubliclySince: new Date(),
    });
    const contribution = await putProfile(app, "profile_session", validProfile);
    expect(contribution.status).toBe(200);
    await expect(contribution.json()).resolves.toMatchObject({
      profile: { eligibilityBasis: "public_contribution" },
    });

    identity.github.set("member_a", {
      ...githubVerification(),
      ownsNonForkRepository: false,
      contributedPubliclySince: null,
    });
    const privateAccount = await putProfile(app, "profile_session", {
      ...validProfile,
      privateCodeAttestation: true,
    });
    expect(privateAccount.status).toBe(200);
    await expect(privateAccount.json()).resolves.toMatchObject({
      profile: { eligibilityBasis: "private_attestation" },
    });
  });

  it("rejects ineligible GitHub account types, missing evidence, and minors", async () => {
    const rejected = async (
      github: GitHubVerification,
      profile = validProfile,
    ) => {
      identity.github.set("member_a", github);
      const response = await putProfile(app, "profile_session", profile);
      expect(response.status).toBe(422);
      return response.json();
    };

    await expect(
      rejected({ ...githubVerification(), accountType: "Bot" }),
    ).resolves.toMatchObject({
      error: { code: "ineligible_github_account_type" },
    });
    await expect(
      rejected({ ...githubVerification(), accountType: "Organization" }),
    ).resolves.toMatchObject({
      error: { code: "ineligible_github_account_type" },
    });
    await expect(
      rejected({
        ...githubVerification(),
        ownsNonForkRepository: false,
        contributedPubliclySince: new Date("2020-01-01"),
      }),
    ).resolves.toMatchObject({ error: { code: "coding_evidence_required" } });
    await expect(
      rejected({ ...githubVerification(), knownMinor: true }),
    ).resolves.toMatchObject({ error: { code: "adult_required" } });
    const suppressedProfile = await app.request("/v1/profile", {
      headers: { authorization: "Bearer profile_session" },
    });
    await expect(suppressedProfile.json()).resolves.toMatchObject({
      profile: {
        searchable: false,
        searchabilityReason: "operator_suppression",
      },
    });
    await expect(
      rejected(githubVerification(), {
        ...validProfile,
        adultAttestation: false,
      }),
    ).resolves.toMatchObject({ error: { code: "adult_required" } });
    await expect(
      rejected({ ...githubVerification(), accountId: "54321" }),
    ).resolves.toMatchObject({
      error: { code: "github_identity_change_requires_review" },
    });
  });

  it("discovers, verifies, reviews, and collision-proofs Profile claims", async () => {
    await database
      .insert(schema.members)
      .values([
        { clerkId: "claim_auto_member" },
        { clerkId: "claim_collision_member" },
        { clerkId: "claim_review_member" },
      ])
      .onConflictDoNothing();
    const [automaticProfile, reviewProfile] = await database
      .insert(schema.profiles)
      .values([
        {
          name: "Automatic Claim Profile",
          currentCompany: "Before",
          githubAccountId: "82001",
          githubLogin: "old-automatic-login",
          eligibilityBasis: "owned_repository",
          adultAttested: true,
          searchable: true,
          searchabilityReason: "approved_import",
        },
        {
          name: "Reviewed Claim Profile",
          githubAccountId: "82002",
          githubLogin: "reviewed-login",
          eligibilityBasis: "owned_repository",
          adultAttested: true,
          searchable: true,
          searchabilityReason: "approved_import",
        },
      ])
      .returning();
    if (!automaticProfile || !reviewProfile)
      throw new Error("Claim fixtures were not created");
    await database.insert(schema.professionalLinks).values({
      profileId: automaticProfile.profileId,
      url: "https://github.com/old-automatic-login",
    });

    identity.sessions.set("claim_auto_session", {
      memberId: "claim_auto_member",
      organizationId: null,
    });
    identity.sessions.set("claim_collision_session", {
      memberId: "claim_collision_member",
      organizationId: null,
    });
    identity.sessions.set("claim_review_session", {
      memberId: "claim_review_member",
      organizationId: null,
    });
    identity.github.set("claim_auto_member", {
      ...githubVerification(),
      accountId: "82001",
      login: "renamed-automatic-login",
    });
    identity.github.set("claim_collision_member", {
      ...githubVerification(),
      accountId: "82001",
      login: "renamed-automatic-login",
    });
    identity.github.set("claim_review_member", {
      ...githubVerification(),
      accountId: "82999",
      login: "different-reviewed-login",
    });

    const candidates = await app.request("/v1/profile/claim-candidates", {
      headers: { authorization: "Bearer claim_auto_session" },
    });
    expect(candidates.status).toBe(200);
    await expect(candidates.json()).resolves.toEqual({
      candidates: [
        {
          profileId: automaticProfile.profileId,
          name: "Automatic Claim Profile",
          githubLogin: "old-automatic-login",
        },
      ],
      claim: null,
    });
    expect(
      (
        await database
          .select({ memberId: schema.profiles.memberId })
          .from(schema.profiles)
          .where(eq(schema.profiles.profileId, automaticProfile.profileId))
      )[0]?.memberId,
    ).toBeNull();

    const duplicate = await putProfile(app, "claim_auto_session", {
      ...validProfile,
      name: "Do Not Duplicate",
      professionalLinks: ["https://github.com/renamed-automatic-login"],
    });
    expect(duplicate.status).toBe(422);
    await expect(duplicate.json()).resolves.toMatchObject({
      error: { code: "imported_profile_claim_required" },
    });

    const spoofed = await app.request("/v1/profile/claims", {
      method: "POST",
      headers: {
        authorization: "Bearer claim_auto_session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        profileReference: automaticProfile.profileId,
        oauthGithubAccountId: "spoofed",
      }),
    });
    expect(spoofed.status).toBe(422);

    const verified = await postProfileClaim(
      app,
      "claim_auto_session",
      automaticProfile.profileId,
    );
    expect(verified.status).toBe(200);
    await expect(verified.json()).resolves.toEqual({
      claim: { status: "verified" },
    });
    await expect(
      database
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.profileId, automaticProfile.profileId)),
    ).resolves.toEqual([
      expect.objectContaining({
        memberId: "claim_auto_member",
        githubLogin: "renamed-automatic-login",
        searchable: false,
        searchabilityReason: "member_opt_out",
      }),
    ]);

    const collision = await postProfileClaim(
      app,
      "claim_collision_session",
      automaticProfile.profileId,
    );
    expect(collision.status).toBe(409);
    await expect(collision.json()).resolves.toEqual({
      error: {
        code: "profile_claim_unavailable",
        message: "The Profile claim could not be completed",
      },
    });

    const pending = await postProfileClaim(
      app,
      "claim_review_session",
      reviewProfile.profileId,
    );
    expect(pending.status).toBe(202);
    await expect(pending.json()).resolves.toEqual({
      claim: { status: "pending_review" },
    });
    await expect(
      database
        .select()
        .from(schema.profileClaims)
        .where(eq(schema.profileClaims.memberId, "claim_review_member")),
    ).resolves.toEqual([
      expect.objectContaining({
        profileId: reviewProfile.profileId,
        githubAccountId: "82999",
        status: "pending_review",
      }),
    ]);
    expect(
      (
        await database
          .select({ memberId: schema.profiles.memberId })
          .from(schema.profiles)
          .where(eq(schema.profiles.profileId, reviewProfile.profileId))
      )[0]?.memberId,
    ).toBeNull();
    await database
      .update(schema.profileClaims)
      .set({ status: "rejected", reviewedAt: new Date() })
      .where(eq(schema.profileClaims.memberId, "claim_review_member"));
  });

  it("edits a controlled Profile, removes Member Statements, verifies canonical links, and opts back in", async () => {
    const [controlledProfile] = await database
      .select({ profileId: schema.profiles.profileId })
      .from(schema.profiles)
      .where(eq(schema.profiles.githubAccountId, "82001"));
    expect(controlledProfile).toBeDefined();
    if (!controlledProfile)
      throw new Error("Controlled Profile fixture was not found");

    const ordinary = await app.request("/v1/profile/details", {
      method: "PATCH",
      headers: {
        authorization: "Bearer claim_auto_session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Controlled Profile",
        currentCompany: "Humans",
        professionalLinks: ["https://github.com/old-automatic-login"],
        statements: { role: "Staff engineer", skills: ["TypeScript"] },
      }),
    });
    expect(ordinary.status).toBe(200);
    await expect(ordinary.json()).resolves.toMatchObject({
      profile: {
        name: "Controlled Profile",
        currentCompany: "Humans",
        statements: { role: "Staff engineer", skills: ["TypeScript"] },
      },
    });

    const verifiedCanonical = await app.request("/v1/profile/details", {
      method: "PATCH",
      headers: {
        authorization: "Bearer claim_auto_session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Controlled Profile",
        currentCompany: "Humans",
        professionalLinks: ["https://github.com/renamed-automatic-login"],
        statements: { role: null },
      }),
    });
    expect(verifiedCanonical.status).toBe(200);
    await expect(
      database
        .select()
        .from(schema.memberStatements)
        .where(
          and(
            eq(schema.memberStatements.profileId, controlledProfile.profileId),
            eq(schema.memberStatements.field, "role"),
          ),
        ),
    ).resolves.toHaveLength(0);

    identity.linkedIn.set("claim_auto_member", {
      providerUserId: "linkedin-82001",
      username: "verified-linkedin",
    });
    const verifiedLinkedIn = await app.request("/v1/profile/details", {
      method: "PATCH",
      headers: {
        authorization: "Bearer claim_auto_session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Controlled Profile",
        currentCompany: "Humans",
        professionalLinks: [
          "https://github.com/renamed-automatic-login",
          "https://www.linkedin.com/in/verified-linkedin",
        ],
        statements: {},
      }),
    });
    expect(verifiedLinkedIn.status).toBe(200);

    const mismatchedLinkedIn = await app.request("/v1/profile/details", {
      method: "PATCH",
      headers: {
        authorization: "Bearer claim_auto_session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Controlled Profile",
        currentCompany: "Humans",
        professionalLinks: [
          "https://github.com/renamed-automatic-login",
          "https://www.linkedin.com/in/not-the-member",
        ],
        statements: {},
      }),
    });
    expect(mismatchedLinkedIn.status).toBe(422);
    await expect(mismatchedLinkedIn.json()).resolves.toMatchObject({
      error: { code: "canonical_identity_mismatch" },
    });

    const mismatchedCanonical = await app.request("/v1/profile/details", {
      method: "PATCH",
      headers: {
        authorization: "Bearer claim_auto_session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Controlled Profile",
        currentCompany: "Humans",
        professionalLinks: [
          "https://github.com/not-the-member",
          "https://www.linkedin.com/in/verified-linkedin",
        ],
        statements: {},
      }),
    });
    expect(mismatchedCanonical.status).toBe(422);
    await expect(mismatchedCanonical.json()).resolves.toMatchObject({
      error: { code: "canonical_identity_mismatch" },
    });

    const putBypass = await putProfile(app, "claim_auto_session", {
      ...validProfile,
      name: "Attempted canonical bypass",
      professionalLinks: [
        "https://github.com/renamed-automatic-login",
        "https://www.linkedin.com/in/not-the-member",
      ],
    });
    expect(putBypass.status).toBe(422);
    await expect(putBypass.json()).resolves.toMatchObject({
      error: { code: "canonical_identity_mismatch" },
    });

    for (const searchable of [true, false, true]) {
      const response = await app.request("/v1/profile/searchability", {
        method: "PATCH",
        headers: {
          authorization: "Bearer claim_auto_session",
          "content-type": "application/json",
        },
        body: JSON.stringify({ searchable }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        profile: {
          searchable,
          searchabilityReason: searchable ? "member_opt_in" : "member_opt_out",
        },
      });
    }
  });

  it("accepts non-enumerating public correction/removal requests and keeps confirmed removals suppressed", async () => {
    const [correctionProfile, removalProfile] = await database
      .insert(schema.profiles)
      .values([
        {
          name: "Public Correction Unique",
          currentCompany: "Wrong Company",
          githubAccountId: "83001",
          githubLogin: "public-correction",
          eligibilityBasis: "owned_repository",
          adultAttested: true,
          searchable: true,
          searchabilityReason: "approved_import",
        },
        {
          name: "Public Removal Unique",
          githubAccountId: "83002",
          githubLogin: "public-removal",
          eligibilityBasis: "owned_repository",
          adultAttested: true,
          searchable: true,
          searchabilityReason: "approved_import",
        },
      ])
      .returning();
    if (!correctionProfile || !removalProfile)
      throw new Error("Public Profile request fixtures were not created");
    expect(
      (await searchProfiles(database, { query: "Public Correction Unique" }))
        .results,
    ).toHaveLength(1);

    const correction = await postPublicProfileRequest(
      app,
      correctionProfile.profileId,
      "correction",
      "198.51.100.10",
    );
    const missing = await postPublicProfileRequest(
      app,
      crypto.randomUUID(),
      "correction",
      "198.51.100.10",
    );
    const duplicate = await postPublicProfileRequest(
      app,
      correctionProfile.profileId,
      "correction",
      "198.51.100.12",
    );
    expect(correction.status).toBe(202);
    expect(correction.headers.get("cache-control")).toBe("no-store");
    expect(correction.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(missing.status).toBe(202);
    expect(duplicate.status).toBe(202);
    const publicRateLimitKeys: string[] = [];
    const publicRateLimit = await postPublicProfileRequest(
      app,
      crypto.randomUUID(),
      "correction",
      "198.51.100.44",
      {
        PUBLIC_PROFILE_REQUEST_RATE_LIMITER: {
          limit: async ({ key }) => {
            publicRateLimitKeys.push(key);
            return { success: false };
          },
        },
      } as Bindings,
    );
    expect(publicRateLimit.status).toBe(429);
    expect(publicRateLimit.headers.get("ratelimit-limit")).toBe("5");
    expect(publicRateLimitKeys).toEqual([
      "public-profile-request:198.51.100.44",
    ]);
    const correctionResponse = await correction.json();
    const missingResponse = await missing.json();
    expect(correctionResponse).toEqual(missingResponse);
    expect(JSON.stringify(correctionResponse)).not.toContain(
      "requester@example.com",
    );
    expect(
      (await searchProfiles(database, { query: "Public Correction Unique" }))
        .results,
    ).toHaveLength(1);
    await expect(
      database
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.profileId, correctionProfile.profileId)),
    ).resolves.toEqual([
      expect.objectContaining({
        searchable: true,
        searchabilityReason: "approved_import",
      }),
    ]);

    await database
      .insert(schema.members)
      .values({ clerkId: "profile_request_operator" })
      .onConflictDoNothing();
    identity.sessions.set("profile_request_operator_session", {
      memberId: "profile_request_operator",
      organizationId: null,
      systemRole: "operator",
    });
    const correctionRequests = await database
      .select()
      .from(schema.profileRequests)
      .where(eq(schema.profileRequests.profileId, correctionProfile.profileId));
    expect(correctionRequests).toHaveLength(2);
    expect(correctionRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "awaiting_verification" }),
        expect.objectContaining({ status: "awaiting_verification" }),
      ]),
    );
    const [correctionRequest] = correctionRequests;
    if (!correctionRequest)
      throw new Error("Correction request fixture was not created");
    expect(correctionRequest.status).toBe("awaiting_verification");
    const verifiedCorrection = await app.request(
      `/v1/operator/profile-requests/${correctionRequest.id}/verify`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer profile_request_operator_session",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          reason: "Requester email ownership confirmed",
          verificationMethod: "verified-email-reply",
          evidenceReference: "support-case:correction-1",
        }),
      },
    );
    expect(verifiedCorrection.status).toBe(200);
    expect(
      (await searchProfiles(database, { query: "Public Correction Unique" }))
        .results,
    ).toHaveLength(0);
    const reviewedCorrection = await app.request(
      `/v1/operator/profile-requests/${correctionRequest.id}/review`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer profile_request_operator_session",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          approved: true,
          reason: "Requester evidence confirmed",
          correction: {
            currentCompany: "Correct Company",
            headline: "Corrected public headline",
            currentResidence: "Bogota, Colombia",
            roles: ["Platform Engineer"],
            skills: ["Rust"],
            seniority: "senior",
            experienceYears: 8,
            opportunityStatus: "open",
            professionalLinks: ["https://github.com/public-correction"],
          },
        }),
      },
    );
    expect(reviewedCorrection.status).toBe(200);
    await expect(
      database
        .select()
        .from(schema.profiles)
        .where(eq(schema.profiles.profileId, correctionProfile.profileId)),
    ).resolves.toEqual([
      expect.objectContaining({
        currentCompany: "Correct Company",
        searchable: true,
        searchabilityReason: "approved_import",
      }),
    ]);
    expect(
      (await searchProfiles(database, { skills: ["Rust"] })).results,
    ).toContainEqual(
      expect.objectContaining({
        profileId: correctionProfile.profileId,
        headline: "Corrected public headline",
        currentResidence: "Bogota, Colombia",
        primaryRole: "Platform Engineer",
        seniority: "senior",
        experienceYears: 8,
        opportunityStatus: "open",
      }),
    );

    const removal = await postPublicProfileRequest(
      app,
      removalProfile.profileId,
      "removal",
      "198.51.100.11",
    );
    expect(removal.status).toBe(202);
    const [removalRequest] = await database
      .select()
      .from(schema.profileRequests)
      .where(eq(schema.profileRequests.profileId, removalProfile.profileId));
    if (!removalRequest)
      throw new Error("Removal request fixture was not created");
    const verifiedRemoval = await app.request(
      `/v1/operator/profile-requests/${removalRequest.id}/verify`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer profile_request_operator_session",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          reason: "Requester identity confirmed",
          verificationMethod: "signed-github-proof",
          evidenceReference: "support-case:removal-1",
        }),
      },
    );
    expect(verifiedRemoval.status).toBe(200);
    const reviewedRemoval = await app.request(
      `/v1/operator/profile-requests/${removalRequest.id}/review`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer profile_request_operator_session",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          approved: true,
          reason: "Requester identity confirmed",
        }),
      },
    );
    expect(reviewedRemoval.status).toBe(200);

    const csv = `contract_version,source,source_record_id,name,current_company,github_account_id,github_login,qualifying_evidence,adult_confirmed,professional_links\nhumans-profiles-v1,api-reimport,83002,Recreated Profile,,83002,public-removal,owned_repository,true,https://github.com/public-removal`;
    const report = await importProfiles(database, csv, {
      dryRun: false,
      runId: "issue12_public_reimport",
    });
    expect(report.appliedChanges.createProfiles).toBe(0);
    await expect(
      database
        .select()
        .from(schema.suppressionRecords)
        .where(eq(schema.suppressionRecords.canonicalProviderId, "83002")),
    ).resolves.toHaveLength(1);
    expect(
      (await searchProfiles(database, { query: "Recreated Profile" })).results,
    ).toHaveLength(0);
    await database
      .delete(schema.importRuns)
      .where(eq(schema.importRuns.id, "issue12_public_reimport"));
  });

  it("limits public Profile requests by IP and rejects oversized bodies", async () => {
    for (let request = 0; request < 6; request += 1) {
      const response = await postPublicProfileRequest(
        app,
        crypto.randomUUID(),
        "correction",
        "198.51.100.99",
      );
      expect(response.status).toBe(request < 5 ? 202 : 429);
    }
    const oversized = await app.request("/v1/public/profile-requests", {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "198.51.100.100",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        profileReference: crypto.randomUUID(),
        kind: "correction",
        requesterEmail: "requester@example.com",
        details: "x".repeat(5_000),
      }),
    });
    expect(oversized.status).toBe(413);
  });

  it("requires the exact web proxy secret for public Profile requests when configured", async () => {
    const bindings = {
      WEB_PROXY_SECRET: "server-owned-proxy-secret",
    } as Bindings;

    for (const [suppliedSecret, stage] of [
      [undefined, undefined],
      ["forged-secret", "verified"],
      ["SERVER-OWNED-PROXY-SECRET", "verified"],
      [bindings.WEB_PROXY_SECRET, undefined],
      [bindings.WEB_PROXY_SECRET, "verification"],
    ] as const) {
      const response = await postPublicProfileRequest(
        app,
        crypto.randomUUID(),
        "correction",
        "198.51.100.101",
        bindings,
        suppliedSecret,
        stage,
      );
      expect(response.status).toBe(403);
    }

    const misconfiguredDeployment = await postPublicProfileRequest(
      app,
      crypto.randomUUID(),
      "correction",
      "198.51.100.101",
      { SENTRY_ENVIRONMENT: "production" } as Bindings,
    );
    expect(misconfiguredDeployment.status).toBe(403);

    const proxied = await postPublicProfileRequest(
      app,
      crypto.randomUUID(),
      "correction",
      "198.51.100.101",
      bindings,
      bindings.WEB_PROXY_SECRET,
      "verified",
    );
    expect(proxied.status).toBe(202);
  });

  it("limits Turnstile verification attempts before provider work", async () => {
    const keys: string[] = [];
    const proxySecret = "server-owned-proxy-secret";
    const bindings = {
      WEB_PROXY_SECRET: proxySecret,
      PUBLIC_PROFILE_VERIFICATION_RATE_LIMITER: {
        limit: async ({ key }) => {
          keys.push(key);
          return { success: false };
        },
      },
    } as Bindings;

    for (const stage of [undefined, "verified", "VERIFICATION"]) {
      const response = await app.request(
        "/v1/internal/public-profile-request-verifications",
        {
          method: "POST",
          headers: {
            "X-Humans-Client-IP": "203.0.113.25",
            "X-Humans-Web-Proxy": proxySecret,
            ...(stage === undefined
              ? {}
              : { "X-Humans-Public-Profile-Request": stage }),
          },
        },
        bindings,
      );
      expect(response.status).toBe(403);
    }

    const limited = await app.request(
      "/v1/internal/public-profile-request-verifications",
      {
        method: "POST",
        headers: {
          "X-Humans-Client-IP": "203.0.113.25",
          "X-Humans-Public-Profile-Request": "verification",
          "X-Humans-Web-Proxy": proxySecret,
        },
      },
      bindings,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("ratelimit-limit")).toBe("20");
    expect(keys).toEqual(["public-profile-verification:203.0.113.25"]);
  });

  it("verifies and translates signed Clerk webhooks", async () => {
    const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
    const timestamp = new Date();
    const payload = JSON.stringify({
      data: {
        email_addresses: [
          { email_address: "signed@example.com", id: "email_signed" },
        ],
        first_name: "Signed",
        id: "member_signed",
        image_url: "https://example.com/member.png",
        last_name: "Member",
        primary_email_address_id: "email_signed",
        updated_at: 42,
      },
      event_attributes: {
        http_request: { client_ip: "127.0.0.1", user_agent: "test" },
      },
      object: "event",
      type: "user.created",
    });
    const webhook = new Webhook(secret);
    const eventId = "evt_signed";
    const signature = webhook.sign(eventId, timestamp, payload);
    const event = await clerkIdentityBoundary.verifyWebhook(
      new Request("http://localhost/webhooks/clerk", {
        method: "POST",
        body: payload,
        headers: {
          "svix-id": eventId,
          "svix-signature": signature,
          "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
          "webhook-id": eventId,
          "webhook-signature": signature,
          "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
        },
      }),
      {
        CLERK_PUBLISHABLE_KEY: "pk_test_unused",
        CLERK_SECRET_KEY: "sk_test_unused",
        CLERK_WEBHOOK_SIGNING_SECRET: secret,
        DATABASE_URL: "postgresql://unused",
      },
    );

    expect(event).toEqual({
      id: eventId,
      sourceUpdatedAt: 42,
      type: "member.upsert",
      member: {
        clerkId: "member_signed",
        email: "signed@example.com",
        imageUrl: "https://example.com/member.png",
        name: "Signed Member",
      },
    });
  });

  it("previews and purchases Contact Reveals without logging values", async () => {
    await database.insert(schema.members).values([
      { clerkId: "reveal_owner", name: "Reveal Owner" },
      { clerkId: "reveal_member", name: "Reveal Member" },
    ]);
    await database.insert(schema.organizations).values({
      clerkId: "reveal_organization",
      name: "Reveal Organization",
    });
    await database.insert(schema.organizationEntitlements).values({
      organizationId: "reveal_organization",
      tier: "free",
      status: "active",
    });
    await database.insert(schema.memberFreeCreditClaims).values({
      memberId: "reveal_member",
      organizationId: "reveal_organization",
    });
    await database.insert(schema.organizationMemberships).values({
      clerkId: "reveal_membership",
      memberId: "reveal_member",
      organizationId: "reveal_organization",
      role: "org:member",
    });
    await database.insert(schema.profiles).values({
      profileId: "reveal_profile",
      memberId: "reveal_owner",
      name: "Reveal Profile",
      githubAccountId: "88001",
      githubLogin: "reveal-profile",
      eligibilityBasis: "owned_repository",
      adultAttested: true,
      searchable: true,
      searchabilityReason: "member_opt_in",
    });
    await database.insert(schema.profileObservations).values({
      id: "reveal_observation",
      profileId: "reveal_profile",
      field: "contact-detail",
      value: {
        type: "professional-email",
        value: "private@company.example",
      },
      source: "tikhub",
      sourceRecordId: "api_reveal_source",
      pipelineVersion: "tikhub-v1",
      confidence: 0.97,
    });
    await applyCreditEntry(database, {
      organizationId: "reveal_organization",
      idempotencyKey: "api:grant",
      kind: "grant",
      amount: 10,
    });
    identity.sessions.set("reveal_session", {
      memberId: "reveal_member",
      organizationId: "reveal_organization",
    });

    const previewResponse = await app.request("/v1/profiles/reveal_profile", {
      headers: { authorization: "Bearer reveal_session" },
    });
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    await expect(previewResponse.json()).resolves.toMatchObject({
      profile: {
        contactDetails: [
          {
            maskedValue: "p***@c***.example",
            price: 5,
            previouslyPurchased: false,
            sourceCategory: "professional-network",
            type: "professional-email",
          },
        ],
      },
    });

    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const purchaseResponse = await app.request(
      "/v1/profiles/reveal_profile/contact-reveals/email",
      {
        method: "POST",
        headers: {
          authorization: "Bearer reveal_session",
          "Idempotency-Key": "api:reveal",
        },
      },
    );
    expect(purchaseResponse.status).toBe(200);
    await expect(purchaseResponse.json()).resolves.toMatchObject({
      reveal: { price: 5, value: "private@company.example" },
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "private@company.example",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("p***@c***.example");
    log.mockRestore();
  });

  it("enforces API-key scopes, Credits, idempotency, and the stable v1 contract", async () => {
    await database.insert(schema.members).values([
      { clerkId: "external_member", name: "External Member" },
      { clerkId: "external_owner", name: "External Profile Owner" },
    ]);
    await database.insert(schema.organizations).values({
      clerkId: "external_organization",
      name: "External Organization",
    });
    await database.insert(schema.organizationEntitlements).values({
      organizationId: "external_organization",
      tier: "free",
      status: "active",
    });
    await database.insert(schema.memberFreeCreditClaims).values({
      memberId: "external_member",
      organizationId: "external_organization",
    });
    await database.insert(schema.organizationMemberships).values({
      clerkId: "external_membership",
      memberId: "external_member",
      organizationId: "external_organization",
      role: "org:member",
    });
    await database.insert(schema.profiles).values({
      profileId: "external_profile",
      memberId: "external_owner",
      name: "External Profile",
      githubAccountId: "88002",
      githubLogin: "external-profile",
      eligibilityBasis: "owned_repository",
      adultAttested: true,
      searchable: true,
      searchabilityReason: "member_opt_in",
    });
    await database.insert(schema.profileObservations).values([
      {
        id: "external_email",
        profileId: "external_profile",
        field: "contact-detail",
        value: {
          type: "professional-email",
          value: "external@company.example",
        },
        source: "tikhub",
        sourceRecordId: "external_email_source",
        pipelineVersion: "tikhub-v1",
        confidence: 0.99,
      },
      {
        id: "external_phone",
        profileId: "external_profile",
        field: "contact-detail",
        value: {
          type: "direct-professional-phone",
          value: "+57 300 555 0199",
        },
        source: "tikhub",
        sourceRecordId: "external_phone_source",
        pipelineVersion: "tikhub-v1",
        confidence: 0.98,
      },
    ]);
    await applyCreditEntry(database, {
      organizationId: "external_organization",
      idempotencyKey: "external:grant",
      kind: "grant",
      amount: 20,
    });
    identity.apiKeySessions.set("read_key", {
      keyId: "read_key_id",
      memberId: "external_member",
      organizationId: "external_organization",
      scopes: ["profiles:read"],
    });
    identity.apiKeySessions.set("reveal_key", {
      keyId: "reveal_key_id",
      memberId: "external_member",
      organizationId: "external_organization",
      scopes: ["profiles:read", "contacts:reveal"],
    });
    identity.apiKeySessions.set("unscoped_key", {
      keyId: "unscoped_key_id",
      memberId: "external_member",
      organizationId: "external_organization",
      scopes: [],
    });

    const mcpInitialization = await app.request("/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer read_key",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "Humans contract test", version: "1.0.0" },
        },
      }),
    });
    expect(mcpInitialization.status).toBe(200);
    await expect(mcpInitialization.json()).resolves.toMatchObject({
      result: { serverInfo: { name: "Humans", version: "1.0.0" } },
    });

    const mcpTools = await callMcpTool(app, "read_key", "tools/list", {});
    expect(mcpTools.status).toBe(200);
    expect(mcpTools.headers.get("cache-control")).toBe("private, no-store");
    await expect(mcpTools.json()).resolves.toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "search_profiles" }),
          expect.objectContaining({ name: "reveal_profile_email" }),
        ]),
      },
    });

    const unscoped = await app.request("/v1/profiles?q=External", {
      headers: {
        authorization: "Bearer unscoped_key",
        "Idempotency-Key": "external:unscoped",
      },
    });
    expect(unscoped.status).toBe(403);
    const broad = await app.request("/v1/profiles", {
      headers: {
        authorization: "Bearer read_key",
        "Idempotency-Key": "external:broad",
      },
    });
    expect(broad.status).toBe(422);
    const disguisedBroad = await app.request("/v1/profiles?role=%2C&q=%20", {
      headers: {
        authorization: "Bearer read_key",
        "Idempotency-Key": "external:disguised-broad",
      },
    });
    expect(disguisedBroad.status).toBe(422);
    const emptyStructured = await app.request("/v1/search", {
      method: "POST",
      headers: {
        authorization: "Bearer read_key",
        "content-type": "application/json",
        "Idempotency-Key": "external:empty-structured",
      },
      body: JSON.stringify({ filters: { roles: [] } }),
    });
    expect(emptyStructured.status).toBe(422);
    identity.sessions.set("external_session", {
      memberId: "external_member",
      organizationId: "external_organization",
    });
    const createdList = await app.request("/v1/saved-lists", {
      method: "POST",
      headers: {
        authorization: "Bearer external_session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Protected list" }),
    });
    expect(createdList.status).toBe(201);
    expect(createdList.headers.get("cache-control")).toBe("private, no-store");
    expect(createdList.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const listedLists = await app.request("/v1/saved-lists", {
      headers: { authorization: "Bearer external_session" },
    });
    expect(listedLists.status).toBe(200);
    expect(listedLists.headers.get("cache-control")).toBe("private, no-store");
    expect(listedLists.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    await expect(listedLists.json()).resolves.toMatchObject({
      lists: [expect.objectContaining({ name: "Protected list" })],
    });
    const broadWebSearch = await app.request("/v1/profiles/search", {
      headers: { authorization: "Bearer external_session" },
    });
    expect(broadWebSearch.status).toBe(400);

    const exportAttempt = await app.request("/v1/contact-details/export", {
      method: "POST",
      headers: {
        authorization: "Bearer reveal_key",
        "content-type": "application/json",
        "X-Correlation-ID": "export-correlation",
      },
      body: JSON.stringify({
        profileId: "external_profile",
        fields: ["email"],
      }),
    });
    expect(exportAttempt.status).toBe(405);
    const [exportAudit] = await database
      .select()
      .from(schema.securityAuditEvents)
      .where(
        eq(schema.securityAuditEvents.correlationId, "export-correlation"),
      );
    expect(exportAudit).toMatchObject({
      eventType: "attempted_export",
      actorMemberId: "external_member",
      organizationId: "external_organization",
      apiKeyId: "reveal_key_id",
      profileId: "external_profile",
      source: "api",
      result: "rejected",
    });
    expect(JSON.stringify(exportAudit)).not.toContain(
      "external@company.example",
    );

    const listResponse = await app.request("/v1/profiles?q=External", {
      headers: {
        authorization: "Bearer read_key",
        "Idempotency-Key": "external:list",
      },
    });
    expect(listResponse.status).toBe(200);
    expect(listResponse.headers.get("ratelimit-limit")).toBe("60");
    await expect(listResponse.json()).resolves.toMatchObject({
      results: [{ profileId: "external_profile" }],
    });
    const replay = await app.request("/v1/profiles?q=External", {
      headers: {
        authorization: "Bearer read_key",
        "Idempotency-Key": "external:list",
      },
    });
    expect(replay.status).toBe(200);
    expect(await getCreditBalance(database, "external_organization")).toBe(19);
    const mcpSearch = await callMcpTool(app, "read_key", "tools/call", {
      name: "search_profiles",
      arguments: {
        filters: { query: "External" },
        idempotencyKey: "mcp:external:search",
      },
    });
    await expect(mcpSearch.json()).resolves.toMatchObject({
      result: {
        isError: false,
        structuredContent: {
          results: [{ profileId: "external_profile" }],
          rateLimit: { limit: "60" },
        },
      },
    });
    expect(await getCreditBalance(database, "external_organization")).toBe(18);
    const conflict = await app.request("/v1/profiles?q=Profile", {
      headers: {
        authorization: "Bearer read_key",
        "Idempotency-Key": "external:list",
      },
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: {
        code: "idempotency_conflict",
        message: "The idempotency key was already used",
      },
    });

    const facets = await app.request("/v1/search/facets", {
      headers: { authorization: "Bearer read_key" },
    });
    expect(facets.status).toBe(200);
    const mcpFacets = await callMcpTool(app, "read_key", "tools/call", {
      name: "list_search_facets",
      arguments: {},
    });
    await expect(mcpFacets.json()).resolves.toMatchObject({
      result: { isError: false, structuredContent: { facets: {} } },
    });
    expect(await getCreditBalance(database, "external_organization")).toBe(18);

    const detail = await app.request("/v1/profiles/external_profile", {
      headers: { authorization: "Bearer read_key" },
    });
    expect(detail.status).toBe(200);
    const mcpDetail = await callMcpTool(app, "read_key", "tools/call", {
      name: "get_profile",
      arguments: { profileId: "external_profile" },
    });
    await expect(mcpDetail.json()).resolves.toMatchObject({
      result: {
        isError: false,
        structuredContent: {
          profile: { profileId: "external_profile" },
        },
      },
    });
    const missingDetail = await app.request("/v1/profiles/missing_profile", {
      headers: { authorization: "Bearer read_key" },
    });
    expect(missingDetail.status).toBe(404);
    await expect(missingDetail.json()).resolves.toEqual({
      error: { code: "not_found", message: "Profile was not found" },
    });

    await database.insert(schema.members).values({
      clerkId: "empty_credit_member",
      name: "Empty Credit Member",
    });
    await database.insert(schema.organizations).values({
      clerkId: "empty_credit_organization",
      name: "Empty Credit Organization",
    });
    await database.insert(schema.organizationEntitlements).values({
      organizationId: "empty_credit_organization",
      tier: "free",
      status: "active",
    });
    await database.insert(schema.memberFreeCreditClaims).values({
      memberId: "empty_credit_member",
      organizationId: "empty_credit_organization",
    });
    await database.insert(schema.organizationMemberships).values({
      clerkId: "empty_credit_membership",
      memberId: "empty_credit_member",
      organizationId: "empty_credit_organization",
      role: "org:member",
    });
    identity.apiKeySessions.set("empty_credit_key", {
      keyId: "empty_credit_key_id",
      memberId: "empty_credit_member",
      organizationId: "empty_credit_organization",
      scopes: ["profiles:read"],
    });
    const insufficientCredits = await app.request("/v1/profiles?q=External", {
      headers: {
        authorization: "Bearer empty_credit_key",
        "Idempotency-Key": "external:no-credits",
      },
    });
    expect(insufficientCredits.status).toBe(402);
    await expect(insufficientCredits.json()).resolves.toEqual({
      error: {
        code: "insufficient_credits",
        message: "The Organization has insufficient Credits",
      },
    });

    const forbiddenReveal = await app.request(
      "/v1/profiles/external_profile/reveal-email",
      {
        method: "POST",
        headers: {
          authorization: "Bearer read_key",
          "Idempotency-Key": "external:forbidden-reveal",
        },
      },
    );
    expect(forbiddenReveal.status).toBe(403);
    const reveal = await app.request(
      "/v1/profiles/external_profile/reveal-email",
      {
        method: "POST",
        headers: {
          authorization: "Bearer reveal_key",
          "Idempotency-Key": "external:reveal",
        },
      },
    );
    expect(reveal.status).toBe(200);
    await expect(reveal.json()).resolves.toMatchObject({
      reveal: { value: "external@company.example", price: 5 },
    });
    expect(await getCreditBalance(database, "external_organization")).toBe(13);
    const reopenedReveal = await app.request(
      "/v1/profiles/external_profile/reveal-email",
      {
        method: "POST",
        headers: {
          authorization: "Bearer reveal_key",
          "Idempotency-Key": "external:reveal:reopened",
        },
      },
    );
    await expect(reopenedReveal.json()).resolves.toMatchObject({
      reveal: { value: "external@company.example", price: 0 },
    });
    const mcpEmail = await callMcpTool(app, "reveal_key", "tools/call", {
      name: "reveal_profile_email",
      arguments: {
        profileId: "external_profile",
        idempotencyKey: "mcp:external:email",
      },
    });
    await expect(mcpEmail.json()).resolves.toMatchObject({
      result: {
        isError: false,
        structuredContent: {
          reveal: { value: "external@company.example", price: 0 },
        },
      },
    });
    const phoneReveal = await app.request(
      "/v1/profiles/external_profile/reveal-phone",
      {
        method: "POST",
        headers: {
          authorization: "Bearer reveal_key",
          "Idempotency-Key": "external:reveal:phone",
        },
      },
    );
    expect(phoneReveal.status).toBe(200);
    await expect(phoneReveal.json()).resolves.toMatchObject({
      reveal: { value: "+57 300 555 0199", price: 10 },
    });
    const mcpPhone = await callMcpTool(app, "reveal_key", "tools/call", {
      name: "reveal_profile_phone",
      arguments: {
        profileId: "external_profile",
        idempotencyKey: "mcp:external:phone",
      },
    });
    await expect(mcpPhone.json()).resolves.toMatchObject({
      result: {
        isError: false,
        structuredContent: {
          reveal: { value: "+57 300 555 0199", price: 0 },
        },
      },
    });
    await applyCreditEntry(database, {
      organizationId: "external_organization",
      idempotencyKey: "external:natural-grant",
      kind: "grant",
      amount: 20,
    });

    const naturalApp = createApp(
      () => makeDatabaseLayer(database),
      identity,
      async () => ({
        language: "en",
        filters: { query: "External" },
      }),
    );
    for (let request = 0; request < 10; request += 1) {
      const response = await naturalApp.request("/v1/search", {
        method: "POST",
        headers: {
          authorization: "Bearer read_key",
          "content-type": "application/json",
          "Idempotency-Key": `external:natural:${request}`,
        },
        body: JSON.stringify({ query: "TypeScript builders" }),
      });
      expect(response.status).toBe(200);
    }
    const naturalLimit = await naturalApp.request("/v1/search", {
      method: "POST",
      headers: {
        authorization: "Bearer read_key",
        "content-type": "application/json",
        "Idempotency-Key": "external:natural:limited",
      },
      body: JSON.stringify({ query: "TypeScript builders" }),
    });
    expect(naturalLimit.status).toBe(429);
    expect(naturalLimit.headers.get("ratelimit-limit")).toBe("10");
    expect(naturalLimit.headers.get("retry-after")).not.toBeNull();

    const webNaturalApp = createApp(
      () => makeDatabaseLayer(database),
      identity,
      async () => ({
        language: "en",
        filters: { query: "External" },
      }),
    );
    for (let request = 0; request < 10; request += 1) {
      const response = await webNaturalApp.request(
        "/v1/profiles/search/interpret",
        {
          method: "POST",
          headers: {
            authorization: "Bearer external_session",
            "content-type": "application/json",
          },
          body: JSON.stringify({ query: "TypeScript builders" }),
        },
      );
      expect(response.status).toBe(200);
    }
    const webNaturalLimit = await webNaturalApp.request(
      "/v1/profiles/search/interpret",
      {
        method: "POST",
        headers: {
          authorization: "Bearer external_session",
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: "TypeScript builders" }),
      },
    );
    expect(webNaturalLimit.status).toBe(429);
    expect(webNaturalLimit.headers.get("ratelimit-limit")).toBe("10");

    const dimensionApp = createApp(() => makeDatabaseLayer(database), identity);
    const dimensionKeys: string[] = [];
    const distributedLimiter = {
      limit: async ({ key }: { key: string }) => {
        dimensionKeys.push(key);
        return { success: true };
      },
    };
    const rateBindings = {
      MEMBER_RATE_LIMITER: distributedLimiter,
      ORGANIZATION_RATE_LIMITER: distributedLimiter,
      API_KEY_RATE_LIMITER: distributedLimiter,
      IP_RATE_LIMITER: distributedLimiter,
    } as Bindings;
    const dimensionResponse = await dimensionApp.request(
      "/v1/search/facets",
      {
        headers: {
          authorization: "Bearer read_key",
          "CF-Connecting-IP": "203.0.113.10",
        },
      },
      rateBindings,
    );
    expect(dimensionResponse.status).toBe(200);
    expect(dimensionKeys).toEqual(
      expect.arrayContaining([
        "member:external_member",
        "organization:external_organization",
        "api-key:read_key_id",
        "ip:203.0.113.10",
      ]),
    );
    dimensionKeys.length = 0;
    const mcpDimensionResponse = await dimensionApp.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer read_key",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-06-18",
          "X-Humans-Client-IP": "198.51.100.28",
          "X-Humans-Web-Proxy": "server-owned-proxy-secret",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_search_facets", arguments: {} },
        }),
      },
      {
        ...rateBindings,
        WEB_PROXY_SECRET: "server-owned-proxy-secret",
      },
    );
    expect(mcpDimensionResponse.status).toBe(200);
    expect([...dimensionKeys].sort()).toEqual(
      [
        "api-key:read_key_id",
        "ip:198.51.100.28",
        "member:external_member",
        "organization:external_organization",
      ].sort(),
    );
    const rateLimitApp = createApp(() => makeDatabaseLayer(database), identity);
    for (let request = 0; request < 60; request += 1) {
      const response = await rateLimitApp.request("/v1/search/facets", {
        headers: { authorization: "Bearer read_key" },
      });
      expect(response.status).toBe(200);
    }
    const organizationLimit = await rateLimitApp.request("/v1/search/facets", {
      headers: { authorization: "Bearer read_key" },
    });
    expect(organizationLimit.status).toBe(429);
    expect(organizationLimit.headers.get("ratelimit-limit")).toBe("60");

    await database.insert(schema.suppressionRecords).values({
      canonicalProvider: "github",
      canonicalProviderId: "88002",
      reason: "removal_request",
    });
    const suppressed = await app.request("/v1/profiles/external_profile", {
      headers: { authorization: "Bearer read_key" },
    });
    expect(suppressed.status).toBe(404);

    const operatorApp = createApp(() => makeDatabaseLayer(database), identity);
    await database
      .insert(schema.members)
      .values({ clerkId: "system_operator" })
      .onConflictDoNothing();
    identity.sessions.set("operator_session", {
      memberId: "system_operator",
      organizationId: null,
      systemRole: "operator",
    });
    const [failedUsage] = await database
      .select({ id: schema.creditUsageOutbox.id })
      .from(schema.creditUsageOutbox)
      .limit(1);
    if (!failedUsage) throw new Error("Expected finalized Credit usage");
    await database
      .update(schema.creditUsageOutbox)
      .set({ state: "failed", attempts: 8, lastErrorCode: "invalid_request" })
      .where(eq(schema.creditUsageOutbox.id, failedUsage.id));
    const suspended = await operatorApp.request("/v1/operator/suspensions", {
      method: "POST",
      headers: {
        authorization: "Bearer operator_session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        principalType: "organization",
        principalId: "external_organization",
        reason: "credential abuse",
      }),
    });
    expect(suspended.status).toBe(201);
    identity.sessions.set("organization_admin_session", {
      memberId: "external_member",
      organizationId: "external_organization",
    });
    const operatorOverview = await operatorApp.request(
      "/v1/operator/overview",
      { headers: { authorization: "Bearer operator_session" } },
    );
    expect(operatorOverview.status).toBe(200);
    await expect(operatorOverview.json()).resolves.toMatchObject({
      imports: [],
      claims: [],
      creditUsageDeadLetters: [
        expect.objectContaining({ id: failedUsage.id, attempts: 8 }),
      ],
      abuse: {
        suspensions: [
          expect.objectContaining({ principalId: "external_organization" }),
        ],
      },
    });
    const adminOverview = await operatorApp.request("/v1/operator/overview", {
      headers: { authorization: "Bearer organization_admin_session" },
    });
    expect(adminOverview.status).toBe(401);
    const adminMutation = await operatorApp.request(
      "/v1/operator/suspensions",
      {
        method: "POST",
        headers: {
          authorization: "Bearer organization_admin_session",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          principalType: "member",
          principalId: "someone_else",
          reason: "not authorized",
        }),
      },
    );
    expect(adminMutation.status).toBe(401);
    const adminRedrive = await operatorApp.request(
      "/v1/operator/credit-usage/redrive",
      {
        method: "POST",
        headers: {
          authorization: "Bearer organization_admin_session",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ids: [failedUsage.id],
          reason: "not authorized",
        }),
      },
    );
    expect(adminRedrive.status).toBe(401);
    const redrive = await operatorApp.request(
      "/v1/operator/credit-usage/redrive",
      {
        method: "POST",
        headers: {
          authorization: "Bearer operator_session",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ids: [failedUsage.id],
          reason: "Provider mapping repaired",
        }),
      },
    );
    expect(redrive.status).toBe(200);
    await expect(redrive.json()).resolves.toEqual({ redriven: 1 });
    await expect(
      database
        .select({ state: schema.creditUsageOutbox.state })
        .from(schema.creditUsageOutbox)
        .where(eq(schema.creditUsageOutbox.id, failedUsage.id)),
    ).resolves.toEqual([{ state: "pending" }]);
    await expect(
      database
        .select({ action: schema.operatorAuditEvents.action })
        .from(schema.operatorAuditEvents)
        .where(eq(schema.operatorAuditEvents.subjectId, failedUsage.id)),
    ).resolves.toEqual([{ action: "credit_usage.redrive" }]);
    const deniedAfterSuspension = await operatorApp.request(
      "/v1/search/facets",
      { headers: { authorization: "Bearer read_key" } },
    );
    expect(deniedAfterSuspension.status).toBe(403);
    const deniedInterpretation = await operatorApp.request(
      "/v1/profiles/search/interpret",
      {
        method: "POST",
        headers: {
          authorization: "Bearer external_session",
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: "TypeScript builders" }),
      },
    );
    expect(deniedInterpretation.status).toBe(403);
  });

  it("denies suspended Operators while active Operators retain access", async () => {
    await database
      .insert(schema.members)
      .values([
        { clerkId: "active_system_operator" },
        { clerkId: "suspended_system_operator" },
      ]);
    await database.insert(schema.principalSuspensions).values({
      principalType: "member",
      principalId: "suspended_system_operator",
      reason: "privacy audit regression fixture",
    });
    identity.sessions.set("active_operator_session", {
      memberId: "active_system_operator",
      organizationId: null,
      systemRole: "operator",
    });
    identity.sessions.set("suspended_operator_session", {
      memberId: "suspended_system_operator",
      organizationId: null,
      systemRole: "operator",
    });

    const activeOverview = await app.request("/v1/operator/overview", {
      headers: { authorization: "Bearer active_operator_session" },
    });
    expect(activeOverview.status).toBe(200);
    const activeMutation = await app.request("/v1/operator/suspensions", {
      method: "POST",
      headers: {
        authorization: "Bearer active_operator_session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        principalType: "api_key",
        principalId: "active_operator_mutation_target",
        reason: "active Operator authorization check",
      }),
    });
    expect(activeMutation.status).toBe(201);

    const suspendedOverview = await app.request("/v1/operator/overview", {
      headers: { authorization: "Bearer suspended_operator_session" },
    });
    expect(suspendedOverview.status).toBe(401);
    const suspendedMutation = await app.request("/v1/operator/suspensions", {
      method: "POST",
      headers: {
        authorization: "Bearer suspended_operator_session",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        principalType: "api_key",
        principalId: "suspended_operator_mutation_target",
        reason: "must not be written",
      }),
    });
    expect(suspendedMutation.status).toBe(401);
    await expect(
      database
        .select()
        .from(schema.principalSuspensions)
        .where(
          eq(
            schema.principalSuspensions.principalId,
            "suspended_operator_mutation_target",
          ),
        ),
    ).resolves.toHaveLength(0);
  });
});

const postWebhook = async (
  app: ReturnType<typeof createApp>,
  event: ClerkProjectionEvent,
) => {
  const response = await app.request("/webhooks/clerk", {
    method: "POST",
    body: JSON.stringify(event),
  });
  expect(response.status).toBe(200);
  return response.json();
};

const callMcpTool = (
  app: ReturnType<typeof createApp>,
  apiKey: string,
  method: string,
  params: Record<string, unknown>,
) =>
  app.request("/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

const invitedProjection: ProvisionedWorkspace = {
  member: {
    clerkId: "invited_member",
    email: "invited@example.com",
    imageUrl: null,
    name: "Invited Member",
  },
  membership: {
    clerkId: "invited_membership",
    memberId: "invited_member",
    organizationId: "inviting_organization",
    role: "org:member",
  },
  organization: {
    clerkId: "inviting_organization",
    name: "Inviting Organization",
    slug: "inviting-organization",
  },
};

class FakeIdentity implements IdentityBoundary {
  readonly github = new Map<string, GitHubVerification>();
  readonly linkedIn = new Map<
    string,
    { providerUserId: string; username: string }
  >();
  readonly sessions = new Map<string, SessionIdentity>();
  readonly apiKeySessions = new Map<string, ApiKeyIdentity>();
  readonly apiKeys = new Map<
    string,
    OrganizationApiKey & { secret?: string }
  >();
  readonly organizations = new Map<string, ProvisionedWorkspace>();
  personalOrganizationsCreated = 0;

  async authenticate(request: Request) {
    const token = request.headers.get("authorization")?.replace("Bearer ", "");
    const session =
      token === undefined ? null : (this.sessions.get(token) ?? null);
    return session
      ? {
          emailVerified: true,
          botProtectionVerified: true,
          ...session,
        }
      : null;
  }

  async authenticateApiKey(request: Request) {
    const token = request.headers.get("authorization")?.replace("Bearer ", "");
    return token === undefined
      ? null
      : (this.apiKeySessions.get(token) ?? null);
  }

  async createOrganizationApiKey(input: {
    memberId: string;
    organizationId: string;
    name: string;
    description?: string;
    scopes: ApiScope[];
    secondsUntilExpiration?: number;
  }) {
    const id = `key_${this.apiKeys.size + 1}`;
    const key = {
      id,
      name: input.name,
      description: input.description ?? null,
      scopes: input.scopes,
      revoked: false,
      expired: false,
      expiration: input.secondsUntilExpiration
        ? Date.now() + input.secondsUntilExpiration * 1000
        : null,
      createdAt: Date.now(),
      secret: `secret_${id}`,
    };
    this.apiKeys.set(id, key);
    return key;
  }

  async listOrganizationApiKeys() {
    return [...this.apiKeys.values()].map(({ secret: _, ...key }) => key);
  }

  async revokeOrganizationApiKey(_organizationId: string, apiKeyId: string) {
    const key = this.apiKeys.get(apiKeyId);
    if (!key) return null;
    const revoked = { ...key, revoked: true };
    this.apiKeys.set(apiKeyId, revoked);
    const { secret: _, ...result } = revoked;
    return result;
  }

  async verifyWebhook(request: Request) {
    return (await request.json()) as ClerkProjectionEvent;
  }

  async provisionPersonalOrganization(memberId: string) {
    const existing = this.organizations.get(memberId);
    if (existing !== undefined) return existing;

    this.personalOrganizationsCreated += 1;
    const projection: ProvisionedWorkspace = {
      member: {
        clerkId: memberId,
        email: `${memberId}@example.com`,
        imageUrl: null,
        name: "New Member",
      },
      membership: {
        clerkId: `membership_${memberId}`,
        memberId,
        organizationId: `personal_${memberId}`,
        role: "org:admin",
      },
      organization: {
        clerkId: `personal_${memberId}`,
        name: "Personal Organization",
        slug: `personal-${memberId}`,
      },
    };
    this.organizations.set(memberId, projection);
    return projection;
  }

  async verifyGitHub(memberId: string) {
    const verification = this.github.get(memberId);
    if (verification === undefined) throw new Error("GitHub is not connected");
    return verification;
  }

  async verifyLinkedIn(memberId: string) {
    return this.linkedIn.get(memberId) ?? null;
  }
}

const validProfile = {
  name: "Member A",
  currentCompany: null,
  professionalLinks: ["https://github.com/member-a"],
  statements: {
    location: "Medellin, Colombia",
    role: "Software engineer",
    skills: ["TypeScript", "PostgreSQL"],
  },
  adultAttestation: true,
  privateCodeAttestation: false,
  searchable: false,
};

const githubVerification = (): GitHubVerification => ({
  accountId: "12345",
  login: "member-a",
  accountType: "User",
  ownsNonForkRepository: true,
  contributedPubliclySince: null,
  ownershipVerified: true,
  knownMinor: false,
});

const putProfile = (
  app: ReturnType<typeof createApp>,
  session: string,
  profile: typeof validProfile,
) =>
  app.request("/v1/profile", {
    method: "PUT",
    headers: {
      authorization: `Bearer ${session}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(profile),
  });

const postProfileClaim = (
  app: ReturnType<typeof createApp>,
  session: string,
  profileReference: string,
) =>
  app.request("/v1/profile/claims", {
    method: "POST",
    headers: {
      authorization: `Bearer ${session}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ profileReference }),
  });

const postPublicProfileRequest = (
  app: ReturnType<typeof createApp>,
  profileReference: string,
  kind: "correction" | "removal",
  ip: string,
  bindings?: Bindings,
  proxySecret?: string,
  stage?: string,
) =>
  app.request(
    "/v1/public/profile-requests",
    {
      method: "POST",
      headers: {
        "CF-Connecting-IP": ip,
        "content-type": "application/json",
        ...(proxySecret === undefined
          ? {}
          : { "X-Humans-Web-Proxy": proxySecret }),
        ...(stage === undefined
          ? {}
          : { "X-Humans-Public-Profile-Request": stage }),
      },
      body: JSON.stringify({
        profileReference,
        kind,
        requesterEmail: "requester@example.com",
        details: "Please review this Profile request.",
      }),
    },
    bindings,
  );
