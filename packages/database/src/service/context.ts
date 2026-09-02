import { Context, type Effect } from "effect";

import type { runChargedProfileSearch } from "../charged-search";
import type {
  activateOrganizationEntitlement,
  assertPrincipalActive,
  recordSecurityActivity,
  recordSecurityAudit,
  revokeSuspension,
  setPolarSubscriptionStatus,
  suspendPrincipal,
} from "../abuse-controls";
import type {
  ContactDetailType,
  getOrganizationContactRevealPolicy,
  listContactDetails,
  purchaseContactReveal,
  reportInvalidContactDetail,
  setContactDetailSuppression,
  setOrganizationContactRevealPolicy,
} from "../contact-reveals";
import type {
  adjustCreditsAsOperator,
  getOperatorOverview,
  recordOperatorAudit,
  retryReconciliationAsOperator,
  revokeSuspensionAsOperator,
  reviewClaimAsOperator,
  reviewRequestAsOperator,
  suppressProfileAsOperator,
  suspendPrincipalAsOperator,
} from "../operations";
import type {
  getSearchableProfile,
  listProfileSearchFacets,
  searchProfiles,
  ProfileSearchFilters,
} from "../search-profiles";
import type {
  createSavedList,
  listSavedLists,
  renameSavedList,
} from "../saved-lists";
import type {
  AbuseControlRejected,
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
    readonly activateOrganizationEntitlement: (
      input: Parameters<typeof activateOrganizationEntitlement>[1],
    ) => Effect.Effect<
      Awaited<ReturnType<typeof activateOrganizationEntitlement>>,
      DatabaseUnavailable | AbuseControlRejected
    >;
    readonly assertPrincipalActive: (
      input: Parameters<typeof assertPrincipalActive>[1],
    ) => Effect.Effect<void, DatabaseUnavailable | AbuseControlRejected>;
    readonly check: Effect.Effect<void, DatabaseUnavailable>;
    readonly projectClerkEvent: (
      event: ClerkProjectionEvent,
    ) => Effect.Effect<boolean, DatabaseUnavailable>;
    readonly getWorkspace: (
      memberId: string,
      organizationId: string,
    ) => Effect.Effect<Workspace, DatabaseUnavailable | WorkspaceForbidden>;
    readonly getOperatorOverview: () => Effect.Effect<
      Awaited<ReturnType<typeof getOperatorOverview>>,
      DatabaseUnavailable
    >;
    readonly recordOperatorAudit: (
      ...input: Parameters<typeof recordOperatorAudit> extends [
        unknown,
        ...infer Rest,
      ]
        ? Rest
        : never
    ) => Effect.Effect<void, DatabaseUnavailable>;
    readonly reviewClaimAsOperator: (
      ...input: Parameters<typeof reviewClaimAsOperator> extends [
        unknown,
        ...infer Rest,
      ]
        ? Rest
        : never
    ) => Effect.Effect<
      Awaited<ReturnType<typeof reviewClaimAsOperator>>,
      DatabaseUnavailable
    >;
    readonly reviewRequestAsOperator: (
      ...input: Parameters<typeof reviewRequestAsOperator> extends [
        unknown,
        ...infer Rest,
      ]
        ? Rest
        : never
    ) => Effect.Effect<
      Awaited<ReturnType<typeof reviewRequestAsOperator>>,
      DatabaseUnavailable
    >;
    readonly suppressProfileAsOperator: (
      ...input: Parameters<typeof suppressProfileAsOperator> extends [
        unknown,
        ...infer Rest,
      ]
        ? Rest
        : never
    ) => Effect.Effect<void, DatabaseUnavailable>;
    readonly adjustCreditsAsOperator: (
      ...input: Parameters<typeof adjustCreditsAsOperator> extends [
        unknown,
        ...infer Rest,
      ]
        ? Rest
        : never
    ) => Effect.Effect<
      Awaited<ReturnType<typeof adjustCreditsAsOperator>>,
      DatabaseUnavailable
    >;
    readonly retryReconciliationAsOperator: (
      ...input: Parameters<typeof retryReconciliationAsOperator> extends [
        unknown,
        ...infer Rest,
      ]
        ? Rest
        : never
    ) => Effect.Effect<
      Awaited<ReturnType<typeof retryReconciliationAsOperator>>,
      DatabaseUnavailable
    >;
    readonly suspendPrincipalAsOperator: (
      ...input: Parameters<typeof suspendPrincipalAsOperator> extends [
        unknown,
        ...infer Rest,
      ]
        ? Rest
        : never
    ) => Effect.Effect<
      Awaited<ReturnType<typeof suspendPrincipalAsOperator>>,
      DatabaseUnavailable
    >;
    readonly revokeSuspensionAsOperator: (
      ...input: Parameters<typeof revokeSuspensionAsOperator> extends [
        unknown,
        ...infer Rest,
      ]
        ? Rest
        : never
    ) => Effect.Effect<
      Awaited<ReturnType<typeof revokeSuspensionAsOperator>>,
      DatabaseUnavailable
    >;
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
      apiKeyId?: string;
      source?: "web" | "api" | "mcp";
      correlationId?: string;
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
    readonly recordSecurityActivity: (
      input: Parameters<typeof recordSecurityActivity>[1],
    ) => Effect.Effect<void, DatabaseUnavailable | AbuseControlRejected>;
    readonly recordAttemptedExport: (
      input: Omit<
        Parameters<typeof recordSecurityAudit>[1],
        "eventType" | "result"
      >,
    ) => Effect.Effect<
      Awaited<ReturnType<typeof recordSecurityAudit>>,
      DatabaseUnavailable
    >;
    readonly revokeSuspension: (
      suspensionId: string,
    ) => Effect.Effect<
      Awaited<ReturnType<typeof revokeSuspension>>,
      DatabaseUnavailable
    >;
    readonly setPolarSubscriptionStatus: (
      input: Parameters<typeof setPolarSubscriptionStatus>[1],
    ) => Effect.Effect<void, DatabaseUnavailable>;
    readonly suspendPrincipal: (
      input: Parameters<typeof suspendPrincipal>[1],
    ) => Effect.Effect<
      Awaited<ReturnType<typeof suspendPrincipal>>,
      DatabaseUnavailable
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
