import { and, desc, eq, sql } from "drizzle-orm";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Context, Effect, Layer, Schema } from "effect";

import {
  clerkWebhookEvents,
  clerkProjectionVersions,
  members,
  memberStatements,
  organizationMemberships,
  organizations,
  professionalLinks,
  profiles,
} from "./schema";

type DrizzleDatabase =
  | NeonDatabase<typeof import("./schema")>
  | NodePgDatabase<typeof import("./schema")>;

export type MemberProjection = {
  clerkId: string;
  email: string | null;
  name: string | null;
  imageUrl: string | null;
};

export type OrganizationProjection = {
  clerkId: string;
  name: string;
  slug: string | null;
};

export type MembershipProjection = {
  clerkId: string;
  memberId: string;
  organizationId: string;
  role: string;
};

export type ClerkProjectionEvent = { id: string; sourceUpdatedAt: number } & (
  | { type: "member.upsert"; member: MemberProjection }
  | { type: "member.delete"; memberId: string }
  | { type: "organization.upsert"; organization: OrganizationProjection }
  | { type: "organization.delete"; organizationId: string }
  | {
      type: "membership.upsert";
      member: MemberProjection;
      membership: MembershipProjection;
      organization: OrganizationProjection;
    }
  | { type: "membership.delete"; memberId: string; organizationId: string }
);

export type Workspace = {
  memberId: string;
  organizationId: string;
  organizationName: string;
  role: string;
};

export type ProvisionedWorkspace = {
  member: MemberProjection;
  membership: MembershipProjection;
  organization: OrganizationProjection;
};

export type GitHubVerification = {
  accountId: string;
  login: string;
  accountType: "User" | "Bot" | "Organization";
  ownsNonForkRepository: boolean;
  contributedPubliclySince: Date | null;
  ownershipVerified: boolean;
  knownMinor: boolean;
};

export type ProfileInput = {
  name: string;
  currentCompany: string | null;
  professionalLinks: string[];
  statements: Record<string, string | string[]>;
  adultAttestation: boolean;
  privateCodeAttestation: boolean;
  searchable: boolean;
};

export type MemberProfile = ProfileInput & {
  memberId: string;
  githubAccountId: string;
  githubLogin: string;
  eligibilityBasis:
    "owned_repository" | "public_contribution" | "private_attestation";
  searchabilityReason:
    "member_opt_in" | "member_opt_out" | "operator_suppression";
};

export class DatabaseUnavailable extends Schema.TaggedError<DatabaseUnavailable>()(
  "DatabaseUnavailable",
  {
    cause: Schema.Defect(),
  },
) {}

export class WorkspaceForbidden extends Schema.TaggedError<WorkspaceForbidden>()(
  "WorkspaceForbidden",
  {},
) {}

export class ProfileRejected extends Schema.TaggedError<ProfileRejected>()(
  "ProfileRejected",
  { reason: Schema.String },
) {}

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
  }
>()("@humans/database/Database") {}

