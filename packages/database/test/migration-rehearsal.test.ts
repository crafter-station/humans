import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

describe("migration rehearsal", () => {
  const resources: {
    container?: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
    temporaryFolder?: string;
  } = {};

  beforeAll(async () => {
    resources.container = await new PostgreSqlContainer(
      "pgvector/pgvector:pg17",
    ).start();
    resources.temporaryFolder = await mkdtemp(
      join(tmpdir(), "humans-migration-rehearsal-"),
    );
  });

  afterAll(async () => {
    if (resources.temporaryFolder)
      await rm(resources.temporaryFolder, { recursive: true, force: true });
    await resources.container?.stop();
  });

  it("installs from empty and upgrades the previous schema without losing data", async () => {
    const baseUrl = resources.container!.getConnectionUri();
    const admin = new Pool({ connectionString: baseUrl });
    await admin.query('CREATE DATABASE "humans_clean_rehearsal"');
    await admin.query('CREATE DATABASE "humans_upgrade_rehearsal"');
    await admin.end();

    const cleanPool = new Pool({
      connectionString: databaseUrl(baseUrl, "humans_clean_rehearsal"),
    });
    await migrate(drizzle(cleanPool), { migrationsFolder });
    const cleanState = await cleanPool.query<{
      profiles: string;
      vector: string;
    }>(
      "SELECT to_regclass('public.profiles')::text AS profiles, " +
        "(SELECT extname FROM pg_extension WHERE extname = 'vector') AS vector",
    );
    expect(cleanState.rows[0]).toEqual({
      profiles: "profiles",
      vector: "vector",
    });
    await cleanPool.end();

    const previousMigrations = join(resources.temporaryFolder!, "previous");
    await createPreviousMigrationFolder(previousMigrations);
    const upgradePool = new Pool({
      connectionString: databaseUrl(baseUrl, "humans_upgrade_rehearsal"),
    });
    const upgradeDatabase = drizzle(upgradePool);
    await migrate(upgradeDatabase, { migrationsFolder: previousMigrations });
    await upgradePool.query(`
      INSERT INTO organizations (clerk_id, name) VALUES ('org_release', 'Release Organization');
      INSERT INTO profiles (
        profile_id, name, github_account_id, github_login, eligibility_basis,
        adult_attested, searchable, searchability_reason
      ) VALUES (
        'profile_release', 'Release Profile', 'release-github-id',
        'release-profile', 'owned_repository', true, true, 'approved_import'
      );
      INSERT INTO profile_observations (
        id, profile_id, field, value, source, source_record_id,
        pipeline_version, confidence
      ) VALUES (
        'observation_release', 'profile_release', 'skills', '["TypeScript"]',
        'release_fixture', 'release-1', 'release-v1', 1
      );
      INSERT INTO credit_accounts (organization_id, balance)
      VALUES ('org_release', 100);
    `);

    await migrate(upgradeDatabase, { migrationsFolder });
    await migrate(upgradeDatabase, { migrationsFolder });

    const preserved = await upgradePool.query<{
      balance: number;
      name: string;
      stale_at: Date | null;
    }>(`
      SELECT p.name, o.stale_at, c.balance
      FROM profiles p
      JOIN profile_observations o ON o.profile_id = p.profile_id
      JOIN credit_accounts c ON c.organization_id = 'org_release'
      WHERE p.profile_id = 'profile_release'
    `);
    expect(preserved.rows).toEqual([
      { balance: 100, name: "Release Profile", stale_at: null },
    ]);
    await expect(
      upgradePool.query(
        "SELECT terminal_classification FROM enrichment_runs LIMIT 0",
      ),
    ).resolves.toBeDefined();
    await upgradePool.end();
  }, 300_000);
});

const databaseUrl = (baseUrl: string, database: string) => {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
};

const createPreviousMigrationFolder = async (destination: string) => {
  await mkdir(join(destination, "meta"), { recursive: true });
  const journal = JSON.parse(
    await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  const previousEntries = journal.entries.filter(
    ({ tag }) => tag !== "0013_initial",
  );
  if (previousEntries.length !== journal.entries.length - 1)
    throw new Error(
      "Expected 0013_initial to be the only unreleased migration",
    );

  for (const { tag } of previousEntries) {
    await cp(
      join(migrationsFolder, `${tag}.sql`),
      join(destination, `${tag}.sql`),
    );
  }
  await writeFile(
    join(destination, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: previousEntries }),
  );
};
