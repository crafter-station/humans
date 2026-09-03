import {
  type CreditReservation,
  finalizeCreditReservation,
  releaseCreditReservation,
  reserveCredit,
} from "./credits";
import {
  profileSearchRequestFingerprint,
  searchProfiles,
  type ProfileSearchFilters,
} from "./search-profiles";
import type { DrizzleDatabase } from "./service/types";

type Database = DrizzleDatabase;

/** Reserves before search, then finalizes or releases the Credit exactly once. */
export const runChargedProfileSearch = async (
  database: Database,
  input: {
    organizationId: string;
    idempotencyKey: string;
    filters: ProfileSearchFilters;
    cursor?: string;
    pageSize?: number;
    now?: Date;
    cursorSecret?: string;
  },
) => {
  const requestFingerprint = await profileSearchRequestFingerprint(
    input.filters,
    { cursor: input.cursor, pageSize: input.pageSize },
  );
  const operation = {
    organizationId: input.organizationId,
    amount: 1,
    referenceId: `profile-search:${requestFingerprint}`,
    idempotencyKey: input.idempotencyKey,
    reservationKey: "idempotency-key",
  } satisfies CreditReservation;
  const result = await database.transaction(async (tx) => {
    const reservation = await reserveCredit(tx, operation);
    const searchResult = await searchProfiles(tx, input.filters, {
      cursor: input.cursor,
      pageSize: input.pageSize,
      now: input.now,
      cursorSecret: input.cursorSecret,
    }).then(
      (page) => ({ ok: true as const, page }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (!searchResult.ok) {
      if (reservation.applied) await releaseCreditReservation(tx, operation);
      return { ok: false as const, error: searchResult.error };
    }
    await finalizeCreditReservation(tx, operation);
    return {
      ok: true as const,
      value: {
        page: searchResult.page,
        credit: { applied: reservation.applied },
      },
    };
  });
  if (!result.ok) throw result.error;
  return result.value;
};
