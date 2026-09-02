import { and, desc, eq, inArray, notExists } from "drizzle-orm";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  memberStatements,
  profileObservations,
  professionalLinks,
  profiles,
  suppressionRecords,
} from "./schema";

type SearchDatabase =
  | NeonDatabase<typeof import("./schema")>
  | NodePgDatabase<typeof import("./schema")>;

export type OpportunityStatus = "open" | "not_open" | "unspecified";

export type ProfileSearchFilters = {
  query?: string;
  roles?: string[];
  skills?: string[];
  currentResidences?: string[];
  companies?: string[];
  seniorities?: string[];
  minimumExperience?: number;
  opportunityStatuses?: OpportunityStatus[];
};

export type ProfileSearchResult = {
  profileId: string;
  name: string;
  headline: string | null;
  currentResidence: string | null;
  primaryRole: string | null;
  skills: string[];
  currentCompany: string | null;
  seniority: string | null;
  experienceYears: number | null;
  opportunityStatus: OpportunityStatus;
  freshness: string;
  evidence: "member" | "strong" | "supported";
};

export type ProfileSearchPage = {
  results: ProfileSearchResult[];
  nextCursor: string | null;
};

export class InvalidSearchCursor extends Error {}

type SearchDocument = ProfileSearchResult & {
  links: string[];
  rank: number;
  evidenceRank: number;
  opportunityRank: number;
  memberFields: Set<string>;
  confidenceByField: Map<string, number>;
};

type Cursor = {
  version: 1;
  expiresAt: number;
  filters: string;
  depth: number;
  rank: number;
  evidenceRank: number;
  opportunityRank: number;
  freshness: string;
  name: string;
  profileId: string;
};

const cursorLifetimeMs = 15 * 60 * 1000;
const maximumCursorDepth = 10;

export const searchProfiles = async (
  database: SearchDatabase,
  filters: ProfileSearchFilters,
  options: {
    cursor?: string;
    pageSize?: number;
    now?: Date;
    cursorSecret?: string;
  } = {},
): Promise<ProfileSearchPage> => {
  const normalized = normalizeFilters(filters);
  const pageSize = Math.max(1, Math.min(100, options.pageSize ?? 25));
  const now = options.now ?? new Date();
  const cursor = options.cursor
    ? await decodeCursor(
        options.cursor,
        normalized,
        now,
        options.cursorSecret ?? "local-search-cursor",
      )
    : null;
  const documents = (await loadDocuments(database, undefined, now))
    .filter((profile) => matches(profile, normalized))
    .map((profile) => rank(profile, normalized))
    .sort(compareDocuments);
  const remaining =
    cursor === null
      ? documents
      : documents.filter((document) => isAfterCursor(document, cursor));
  const page = remaining.slice(0, pageSize);
  const last = page.at(-1);

  return {
    results: page.map(toSearchResult),
    nextCursor:
      remaining.length > pageSize && last !== undefined
        ? await encodeCursor(
            {
              version: 1,
              expiresAt: now.getTime() + cursorLifetimeMs,
              filters: JSON.stringify(normalized),
              depth: (cursor?.depth ?? 0) + 1,
              rank: last.rank,
              evidenceRank: last.evidenceRank,
              opportunityRank: last.opportunityRank,
              freshness: last.freshness,
              name: last.name,
              profileId: last.profileId,
            },
            options.cursorSecret ?? "local-search-cursor",
          )
        : null,
  };
};

export const getSearchableProfile = async (
  database: SearchDatabase,
  profileId: string,
) => {
  const document = (await loadDocuments(database, profileId, new Date()))[0];
  if (document === undefined) return null;
  return { ...toSearchResult(document), links: document.links };
};

const toSearchResult = (document: SearchDocument): ProfileSearchResult => ({
  profileId: document.profileId,
  name: document.name,
  headline: document.headline,
  currentResidence: document.currentResidence,
  primaryRole: document.primaryRole,
  skills: document.skills,
  currentCompany: document.currentCompany,
  seniority: document.seniority,
  experienceYears: document.experienceYears,
  opportunityStatus: document.opportunityStatus,
  freshness: document.freshness,
  evidence: document.evidence,
});

