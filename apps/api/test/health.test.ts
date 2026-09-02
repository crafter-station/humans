import { PostgreSqlContainer } from "@testcontainers/postgresql";
import {
  makeDatabaseLayer,
  type ClerkProjectionEvent,
  type GitHubVerification,
  type ProvisionedWorkspace,
} from "@humans/database";
import * as schema from "@humans/database/schema";
import { applyCreditEntry } from "@humans/database/credits";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { Webhook } from "standardwebhooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import {
  clerkIdentityBoundary,
  type IdentityBoundary,
  type SessionIdentity,
} from "../src/clerk";

describe("Humans API", () => {
  const resources: {
    container?: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
    pool?: Pool;
  } = {};
  let app: ReturnType<typeof createApp>;
  let identity: FakeIdentity;
  let database: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    resources.container = await new PostgreSqlContainer(
      "pgvector/pgvector:pg17",
    ).start();
    resources.pool = new Pool({
      connectionString: resources.container.getConnectionUri(),
    });

    database = drizzle(resources.pool, { schema });
    await migrate(database, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url),
      ),
    });
    identity = new FakeIdentity();
    app = createApp(() => makeDatabaseLayer(database), identity);
  });

  afterAll(async () => {
    await resources.pool?.end();
    await resources.container?.stop();
  });

  it("serves health and public API documentation from an initialized database", async () => {
    const healthResponse = await app.request("/health");
    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toEqual({
      checks: {
        database: "ok",
        pgvector: "ok",
      },
      status: "ok",
    });

    const openApiResponse = await app.request("/openapi.json");
    expect(openApiResponse.status).toBe(200);
    const openApi = await openApiResponse.json();
    expect(openApi).toMatchObject({
      info: { title: "Humans API" },
      paths: { "/health": {} },
    });
    expect(JSON.stringify(openApi)).not.toContain("Profile");

    const documentationResponse = await app.request("/docs");
    expect(documentationResponse.status).toBe(200);
    await expect(documentationResponse.text()).resolves.toContain(
      "Humans API Reference",
    );
  });

  it("projects Clerk events once and isolates Organization workspaces", async () => {
    const memberEvent: ClerkProjectionEvent = {
      id: "evt_member_a",
      sourceUpdatedAt: 1,
      type: "member.upsert",
      member: {
        clerkId: "member_a",
        email: "a@example.com",
        imageUrl: null,
        name: "Member A",
      },
    };
    const membershipEvent: ClerkProjectionEvent = {
      id: "evt_membership_a",
      sourceUpdatedAt: 2,
      type: "membership.upsert",
      member: memberEvent.member,
      membership: {
        clerkId: "membership_a",
        memberId: "member_a",
        organizationId: "organization_a",
        role: "org:admin",
      },
      organization: {
        clerkId: "organization_a",
        name: "Organization A",
        slug: "organization-a",
      },
    };

    await expect(postWebhook(app, memberEvent)).resolves.toMatchObject({
      processed: true,
    });
    await expect(postWebhook(app, membershipEvent)).resolves.toMatchObject({
      processed: true,
    });
    await expect(postWebhook(app, membershipEvent)).resolves.toMatchObject({
      processed: false,
    });

    identity.sessions.set("session_a", {
      memberId: "member_a",
      organizationId: "organization_a",
    });
    const ownWorkspace = await app.request(
      "/v1/organizations/organization_a/workspace",
      { headers: { authorization: "Bearer session_a" } },
    );
    expect(ownWorkspace.status).toBe(200);
    await expect(ownWorkspace.json()).resolves.toMatchObject({
      memberId: "member_a",
      organizationId: "organization_a",
    });

    const otherWorkspace = await app.request(
      "/v1/organizations/organization_b/workspace",
      { headers: { authorization: "Bearer session_a" } },
    );
    expect(otherWorkspace.status).toBe(403);
    await expect(otherWorkspace.json()).resolves.toEqual({
      error: {
        code: "forbidden",
        message: "Organization access is denied",
      },
    });

    await expect(
      postWebhook(app, {
        id: "evt_membership_deleted",
        sourceUpdatedAt: 4,
        type: "membership.delete",
        memberId: "member_a",
        organizationId: "organization_a",
      }),
    ).resolves.toMatchObject({ processed: true });
    await expect(
      postWebhook(app, {
        ...membershipEvent,
        id: "evt_membership_delayed",
        sourceUpdatedAt: 3,
      }),
    ).resolves.toMatchObject({ processed: true });

    const removedWorkspace = await app.request(
      "/v1/organizations/organization_a/workspace",
      { headers: { authorization: "Bearer session_a" } },
    );
    expect(removedWorkspace.status).toBe(403);

    identity.sessions.set("delete_first_session", {
      memberId: "delete_first_member",
      organizationId: "delete_first_organization",
    });
    const deleteFirstMembership: ClerkProjectionEvent = {
      id: "evt_delete_first",
      sourceUpdatedAt: 10,
      type: "membership.delete",
      memberId: "delete_first_member",
      organizationId: "delete_first_organization",
    };
    await postWebhook(app, deleteFirstMembership);
    await postWebhook(app, {
      id: "evt_delayed_create",
      sourceUpdatedAt: 9,
      type: "membership.upsert",
      member: {
        clerkId: "delete_first_member",
        email: null,
        imageUrl: null,
        name: "Removed Member",
      },
      membership: {
        clerkId: "delete_first_membership",
        memberId: "delete_first_member",
        organizationId: "delete_first_organization",
        role: "org:member",
      },
      organization: {
        clerkId: "delete_first_organization",
        name: "Removed Organization",
        slug: "removed-organization",
      },
    });
    const deleteFirstWorkspace = await app.request(
      "/v1/organizations/delete_first_organization/workspace",
      { headers: { authorization: "Bearer delete_first_session" } },
    );
    expect(deleteFirstWorkspace.status).toBe(403);
  });

  it("provisions one personal Organization and preserves invitation membership", async () => {
    identity.sessions.set("new_session", {
      memberId: "new_member",
      organizationId: null,
    });

    const first = await app.request("/v1/workspace", {
      method: "POST",
      headers: { authorization: "Bearer new_session" },
    });
    const retry = await app.request("/v1/workspace", {
      method: "POST",
      headers: { authorization: "Bearer new_session" },
    });
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      organizationId: "personal_new_member",
    });
    await expect(retry.json()).resolves.toMatchObject({
      organizationId: "personal_new_member",
    });
    expect(identity.personalOrganizationsCreated).toBe(1);

    identity.sessions.set("invited_session", {
      memberId: "invited_member",
      organizationId: "inviting_organization",
    });
    identity.organizations.set("invited_member", invitedProjection);
    const invited = await app.request("/v1/workspace", {
      method: "POST",
      headers: { authorization: "Bearer invited_session" },
    });
    expect(invited.status).toBe(200);
    await expect(invited.json()).resolves.toMatchObject({
      organizationId: "inviting_organization",
    });
    expect(identity.personalOrganizationsCreated).toBe(1);
  });

  it("returns a structured unauthorized response", async () => {
    const response = await app.request(
      "/v1/organizations/organization_a/workspace",
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });

    const search = await app.request("/v1/profiles/search");
    expect(search.status).toBe(401);
    const detail = await app.request("/v1/profiles/any-profile");
    expect(detail.status).toBe(401);
  });

  it("creates an eligible Profile only after explicit Member opt-in", async () => {
    identity.sessions.set("profile_session", {
      memberId: "member_a",
      organizationId: "organization_a",
    });
    identity.github.set("member_a", githubVerification());

    const draft = await putProfile(app, "profile_session", {
      ...validProfile,
      searchable: false,
    });
    expect(draft.status).toBe(200);
    await expect(draft.json()).resolves.toMatchObject({
      profile: {
        eligibilityBasis: "owned_repository",
        githubAccountId: "12345",
        searchable: false,
        searchabilityReason: "member_opt_out",
      },
    });

    const publish = await putProfile(app, "profile_session", {
      ...validProfile,
      searchable: true,
    });
    expect(publish.status).toBe(200);
    await expect(publish.json()).resolves.toMatchObject({
      profile: { searchable: true, searchabilityReason: "member_opt_in" },
    });

    const disable = await app.request("/v1/profile/searchability", {
      method: "PATCH",
      headers: {
        authorization: "Bearer profile_session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ searchable: false }),
    });
    expect(disable.status).toBe(200);
    await expect(disable.json()).resolves.toMatchObject({
      profile: { searchable: false, searchabilityReason: "member_opt_out" },
    });

    const unsafeReenable = await app.request("/v1/profile/searchability", {
      method: "PATCH",
      headers: {
        authorization: "Bearer profile_session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ searchable: true }),
    });
    expect(unsafeReenable.status).toBe(422);

    const protectedRead = await app.request("/v1/profile");
    expect(protectedRead.status).toBe(401);
  });

  it("accepts recent public contributions and private-account attestation", async () => {
    identity.github.set("member_a", {
      ...githubVerification(),
      ownsNonForkRepository: false,
      contributedPubliclySince: new Date(),
    });
    const contribution = await putProfile(app, "profile_session", validProfile);
    expect(contribution.status).toBe(200);
    await expect(contribution.json()).resolves.toMatchObject({
      profile: { eligibilityBasis: "public_contribution" },
    });

    identity.github.set("member_a", {
      ...githubVerification(),
      ownsNonForkRepository: false,
      contributedPubliclySince: null,
    });
    const privateAccount = await putProfile(app, "profile_session", {
      ...validProfile,
      privateCodeAttestation: true,
    });
    expect(privateAccount.status).toBe(200);
    await expect(privateAccount.json()).resolves.toMatchObject({
      profile: { eligibilityBasis: "private_attestation" },
    });
  });

  it("rejects ineligible GitHub account types, missing evidence, and minors", async () => {
    const rejected = async (
      github: GitHubVerification,
      profile = validProfile,
    ) => {
      identity.github.set("member_a", github);
      const response = await putProfile(app, "profile_session", profile);
      expect(response.status).toBe(422);
      return response.json();
    };

    await expect(
      rejected({ ...githubVerification(), accountType: "Bot" }),
    ).resolves.toMatchObject({
      error: { code: "ineligible_github_account_type" },
    });
    await expect(
      rejected({ ...githubVerification(), accountType: "Organization" }),
    ).resolves.toMatchObject({
      error: { code: "ineligible_github_account_type" },
    });
    await expect(
      rejected({
        ...githubVerification(),
        ownsNonForkRepository: false,
        contributedPubliclySince: new Date("2020-01-01"),
      }),
    ).resolves.toMatchObject({ error: { code: "coding_evidence_required" } });
    await expect(
      rejected({ ...githubVerification(), knownMinor: true }),
    ).resolves.toMatchObject({ error: { code: "adult_required" } });
    const suppressedProfile = await app.request("/v1/profile", {
      headers: { authorization: "Bearer profile_session" },
    });
    await expect(suppressedProfile.json()).resolves.toMatchObject({
      profile: {
        searchable: false,
        searchabilityReason: "operator_suppression",
      },
    });
    await expect(
      rejected(githubVerification(), {
        ...validProfile,
        adultAttestation: false,
      }),
    ).resolves.toMatchObject({ error: { code: "adult_required" } });
    await expect(
      rejected({ ...githubVerification(), accountId: "different-account" }),
    ).resolves.toMatchObject({
      error: { code: "github_identity_change_requires_review" },
    });
  });

  it("verifies and translates signed Clerk webhooks", async () => {
    const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
    const timestamp = new Date();
    const payload = JSON.stringify({
      data: {
        email_addresses: [
          { email_address: "signed@example.com", id: "email_signed" },
        ],
        first_name: "Signed",
        id: "member_signed",
        image_url: "https://example.com/member.png",
        last_name: "Member",
        primary_email_address_id: "email_signed",
        updated_at: 42,
      },
      event_attributes: {
        http_request: { client_ip: "127.0.0.1", user_agent: "test" },
      },
      object: "event",
      type: "user.created",
    });
    const webhook = new Webhook(secret);
    const eventId = "evt_signed";
    const signature = webhook.sign(eventId, timestamp, payload);
    const event = await clerkIdentityBoundary.verifyWebhook(
      new Request("http://localhost/webhooks/clerk", {
        method: "POST",
        body: payload,
        headers: {
          "svix-id": eventId,
          "svix-signature": signature,
          "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
          "webhook-id": eventId,
          "webhook-signature": signature,
          "webhook-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
        },
      }),
      {
        CLERK_PUBLISHABLE_KEY: "pk_test_unused",
        CLERK_SECRET_KEY: "sk_test_unused",
        CLERK_WEBHOOK_SIGNING_SECRET: secret,
        DATABASE_URL: "postgresql://unused",
      },
    );

    expect(event).toEqual({
      id: eventId,
      sourceUpdatedAt: 42,
      type: "member.upsert",
      member: {
        clerkId: "member_signed",
        email: "signed@example.com",
        imageUrl: "https://example.com/member.png",
        name: "Signed Member",
      },
    });
  });

  it("previews and purchases Contact Reveals without logging values", async () => {
    await database.insert(schema.members).values([
      { clerkId: "reveal_owner", name: "Reveal Owner" },
      { clerkId: "reveal_member", name: "Reveal Member" },
    ]);
    await database.insert(schema.organizations).values({
      clerkId: "reveal_organization",
      name: "Reveal Organization",
    });
    await database.insert(schema.organizationMemberships).values({
      clerkId: "reveal_membership",
      memberId: "reveal_member",
      organizationId: "reveal_organization",
      role: "org:member",
    });
    await database.insert(schema.profiles).values({
      profileId: "reveal_profile",
      memberId: "reveal_owner",
      name: "Reveal Profile",
      githubAccountId: "reveal_github",
      githubLogin: "reveal-profile",
      eligibilityBasis: "owned_repository",
      adultAttested: true,
      searchable: true,
      searchabilityReason: "member_opt_in",
    });
    await database.insert(schema.profileObservations).values({
      id: "reveal_observation",
      profileId: "reveal_profile",
      field: "contact-detail",
      value: {
        type: "professional-email",
        value: "private@company.example",
      },
      source: "tikhub",
      sourceRecordId: "api_reveal_source",
      pipelineVersion: "tikhub-v1",
      confidence: 0.97,
    });
    await applyCreditEntry(database, {
      organizationId: "reveal_organization",
      idempotencyKey: "api:grant",
      kind: "grant",
      amount: 10,
    });
    identity.sessions.set("reveal_session", {
      memberId: "reveal_member",
      organizationId: "reveal_organization",
    });

    const previewResponse = await app.request("/v1/profiles/reveal_profile", {
      headers: { authorization: "Bearer reveal_session" },
    });
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    await expect(previewResponse.json()).resolves.toMatchObject({
      profile: {
        contactDetails: [
          {
            maskedValue: "p***@c***.example",
            price: 5,
            previouslyPurchased: false,
            sourceCategory: "professional-network",
            type: "professional-email",
          },
        ],
      },
    });

    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const purchaseResponse = await app.request(
      "/v1/profiles/reveal_profile/contact-reveals/email",
      {
        method: "POST",
        headers: {
          authorization: "Bearer reveal_session",
          "Idempotency-Key": "api:reveal",
        },
      },
    );
    expect(purchaseResponse.status).toBe(200);
    await expect(purchaseResponse.json()).resolves.toMatchObject({
      reveal: { price: 5, value: "private@company.example" },
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "private@company.example",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("p***@c***.example");
    log.mockRestore();
  });
});

const postWebhook = async (
  app: ReturnType<typeof createApp>,
  event: ClerkProjectionEvent,
) => {
  const response = await app.request("/webhooks/clerk", {
    method: "POST",
    body: JSON.stringify(event),
  });
  expect(response.status).toBe(200);
  return response.json();
};

const invitedProjection: ProvisionedWorkspace = {
  member: {
    clerkId: "invited_member",
    email: "invited@example.com",
    imageUrl: null,
    name: "Invited Member",
  },
  membership: {
    clerkId: "invited_membership",
    memberId: "invited_member",
    organizationId: "inviting_organization",
    role: "org:member",
  },
  organization: {
    clerkId: "inviting_organization",
    name: "Inviting Organization",
    slug: "inviting-organization",
  },
};

class FakeIdentity implements IdentityBoundary {
  readonly github = new Map<string, GitHubVerification>();
  readonly sessions = new Map<string, SessionIdentity>();
  readonly organizations = new Map<string, ProvisionedWorkspace>();
  personalOrganizationsCreated = 0;

  async authenticate(request: Request) {
    const token = request.headers.get("authorization")?.replace("Bearer ", "");
    return token === undefined ? null : (this.sessions.get(token) ?? null);
  }

  async verifyWebhook(request: Request) {
    return (await request.json()) as ClerkProjectionEvent;
  }

  async provisionPersonalOrganization(memberId: string) {
    const existing = this.organizations.get(memberId);
    if (existing !== undefined) return existing;

    this.personalOrganizationsCreated += 1;
    const projection: ProvisionedWorkspace = {
      member: {
        clerkId: memberId,
        email: `${memberId}@example.com`,
        imageUrl: null,
        name: "New Member",
      },
      membership: {
        clerkId: `membership_${memberId}`,
        memberId,
        organizationId: `personal_${memberId}`,
        role: "org:admin",
      },
      organization: {
        clerkId: `personal_${memberId}`,
        name: "Personal Organization",
        slug: `personal-${memberId}`,
      },
    };
    this.organizations.set(memberId, projection);
    return projection;
  }

  async verifyGitHub(memberId: string) {
    const verification = this.github.get(memberId);
    if (verification === undefined) throw new Error("GitHub is not connected");
    return verification;
  }
}

const validProfile = {
  name: "Member A",
  currentCompany: null,
  professionalLinks: ["https://github.com/member-a"],
  statements: {
    location: "Medellin, Colombia",
    role: "Software engineer",
    skills: ["TypeScript", "PostgreSQL"],
  },
  adultAttestation: true,
  privateCodeAttestation: false,
  searchable: false,
};

const githubVerification = (): GitHubVerification => ({
  accountId: "12345",
  login: "member-a",
  accountType: "User",
  ownsNonForkRepository: true,
  contributedPubliclySince: null,
  ownershipVerified: true,
  knownMinor: false,
});

const putProfile = (
  app: ReturnType<typeof createApp>,
  session: string,
  profile: typeof validProfile,
) =>
  app.request("/v1/profile", {
    method: "PUT",
    headers: {
      authorization: `Bearer ${session}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(profile),
  });
