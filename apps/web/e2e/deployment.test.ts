import type { BrowserContext } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";

const establishVercelBypass = vi.hoisted(() => vi.fn());

vi.mock("./vercel-bypass", () => ({ establishVercelBypass }));

import { deploymentUrl, prepareDeploymentContext } from "./deployment";

const publicProductionUrl = "https://humans.crafter.run/";
const productionAcceptanceUrl = "https://acceptance.humans.crafter.run/";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("Production deployment URL", () => {
  it("accepts the public Production origin without a canary variable", () => {
    vi.stubEnv("PLAYWRIGHT_PRODUCTION_URL", publicProductionUrl);

    expect(deploymentUrl("production").href).toBe(publicProductionUrl);
  });

  it("accepts only the configured fixed canary and sends no Vercel bypass", async () => {
    vi.stubEnv("PLAYWRIGHT_PRODUCTION_URL", productionAcceptanceUrl);
    vi.stubEnv("HUMANS_PRODUCTION_ACCEPTANCE_URL", productionAcceptanceUrl);

    await expect(
      prepareDeploymentContext({} as BrowserContext, "production"),
    ).resolves.toMatchObject({
      bypassed: false,
      url: new URL(productionAcceptanceUrl),
    });
    expect(establishVercelBypass).not.toHaveBeenCalled();
  });

  it.each([
    "https://humans-abcdef123-crafter-station.vercel.app/",
    "https://another.humans.crafter.run/",
    "https://humans.crafter.run",
    "https://acceptance.humans.crafter.run",
  ])("rejects the Production origin %s", (url) => {
    vi.stubEnv("PLAYWRIGHT_PRODUCTION_URL", url);
    vi.stubEnv("HUMANS_PRODUCTION_ACCEPTANCE_URL", productionAcceptanceUrl);

    expect(() => deploymentUrl("production")).toThrow(
      "PLAYWRIGHT_PRODUCTION_URL",
    );
  });

  it("rejects a canary not confirmed by the exact environment value", () => {
    vi.stubEnv("PLAYWRIGHT_PRODUCTION_URL", productionAcceptanceUrl);
    vi.stubEnv(
      "HUMANS_PRODUCTION_ACCEPTANCE_URL",
      "https://other.humans.crafter.run/",
    );

    expect(() => deploymentUrl("production")).toThrow(
      "PLAYWRIGHT_PRODUCTION_URL",
    );
  });
});