const loadDocuments = async (
  database: SearchDatabase,
  profileId: string | undefined,
  now: Date,
) => {
  const rows = await database
    .select()
    .from(profiles)
    .where(
      and(
        eq(profiles.searchable, true),
        profileId === undefined ? undefined : eq(profiles.profileId, profileId),
        notExists(
          database
            .select({ id: suppressionRecords.canonicalProviderId })
            .from(suppressionRecords)
            .where(
              and(
                eq(suppressionRecords.canonicalProvider, "github"),
                eq(
                  suppressionRecords.canonicalProviderId,
                  profiles.githubAccountId,
                ),
              ),
            ),
        ),
      ),
    );
  if (rows.length === 0) return [];
  const profileIds = rows.map(({ profileId: id }) => id);
  const [statements, observations, links] = await Promise.all([
    database
      .select()
      .from(memberStatements)
      .where(inArray(memberStatements.profileId, profileIds))
      .orderBy(desc(memberStatements.collectedAt)),
    database
      .select()
      .from(profileObservations)
      .where(inArray(profileObservations.profileId, profileIds))
      .orderBy(desc(profileObservations.collectedAt)),
    database
      .select()
      .from(professionalLinks)
      .where(inArray(professionalLinks.profileId, profileIds)),
  ]);

  return rows.map((profile): SearchDocument => {
    const ownStatements = statements.filter(
      (statement) => statement.profileId === profile.profileId,
    );
    const ownObservations = observations.filter(
      (observation) =>
        observation.profileId === profile.profileId &&
        (!observation.source.startsWith("github") ||
          now.getTime() - observation.collectedAt.getTime() <=
            30 * 24 * 60 * 60 * 1000),
    );
    const { values, confidenceByField, memberFields } = effectiveValues(
      ownStatements,
      ownObservations,
    );
    const freshness = [
      profile.updatedAt,
      ...ownStatements.map(({ collectedAt }) => collectedAt),
      ...ownObservations.map(({ collectedAt }) => collectedAt),
    ]
      .sort((left, right) => right.getTime() - left.getTime())[0]!
      .toISOString();
    const hasMemberEvidence = ownStatements.length > 0;
    const strongestConfidence = Math.max(
      0,
      ...ownObservations.map(({ confidence }) => confidence),
    );
    const roles = strings(values.roles ?? values.role);
    const skills = strings(values.skills);

    return {
      profileId: profile.profileId,
      name: stringValue(values.name) ?? profile.name,
      headline: stringValue(values.headline ?? values.summary),
      currentResidence: stringValue(
        values.current_residence ?? values.currentResidence ?? values.location,
      ),
      primaryRole: roles[0] ?? null,
      skills,
      currentCompany:
        stringValue(values.current_company ?? values.currentCompany) ??
        profile.currentCompany,
      seniority: stringValue(values.seniority),
      experienceYears: numberValue(
        values.experience_years ?? values.experienceYears ?? values.experience,
      ),
      opportunityStatus: opportunityStatus(
        values.opportunity_status ?? values.opportunityStatus,
      ),
      freshness,
      evidence: hasMemberEvidence
        ? "member"
        : strongestConfidence >= 0.9
          ? "strong"
          : "supported",
      evidenceRank: hasMemberEvidence ? 3 : strongestConfidence >= 0.9 ? 2 : 1,
      memberFields,
      confidenceByField,
      opportunityRank:
        opportunityStatus(
          values.opportunity_status ?? values.opportunityStatus,
        ) === "open"
          ? 1
          : 0,
      links: links
        .filter((link) => link.profileId === profile.profileId)
        .map(({ url }) => url),
      rank: 0,
    };
  });
};

