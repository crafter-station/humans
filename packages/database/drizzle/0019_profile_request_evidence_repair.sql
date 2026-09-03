UPDATE profile_requests
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
