import { sql } from "drizzle-orm";
import { Effect, Layer } from "effect";

import { runChargedProfileSearch } from "../charged-search";
import {
  ContactRevealError,
  getOrganizationContactRevealPolicy,
  listContactDetails,
  purchaseContactReveal,
  reportInvalidContactDetail,
  setContactDetailSuppression,
  setOrganizationContactRevealPolicy,
} from "../contact-reveals";
import { CreditOperationError } from "../credits";
import {
  getSearchableProfile,
  InvalidSearchCursor,
  listProfileSearchFacets,
  searchProfiles,
  type ProfileSearchFilters,
} from "../search-profiles";
import {
  addSavedListEntry,
  createSavedList,
  deleteSavedList,
  listSavedLists,
  removeSavedListEntry,
  renameSavedList,
  updateSavedListEntryNote,
} from "../saved-lists";
import { makeClerkService } from "./clerk";
import { Database } from "./context";
import {
  ContactRevealRejected,
  DatabaseUnavailable,
  SearchChargeRejected,
  SearchRejected,
} from "./errors";
import { makeProfileService } from "./profiles";
import type { DrizzleDatabase } from "./types";

export { Database } from "./context";
export {
  ContactRevealRejected,
  DatabaseUnavailable,
  ProfileRejected,
  SearchChargeRejected,
  SearchRejected,
  WorkspaceForbidden,
} from "./errors";
export type {
  ClerkProjectionEvent,
  GitHubVerification,
  MemberProfile,
  MemberProjection,
  MembershipProjection,
  OrganizationProjection,
  ProfileInput,
  ProvisionedWorkspace,
  Workspace,
} from "./types";

export const makeDatabaseService = (
  database: DrizzleDatabase,
  searchCursorSecret = "local-search-cursor",
) => {
  const check = Effect.tryPromise({
    try: async () => {
      await database.execute(sql`select null::vector`);
    },
    catch: (cause) => new DatabaseUnavailable({ cause }),
  }).pipe(Effect.withSpan("Database.check"));

  const search = (
    filters: ProfileSearchFilters,
    options?: { cursor?: string; pageSize?: number },
  ) =>
    Effect.tryPromise({
      try: () =>
        searchProfiles(database, filters, {
          ...options,
          cursorSecret: searchCursorSecret,
        }),
      catch: (cause) =>
        cause instanceof InvalidSearchCursor
          ? new SearchRejected()
          : new DatabaseUnavailable({ cause }),
    }).pipe(Effect.withSpan("Database.searchProfiles"));

  const getSearchResult = (profileId: string) =>
    Effect.tryPromise({
      try: () => getSearchableProfile(database, profileId),
      catch: (cause) => new DatabaseUnavailable({ cause }),
    }).pipe(Effect.withSpan("Database.getSearchableProfile"));

  const chargedSearch = (input: {
    organizationId: string;
    idempotencyKey: string;
    filters: ProfileSearchFilters;
    cursor?: string;
    pageSize?: number;
  }) =>
    Effect.tryPromise({
      try: async () =>
        (
          await runChargedProfileSearch(database, {
            ...input,
            cursorSecret: searchCursorSecret,
          })
        ).page,
      catch: (cause) =>
        cause instanceof InvalidSearchCursor
          ? new SearchRejected()
          : cause instanceof CreditOperationError
            ? new SearchChargeRejected({ reason: cause.code })
            : new DatabaseUnavailable({ cause }),
    }).pipe(Effect.withSpan("Database.searchProfilesWithCredit"));

  const saved = <A>(name: string, operation: () => Promise<A>) =>
    Effect.tryPromise({
      try: operation,
      catch: (cause) => new DatabaseUnavailable({ cause }),
    }).pipe(Effect.withSpan(name));

  const contact = <A>(name: string, operation: () => Promise<A>) =>
    Effect.tryPromise({
      try: operation,
      catch: (cause) =>
        cause instanceof ContactRevealError
          ? new ContactRevealRejected({ reason: cause.code })
          : new DatabaseUnavailable({ cause }),
    }).pipe(Effect.withSpan(name));

  return Database.of({
    check,
    ...makeClerkService(database),
    ...makeProfileService(database),
    addSavedListEntry: (memberId, organizationId, listId, profileId) =>
      saved("Database.addSavedListEntry", () =>
        addSavedListEntry(
          database,
          memberId,
          organizationId,
          listId,
          profileId,
        ),
      ),
    createSavedList: (memberId, organizationId, name) =>
      saved("Database.createSavedList", () =>
        createSavedList(database, memberId, organizationId, name),
      ),
    deleteSavedList: (memberId, organizationId, listId) =>
      saved("Database.deleteSavedList", () =>
        deleteSavedList(database, memberId, organizationId, listId),
      ),
    getSearchableProfile: getSearchResult,
    getOrganizationContactRevealPolicy: (memberId, organizationId) =>
      contact("Database.getOrganizationContactRevealPolicy", () =>
        getOrganizationContactRevealPolicy(database, memberId, organizationId),
      ),
    listContactDetails: (memberId, organizationId, profileId) =>
      contact("Database.listContactDetails", () =>
        listContactDetails(database, memberId, organizationId, profileId),
      ),
    listSearchFacets: () =>
      saved("Database.listSearchFacets", () =>
        listProfileSearchFacets(database),
      ),
    listSavedLists: (memberId, organizationId) =>
      saved("Database.listSavedLists", () =>
        listSavedLists(database, memberId, organizationId),
      ),
    purchaseContactReveal: (input) =>
      contact("Database.purchaseContactReveal", () =>
        purchaseContactReveal(database, input),
      ),
    reportInvalidContactDetail: (input) =>
      contact("Database.reportInvalidContactDetail", () =>
        reportInvalidContactDetail(database, input),
      ),
    removeSavedListEntry: (memberId, organizationId, listId, profileId) =>
      saved("Database.removeSavedListEntry", () =>
        removeSavedListEntry(
          database,
          memberId,
          organizationId,
          listId,
          profileId,
        ),
      ),
    renameSavedList: (memberId, organizationId, listId, name) =>
      saved("Database.renameSavedList", () =>
        renameSavedList(database, memberId, organizationId, listId, name),
      ),
    searchProfiles: search,
    searchProfilesWithCredit: chargedSearch,
    setContactDetailSuppression: (memberId, type, suppressed) =>
      contact("Database.setContactDetailSuppression", () =>
        setContactDetailSuppression(database, memberId, type, suppressed),
      ),
    setOrganizationContactRevealPolicy: (
      memberId,
      organizationId,
      membersCanReveal,
    ) =>
      contact("Database.setOrganizationContactRevealPolicy", () =>
        setOrganizationContactRevealPolicy(
          database,
          memberId,
          organizationId,
          membersCanReveal,
        ),
      ),
    updateSavedListEntryNote: (
      memberId,
      organizationId,
      listId,
      profileId,
      note,
    ) =>
      saved("Database.updateSavedListEntryNote", () =>
        updateSavedListEntryNote(
          database,
          memberId,
          organizationId,
          listId,
          profileId,
          note,
        ),
      ),
  });
};

export const makeDatabaseLayer = (
  database: DrizzleDatabase,
  searchCursorSecret?: string,
) => Layer.succeed(Database, makeDatabaseService(database, searchCursorSecret));
