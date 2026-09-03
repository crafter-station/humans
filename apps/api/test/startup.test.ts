import { expect, it, vi } from "vitest";

import { type Bindings, createApp } from "../src/app";

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

  await app.request("/health", {
    headers: { "X-Correlation-ID": "private.person@example.com" },
  });

  expect(report).toHaveBeenCalledWith(failure, {
    correlationId: undefined,
    operation: "health.check",
  });
});