export const makeDatabaseService = (database: DrizzleDatabase) => {
  const check = Effect.tryPromise({
    try: async () => {
      await database.execute(sql`select null::vector`);
    },
    catch: (cause) => new DatabaseUnavailable({ cause }),
  }).pipe(Effect.withSpan("Database.check"));

  const projectClerkEvent = (event: ClerkProjectionEvent) =>
    Effect.tryPromise({
      try: () =>
        database.transaction(async (transaction) => {
          const [claimed] = await transaction
            .insert(clerkWebhookEvents)
            .values({ id: event.id, type: event.type })
            .onConflictDoNothing()
            .returning();

          if (claimed === undefined) return false;

          const version = projectionVersion(event);
          const versionClaimed = await claimProjectionVersion(
            transaction,
            version.entityType,
            version.entityId,
            event.sourceUpdatedAt,
            version.active,
          );
          if (!versionClaimed) return true;

          if (event.type === "member.upsert") {
            await upsertMember(transaction, event.member);
          } else if (event.type === "member.delete") {
            await transaction
              .update(members)
              .set({
                active: false,
                updatedAt: new Date(),
              })
              .where(eq(members.clerkId, event.memberId));
          } else if (event.type === "organization.upsert") {
            await upsertOrganization(transaction, event.organization);
          } else if (event.type === "organization.delete") {
            await transaction
              .update(organizations)
              .set({
                active: false,
                updatedAt: new Date(),
              })
              .where(eq(organizations.clerkId, event.organizationId));
          } else if (event.type === "membership.upsert") {
            await ensureMember(
              transaction,
              event.member,
              await projectionIsActive(
                transaction,
                "member",
                event.member.clerkId,
              ),
            );
            await ensureOrganization(
              transaction,
              event.organization,
              await projectionIsActive(
                transaction,
                "organization",
                event.organization.clerkId,
              ),
            );
            await transaction
              .insert(organizationMemberships)
              .values(event.membership)
              .onConflictDoUpdate({
                target: [
                  organizationMemberships.memberId,
                  organizationMemberships.organizationId,
                ],
                set: {
                  clerkId: event.membership.clerkId,
                  role: event.membership.role,
                  active: true,
                  updatedAt: new Date(),
                },
              });
          } else {
            await transaction
              .update(organizationMemberships)
              .set({
                active: false,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(organizationMemberships.memberId, event.memberId),
                  eq(
                    organizationMemberships.organizationId,
                    event.organizationId,
                  ),
                ),
              );
          }

          return true;
        }),
      catch: (cause) => new DatabaseUnavailable({ cause }),
    }).pipe(Effect.withSpan("Database.projectClerkEvent"));

  const getWorkspace = (memberId: string, organizationId: string) =>
    Effect.tryPromise({
      try: () =>
        database
          .select({
            memberId: organizationMemberships.memberId,
            organizationId: organizationMemberships.organizationId,
            organizationName: organizations.name,
            role: organizationMemberships.role,
          })
          .from(organizationMemberships)
          .innerJoin(
            members,
            eq(members.clerkId, organizationMemberships.memberId),
          )
          .innerJoin(
            organizations,
            eq(organizations.clerkId, organizationMemberships.organizationId),
          )
          .where(
            and(
              eq(organizationMemberships.memberId, memberId),
              eq(organizationMemberships.organizationId, organizationId),
              eq(organizationMemberships.active, true),
              eq(members.active, true),
              eq(organizations.active, true),
            ),
          )
          .limit(1),
      catch: (cause) => new DatabaseUnavailable({ cause }),
    }).pipe(
      Effect.flatMap(([workspace]) =>
        workspace === undefined
          ? Effect.fail(new WorkspaceForbidden())
          : Effect.succeed(workspace),
      ),
      Effect.withSpan("Database.getWorkspace"),
    );

  const provisionWorkspace = (
    memberId: string,
    provision: () => Promise<ProvisionedWorkspace>,
  ) =>
    Effect.tryPromise({
      try: async () => {
        const projection = await provision();
        return database.transaction(async (transaction) => {
          await ensureMember(transaction, projection.member, true);
          await ensureOrganization(transaction, projection.organization, true);
          await transaction
            .insert(organizationMemberships)
            .values(projection.membership)
            .onConflictDoUpdate({
              target: [
                organizationMemberships.memberId,
                organizationMemberships.organizationId,
              ],
              set: {
                clerkId: projection.membership.clerkId,
                role: projection.membership.role,
                active: true,
                updatedAt: new Date(),
              },
            });

          return {
            memberId,
            organizationId: projection.organization.clerkId,
            organizationName: projection.organization.name,
            role: projection.membership.role,
          };
        });
      },
      catch: (cause) => new DatabaseUnavailable({ cause }),
    }).pipe(Effect.withSpan("Database.provisionWorkspace"));

  const getProfile = (memberId: string) =>
    Effect.tryPromise({
      try: async () => {
        const [profile] = await database
          .select()
          .from(profiles)
          .where(eq(profiles.memberId, memberId))
          .limit(1);
        if (profile === undefined) return null;

        const [links, statements] = await Promise.all([
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
        ]);

        return profileResult(profile, links, statements);
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

  return Database.of({
    check,
    disableProfileSearchability,
    getProfile,
    getWorkspace,
    projectClerkEvent,
    provisionWorkspace,
    saveProfile,
  });
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
});

export const makeDatabaseLayer = (database: DrizzleDatabase) =>
  Layer.succeed(Database, makeDatabaseService(database));

const upsertOrganization = async (
  database: Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0],
  organization: OrganizationProjection,
) => {
  await database
    .insert(organizations)
    .values(organization)
    .onConflictDoUpdate({
      target: organizations.clerkId,
      set: {
        ...organization,
        active: true,
        updatedAt: new Date(),
      },
    });
};

const upsertMember = async (
  database: Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0],
  member: MemberProjection,
) => {
  await database
    .insert(members)
    .values(member)
    .onConflictDoUpdate({
      target: members.clerkId,
      set: { ...member, active: true, updatedAt: new Date() },
    });
};

const ensureMember = async (
  database: Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0],
  member: MemberProjection,
  active: boolean,
) => {
  await database
    .insert(members)
    .values({ ...member, active })
    .onConflictDoNothing();
};

const ensureOrganization = async (
  database: Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0],
  organization: OrganizationProjection,
  active: boolean,
) => {
  await database
    .insert(organizations)
    .values({ ...organization, active })
    .onConflictDoNothing();
};

const projectionVersion = (event: ClerkProjectionEvent) => {
  if (event.type === "member.upsert") {
    return {
      active: true,
      entityId: event.member.clerkId,
      entityType: "member",
    };
  }
  if (event.type === "member.delete") {
    return { active: false, entityId: event.memberId, entityType: "member" };
  }
  if (event.type === "organization.upsert") {
    return {
      active: true,
      entityId: event.organization.clerkId,
      entityType: "organization",
    };
  }
  if (event.type === "organization.delete") {
    return {
      active: false,
      entityId: event.organizationId,
      entityType: "organization",
    };
  }
  return {
    active: event.type === "membership.upsert",
    entityId:
      event.type === "membership.upsert"
        ? `${event.membership.memberId}:${event.membership.organizationId}`
        : `${event.memberId}:${event.organizationId}`,
    entityType: "membership",
  };
};

const claimProjectionVersion = async (
  database: Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0],
  entityType: string,
  entityId: string,
  sourceUpdatedAt: number,
  active: boolean,
) => {
  const [claimed] = await database
    .insert(clerkProjectionVersions)
    .values({ active, entityId, entityType, sourceUpdatedAt })
    .onConflictDoUpdate({
      target: [
        clerkProjectionVersions.entityType,
        clerkProjectionVersions.entityId,
      ],
      set: { active, sourceUpdatedAt },
      setWhere: sql`${clerkProjectionVersions.sourceUpdatedAt} <= ${sourceUpdatedAt}`,
    })
    .returning();
  return claimed !== undefined;
};

const projectionIsActive = async (
  database: Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0],
  entityType: string,
  entityId: string,
) => {
  const [version] = await database
    .select({ active: clerkProjectionVersions.active })
    .from(clerkProjectionVersions)
    .where(
      and(
        eq(clerkProjectionVersions.entityType, entityType),
        eq(clerkProjectionVersions.entityId, entityId),
      ),
    )
    .limit(1);
  return version?.active ?? true;
};
