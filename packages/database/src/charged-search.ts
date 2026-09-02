import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  finalizeSearchPage,
  releaseSearchPage,
  reserveSearchPage,
} from "./credits";
import {
  profileSearchRequestFingerprint,
  searchProfiles,
  type ProfileSearchFilters,
} from "./search-profiles";

type Database =
  | NeonDatabase<typeof import("./schema")>
  | NodePgDatabase<typeof import("./schema")>;

/** Reserves before search, then finalizes or releases the Credit atomically. */
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
    idempotencyKey: input.idempotencyKey,
    requestFingerprint,
  };
  const reservation = await reserveSearchPage(database, operation);
  try {
    const page = await searchProfiles(database, input.filters, {
      cursor: input.cursor,
      pageSize: input.pageSize,
      now: input.now,
      cursorSecret: input.cursorSecret,
    });
    await finalizeSearchPage(database, operation);
    return { page, credit: { applied: reservation.applied } };
  } catch (error) {
    if (reservation.applied) await releaseSearchPage(database, operation);
    throw error;
  }
};
