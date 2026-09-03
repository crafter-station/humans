import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { backfillCurrentCompanyEmployments } from "../src/companies";
import * as schema from "../src/schema";

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
    const container = resources.container;
    const temporaryFolder = resources.temporaryFolder;
    if (!container || !temporaryFolder)
      throw new Error("Migration rehearsal resources are unavailable");
    const baseUrl = container.getConnectionUri();
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

    const previousMigrations = join(temporaryFolder, "previous");
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
      ) VALUES
        (
          'profile_release', 'Release Profile', '70001',
          'release-profile', 'owned_repository', true, false, 'disputed'
        ),
        (
          'profile_alias', 'Alias Profile', '00070004',
          'alias-profile', 'owned_repository', true, true, 'approved_import'
        ),
        (
          'profile_duplicate_alias', 'Duplicate Alias', '00070005',
          'duplicate-alias', 'owned_repository', true, true, 'approved_import'
        ),
        (
          'profile_duplicate_canonical', 'Duplicate Canonical', '70005',
          'duplicate-canonical', 'owned_repository', true, true, 'approved_import'
        ),
        (
          'profile_invalid', 'Invalid Legacy Profile', 'legacy-github-id',
          'invalid-legacy', 'owned_repository', true, true, 'approved_import'
        );
      INSERT INTO suppression_records (
        canonical_provider, canonical_provider_id, reason
      ) VALUES
        ('github', '00070006', 'legacy_alias'),
        ('github', 'legacy-suppression-id', 'legacy_invalid');
      INSERT INTO profile_requests (
        id, profile_id, kind, requester_email, details, previous_searchable,
        previous_searchability_reason, status, created_at
      ) VALUES
        (
          'request_release_old', 'profile_release', 'correction',
          'old@example.com', 'Old active request', true, 'approved_import', 'pending',
          '2026-08-01T00:00:00Z'
        ),
        (
          'request_release_duplicate', 'profile_release', 'removal',
          'duplicate@example.com', 'Duplicate active request', false, 'disputed', 'pending',
          '2026-08-02T00:00:00Z'
        ),
        (
          'request_invalid_profile', 'profile_invalid', 'correction',
          'invalid@example.com', 'Request against quarantined legacy data',
          false, 'operator_suppression', 'pending', '2026-08-03T00:00:00Z'
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
      UPDATE profiles SET current_company = 'Release Company'
      WHERE profile_id = 'profile_release';
      INSERT INTO profile_observations (
        id, profile_id, field, value, source, source_record_id,
        pipeline_version, confidence
      ) VALUES (
        'observation_company_release', 'profile_release', 'current_company',
        '"Release Company"', 'release_fixture', 'release-company-1',
        'release-v1', 1
      );
    `);

    await migrate(upgradeDatabase, { migrationsFolder });
    await migrate(upgradeDatabase, { migrationsFolder });
    const structuredUpgradeDatabase = drizzle(upgradePool, { schema });
    await expect(
      backfillCurrentCompanyEmployments(structuredUpgradeDatabase),
    ).resolves.toBe(1);
    await expect(
      backfillCurrentCompanyEmployments(structuredUpgradeDatabase),
    ).resolves.toBe(0);

    const employment = await upgradePool.query<{
      name: string;
      source: string;
      source_record_id: string;
    }>(`
      SELECT c.name, e.source, e.source_record_id
      FROM employments e
      JOIN companies c ON c.company_id = e.company_id
      WHERE e.profile_id = 'profile_release' AND e.current = true
    `);
    expect(employment.rows).toEqual([
      {
        name: "Release Company",
        source: "release_fixture",
        source_record_id: "release-company-1",
      },
    ]);

    const preserved = await upgradePool.query<{
      balance: number;
      name: string;
      searchable: boolean;
      searchability_reason: string;
      stale_at: Date | null;
    }>(`
      SELECT
        p.name,
        p.searchable,
        p.searchability_reason,
        o.stale_at,
        c.balance
      FROM profiles p
      JOIN profile_observations o ON o.profile_id = p.profile_id
      JOIN credit_accounts c ON c.organization_id = 'org_release'
      WHERE p.profile_id = 'profile_release'
        AND o.id = 'observation_release'
    `);
    expect(preserved.rows).toEqual([
      {
        balance: 100,
        name: "Release Profile",
        searchable: true,
        searchability_reason: "approved_import",
        stale_at: null,
      },
    ]);
    const repairedProfiles = await upgradePool.query<{
      github_account_id: string;
      profile_id: string;
      searchable: boolean;
      searchability_reason: string;
    }>(`
      SELECT profile_id, github_account_id, searchable, searchability_reason
      FROM profiles
      WHERE profile_id IN (
        'profile_alias',
        'profile_duplicate_alias',
        'profile_duplicate_canonical',
        'profile_invalid'
      )
      ORDER BY profile_id
    `);
    expect(repairedProfiles.rows).toEqual([
      {
        profile_id: "profile_alias",
        github_account_id: "70004",
        searchable: true,
        searchability_reason: "approved_import",
      },
      {
        profile_id: "profile_duplicate_alias",
        github_account_id: "00070005",
        searchable: false,
        searchability_reason: "operator_suppression",
      },
      {
        profile_id: "profile_duplicate_canonical",
        github_account_id: "70005",
        searchable: false,
        searchability_reason: "operator_suppression",
      },
      {
        profile_id: "profile_invalid",
        github_account_id: "legacy-github-id",
        searchable: false,
        searchability_reason: "operator_suppression",
      },
    ]);
    const repairedSuppressions = await upgradePool.query<{
      canonical_provider: string;
      canonical_provider_id: string;
    }>(`
      SELECT canonical_provider, canonical_provider_id
      FROM suppression_records
      WHERE canonical_provider_id IN (
        '70005', '70006', 'legacy-github-id', 'legacy-suppression-id'
      )
      ORDER BY canonical_provider_id
    `);
    expect(repairedSuppressions.rows).toEqual([
      { canonical_provider: "github", canonical_provider_id: "70005" },
      { canonical_provider: "github", canonical_provider_id: "70006" },
      {
        canonical_provider: "legacy-github",
        canonical_provider_id: "legacy-github-id",
      },
      {
        canonical_provider: "legacy-github",
        canonical_provider_id: "legacy-suppression-id",
      },
    ]);
    const repairedRequests = await upgradePool.query<{
      id: string;
      status: string;
    }>(`
      SELECT id, status
      FROM profile_requests
      WHERE profile_id = 'profile_release'
      ORDER BY created_at
    `);
    expect(repairedRequests.rows).toEqual([
      { id: "request_release_old", status: "awaiting_verification" },
      { id: "request_release_duplicate", status: "superseded" },
    ]);
    await expect(
      upgradePool.query(`
        SELECT status
        FROM profile_requests
        WHERE id = 'request_invalid_profile'
      `),
    ).resolves.toMatchObject({
      rows: [{ status: "awaiting_verification" }],
    });
    await expect(
      upgradePool.query(`
        INSERT INTO profile_requests (
          id, profile_id, kind, requester_email, details, status
        ) VALUES (
          'request_release_awaiting', 'profile_release', 'correction',
          'awaiting@example.com', 'Another unverified request',
          'awaiting_verification'
        )
      `),
    ).resolves.toBeDefined();
    await expect(
      upgradePool.query(`
        INSERT INTO profile_requests (
          id, profile_id, kind, requester_email, details, status,
          verification_method, verification_evidence_reference, verified_at
        ) VALUES (
          'request_release_verified', 'profile_release', 'correction',
          'verified@example.com', 'Verified review request', 'pending',
          'email_challenge', 'evidence://verified', now()
        )
      `),
    ).resolves.toBeDefined();
    await expect(
      upgradePool.query(`
        INSERT INTO profile_requests (
          id, profile_id, kind, requester_email, details, status,
          verification_method, verification_evidence_reference, verified_at
        ) VALUES (
          'request_release_conflict', 'profile_release', 'correction',
          'conflict@example.com', 'Conflicting verified review', 'pending',
          'email_challenge', 'evidence://conflict', now()
        )
      `),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      upgradePool.query(`
        INSERT INTO profile_requests (
          id, profile_id, kind, requester_email, details, status
        ) VALUES (
          'request_missing_evidence', 'profile_alias', 'correction',
          'missing@example.com', 'Missing verification evidence', 'pending'
        )
      `),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      upgradePool.query(`
        INSERT INTO profiles (
          profile_id, name, github_account_id, github_login, eligibility_basis,
          adult_attested, searchable, searchability_reason
        ) VALUES (
          'profile_new_invalid', 'New Invalid Profile', 'not-an-id',
          'new-invalid', 'owned_repository', true, true, 'approved_import'
        )
      `),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      upgradePool.query(`
        INSERT INTO professional_links (
          profile_id, url, source, verified_provider
        ) VALUES (
          'profile_alias', 'https://github.com/alias-profile',
          'member', 'github'
        )
      `),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      upgradePool.query(
        "SELECT terminal_classification, completed_stages, error, observations_persisted_at FROM enrichment_runs LIMIT 0",
      ),
    ).resolves.toBeDefined();
    await expect(
      upgradePool.query(
        "SELECT to_regclass('public.enrichment_checkpoints'), to_regclass('public.enrichment_dispatches'), github_inaccessible_since FROM profiles LIMIT 0",
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
  const deployedIndex = journal.entries.findIndex(
    ({ tag }) => tag === "0016_initial",
  );
  if (
    deployedIndex === -1 ||
    journal.entries[deployedIndex + 1]?.tag !== "0017_profile_control_repair"
  )
    throw new Error(
      "Expected 0016_initial to be the deployed migration boundary",
    );
  const previousEntries = journal.entries.slice(0, deployedIndex + 1);

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
