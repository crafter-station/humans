import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDirectory = join(packageDirectory, "drizzle");

const generatedMigrationBodies = {
  profile_control_repair: `WITH normalized AS (
  SELECT
    profile_id,
    github_account_id,
    CASE
      WHEN github_account_id ~ '^[0-9]+$'
      THEN CASE
        WHEN github_account_id::numeric BETWEEN 1 AND 9007199254740991
        THEN github_account_id::numeric::text
      END
    END AS canonical_id
  FROM profiles
), classified AS (
  SELECT
    *,
    count(*) OVER (PARTITION BY canonical_id) AS identity_count
  FROM normalized
)
UPDATE profiles AS profile
SET
  searchable = false,
  searchability_reason = 'operator_suppression',
  updated_at = now()
FROM classified
WHERE profile.profile_id = classified.profile_id
  AND (classified.canonical_id IS NULL OR classified.identity_count > 1);
--> statement-breakpoint
WITH normalized AS (
  SELECT
    github_account_id,
    github_account_id::numeric::text AS canonical_id
  FROM profiles
  WHERE CASE
    WHEN github_account_id ~ '^[0-9]+$'
    THEN github_account_id::numeric BETWEEN 1 AND 9007199254740991
    ELSE false
  END
), duplicates AS (
  SELECT canonical_id
  FROM normalized
  GROUP BY canonical_id
  HAVING count(*) > 1
)
INSERT INTO suppression_records (
  canonical_provider,
  canonical_provider_id,
  reason
)
SELECT 'github', canonical_id, 'legacy_duplicate_github_identity'
FROM duplicates
ON CONFLICT (canonical_provider, canonical_provider_id) DO NOTHING;
--> statement-breakpoint
WITH normalized AS (
  SELECT
    profile_id,
    github_account_id,
    github_account_id::numeric::text AS canonical_id,
    count(*) OVER (
      PARTITION BY github_account_id::numeric::text
    ) AS identity_count
  FROM profiles
  WHERE CASE
    WHEN github_account_id ~ '^[0-9]+$'
    THEN github_account_id::numeric BETWEEN 1 AND 9007199254740991
    ELSE false
  END
)
UPDATE profiles AS profile
SET github_account_id = normalized.canonical_id
FROM normalized
WHERE profile.profile_id = normalized.profile_id
  AND normalized.identity_count = 1
  AND normalized.github_account_id <> normalized.canonical_id;
--> statement-breakpoint
INSERT INTO suppression_records (
  canonical_provider,
  canonical_provider_id,
  reason,
  created_at
)
SELECT
  'legacy-github',
  canonical_provider_id,
  reason,
  created_at
FROM suppression_records
WHERE canonical_provider = 'github'
  AND NOT CASE
    WHEN canonical_provider_id ~ '^[0-9]+$'
    THEN canonical_provider_id::numeric BETWEEN 1 AND 9007199254740991
    ELSE false
  END
ON CONFLICT (canonical_provider, canonical_provider_id) DO NOTHING;
--> statement-breakpoint
DELETE FROM suppression_records
WHERE canonical_provider = 'github'
  AND NOT CASE
    WHEN canonical_provider_id ~ '^[0-9]+$'
    THEN canonical_provider_id::numeric BETWEEN 1 AND 9007199254740991
    ELSE false
  END;
--> statement-breakpoint
WITH aliases AS (
  SELECT DISTINCT ON (canonical_provider_id::numeric::text)
    canonical_provider_id,
    canonical_provider_id::numeric::text AS canonical_id,
    reason,
    created_at
  FROM suppression_records
  WHERE canonical_provider = 'github'
    AND CASE
      WHEN canonical_provider_id ~ '^[0-9]+$'
      THEN canonical_provider_id::numeric BETWEEN 1 AND 9007199254740991
      ELSE false
    END
    AND canonical_provider_id <> canonical_provider_id::numeric::text
  ORDER BY canonical_provider_id::numeric::text, created_at, canonical_provider_id
)
INSERT INTO suppression_records (
  canonical_provider,
  canonical_provider_id,
  reason,
  created_at
)
SELECT 'github', canonical_id, reason, created_at
FROM aliases
ON CONFLICT (canonical_provider, canonical_provider_id) DO NOTHING;
--> statement-breakpoint
DELETE FROM suppression_records
WHERE canonical_provider = 'github'
  AND CASE
    WHEN canonical_provider_id ~ '^[0-9]+$'
    THEN canonical_provider_id::numeric BETWEEN 1 AND 9007199254740991
    ELSE false
  END
  AND canonical_provider_id <> canonical_provider_id::numeric::text;
--> statement-breakpoint
INSERT INTO suppression_records (
  canonical_provider,
  canonical_provider_id,
  reason
)
SELECT 'legacy-github', github_account_id, 'legacy_invalid_github_identity'
FROM profiles
WHERE NOT CASE
  WHEN github_account_id ~ '^[1-9][0-9]*$'
  THEN github_account_id::numeric <= 9007199254740991
  ELSE false
END
ON CONFLICT (canonical_provider, canonical_provider_id) DO NOTHING;
--> statement-breakpoint
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY profile_id
      ORDER BY created_at, id
    ) AS position
  FROM profile_requests
  WHERE status IN ('awaiting_verification', 'pending')
)
UPDATE profile_requests AS request
SET
  status = 'superseded',
  reviewed_at = coalesce(request.reviewed_at, now())
FROM ranked
WHERE request.id = ranked.id
  AND ranked.position > 1;
`,
  profile_request_evidence_repair: `UPDATE profile_requests
SET status = 'awaiting_verification'
WHERE status = 'pending'
  AND (
    verification_method IS NULL
    OR btrim(verification_method) = ''
    OR verification_evidence_reference IS NULL
    OR btrim(verification_evidence_reference) = ''
    OR verified_at IS NULL
  );
--> statement-breakpoint
WITH restorable AS (
  SELECT DISTINCT ON (request.profile_id)
    request.profile_id,
    request.previous_searchable,
    request.previous_searchability_reason
  FROM profile_requests AS request
  WHERE request.status = 'awaiting_verification'
    AND (
      request.verification_method IS NULL
      OR btrim(request.verification_method) = ''
      OR request.verification_evidence_reference IS NULL
      OR btrim(request.verification_evidence_reference) = ''
      OR request.verified_at IS NULL
    )
  ORDER BY request.profile_id, request.created_at, request.id
)
UPDATE profiles AS profile
SET
  searchable = restorable.previous_searchable,
  searchability_reason = restorable.previous_searchability_reason,
  updated_at = now()
FROM restorable
WHERE profile.profile_id = restorable.profile_id
  AND profile.searchability_reason = 'disputed'
  AND NOT EXISTS (
    SELECT 1
    FROM suppression_records AS suppression
    WHERE suppression.canonical_provider = 'github'
      AND suppression.canonical_provider_id = profile.github_account_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM profile_requests AS request
    WHERE request.profile_id = profile.profile_id
      AND request.status = 'pending'
      AND request.verification_method IS NOT NULL
      AND btrim(request.verification_method) <> ''
      AND request.verification_evidence_reference IS NOT NULL
      AND btrim(request.verification_evidence_reference) <> ''
      AND request.verified_at IS NOT NULL
  );
--> statement-breakpoint
UPDATE profiles AS profile
SET
  searchable = false,
  searchability_reason = 'disputed',
  updated_at = now()
WHERE profile.searchability_reason <> 'operator_suppression'
  AND NOT EXISTS (
    SELECT 1
    FROM suppression_records AS suppression
    WHERE suppression.canonical_provider = 'github'
      AND suppression.canonical_provider_id = profile.github_account_id
  )
  AND EXISTS (
    SELECT 1
    FROM profile_requests AS request
    WHERE request.profile_id = profile.profile_id
      AND request.status = 'pending'
      AND request.verification_method IS NOT NULL
      AND btrim(request.verification_method) <> ''
      AND request.verification_evidence_reference IS NOT NULL
      AND btrim(request.verification_evidence_reference) <> ''
      AND request.verified_at IS NOT NULL
  );
`,
};

