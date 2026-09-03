import { and, eq, inArray, or } from "drizzle-orm";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { recordEmployment, staleCurrentEmployment } from "./companies";
import {
  canonicalGitHubAccountId,
  lockGitHubIdentity,
} from "./github-identity";
import { isProfessionalLink } from "./professional-links";
import { suppressGitHubIdentityInTransaction } from "./profile-suppression";
import {
  importRowFailures,
  importRuns,
  operatorAuditEvents,
  professionalLinks,
  profileObservations,
  profiles,
  suppressionRecords,
} from "./schema";

type ImportDatabase =
  | NeonDatabase<typeof import("./schema")>
  | NodePgDatabase<typeof import("./schema")>;

const contractVersion = "humans-profiles-v1";
const contractHeaders = [
  "contract_version",
  "source",
  "source_record_id",
  "name",
  "current_company",
  "github_account_id",
  "github_login",
  "qualifying_evidence",
  "adult_confirmed",
  "professional_links",
] as const;

type ImportRow = {
  row: number;
  source: string;
  sourceRecordId: string;
  name: string;
  currentCompany: string | null;
  githubAccountId: string;
  githubLogin: string;
  qualifyingEvidence: "owned_repository" | "public_contribution";
  professionalLinks: string[];
};

type ChangeCounts = {
  createProfiles: number;
  addObservations: number;
  suppressedProfiles: number;
  noops: number;
};

export type ImportProfilesReport = {
  applied: boolean;
  validRows: number;
  invalidRows: Array<{ row: number; errors: string[] }>;
  canonicalMatches: number;
  duplicateCandidates: Array<{
    canonicalProvider: "github";
    canonicalProviderId: string;
    row: number;
    duplicateOfRow: number;
  }>;
  plannedChanges: ChangeCounts;
  appliedChanges: ChangeCounts;
  rows: Array<{
    row: number;
    outcome: "created" | "observed" | "noop" | "planned";
    searchable: boolean;
  }>;
};

export class ImportContractError extends Error {}

