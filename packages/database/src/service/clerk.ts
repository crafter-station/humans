import { and, eq, isNull, notExists, or, sql } from "drizzle-orm";
import { Effect } from "effect";

import {
  clerkProjectionVersions,
  clerkWebhookEvents,
  members,
  organizationMemberships,
  organizations,
  principalSuspensions,
} from "../schema";
import { DatabaseUnavailable, WorkspaceForbidden } from "./errors";
import type {
  ClerkProjectionEvent,
  DrizzleDatabase,
  MemberProjection,
  OrganizationProjection,
  ProvisionedWorkspace,
  Transaction,
} from "./types";

export const makeClerkService = (database: DrizzleDatabase) => {
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
              .set({ active: false, updatedAt: new Date() })
              .where(eq(members.clerkId, event.memberId));
          } else if (event.type === "organization.upsert") {
            await upsertOrganization(transaction, event.organization);
          } else if (event.type === "organization.delete") {
            await transaction
              .update(organizations)
              .set({ active: false, updatedAt: new Date() })
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
              .set({ active: false, updatedAt: new Date() })
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
              notExists(
                database
                  .select({ id: principalSuspensions.id })
                  .from(principalSuspensions)
                  .where(
                    and(
                      isNull(principalSuspensions.revokedAt),
                      or(
                        and(
                          eq(principalSuspensions.principalType, "member"),
                          eq(principalSuspensions.principalId, memberId),
                        ),
                        and(
                          eq(
                            principalSuspensions.principalType,
                            "organization",
                          ),
                          eq(principalSuspensions.principalId, organizationId),
                        ),
                      ),
                    ),
                  ),
              ),
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

  return { getWorkspace, projectClerkEvent, provisionWorkspace };
};

const upsertOrganization = async (
  database: Transaction,
  organization: OrganizationProjection,
) => {
  await database
    .insert(organizations)
    .values(organization)
    .onConflictDoUpdate({
      target: organizations.clerkId,
      set: { ...organization, active: true, updatedAt: new Date() },
    });
};

const upsertMember = async (
  database: Transaction,
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
  database: Transaction,
  member: MemberProjection,
  active: boolean,
) => {
  await database
    .insert(members)
    .values({ ...member, active })
    .onConflictDoNothing();
};

const ensureOrganization = async (
  database: Transaction,
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
  database: Transaction,
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
  database: Transaction,
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
