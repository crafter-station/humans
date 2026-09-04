import { describe, expect, it } from "vitest";

import { assertProductionDeployConfirmation } from "../../../scripts/release-confirmation.mjs";

const release = "a".repeat(40);

describe("Production deployment confirmation", () => {
  it("does not require confirmation for Preview", () => {
    expect(() =>
      assertProductionDeployConfirmation({
        environment: "preview",
        release,
        service: "api",
        target: "humans-api-preview",
      }),
    ).not.toThrow();
  });

  it("binds Production confirmation to service, target, and release", () => {
    expect(() =>
      assertProductionDeployConfirmation({
        confirmation: `production:api:humans-api-production:${release}`,
        environment: "production",
        release,
        service: "api",
        target: "humans-api-production",
      }),
    ).not.toThrow();
    expect(() =>
      assertProductionDeployConfirmation({
        confirmation: `production:api:humans-api-preview:${release}`,
        environment: "production",
        release,
        service: "api",
        target: "humans-api-production",
      }),
    ).toThrow("HUMANS_PRODUCTION_DEPLOY_CONFIRMATION");
  });

  it("rejects an invalid release in every environment", () => {
    expect(() =>
      assertProductionDeployConfirmation({
        environment: "preview",
        release: "main",
        service: "api",
        target: "humans-api-preview",
      }),
    ).toThrow("full Git commit SHA");
  });

  it("rejects a target outside the exact service environment", () => {
    expect(() =>
      assertProductionDeployConfirmation({
        environment: "preview",
        release,
        service: "api",
        target: "humans-api-production",
      }),
    ).toThrow("service, target, and environment");
  });
});