export const importProfiles = async (
  database: ImportDatabase,
  csv: string,
  options: { dryRun: boolean; runId?: string },
): Promise<ImportProfilesReport> => {
  const startedAt = Date.now();
  const parsed = parseContract(csv);
  const identities = [
    ...new Set(parsed.valid.map((row) => row.githubAccountId)),
  ];
  const sourceKeys = parsed.valid.map<[string, string]>((row) => [
    row.source,
    row.sourceRecordId,
  ]);

  const [existingProfiles, existingObservations, suppressions] =
    await Promise.all([
      identities.length === 0
        ? Promise.resolve([])
        : database
            .select({
              githubAccountId: profiles.githubAccountId,
              searchable: profiles.searchable,
            })
            .from(profiles)
            .where(inArray(profiles.githubAccountId, identities)),
      sourceKeys.length === 0
        ? Promise.resolve([])
        : database
            .select({
              source: profileObservations.source,
              sourceRecordId: profileObservations.sourceRecordId,
            })
            .from(profileObservations)
            .where(
              or(
                ...sourceKeys.map(([source, sourceRecordId]) =>
                  and(
                    eq(profileObservations.source, source),
                    eq(profileObservations.sourceRecordId, sourceRecordId),
                  ),
                ),
              ),
            ),
      identities.length === 0
        ? Promise.resolve([])
        : database
            .select({
              canonicalProviderId: suppressionRecords.canonicalProviderId,
            })
            .from(suppressionRecords)
            .where(
              and(
                eq(suppressionRecords.canonicalProvider, "github"),
                inArray(suppressionRecords.canonicalProviderId, identities),
              ),
            ),
    ]);

  const existingIdentityIds = new Set(
    existingProfiles.map(({ githubAccountId }) => githubAccountId),
  );
  const existingSourceKeys = new Set(
    existingObservations.map(
      ({ source, sourceRecordId }) => `${source}\0${sourceRecordId}`,
    ),
  );
  const suppressedIds = new Set(
    suppressions.map(({ canonicalProviderId }) => canonicalProviderId),
  );
  const firstIdentityRows = new Map<string, number>();
  const duplicateCandidates: ImportProfilesReport["duplicateCandidates"] = [];
  for (const row of parsed.valid) {
    const duplicateOfRow = firstIdentityRows.get(row.githubAccountId);
    if (duplicateOfRow === undefined) {
      firstIdentityRows.set(row.githubAccountId, row.row);
    } else {
      duplicateCandidates.push({
        canonicalProvider: "github",
        canonicalProviderId: row.githubAccountId,
        row: row.row,
        duplicateOfRow,
      });
    }
  }

  const plannedChanges = emptyChanges();
  const plannedRows: ImportProfilesReport["rows"] = [];
  const plannedIdentities = new Set(existingIdentityIds);
  const plannedSourceKeys = new Set(existingSourceKeys);
  for (const row of parsed.valid) {
    const sourceKey = `${row.source}\0${row.sourceRecordId}`;
    const suppressed = suppressedIds.has(row.githubAccountId);
    const willCreate =
      !suppressed && !plannedIdentities.has(row.githubAccountId);
    const willObserve = !suppressed && !plannedSourceKeys.has(sourceKey);
    if (willCreate) {
      plannedChanges.createProfiles += 1;
      plannedIdentities.add(row.githubAccountId);
    }
    if (willObserve) {
      plannedChanges.addObservations += 1;
      plannedSourceKeys.add(sourceKey);
    }
    if (suppressed) plannedChanges.suppressedProfiles += 1;
    if (!willCreate && !willObserve) plannedChanges.noops += 1;
    plannedRows.push({
      row: row.row,
      outcome: "planned",
      searchable: !suppressedIds.has(row.githubAccountId),
    });
  }

  const reportBase = {
    validRows: parsed.valid.length,
    invalidRows: parsed.invalid,
    canonicalMatches: parsed.valid.filter((row) =>
      existingIdentityIds.has(row.githubAccountId),
    ).length,
    duplicateCandidates,
    plannedChanges,
  };
  if (options.dryRun) {
    return {
      ...reportBase,
      applied: false,
      appliedChanges: emptyChanges(),
      rows: plannedRows,
    };
  }

  const runId = options.runId ?? crypto.randomUUID();
  await database
    .insert(importRuns)
    .values({
      id: runId,
      contractVersion,
      status: "running",
      validRows: parsed.valid.length,
      invalidRows: parsed.invalid.length,
      duplicateCandidates,
      appliedChanges: emptyChanges(),
    })
    .onConflictDoUpdate({
      target: importRuns.id,
      set: {
        status: "running",
        appliedChanges: emptyChanges(),
        finishedAt: null,
      },
    });
  if (parsed.invalid.length > 0) {
    await database
      .insert(importRowFailures)
      .values(
        parsed.invalid.map((failure) => ({
          importId: runId,
          row: failure.row,
          errors: failure.errors,
        })),
      )
      .onConflictDoNothing();
  }

  const appliedChanges = emptyChanges();
  const rows: ImportProfilesReport["rows"] = [];
  try {
    for (const row of parsed.valid) {
      const result = await applyRow(database, row);
      if (result.created) appliedChanges.createProfiles += 1;
      if (result.observed) appliedChanges.addObservations += 1;
      if (result.suppressed) {
        appliedChanges.suppressedProfiles += 1;
      }
      if (!result.created && !result.observed) appliedChanges.noops += 1;
      rows.push({
        row: row.row,
        outcome: result.created
          ? "created"
          : result.observed
            ? "observed"
            : "noop",
        searchable: result.searchable,
      });
    }
  } catch (error) {
    await database
      .update(importRuns)
      .set({ status: "failed", appliedChanges, finishedAt: new Date() })
      .where(eq(importRuns.id, runId));
    console.error({
      event: "profile_import",
      importId: runId,
      durationMs: Date.now() - startedAt,
      attempts: 1,
      costMetadata: null,
      terminalClassification: "failed",
      validRows: parsed.valid.length,
      invalidRows: parsed.invalid.length,
    });
    throw error;
  }

  await database
    .update(importRuns)
    .set({
      status: "succeeded",
      appliedChanges,
      finishedAt: new Date(),
    })
    .where(eq(importRuns.id, runId));
  console.info({
    event: "profile_import",
    importId: runId,
    durationMs: Date.now() - startedAt,
    attempts: 1,
    costMetadata: null,
    terminalClassification: "succeeded",
    validRows: parsed.valid.length,
    invalidRows: parsed.invalid.length,
  });
  return { ...reportBase, applied: true, appliedChanges, rows };
};

