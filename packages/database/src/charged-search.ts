import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { chargeSearchPage } from "./credits";
import {
  profileSearchRequestFingerprint,
  searchProfiles,
  type ProfileSearchFilters,
} from "./search-profiles";

type Database =
  | NeonDatabase<typeof import("./schema")>
  | NodePgDatabase<typeof import("./schema")>;

/** Runs search first so invalid or failed searches never consume a Credit. */
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
  const page = await searchProfiles(database, input.filters, {
    cursor: input.cursor,
    pageSize: input.pageSize,
    now: input.now,
    cursorSecret: input.cursorSecret,
  });
  const requestFingerprint = await profileSearchRequestFingerprint(
    input.filters,
    { cursor: input.cursor, pageSize: input.pageSize },
  );
  const credit = await chargeSearchPage(database, {
    organizationId: input.organizationId,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint,
  });
  return { page, credit };
};
