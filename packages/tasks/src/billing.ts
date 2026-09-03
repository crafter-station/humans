import type { CreditUsageDelivery } from "@humans/database/billing";

const providerErrorCodes = new Set([
  "invalid_configuration",
  "invalid_input",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "invalid_request",
  "rate_limited",
  "server_error",
  "network_error",
  "malformed_response",
]);

const isolatableProviderErrorCodes = new Set([
  "invalid_input",
  "not_found",
  "conflict",
  "invalid_request",
]);

const readProviderErrorCode = (error: unknown) => {
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && providerErrorCodes.has(code)
    ? code
    : undefined;
};

const providerErrorCode = (error: unknown) =>
  readProviderErrorCode(error) ?? "provider_error";

const isIsolatableProviderError = (error: unknown) => {
  const code = readProviderErrorCode(error);
  return code !== undefined && isolatableProviderErrorCodes.has(code);
};

export const deliverCreditUsageBatch = async (dependencies: {
  claim: () => Promise<CreditUsageDelivery[]>;
  ingest: (items: CreditUsageDelivery[]) => Promise<void>;
  markDelivered: (items: CreditUsageDelivery[]) => Promise<void>;
  release: (items: CreditUsageDelivery[], errorCode: string) => Promise<void>;
}) => {
  const items = await dependencies.claim();
  if (items.length === 0) return { claimed: 0, delivered: 0, failed: 0 };

  const unsettledIds = new Set(items.map(({ id }) => id));
  const releaseAttemptedIds = new Set<string>();
  let delivered = 0;
  let failed = 0;

  const markDelivered = async (batch: CreditUsageDelivery[]) => {
    await dependencies.markDelivered(batch);
    for (const { id } of batch) unsettledIds.delete(id);
    delivered += batch.length;
  };

  const release = async (batch: CreditUsageDelivery[], errorCode: string) => {
    for (const { id } of batch) releaseAttemptedIds.add(id);
    await dependencies.release(batch, errorCode);
    for (const { id } of batch) unsettledIds.delete(id);
    failed += batch.length;
  };

  const deliver = async (batch: CreditUsageDelivery[]): Promise<void> => {
    try {
      await dependencies.ingest(batch);
    } catch (error) {
      if (!isIsolatableProviderError(error)) throw error;
      if (batch.length === 1) {
        await release(batch, providerErrorCode(error));
        return;
      }
      const middle = Math.floor(batch.length / 2);
      await deliver(batch.slice(0, middle));
      await deliver(batch.slice(middle));
      return;
    }
    await markDelivered(batch);
  };

  try {
    await deliver(items);
  } catch (error) {
    const recoverable = items.filter(
      ({ id }) => unsettledIds.has(id) && !releaseAttemptedIds.has(id),
    );
    try {
      if (recoverable.length > 0)
        await dependencies.release(recoverable, providerErrorCode(error));
    } catch {
      // Expired leases remain durable for the recovery schedule.
    }
    throw new Error("Credit usage delivery failed");
  }
  return { claimed: items.length, delivered, failed };
};

export const reconcileAllCreditPeriodPages = async (dependencies: {
  page: (afterOrganizationId: string | undefined) => Promise<{
    reconciliations: readonly unknown[];
    nextCursor: string | null;
  }>;
}) => {
  const cursors = new Set<string>();
  let afterOrganizationId: string | undefined;
  let pages = 0;
  let reconciled = 0;
  let complete = false;
  while (!complete) {
    const page = await dependencies.page(afterOrganizationId);
    pages += 1;
    reconciled += page.reconciliations.length;
    if (page.nextCursor === null) {
      complete = true;
      continue;
    }
    if (cursors.has(page.nextCursor))
      throw new Error("Credit reconciliation cursor did not advance");
    cursors.add(page.nextCursor);
    afterOrganizationId = page.nextCursor;
  }
  return { pages, reconciled };
};
