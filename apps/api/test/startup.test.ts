import { expect, it, vi } from "vitest";

import {
  type Bindings,
  createApp,
  deployedApiConfigurationValid,
} from "../src/app";
import { clerkIdentityBoundary } from "../src/clerk";
import { createPolarBoundary } from "../src/polar";

it("initializes without generating randomness at module scope", () => {
  const randomUUID = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    throw new Error("Randomness is unavailable during Worker initialization");
  });

  expect(() =>
    createApp(() => {
      throw new Error("The database is unavailable during initialization");
    }),
  ).not.toThrow();
  expect(randomUUID).not.toHaveBeenCalled();
});

it("permits browser API preflights only from trusted web origins", async () => {
  const app = createApp(
    () => {
      throw new Error("CORS requests must not initialize the database");
    },
    {
      ...clerkIdentityBoundary,
      authenticate: async () => null,
      authenticateApiKey: async () => null,
    },
  );
  const preflight = (
    origin: string,
    environment: "local" | "preview" | "production",
  ) =>
    app.request(
      "https://api.humns.co/v1/profiles/search",
      {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Headers": "authorization,idempotency-key",
          "Access-Control-Request-Method": "GET",
        },
      },
      { SENTRY_ENVIRONMENT: environment } as Bindings,
    );

  const production = await preflight(
    "https://humns.co",
    "production",
  );
  expect(production.status).toBe(204);
  expect(production.headers.get("access-control-allow-origin")).toBe(
    "https://humns.co",
  );

  const retiringProduction = await preflight(
    "https://humans.crafter.run",
    "production",
  );
  expect(retiringProduction.status).toBe(204);
  expect(retiringProduction.headers.get("access-control-allow-origin")).toBe(
    "https://humans.crafter.run",
  );
  expect(production.headers.get("access-control-allow-headers")).toBe(
    "Authorization, Content-Type, Idempotency-Key",
  );

  const unauthenticated = await app.request(
    "https://api.humns.co/v1/profiles/search?q=anthony",
    { headers: { Origin: "https://humns.co" } },
    { SENTRY_ENVIRONMENT: "production" } as Bindings,
  );
  expect(unauthenticated.status).toBe(401);
  expect(unauthenticated.headers.get("access-control-allow-origin")).toBe(
    "https://humns.co",
  );

  const preview = await preflight(
    "https://humans-abcdef123-crafter-station.vercel.app",
    "preview",
  );
  expect(preview.status).toBe(204);
  expect(preview.headers.get("access-control-allow-origin")).toBe(
    "https://humans-abcdef123-crafter-station.vercel.app",
  );

  const local = await preflight("http://localhost:3000", "local");
  expect(local.status).toBe(204);
  expect(local.headers.get("access-control-allow-origin")).toBe(
    "http://localhost:3000",
  );

  const untrusted = await preflight("https://attacker.example", "production");
  expect(untrusted.status).toBe(403);
  expect(untrusted.headers.has("access-control-allow-origin")).toBe(false);
});

it("reports caught service failures without request data", async () => {
  const failure = new Error("database unavailable");
  const report = vi.fn();
  const app = createApp(
    () => {
      throw failure;
    },
    undefined,
    undefined,
    undefined,
    report,
  );

  const response = await app.request("/health", {
    headers: { "X-Correlation-ID": "release-verification" },
  });

  expect(response.status).toBe(503);
  expect(report).toHaveBeenCalledWith(failure, {
    correlationId: "release-verification",
    operation: "health.check",
  });
});

it("fails deployed health checks when required billing is not configured", async () => {
  const report = vi.fn();
  const app = createApp(
    () => {
      throw new Error("The database should not be reached");
    },
    undefined,
    undefined,
    undefined,
    report,
  );

  const response = await app.request("/health", {}, {
    BILLING_REQUIRED: "true",
  } as Bindings);

  expect(response.status).toBe(503);
  expect(report).toHaveBeenCalledWith(expect.any(Error), {
    correlationId: undefined,
    operation: "health.check",
  });
});

it("fails deployed health checks when non-billing configuration is incomplete", async () => {
  const app = createApp(
    () => {
      throw new Error("The database should not be reached");
    },
    undefined,
    undefined,
    createPolarBoundary(),
  );

  const response = await app.request("/health", {}, {
    BILLING_REQUIRED: "true",
    BILLING_APP_ORIGIN: "https://preview.example.com",
    POLAR_ACCESS_TOKEN: "polar_access_token",
    POLAR_BASE_URL: "https://sandbox-api.polar.sh/v1",
    POLAR_ORGANIZATION_ID: "11111111-1111-4111-8111-111111111111",
    POLAR_PRO_PRODUCT_ID: "22222222-2222-4222-8222-222222222222",
    POLAR_CUSTOMER_OWNER_EMAIL: "billing@humans.example",
    POLAR_USAGE_METER_ID: "33333333-3333-4333-8333-333333333333",
    POLAR_USAGE_EVENT_NAME: "humans_credit_usage",
    POLAR_WEBHOOK_SECRET: "polar_webhook_secret",
  } as Bindings);

  expect(response.status).toBe(503);
});

