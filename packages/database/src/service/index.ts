import { sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import {
  AbuseControlError,
  activateOrganizationEntitlement,
  assertMemberActive,
  assertPrincipalActive,
  recordSecurityActivity,
  recordSecurityAudit,
  revokeSuspension,
  setPolarSubscriptionStatus,
  suspendPrincipal,
} from "../abuse-controls";
import { runChargedProfileSearch } from "../charged-search";
import {
  beginPolarCheckoutCreation,
  claimPolarCheckout,
  clearPolarCheckoutClaim,
  completePolarCheckout,
  getBillingCustomerSeed,
  getOrganizationBillingOverview,
  recordPolarOrderRefund,
  recordPolarCustomer,
  releaseExpiredPolarCheckoutReconciliation,
  releasePolarCheckoutLease,
} from "../billing";
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
  adjustCreditsAsOperator,
  getOperatorOverview,
  recordOperatorAudit,
  redriveCreditUsageAsOperator,
  retryReconciliationAsOperator,
  reviewClaimAsOperator,
  reviewRequestAsOperator,
  revokeSuspensionAsOperator,
  suppressProfileAsOperator,
  suspendPrincipalAsOperator,
  verifyRequestAsOperator,
} from "../operations";
import {
  editControlledProfile,
  findClaimCandidates,
  getMemberProfileClaim,
  ProfileControlError,
  requestProfileClaim,
  setMemberStatements,
  setProfileSearchability,
  suppressKnownMinorProfile,
  submitPublicProfileRequest,
} from "../profile-control";
import {
  addSavedListEntry,
  createSavedList,
  deleteSavedList,
  listSavedLists,
  removeSavedListEntry,
  renameSavedList,
  updateSavedListEntryNote,
} from "../saved-lists";
import {
  getSearchableProfile,
  InvalidSearchCursor,
  listProfileSearchFacets,
  type ProfileSearchFilters,
  searchProfiles,
} from "../search-profiles";
import { makeClerkService } from "./clerk";
import { Database } from "./context";
import {
  AbuseControlRejected,
  ContactRevealRejected,
  DatabaseUnavailable,
  ProfileControlRejected,
  SearchChargeRejected,
  SearchRejected,
} from "./errors";
import { makeProfileService } from "./profiles";
import type { DrizzleDatabase } from "./types";

