import { describe, expect, it, vi } from "vitest";

import {
  createTaskExceptionReporter,
  scrubTaskErrorEvent,
} from "../src/sentry.js";

describe("task exception reporting", () => {
  it("sends only a redacted exception and allowlisted correlation tags", async () => {
    const init = vi.fn();
    const captureException = vi.fn();
    const flush = vi.fn(async () => true);
    const reporter = createTaskExceptionReporter(
      { init, captureException, flush } as never,
      {
        SENTRY_DSN: "https://public@example.invalid/1",
        SENTRY_ENVIRONMENT: "production",
        SENTRY_RELEASE: "release-1",
      },
    );

    const original = new Error(
      "Profile profile-secret failed for ada@example.test with provider-output-secret",
    );
    original.stack =
      "Error: Profile profile-secret failed for ada@example.test\n" +
      "    at runProvider (/workspace/src/provider.ts:42:7)";
    await reporter(original, {
      taskId: "deepline-career-fallback-v1",
      runId: "trigger-run-correlation",
    });

    const [reported, context] = captureException.mock.calls[0] ?? [];
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).message).toBe("Redacted task exception");
    expect((reported as Error).stack).toContain(
      "at runProvider (/workspace/src/provider.ts:42:7)",
    );
    expect(JSON.stringify([reported, context])).not.toContain("profile-secret");
    expect(JSON.stringify([reported, context])).not.toContain(
      "ada@example.test",
    );
    expect(JSON.stringify([reported, context])).not.toContain(
      "provider-output-secret",
    );
    expect(context).toEqual({
      tags: {
        task: "deepline-career-fallback-v1",
        provider: "deepline",
        stage: "career",
        run_correlation: "trigger-run-correlation",
      },
    });

    const configuration = init.mock.calls[0]?.[0] as {
      beforeSend: (event: never) => unknown;
      dataCollection: Record<string, unknown>;
      defaultIntegrations: boolean;
      maxBreadcrumbs: number;
      tracesSampleRate: number;
    };
    expect(configuration).toMatchObject({
      defaultIntegrations: false,
      maxBreadcrumbs: 0,
      tracesSampleRate: 0,
      dataCollection: {
        userInfo: false,
        cookies: false,
        genAI: { inputs: false, outputs: false },
        databaseQueryData: false,
        stackFrameVariables: false,
      },
    });
  });

  it("strips payload-like event data and non-allowlisted tags", () => {
    const event = scrubTaskErrorEvent({
      type: undefined,
      breadcrumbs: [{ message: "provider secret" }],
      contexts: { privateProfile: { id: "profile-secret" } },
      extra: { payload: { email: "ada@example.test" } },
      request: { data: "provider request" },
      user: { id: "member-secret" },
      message: "provider value",
      exception: { values: [{ value: "provider response" }] },
      tags: {
        task: "task-1",
        provider: "github",
        stage: "account",
        run_correlation: "run-1",
        profile: "profile-secret",
      },
    });

    expect(event).toEqual({
      type: undefined,
      message: "Redacted task error",
      exception: { values: [{ value: "Redacted task exception" }] },
      tags: {
        task: "task-1",
        provider: "github",
        stage: "account",
        run_correlation: "run-1",
      },
    });
  });
});
