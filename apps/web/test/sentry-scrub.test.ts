import type { ErrorEvent } from "@sentry/nextjs";
import { describe, expect, it } from "vitest";

import {
  scrubSentryEvent,
  scrubSentryTransaction,
} from "../sentry-scrub";

describe("Sentry privacy scrubbing", () => {
  it("removes request and directory data from errors", () => {
    const event: ErrorEvent = {
      type: undefined,
      message: "privacy-canary@example.invalid",
      breadcrumbs: [{ message: "profile_privacy_canary" }],
      contexts: { organization: { id: "org_privacy_canary" } },
      extra: { contactDetail: "contact_privacy_canary" },
      request: { url: "https://example.invalid/?profile=privacy-canary" },
      user: {
        id: "member_privacy_canary",
        email: "privacy-canary@example.invalid",
      },
      exception: {
        values: [
          {
            type: "Error",
            value: "privacy-canary exception value",
          },
        ],
      },
      tags: { operation: "privacy.test" },
    };

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed).toMatchObject({
      message: "Redacted application error",
      exception: {
        values: [
          { type: "Error", value: "Redacted application exception" },
        ],
      },
      tags: { operation: "privacy.test" },
    });
    expect(scrubbed).not.toHaveProperty("breadcrumbs");
    expect(scrubbed).not.toHaveProperty("contexts");
    expect(scrubbed).not.toHaveProperty("extra");
    expect(scrubbed).not.toHaveProperty("request");
    expect(scrubbed).not.toHaveProperty("user");
    expect(JSON.stringify(scrubbed)).not.toContain("privacy-canary");
  });

  it("keeps trace identity while removing span data and route identifiers", () => {
    type Transaction = Parameters<typeof scrubSentryTransaction>[0];
    const event: Transaction = {
      type: "transaction",
      transaction:
        "GET /v1/profiles/123e4567-e89b-42d3-a456-426614174000?email=privacy-canary",
      contexts: {
        trace: {
          trace_id: "123e4567e89b42d3a456426614174000",
          span_id: "123e4567e89b42d3",
          op: "http.server",
        },
        organization: { id: "org_privacy_canary" },
      },
      request: { url: "https://example.invalid/?profile=privacy-canary" },
      spans: [
        {
          trace_id: "123e4567e89b42d3a456426614174000",
          span_id: "223e4567e89b42d3",
          parent_span_id: "123e4567e89b42d3",
          start_timestamp: 1,
          timestamp: 2,
          op: "http.client",
          description:
            "GET /v1/profiles/profile_identifier_12345?contact=privacy-canary",
          data: { payload: "contact_privacy_canary" },
        },
      ],
    };

    const scrubbed = scrubSentryTransaction(event);

    expect(scrubbed.transaction).toBe("GET /v1/profiles/:id");
    expect(scrubbed.contexts).toEqual({ trace: event.contexts?.trace });
    expect(scrubbed.spans?.[0]).toMatchObject({
      description: "GET /v1/profiles/:id",
      data: {},
    });
    expect(scrubbed).not.toHaveProperty("request");
    expect(JSON.stringify(scrubbed)).not.toContain("privacy-canary");
  });
});
