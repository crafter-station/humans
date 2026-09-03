import type { CreditUsageDelivery } from "@humans/database/billing";
import {
  PolarBillingError,
  type PolarBillingErrorCode,
} from "@humans/polar-billing";
import { describe, expect, it, vi } from "vitest";

import {
  deliverCreditUsageBatch,
  reconcileAllCreditPeriodPages,
} from "../src/billing.js";

const delivery = (id: string): CreditUsageDelivery => ({
  id,
  idempotencyKey: `credit-usage:${id}`,
  organizationId: `org_${id}`,
  occurredAt: new Date("2026-09-03T12:00:00.000Z"),
  attempts: 1,
});

const providerError = (code: PolarBillingErrorCode) =>
  new PolarBillingError(code, { operation: "ingest_usage" });

describe("Credit usage delivery", () => {
  it("returns stable zero counts without calling delivery dependencies", async () => {
    const ingest = vi.fn(async () => undefined);
    const markDelivered = vi.fn(
      async (_batch: CreditUsageDelivery[]) => undefined,
    );
    const release = vi.fn(async () => undefined);

    await expect(
      deliverCreditUsageBatch({
        claim: async () => [],
        ingest,
        markDelivered,
        release,
      }),
    ).resolves.toEqual({ claimed: 0, delivered: 0, failed: 0 });
    expect(ingest).not.toHaveBeenCalled();
    expect(markDelivered).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("delivers a successful batch with one provider request", async () => {
    const items = [delivery("a"), delivery("b"), delivery("c")];
    const ingest = vi.fn(async () => undefined);
    const markDelivered = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);

    await expect(
      deliverCreditUsageBatch({
        claim: async () => items,
        ingest,
        markDelivered,
        release,
      }),
    ).resolves.toEqual({ claimed: 3, delivered: 3, failed: 0 });
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledWith(items);
    expect(markDelivered).toHaveBeenCalledTimes(1);
    expect(markDelivered).toHaveBeenCalledWith(items);
    expect(release).not.toHaveBeenCalled();
  });

  it.each([
    "invalid_configuration",
    "unauthorized",
    "forbidden",
    "rate_limited",
    "server_error",
    "network_error",
    "malformed_response",
  ] as const)("retries the whole batch after a %s failure", async (code) => {
    const items = [delivery("a"), delivery("b")];
    const ingest = vi.fn(async () => {
      throw providerError(code);
    });
    const markDelivered = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);

    await expect(
      deliverCreditUsageBatch({
        claim: async () => items,
        ingest,
        markDelivered,
        release,
      }),
    ).rejects.toThrow("Credit usage delivery failed");
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(markDelivered).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(items, code);
  });

  it.each([
    "invalid_input",
    "not_found",
    "conflict",
    "invalid_request",
  ] as const)("isolates an item rejected with %s", async (code) => {
    const first = delivery("a");
    const rejected = delivery("b");
    const remaining = [delivery("c"), delivery("d")];
    const items = [first, rejected, ...remaining];
    const ingest = vi.fn(async (batch: CreditUsageDelivery[]) => {
      if (batch.includes(rejected)) throw providerError(code);
    });
    const markDelivered = vi.fn(
      async (_batch: CreditUsageDelivery[]) => undefined,
    );
    const release = vi.fn(async () => undefined);

    await expect(
      deliverCreditUsageBatch({
        claim: async () => items,
        ingest,
        markDelivered,
        release,
      }),
    ).resolves.toEqual({ claimed: 4, delivered: 3, failed: 1 });
    expect(ingest.mock.calls.map(([batch]) => batch)).toEqual([
      items,
      [first, rejected],
      [first],
      [rejected],
      remaining,
    ]);
    expect(markDelivered.mock.calls.map(([batch]) => batch)).toEqual([
      [first],
      remaining,
    ]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith([rejected], code);
  });

  it("reports stable counts while isolating multiple rejected items", async () => {
    const first = delivery("a");
    const invalid = delivery("b");
    const middle = delivery("c");
    const last = delivery("d");
    const conflicting = delivery("e");
    const items = [first, invalid, middle, last, conflicting];
    const ingest = vi.fn(async (batch: CreditUsageDelivery[]) => {
      if (batch.includes(invalid)) throw providerError("invalid_request");
      if (batch.includes(conflicting)) throw providerError("conflict");
    });
    const markDelivered = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);

    await expect(
      deliverCreditUsageBatch({
        claim: async () => items,
        ingest,
        markDelivered,
        release,
      }),
    ).resolves.toEqual({ claimed: 5, delivered: 3, failed: 2 });
    expect(release.mock.calls).toEqual([
      [[invalid], "invalid_request"],
      [[conflicting], "conflict"],
    ]);
  });

  it("releases only unsettled items when marking a split subset fails", async () => {
    const first = delivery("a");
    const rejected = delivery("b");
    const remaining = [delivery("c"), delivery("d")];
    const items = [first, rejected, ...remaining];
    const ingest = vi.fn(async (batch: CreditUsageDelivery[]) => {
      if (batch.includes(rejected)) throw providerError("invalid_request");
    });
    const markDelivered = vi.fn(async (batch: CreditUsageDelivery[]) => {
      if (batch.some(({ id }) => id === "c"))
        throw new Error("database unavailable");
    });
    const release = vi.fn(async () => undefined);

    await expect(
      deliverCreditUsageBatch({
        claim: async () => items,
        ingest,
        markDelivered,
        release,
      }),
    ).rejects.toThrow("Credit usage delivery failed");
    expect(markDelivered.mock.calls.map(([batch]) => batch)).toEqual([
      [first],
      remaining,
    ]);
    expect(release.mock.calls).toEqual([
      [[rejected], "invalid_request"],
      [remaining, "provider_error"],
    ]);
  });

  it("keeps the whole batch recoverable when marking fails", async () => {
    const items = [delivery("a"), delivery("b")];
    const release = vi.fn(async () => undefined);

    await expect(
      deliverCreditUsageBatch({
        claim: async () => items,
        ingest: async () => undefined,
        markDelivered: async () => {
          throw new Error("database unavailable");
        },
        release,
      }),
    ).rejects.toThrow("Credit usage delivery failed");
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(items, "provider_error");
  });

  it("relies on lease recovery when a whole-batch release fails", async () => {
    const items = [delivery("a"), delivery("b")];
    const release = vi.fn(async () => {
      throw new Error("database unavailable");
    });

    await expect(
      deliverCreditUsageBatch({
        claim: async () => items,
        ingest: async () => {
          throw providerError("network_error");
        },
        markDelivered: vi.fn(async () => undefined),
        release,
      }),
    ).rejects.toThrow("Credit usage delivery failed");
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(items, "network_error");
  });

  it("does not retry a failed item release or strand its unprocessed sibling", async () => {
    const rejected = delivery("a");
    const unprocessed = delivery("b");
    const items = [rejected, unprocessed];
    const ingest = vi.fn(async (batch: CreditUsageDelivery[]) => {
      if (batch.includes(rejected)) throw providerError("invalid_request");
    });
    const release = vi
      .fn<(batch: CreditUsageDelivery[], errorCode: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(undefined);

    await expect(
      deliverCreditUsageBatch({
        claim: async () => items,
        ingest,
        markDelivered: vi.fn(async () => undefined),
        release,
      }),
    ).rejects.toThrow("Credit usage delivery failed");
    expect(release.mock.calls).toEqual([
      [[rejected], "invalid_request"],
      [[unprocessed], "provider_error"],
    ]);
  });

  it("sanitizes unknown error codes before releasing a batch", async () => {
    const items = [delivery("a"), delivery("b")];
    const release = vi.fn(async () => undefined);

    await expect(
      deliverCreditUsageBatch({
        claim: async () => items,
        ingest: async () => {
          throw { code: "unsafe provider detail" };
        },
        markDelivered: vi.fn(async () => undefined),
        release,
      }),
    ).rejects.toThrow("Credit usage delivery failed");
    expect(release).toHaveBeenCalledWith(items, "provider_error");
  });
});

describe("Credit reconciliation pagination", () => {
  it("reconciles every page exactly once", async () => {
    const page = vi
      .fn()
      .mockResolvedValueOnce({
        reconciliations: [{ id: "a" }],
        nextCursor: "a",
      })
      .mockResolvedValueOnce({
        reconciliations: [{ id: "b" }, { id: "c" }],
        nextCursor: "c",
      })
      .mockResolvedValueOnce({ reconciliations: [], nextCursor: null });

    await expect(reconcileAllCreditPeriodPages({ page })).resolves.toEqual({
      pages: 3,
      reconciled: 3,
    });
    expect(page.mock.calls).toEqual([[undefined], ["a"], ["c"]]);
  });

  it("rejects a repeated cursor instead of looping forever", async () => {
    const page = vi.fn(async () => ({
      reconciliations: [],
      nextCursor: "same",
    }));

    await expect(reconcileAllCreditPeriodPages({ page })).rejects.toThrow(
      "Credit reconciliation cursor did not advance",
    );
    expect(page).toHaveBeenCalledTimes(2);
  });
});