const generatedMigrationOrder = [
  "0017_profile_control_repair",
  "0018_initial",
  "0019_profile_request_evidence_repair",
  "0020_initial",
  "0021_initial",
];

const runDrizzleKit = (...arguments_) => {
  const result = spawnSync("bun", ["x", "drizzle-kit", ...arguments_], {
    cwd: packageDirectory,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

const generateDeclaredMigration = (name, expectedBody) => {
  const matches = readdirSync(migrationsDirectory).filter((file) =>
    file.endsWith(`_${name}.sql`),
  );
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one generated ${name} migration`);
  }
  writeFileSync(join(migrationsDirectory, matches[0]), expectedBody);
  if (
    readFileSync(join(migrationsDirectory, matches[0]), "utf8") !== expectedBody
  ) {
    throw new Error(
      `${matches[0]} differs from its declaration in generate-migrations.mjs`,
    );
  }
};

const verifyGeneratedMigrationOrder = () => {
  const journal = JSON.parse(
    readFileSync(join(migrationsDirectory, "meta", "_journal.json"), "utf8"),
  );
  const tags = journal.entries?.map(({ tag }) => tag);
  const positions = generatedMigrationOrder.map((tag) => tags?.indexOf(tag));
  if (positions.some((position, index) => position !== positions[0] + index)) {
    throw new Error(
      `Generated migration order must remain ${generatedMigrationOrder.join(" -> ")}`,
    );
  }
};

const generateDeclaredRepairs = () => {
  for (const [name, body] of Object.entries(generatedMigrationBodies)) {
    generateDeclaredMigration(name, body);
  }
  verifyGeneratedMigrationOrder();
};

// Drizzle has no schema primitive for extensions, so generate its custom
// migration from this declaration instead of editing migration SQL by hand.
const hasMigrationJournal = existsSync(
  join(migrationsDirectory, "meta", "_journal.json"),
);
const hasLegacyProfileSchemaHistory =
  hasMigrationJournal &&
  JSON.parse(
    readFileSync(join(migrationsDirectory, "meta", "_journal.json"), "utf8"),
  ).entries?.some(({ tag }) => tag === "0013_initial");
if (!hasMigrationJournal) {
  runDrizzleKit("generate", "--custom", "--name=extensions");

  const [extensionMigration] = readdirSync(migrationsDirectory).filter((file) =>
    file.endsWith("_extensions.sql"),
  );

  if (extensionMigration === undefined) {
    throw new Error("Drizzle Kit did not generate the extension migration");
  }

  const extensions = ["vector"];
  writeFileSync(
    join(migrationsDirectory, extensionMigration),
    `${extensions
      .map((extension) => `CREATE EXTENSION IF NOT EXISTS "${extension}";`)
      .join("\n")}\n`,
  );
} else if (hasLegacyProfileSchemaHistory) {
  generateDeclaredRepairs();
}

runDrizzleKit("generate", "--name=initial");

if (hasLegacyProfileSchemaHistory) generateDeclaredRepairs();
