import { and, desc, eq, isNull, lte, sql } from "drizzle-orm";

import {
  companies,
  companyAliases,
  companyIdentities,
  employments,
  memberStatements,
  profileObservations,
  profiles,
} from "./schema";
import type { DrizzleDatabase, Transaction } from "./service/types";

export type EmploymentWrite = {
  profileId: string;
  companyName: string;
  current: boolean;
  source: string;
  sourceRecordId: string;
  pipelineVersion: string;
  confidence: number;
  collectedAt: Date;
  title?: string;
  startedAt?: string;
  endedAt?: string;
  identity?: { kind: "domain" | "linkedin"; value: string };
};

const normalizedCompanyName = (name: string) =>
  name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();

const normalizedIdentity = (
  identity: NonNullable<EmploymentWrite["identity"]>,
) => {
  const value = identity.value.trim().toLocaleLowerCase();
  if (!value) throw new Error("invalid_company_identity");
  if (identity.kind === "domain") {
    const domain = value.replace(/^https?:\/\//, "").split("/")[0];
    if (!domain) throw new Error("invalid_company_identity");
    return { ...identity, value: domain };
  }
  return { ...identity, value };
};

export const recordEmployment = async (
  transaction: Transaction,
  input: EmploymentWrite,
) => {
  const companyName = input.companyName.trim().replace(/\s+/g, " ");
  if (!companyName || !input.source.trim() || !input.sourceRecordId.trim())
    throw new Error("invalid_employment");
  if (
    !Number.isFinite(input.confidence) ||
    input.confidence < 0 ||
    input.confidence > 1
  )
    throw new Error("invalid_employment");

  const identity = input.identity && normalizedIdentity(input.identity);
  if (identity)
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`company:${identity.kind}:${identity.value}`}))`,
    );

  const [existingEmployment] = await transaction
    .select({
      companyId: employments.companyId,
      companyName: companies.name,
      collectedAt: employments.collectedAt,
    })
    .from(employments)
    .innerJoin(companies, eq(companies.companyId, employments.companyId))
    .where(
      and(
        eq(employments.profileId, input.profileId),
        eq(employments.source, input.source),
        eq(employments.sourceRecordId, input.sourceRecordId),
      ),
    )
    .limit(1);
  if (
    existingEmployment !== undefined &&
    existingEmployment.collectedAt.getTime() > input.collectedAt.getTime()
  )
    return;
  const [identifiedCompany] = identity
    ? await transaction
        .select({ companyId: companyIdentities.companyId })
        .from(companyIdentities)
        .where(
          and(
            eq(companyIdentities.kind, identity.kind),
            eq(companyIdentities.value, identity.value),
          ),
        )
        .limit(1)
    : [];
  let companyId =
    identifiedCompany?.companyId ??
    (identity === undefined &&
    existingEmployment !== undefined &&
    normalizedCompanyName(existingEmployment.companyName) ===
      normalizedCompanyName(companyName)
      ? existingEmployment.companyId
      : undefined);
  if (!companyId) {
    const [created] = await transaction
      .insert(companies)
      .values({
        name: companyName,
        createdAt: input.collectedAt,
        updatedAt: input.collectedAt,
      })
      .returning({ companyId: companies.companyId });
    if (!created) throw new Error("company_not_created");
    companyId = created.companyId;
  } else if (identity) {
    await transaction
      .update(companies)
      .set({ name: companyName, updatedAt: input.collectedAt })
      .where(
        and(
          eq(companies.companyId, companyId),
          sql`${companies.updatedAt} <= ${input.collectedAt}`,
        ),
      );
  }

  await transaction
    .insert(companyAliases)
    .values({
      companyId,
      name: companyName,
      normalizedName: normalizedCompanyName(companyName),
      source: input.source,
      createdAt: input.collectedAt,
    })
    .onConflictDoNothing();
  if (identity)
    await transaction
      .insert(companyIdentities)
      .values({
        ...identity,
        companyId,
        source: input.source,
        sourceRecordId: input.sourceRecordId,
        collectedAt: input.collectedAt,
      })
      .onConflictDoNothing();

  await transaction
    .insert(employments)
    .values({
      profileId: input.profileId,
      companyId,
      title: input.title,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      current: input.current,
      source: input.source,
      sourceRecordId: input.sourceRecordId,
      pipelineVersion: input.pipelineVersion,
      confidence: input.confidence,
      collectedAt: input.collectedAt,
    })
    .onConflictDoUpdate({
      target: [
        employments.profileId,
        employments.source,
        employments.sourceRecordId,
      ],
      set: {
        companyId,
        title: input.title ?? null,
        startedAt: input.startedAt ?? null,
        endedAt: input.endedAt ?? null,
        current: input.current,
        pipelineVersion: input.pipelineVersion,
        confidence: input.confidence,
        collectedAt: input.collectedAt,
        staleAt: null,
      },
      setWhere: sql`${employments.collectedAt} <= excluded.collected_at`,
    });
};

export const staleCurrentEmployment = (
  transaction: Transaction,
  profileId: string,
  source: string,
  staleAt: Date,
) =>
  transaction
    .update(employments)
    .set({ staleAt })
    .where(
      and(
        eq(employments.profileId, profileId),
        eq(employments.source, source),
        eq(employments.current, true),
        isNull(employments.staleAt),
        lte(employments.collectedAt, staleAt),
      ),
    );

export const staleEmploymentsFromSource = (
  transaction: Transaction,
  profileId: string,
  source: string,
  staleAt: Date,
) =>
  transaction
    .update(employments)
    .set({ staleAt })
    .where(
      and(
        eq(employments.profileId, profileId),
        eq(employments.source, source),
        isNull(employments.staleAt),
        lte(employments.collectedAt, staleAt),
      ),
    );

const observedCompany = (field: string, value: unknown) => {
  if (
    (field === "current_company" ||
      field === "currentCompany" ||
      field === "company") &&
    typeof value === "string"
  )
    return { name: value };
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const name =
    field === "linkedin-career"
      ? record.currentCompany
      : field === "github-account"
        ? record.company
        : field === "github-normalization"
          ? (record.current_company ?? record.currentCompany ?? record.company)
          : undefined;
  if (typeof name !== "string") return undefined;
  const identity =
    field === "linkedin-career" && typeof record.currentCompanyId === "string"
      ? { kind: "linkedin" as const, value: record.currentCompanyId }
      : undefined;
  return { name, identity };
};

/** Backfills the structured projection after the schema migration is applied. */
export const backfillCurrentCompanyEmployments = async (
  database: DrizzleDatabase,
) => {
  const candidates = await database
    .select({
      profileId: profiles.profileId,
      memberId: profiles.memberId,
      currentCompany: profiles.currentCompany,
      updatedAt: profiles.updatedAt,
    })
    .from(profiles)
    .where(sql`${profiles.currentCompany} is not null`);
  let created = 0;
  for (const candidate of candidates) {
    if (candidate.currentCompany === null) continue;
    const currentCompany = candidate.currentCompany;
    created += await database.transaction(async (transaction) => {
      const [existing] = await transaction
        .select({ companyName: companies.name })
        .from(employments)
        .innerJoin(companies, eq(companies.companyId, employments.companyId))
        .where(
          and(
            eq(employments.profileId, candidate.profileId),
            eq(employments.current, true),
            isNull(employments.staleAt),
          ),
        )
        .limit(1);
      if (
        existing &&
        normalizedCompanyName(existing.companyName) ===
          normalizedCompanyName(currentCompany)
      )
        return 0;

      const observations = await transaction
        .select()
        .from(profileObservations)
        .where(
          and(
            eq(profileObservations.profileId, candidate.profileId),
            isNull(profileObservations.staleAt),
          ),
        )
        .orderBy(desc(profileObservations.collectedAt));
      const evidence = observations.find((observation) => {
        const company = observedCompany(observation.field, observation.value);
        return (
          company !== undefined &&
          normalizedCompanyName(company.name) ===
            normalizedCompanyName(currentCompany)
        );
      });
      const observed =
        evidence === undefined
          ? undefined
          : observedCompany(evidence.field, evidence.value);
      const [statement] = await transaction
        .select()
        .from(memberStatements)
        .where(
          and(
            eq(memberStatements.profileId, candidate.profileId),
            sql`${memberStatements.field} in ('current_company', 'currentCompany', 'company')`,
          ),
        )
        .orderBy(desc(memberStatements.collectedAt))
        .limit(1);
      const matchingStatement =
        typeof statement?.value === "string" &&
        normalizedCompanyName(statement.value) ===
          normalizedCompanyName(currentCompany)
          ? statement
          : undefined;
      await recordEmployment(transaction, {
        profileId: candidate.profileId,
        companyName: currentCompany,
        current: true,
        source:
          matchingStatement !== undefined
            ? "member"
            : (evidence?.source ?? "legacy-profile-projection"),
        sourceRecordId:
          matchingStatement !== undefined
            ? (candidate.memberId ?? matchingStatement.id)
            : (evidence?.sourceRecordId ?? candidate.profileId),
        pipelineVersion:
          matchingStatement?.pipelineVersion ??
          evidence?.pipelineVersion ??
          "legacy-profile-v1",
        confidence:
          matchingStatement?.confidence ?? evidence?.confidence ?? 0.5,
        collectedAt:
          matchingStatement?.collectedAt ??
          evidence?.collectedAt ??
          candidate.updatedAt,
        ...(matchingStatement !== undefined || observed?.identity === undefined
          ? {}
          : { identity: observed.identity }),
      });
      return 1;
    });
  }
  return created;
};
