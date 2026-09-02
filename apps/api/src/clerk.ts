import { createClerkClient } from "@clerk/backend";
import { verifyWebhook } from "@clerk/backend/webhooks";
import type {
  ClerkProjectionEvent,
  GitHubVerification,
  MemberProjection,
  OrganizationProjection,
  ProvisionedWorkspace,
} from "@humans/database";

import type { Bindings } from "./app";

export type SessionIdentity = {
  memberId: string;
  organizationId: string | null;
  systemRole?: "operator";
  emailVerified?: boolean;
  botProtectionVerified?: boolean;
};

export type ApiScope = "profiles:read" | "contacts:reveal";

export type ApiKeyIdentity = {
  keyId: string;
  memberId: string;
  organizationId: string;
  scopes: ApiScope[];
};

export type OrganizationApiKey = {
  id: string;
  name: string;
  description: string | null;
  scopes: string[];
  revoked: boolean;
  expired: boolean;
  expiration: number | null;
  createdAt: number;
};

export type CreatedOrganizationApiKey = OrganizationApiKey & {
  secret: string;
};

export type IdentityBoundary = {
  authenticate(
    request: Request,
    bindings: Bindings,
  ): Promise<SessionIdentity | null>;
  authenticateApiKey(
    request: Request,
    bindings: Bindings,
  ): Promise<ApiKeyIdentity | null>;
  createOrganizationApiKey(
    input: {
      memberId: string;
      organizationId: string;
      name: string;
      description?: string;
      scopes: ApiScope[];
      secondsUntilExpiration?: number;
    },
    bindings: Bindings,
  ): Promise<CreatedOrganizationApiKey>;
  listOrganizationApiKeys(
    organizationId: string,
    bindings: Bindings,
  ): Promise<OrganizationApiKey[]>;
  revokeOrganizationApiKey(
    organizationId: string,
    apiKeyId: string,
    bindings: Bindings,
  ): Promise<OrganizationApiKey | null>;
  revokeMemberSessions?(memberId: string, bindings: Bindings): Promise<void>;
  revokeAllOrganizationApiKeys?(
    organizationId: string,
    bindings: Bindings,
  ): Promise<void>;
  verifyWebhook(
    request: Request,
    bindings: Bindings,
  ): Promise<ClerkProjectionEvent | null>;
  provisionPersonalOrganization(
    memberId: string,
    bindings: Bindings,
    organizationId?: string,
  ): Promise<ProvisionedWorkspace>;
  verifyGitHub(
    memberId: string,
    bindings: Bindings,
  ): Promise<GitHubVerification>;
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
  name: [data.first_name, data.last_name].filter(Boolean).join(" ") || null,
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
    const member = await clerk.users.getUser(auth.userId);
    const primaryEmail = member.emailAddresses.find(
      (email) => email.id === member.primaryEmailAddressId,
    );
    return {
      memberId: auth.userId,
      organizationId: auth.orgId ?? null,
      systemRole:
        member.publicMetadata.humansRole === "operator"
          ? "operator"
          : undefined,
      emailVerified: primaryEmail?.verification?.status === "verified",
      // A completed Clerk signup proves the configured protection flow passed.
      botProtectionVerified: bindings.CLERK_BOT_PROTECTION_ENABLED === "true",
    };
  },

  async authenticateApiKey(request, bindings) {
    const clerk = createClerkClient({ secretKey: bindings.CLERK_SECRET_KEY });
    const state = await clerk
      .authenticateRequest(request, { acceptsToken: "api_key" })
      .catch(() => null);
    if (state === null || !state.isAuthenticated) return null;

    const auth = state.toAuth();
    const claims = auth.claims as Record<string, unknown> | null;
    const memberId = claims?.humansMemberId;
    const scopes = auth.scopes.filter(isApiScope);
    if (
      !auth.subject.startsWith("org_") ||
      typeof memberId !== "string" ||
      memberId === "" ||
      scopes.length === 0 ||
      scopes.length !== auth.scopes.length
    ) {
      return null;
    }
    return {
      keyId: auth.id,
      memberId,
      organizationId: auth.subject,
      scopes,
    };
  },

  async createOrganizationApiKey(input, bindings) {
    const clerk = createClerkClient({ secretKey: bindings.CLERK_SECRET_KEY });
    const apiKey = await clerk.apiKeys.create({
      name: input.name,
      subject: input.organizationId,
      description: input.description,
      scopes: input.scopes,
      claims: { humansMemberId: input.memberId },
      createdBy: input.memberId,
      secondsUntilExpiration: input.secondsUntilExpiration,
    });
    if (!apiKey.secret)
      throw new Error("Clerk did not return an API key secret");
    return { ...organizationApiKey(apiKey), secret: apiKey.secret };
  },

  async listOrganizationApiKeys(organizationId, bindings) {
    const clerk = createClerkClient({ secretKey: bindings.CLERK_SECRET_KEY });
    const result = await clerk.apiKeys.list({
      subject: organizationId,
      includeInvalid: true,
      limit: 500,
    });
    return result.data.map(organizationApiKey);
  },

  async revokeOrganizationApiKey(organizationId, apiKeyId, bindings) {
    const clerk = createClerkClient({ secretKey: bindings.CLERK_SECRET_KEY });
    const keys = await clerk.apiKeys.list({
      subject: organizationId,
      includeInvalid: true,
      limit: 500,
    });
    if (!keys.data.some((key) => key.id === apiKeyId)) return null;
    return organizationApiKey(
      await clerk.apiKeys.revoke({
        apiKeyId,
        revocationReason: "Revoked by an Organization admin",
      }),
    );
  },

  async revokeMemberSessions(memberId, bindings) {
    const clerk = createClerkClient({ secretKey: bindings.CLERK_SECRET_KEY });
    const sessions = await clerk.sessions.getSessionList({
      userId: memberId,
      limit: 500,
    });
    await Promise.all(
      sessions.data.map((session) =>
        clerk.sessions.revokeSession(session.id).then(() => undefined),
      ),
    );
  },

  async revokeAllOrganizationApiKeys(organizationId, bindings) {
    const clerk = createClerkClient({ secretKey: bindings.CLERK_SECRET_KEY });
    const keys = await clerk.apiKeys.list({
      subject: organizationId,
      includeInvalid: false,
      limit: 500,
    });
    await Promise.all(
      keys.data.map((key) =>
        clerk.apiKeys
          .revoke({
            apiKeyId: key.id,
            revocationReason: "Revoked by a Humans Operator",
          })
          .then(() => undefined),
      ),
    );
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
    if (!Number.isFinite(deliveredAt))
      throw new Error("Missing webhook-timestamp");

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
          name:
            [member.first_name, member.last_name].filter(Boolean).join(" ") ||
            null,
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
      const organization = await clerk.organizations
        .createOrganization({
          createdBy: memberId,
          name: `${member.firstName ?? "My"}'s workspace`,
          privateMetadata: { personalOwnerMemberId: memberId },
          slug,
        })
        .catch(async () => {
          const existing = await clerk.organizations.getOrganization({ slug });
          if (existing.privateMetadata.personalOwnerMemberId !== memberId) {
            throw new Error("Personal Organization slug is already owned");
          }
          return existing;
        });

      return {
        member: {
          clerkId: member.id,
          email:
            member.emailAddresses.find(
              (email) => email.id === member.primaryEmailAddressId,
            )?.emailAddress ?? null,
          imageUrl: member.imageUrl,
          name:
            [member.firstName, member.lastName].filter(Boolean).join(" ") ||
            null,
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

  async verifyGitHub(memberId, bindings) {
    const clerk = createClerkClient({ secretKey: bindings.CLERK_SECRET_KEY });
    const [tokens, member] = await Promise.all([
      clerk.users.getUserOauthAccessToken(memberId, "github"),
      clerk.users.getUser(memberId),
    ]);
    const token = tokens.data[0]?.token;
    if (token === undefined)
      throw new Error("A connected GitHub account is required");

    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    };
    const accountResponse = await fetch("https://api.github.com/user", {
      headers,
    });
    if (!accountResponse.ok)
      throw new Error("GitHub ownership verification failed");
    const account = (await accountResponse.json()) as {
      id: number;
      login: string;
      type: "User" | "Bot" | "Organization";
    };

    let ownsNonForkRepository = false;
    for (let page = 1; !ownsNonForkRepository; page += 1) {
      const repositoriesResponse = await fetch(
        `https://api.github.com/user/repos?affiliation=owner&visibility=public&per_page=100&page=${page}`,
        { headers },
      );
      if (!repositoriesResponse.ok)
        throw new Error("GitHub repository verification failed");
      const repositories = (await repositoriesResponse.json()) as Array<{
        fork: boolean;
      }>;
      ownsNonForkRepository = repositories.some(
        (repository) => !repository.fork,
      );
      if (repositories.length < 100) break;
    }

    const cutoff = new Date();
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
    cutoff.setUTCHours(0, 0, 0, 0);
    const contributionsResponse = await fetch(
      "https://api.github.com/graphql",
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          query: `query($from: DateTime!) {
          viewer {
            contributionsCollection(from: $from) {
              commitContributionsByRepository(maxRepositories: 100) {
                repository { isPrivate }
                contributions(first: 1) { nodes { occurredAt } }
              }
              pullRequestContributions(first: 100) {
                nodes {
                  occurredAt
                  pullRequest { repository { isPrivate } }
                }
              }
            }
          }
        }`,
          variables: { from: cutoff.toISOString() },
        }),
      },
    );
    const contributions = contributionsResponse.ok
      ? (
          (await contributionsResponse.json()) as {
            data?: {
              viewer: {
                contributionsCollection: {
                  commitContributionsByRepository: Array<{
                    repository: { isPrivate: boolean };
                    contributions: { nodes: Array<{ occurredAt: string }> };
                  }>;
                  pullRequestContributions: {
                    nodes: Array<{
                      occurredAt: string;
                      pullRequest: { repository: { isPrivate: boolean } };
                    }>;
                  };
                };
              };
            };
          }
        ).data?.viewer.contributionsCollection
      : undefined;
    const publicContributionDates = contributions
      ? [
          ...contributions.commitContributionsByRepository.flatMap(
            ({ repository, contributions: repositoryContributions }) =>
              repository.isPrivate
                ? []
                : repositoryContributions.nodes.map(
                    (contribution) => contribution.occurredAt,
                  ),
          ),
          ...contributions.pullRequestContributions.nodes.flatMap(
            (contribution) =>
              contribution.pullRequest.repository.isPrivate
                ? []
                : [contribution.occurredAt],
          ),
        ]
      : [];

    return {
      accountId: String(account.id),
      login: account.login,
      accountType: account.type,
      ownsNonForkRepository,
      contributedPubliclySince:
        publicContributionDates.length > 0
          ? new Date(publicContributionDates.sort().at(-1)!)
          : null,
      ownershipVerified: true,
      knownMinor: member.privateMetadata.knownMinor === true,
    };
  },
};

const isApiScope = (scope: string): scope is ApiScope =>
  scope === "profiles:read" || scope === "contacts:reveal";

const organizationApiKey = (apiKey: {
  id: string;
  name: string;
  description: string | null;
  scopes: string[];
  revoked: boolean;
  expired: boolean;
  expiration: number | null;
  createdAt: number;
}): OrganizationApiKey => ({
  id: apiKey.id,
  name: apiKey.name,
  description: apiKey.description,
  scopes: apiKey.scopes,
  revoked: apiKey.revoked,
  expired: apiKey.expired,
  expiration: apiKey.expiration,
  createdAt: apiKey.createdAt,
});
