import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { recordEmployment, staleCurrentEmployment } from "./companies";
import { invalidateContactDetailObservationsInTransaction } from "./contact-reveals";
import { enqueueAffectedMemberEditDispatches } from "./enrichment";
import {
  canonicalGitHubAccountId,
  lockGitHubIdentity,
} from "./github-identity";
import {
  type CanonicalIdentityVerification,
  isProfessionalLink,
  professionalLinkIdentity,
  verifiedProfessionalLink,
} from "./professional-links";
import { suppressGitHubIdentityInTransaction } from "./profile-suppression";
import {
  memberStatements,
  operatorAuditEvents,
  professionalLinks,
  profileClaims,
  profileObservations,
  profileRequests,
  profiles,
  suppressionRecords,
} from "./schema";
import type { GitHubVerification } from "./service/types";

type Database =
  | NeonDatabase<typeof import("./schema")>
  | NodePgDatabase<typeof import("./schema")>;
export type ClaimStatus = "verified" | "pending_review" | "rejected";
export type { CanonicalIdentityVerification } from "./professional-links";

export type ProfileControlErrorCode =
  | "canonical_identity_change_requires_verification"
  | "canonical_identity_mismatch"
  | "claim_collision"
  | "claim_evidence_required"
  | "claim_not_pending"
  | "confirmed_correction_requires_changes"
  | "member_claim_conflict"
  | "invalid_profile_correction"
  | "invalid_professional_link"
  | "profile_already_claimed"
  | "profile_not_controlled"
  | "profile_not_found"
  | "profile_eligibility_verification_required"
  | "profile_ineligible"
  | "profile_searchability_locked"
  | "profile_suppressed"
  | "request_already_active"
  | "request_not_pending"
  | "request_verification_evidence_required";

export class ProfileControlError extends Error {
  constructor(readonly code: ProfileControlErrorCode) {
    super(code);
    this.name = "ProfileControlError";
  }
}

/** Finds likely Imported Profiles without implying that the Member controls them. */
export const findClaimCandidates = (
  database: Database,
  identity: { githubAccountId: string },
) => {
  const githubAccountId = canonicalGitHubAccountId(identity.githubAccountId);
  if (githubAccountId === null)
    throw new ProfileControlError("canonical_identity_mismatch");
  return database
    .select({
      profileId: profiles.profileId,
      name: profiles.name,
      githubLogin: profiles.githubLogin,
    })
    .from(profiles)
    .leftJoin(
      profileClaims,
      and(
        eq(profileClaims.profileId, profiles.profileId),
        eq(profileClaims.status, "verified"),
      ),
    )
    .leftJoin(
      suppressionRecords,
      and(
        eq(suppressionRecords.canonicalProvider, "github"),
        eq(suppressionRecords.canonicalProviderId, profiles.githubAccountId),
      ),
    )
    .where(
      and(
        eq(profiles.githubAccountId, githubAccountId),
        isNull(profiles.memberId),
        isNull(profileClaims.id),
        isNull(suppressionRecords.canonicalProviderId),
        ne(profiles.searchabilityReason, "disputed"),
        ne(profiles.searchabilityReason, "operator_suppression"),
      ),
    )
    .limit(5);
};

export const getMemberProfileClaim = async (
  database: Database,
  memberId: string,
) => {
  const [claim] = await database
    .select({ status: profileClaims.status })
    .from(profileClaims)
    .where(
      and(
        eq(profileClaims.memberId, memberId),
        eq(profileClaims.status, "pending_review"),
      ),
    )
    .limit(1);
  return claim?.status === "pending_review"
    ? { status: claim.status as "pending_review" }
    : null;
};

