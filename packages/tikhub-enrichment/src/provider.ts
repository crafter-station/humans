import {
  type CareerEntry,
  InvalidTikHubPayloadError,
  type TikHubProfile,
  type TikHubProvider,
  TikHubProviderError,
} from "./types.js";
import { parseTikHubProfile } from "./workflow.js";

export const TIKHUB_LINKEDIN_PROFILE_ENDPOINT =
  "https://api.tikhub.io/api/v1/linkedin/web_v2/get_user_profile";
const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

export type TikHubFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type TikHubApiEnvelope = {
  code: number;
  data: unknown;
  request_id?: string | null;
  [key: string]: unknown;
};

export type TikHubLinkedInSnapshot = TikHubProfile & {
  /** Retained only by the workflow's bounded provider checkpoint. */
  providerEnvelope: TikHubApiEnvelope;
};

export type TikHubLinkedInProviderOptions = {
  apiKey: string;
  endpoint?: string | URL;
  fetch?: TikHubFetch;
  now?: () => Date;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalidResponse = (reason: string) =>
  new InvalidTikHubPayloadError(`Invalid TikHub response: ${reason}`);

const parseEnvelope = (value: unknown): TikHubApiEnvelope => {
  if (!isRecord(value)) throw invalidResponse("expected an object envelope");
  if (
    typeof value.code !== "number" ||
    !Number.isInteger(value.code) ||
    value.code < 100 ||
    value.code > 599
  )
    throw invalidResponse("invalid code");

  if (
    value.request_id !== undefined &&
    value.request_id !== null &&
    typeof value.request_id !== "string"
  )
    throw invalidResponse("invalid request_id");

  for (const field of [
    "message",
    "message_zh",
    "support",
    "time",
    "time_zone",
    "router",
  ] as const)
    if (value[field] !== undefined && typeof value[field] !== "string")
      throw invalidResponse(`invalid ${field}`);

  for (const field of [
    "docs",
    "cache_message",
    "cache_message_zh",
    "cache_url",
  ] as const)
    if (
      value[field] !== undefined &&
      value[field] !== null &&
      typeof value[field] !== "string"
    )
      throw invalidResponse(`invalid ${field}`);

  if (value.time_stamp !== undefined && !Number.isInteger(value.time_stamp))
    throw invalidResponse("invalid time_stamp");

  return value as TikHubApiEnvelope;
};

const parseRetryAfter = (value: string | null, now: Date) => {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const timestamp = now.getTime() + Number(trimmed) * 1_000;
    return Number.isFinite(timestamp) &&
      !Number.isNaN(new Date(timestamp).getTime())
      ? new Date(timestamp)
      : undefined;
  }
  const timestamp = Date.parse(trimmed);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
};

const providerError = (status: number, retryAfter?: Date) =>
  new TikHubProviderError(
    status === 0
      ? "TikHub network request failed"
      : `TikHub request failed with status ${status}`,
    status,
    retryAfter,
  );

const optionalString = (
  value: Record<string, unknown>,
  field: string,
  context: string,
) => {
  const candidate = value[field];
  if (candidate === null || candidate === undefined) return undefined;
  if (typeof candidate !== "string")
    throw invalidResponse(`invalid ${context}.${field}`);
  return candidate;
};