const effectiveValues = (
  statements: Array<typeof memberStatements.$inferSelect>,
  observations: Array<typeof profileObservations.$inferSelect>,
) => {
  const values: Record<string, unknown> = {};
  const confidenceByField = new Map<string, number>();
  for (const observation of [...observations].reverse()) {
    if (
      observation.field === "github-normalization" &&
      isRecord(observation.value)
    ) {
      for (const [field, value] of Object.entries(observation.value)) {
        const evidenceField = canonicalField(field);
        if (
          (confidenceByField.get(evidenceField) ?? -1) <= observation.confidence
        ) {
          values[field] = value;
          confidenceByField.set(evidenceField, observation.confidence);
        }
      }
    } else if (
      observation.field === "github-account" &&
      isRecord(observation.value)
    ) {
      for (const field of ["location", "company"] as const) {
        if (
          observation.value[field] !== undefined &&
          values[field] === undefined
        ) {
          values[field] = observation.value[field];
          confidenceByField.set(canonicalField(field), observation.confidence);
        }
      }
    } else if (
      (confidenceByField.get(canonicalField(observation.field)) ?? -1) <=
      observation.confidence
    ) {
      values[observation.field] = observation.value;
      confidenceByField.set(
        canonicalField(observation.field),
        observation.confidence,
      );
    }
  }
  for (const statement of [...statements].reverse()) {
    values[statement.field] = statement.value;
  }
  return {
    values,
    confidenceByField,
    memberFields: new Set(statements.map(({ field }) => canonicalField(field))),
  };
};

const normalizeFilters = (filters: ProfileSearchFilters) => ({
  query: filters.query?.trim().toLocaleLowerCase() || undefined,
  roles: normalizeList(filters.roles),
  skills: normalizeList(filters.skills),
  currentResidences: normalizeList(filters.currentResidences),
  companies: normalizeList(filters.companies),
  seniorities: normalizeList(filters.seniorities),
  minimumExperience:
    filters.minimumExperience === undefined
      ? undefined
      : Math.max(0, filters.minimumExperience),
  opportunityStatuses: [...new Set(filters.opportunityStatuses ?? [])].sort(),
});

type NormalizedFilters = ReturnType<typeof normalizeFilters>;

const matches = (profile: SearchDocument, filters: NormalizedFilters) => {
  const role = profile.primaryRole?.toLocaleLowerCase() ?? "";
  const skills = profile.skills.map((skill) => skill.toLocaleLowerCase());
  const residence = profile.currentResidence?.toLocaleLowerCase() ?? "";
  const company = profile.currentCompany?.toLocaleLowerCase() ?? "";
  const seniority = profile.seniority?.toLocaleLowerCase() ?? "";
  const searchableText = [
    profile.name,
    profile.headline,
    profile.primaryRole,
    profile.currentResidence,
    profile.currentCompany,
    ...profile.skills,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();

  return (
    (filters.query === undefined || searchableText.includes(filters.query)) &&
    (filters.roles.length === 0 ||
      filters.roles.some((value) => role.includes(value))) &&
    (filters.skills.length === 0 ||
      filters.skills.every((value) =>
        skills.some((skill) => skill.includes(value)),
      )) &&
    (filters.currentResidences.length === 0 ||
      filters.currentResidences.some((value) =>
        residenceMatches(residence, value),
      )) &&
    (filters.companies.length === 0 ||
      filters.companies.some((value) => company.includes(value))) &&
    (filters.seniorities.length === 0 ||
      filters.seniorities.some((value) => seniority.includes(value))) &&
    (filters.minimumExperience === undefined ||
      (profile.experienceYears ?? -1) >= filters.minimumExperience) &&
    (filters.opportunityStatuses.length === 0 ||
      filters.opportunityStatuses.includes(profile.opportunityStatus))
  );
};

const rank = (profile: SearchDocument, filters: NormalizedFilters) => {
  const role = profile.primaryRole?.toLocaleLowerCase() ?? "";
  const skills = profile.skills.map((skill) => skill.toLocaleLowerCase());
  const residence = profile.currentResidence?.toLocaleLowerCase() ?? "";
  const queryMatches =
    filters.query === undefined
      ? 0
      : [
          profile.name,
          profile.headline,
          profile.primaryRole,
          ...profile.skills,
        ].filter((value) => value?.toLocaleLowerCase().includes(filters.query!))
          .length;
  const relevantFields = [
    ...(filters.roles.length > 0 ? ["role"] : []),
    ...(filters.skills.length > 0 ? ["skills"] : []),
    ...(filters.currentResidences.length > 0 ? ["current_residence"] : []),
  ];
  const hasMemberEvidence = relevantFields.some((field) =>
    profile.memberFields.has(field),
  );
  const relevantConfidence = Math.max(
    0,
    ...relevantFields.map((field) => profile.confidenceByField.get(field) ?? 0),
  );
  const evidenceRank =
    relevantFields.length === 0
      ? profile.evidenceRank
      : hasMemberEvidence
        ? 3
        : relevantConfidence >= 0.9
          ? 2
          : 1;
  return {
    ...profile,
    evidenceRank,
    evidence:
      evidenceRank === 3
        ? ("member" as const)
        : evidenceRank === 2
          ? ("strong" as const)
          : ("supported" as const),
    rank:
      filters.roles.filter((value) => role.includes(value)).length * 40 +
      filters.skills.filter((value) =>
        skills.some((skill) => skill.includes(value)),
      ).length *
        25 +
      filters.currentResidences.filter((value) =>
        residenceMatches(residence, value),
      ).length *
        20 +
      queryMatches * 10,
  };
};

type SortKey = Pick<
  SearchDocument,
  | "rank"
  | "evidenceRank"
  | "opportunityRank"
  | "freshness"
  | "name"
  | "profileId"
>;

const compareDocuments = (left: SortKey, right: SortKey) =>
  right.rank - left.rank ||
  right.evidenceRank - left.evidenceRank ||
  right.opportunityRank - left.opportunityRank ||
  right.freshness.localeCompare(left.freshness) ||
  left.name.localeCompare(right.name) ||
  left.profileId.localeCompare(right.profileId);

const isAfterCursor = (document: SearchDocument, cursor: Cursor) =>
  compareDocuments(document, cursor) > 0;

const encodeCursor = async (cursor: Cursor, secret: string) => {
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(cursor)));
  const signature = await sign(payload, secret);
  return `${payload}.${base64Url(signature)}`;
};