export const requestProfileClaim = async (
  database: Database,
  input: {
    profileId: string;
    memberId: string;
    oauthGithubAccountId: string;
    oauthGithubLogin: string;
  },
) => {
  const oauthGithubAccountId = canonicalGitHubAccountId(
    input.oauthGithubAccountId,
  );
  if (
    oauthGithubAccountId === null ||
    !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(input.oauthGithubLogin)
  ) {
    throw new ProfileControlError("canonical_identity_mismatch");
  }
  try {
    return await database.transaction(async (tx) => {
      const [identity] = await tx
        .select({ githubAccountId: profiles.githubAccountId })
        .from(profiles)
        .where(eq(profiles.profileId, input.profileId))
        .limit(1);
      if (!identity) throw new ProfileControlError("profile_not_found");
      await lockGitHubIdentity(tx, identity.githubAccountId);
      const [profile] = await tx
        .select()
        .from(profiles)
        .where(eq(profiles.profileId, input.profileId))
        .limit(1)
        .for("update");
      if (!profile) throw new ProfileControlError("profile_not_found");
      if (
        profile.searchabilityReason === "disputed" ||
        profile.searchabilityReason === "operator_suppression"
      )
        throw new ProfileControlError("profile_suppressed");
      const suppression = await tx
        .select({ canonicalProviderId: suppressionRecords.canonicalProviderId })
        .from(suppressionRecords)
        .where(
          and(
            eq(suppressionRecords.canonicalProvider, "github"),
            eq(suppressionRecords.canonicalProviderId, profile.githubAccountId),
          ),
        )
        .limit(1);
      if (suppression.length > 0)
        throw new ProfileControlError("profile_suppressed");
      if (profile.memberId !== null) {
        if (profile.memberId !== input.memberId)
          throw new ProfileControlError("profile_already_claimed");
        const [existingClaim] = await tx
          .select()
          .from(profileClaims)
          .where(
            and(
              eq(profileClaims.profileId, profile.profileId),
              eq(profileClaims.memberId, input.memberId),
              eq(profileClaims.status, "verified"),
            ),
          )
          .limit(1);
        if (existingClaim) return existingClaim;
        throw new ProfileControlError("profile_already_claimed");
      }
      const controlledProfile = await tx
        .select({ profileId: profiles.profileId })
        .from(profiles)
        .where(eq(profiles.memberId, input.memberId))
        .limit(1);
      const claims = await tx
        .select()
        .from(profileClaims)
        .where(
          and(
            or(
              eq(profileClaims.profileId, input.profileId),
              eq(profileClaims.memberId, input.memberId),
            ),
            inArray(profileClaims.status, ["pending_review", "verified"]),
          ),
        )
        .for("update");
      if (controlledProfile.length > 0)
        throw new ProfileControlError("profile_already_claimed");

      const targetClaim = claims.find(
        (claim) => claim.profileId === input.profileId,
      );
      const memberClaim = claims.find(
        (claim) => claim.memberId === input.memberId,
      );
      const exactIdentity = profile.githubAccountId === oauthGithubAccountId;
      if (
        targetClaim &&
        targetClaim.memberId !== input.memberId &&
        targetClaim.status === "verified"
      ) {
        throw new ProfileControlError("profile_already_claimed");
      }
      if (
        targetClaim &&
        targetClaim.memberId !== input.memberId &&
        targetClaim.status === "pending_review" &&
        !exactIdentity
      )
        throw new ProfileControlError("profile_already_claimed");
      if (
        memberClaim &&
        memberClaim.profileId !== input.profileId &&
        memberClaim.status !== "rejected"
      ) {
        throw new ProfileControlError("member_claim_conflict");
      }

      if (
        exactIdentity &&
        targetClaim?.status === "pending_review" &&
        targetClaim.memberId !== input.memberId
      ) {
        await tx
          .update(profileClaims)
          .set({ status: "superseded", reviewedAt: new Date() })
          .where(eq(profileClaims.id, targetClaim.id));
      }

      const status: ClaimStatus = exactIdentity ? "verified" : "pending_review";
      const ownClaim =
        targetClaim?.memberId === input.memberId ? targetClaim : undefined;
      const [claim] = ownClaim
        ? await tx
            .update(profileClaims)
            .set({
              githubAccountId: oauthGithubAccountId,
              githubLogin: input.oauthGithubLogin,
              status,
              reviewedAt: null,
            })
            .where(eq(profileClaims.id, ownClaim.id))
            .returning()
        : await tx
            .insert(profileClaims)
            .values({
              profileId: input.profileId,
              memberId: input.memberId,
              githubAccountId: oauthGithubAccountId,
              githubLogin: input.oauthGithubLogin,
              status,
            })
            .returning();
      if (!claim) throw new Error("profile_claim_not_created");
      if (status === "verified") {
        const [controlled] = await tx
          .update(profiles)
          .set({
            memberId: input.memberId,
            githubLogin: input.oauthGithubLogin,
            searchable: false,
            searchabilityReason: "member_opt_out",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(profiles.profileId, input.profileId),
              eq(profiles.githubAccountId, oauthGithubAccountId),
              isNull(profiles.memberId),
            ),
          )
          .returning();
        if (!controlled) throw new ProfileControlError("claim_collision");
      }
      return claim;
    });
  } catch (error) {
    if (error instanceof ProfileControlError) throw error;
    if (databaseErrorCode(error) === "23505")
      throw new ProfileControlError("profile_already_claimed");
    throw error;
  }
};