export const suppressProviderIdentity = async (
  database: ImportDatabase,
  suppression: {
    canonicalProvider: "github";
    canonicalProviderId: string;
    reason: string;
  },
  operator?: {
    operatorId: string;
    correlationId: string;
  },
) => {
  const canonicalProviderId = canonicalGitHubAccountId(
    suppression.canonicalProviderId,
  );
  if (canonicalProviderId === null)
    throw new ImportContractError("Invalid GitHub account ID");
  await database.transaction(async (tx) => {
    await suppressGitHubIdentityInTransaction(tx, {
      githubAccountId: canonicalProviderId,
      reason: suppression.reason,
      purge: true,
    });
    if (operator)
      await tx.insert(operatorAuditEvents).values({
        ...operator,
        reason: suppression.reason,
        action: "profile.suppress",
        subjectType: "github_account",
        subjectId: canonicalProviderId,
      });
  });
};

const applyRow = (database: ImportDatabase, row: ImportRow) =>
  database.transaction(async (transaction) => {
    await lockGitHubIdentity(transaction, row.githubAccountId);
    const [suppression] = await transaction
      .select()
      .from(suppressionRecords)
      .where(
        and(
          eq(suppressionRecords.canonicalProvider, "github"),
          eq(suppressionRecords.canonicalProviderId, row.githubAccountId),
        ),
      )
      .limit(1);
    if (suppression !== undefined) {
      return {
        created: false,
        observed: false,
        searchable: false,
        suppressed: true,
      };
    }
    const searchable = suppression === undefined;
    const [created] = await transaction
      .insert(profiles)
      .values({
        name: row.name,
        currentCompany: row.currentCompany,
        githubAccountId: row.githubAccountId,
        githubLogin: row.githubLogin,
        eligibilityBasis: row.qualifyingEvidence,
        adultAttested: true,
        searchable,
        searchabilityReason: searchable
          ? "approved_import"
          : "operator_suppression",
      })
      .onConflictDoNothing()
      .returning({ profileId: profiles.profileId });
    const [profile] = await transaction
      .select({
        profileId: profiles.profileId,
        searchable: profiles.searchable,
        searchabilityReason: profiles.searchabilityReason,
      })
      .from(profiles)
      .where(eq(profiles.githubAccountId, row.githubAccountId))
      .limit(1);
    if (profile === undefined) throw new Error("canonical_profile_not_found");
    if (profile.searchabilityReason === "operator_suppression") {
      return {
        created: false,
        observed: false,
        searchable: false,
        suppressed: true,
      };
    }

    if (created !== undefined && row.professionalLinks.length > 0) {
      await transaction.insert(professionalLinks).values(
        row.professionalLinks.map((url) => ({
          profileId: profile.profileId,
          url,
          source: row.source,
          sourceRecordId: row.sourceRecordId,
        })),
      );
    }
    const observations = await transaction
      .insert(profileObservations)
      .values(
        importedObservations(row).map(({ field, value }) => ({
          profileId: profile.profileId,
          field,
          value,
          source: row.source,
          sourceRecordId: row.sourceRecordId,
          pipelineVersion: contractVersion,
          confidence: 1,
        })),
      )
      .onConflictDoNothing()
      .returning({ field: profileObservations.field });
    if (observations.some(({ field }) => field === "current_company")) {
      const collectedAt = new Date();
      await staleCurrentEmployment(
        transaction,
        profile.profileId,
        row.source,
        collectedAt,
      );
      if (row.currentCompany !== null)
        await recordEmployment(transaction, {
          profileId: profile.profileId,
          companyName: row.currentCompany,
          current: true,
          source: row.source,
          sourceRecordId: row.sourceRecordId,
          pipelineVersion: contractVersion,
          confidence: 1,
          collectedAt,
        });
    }
    return {
      created: created !== undefined,
      observed: observations.length > 0,
      searchable: profile.searchable,
      suppressed: false,
    };
  });

