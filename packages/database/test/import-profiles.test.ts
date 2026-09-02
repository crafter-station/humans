import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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

    const imported = await importProfiles(database, csv, { dryRun: false });
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
});
