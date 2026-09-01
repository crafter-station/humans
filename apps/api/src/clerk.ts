import { createClerkClient } from "@clerk/backend";
import { verifyWebhook } from "@clerk/backend/webhooks";
import type {
  ClerkProjectionEvent,
  MemberProjection,
  OrganizationProjection,
  ProvisionedWorkspace,
} from "@humans/database";

import type { Bindings } from "./app";

export type SessionIdentity = {
  memberId: string;
  organizationId: string | null;
};

export type IdentityBoundary = {
  authenticate(
    request: Request,
    bindings: Bindings,
  ): Promise<SessionIdentity | null>;
  verifyWebhook(
    request: Request,
    bindings: Bindings,
  ): Promise<ClerkProjectionEvent | null>;
  provisionPersonalOrganization(
    memberId: string,
    bindings: Bindings,
    organizationId?: string,
  ): Promise<ProvisionedWorkspace>;
};

const memberProjection = (data: {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  image_url?: string;
  email_addresses?: Array<{ id: string; email_address: string }>;
  primary_email_address_id?: string | null;
}): MemberProjection => ({
  clerkId: data.id,
  email:
    data.email_addresses?.find(
      (email) => email.id === data.primary_email_address_id,
    )?.email_address ?? null,
  name:
    [data.first_name, data.last_name].filter(Boolean).join(" ") || null,
  imageUrl: data.image_url ?? null,
});

const organizationProjection = (data: {
  id: string;
  name: string;
  slug?: string | null;
}): OrganizationProjection => ({
  clerkId: data.id,
  name: data.name,
  slug: data.slug ?? null,
});

export const clerkIdentityBoundary: IdentityBoundary = {
  async authenticate(request, bindings) {
    const clerk = createClerkClient({
      publishableKey: bindings.CLERK_PUBLISHABLE_KEY,
      secretKey: bindings.CLERK_SECRET_KEY,
    });
    const state = await clerk.authenticateRequest(request, {
      acceptsToken: "session_token",
    });
    if (!state.isAuthenticated) return null;

    const auth = state.toAuth();
    return { memberId: auth.userId, organizationId: auth.orgId ?? null };
  },

  async verifyWebhook(request, bindings) {
    const eventId =
      request.headers.get("webhook-id") ?? request.headers.get("svix-id");
    if (eventId === null) throw new Error("Missing webhook-id");
    const deliveredAt =
      Number(
        request.headers.get("webhook-timestamp") ??
          request.headers.get("svix-timestamp"),
      ) * 1000;
    if (!Number.isFinite(deliveredAt)) throw new Error("Missing webhook-timestamp");

    const event = await verifyWebhook(request, {
      signingSecret: bindings.CLERK_WEBHOOK_SIGNING_SECRET,
    });

    if (event.type === "user.created" || event.type === "user.updated") {
      return {
        id: eventId,
        sourceUpdatedAt: event.data.updated_at,
        type: "member.upsert",
        member: memberProjection(event.data),
      };
    }
    if (event.type === "user.deleted" && event.data.id !== undefined) {
      return {
        id: eventId,
        sourceUpdatedAt: deliveredAt,
        type: "member.delete",
        memberId: event.data.id,
      };
    }
    if (
      event.type === "organization.created" ||
      event.type === "organization.updated"
    ) {
      return {
        id: eventId,
        sourceUpdatedAt: event.data.updated_at,
        type: "organization.upsert",
        organization: organizationProjection(event.data),
      };
    }
    if (event.type === "organization.deleted" && event.data.id !== undefined) {
      return {
        id: eventId,
        sourceUpdatedAt: deliveredAt,
        type: "organization.delete",
        organizationId: event.data.id,
      };
    }
    if (
      event.type === "organizationMembership.created" ||
      event.type === "organizationMembership.updated"
    ) {
      const member = event.data.public_user_data;
      return {
        id: eventId,
        sourceUpdatedAt: event.data.updated_at,
        type: "membership.upsert",
        member: {
          clerkId: member.user_id,
          email: member.identifier,
          name: [member.first_name, member.last_name].filter(Boolean).join(" ") || null,
          imageUrl: member.image_url,
        },
        membership: {
          clerkId: event.data.id,
          memberId: member.user_id,
          organizationId: event.data.organization.id,
          role: event.data.role,
        },
        organization: organizationProjection(event.data.organization),
      };
    }
    if (event.type === "organizationMembership.deleted") {
      return {
        id: eventId,
        sourceUpdatedAt: event.data.updated_at,
        type: "membership.delete",
        memberId: event.data.public_user_data.user_id,
        organizationId: event.data.organization.id,
      };
    }

    return null;
  },

  async provisionPersonalOrganization(memberId, bindings, organizationId) {
    const clerk = createClerkClient({ secretKey: bindings.CLERK_SECRET_KEY });
    const member = await clerk.users.getUser(memberId);
    const memberships = await clerk.users.getOrganizationMembershipList({
      limit: organizationId === undefined ? 1 : 500,
      userId: memberId,
    });

    // An accepted invitation always wins. The database lock prevents two local
    // requests from creating personal Organizations concurrently.
    if (memberships.data.length === 0 && organizationId === undefined) {
      const slug = `personal-${memberId.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
      let organization;
      try {
        organization = await clerk.organizations.createOrganization({
          createdBy: memberId,
          name: `${member.firstName ?? "My"}'s workspace`,
          privateMetadata: { personalOwnerMemberId: memberId },
          slug,
        });
      } catch {
        organization = await clerk.organizations.getOrganization({ slug });
        if (organization.privateMetadata.personalOwnerMemberId !== memberId) {
          throw new Error("Personal Organization slug is already owned");
        }
      }

      return {
        member: {
          clerkId: member.id,
          email:
            member.emailAddresses.find(
              (email) => email.id === member.primaryEmailAddressId,
            )?.emailAddress ?? null,
          imageUrl: member.imageUrl,
          name:
            [member.firstName, member.lastName].filter(Boolean).join(" ") || null,
        },
        membership: {
          clerkId: `pending:${memberId}:${organization.id}`,
          memberId,
          organizationId: organization.id,
          role: "org:admin",
        },
        organization: {
          clerkId: organization.id,
          name: organization.name,
          slug: organization.slug,
        },
      };
    }

    const membership =
      organizationId === undefined
        ? memberships.data[0]
        : memberships.data.find(
            (item) => item.organization.id === organizationId,
          );
    if (membership === undefined) {
      throw new Error("Clerk did not create an Organization membership");
    }

    return {
      member: {
        clerkId: member.id,
        email:
          member.emailAddresses.find(
            (email) => email.id === member.primaryEmailAddressId,
          )?.emailAddress ?? null,
        imageUrl: member.imageUrl,
        name:
          [member.firstName, member.lastName].filter(Boolean).join(" ") || null,
      },
      membership: {
        clerkId: membership.id,
        memberId,
        organizationId: membership.organization.id,
        role: membership.role,
      },
      organization: {
        clerkId: membership.organization.id,
        name: membership.organization.name,
        slug: membership.organization.slug,
      },
    };
  },
};
