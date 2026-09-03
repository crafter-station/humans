import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  importProfiles,
  suppressProviderIdentity,
} from "../src/import-profiles";
import * as schema from "../src/schema";

describe("Profile importer", () => {
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
  });

  afterAll(async () => {
    await resources.pool?.end();
    await resources.container?.stop();
  });

  it("reports a dry-run without writing and imports the sanitized v1 fixture idempotently", async () => {
    const csv = await readFile(
      new URL("../fixtures/imported-profiles-v1.csv", import.meta.url),
      "utf8",
    );

    const dryRun = await importProfiles(database, csv, { dryRun: true });
    expect(dryRun).toMatchObject({
      applied: false,
      validRows: 2,
      invalidRows: [],
      canonicalMatches: 0,
      duplicateCandidates: [],
      plannedChanges: {
        createProfiles: 2,
        addObservations: 2,
        suppressedProfiles: 0,
        noops: 0,
      },
    });

    const imported = await importProfiles(database, csv, {
      dryRun: false,
      runId: "fixture-import",
    });
    expect(imported).toMatchObject({
      applied: true,
      canonicalMatches: 0,
      appliedChanges: {
        createProfiles: 2,
        addObservations: 2,
        suppressedProfiles: 0,
        noops: 0,
      },
    });
    await expect(database.select().from(schema.importRuns)).resolves.toEqual([
      expect.objectContaining({
        id: "fixture-import",
        status: "succeeded",
        validRows: 2,
      }),
    ]);
    await expect(
      database
        .select({
          source: schema.professionalLinks.source,
          sourceRecordId: schema.professionalLinks.sourceRecordId,
        })
        .from(schema.professionalLinks)
        .where(
          eq(schema.professionalLinks.url, "https://github.com/ana-example"),
        ),
    ).resolves.toEqual([
      { source: "approved-partner", sourceRecordId: "person-001" },
    ]);
    await expect(database.select().from(schema.employments)).resolves.toEqual([
      expect.objectContaining({
        current: true,
        source: "approved-partner",
        sourceRecordId: "person-001",
        staleAt: null,
      }),
    ]);

    const rerun = await importProfiles(database, csv, { dryRun: false });
    expect(rerun).toMatchObject({
      canonicalMatches: 2,
      appliedChanges: {
        createProfiles: 0,
        addObservations: 0,
        suppressedProfiles: 0,
        noops: 2,
      },
    });
    await expect(
      database.select().from(schema.employments),
    ).resolves.toHaveLength(1);
  });

  it("imports unrelated valid rows while reporting malformed rows and duplicate identities", async () => {
    const csv = `contract_version,source,source_record_id,name,current_company,github_account_id,github_login,qualifying_evidence,adult_confirmed,professional_links
humans-profiles-v1,batch-two,valid-1,Carla Example,,20001,carla-example,owned_repository,true,https://github.com/carla-example
humans-profiles-v1,batch-two,bad-1,Minor Example,,20002,minor-example,owned_repository,false,https://github.com/minor-example
humans-profiles-v1,batch-two,broken-columns
humans-profiles-v1,batch-two,duplicate-1,Carla Duplicate,,20001,carla-renamed,public_contribution,true,https://github.com/carla-renamed`;

    const report = await importProfiles(database, csv, { dryRun: false });

    expect(report.validRows).toBe(2);
    expect(report.invalidRows).toEqual([
      { row: 3, errors: ["adult_confirmed_must_be_true"] },
      { row: 4, errors: ["malformed_csv_row"] },
    ]);
    expect(report.duplicateCandidates).toEqual([
      {
        canonicalProvider: "github",
        canonicalProviderId: "20001",
        row: 5,
        duplicateOfRow: 2,
      },
    ]);
    expect(report.appliedChanges).toMatchObject({
      createProfiles: 1,
      addObservations: 2,
      noops: 0,
    });
  });

  it("resumes from an imported prefix and keeps a suppressed identity unsearchable", async () => {
    await suppressProviderIdentity(database, {
      canonicalProvider: "github",
      canonicalProviderId: "30002",
      reason: "person_requested_removal",
    });
    const header =
      "contract_version,source,source_record_id,name,current_company,github_account_id,github_login,qualifying_evidence,adult_confirmed,professional_links";
    const first =
      "humans-profiles-v1,batch-three,resume-1,Dario Example,,30001,dario-example,owned_repository,true,https://github.com/dario-example";
    const second =
      "humans-profiles-v1,batch-three,resume-2,Elena Example,,30002,elena-example,public_contribution,true,https://github.com/elena-example";

    await importProfiles(database, `${header}\n${first}`, { dryRun: false });
    const resumed = await importProfiles(
      database,
      `${header}\n${first}\n${second}`,
      {
        dryRun: false,
      },
    );

    expect(resumed.canonicalMatches).toBe(1);
    expect(resumed.appliedChanges).toMatchObject({
      createProfiles: 0,
      addObservations: 0,
      suppressedProfiles: 1,
      noops: 2,
    });
    expect(resumed.rows).toEqual([
      expect.objectContaining({ row: 2, outcome: "noop", searchable: true }),
      expect.objectContaining({
        row: 3,
        outcome: "noop",
        searchable: false,
      }),
    ]);
  });

  it("uses the canonical provider constraint during concurrent imports", async () => {
    const csv = `contract_version,source,source_record_id,name,current_company,github_account_id,github_login,qualifying_evidence,adult_confirmed,professional_links
humans-profiles-v1,concurrent-batch,concurrent-1,Fernanda Example,,40001,fernanda-example,owned_repository,true,https://github.com/fernanda-example`;

    const [first, second] = await Promise.all([
      importProfiles(database, csv, { dryRun: false }),
      importProfiles(database, csv, { dryRun: false }),
    ]);

    expect(
      first.appliedChanges.createProfiles +
        second.appliedChanges.createProfiles,
    ).toBe(1);
    expect(
      first.appliedChanges.addObservations +
        second.appliedChanges.addObservations,
    ).toBe(1);
  });

  it("canonicalizes GitHub IDs and rejects invalid numeric aliases", async () => {
    const csv = `contract_version,source,source_record_id,name,current_company,github_account_id,github_login,qualifying_evidence,adult_confirmed,professional_links
humans-profiles-v1,canonical-batch,canonical-1,Canonical One,,00050042,canonical-one,owned_repository,true,https://github.com/canonical-one
humans-profiles-v1,canonical-batch,canonical-2,Canonical Two,,50042,canonical-two,owned_repository,true,https://github.com/canonical-two
humans-profiles-v1,canonical-batch,zero,Zero,,0,zero,owned_repository,true,https://github.com/zero
humans-profiles-v1,canonical-batch,unsafe,Unsafe,,9007199254740992,unsafe,owned_repository,true,https://github.com/unsafe`;

    const report = await importProfiles(database, csv, { dryRun: true });

    expect(report.validRows).toBe(2);
    expect(report.invalidRows).toEqual([
      { row: 4, errors: ["github_account_id_invalid"] },
      { row: 5, errors: ["github_account_id_invalid"] },
    ]);
    expect(report.duplicateCandidates).toEqual([
      {
        canonicalProvider: "github",
        canonicalProviderId: "50042",
        row: 3,
        duplicateOfRow: 2,
      },
    ]);
  });

  it("serializes import and suppression for one canonical identity", async () => {
    const csv = `contract_version,source,source_record_id,name,current_company,github_account_id,github_login,qualifying_evidence,adult_confirmed,professional_links
humans-profiles-v1,race-batch,race-1,Race Person,,00060042,race-person,owned_repository,true,https://github.com/race-person`;

    await Promise.all([
      importProfiles(database, csv, { dryRun: false }),
      suppressProviderIdentity(database, {
        canonicalProvider: "github",
        canonicalProviderId: "60042",
        reason: "person_requested_removal",
      }),
    ]);

    const matchingProfiles = await database
      .select()
      .from(schema.profiles)
      .where(eq(schema.profiles.githubAccountId, "60042"));
    expect(matchingProfiles).toEqual(
      matchingProfiles.length === 0
        ? []
        : [
            expect.objectContaining({
              name: "Suppressed Profile",
              searchable: false,
            }),
          ],
    );
    await expect(
      database
        .select()
        .from(schema.profileObservations)
        .where(eq(schema.profileObservations.sourceRecordId, "race-1")),
    ).resolves.toEqual([]);
    await expect(
      database
        .select()
        .from(schema.suppressionRecords)
        .where(eq(schema.suppressionRecords.canonicalProviderId, "60042")),
    ).resolves.toHaveLength(1);
  });
});
