WITH normalized AS (
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
