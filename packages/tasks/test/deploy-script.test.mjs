import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { main, triggerDeployArguments } from "../scripts/deploy.mjs";

describe("Trigger.dev deployment command", () => {
  it("rejects disabled environment validation before deployment", async () => {
    await expect(
      main(["preview", "--dry-run"], { SKIP_ENV_VALIDATION: "1" }),
    ).rejects.toThrow("environment validation disabled");
  });

  it("pins the project, Production scope, and full release external ID", () => {
    const release = "a".repeat(40);
    expect(
      triggerDeployArguments({
        dryRun: false,
        release,
        target: "proj_target",
      }),
    ).toEqual([
      "trigger",
      "deploy",
      "--env",
      "prod",
      "--project-ref",
      "proj_target",
      "--external-id",
      release,
      "--skip-update-check",
      "--skip-telemetry",
      "--build-logs",
      "full",
    ]);
  });

  it("keeps dry runs non-deploying through the provider flag", () => {
    const arguments_ = triggerDeployArguments({
      dryRun: true,
      release: "b".repeat(40),
      target: "proj_target",
    });
    expect(arguments_.filter((argument) => argument === "--dry-run")).toEqual([
      "--dry-run",
    ]);
    expect(arguments_).not.toContain("--force");
  });

  it("synchronizes every environment value required to import the config", () => {
    const configuration = readFileSync(
      new URL("../trigger.config.ts", import.meta.url),
      "utf8",
    );

    expect(configuration).toContain(
      '{ name: "TRIGGER_PROJECT_REF", value: project }',
    );
    expect(configuration).toContain(
      '{ name: "SENTRY_RELEASE", value: sentryRelease }',
    );
  });
});
