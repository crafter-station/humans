import { and, desc, eq, ne } from "drizzle-orm";
import { Effect } from "effect";
import { recordEmployment, staleCurrentEmployment } from "../companies";
import {
  canonicalGitHubAccountId,
  lockGitHubIdentity,
} from "../github-identity";
import { verifiedProfessionalLink } from "../professional-links";
import {
  type CanonicalIdentityVerification,
  ProfileControlError,
  verifyCanonicalProfileLinks,
} from "../profile-control";
import { suppressGitHubIdentityInTransaction } from "../profile-suppression";
import {
  contactDetailSuppressions,
  memberStatements,
  professionalLinks,
  profileClaims,
  profiles,
  suppressionRecords,
} from "../schema";
import { DatabaseUnavailable, ProfileRejected } from "./errors";
import type {
  DrizzleDatabase,
  GitHubVerification,
  MemberProfile,
  ProfileInput,
} from "./types";

export const makeProfileService = (database: DrizzleDatabase) => {
  const getProfile = (memberId: string) =>
    Effect.tryPromise({
      try: async () => {
        const [profile] = await database
          .select()
          .from(profiles)
          .where(eq(profiles.memberId, memberId))
          .limit(1);
        if (profile === undefined) return null;

        const [links, statements, suppressions] = await Promise.all([
          database
            .select({ url: professionalLinks.url })
            .from(professionalLinks)
            .where(eq(professionalLinks.profileId, profile.profileId)),
          database
            .select({
              field: memberStatements.field,
              value: memberStatements.value,
            })
            .from(memberStatements)
            .where(eq(memberStatements.profileId, profile.profileId))
            .orderBy(desc(memberStatements.collectedAt)),
          database
            .select({ type: contactDetailSuppressions.type })
            .from(contactDetailSuppressions)
            .where(eq(contactDetailSuppressions.profileId, profile.profileId)),
        ]);

        return profileResult(profile, links, statements, suppressions);
      },
      catch: (cause) => new DatabaseUnavailable({ cause }),
    }).pipe(Effect.withSpan("Database.getProfile"));

  const saveProfile = (
    memberId: string,
    input: ProfileInput,
    github: GitHubVerification,
    canonicalIdentityVerification?: CanonicalIdentityVerification,
  ) => {
    const githubAccountId = canonicalGitHubAccountId(github.accountId);
    if (githubAccountId === null)
      return Effect.fail(
        new ProfileRejected({ reason: "github_ownership_not_verified" }),
      );
    const hasRecentContribution = hasRecentPublicContribution(
      github.contributedPubliclySince,
    );
    const rejection = profileRejection(input, github, hasRecentContribution);
    if (rejection !== null) {
      return Effect.gen(function* () {
        if (github.knownMinor) {
          yield* Effect.tryPromise({
            try: () =>
              database.transaction(async (transaction) => {
                const [existing] = await transaction
                  .select({ githubAccountId: profiles.githubAccountId })
                  .from(profiles)
                  .where(eq(profiles.memberId, memberId))
                  .limit(1);
                const existingAccountId =
                  existing === undefined
                    ? null
                    : canonicalGitHubAccountId(existing.githubAccountId);
                const accountIds = [
                  ...new Set([
                    githubAccountId,
                    ...(existingAccountId === null ? [] : [existingAccountId]),
                  ]),
                ].sort();
                for (const accountId of accountIds)
                  await suppressGitHubIdentityInTransaction(transaction, {
                    githubAccountId: accountId,
                    reason: "known_minor",
                    purge: true,
                    detachMember: false,
                  });
              }),
            catch: (cause) => new DatabaseUnavailable({ cause }),
          });
        }
        return yield* new ProfileRejected({ reason: rejection });
      });
    }

    const eligibilityBasis = github.ownsNonForkRepository
      ? ("owned_repository" as const)
      : hasRecentContribution
        ? ("public_contribution" as const)
        : ("private_attestation" as const);
    const searchabilityReason = input.searchable
      ? ("member_opt_in" as const)
      : ("member_opt_out" as const);

    return Effect.tryPromise({
      try: async () => {
        const contactSuppressions = await database.transaction(
          async (transaction) => {
            await lockGitHubIdentity(transaction, githubAccountId);
            const [existing] = await transaction
              .select()
              .from(profiles)
              .where(eq(profiles.memberId, memberId))
              .limit(1)
              .for("update");
            if (
              existing !== undefined &&
              existing.githubAccountId !== githubAccountId
            ) {
              throw new ProfileRejected({
                reason: "github_identity_change_requires_review",
              });
            }
            if (
              existing?.searchabilityReason === "operator_suppression" ||
              existing?.searchabilityReason === "disputed"
            ) {
              throw new ProfileRejected({
                reason: "profile_searchability_locked",
              });
            }
            const [suppression] = await transaction
              .select({
                canonicalProviderId: suppressionRecords.canonicalProviderId,
              })
              .from(suppressionRecords)
              .where(
                and(
                  eq(suppressionRecords.canonicalProvider, "github"),
                  eq(suppressionRecords.canonicalProviderId, githubAccountId),
                ),
              )
              .limit(1);
            const [canonicalProfile] = await transaction
              .select({ profileId: profiles.profileId })
              .from(profiles)
              .where(eq(profiles.githubAccountId, githubAccountId))
              .limit(1);
            const [pendingClaim] = await transaction
              .select({ id: profileClaims.id })
              .from(profileClaims)
              .where(
                and(
                  eq(profileClaims.memberId, memberId),
                  eq(profileClaims.status, "pending_review"),
                ),
              )
              .limit(1);
            if (suppression !== undefined)
              throw new ProfileRejected({ reason: "profile_suppressed" });
            if (pendingClaim !== undefined)
              throw new ProfileRejected({ reason: "profile_claim_pending" });
            if (existing === undefined && canonicalProfile !== undefined) {
              throw new ProfileRejected({
                reason: "imported_profile_claim_required",
              });
            }

            const existingLinks =
              existing === undefined
                ? []
                : await transaction
                    .select()
                    .from(professionalLinks)
                    .where(eq(professionalLinks.profileId, existing.profileId));
            try {
              verifyCanonicalProfileLinks(
                githubAccountId,
                existingLinks.map(({ url }) => url),
                input.professionalLinks,
                { ...canonicalIdentityVerification, github },
              );
            } catch (cause) {
              if (cause instanceof ProfileControlError)
                throw new ProfileRejected({ reason: cause.code });
              throw cause;
            }

            const now = new Date();
            const [storedProfile] = existing
              ? await transaction
                  .update(profiles)
                  .set({
                    name: input.name,
                    currentCompany: input.currentCompany,
                    githubLogin: github.login,
                    eligibilityBasis,
                    adultAttested: true,
                    searchable: input.searchable,
                    searchabilityReason,
                    updatedAt: now,
                  })
                  .where(eq(profiles.profileId, existing.profileId))
                  .returning()
              : await transaction
                  .insert(profiles)
                  .values({
                    memberId,
                    name: input.name,
                    currentCompany: input.currentCompany,
                    githubAccountId,
                    githubLogin: github.login,
                    eligibilityBasis,
                    adultAttested: true,
                    searchable: input.searchable,
                    searchabilityReason,
                  })
                  .returning();
            if (!storedProfile) throw new Error("profile_not_saved");
            await staleCurrentEmployment(
              transaction,
              storedProfile.profileId,
              "member",
              now,
            );
            if (input.currentCompany !== null)
              await recordEmployment(transaction, {
                profileId: storedProfile.profileId,
                companyName: input.currentCompany,
                current: true,
                source: "member",
                sourceRecordId: memberId,
                pipelineVersion: "member-v1",
                confidence: 1,
                collectedAt: now,
              });
            await transaction
              .delete(professionalLinks)
              .where(eq(professionalLinks.profileId, storedProfile.profileId));
            await transaction.insert(professionalLinks).values(
              input.professionalLinks.map((url) => {
                const existingLink = existingLinks.find(
                  (link) => link.url === url,
                );
                const verified = verifiedProfessionalLink(
                  url,
                  { ...canonicalIdentityVerification, github },
                  now,
                );
                return verified === undefined && existingLink !== undefined
                  ? existingLink
                  : {
                      profileId: storedProfile.profileId,
                      url,
                      source: "member",
                      sourceRecordId: memberId,
                      ...verified,
                    };
              }),
            );
            await transaction
              .delete(memberStatements)
              .where(eq(memberStatements.profileId, storedProfile.profileId));
            const statements = Object.entries(input.statements);
            if (statements.length > 0) {
              await transaction.insert(memberStatements).values(
                statements.map(([field, value]) => ({
                  id: crypto.randomUUID(),
                  profileId: storedProfile.profileId,
                  field,
                  value,
                  source: "member",
                  pipelineVersion: "member-v1",
                  confidence: 1,
                })),
              );
            }
            const suppressions = await transaction
              .select({ type: contactDetailSuppressions.type })
              .from(contactDetailSuppressions)
              .where(
                eq(
                  contactDetailSuppressions.profileId,
                  storedProfile.profileId,
                ),
              );
            return suppressions
              .map(({ type }) => type)
              .filter(
                (type): type is MemberProfile["contactSuppressions"][number] =>
                  type === "professional-email" ||
                  type === "direct-professional-phone",
              );
          },
        );
        return {
          ...input,
          memberId,
          githubAccountId,
          githubLogin: github.login,
          eligibilityBasis,
          searchabilityReason,
          contactSuppressions,
        };
      },
      catch: (cause) =>
        cause instanceof ProfileRejected
          ? cause
          : new DatabaseUnavailable({ cause }),
    }).pipe(Effect.withSpan("Database.saveProfile"));
  };

  const disableProfileSearchability = (memberId: string) =>
    Effect.gen(function* () {
      const [updated] = yield* Effect.tryPromise({
        try: () =>
          database
            .update(profiles)
            .set({
              searchable: false,
              searchabilityReason: "member_opt_out",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(profiles.memberId, memberId),
                ne(profiles.searchabilityReason, "disputed"),
                ne(profiles.searchabilityReason, "operator_suppression"),
              ),
            )
            .returning(),
        catch: (cause) => new DatabaseUnavailable({ cause }),
      });
      if (updated === undefined) {
        return yield* new ProfileRejected({ reason: "profile_not_found" });
      }
      const profile = yield* getProfile(memberId);
      if (profile === null) {
        return yield* new ProfileRejected({ reason: "profile_not_found" });
      }
      return profile;
    }).pipe(Effect.withSpan("Database.disableProfileSearchability"));

  return { disableProfileSearchability, getProfile, saveProfile };
};

