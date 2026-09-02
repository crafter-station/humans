import { and, desc, eq, isNull, ne, or } from "drizzle-orm";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  memberStatements,
  profileClaims,
  profileObservations,
  profileRequests,
  professionalLinks,
  profiles,
  suppressionRecords,
} from "./schema";

type Database =
  | NeonDatabase<typeof import("./schema")>
  | NodePgDatabase<typeof import("./schema")>;
export type ClaimStatus = "verified" | "pending_review" | "rejected";

/** Finds likely Imported Profiles without implying that the Member controls them. */
export const findClaimCandidates = (
  database: Database,
  identity: { githubAccountId: string; githubLogin?: string },
) =>
  database
    .select({
      profileId: profiles.profileId,
      name: profiles.name,
      githubLogin: profiles.githubLogin,
    })
    .from(profiles)
    .where(
      identity.githubLogin === undefined
        ? and(
            eq(profiles.githubAccountId, identity.githubAccountId),
            isNull(profiles.memberId),
            ne(profiles.searchabilityReason, "operator_suppression"),
          )
        : and(
            eq(profiles.githubAccountId, identity.githubAccountId),
            eq(profiles.githubLogin, identity.githubLogin),
            isNull(profiles.memberId),
            ne(profiles.searchabilityReason, "operator_suppression"),
          ),
    )
    .limit(5);

export const requestProfileClaim = (
  database: Database,
  input: {
    profileId: string;
    memberId: string;
    oauthGithubAccountId: string;
  },
) =>
  database.transaction(async (tx) => {
    const [profile] = await tx
      .select()
      .from(profiles)
      .where(eq(profiles.profileId, input.profileId))
      .limit(1);
    if (!profile) throw new Error("profile_not_found");
    if (profile.memberId !== null && profile.memberId !== input.memberId)
      throw new Error("profile_already_claimed");
    const [collision] = await tx
      .select()
      .from(profileClaims)
      .where(
        and(
          eq(profileClaims.profileId, input.profileId),
          ne(profileClaims.memberId, input.memberId),
        ),
      )
      .limit(1);
    if (collision) throw new Error("profile_already_claimed");
    const status: ClaimStatus =
      profile.githubAccountId === input.oauthGithubAccountId
        ? "verified"
        : "pending_review";
    const [claim] = await tx
      .insert(profileClaims)
      .values({
        profileId: input.profileId,
        memberId: input.memberId,
        githubAccountId: input.oauthGithubAccountId,
        status,
      })
      .onConflictDoUpdate({
        target: profileClaims.memberId,
        set: {
          profileId: input.profileId,
          githubAccountId: input.oauthGithubAccountId,
          status,
        },
      })
      .returning();
    if (status === "verified") {
      const [controlled] = await tx
        .update(profiles)
        .set({ memberId: input.memberId, updatedAt: new Date() })
        .where(
          and(
            eq(profiles.profileId, input.profileId),
            eq(profiles.githubAccountId, input.oauthGithubAccountId),
            or(
              isNull(profiles.memberId),
              eq(profiles.memberId, input.memberId),
            ),
          ),
        )
        .returning();
      if (!controlled) throw new Error("claim_collision");
    }
    return claim!;
  });

export const reviewProfileClaim = (
  database: Database,
  claimId: string,
  approved: boolean,
) =>
  database.transaction(async (tx) => {
    const [claim] = await tx
      .select()
      .from(profileClaims)
      .where(eq(profileClaims.id, claimId))
      .limit(1);
    if (!claim || claim.status !== "pending_review")
      throw new Error("claim_not_pending");
    if (approved) {
      const [profile] = await tx
        .update(profiles)
        .set({ memberId: claim.memberId, updatedAt: new Date() })
        .where(
          and(
            eq(profiles.profileId, claim.profileId),
            isNull(profiles.memberId),
          ),
        )
        .returning();
      if (!profile) throw new Error("profile_already_claimed");
    }
    const [reviewed] = await tx
      .update(profileClaims)
      .set({
        status: approved ? "verified" : "rejected",
        reviewedAt: new Date(),
      })
      .where(eq(profileClaims.id, claimId))
      .returning();
    return reviewed!;
  });

export const setMemberStatement = (
  database: Database,
  input: { memberId: string; field: string; value: string | string[] | null },
) =>
  database.transaction(async (tx) => {
    const [profile] = await tx
      .select({ profileId: profiles.profileId })
      .from(profiles)
      .where(eq(profiles.memberId, input.memberId))
      .limit(1);
    if (!profile) throw new Error("profile_not_controlled");
    await tx
      .delete(memberStatements)
      .where(
        and(
          eq(memberStatements.profileId, profile.profileId),
          eq(memberStatements.field, input.field),
        ),
      );
    if (input.value !== null)
      await tx.insert(memberStatements).values({
        id: crypto.randomUUID(),
        profileId: profile.profileId,
        field: input.field,
        value: input.value,
        source: "member",
        pipelineVersion: "member-v1",
        confidence: 1,
      });
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
      ),
    )
    .orderBy(desc(profileObservations.collectedAt))
    .limit(1);
  return observation
    ? {
        ...observation,
        source: "observation" as const,
        observationSource: observation.source,
      }
    : null;
};