export const reviewProfileClaim = (
  database: Database,
  claimId: string,
  approved: boolean,
  operator?: {
    operatorId: string;
    correlationId: string;
    reason?: string;
    evidenceReference?: string;
  },
) =>
  database.transaction(async (tx) => {
    const [claimIdentity] = await tx
      .select({ profileId: profileClaims.profileId })
      .from(profileClaims)
      .where(eq(profileClaims.id, claimId))
      .limit(1);
    if (!claimIdentity) throw new ProfileControlError("claim_not_pending");
    const [identity] = await tx
      .select({ githubAccountId: profiles.githubAccountId })
      .from(profiles)
      .where(eq(profiles.profileId, claimIdentity.profileId))
      .limit(1);
    if (!identity) throw new ProfileControlError("profile_not_found");
    await lockGitHubIdentity(tx, identity.githubAccountId);
    const [target] = await tx
      .select()
      .from(profiles)
      .where(eq(profiles.profileId, claimIdentity.profileId))
      .limit(1)
      .for("update");
    if (!target) throw new ProfileControlError("profile_not_found");
    const [claim] = await tx
      .select()
      .from(profileClaims)
      .where(eq(profileClaims.id, claimId))
      .limit(1)
      .for("update");
    if (claim?.status !== "pending_review")
      throw new ProfileControlError("claim_not_pending");
    if (approved) {
      const identityMismatch = target.githubAccountId !== claim.githubAccountId;
      if (identityMismatch && !operator?.evidenceReference?.trim())
        throw new ProfileControlError("claim_evidence_required");
      if (target.memberId !== null) {
        throw new ProfileControlError("profile_already_claimed");
      }
      if (
        target.searchabilityReason === "disputed" ||
        target.searchabilityReason === "operator_suppression"
      ) {
        throw new ProfileControlError("profile_suppressed");
      }
      const [suppression] = await tx
        .select({ canonicalProviderId: suppressionRecords.canonicalProviderId })
        .from(suppressionRecords)
        .where(
          and(
            eq(suppressionRecords.canonicalProvider, "github"),
            eq(suppressionRecords.canonicalProviderId, target.githubAccountId),
          ),
        )
        .limit(1);
      if (suppression) throw new ProfileControlError("profile_suppressed");
      const [profile] = await tx
        .update(profiles)
        .set({
          memberId: claim.memberId,
          ...(!identityMismatch && claim.githubLogin !== null
            ? { githubLogin: claim.githubLogin }
            : {}),
          searchable: false,
          searchabilityReason: "member_opt_out",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(profiles.profileId, claim.profileId),
            isNull(profiles.memberId),
          ),
        )
        .returning();
      if (!profile) throw new ProfileControlError("profile_already_claimed");
    }
    const [reviewed] = await tx
      .update(profileClaims)
      .set({
        status: approved ? "verified" : "rejected",
        evidenceReference: approved
          ? (operator?.evidenceReference ?? null)
          : null,
        reviewedAt: new Date(),
      })
      .where(eq(profileClaims.id, claimId))
      .returning();
    if (!reviewed) throw new Error("profile_claim_not_reviewed");
    if (operator)
      await tx.insert(operatorAuditEvents).values({
        ...operator,
        action: approved ? "claim.approve" : "claim.reject",
        subjectType: "profile_claim",
        subjectId: claimId,
        metadata: {
          evidenceReference: operator.evidenceReference ?? null,
          targetGithubAccountId: target.githubAccountId,
          claimantGithubAccountId: claim.githubAccountId,
          claimantGithubLogin: claim.githubLogin,
        },
      });
    return reviewed;
  });

export const setMemberStatements = (
  database: Database,
  input: {
    memberId: string;
    statements: Record<string, string | string[] | null>;
  },
) =>
  database.transaction(async (tx) => {
    const [identity] = await tx
      .select({ githubAccountId: profiles.githubAccountId })
      .from(profiles)
      .where(eq(profiles.memberId, input.memberId))
      .limit(1);
    if (!identity) throw new ProfileControlError("profile_not_controlled");
    await lockGitHubIdentity(tx, identity.githubAccountId);
    const [profile] = await tx
      .select()
      .from(profiles)
      .where(eq(profiles.memberId, input.memberId))
      .limit(1)
      .for("update");
    if (!profile) throw new ProfileControlError("profile_not_controlled");
    if (profile.searchabilityReason === "disputed")
      throw new ProfileControlError("profile_searchability_locked");
    const [suppression] = await tx
      .select({ id: suppressionRecords.canonicalProviderId })
      .from(suppressionRecords)
      .where(
        and(
          eq(suppressionRecords.canonicalProvider, "github"),
          eq(suppressionRecords.canonicalProviderId, profile.githubAccountId),
        ),
      )
      .limit(1);
    if (
      profile.searchabilityReason === "operator_suppression" ||
      suppression !== undefined
    )
      throw new ProfileControlError("profile_suppressed");
    const statements = Object.entries(input.statements);
    for (const [field] of statements) {
      await tx
        .delete(memberStatements)
        .where(
          and(
            eq(memberStatements.profileId, profile.profileId),
            eq(memberStatements.field, field),
          ),
        );
    }
    const current = statements.filter(
      (statement): statement is [string, string | string[]] =>
        statement[1] !== null,
    );
    if (current.length > 0)
      await tx.insert(memberStatements).values(
        current.map(([field, value]) => ({
          id: crypto.randomUUID(),
          profileId: profile.profileId,
          field,
          value,
          source: "member",
          pipelineVersion: "member-v1",
          confidence: 1,
        })),
      );
  });

export const setMemberStatement = (
  database: Database,
  input: { memberId: string; field: string; value: string | string[] | null },
) =>
  setMemberStatements(database, {
    memberId: input.memberId,
    statements: { [input.field]: input.value },
  });

export const resolveProfileField = async (
  database: Database,
  profileId: string,
  field: string,
) => {
  const [statement] = await database
    .select({ value: memberStatements.value })
    .from(memberStatements)
    .where(
      and(
        eq(memberStatements.profileId, profileId),
        eq(memberStatements.field, field),
      ),
    )
    .orderBy(desc(memberStatements.collectedAt))
    .limit(1);
  if (statement) return { value: statement.value, source: "member" as const };
  const [observation] = await database
    .select({
      value: profileObservations.value,
      source: profileObservations.source,
    })
    .from(profileObservations)
    .where(
      and(
        eq(profileObservations.profileId, profileId),
        eq(profileObservations.field, field),
        isNull(profileObservations.staleAt),
      ),
    )
    .orderBy(
      desc(
        sql<number>`case
          when ${profileObservations.source} = 'public-profile-request' then 3
          when ${profileObservations.source} in ('github', 'github-ai-normalization', 'tikhub') then 2
          when ${profileObservations.source} = 'deepline' then 1
          else 0
        end`,
      ),
      desc(profileObservations.confidence),
      desc(profileObservations.collectedAt),
    )
    .limit(1);
  return observation
    ? {
        ...observation,
        source: "observation" as const,
        observationSource: observation.source,
      }
    : null;
};

