import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { releaseCreditReservation } from "./credits";
import { lockGitHubIdentity } from "./github-identity";
import {
  contactDetailSuppressions,
  contactRevealRequests,
  contactReveals,
  employments,
  enrichmentCheckpoints,
  enrichmentDispatches,
  enrichmentRuns,
  legacyContactDetails,
  memberStatements,
  operatorAuditEvents,
  professionalLinks,
  profileClaims,
  profileObservations,
  profileRequests,
  profiles,
  reenrichmentOutbox,
  savedListEntries,
  suppressionRecords,
} from "./schema";
import type { Transaction } from "./service/types";

export const suppressGitHubIdentityInTransaction = async (
  transaction: Transaction,
  input: {
    githubAccountId: string;
    reason: string;
    purge: boolean;
    detachMember?: boolean;
    now?: Date;
  },
) => {
  const githubAccountId = await lockGitHubIdentity(
    transaction,
    input.githubAccountId,
  );
  const now = input.now ?? new Date();
  await transaction
    .insert(suppressionRecords)
    .values({
      canonicalProvider: "github",
      canonicalProviderId: githubAccountId,
      reason: input.reason,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [
        suppressionRecords.canonicalProvider,
        suppressionRecords.canonicalProviderId,
      ],
      set: { reason: input.reason },
    });

  const matchingProfiles = await transaction
    .select({ profileId: profiles.profileId })
    .from(profiles)
    .where(eq(profiles.githubAccountId, githubAccountId))
    .for("update");
  const profileIds = matchingProfiles.map(({ profileId }) => profileId);
  if (profileIds.length === 0) return { githubAccountId, profileIds };

  if (input.purge) {
    const [claims, requests] = await Promise.all([
      transaction
        .select({ id: profileClaims.id })
        .from(profileClaims)
        .where(inArray(profileClaims.profileId, profileIds)),
      transaction
        .select({ id: profileRequests.id })
        .from(profileRequests)
        .where(inArray(profileRequests.profileId, profileIds)),
    ]);
    const reservedReveals = await transaction
      .select()
      .from(contactReveals)
      .where(
        and(
          inArray(contactReveals.profileId, profileIds),
          eq(contactReveals.status, "reserved"),
        ),
      )
      .orderBy(contactReveals.organizationId);
    const reservedRequests =
      reservedReveals.length === 0
        ? []
        : await transaction
            .select({
              revealId: contactRevealRequests.revealId,
              idempotencyKey: contactRevealRequests.idempotencyKey,
            })
            .from(contactRevealRequests)
            .where(
              and(
                inArray(
                  contactRevealRequests.revealId,
                  reservedReveals.map(({ id }) => id),
                ),
                eq(contactRevealRequests.status, "reserved"),
              ),
            )
            .orderBy(desc(contactRevealRequests.createdAt));
    const reservationKeyByReveal = new Map<string, string>();
    for (const request of reservedRequests) {
      if (!reservationKeyByReveal.has(request.revealId))
        reservationKeyByReveal.set(request.revealId, request.idempotencyKey);
    }
    for (const reveal of reservedReveals) {
      await releaseCreditReservation(transaction, {
        organizationId: reveal.organizationId,
        amount: reveal.price,
        referenceId: reveal.id,
        idempotencyKey:
          reservationKeyByReveal.get(reveal.id) ?? reveal.idempotencyKey,
        reservationKey: "reservation-suffix",
        actor: { type: "system", id: "profile-suppression" },
        operation: "contact_reveal.profile_suppression.release",
      });
    }
    await transaction
      .update(contactRevealRequests)
      .set({
        status: sql`case
          when ${contactRevealRequests.status} = 'reserved' then 'released'
          when ${contactRevealRequests.status} in ('finalized', 'reopened') then 'suppressed'
          else ${contactRevealRequests.status}
        end`,
      })
      .where(inArray(contactRevealRequests.profileId, profileIds));
    await transaction
      .delete(reenrichmentOutbox)
      .where(inArray(reenrichmentOutbox.profileId, profileIds));
    await transaction
      .update(contactReveals)
      .set({
        status: sql`case
          when ${contactReveals.status} = 'reserved' then 'released'
          when ${contactReveals.status} = 'finalized' then 'suppressed'
          else ${contactReveals.status}
        end`,
      })
      .where(inArray(contactReveals.profileId, profileIds));
    await transaction
      .delete(contactDetailSuppressions)
      .where(inArray(contactDetailSuppressions.profileId, profileIds));
    await transaction
      .delete(savedListEntries)
      .where(inArray(savedListEntries.profileId, profileIds));
    await transaction
      .delete(enrichmentDispatches)
      .where(inArray(enrichmentDispatches.profileId, profileIds));
    const runs = await transaction
      .select({ id: enrichmentRuns.id })
      .from(enrichmentRuns)
      .where(inArray(enrichmentRuns.profileId, profileIds));
    if (runs.length > 0)
      await transaction.delete(enrichmentCheckpoints).where(
        inArray(
          enrichmentCheckpoints.runId,
          runs.map(({ id }) => id),
        ),
      );
    await transaction
      .update(legacyContactDetails)
      .set({
        value: "[removed]",
        source: "profile-suppression",
        sourceRecordId: sql`'suppressed:' || ${legacyContactDetails.id}`,
        valid: false,
        suppressed: true,
        updatedAt: now,
      })
      .where(inArray(legacyContactDetails.profileId, profileIds));
    await transaction
      .delete(professionalLinks)
      .where(inArray(professionalLinks.profileId, profileIds));
    await transaction
      .delete(memberStatements)
      .where(inArray(memberStatements.profileId, profileIds));
    await transaction
      .delete(employments)
      .where(inArray(employments.profileId, profileIds));
    await transaction
      .delete(profileObservations)
      .where(inArray(profileObservations.profileId, profileIds));
    if (claims.length > 0) {
      await transaction
        .update(operatorAuditEvents)
        .set({ reason: "Redacted after confirmed removal", metadata: null })
        .where(
          and(
            eq(operatorAuditEvents.subjectType, "profile_claim"),
            inArray(
              operatorAuditEvents.subjectId,
              claims.map(({ id }) => id),
            ),
          ),
        );
    }
    if (requests.length > 0) {
      await transaction
        .update(operatorAuditEvents)
        .set({ reason: "Redacted after confirmed removal", metadata: null })
        .where(
          and(
            eq(operatorAuditEvents.subjectType, "profile_request"),
            inArray(
              operatorAuditEvents.subjectId,
              requests.map(({ id }) => id),
            ),
          ),
        );
    }
    if (input.detachMember === false)
      await transaction
        .update(profileClaims)
        .set({ status: "superseded", reviewedAt: now })
        .where(inArray(profileClaims.profileId, profileIds));
    else
      await transaction
        .delete(profileClaims)
        .where(inArray(profileClaims.profileId, profileIds));
    await transaction
      .update(profileRequests)
      .set({
        requesterEmail: "removed@example.invalid",
        details: "Removed after Profile suppression",
        verificationMethod: null,
        verificationEvidenceReference: null,
        verifiedAt: null,
        status: sql`case
          when ${profileRequests.status} in ('awaiting_verification', 'pending') then 'superseded'
          else ${profileRequests.status}
        end`,
        reviewedAt: sql`coalesce(${profileRequests.reviewedAt}, ${now})`,
      })
      .where(inArray(profileRequests.profileId, profileIds));
  } else {
    await transaction
      .update(enrichmentDispatches)
      .set({
        state: "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: "profile_suppressed",
        updatedAt: now,
      })
      .where(
        and(
          inArray(enrichmentDispatches.profileId, profileIds),
          inArray(enrichmentDispatches.state, ["pending", "leased"]),
        ),
      );
  }

  await transaction
    .update(profiles)
    .set({
      ...(input.purge
        ? {
            ...(input.detachMember === false ? {} : { memberId: null }),
            name: "Suppressed Profile",
            currentCompany: null,
            githubLogin: "suppressed",
            githubInaccessibleSince: null,
          }
        : {}),
      searchable: false,
      searchabilityReason: "operator_suppression",
      updatedAt: now,
    })
    .where(inArray(profiles.profileId, profileIds));

  return { githubAccountId, profileIds };
};
