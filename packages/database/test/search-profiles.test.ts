import { PostgreSqlContainer } from "@testcontainers/postgresql";
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
    await database.insert(schema.organizations).values({
      clerkId: "organization_search",
      name: "Search",
    });
    await database.insert(schema.organizationEntitlements).values({
      organizationId: "organization_search",
      tier: "free",
      status: "active",
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
    const second = await searchProfiles(
      database,
      {},
      {
        cursor: first.nextCursor!,
        pageSize: 1,
        now: new Date("2026-09-01T12:01:00Z"),
      },
    );
    expect(second.results.map(({ profileId }) => profileId)).not.toEqual(
      expect.arrayContaining(first.results.map(({ profileId }) => profileId)),
    );
    await expect(
      searchProfiles(
        database,
        {},
        {
          cursor: second.nextCursor!,
          pageSize: 1,
          now: new Date("2026-09-01T12:16:00Z"),
        },
      ),
    ).rejects.toBeInstanceOf(InvalidSearchCursor);
    await expect(
      searchProfiles(
        database,
        { skills: ["rust"] },
        { cursor: first.nextCursor!, now: new Date("2026-09-01T12:01:00Z") },
      ),
    ).rejects.toBeInstanceOf(InvalidSearchCursor);
    await expect(
      searchProfiles(
        database,
        {},
        {
          cursor: `${first.nextCursor!.slice(0, -1)}x`,
          now: new Date("2026-09-01T12:01:00Z"),
        },
      ),
    ).rejects.toBeInstanceOf(InvalidSearchCursor);
    await expect(
      searchProfiles(
        database,
        {},
        { cursor: first.nextCursor!, now: new Date("2026-09-01T12:16:00Z") },
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

    await runChargedProfileSearch(database, {
      organizationId: "organization_search",
      idempotencyKey: "search:second",
      filters: { skills: ["typescript"] },
      cursor: first.page.nextCursor!,
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
        githubAccountId: `reachable-github-${index}`,
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
      githubAccountId: "s1",
      githubLogin: "ana",
      searchable: true,
      updatedAt: new Date("2026-08-20"),
    },
    {
      ...base,
      profileId: "bea",
      name: "Bea Mora",
      currentCompany: "Beta",
      githubAccountId: "s2",
      githubLogin: "bea",
      searchable: true,
      updatedAt: new Date("2026-08-10"),
    },
    {
      ...base,
      profileId: "carla",
      name: "Carla Luz",
      currentCompany: "Cloud",
      githubAccountId: "s3",
      githubLogin: "carla",
      searchable: true,
      updatedAt: new Date("2026-08-30"),
    },
    {
      ...base,
      profileId: "diego",
      name: "Diego Paz",
      currentCompany: "Delta",
      githubAccountId: "s4",
      githubLogin: "diego",
      searchable: true,
      updatedAt: new Date("2026-08-29"),
    },
    {
      ...base,
      profileId: "suppressed",
      name: "Suppressed",
      currentCompany: null,
      githubAccountId: "s5",
      githubLogin: "suppressed",
      searchable: true,
      updatedAt: new Date("2026-08-29"),
    },
    {
      ...base,
      profileId: "private",
      name: "Private",
      currentCompany: null,
      githubAccountId: "s6",
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
    canonicalProviderId: "s5",
    reason: "person_requested_removal",
  });
};