export const setProfileSearchability = (
  database: Database,
  memberId: string,
  searchable: boolean,
  verification?: GitHubVerification,
  now = new Date(),
) => {
  const update = database.transaction(async (tx) => {
    const [identity] = await tx
      .select({ githubAccountId: profiles.githubAccountId })
      .from(profiles)
      .where(eq(profiles.memberId, memberId))
      .limit(1);
    if (!identity) throw new ProfileControlError("profile_not_controlled");
    await lockGitHubIdentity(tx, identity.githubAccountId);
    const [profile] = await tx
      .select()
      .from(profiles)
      .where(eq(profiles.memberId, memberId))
      .limit(1)
      .for("update");
    if (!profile) throw new ProfileControlError("profile_not_controlled");
    if (
      profile.searchabilityReason === "operator_suppression" ||
      profile.searchabilityReason === "disputed"
    ) {
      throw new ProfileControlError("profile_searchability_locked");
    }
    let eligibilityBasis = profile.eligibilityBasis;
    let githubLogin = profile.githubLogin;
    if (searchable) {
      if (!verification)
        throw new ProfileControlError(
          "profile_eligibility_verification_required",
        );
      const verifiedAccountId = canonicalGitHubAccountId(
        verification.accountId,
      );
      if (verification.knownMinor) {
        await suppressGitHubIdentityInTransaction(tx, {
          githubAccountId: profile.githubAccountId,
          reason: "known_minor",
          purge: true,
          detachMember: false,
          now,
        });
        return null;
      }
      const contributionCutoff = new Date(now);
      contributionCutoff.setUTCFullYear(
        contributionCutoff.getUTCFullYear() - 1,
      );
      contributionCutoff.setUTCHours(0, 0, 0, 0);
      const hasRecentContribution =
        verification.contributedPubliclySince !== null &&
        verification.contributedPubliclySince >= contributionCutoff;
      if (
        verifiedAccountId !== profile.githubAccountId ||
        verification.accountType !== "User" ||
        !verification.ownershipVerified ||
        (!verification.ownsNonForkRepository &&
          !hasRecentContribution &&
          profile.eligibilityBasis !== "private_attestation")
      ) {
        throw new ProfileControlError("profile_ineligible");
      }
      eligibilityBasis = verification.ownsNonForkRepository
        ? "owned_repository"
        : hasRecentContribution
          ? "public_contribution"
          : "private_attestation";
      githubLogin = verification.login;
    }
    const [updated] = await tx
      .update(profiles)
      .set({
        searchable,
        searchabilityReason: searchable ? "member_opt_in" : "member_opt_out",
        eligibilityBasis,
        githubLogin,
        updatedAt: new Date(),
      })
      .where(eq(profiles.profileId, profile.profileId))
      .returning();
    if (!updated) throw new Error("profile_searchability_not_updated");
    return updated;
  });
  return update.then((profile) => {
    if (profile === null) throw new ProfileControlError("profile_suppressed");
    return profile;
  });
};

export const suppressKnownMinorProfile = (
  database: Database,
  githubAccountId: string,
) =>
  database.transaction((transaction) =>
    suppressGitHubIdentityInTransaction(transaction, {
      githubAccountId,
      reason: "known_minor",
      purge: true,
      detachMember: false,
    }),
  );

