import { and, desc, eq, inArray, notExists } from "drizzle-orm";
import {
  memberStatements,
  profileObservations,
  professionalLinks,
  profiles,
  suppressionRecords,
} from "./schema";
import type { DrizzleDatabase, Transaction } from "./service/types";

type SearchDatabase = DrizzleDatabase | Transaction;

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
  version: 2;
  expiresAt: number;
  filters: string;
  reached: number;
  rank: number;
  evidenceRank: number;
  opportunityRank: number;
  freshness: string;
  name: string;
  profileId: string;
};

const cursorLifetimeMs = 15 * 60 * 1000;
const maximumReachableResults = 1_000;

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
  const availablePageSize = Math.min(
    pageSize,
    maximumReachableResults - (cursor?.reached ?? 0),
  );
  const page = remaining.slice(0, availablePageSize);
  const last = page.at(-1);
  const reached = (cursor?.reached ?? 0) + page.length;

  return {
    results: page.map(toSearchResult),
    nextCursor:
      remaining.length > availablePageSize &&
      reached < maximumReachableResults &&
      last !== undefined
        ? await encodeCursor(
            {
              version: 2,
              expiresAt: cursor?.expiresAt ?? now.getTime() + cursorLifetimeMs,
              filters: JSON.stringify(normalized),
              reached,
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

export type ProfileSearchFacets = {
  roles: string[];
  skills: string[];
  currentResidences: string[];
  companies: string[];
  seniorities: string[];
  opportunityStatuses: OpportunityStatus[];
};

/** Lists zero-cost filters from the same searchable Profile view as search. */
export const listProfileSearchFacets = async (
  database: SearchDatabase,
  now = new Date(),
): Promise<ProfileSearchFacets> => {
  const documents = await loadDocuments(database, undefined, now);
  return {
    roles: facetValues(
      documents.flatMap(({ primaryRole }) => primaryRole ?? []),
    ),
    skills: facetValues(documents.flatMap(({ skills }) => skills)),
    currentResidences: facetValues(
      documents.flatMap(({ currentResidence }) => currentResidence ?? []),
    ),
    companies: facetValues(
      documents.flatMap(({ currentCompany }) => currentCompany ?? []),
    ),
    seniorities: facetValues(
      documents.flatMap(({ seniority }) => seniority ?? []),
    ),
    opportunityStatuses: facetValues(
      documents.map(({ opportunityStatus }) => opportunityStatus),
    ) as OpportunityStatus[],
  };
};

export const profileSearchRequestFingerprint = async (
  filters: ProfileSearchFilters,
  options: { cursor?: string; pageSize?: number },
) => {
  const request = JSON.stringify({
    filters: normalizeFilters(filters),
    cursor: options.cursor ?? null,
    pageSize: Math.max(1, Math.min(100, options.pageSize ?? 25)),
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(request),
  );
  return base64Url(new Uint8Array(digest));
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
  const statements = await database
    .select({
      profileId: memberStatements.profileId,
      field: memberStatements.field,
      value: memberStatements.value,
      collectedAt: memberStatements.collectedAt,
    })
    .from(memberStatements)
    .where(inArray(memberStatements.profileId, profileIds))
    .orderBy(desc(memberStatements.collectedAt));
  const observations = await database
    .select({
      profileId: profileObservations.profileId,
      field: profileObservations.field,
      value: profileObservations.value,
      source: profileObservations.source,
      confidence: profileObservations.confidence,
      collectedAt: profileObservations.collectedAt,
    })
    .from(profileObservations)
    .where(inArray(profileObservations.profileId, profileIds))
    .orderBy(desc(profileObservations.collectedAt));
  const links = await database
    .select({
      profileId: professionalLinks.profileId,
      url: professionalLinks.url,
    })
    .from(professionalLinks)
    .where(inArray(professionalLinks.profileId, profileIds));

  const statementsByProfile = new Map<string, (typeof statements)[number][]>();
  for (const statement of statements) {
    const ownStatements = statementsByProfile.get(statement.profileId) ?? [];
    ownStatements.push(statement);
    statementsByProfile.set(statement.profileId, ownStatements);
  }
  const observationsByProfile = new Map<
    string,
    (typeof observations)[number][]
  >();
  for (const observation of observations) {
    const ownObservations =
      observationsByProfile.get(observation.profileId) ?? [];
    ownObservations.push(observation);
    observationsByProfile.set(observation.profileId, ownObservations);
  }
  const linksByProfile = new Map<string, (typeof links)[number][]>();
  for (const link of links) {
    const ownLinks = linksByProfile.get(link.profileId) ?? [];
    ownLinks.push(link);
    linksByProfile.set(link.profileId, ownLinks);
  }

  return rows.map((profile): SearchDocument => {
    const ownStatements = statementsByProfile.get(profile.profileId) ?? [];
    const ownObservations = (
      observationsByProfile.get(profile.profileId) ?? []
    ).filter(
      (observation) =>
        !observation.source.startsWith("github") ||
        now.getTime() - observation.collectedAt.getTime() <=
          30 * 24 * 60 * 60 * 1000,
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
      links: (linksByProfile.get(profile.profileId) ?? []).map(
        ({ url }) => url,
      ),
      rank: 0,
    };
  });
};

const effectiveValues = (
  statements: Array<
    Pick<typeof memberStatements.$inferSelect, "field" | "value">
  >,
  observations: Array<
    Pick<
      typeof profileObservations.$inferSelect,
      "field" | "value" | "source" | "confidence"
    >
  >,
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
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await encryptionKey(secret),
      new TextEncoder().encode(JSON.stringify(cursor)),
    ),
  );
  const value = new Uint8Array(iv.length + encrypted.length);
  value.set(iv);
  value.set(encrypted, iv.length);
  return base64Url(value);
};

const decodeCursor = async (
  value: string,
  filters: NormalizedFilters,
  now: Date,
  secret: string,
): Promise<Cursor> => {
  try {
    const encoded = fromBase64Url(value);
    if (encoded.length <= 28) throw new Error("invalid cursor");
    const decoded = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: encoded.slice(0, 12) },
      await encryptionKey(secret),
      encoded.slice(12),
    );
    const cursor: unknown = JSON.parse(new TextDecoder().decode(decoded));
    if (
      !isCursor(cursor) ||
      cursor.version !== 2 ||
      cursor.expiresAt <= now.getTime() ||
      cursor.filters !== JSON.stringify(filters) ||
      cursor.reached <= 0 ||
      cursor.reached >= maximumReachableResults
    ) {
      throw new Error("invalid cursor");
    }
    return cursor;
  } catch {
    throw new InvalidSearchCursor("Search cursor is invalid or expired");
  }
};

const encryptionKey = async (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
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

const isCursor = (value: unknown): value is Cursor => {
  if (!isRecord(value)) return false;
  return (
    value.version === 2 &&
    typeof value.expiresAt === "number" &&
    Number.isSafeInteger(value.expiresAt) &&
    typeof value.filters === "string" &&
    typeof value.reached === "number" &&
    Number.isSafeInteger(value.reached) &&
    typeof value.rank === "number" &&
    Number.isFinite(value.rank) &&
    typeof value.evidenceRank === "number" &&
    Number.isFinite(value.evidenceRank) &&
    typeof value.opportunityRank === "number" &&
    Number.isFinite(value.opportunityRank) &&
    typeof value.freshness === "string" &&
    typeof value.name === "string" &&
    typeof value.profileId === "string"
  );
};

const facetValues = (values: string[]) => {
  const unique = new Map<string, string>();
  for (const value of values) {
    const normalized = value.trim().toLocaleLowerCase();
    if (normalized !== "" && !unique.has(normalized))
      unique.set(normalized, value);
  }
  return [...unique.values()].sort((left, right) => left.localeCompare(right));
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