const careerEntriesFrom = (
  value: unknown,
  profileRecordId: string,
  kind: "experience" | "education",
): CareerEntry[] => {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw invalidResponse(`invalid ${kind}`);

  return value.map((entry, index) => {
    if (!isRecord(entry)) throw invalidResponse(`invalid ${kind} entry`);
    const organization = optionalString(
      entry,
      kind === "experience" ? "company" : "title",
      kind,
    );
    if (!organization) throw invalidResponse(`invalid ${kind} organization`);

    const title =
      kind === "experience" ? optionalString(entry, "title", kind) : undefined;
    const field =
      kind === "education" ? optionalString(entry, "field", kind) : undefined;
    const startedAt = optionalString(
      entry,
      kind === "experience" ? "start_date" : "start_year",
      kind,
    );
    const endedAt = optionalString(
      entry,
      kind === "experience" ? "end_date" : "end_year",
      kind,
    );
    const companyId =
      kind === "experience"
        ? optionalString(entry, "company_id", kind)
        : undefined;

    return {
      sourceRecordId: `${profileRecordId}:${kind}:${index + 1}`,
      organization,
      ...(companyId === undefined ? {} : { companyId }),
      ...(title === undefined ? {} : { title }),
      ...(field === undefined ? {} : { field }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(endedAt === undefined ? {} : { endedAt }),
    };
  });
};

const profileFrom = (value: unknown): TikHubProfile => {
  let decoded = value;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded) as unknown;
    } catch {
      throw invalidResponse("data was not valid JSON");
    }
  }
  if (!isRecord(decoded)) throw invalidResponse("invalid data");

  const linkedInNumericId = optionalString(
    decoded,
    "linkedin_num_id",
    "profile",
  );
  if (!linkedInNumericId || !/^\d+$/.test(linkedInNumericId))
    throw invalidResponse("invalid profile.linkedin_num_id");
  const sourceRecordId = `linkedin:${linkedInNumericId}`;

  const currentCompanyValue = decoded.current_company;
  if (
    currentCompanyValue !== null &&
    currentCompanyValue !== undefined &&
    !isRecord(currentCompanyValue)
  )
    throw invalidResponse("invalid profile.current_company");
  const currentCompany =
    optionalString(decoded, "current_company_name", "profile") ??
    (isRecord(currentCompanyValue)
      ? optionalString(currentCompanyValue, "name", "current_company")
      : undefined);
  const currentCompanyId =
    optionalString(decoded, "current_company_company_id", "profile") ??
    (isRecord(currentCompanyValue)
      ? optionalString(currentCompanyValue, "company_id", "current_company")
      : undefined);
  const headline =
    optionalString(decoded, "position", "profile") ??
    (isRecord(currentCompanyValue)
      ? optionalString(currentCompanyValue, "title", "current_company")
      : undefined);

  return parseTikHubProfile({
    sourceRecordId,
    headline: headline ?? null,
    currentCompany: currentCompany ?? null,
    ...(currentCompanyId === undefined ? {} : { currentCompanyId }),
    experience: careerEntriesFrom(
      decoded.experience,
      sourceRecordId,
      "experience",
    ),
    education: careerEntriesFrom(
      decoded.education,
      sourceRecordId,
      "education",
    ),
    skills: [],
    contacts: [],
  });
};

/**
 * Fetches the documented TikHub envelope and adapts its data through the
 * package-owned provider fixture contract. TikHub does not publish a schema
 * for the endpoint's nested `data`, so undocumented field aliases are rejected.
 */
export class TikHubLinkedInProvider implements TikHubProvider {
  readonly #apiKey: string;
  readonly #endpoint: URL;
  readonly #fetch: TikHubFetch;
  readonly #now: () => Date;

  constructor(options: TikHubLinkedInProviderOptions) {
    const apiKey = options.apiKey.trim();
    if (apiKey.length === 0)
      throw new TypeError("TikHub apiKey must not be empty");

    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint ?? TIKHUB_LINKEDIN_PROFILE_ENDPOINT);
    } catch {
      throw new TypeError("TikHub endpoint must be a valid URL");
    }
    if (endpoint.protocol !== "https:")
      throw new TypeError("TikHub endpoint must use HTTPS");
    if (endpoint.username || endpoint.password)
      throw new TypeError("TikHub endpoint must not contain credentials");

    this.#apiKey = apiKey;
    this.#endpoint = endpoint;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async getLinkedInProfile(
    linkedInUrl: string,
  ): Promise<TikHubLinkedInSnapshot> {
    let profileUrl: URL;
    try {
      profileUrl = new URL(linkedInUrl);
    } catch {
      throw new TypeError("TikHub Profile URL must be a valid LinkedIn URL");
    }
    const hostname = profileUrl.hostname.toLowerCase().replace(/^www\./, "");
    if (
      profileUrl.protocol !== "https:" ||
      profileUrl.username !== "" ||
      profileUrl.password !== "" ||
      (hostname !== "linkedin.com" && !hostname.endsWith(".linkedin.com"))
    )
      throw new TypeError("TikHub Profile URL must be a valid LinkedIn URL");

    const url = new URL(this.#endpoint);
    url.searchParams.set("url", profileUrl.toString());

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.#apiKey}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw providerError(0);
    }

    const retryAfter = parseRetryAfter(
      response.headers.get("retry-after"),
      this.#now(),
    );
    if (!response.ok) throw providerError(response.status, retryAfter);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw invalidResponse("body was not valid JSON");
    }

    const envelope = parseEnvelope(body);
    if (envelope.code !== 200) {
      if (envelope.code >= 400 && envelope.code <= 599)
        throw providerError(envelope.code, retryAfter);
      throw invalidResponse("unexpected code");
    }
    if (!Object.hasOwn(envelope, "data")) throw invalidResponse("missing data");

    return {
      ...profileFrom(envelope.data),
      providerEnvelope: envelope,
    };
  }
}