export const editControlledProfile = (
  database: Database,
  input: {
    memberId: string;
    name: string;
    currentCompany: string | null;
    professionalLinks: string[];
    statements?: Record<string, string | string[] | null>;
    canonicalIdentityVerification?: CanonicalIdentityVerification;
  },
) =>
  database.transaction(async (tx) => {
    const [identity] = await tx
      .select({ githubAccountId: profiles.githubAccountId })
      .from(profiles)
      .where(eq(profiles.memberId, input.memberId))
      .limit(1);
    if (!identity) throw new ProfileControlError("profile_not_found");
    await lockGitHubIdentity(tx, identity.githubAccountId);
    const [profile] = await tx
      .select()
      .from(profiles)
      .where(eq(profiles.memberId, input.memberId))
      .limit(1)
      .for("update");
    if (!profile) throw new ProfileControlError("profile_not_controlled");
    if (profile.searchabilityReason === "disputed")
      throw new ProfileControlError("profile_searchability_locked");
    const [suppression] = await tx
      .select({ id: suppressionRecords.canonicalProviderId })
      .from(suppressionRecords)
      .where(
        and(
          eq(suppressionRecords.canonicalProvider, "github"),
          eq(suppressionRecords.canonicalProviderId, profile.githubAccountId),
        ),
      )
      .limit(1);
    if (
      profile.searchabilityReason === "operator_suppression" ||
      suppression !== undefined
    )
      throw new ProfileControlError("profile_suppressed");
    const existingLinks = await tx
      .select()
      .from(professionalLinks)
      .where(eq(professionalLinks.profileId, profile.profileId));
    verifyCanonicalProfileLinks(
      profile.githubAccountId,
      existingLinks.map(({ url }) => url),
      input.professionalLinks,
      input.canonicalIdentityVerification,
    );
    const githubLogin =
      input.canonicalIdentityVerification?.github?.login ?? profile.githubLogin;
    const now = new Date();
    await tx
      .update(profiles)
      .set({
        name: input.name,
        currentCompany: input.currentCompany,
        githubLogin,
        updatedAt: now,
      })
      .where(eq(profiles.profileId, profile.profileId));
    await staleCurrentEmployment(tx, profile.profileId, "member", now);
    if (input.currentCompany !== null)
      await recordEmployment(tx, {
        profileId: profile.profileId,
        companyName: input.currentCompany,
        current: true,
        source: "member",
        sourceRecordId: input.memberId,
        pipelineVersion: "member-v1",
        confidence: 1,
        collectedAt: now,
      });
    await tx
      .delete(professionalLinks)
      .where(eq(professionalLinks.profileId, profile.profileId));
    if (input.professionalLinks.length > 0) {
      await tx.insert(professionalLinks).values(
        input.professionalLinks.map((url) => {
          const existing = existingLinks.find((link) => link.url === url);
          const verified = verifiedProfessionalLink(
            url,
            input.canonicalIdentityVerification,
            now,
          );
          return verified === undefined && existing !== undefined
            ? existing
            : {
                profileId: profile.profileId,
                url,
                source: "member",
                sourceRecordId: input.memberId,
                ...verified,
              };
        }),
      );
    }
    if (input.statements) {
      for (const [field, value] of Object.entries(input.statements)) {
        await tx
          .delete(memberStatements)
          .where(
            and(
              eq(memberStatements.profileId, profile.profileId),
              eq(memberStatements.field, field),
            ),
          );
        if (value !== null)
          await tx.insert(memberStatements).values({
            id: crypto.randomUUID(),
            profileId: profile.profileId,
            field,
            value,
            source: "member",
            pipelineVersion: "member-v1",
            confidence: 1,
          });
      }
    }
    await enqueueAffectedMemberEditDispatches(tx, {
      memberId: input.memberId,
      profileId: profile.profileId,
      before: {
        name: profile.name,
        currentCompany: profile.currentCompany,
        githubLogin: profile.githubLogin,
        professionalLinks: existingLinks.map(({ url }) => url),
      },
      after: {
        name: input.name,
        currentCompany: input.currentCompany,
        githubLogin,
        professionalLinks: input.professionalLinks,
      },
    });
  });

export const submitPublicProfileRequest = (
  database: Database,
  input: {
    profileId: string;
    kind: "correction" | "removal";
    requesterEmail: string;
    details: string;
  },
) =>
  database.transaction(async (tx) => {
    const [identity] = await tx
      .select({ githubAccountId: profiles.githubAccountId })
      .from(profiles)
      .where(eq(profiles.profileId, input.profileId))
      .limit(1);
    if (!identity) throw new ProfileControlError("profile_not_found");
    await lockGitHubIdentity(tx, identity.githubAccountId);
    const [profile] = await tx
      .select()
      .from(profiles)
      .where(eq(profiles.profileId, input.profileId))
      .limit(1)
      .for("update");
    if (!profile || profile.searchabilityReason === "operator_suppression") {
      throw new ProfileControlError("profile_not_found");
    }
    const [suppression] = await tx
      .select({ id: suppressionRecords.canonicalProviderId })
      .from(suppressionRecords)
      .where(
        and(
          eq(suppressionRecords.canonicalProvider, "github"),
          eq(suppressionRecords.canonicalProviderId, profile.githubAccountId),
        ),
      )
      .limit(1);
    if (suppression) throw new ProfileControlError("profile_not_found");
    const now = new Date();
    await tx
      .update(profileRequests)
      .set({
        status: "expired",
        requesterEmail: "expired@example.invalid",
        details: "Expired before verification",
        reviewedAt: now,
      })
      .where(
        and(
          eq(profileRequests.profileId, profile.profileId),
          eq(profileRequests.status, "awaiting_verification"),
          lt(
            profileRequests.createdAt,
            new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
          ),
        ),
      );
    const [request] = await tx
      .insert(profileRequests)
      .values({
        ...input,
        previousSearchable: profile.searchable,
        previousSearchabilityReason: profile.searchabilityReason,
        status: "awaiting_verification",
      })
      .returning();
    if (!request) throw new Error("profile_request_not_created");
    return request;
  });

export type ProfileRequestVerification = {
  operatorId: string;
  correlationId: string;
  reason?: string;
  verificationMethod: string;
  evidenceReference: string;
};

export type OperatorProfileCorrection = {
  name?: string;
  currentCompany?: string | null;
  headline?: string | null;
  currentResidence?: string | null;
  roles?: string[];
  skills?: string[];
  seniority?: string | null;
  experienceYears?: number | null;
  opportunityStatus?: "open" | "not_open" | "unspecified";
  professionalLinks?: string[];
  invalidContactObservationIds?: string[];
};

