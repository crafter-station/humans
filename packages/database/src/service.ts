import { and, eq, sql } from "drizzle-orm";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Context, Effect, Layer, Schema } from "effect";

import {
  clerkWebhookEvents,
  clerkProjectionVersions,
  members,
  organizationMemberships,
  organizations,
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
              await projectionIsActive(transaction, "member", event.member.clerkId),
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
                  eq(organizationMemberships.organizationId, event.organizationId),
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

  return Database.of({
    check,
    getWorkspace,
    projectClerkEvent,
    provisionWorkspace,
  });
};

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
    return { active: true, entityId: event.member.clerkId, entityType: "member" };
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
