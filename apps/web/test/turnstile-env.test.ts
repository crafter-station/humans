import { afterEach, describe, expect, it, vi } from "vitest";

const localTurnstile = {
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
};

const loadEnv = async (
  environment: "local" | "production",
  turnstile: {
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: string;
    TURNSTILE_SECRET_KEY: string;
  },
) => {
  vi.resetModules();
  const values = {
    CLERK_SECRET_KEY: "sk_test_environment_validation",
    HUMANS_API_URL:
      environment === "local"
        ? "http://localhost:8787"
        : "https://humans-api-production.hi-541.workers.dev",
    HUMANS_PROXY_SECRET: "server-owned-proxy-secret",
    HUMANS_RELEASE_ENVIRONMENT: environment,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_environment_validation",
    SKIP_ENV_VALIDATION: "0",
    ...turnstile,
  };
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
  return import("../env");
};

describe("Turnstile environment validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("permits Cloudflare's documented testing credentials locally", async () => {
    const { env } = await loadEnv("local", localTurnstile);

    expect(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY).toBe(
      localTurnstile.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
    );
    expect(env.TURNSTILE_SECRET_KEY).toBe(localTurnstile.TURNSTILE_SECRET_KEY);
  });

  it("rejects Cloudflare testing credentials in a deployed environment", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(loadEnv("production", localTurnstile)).rejects.toThrow(
      "Invalid environment variables",
    );
  });

  it("requires distinct deployed site and secret keys", async () => {
    const reusedKey = "non-test-turnstile-key";

    await expect(
      loadEnv("production", {
        NEXT_PUBLIC_TURNSTILE_SITE_KEY: reusedKey,
        TURNSTILE_SECRET_KEY: reusedKey,
      }),
    ).rejects.toThrow("Turnstile site and secret keys must be distinct");
  });
});