const parseContract = (csv: string) => {
  const lines = csv.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  while (lines.at(-1)?.trim() === "") lines.pop();
  const header = lines[0];
  if (header === undefined) throw new ImportContractError("CSV is empty");
  const parsedHeader = parseCsvLine(header);
  if (
    parsedHeader.error !== null ||
    parsedHeader.values.length !== contractHeaders.length ||
    parsedHeader.values.some((value, index) => value !== contractHeaders[index])
  ) {
    throw new ImportContractError(
      `Expected headers: ${contractHeaders.join(",")}`,
    );
  }

  const valid: ImportRow[] = [];
  const invalid: Array<{ row: number; errors: string[] }> = [];
  const sourceRecords = new Set<string>();
  for (const [lineIndex, line] of lines.slice(1).entries()) {
    const rowNumber = lineIndex + 2;
    const parsed = parseCsvLine(line);
    if (
      parsed.error !== null ||
      parsed.values.length !== contractHeaders.length
    ) {
      invalid.push({ row: rowNumber, errors: ["malformed_csv_row"] });
      continue;
    }
    const [
      version,
      source,
      sourceRecordId,
      name,
      currentCompany,
      githubAccountId,
      githubLogin,
      qualifyingEvidence,
      adultConfirmed,
      linksValue,
    ] = parsed.values as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const errors: string[] = [];
    if (version !== contractVersion)
      errors.push("unsupported_contract_version");
    if (source.trim() === "") errors.push("source_required");
    if (sourceRecordId.trim() === "") errors.push("source_record_id_required");
    if (name.trim() === "") errors.push("name_required");
    const canonicalAccountId = canonicalGitHubAccountId(githubAccountId);
    if (canonicalAccountId === null) errors.push("github_account_id_invalid");
    if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(githubLogin)) {
      errors.push("github_login_invalid");
    }
    if (
      qualifyingEvidence !== "owned_repository" &&
      qualifyingEvidence !== "public_contribution"
    ) {
      errors.push("qualifying_evidence_invalid");
    }
    if (adultConfirmed !== "true") errors.push("adult_confirmed_must_be_true");
    const professionalLinks = linksValue
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean);
    if (
      professionalLinks.length === 0 ||
      professionalLinks.some((value) => !isProfessionalLink(value))
    ) {
      errors.push("professional_links_invalid");
    }
    if (errors.length > 0) {
      invalid.push({ row: rowNumber, errors });
      continue;
    }
    if (canonicalAccountId === null)
      throw new ImportContractError("Invalid canonical GitHub account ID");
    const sourceKey = `${source}\0${sourceRecordId}`;
    if (sourceRecords.has(sourceKey)) {
      invalid.push({ row: rowNumber, errors: ["duplicate_source_record"] });
      continue;
    }
    sourceRecords.add(sourceKey);
    valid.push({
      row: rowNumber,
      source,
      sourceRecordId,
      name,
      currentCompany: currentCompany || null,
      githubAccountId: canonicalAccountId,
      githubLogin,
      qualifyingEvidence: qualifyingEvidence as ImportRow["qualifyingEvidence"],
      professionalLinks,
    });
  }
  return { valid, invalid };
};

const importedObservations = (row: ImportRow) => {
  const observations: Array<{ field: string; value: string | string[] }> = [
    { field: "name", value: row.name },
    { field: "github_login", value: row.githubLogin },
    { field: "qualifying_evidence", value: row.qualifyingEvidence },
    { field: "professional_links", value: row.professionalLinks },
  ];
  if (row.currentCompany !== null) {
    observations.push({ field: "current_company", value: row.currentCompany });
  }
  return observations;
};

const parseCsvLine = (line: string) => {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line.charAt(index);
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (quoted || value === "") {
        quoted = !quoted;
      } else {
        return { values, error: "unexpected_quote" };
      }
    } else if (character === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value);
  return { values, error: quoted ? "unclosed_quote" : null };
};

const emptyChanges = (): ChangeCounts => ({
  createProfiles: 0,
  addObservations: 0,
  suppressedProfiles: 0,
  noops: 0,
});
