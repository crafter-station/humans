import type { EnrichmentDispatch } from "@humans/database/enrichment";
import { describe, expect, it, vi } from "vitest";

import { dispatchEnrichmentBatch } from "../src/dispatch.js";

const dispatch = {
  id: "dispatch-1",
  profileId: "profile-private-value",
  provider: "github",
  runId: "logical-run-1",
  dedupeKey: "github:profile-private-value:refresh-1",
  payload: {
    profileId: "profile-private-value",
    githubLogin: "private-provider-value",
    runId: "logical-run-1",
  },
  state: "leased",
  attempts: 1,
  availableAt: new Date("2026-09-01T00:00:00.000Z"),
  leaseOwner: "dispatcher-1",
  leaseExpiresAt: new Date("2026-09-01T00:10:00.000Z"),
  triggerRunId: null,
  deliveredAt: null,
} satisfies EnrichmentDispatch;

describe("enrichment dispatcher", () => {
  it("leaves failed deliveries recoverable", async () => {
    const release = vi.fn(async () => undefined);
    const result = await dispatchEnrichmentBatch({
      claim: async () => [dispatch],
      trigger: async () => {
        throw new Error("Trigger unavailable");
      },
      markDelivered: vi.fn(async () => undefined),
      release,
    });

    expect(result).toEqual({ claimed: 1, delivered: 0, failed: 1 });
    expect(release).toHaveBeenCalledWith(dispatch);
  });

  it("reuses the logical run and dedupe key when delivery acknowledgement retries", async () => {
    const providerRuns = new Map<string, { id: string; runId: string }>();
    const trigger = vi.fn(async (item: EnrichmentDispatch) => {
      const existing = providerRuns.get(item.dedupeKey);
      if (existing) return existing;
      const created = { id: "trigger-run-1", runId: item.runId };
      providerRuns.set(item.dedupeKey, created);
      return created;
    });
    let acknowledgementFails = true;
    const dependencies = {
      claim: async () => [dispatch],
      trigger,
      markDelivered: async () => {
        if (acknowledgementFails) {
          acknowledgementFails = false;
          throw new Error("database unavailable");
        }
      },
      release: async () => undefined,
    };

    await dispatchEnrichmentBatch(dependencies);
    await dispatchEnrichmentBatch(dependencies);

    expect(trigger).toHaveBeenCalledTimes(2);
    expect(providerRuns).toEqual(
      new Map([
        [dispatch.dedupeKey, { id: "trigger-run-1", runId: "logical-run-1" }],
      ]),
    );
  });
});