it("validates deployed service bindings structurally and by environment", () => {
  const rateLimitBinding = { limit: async () => ({ success: true }) };
  const production = {
    API_KEY_RATE_LIMITER: rateLimitBinding,
    BILLING_REQUIRED: "true",
    CLERK_BOT_PROTECTION_ENABLED: "true",
    CLERK_PUBLISHABLE_KEY: `pk_live_${"a".repeat(24)}`,
    CLERK_SECRET_KEY: `sk_live_${"b".repeat(24)}`,
    CLERK_WEBHOOK_SIGNING_SECRET: `whsec_${"c".repeat(24)}`,
    CF_VERSION_METADATA: { id: "11111111-1111-4111-8111-111111111111" },
    DATABASE_URL:
      "postgresql://humans:password@ep-jolly-night-au0ic7nb-pooler.c-10.us-east-1.aws.neon.tech/humans?sslmode=require",
    IP_RATE_LIMITER: rateLimitBinding,
    MEMBER_RATE_LIMITER: rateLimitBinding,
    NATURAL_SEARCH_RATE_LIMITER: rateLimitBinding,
    ORGANIZATION_RATE_LIMITER: rateLimitBinding,
    PUBLIC_PROFILE_REQUEST_RATE_LIMITER: rateLimitBinding,
    PUBLIC_PROFILE_VERIFICATION_RATE_LIMITER: rateLimitBinding,
    SEARCH_CURSOR_SECRET: "d".repeat(32),
    SENTRY_DSN: "https://public@o1.ingest.us.sentry.io/4512020552089600",
    SENTRY_ENVIRONMENT: "production",
    SENTRY_RELEASE: "e".repeat(40),
    WEB_PROXY_SECRET: "f".repeat(16),
  } satisfies Partial<Bindings>;
  expect(deployedApiConfigurationValid(production as Bindings)).toBe(true);

  for (const [name, value] of [
    ["CLERK_PUBLISHABLE_KEY", "x"],
    ["CLERK_SECRET_KEY", "x"],
    ["CLERK_WEBHOOK_SIGNING_SECRET", "x"],
    ["DATABASE_URL", "postgresql://example.invalid/humans"],
    ["SEARCH_CURSOR_SECRET", "x"],
    ["SENTRY_DSN", "https://public@example.invalid/1"],
    ["WEB_PROXY_SECRET", "x"],
  ] as const) {
    expect(
      deployedApiConfigurationValid({
        ...production,
        [name]: value,
      } as Bindings),
      name,
    ).toBe(false);
  }

  for (const name of [
    "API_KEY_RATE_LIMITER",
    "IP_RATE_LIMITER",
    "MEMBER_RATE_LIMITER",
    "NATURAL_SEARCH_RATE_LIMITER",
    "ORGANIZATION_RATE_LIMITER",
    "PUBLIC_PROFILE_REQUEST_RATE_LIMITER",
    "PUBLIC_PROFILE_VERIFICATION_RATE_LIMITER",
  ] as const) {
    expect(
      deployedApiConfigurationValid({
        ...production,
        [name]: undefined,
      } as Bindings),
      name,
    ).toBe(false);
  }

  expect(
    deployedApiConfigurationValid({
      ...production,
      CLERK_PUBLISHABLE_KEY: `pk_test_${"a".repeat(24)}`,
    } as Bindings),
  ).toBe(false);
  expect(
    deployedApiConfigurationValid({
      ...production,
      DATABASE_URL:
        "postgresql://humans:password@ep-sweet-tree-aubos9m6-pooler.c-10.us-east-1.aws.neon.tech/humans?sslmode=require",
    } as Bindings),
  ).toBe(false);
  expect(
    deployedApiConfigurationValid({
      ...production,
      SENTRY_DSN: "https://public@o1.ingest.us.sentry.io/4512020599144448",
    } as Bindings),
  ).toBe(false);
});

it("does not report arbitrary client text as a correlation tag", async () => {
  const failure = new Error("database unavailable");
  const report = vi.fn();
  const app = createApp(
    () => {
      throw failure;
    },
    undefined,
    undefined,
    undefined,
    report,
  );

  await app.request(
    "/health",
    {
      headers: {
        "X-Correlation-ID": "sk_live_private_value_that_must_not_be_tagged",
      },
    },
    { WEB_PROXY_SECRET: "server-owned-proxy-secret" } as Bindings,
  );

  expect(report).toHaveBeenCalledWith(failure, {
    correlationId: undefined,
    operation: "health.check",
  });
});

it("fails deployed health when the billing-required marker is missing", async () => {
  const report = vi.fn();
  const app = createApp(
    () => {
      throw new Error("The database should not be reached");
    },
    undefined,
    undefined,
    undefined,
    report,
  );

  const response = await app.request("/health", {}, {
    SENTRY_ENVIRONMENT: "production",
  } as Bindings);

  expect(response.status).toBe(503);
  expect(report).toHaveBeenCalledOnce();
});
