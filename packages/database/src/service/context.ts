import { Context, type Effect } from "effect";

import { runChargedProfileSearch } from "../charged-search";
import {
  type ContactDetailType,
  getOrganizationContactRevealPolicy,
  listContactDetails,
  purchaseContactReveal,
  reportInvalidContactDetail,
  setContactDetailSuppression,
  setOrganizationContactRevealPolicy,
} from "../contact-reveals";
import {
  getSearchableProfile,
  listProfileSearchFacets,
  searchProfiles,
  type ProfileSearchFilters,
} from "../search-profiles";
import {
  createSavedList,
  listSavedLists,
  renameSavedList,
} from "../saved-lists";
import {
  ContactRevealRejected,
  DatabaseUnavailable,
  ProfileRejected,
  SearchChargeRejected,
  SearchRejected,
  WorkspaceForbidden,
} from "./errors";
import type {
  ClerkProjectionEvent,
  GitHubVerification,
  MemberProfile,
  ProfileInput,
  ProvisionedWorkspace,
  Workspace,
} from "./types";

export class Database extends Context.Service<
  Database,
  {
    readonly check: Effect.Effect<void, DatabaseUnavailable>;
    readonly projectClerkEvent: (
      event: ClerkProjectionEvent,
    ) => Effect.Effect<boolean, DatabaseUnavailable>;
    readonly getWorkspace: (
      memberId: string,
      organizationId: string,
    ) => Effect.Effect<Workspace, DatabaseUnavailable | WorkspaceForbidden>;
    readonly provisionWorkspace: (
      memberId: string,
      provision: () => Promise<ProvisionedWorkspace>,
    ) => Effect.Effect<Workspace, DatabaseUnavailable>;
    readonly getProfile: (
      memberId: string,
    ) => Effect.Effect<MemberProfile | null, DatabaseUnavailable>;
    readonly saveProfile: (
      memberId: string,
      input: ProfileInput,
      github: GitHubVerification,
    ) => Effect.Effect<MemberProfile, DatabaseUnavailable | ProfileRejected>;
    readonly disableProfileSearchability: (
      memberId: string,
    ) => Effect.Effect<MemberProfile, DatabaseUnavailable | ProfileRejected>;
    readonly searchProfiles: (
      filters: ProfileSearchFilters,
      options?: { cursor?: string; pageSize?: number },
    ) => Effect.Effect<
      Awaited<ReturnType<typeof searchProfiles>>,
      DatabaseUnavailable | SearchRejected
    >;
    readonly searchProfilesWithCredit: (input: {
      organizationId: string;
      idempotencyKey: string;
      filters: ProfileSearchFilters;
      cursor?: string;
      pageSize?: number;
    }) => Effect.Effect<
      Awaited<ReturnType<typeof runChargedProfileSearch>>["page"],
      DatabaseUnavailable | SearchRejected | SearchChargeRejected
    >;
    readonly listSearchFacets: () => Effect.Effect<
      Awaited<ReturnType<typeof listProfileSearchFacets>>,
      DatabaseUnavailable
    >;
    readonly getSearchableProfile: (
      profileId: string,
    ) => Effect.Effect<
      Awaited<ReturnType<typeof getSearchableProfile>>,
      DatabaseUnavailable
    >;
    readonly listContactDetails: (
      memberId: string,
      organizationId: string,
      profileId: string,
    ) => Effect.Effect<
      Awaited<ReturnType<typeof listContactDetails>>,
      DatabaseUnavailable | ContactRevealRejected
    >;
    readonly purchaseContactReveal: (input: {
      memberId: string;
      organizationId: string;
      profileId: string;
      type: ContactDetailType;
      idempotencyKey: string;
      observationId?: string;
    }) => Effect.Effect<
      Awaited<ReturnType<typeof purchaseContactReveal>>,
      DatabaseUnavailable | ContactRevealRejected
    >;
    readonly reportInvalidContactDetail: (input: {
      memberId: string;
      organizationId: string;
      observationId: string;
      reason: "bounced-email" | "wrong-phone";
    }) => Effect.Effect<
      Awaited<ReturnType<typeof reportInvalidContactDetail>>,
      DatabaseUnavailable | ContactRevealRejected
    >;
    readonly setContactDetailSuppression: (
      memberId: string,
      type: ContactDetailType,
      suppressed: boolean,
    ) => Effect.Effect<
      Awaited<ReturnType<typeof setContactDetailSuppression>>,
      DatabaseUnavailable | ContactRevealRejected
    >;
    readonly setOrganizationContactRevealPolicy: (
      memberId: string,
      organizationId: string,
      membersCanReveal: boolean,
    ) => Effect.Effect<
      Awaited<ReturnType<typeof setOrganizationContactRevealPolicy>>,
      DatabaseUnavailable | ContactRevealRejected
    >;
    readonly getOrganizationContactRevealPolicy: (
      memberId: string,
      organizationId: string,
    ) => Effect.Effect<
      Awaited<ReturnType<typeof getOrganizationContactRevealPolicy>>,
      DatabaseUnavailable | ContactRevealRejected
    >;
    readonly listSavedLists: (
      memberId: string,
      organizationId: string,
    ) => Effect.Effect<
      Awaited<ReturnType<typeof listSavedLists>>,
      DatabaseUnavailable
    >;
    readonly createSavedList: (
      memberId: string,
      organizationId: string,
      name: string,
    ) => Effect.Effect<
      Awaited<ReturnType<typeof createSavedList>>,
      DatabaseUnavailable
    >;
    readonly renameSavedList: (
      memberId: string,
      organizationId: string,
      listId: string,
      name: string,
    ) => Effect.Effect<
      Awaited<ReturnType<typeof renameSavedList>>,
      DatabaseUnavailable
    >;
    readonly deleteSavedList: (
      memberId: string,
      organizationId: string,
      listId: string,
    ) => Effect.Effect<void, DatabaseUnavailable>;
    readonly addSavedListEntry: (
      memberId: string,
      organizationId: string,
      listId: string,
      profileId: string,
    ) => Effect.Effect<void, DatabaseUnavailable>;
    readonly removeSavedListEntry: (
      memberId: string,
      organizationId: string,
      listId: string,
      profileId: string,
    ) => Effect.Effect<void, DatabaseUnavailable>;
    readonly updateSavedListEntryNote: (
      memberId: string,
      organizationId: string,
      listId: string,
      profileId: string,
      note: string,
    ) => Effect.Effect<void, DatabaseUnavailable>;
  }
>()("@humans/database/Database") {}