const normalizeOperatorCorrection = (
  correction: OperatorProfileCorrection,
): OperatorProfileCorrection => {
  const normalized = { ...correction };
  for (const field of [
    "name",
    "currentCompany",
    "headline",
    "currentResidence",
    "seniority",
  ] as const) {
    const value = normalized[field];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) throw new ProfileControlError("invalid_profile_correction");
    normalized[field] = trimmed;
  }
  for (const field of ["roles", "skills"] as const) {
    const values = normalized[field];
    if (values === undefined) continue;
    const trimmed = values.map((value) => value.trim());
    if (
      trimmed.some((value) => !value) ||
      new Set(trimmed).size !== trimmed.length
    )
      throw new ProfileControlError("invalid_profile_correction");
    normalized[field] = trimmed;
  }
  if (
    normalized.experienceYears !== undefined &&
    normalized.experienceYears !== null &&
    (!Number.isFinite(normalized.experienceYears) ||
      normalized.experienceYears < 0)
  )
    throw new ProfileControlError("invalid_profile_correction");
  if (
    normalized.professionalLinks !== undefined &&
    (normalized.professionalLinks.length === 0 ||
      normalized.professionalLinks.some((link) => !isProfessionalLink(link)) ||
      new Set(normalized.professionalLinks).size !==
        normalized.professionalLinks.length)
  )
    throw new ProfileControlError("invalid_professional_link");
  if (
    normalized.invalidContactObservationIds !== undefined &&
    (normalized.invalidContactObservationIds.length === 0 ||
      normalized.invalidContactObservationIds.length > 100 ||
      normalized.invalidContactObservationIds.some((id) => !id.trim()) ||
      new Set(normalized.invalidContactObservationIds).size !==
        normalized.invalidContactObservationIds.length)
  )
    throw new ProfileControlError("invalid_profile_correction");
  return normalized;
};

export const verifyProfileRequest = (
  database: Database,
  requestId: string,
  verification: ProfileRequestVerification,
) => {
  if (
    !verification.verificationMethod?.trim() ||
    !verification.evidenceReference?.trim()
  )
    throw new ProfileControlError("request_verification_evidence_required");
  return database.transaction(async (tx) => {
    const [requestIdentity] = await tx
      .select({ profileId: profileRequests.profileId })
      .from(profileRequests)
      .where(eq(profileRequests.id, requestId))
      .limit(1);
    if (!requestIdentity) throw new ProfileControlError("request_not_pending");
    const [identity] = await tx
      .select({ githubAccountId: profiles.githubAccountId })
      .from(profiles)
      .where(eq(profiles.profileId, requestIdentity.profileId))
      .limit(1);
    if (!identity) throw new ProfileControlError("profile_not_found");
    await lockGitHubIdentity(tx, identity.githubAccountId);
    const [profile] = await tx
      .select()
      .from(profiles)
      .where(eq(profiles.profileId, requestIdentity.profileId))
      .limit(1)
      .for("update");
    if (!profile || profile.searchabilityReason === "operator_suppression")
      throw new ProfileControlError("profile_not_found");
    const [suppression] = await tx
      .select({ id: suppressionRecords.canonicalProviderId })
      .from(suppressionRecords)
      .where(
        and(
          eq(suppressionRecords.canonicalProvider, "github"),
          eq(suppressionRecords.canonicalProviderId, profile.githubAccountId),
        ),
      )
      .limit(1);
    if (suppression) throw new ProfileControlError("profile_not_found");
    const [request] = await tx
      .select()
      .from(profileRequests)
      .where(eq(profileRequests.id, requestId))
      .limit(1)
      .for("update");
    const alreadyVerified = Boolean(
      request?.verificationMethod?.trim() &&
        request.verificationEvidenceReference?.trim() &&
        request.verifiedAt !== null,
    );
    if (
      request === undefined ||
      (request.status !== "awaiting_verification" &&
        !(request.status === "pending" && !alreadyVerified))
    )
      throw new ProfileControlError("request_not_pending");
    const [activeReview] = await tx
      .select({ id: profileRequests.id })
      .from(profileRequests)
      .where(
        and(
          eq(profileRequests.profileId, request.profileId),
          eq(profileRequests.status, "pending"),
          ne(profileRequests.id, request.id),
        ),
      )
      .limit(1);
    if (activeReview)
      throw new ProfileControlError("request_already_active");
    const now = new Date();
    const [verified] = await tx
      .update(profileRequests)
      .set({
        status: "pending",
        ...(profile.searchabilityReason === "disputed"
          ? {}
          : {
              previousSearchable: profile.searchable,
              previousSearchabilityReason: profile.searchabilityReason,
            }),
        verificationMethod: verification.verificationMethod.trim(),
        verificationEvidenceReference: verification.evidenceReference.trim(),
        verifiedAt: now,
      })
      .where(eq(profileRequests.id, requestId))
      .returning();
    await tx
      .update(profiles)
      .set({
        searchable: false,
        searchabilityReason: "disputed",
        updatedAt: now,
      })
      .where(eq(profiles.profileId, profile.profileId));
    await tx.insert(operatorAuditEvents).values({
      operatorId: verification.operatorId,
      correlationId: verification.correlationId,
      reason: verification.reason,
      action: "profile_request.verify",
      subjectType: "profile_request",
      subjectId: requestId,
      metadata: {
        verificationMethod: verification.verificationMethod.trim(),
        evidenceReference: verification.evidenceReference.trim(),
      },
    });
    if (!verified) throw new Error("profile_request_not_verified");
    return verified;
  });
};