export { Database } from "./context";
export {
  AbuseControlRejected,
  ContactRevealRejected,
  DatabaseUnavailable,
  ProfileControlRejected,
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
    memberId?: string;
    apiKeyId?: string;
    source?: "web" | "api" | "mcp";
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

  const abuse = <A>(name: string, operation: () => Promise<A>) =>
    Effect.tryPromise({
      try: operation,
      catch: (cause) =>
        cause instanceof AbuseControlError
          ? new AbuseControlRejected({ reason: cause.code })
          : new DatabaseUnavailable({ cause }),
    }).pipe(Effect.withSpan(name));

  const profileControl = <A>(name: string, operation: () => Promise<A>) =>
    Effect.tryPromise({
      try: operation,
      catch: (cause) =>
        cause instanceof ProfileControlError
          ? new ProfileControlRejected({ reason: cause.code })
          : new DatabaseUnavailable({ cause }),
    }).pipe(Effect.withSpan(name));

  return Database.of({
    activateOrganizationEntitlement: (input) =>
      abuse("Database.activateOrganizationEntitlement", () =>
        activateOrganizationEntitlement(database, input),
      ),
    assertMemberActive: (memberId) =>
      abuse("Database.assertMemberActive", () =>
        assertMemberActive(database, memberId),
      ),
    assertPrincipalActive: (input) =>
      abuse("Database.assertPrincipalActive", () =>
        assertPrincipalActive(database, input),
      ),
    check,
    getBillingCustomerSeed: (input) =>
      saved("Database.getBillingCustomerSeed", () =>
        getBillingCustomerSeed(database, input),
      ),
    getOrganizationBillingOverview: (organizationId) =>
      saved("Database.getOrganizationBillingOverview", () =>
        getOrganizationBillingOverview(database, organizationId),
      ),
    claimPolarCheckout: (input) =>
      saved("Database.claimPolarCheckout", () =>
        claimPolarCheckout(database, input),
      ),
    beginPolarCheckoutCreation: (input) =>
      saved("Database.beginPolarCheckoutCreation", () =>
        beginPolarCheckoutCreation(database, input),
      ),
    completePolarCheckout: (input) =>
      saved("Database.completePolarCheckout", () =>
        completePolarCheckout(database, input),
      ),
    clearPolarCheckoutClaim: (input) =>
      saved("Database.clearPolarCheckoutClaim", () =>
        clearPolarCheckoutClaim(database, input),
      ),
    releaseExpiredPolarCheckoutReconciliation: (input) =>
      saved("Database.releaseExpiredPolarCheckoutReconciliation", () =>
        releaseExpiredPolarCheckoutReconciliation(database, input),
      ),
    releasePolarCheckoutLease: (input) =>
      saved("Database.releasePolarCheckoutLease", () =>
        releasePolarCheckoutLease(database, input),
      ),
    recordPolarCustomer: (input) =>
      saved("Database.recordPolarCustomer", () =>
        recordPolarCustomer(database, input),
      ),
    recordPolarOrderRefund: (input) =>
      saved("Database.recordPolarOrderRefund", () =>
        recordPolarOrderRefund(database, input),
      ),
    ...makeClerkService(database),
    ...makeProfileService(database),
    editControlledProfile: (input) =>
      profileControl("Database.editControlledProfile", () =>
        editControlledProfile(database, input),
      ),
    findClaimCandidates: (identity) =>
      saved("Database.findClaimCandidates", () =>
        findClaimCandidates(database, identity),
      ),
    getMemberProfileClaim: (memberId) =>
      saved("Database.getMemberProfileClaim", () =>
        getMemberProfileClaim(database, memberId),
      ),
    requestProfileClaim: (input) =>
      profileControl("Database.requestProfileClaim", () =>
        requestProfileClaim(database, input),
      ),
    setMemberStatements: (input) =>
      profileControl("Database.setMemberStatements", () =>
        setMemberStatements(database, input),
      ),
    setProfileSearchability: (memberId, searchable, verification) =>
      profileControl("Database.setProfileSearchability", () =>
        setProfileSearchability(database, memberId, searchable, verification),
      ),
    suppressKnownMinorProfile: (githubAccountId) =>
      profileControl("Database.suppressKnownMinorProfile", () =>
        suppressKnownMinorProfile(database, githubAccountId),
      ),
    submitPublicProfileRequest: (input) =>
      profileControl("Database.submitPublicProfileRequest", () =>
        submitPublicProfileRequest(database, input),
      ),
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
    getOperatorOverview: () =>
      saved("Database.getOperatorOverview", () =>
        getOperatorOverview(database),
      ),
    recordOperatorAudit: (context, action, subjectType, subjectId) =>
      saved("Database.recordOperatorAudit", () =>
        recordOperatorAudit(database, context, action, subjectType, subjectId),
      ),
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
    reviewClaimAsOperator: (claimId, approved, context) =>
      saved("Database.reviewClaimAsOperator", () =>
        reviewClaimAsOperator(database, claimId, approved, context),
      ),
    reviewRequestAsOperator: (requestId, confirmed, context) =>
      saved("Database.reviewRequestAsOperator", () =>
        reviewRequestAsOperator(database, requestId, confirmed, context),
      ),
    verifyRequestAsOperator: (requestId, context) =>
      saved("Database.verifyRequestAsOperator", () =>
        verifyRequestAsOperator(database, requestId, context),
      ),
    suppressProfileAsOperator: (input, context) =>
      saved("Database.suppressProfileAsOperator", () =>
        suppressProfileAsOperator(database, input, context),
      ),
    adjustCreditsAsOperator: (input, context) =>
      saved("Database.adjustCreditsAsOperator", () =>
        adjustCreditsAsOperator(database, input, context),
      ),
    retryReconciliationAsOperator: (reconciliationId, context, readMeter) =>
      saved("Database.retryReconciliationAsOperator", () =>
        retryReconciliationAsOperator(
          database,
          reconciliationId,
          context,
          readMeter,
        ),
      ),
    redriveCreditUsageAsOperator: (ids, context) =>
      saved("Database.redriveCreditUsageAsOperator", () =>
        redriveCreditUsageAsOperator(database, ids, context),
      ),
    suspendPrincipalAsOperator: (input, context) =>
      saved("Database.suspendPrincipalAsOperator", () =>
        suspendPrincipalAsOperator(database, input, context),
      ),
    revokeSuspensionAsOperator: (suspensionId, context) =>
      saved("Database.revokeSuspensionAsOperator", () =>
        revokeSuspensionAsOperator(database, suspensionId, context),
      ),
    recordSecurityActivity: (input) =>
      abuse("Database.recordSecurityActivity", () =>
        recordSecurityActivity(database, input),
      ),
    recordAttemptedExport: (input) =>
      saved("Database.recordAttemptedExport", () =>
        recordSecurityAudit(database, {
          ...input,
          eventType: "attempted_export",
          result: "rejected",
        }),
      ),
    revokeSuspension: (suspensionId) =>
      saved("Database.revokeSuspension", () =>
        revokeSuspension(database, suspensionId),
      ),
    setPolarSubscriptionStatus: (input) =>
      saved("Database.setPolarSubscriptionStatus", () =>
        setPolarSubscriptionStatus(database, input),
      ),
    suspendPrincipal: (input) =>
      saved("Database.suspendPrincipal", () =>
        suspendPrincipal(database, input),
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