const decodeCursor = async (
  value: string,
  filters: NormalizedFilters,
  now: Date,
  secret: string,
): Promise<Cursor> => {
  try {
    const [payload, encodedSignature, extra] = value.split(".");
    if (
      payload === undefined ||
      encodedSignature === undefined ||
      extra !== undefined
    )
      throw new Error("invalid cursor");
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(encodedSignature),
      new TextEncoder().encode(payload),
    );
    if (!valid) throw new Error("invalid cursor");
    const cursor = JSON.parse(
      new TextDecoder().decode(fromBase64Url(payload)),
    ) as Cursor;
    if (
      cursor.version !== 1 ||
      cursor.expiresAt <= now.getTime() ||
      cursor.filters !== JSON.stringify(filters) ||
      cursor.depth > maximumCursorDepth
    ) {
      throw new Error("invalid cursor");
    }
    return cursor;
  } catch {
    throw new InvalidSearchCursor("Search cursor is invalid or expired");
  }
};

const sign = async (value: string, secret: string) =>
  new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await hmacKey(secret),
      new TextEncoder().encode(value),
    ),
  );

const hmacKey = (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

const base64Url = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const fromBase64Url = (value: string) => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
};

const normalizeList = (values: string[] | undefined) =>
  [
    ...new Set(
      (values ?? [])
        .map((value) => value.trim().toLocaleLowerCase())
        .filter(Boolean),
    ),
  ].sort();

const strings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string" && value.trim() !== ""
      ? [value]
      : [];

const stringValue = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const numberValue = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const opportunityStatus = (value: unknown): OpportunityStatus =>
  value === "open" || value === "not_open" ? value : "unspecified";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalField = (field: string) => {
  if (field === "roles") return "role";
  if (
    field === "currentResidence" ||
    field === "location" ||
    field === "current_residence"
  )
    return "current_residence";
  return field;
};

const residenceMatches = (residence: string, filter: string) =>
  residence.includes(filter) ||
  ((filter === "latam" || filter === "latin america") &&
    latinAmericaCountries.some((country) => residence.includes(country)));

const latinAmericaCountries = [
  "argentina",
  "bolivia",
  "brazil",
  "brasil",
  "chile",
  "colombia",
  "costa rica",
  "cuba",
  "dominican republic",
  "ecuador",
  "el salvador",
  "guatemala",
  "haiti",
  "honduras",
  "mexico",
  "nicaragua",
  "panama",
  "paraguay",
  "peru",
  "puerto rico",
  "uruguay",
  "venezuela",
];