export const reviewProfileRequest = (
  database: Database,
  requestId: string,
  confirmed: boolean,
  operator: {
    operatorId: string;
    correlationId: string;
    reason?: string;
    correction?: OperatorProfileCorrection;
  },
) =>
  database.transaction(async (tx) => {
    const [requestIdentity] = await tx
      .select({ profileId: profileRequests.profileId })
      .from(profileRequests)
      .where(eq(profileRequests.id, requestId))
      .limit(1);
    if (!requestIdentity) throw new ProfileControlError("request_not_pending");
    const [identity] = await tx
      .select({ githubAccountId: profiles.githubAccountId })
      .from(profiles)
      .where(eq(profiles.profileId, requestIdentity.profileId))
      .limit(1);
    if (!identity) throw new ProfileControlError("profile_not_found");
    await lockGitHubIdentity(tx, identity.githubAccountId);
    const [profile] = await tx
      .select()
      .from(profiles)
      .where(eq(profiles.profileId, requestIdentity.profileId))
      .limit(1)
      .for("update");
    if (!profile || profile.searchabilityReason === "operator_suppression")
      throw new ProfileControlError("profile_not_found");
    const [suppression] = await tx
      .select({ id: suppressionRecords.canonicalProviderId })
      .from(suppressionRecords)
      .where(
        and(
          eq(suppressionRecords.canonicalProvider, "github"),
          eq(suppressionRecords.canonicalProviderId, profile.githubAccountId),
        ),
      )
      .limit(1);
    if (suppression) throw new ProfileControlError("profile_not_found");
    const [request] = await tx
      .select()
      .from(profileRequests)
      .where(eq(profileRequests.id, requestId))
      .limit(1)
      .for("update");
    if (
      request === undefined ||
      (request.status !== "pending" &&
        !(request.status === "awaiting_verification" && !confirmed))
    )
      throw new ProfileControlError("request_not_pending");
    const verified = Boolean(
      request.verificationMethod?.trim() &&
        request.verificationEvidenceReference?.trim() &&
        request.verifiedAt !== null,
    );
    if (confirmed && !verified)
      throw new ProfileControlError("request_verification_evidence_required");
    const [otherVerifiedRequest] = await tx
      .select({ id: profileRequests.id })
      .from(profileRequests)
      .where(
        and(
          eq(profileRequests.profileId, request.profileId),
          eq(profileRequests.status, "pending"),
          ne(profileRequests.id, request.id),
        ),
      )
      .limit(1);
    const restoresSearchability =
      verified &&
      request.status === "pending" &&
      profile.searchabilityReason === "disputed" &&
      otherVerifiedRequest === undefined;
    if (confirmed && request.kind === "removal") {
      await suppressGitHubIdentityInTransaction(tx, {
        githubAccountId: profile.githubAccountId,
        reason: "person_requested_removal",
        purge: true,
      });
      await tx
        .update(profileRequests)
        .set({
          status: "superseded",
          requesterEmail: "removed@example.invalid",
          details: "Removed after confirmed request",
          reviewedAt: new Date(),
        })
        .where(
          and(
            eq(profileRequests.profileId, profile.profileId),
            eq(profileRequests.status, "pending"),
            ne(profileRequests.id, request.id),
          ),
        );
    } else if (confirmed && request.kind === "correction") {
      const correction =
        operator.correction === undefined
          ? undefined
          : normalizeOperatorCorrection(operator.correction);
      if (correction === undefined || Object.keys(correction).length === 0)
        throw new ProfileControlError("confirmed_correction_requires_changes");
      const now = new Date();
      await tx
        .update(profiles)
        .set({
          ...(correction.name === undefined ? {} : { name: correction.name }),
          ...(correction.currentCompany === undefined
            ? {}
            : { currentCompany: correction.currentCompany }),
          searchable: restoresSearchability
            ? request.previousSearchable
            : profile.searchable,
          searchabilityReason: restoresSearchability
            ? request.previousSearchabilityReason
            : profile.searchabilityReason,
          updatedAt: now,
        })
        .where(eq(profiles.profileId, profile.profileId));
      const correctionValues: Array<[string, unknown]> = [
        ["name", correction.name],
        ["current_company", correction.currentCompany],
        ["headline", correction.headline],
        ["current_residence", correction.currentResidence],
        ["role", correction.roles],
        ["skills", correction.skills],
        ["seniority", correction.seniority],
        ["experience_years", correction.experienceYears],
        ["opportunity_status", correction.opportunityStatus],
      ];
      const correctedObservations = correctionValues.flatMap(
        ([field, value]) =>
          value === undefined
            ? []
            : [
                {
                  profileId: profile.profileId,
                  field,
                  value: value === null ? sql`'null'::jsonb` : value,
                  source: "public-profile-request",
                  sourceRecordId: request.id,
                  pipelineVersion: "public-request-v1",
                  confidence: 1,
                  collectedAt: now,
                },
              ],
      );
      if (correctedObservations.length > 0)
        await tx.insert(profileObservations).values(correctedObservations);
      if (correction.currentCompany !== undefined) {
        await staleCurrentEmployment(
          tx,
          profile.profileId,
          "public-profile-request",
          now,
        );
        if (correction.currentCompany !== null)
          await recordEmployment(tx, {
            profileId: profile.profileId,
            companyName: correction.currentCompany,
            current: true,
            source: "public-profile-request",
            sourceRecordId: request.id,
            pipelineVersion: "public-request-v1",
            confidence: 1,
            collectedAt: now,
          });
      }
      if (correction.professionalLinks !== undefined) {
        const existingLinks = await tx
          .select()
          .from(professionalLinks)
          .where(eq(professionalLinks.profileId, profile.profileId));
        const existingByUrl = new Map(
          existingLinks.map((link) => [link.url, link]),
        );
        await tx
          .delete(professionalLinks)
          .where(eq(professionalLinks.profileId, profile.profileId));
        await tx.insert(professionalLinks).values(
          correction.professionalLinks.map((url) => ({
            ...(existingByUrl.get(url) ?? {
              profileId: profile.profileId,
              url,
            }),
            source: "public-profile-request",
            sourceRecordId: request.id,
          })),
        );
      }
      if (correction.invalidContactObservationIds !== undefined)
        await invalidateContactDetailObservationsInTransaction(tx, {
          profileId: profile.profileId,
          observationIds: correction.invalidContactObservationIds,
          reportedBy: operator.operatorId,
          reason: "profile-correction",
          actor: { type: "operator", id: operator.operatorId },
          operation: "contact_reveal.profile_correction.refund",
        });
    } else if (!confirmed && restoresSearchability) {
      await tx
        .update(profiles)
        .set({
          searchable: request.previousSearchable,
          searchabilityReason: request.previousSearchabilityReason,
          updatedAt: new Date(),
        })
        .where(eq(profiles.profileId, profile.profileId));
    }
    const [reviewed] = await tx
      .update(profileRequests)
      .set({
        status: confirmed ? "confirmed" : !verified ? "dismissed" : "rejected",
        reviewedAt: new Date(),
        ...(confirmed && request.kind === "removal"
          ? {
              requesterEmail: "removed@example.invalid",
              details: "Removed after confirmed request",
            }
          : {}),
      })
      .where(eq(profileRequests.id, requestId))
      .returning();
    if (!reviewed) throw new Error("profile_request_not_reviewed");
    const { correction: _, ...operatorAuditContext } = operator;
    const auditContext =
      confirmed && request.kind === "removal"
        ? {
            ...operatorAuditContext,
            reason: "Redacted after confirmed removal",
          }
        : operatorAuditContext;
    await tx.insert(operatorAuditEvents).values({
      ...auditContext,
      action: confirmed
        ? "profile_request.confirm"
        : !verified
          ? "profile_request.dismiss"
          : "profile_request.reject",
      subjectType: "profile_request",
      subjectId: requestId,
      metadata:
        request.kind === "correction" && operator.correction
          ? { correctedFields: Object.keys(operator.correction).sort() }
          : null,
    });
    return reviewed;
  });