const profileRejection = (
  input: ProfileInput,
  github: GitHubVerification,
  hasRecentContribution: boolean,
) => {
  if (input.name.trim() === "" || input.professionalLinks.length === 0) {
    return "profile_details_required";
  }
  if (github.accountType !== "User") return "ineligible_github_account_type";
  if (!github.ownershipVerified) return "github_ownership_not_verified";
  if (!input.adultAttestation || github.knownMinor) return "adult_required";

  if (
    !github.ownsNonForkRepository &&
    !hasRecentContribution &&
    !input.privateCodeAttestation
  ) {
    return "coding_evidence_required";
  }
  return null;
};

const hasRecentPublicContribution = (contributedSince: Date | null) => {
  if (contributedSince === null) return false;
  const contributionCutoff = new Date();
  contributionCutoff.setUTCFullYear(contributionCutoff.getUTCFullYear() - 1);
  contributionCutoff.setUTCHours(0, 0, 0, 0);
  return contributedSince >= contributionCutoff;
};

const profileResult = (
  profile: typeof profiles.$inferSelect,
  links: Array<{ url: string }>,
  statements: Array<{ field: string; value: unknown }>,
  suppressions: Array<{ type: string }>,
): MemberProfile => {
  if (profile.memberId === null) throw new Error("profile_member_missing");
  return {
    memberId: profile.memberId,
    name: profile.name,
    currentCompany: profile.currentCompany,
    professionalLinks: links.map(({ url }) => url),
    statements: statements.reduce<Record<string, string | string[]>>(
      (latest, { field, value }) => {
        if (!(field in latest)) latest[field] = value as string | string[];
        return latest;
      },
      {},
    ),
    adultAttestation: profile.adultAttested,
    privateCodeAttestation: profile.eligibilityBasis === "private_attestation",
    searchable: profile.searchable,
    githubAccountId: profile.githubAccountId,
    githubLogin: profile.githubLogin,
    eligibilityBasis:
      profile.eligibilityBasis as MemberProfile["eligibilityBasis"],
    searchabilityReason:
      profile.searchabilityReason as MemberProfile["searchabilityReason"],
    contactSuppressions: suppressions
      .map(({ type }) => type)
      .filter(
        (type): type is MemberProfile["contactSuppressions"][number] =>
          type === "professional-email" ||
          type === "direct-professional-phone",
      ),
  };
};
