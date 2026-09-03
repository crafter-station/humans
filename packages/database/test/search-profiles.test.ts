import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Effect } from "effect";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runChargedProfileSearch } from "../src/charged-search";
import {
  applyCreditEntry,
  CreditOperationError,
  getCreditBalance,
} from "../src/credits";
import {
  InvalidSearchCursor,
  getSearchableProfile,
  listProfileSearchFacets,
  searchProfiles,
} from "../src/search-profiles";
import * as schema from "../src/schema";
import { makeDatabaseService } from "../src/service";

describe("Profile search", () => {
  const resources: {
    container?: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
    pool?: Pool;
  } = {};
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
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    await seedSearchProfiles(database);
    await database.insert(schema.members).values({
      clerkId: "member_search",
      name: "Search Member",
    });
    await database.insert(schema.organizations).values({
      clerkId: "organization_search",
      name: "Search",
    });
    await database.insert(schema.organizationEntitlements).values({
      organizationId: "organization_search",
      tier: "free",
      status: "active",
    });
    await database.insert(schema.memberFreeCreditClaims).values({
      memberId: "member_search",
      organizationId: "organization_search",
    });
  });

  afterAll(async () => {
    await resources.pool?.end();
    await resources.container?.stop();
  });

  it("filters every structured field and uses current residence for LATAM location", async () => {
    const result = await searchProfiles(database, {
      roles: ["backend engineer"],
      skills: ["typescript", "postgresql"],
      currentResidences: ["Colombia"],
      companies: ["Acme"],
      seniorities: ["senior"],
      minimumExperience: 7,
      opportunityStatuses: ["not_open"],
    });

    expect(result.results.map(({ name }) => name)).toEqual(["Ana Rios"]);
    const nationalityOnly = await searchProfiles(database, {
      currentResidences: ["Colombia"],
      query: "Diego",
    });
    expect(nationalityOnly.results).toEqual([]);

    const latam = await searchProfiles(database, {
      currentResidences: ["LATAM"],
    });
    expect(latam.results.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["Ana Rios", "Bea Mora", "Carla Luz"]),
    );
    expect(latam.results.map(({ name }) => name)).not.toContain("Diego Paz");
  });

  it("orders requested matches before evidence and freshness, with Opportunity Status as a boost", async () => {
    const result = await searchProfiles(database, {
      roles: ["backend"],
      skills: ["typescript"],
      currentResidences: ["medellin"],
    });

    expect(result.results.map(({ name }) => name)).toEqual([
      "Bea Mora",
      "Ana Rios",
    ]);
    expect(result.results[0]).not.toHaveProperty("score");
  });

  it("resolves field aliases before applying Member Statement precedence", async () => {
    const profileId = "statement-precedence";
    try {
      await database.insert(schema.profiles).values({
        profileId,
        name: "Alias Profile",
        currentCompany: null,
        githubAccountId: "91001",
        githubLogin: "statement-precedence",
        eligibilityBasis: "owned_repository",
        adultAttested: true,
        searchable: true,
        searchabilityReason: "approved_import",
      });
      await database.insert(schema.profileObservations).values({
        profileId,
        field: "github-normalization",
        value: {
          roles: ["Provider Engineer"],
          location: "Provider Location",
          current_residence: "Provider Residence",
          current_company: "Provider Company",
          opportunity_status: "not_open",
        },
        source: "provider-normalization",
        sourceRecordId: "statement-precedence:normalization",
        pipelineVersion: "provider-v1",
        confidence: 1,
        collectedAt: new Date("2026-08-30T00:00:00Z"),
      });
      await database.insert(schema.memberStatements).values([
        {
          id: "statement-precedence-role",
          profileId,
          field: "role",
          value: "Member Architect",
          source: "member",
          pipelineVersion: "member-v1",
          confidence: 1,
          collectedAt: new Date("2026-08-20T00:00:00Z"),
        },
        {
          id: "statement-precedence-residence-old",
          profileId,
          field: "currentResidence",
          value: "Older Member Residence",
          source: "member",
          pipelineVersion: "member-v1",
          confidence: 1,
          collectedAt: new Date("2026-08-20T00:00:00Z"),
        },
        {
          id: "statement-precedence-residence-new",
          profileId,
          field: "location",
          value: "Quito, Ecuador",
          source: "member",
          pipelineVersion: "member-v1",
          confidence: 1,
          collectedAt: new Date("2026-08-21T00:00:00Z"),
        },
        {
          id: "statement-precedence-company",
          profileId,
          field: "currentCompany",
          value: "Member Company",
          source: "member",
          pipelineVersion: "member-v1",
          confidence: 1,
          collectedAt: new Date("2026-08-20T00:00:00Z"),
        },
        {
          id: "statement-precedence-opportunity",
          profileId,
          field: "opportunityStatus",
          value: "open",
          source: "member",
          pipelineVersion: "member-v1",
          confidence: 1,
          collectedAt: new Date("2026-08-20T00:00:00Z"),
        },
      ]);

      await expect(getSearchableProfile(database, profileId)).resolves.toEqual(
        expect.objectContaining({
          profileId,
          primaryRole: "Member Architect",
          currentResidence: "Quito, Ecuador",
          currentCompany: "Member Company",
          opportunityStatus: "open",
        }),
      );
      const result = await searchProfiles(database, {
        roles: ["member architect"],
        currentResidences: ["quito"],
        companies: ["member company"],
        opportunityStatuses: ["open"],
      });
      expect(result.results.map(({ profileId: id }) => id)).toContain(
        profileId,
      );
    } finally {
      await database
        .delete(schema.memberStatements)
        .where(eq(schema.memberStatements.profileId, profileId));
      await database
        .delete(schema.profileObservations)
        .where(eq(schema.profileObservations.profileId, profileId));
      await database
        .delete(schema.profiles)
        .where(eq(schema.profiles.profileId, profileId));
    }
  });

  it("projects TikHub LinkedIn career evidence into imported Profile search", async () => {
    const profileId = "tikhub-career-projection";
    try {
      await database.insert(schema.profiles).values({
        profileId,
        name: "TikHub Profile",
        currentCompany: null,
        githubAccountId: "91002",
        githubLogin: "tikhub-career-projection",
        eligibilityBasis: "owned_repository",
        adultAttested: true,
        searchable: true,
        searchabilityReason: "approved_import",
      });
      await database.insert(schema.profileObservations).values({
        profileId,
        field: "linkedin-career",
        value: {
          sourceRecordId: "linkedin:91002",
          headline: "Founder and Engineer",
          currentCompany: "Zabio (SureFX)",
          experience: [],
          education: [],
          skills: ["TypeScript"],
        },
        source: "tikhub",
        sourceRecordId: "linkedin:91002",
        pipelineVersion: "tikhub-linkedin-v1",
        confidence: 1,
        collectedAt: new Date("2026-09-03T00:00:00Z"),
      });
      await database.insert(schema.profileObservations).values({
        profileId,
        field: "headline",
        value: "Fallback headline",
        source: "deepline",
        sourceRecordId: "deepline:headline:91002",
        pipelineVersion: "deepline-fallback-v1",
        confidence: 1,
        collectedAt: new Date("2026-09-03T00:30:00Z"),
      });

      await expect(getSearchableProfile(database, profileId)).resolves.toEqual(
        expect.objectContaining({
          headline: "Founder and Engineer",
          currentCompany: "Zabio (SureFX)",
          skills: ["TypeScript"],
        }),
      );
      const result = await searchProfiles(database, {
        companies: ["Zabio (SureFX)"],
      });
      expect(result.results.map(({ profileId: id }) => id)).toContain(
        profileId,
      );

      await database
        .update(schema.profiles)
        .set({ currentCompany: "Zabio (SureFX)" })
        .where(eq(schema.profiles.profileId, profileId));
      await database.insert(schema.profileObservations).values({
        profileId,
        field: "current_company",
        value: sql`'null'::jsonb`,
        source: "public-profile-request",
        sourceRecordId: "cleared-company:91002",
        pipelineVersion: "public-request-v1",
        confidence: 1,
        collectedAt: new Date("2026-09-03T00:45:00Z"),
      });
      await expect(getSearchableProfile(database, profileId)).resolves.toEqual(
        expect.objectContaining({
          headline: "Founder and Engineer",
          currentCompany: null,
          skills: ["TypeScript"],
        }),
      );
      const clearedResult = await searchProfiles(database, {
        companies: ["Zabio (SureFX)"],
      });
      expect(
        clearedResult.results.map(({ profileId: id }) => id),
      ).not.toContain(profileId);

      await database
        .update(schema.profileObservations)
        .set({ staleAt: new Date("2026-09-03T01:00:00Z") })
        .where(
          and(
            eq(schema.profileObservations.profileId, profileId),
            inArray(schema.profileObservations.source, ["tikhub", "deepline"]),
          ),
        );
      await expect(getSearchableProfile(database, profileId)).resolves.toEqual(
        expect.objectContaining({
          headline: null,
          currentCompany: null,
          skills: [],
        }),
      );
      const staleResult = await searchProfiles(database, {
        companies: ["Zabio (SureFX)"],
      });
      expect(staleResult.results.map(({ profileId: id }) => id)).not.toContain(
        profileId,
      );
    } finally {
      await database
        .delete(schema.profileObservations)
        .where(eq(schema.profileObservations.profileId, profileId));
      await database
        .delete(schema.profiles)
        .where(eq(schema.profiles.profileId, profileId));
    }
  });

  it("uses fallback evidence when direct providers returned missing values", async () => {
    const profileId = "missing-direct-fallback-projection";
    try {
      await database.insert(schema.profiles).values({
        profileId,
        name: "Fallback Profile",
        currentCompany: "Imported Company",
        githubAccountId: "91003",
        githubLogin: "missing-direct-fallback",
        eligibilityBasis: "owned_repository",
        adultAttested: true,
        searchable: true,
        searchabilityReason: "approved_import",
      });
      await database.insert(schema.profileObservations).values([
        {
          profileId,
          field: "linkedin-career",
          value: {
            sourceRecordId: "linkedin:91003",
            headline: null,
            currentCompany: null,
            experience: [],
            education: [],
            skills: [],
          },
          source: "tikhub",
          sourceRecordId: "linkedin:91003",
          pipelineVersion: "tikhub-linkedin-v1",
          confidence: 1,
        },
        {
          profileId,
          field: "github-normalization",
          value: { roles: [], skills: [], summary: "" },
          source: "github-ai-normalization",
          sourceRecordId: "github:91003:normalization",
          pipelineVersion: "github-v1",
          confidence: 1,
        },
        {
          profileId,
          field: "headline",
          value: "Fallback headline",
          source: "deepline",
          sourceRecordId: "deepline:headline:91003",
          pipelineVersion: "deepline-fallback-v1",
          confidence: 0.8,
        },
        {
          profileId,
          field: "skills",
          value: ["Rust"],
          source: "deepline",
          sourceRecordId: "deepline:skills:91003",
          pipelineVersion: "deepline-fallback-v1",
          confidence: 0.8,
        },
        {
          profileId,
          field: "currentPosition",
          value: [
            {
              companyName: "Fallback Company",
              position: "Principal Engineer",
            },
          ],
          source: "deepline",
          sourceRecordId: "deepline:position:91003",
          pipelineVersion: "deepline-fallback-v1",
          confidence: 0.8,
        },
      ]);

      await expect(getSearchableProfile(database, profileId)).resolves.toEqual(
        expect.objectContaining({
          headline: "Fallback headline",
          currentCompany: "Fallback Company",
          primaryRole: "Principal Engineer",
          skills: ["Rust"],
        }),
      );

      await database.insert(schema.profileObservations).values({
        profileId,
        field: "github-normalization",
        value: {
          roles: ["Maintainer"],
          skills: ["TypeScript"],
          summary: "Direct GitHub summary",
        },
        source: "github-ai-normalization",
        sourceRecordId: "github:91003:complete-normalization",
        pipelineVersion: "github-v1",
        confidence: 1,
      });
      await expect(getSearchableProfile(database, profileId)).resolves.toEqual(
        expect.objectContaining({
          headline: "Direct GitHub summary",
          primaryRole: "Maintainer",
          skills: ["TypeScript"],
        }),
      );

      await database.insert(schema.profileObservations).values([
        {
          profileId,
          field: "github-account",
          value: { company: "Earlier Direct Company" },
          source: "github",
          sourceRecordId: "github:91003:earlier-account",
          pipelineVersion: "github-v1",
          confidence: 1,
          collectedAt: new Date("2026-09-01T00:00:00.000Z"),
        },
        {
          profileId,
          field: "github-account",
          value: { company: "Latest Direct Company" },
          source: "github",
          sourceRecordId: "github:91003:latest-account",
          pipelineVersion: "github-v1",
          confidence: 1,
          collectedAt: new Date("2026-09-02T00:00:00.000Z"),
        },
      ]);
      await expect(getSearchableProfile(database, profileId)).resolves.toEqual(
        expect.objectContaining({ currentCompany: "Latest Direct Company" }),
      );
    } finally {
      await database
        .delete(schema.profileObservations)
        .where(eq(schema.profileObservations.profileId, profileId));
      await database
        .delete(schema.profiles)
        .where(eq(schema.profiles.profileId, profileId));
    }
  });

  it("keeps controlled Profile name and currentCompany authoritative in search", async () => {
    const memberId = "member-search-precedence";
    const profileId = "controlled-search-precedence";
    try {
      await database.insert(schema.members).values({ clerkId: memberId });
      await database.insert(schema.profiles).values({
        profileId,
        memberId,
        name: "PUT Name",
        currentCompany: null,
        githubAccountId: "91002",
        githubLogin: "controlled-search-precedence",
        eligibilityBasis: "owned_repository",
        adultAttested: true,
        searchable: true,
        searchabilityReason: "member_opt_in",
      });
      await database.insert(schema.profileObservations).values({
        profileId,
        field: "github-normalization",
        value: {
          name: "Provider Name",
          current_company: "Provider Company",
        },
        source: "provider-normalization",
        sourceRecordId: "controlled-search-precedence:normalization",
        pipelineVersion: "provider-v1",
        confidence: 1,
      });

      await expect(getSearchableProfile(database, profileId)).resolves.toEqual(
        expect.objectContaining({
          profileId,
          name: "PUT Name",
          currentCompany: null,
        }),
      );
      const putValue = await searchProfiles(database, { query: "PUT Name" });
      expect(putValue.results.map(({ profileId: id }) => id)).toContain(
        profileId,
      );
      const providerValues = await searchProfiles(database, {
        query: "Provider Name",
        companies: ["Provider Company"],
      });
      expect(
        providerValues.results.map(({ profileId: id }) => id),
      ).not.toContain(profileId);
    } finally {
      await database
        .delete(schema.profileObservations)
        .where(eq(schema.profileObservations.profileId, profileId));
      await database
        .delete(schema.profiles)
        .where(eq(schema.profiles.profileId, profileId));
      await database
        .delete(schema.members)
        .where(eq(schema.members.clerkId, memberId));
    }
  });

  it("excludes non-searchable and suppressed Profiles from search and detail", async () => {
    const result = await searchProfiles(database, {});
    expect(result.results.map(({ profileId }) => profileId)).not.toEqual(
      expect.arrayContaining(["suppressed", "private"]),
    );
    await expect(
      getSearchableProfile(database, "suppressed"),
    ).resolves.toBeNull();
    await expect(getSearchableProfile(database, "private")).resolves.toBeNull();
  });

  it("uses filter-bound expiring keyset cursors and caps pages at 100", async () => {
    const first = await searchProfiles(
      database,
      {},
      { pageSize: 2, now: new Date("2026-09-01T12:00:00Z") },
    );
    expect(first.results).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const firstCursor = first.nextCursor;
    if (firstCursor === null) throw new Error("Expected a search cursor");
    const second = await searchProfiles(
      database,
      {},
      {
        cursor: firstCursor,
        pageSize: 1,
        now: new Date("2026-09-01T12:01:00Z"),
      },
    );
    const secondCursor = second.nextCursor;
    if (secondCursor === null)
      throw new Error("Expected a second search cursor");
    expect(second.results.map(({ profileId }) => profileId)).not.toEqual(
      expect.arrayContaining(first.results.map(({ profileId }) => profileId)),
    );
    await expect(
      searchProfiles(
        database,
        {},
        {
          cursor: secondCursor,
          pageSize: 1,
          now: new Date("2026-09-01T12:16:00Z"),
        },
      ),
    ).rejects.toBeInstanceOf(InvalidSearchCursor);
    await expect(
      searchProfiles(
        database,
        { skills: ["rust"] },
        { cursor: firstCursor, now: new Date("2026-09-01T12:01:00Z") },
      ),
    ).rejects.toBeInstanceOf(InvalidSearchCursor);
    await expect(
      searchProfiles(
        database,
        {},
        {
          cursor: `${firstCursor[0] === "A" ? "B" : "A"}${firstCursor.slice(1)}`,
          now: new Date("2026-09-01T12:01:00Z"),
        },
      ),
    ).rejects.toBeInstanceOf(InvalidSearchCursor);
    await expect(
      searchProfiles(
        database,
        {},
        { cursor: firstCursor, now: new Date("2026-09-01T12:16:00Z") },
      ),
    ).rejects.toBeInstanceOf(InvalidSearchCursor);
    await expect(
      searchProfiles(database, {}, { pageSize: 500 }),
    ).resolves.toMatchObject({
      results: expect.any(Array),
    });
  });

  it("lists facets without exposing suppressed or non-searchable Profiles", async () => {
    const facets = await listProfileSearchFacets(database);

    expect(facets).toMatchObject({
      roles: ["Backend Engineer", "Frontend Engineer"],
      skills: ["PostgreSQL", "React", "Rust", "TypeScript"],
      companies: ["Acme", "Beta", "Cloud", "Delta"],
      seniorities: ["Senior"],
      opportunityStatuses: ["not_open", "open"],
    });
    expect(facets.currentResidences).not.toContain("Bogota, Colombia");
  });

  it("charges successful initial and page searches once and leaves failures free", async () => {
    await applyCreditEntry(database, {
      organizationId: "organization_search",
      idempotencyKey: "grant:search",
      kind: "grant",
      amount: 2,
    });
    const failedCursor = "not-a-cursor";
    await expect(
      runChargedProfileSearch(database, {
        organizationId: "organization_search",
        idempotencyKey: "search:failed",
        filters: {},
        cursor: failedCursor,
      }),
    ).rejects.toBeInstanceOf(InvalidSearchCursor);
    expect(await getCreditBalance(database, "organization_search")).toBe(2);

    const first = await runChargedProfileSearch(database, {
      organizationId: "organization_search",
      idempotencyKey: "search:first",
      filters: { skills: ["typescript"] },
      pageSize: 1,
    });
    await runChargedProfileSearch(database, {
      organizationId: "organization_search",
      idempotencyKey: "search:first",
      filters: { skills: ["typescript"] },
      pageSize: 1,
    });
    expect(await getCreditBalance(database, "organization_search")).toBe(1);
    const nextCursor = first.page.nextCursor;
    if (nextCursor === null)
      throw new Error("Expected a charged search cursor");

    await runChargedProfileSearch(database, {
      organizationId: "organization_search",
      idempotencyKey: "search:second",
      filters: { skills: ["typescript"] },
      cursor: nextCursor,
      pageSize: 1,
    });
    expect(await getCreditBalance(database, "organization_search")).toBe(0);
    await expect(
      runChargedProfileSearch(database, {
        organizationId: "organization_search",
        idempotencyKey: "search:first",
        filters: { skills: ["rust"] },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      runChargedProfileSearch(database, {
        organizationId: "organization_search",
        idempotencyKey: "search:third",
        filters: { skills: ["rust"] },
      }),
    ).rejects.toBeInstanceOf(CreditOperationError);
    expect(await getCreditBalance(database, "organization_search")).toBe(0);

    const service = makeDatabaseService(database);
    await expect(
      Effect.runPromise(
        service.searchProfilesWithCredit({
          organizationId: "organization_search",
          idempotencyKey: "search:service-insufficient",
          filters: { skills: ["rust"] },
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "SearchChargeRejected",
      reason: "insufficient_credits",
    });
    await expect(
      Effect.runPromise(
        service.searchProfilesWithCredit({
          organizationId: "organization_search",
          idempotencyKey: "search:first",
          filters: { skills: ["rust"] },
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "SearchChargeRejected",
      reason: "idempotency_conflict",
    });
  });

  it("caps a query at exactly 1,000 reachable results across variable pages", async () => {
    await database.insert(schema.profiles).values(
      Array.from({ length: 1_001 }, (_, index) => ({
        profileId: `reachable-${index.toString().padStart(4, "0")}`,
        name: `Reachable ${index.toString().padStart(4, "0")}`,
        currentCompany: null,
        githubAccountId: String(94_000 + index),
        githubLogin: `reachable-${index}`,
        eligibilityBasis: "owned_repository",
        adultAttested: true,
        searchable: true,
        searchabilityReason: "approved_import",
      })),
    );

    let cursor: string | undefined;
    let reached = 0;
    for (const pageSize of [
      73, 100, 100, 100, 100, 100, 100, 100, 100, 100, 27,
    ]) {
      const page = await searchProfiles(
        database,
        { query: "reachable" },
        { cursor, pageSize },
      );
      reached += page.results.length;
      cursor = page.nextCursor ?? undefined;
    }
    expect(reached).toBe(1_000);
    expect(cursor).toBeUndefined();
  });
});

const seedSearchProfiles = async (
  database: ReturnType<typeof drizzle<typeof schema>>,
) => {
  const base = {
    eligibilityBasis: "owned_repository",
    adultAttested: true,
    searchabilityReason: "approved_import",
  };
  await database.insert(schema.profiles).values([
    {
      ...base,
      profileId: "ana",
      name: "Ana Rios",
      currentCompany: "Acme",
      githubAccountId: "92001",
      githubLogin: "ana",
      searchable: true,
      updatedAt: new Date("2026-08-20"),
    },
    {
      ...base,
      profileId: "bea",
      name: "Bea Mora",
      currentCompany: "Beta",
      githubAccountId: "92002",
      githubLogin: "bea",
      searchable: true,
      updatedAt: new Date("2026-08-10"),
    },
    {
      ...base,
      profileId: "carla",
      name: "Carla Luz",
      currentCompany: "Cloud",
      githubAccountId: "92003",
      githubLogin: "carla",
      searchable: true,
      updatedAt: new Date("2026-08-30"),
    },
    {
      ...base,
      profileId: "diego",
      name: "Diego Paz",
      currentCompany: "Delta",
      githubAccountId: "92004",
      githubLogin: "diego",
      searchable: true,
      updatedAt: new Date("2026-08-29"),
    },
    {
      ...base,
      profileId: "suppressed",
      name: "Suppressed",
      currentCompany: null,
      githubAccountId: "92005",
      githubLogin: "suppressed",
      searchable: true,
      updatedAt: new Date("2026-08-29"),
    },
    {
      ...base,
      profileId: "private",
      name: "Private",
      currentCompany: null,
      githubAccountId: "92006",
      githubLogin: "private",
      searchable: false,
      updatedAt: new Date("2026-08-29"),
    },
  ]);
  const evidence = (
    profileId: string,
    value: Record<string, unknown>,
    confidence = 0.9,
  ) => ({
    profileId,
    field: "github-normalization",
    value,
    source: "github-ai-normalization",
    sourceRecordId: `${profileId}:normalization`,
    pipelineVersion: "github-v1",
    confidence,
    collectedAt: new Date("2026-08-25"),
  });
  await database.insert(schema.profileObservations).values([
    evidence(
      "ana",
      {
        roles: ["Backend Engineer"],
        skills: ["TypeScript", "PostgreSQL"],
        summary: "Systems builder",
        current_residence: "Medellin, Colombia",
        seniority: "Senior",
        experience_years: 8,
        opportunity_status: "not_open",
      },
      1,
    ),
    evidence(
      "bea",
      {
        roles: ["Backend Engineer"],
        skills: ["TypeScript"],
        summary: "Platform specialist",
        current_residence: "Medellin, Colombia",
        seniority: "Senior",
        experience_years: 9,
        opportunity_status: "open",
      },
      0.8,
    ),
    evidence("carla", {
      roles: ["Frontend Engineer"],
      skills: ["React"],
      current_residence: "Sao Paulo, Brazil",
      opportunity_status: "open",
    }),
    evidence("diego", {
      roles: ["Backend Engineer"],
      skills: ["Rust"],
      current_residence: "Lisbon, Portugal",
      nationality: "Colombia",
      opportunity_status: "open",
    }),
    evidence("suppressed", {
      roles: ["Backend Engineer"],
      skills: ["TypeScript"],
      current_residence: "Bogota, Colombia",
    }),
  ]);
  await database.insert(schema.memberStatements).values({
    id: "bea-role",
    profileId: "bea",
    field: "role",
    value: "Backend Engineer",
    source: "member",
    pipelineVersion: "member-v1",
    confidence: 1,
    collectedAt: new Date("2026-08-26"),
  });
  await database.insert(schema.suppressionRecords).values({
    canonicalProvider: "github",
    canonicalProviderId: "92005",
    reason: "person_requested_removal",
  });
};