type CanonicalIdentities = {
  github: string[];
  linkedIn: string[];
};

export const verifyCanonicalProfileLinks = (
  profileGithubAccountId: string,
  beforeLinks: string[],
  afterLinks: string[],
  verification?: CanonicalIdentityVerification,
) => {
  if (
    afterLinks.some((link) => !isProfessionalLink(link)) ||
    new Set(afterLinks).size !== afterLinks.length
  )
    throw new ProfileControlError("invalid_professional_link");
  return verifyCanonicalIdentityChange(
    profileGithubAccountId,
    canonicalIdentities(beforeLinks),
    canonicalIdentities(afterLinks),
    verification,
  );
};

const canonicalIdentities = (links: string[]): CanonicalIdentities => {
  const identities: CanonicalIdentities = { github: [], linkedIn: [] };
  for (const link of links) {
    const identity = professionalLinkIdentity(link);
    if (identity?.kind === "github") identities.github.push(identity.login);
    if (identity?.kind === "linkedin")
      identities.linkedIn.push(identity.username);
  }
  identities.github = [...new Set(identities.github)].sort();
  identities.linkedIn = [...new Set(identities.linkedIn)].sort();
  return identities;
};

const verifyCanonicalIdentityChange = (
  profileGithubAccountId: string,
  before: CanonicalIdentities,
  after: CanonicalIdentities,
  verification?: CanonicalIdentityVerification,
) => {
  const suppliedGitHub = verification?.github;
  if (
    suppliedGitHub !== undefined &&
    (suppliedGitHub.accountType !== "User" ||
      !suppliedGitHub.ownershipVerified ||
      suppliedGitHub.knownMinor ||
      canonicalGitHubAccountId(suppliedGitHub.accountId) !==
        profileGithubAccountId ||
      !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(suppliedGitHub.login))
  )
    throw new ProfileControlError("canonical_identity_mismatch");
  if (
    verification?.linkedIn !== undefined &&
    !verification.linkedIn.providerUserId?.trim()
  )
    throw new ProfileControlError("canonical_identity_mismatch");
  if (JSON.stringify(before.github) !== JSON.stringify(after.github)) {
    const github = verification?.github;
    if (!github)
      throw new ProfileControlError(
        "canonical_identity_change_requires_verification",
      );
    if (after.github.some((login) => login !== github.login.toLowerCase())) {
      throw new ProfileControlError("canonical_identity_mismatch");
    }
  }
  if (JSON.stringify(before.linkedIn) !== JSON.stringify(after.linkedIn)) {
    const linkedIn = verification?.linkedIn;
    if (!linkedIn)
      throw new ProfileControlError(
        "canonical_identity_change_requires_verification",
      );
    if (
      !linkedIn.providerUserId?.trim() ||
      after.linkedIn.some(
        (username) => username !== linkedIn.username.toLowerCase(),
      )
    ) {
      throw new ProfileControlError("canonical_identity_mismatch");
    }
  }
};

const databaseErrorCode = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : null;
