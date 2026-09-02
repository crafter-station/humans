import { desc, eq } from "drizzle-orm";
import { Effect } from "effect";

import {
  contactDetailSuppressions,
  memberStatements,
  professionalLinks,
  profiles,
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
  ) => {
    const rejection = profileRejection(input, github);
    if (rejection !== null) {
      return Effect.gen(function* () {
        if (github.knownMinor) {
          yield* Effect.tryPromise({
            try: () =>
              database
                .update(profiles)
                .set({
                  searchable: false,
                  searchabilityReason: "operator_suppression",
                  updatedAt: new Date(),
                })
                .where(eq(profiles.memberId, memberId)),
            catch: (cause) => new DatabaseUnavailable({ cause }),
          });
        }
        return yield* new ProfileRejected({ reason: rejection });
      });
    }

    const eligibilityBasis = github.ownsNonForkRepository
      ? ("owned_repository" as const)
      : github.contributedPubliclySince !== null
        ? ("public_contribution" as const)
        : ("private_attestation" as const);
    const searchabilityReason = input.searchable
      ? ("member_opt_in" as const)
      : ("member_opt_out" as const);

    return Effect.gen(function* () {
      const existing = yield* getProfile(memberId);
      if (existing !== null && existing.githubAccountId !== github.accountId) {
        return yield* new ProfileRejected({
          reason: "github_identity_change_requires_review",
        });
      }

      return yield* Effect.tryPromise({
        try: async () => {
          await database.transaction(async (transaction) => {
            const [storedProfile] = await transaction
              .insert(profiles)
              .values({
                memberId,
                name: input.name,
                currentCompany: input.currentCompany,
                githubAccountId: github.accountId,
                githubLogin: github.login,
                eligibilityBasis,
                adultAttested: true,
                searchable: input.searchable,
                searchabilityReason,
              })
              .onConflictDoUpdate({
                target: profiles.memberId,
                set: {
                  name: input.name,
                  currentCompany: input.currentCompany,
                  githubLogin: github.login,
                  eligibilityBasis,
                  adultAttested: true,
                  searchable: input.searchable,
                  searchabilityReason,
                  updatedAt: new Date(),
                },
              })
              .returning({
                githubAccountId: profiles.githubAccountId,
                profileId: profiles.profileId,
              });
            if (storedProfile?.githubAccountId !== github.accountId) {
              throw new ProfileRejected({
                reason: "github_identity_change_requires_review",
              });
            }
            await transaction
              .delete(professionalLinks)
              .where(eq(professionalLinks.profileId, storedProfile.profileId));
            await transaction.insert(professionalLinks).values(
              input.professionalLinks.map((url) => ({
                profileId: storedProfile.profileId,
                url,
              })),
            );
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
          });
          return {
            ...input,
            memberId,
            githubAccountId: github.accountId,
            githubLogin: github.login,
            eligibilityBasis,
            searchabilityReason,
            contactSuppressions: existing?.contactSuppressions ?? [],
          };
        },
        catch: (cause) =>
          cause instanceof ProfileRejected
            ? cause
            : new DatabaseUnavailable({ cause }),
      });
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
            .where(eq(profiles.memberId, memberId))
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

const profileRejection = (input: ProfileInput, github: GitHubVerification) => {
  if (input.name.trim() === "" || input.professionalLinks.length === 0) {
    return "profile_details_required";
  }
  if (github.accountType !== "User") return "ineligible_github_account_type";
  if (!github.ownershipVerified) return "github_ownership_not_verified";
  if (!input.adultAttestation || github.knownMinor) return "adult_required";

  const contributionCutoff = new Date();
  contributionCutoff.setUTCFullYear(contributionCutoff.getUTCFullYear() - 1);
  contributionCutoff.setUTCHours(0, 0, 0, 0);
  const hasRecentContribution =
    github.contributedPubliclySince !== null &&
    github.contributedPubliclySince >= contributionCutoff;
  if (
    !github.ownsNonForkRepository &&
    !hasRecentContribution &&
    !input.privateCodeAttestation
  ) {
    return "coding_evidence_required";
  }
  return null;
};

const profileResult = (
  profile: typeof profiles.$inferSelect,
  links: Array<{ url: string }>,
  statements: Array<{ field: string; value: unknown }>,
  suppressions: Array<{ type: string }>,
): MemberProfile => ({
  memberId: profile.memberId!,
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
        type === "professional-email" || type === "direct-professional-phone",
    ),
});