export const setProfileSearchability = async (
  database: Database,
  memberId: string,
  searchable: boolean,
) => {
  const [profile] = await database
    .update(profiles)
    .set({
      searchable,
      searchabilityReason: searchable ? "member_opt_in" : "member_opt_out",
      updatedAt: new Date(),
    })
    .where(eq(profiles.memberId, memberId))
    .returning();
  if (!profile) throw new Error("profile_not_controlled");
  return profile;
};

export const editControlledProfile = (
  database: Database,
  input: {
    memberId: string;
    name: string;
    currentCompany: string | null;
    professionalLinks: string[];
    canonicalIdentityChangeVerified?: boolean;
  },
) =>
  database.transaction(async (tx) => {
    const [profile] = await tx
      .select()
      .from(profiles)
      .where(eq(profiles.memberId, input.memberId))
      .limit(1);
    if (!profile) throw new Error("profile_not_controlled");
    const existingLinks = await tx
      .select({ url: professionalLinks.url })
      .from(professionalLinks)
      .where(eq(professionalLinks.profileId, profile.profileId));
    const canonical = (url: string) =>
      /^(?:https?:\/\/)?(?:www\.)?(?:github\.com|linkedin\.com)\//i.test(url);
    const before = existingLinks
      .map(({ url }) => url)
      .filter(canonical)
      .sort();
    const after = input.professionalLinks.filter(canonical).sort();
    if (
      JSON.stringify(before) !== JSON.stringify(after) &&
      !input.canonicalIdentityChangeVerified
    ) {
      throw new Error("canonical_identity_change_requires_verification");
    }
    await tx
      .update(profiles)
      .set({
        name: input.name,
        currentCompany: input.currentCompany,
        updatedAt: new Date(),
      })
      .where(eq(profiles.profileId, profile.profileId));
    await tx
      .delete(professionalLinks)
      .where(eq(professionalLinks.profileId, profile.profileId));
    if (input.professionalLinks.length > 0) {
      await tx.insert(professionalLinks).values(
        input.professionalLinks.map((url) => ({
          profileId: profile.profileId,
          url,
        })),
      );
    }
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
    const [profile] = await tx
      .select()
      .from(profiles)
      .where(eq(profiles.profileId, input.profileId))
      .limit(1);
    if (!profile) throw new Error("profile_not_found");
    const [request] = await tx
      .insert(profileRequests)
      .values({
        ...input,
        previousSearchable: profile.searchable,
        previousSearchabilityReason: profile.searchabilityReason,
      })
      .returning();
    await tx
      .update(profiles)
      .set({
        searchable: false,
        searchabilityReason: "disputed",
        updatedAt: new Date(),
      })
      .where(eq(profiles.profileId, input.profileId))
      .returning();
    return request!;
  });

export const reviewProfileRequest = (
  database: Database,
  requestId: string,
  confirmed: boolean,
) =>
  database.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(profileRequests)
      .where(eq(profileRequests.id, requestId))
      .limit(1);
    if (!request || request.status !== "pending")
      throw new Error("request_not_pending");
    const [profile] = await tx
      .select()
      .from(profiles)
      .where(eq(profiles.profileId, request.profileId))
      .limit(1);
    if (!profile) throw new Error("profile_not_found");
    if (confirmed && request.kind === "removal") {
      await tx
        .insert(suppressionRecords)
        .values({
          canonicalProvider: "github",
          canonicalProviderId: profile.githubAccountId,
          reason: "person_requested_removal",
        })
        .onConflictDoNothing();
      await tx
        .update(profiles)
        .set({
          memberId: null,
          name: "Suppressed Profile",
          currentCompany: null,
          githubLogin: "suppressed",
          searchable: false,
          searchabilityReason: "operator_suppression",
          updatedAt: new Date(),
        })
        .where(eq(profiles.profileId, profile.profileId));
      await tx
        .delete(professionalLinks)
        .where(eq(professionalLinks.profileId, profile.profileId));
      await tx
        .delete(memberStatements)
        .where(eq(memberStatements.profileId, profile.profileId));
      await tx
        .delete(profileObservations)
        .where(eq(profileObservations.profileId, profile.profileId));
      await tx
        .delete(profileClaims)
        .where(eq(profileClaims.profileId, profile.profileId));
    } else if (!confirmed) {
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
        status: confirmed ? "confirmed" : "rejected",
        reviewedAt: new Date(),
      })
      .where(eq(profileRequests.id, requestId))
      .returning();
    return reviewed!;
  });
