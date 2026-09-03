export const DEEPLINE_PIPELINE_VERSION = "deepline-fallback-v1";
export const DEEPLINE_SNAPSHOT_RETENTION_DAYS = 30;
export const DEEPLINE_CONCURRENCY_LIMIT = 4;
export const DEEPLINE_BASE_URL = "https://code.deepline.com";
export const DEEPLINE_FALLBACK_CONFIDENCE = 0.8;

export const DEEPLINE_IDENTITY_TOOL_ID =
  "limadata_find_person_profiles" as const;
export const DEEPLINE_CAREER_TOOL_ID = "harvestapi_get_profile" as const;

export const DEEPLINE_IDENTITY_FIELDS = [
  "linkedinUrl",
  "githubUrl",
  "xUrl",
] as const;
export const DEEPLINE_CAREER_FIELDS = [
  "headline",
  "currentPosition",
  "experience",
  "education",
  "skills",
] as const;
export const DEEPLINE_FIELDS = [
  ...DEEPLINE_IDENTITY_FIELDS,
  ...DEEPLINE_CAREER_FIELDS,
] as const;

export type DeeplineIdentityField = (typeof DEEPLINE_IDENTITY_FIELDS)[number];
export type DeeplineCareerField = (typeof DEEPLINE_CAREER_FIELDS)[number];
export type DeeplineField = (typeof DEEPLINE_FIELDS)[number];
export type DeeplineToolId =
  | typeof DEEPLINE_IDENTITY_TOOL_ID
  | typeof DEEPLINE_CAREER_TOOL_ID;

export type DeeplineIdentityContext = {
  fullName: string;
  companyName?: string;
  companyDomain?: string;
  email?: string;
};

export type DeeplineEnrichmentInput = {
  profileId: string;
  runId: string;
  /** Fields explicitly left unresolved by direct Member, GitHub, and TikHub data. */
  missingFields: DeeplineField[];
  /** Direct provider attempts that must finish before fallback can be dispatched. */
  prerequisiteRunIds?: string[];
  identity?: DeeplineIdentityContext;
  linkedInUrl?: string;
};

export type DeeplineDate = {
  month?: string | null;
  text?: string;
  year?: number | null;
};

export type DeeplinePosition = {
  companyId?: string;
  companyName?: string;
  companyLinkedinUrl?: string;
  position?: string;
  description?: string | null;
  duration?: string;
  employmentType?: string | null;
  location?: string | null;
  workplaceType?: string | null;
  startDate?: DeeplineDate | null;
  endDate?: DeeplineDate | null;
  skills?: string[] | null;
};

export type DeeplineEducation = {
  schoolId?: string | null;
  schoolName?: string;
  schoolLinkedinUrl?: string;
  degree?: string | null;
  fieldOfStudy?: string | null;
  period?: string | null;
  startDate?: DeeplineDate | null;
  endDate?: DeeplineDate | null;
  skills?: string[];
};

export type DeeplineIdentityResult = {
  linkedinUrl: string | null;
  githubUrl: string | null;
  xUrl: string | null;
};

export type DeeplineCareerResult = {
  sourceRecordId: string;
  headline: string;
  currentPosition: DeeplinePosition[];
  experience: DeeplinePosition[];
  education: DeeplineEducation[];
  skills: string[];
};

export type DeeplineProviderResult<
  TValue,
  TToolId extends DeeplineToolId = DeeplineToolId,
> = {
  toolId: TToolId;
  /** Complete scrubbed provider response retained only in the expiring checkpoint. */
  raw: unknown;
  value: TValue;
};

export interface DeeplineProvider {
  resolveIdentity(
    context: DeeplineIdentityContext,
  ): Promise<
    DeeplineProviderResult<
      DeeplineIdentityResult,
      typeof DEEPLINE_IDENTITY_TOOL_ID
    >
  >;
  getLinkedInCareer(
    linkedInUrl: string,
  ): Promise<
    DeeplineProviderResult<DeeplineCareerResult, typeof DEEPLINE_CAREER_TOOL_ID>
  >;
}

export type DeeplineObservation = {
  profileId: string;
  sourceRecordId: string;
  field: DeeplineField;
  value: unknown;
  source: "deepline";
  providerToolId: DeeplineToolId;
  collectedAt: string;
  confidence: number;
  pipelineVersion: typeof DEEPLINE_PIPELINE_VERSION;
};

export type ProtectedDeeplineField = {
  field: DeeplineField;
  /** Current stronger source that prevents fallback for this field. */
  source: "reviewed" | "member" | "github" | "tikhub";
};

export type DeeplineStage = "identity" | "career" | "persistence";
export type DeeplineRun = {
  id: string;
  profileId: string;
  status: "pending" | "running" | "succeeded" | "failed";
  completedStages: DeeplineStage[];
  currentStage: DeeplineStage | null;
  startedAt: string;
  finishedAt?: string;
  error?: string;
};

export type Collected<T> = {
  value: T;
  collectedAt: string;
};

export interface DeeplineStore {
  getRun(runId: string): Promise<DeeplineRun | undefined>;
  getOrCreateRun(
    profileId: string,
    runId: string,
    startedAt: string,
  ): Promise<DeeplineRun>;
  saveRun(run: DeeplineRun): Promise<void>;
  loadCheckpoint<T>(
    runId: string,
    stage: DeeplineStage,
  ): Promise<T | undefined>;
  saveCheckpoint<T>(
    runId: string,
    stage: DeeplineStage,
    value: T,
    options?: { expiresAt?: string },
  ): Promise<void>;
  /** Returns reviewed corrections, Member Statements, and direct coverage. */
  listProtectedFields(
    profileId: string,
    fields: DeeplineField[],
  ): Promise<ProtectedDeeplineField[]>;
  /** Atomically persists an idempotent run result keyed by runId. */
  persistObservations(
    runId: string,
    observations: DeeplineObservation[],
  ): Promise<void>;
  /** Marks only source="deepline" Observations for these fields stale. */
  markDeeplineObservationsStale(
    profileId: string,
    fields: DeeplineField[],
    at: string,
  ): Promise<void>;
}

export class DeeplineProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: Date,
  ) {
    super(message);
    this.name = "DeeplineProviderError";
  }
}

export class DeeplineTransportError extends Error {
  constructor() {
    super("Deepline request failed before receiving a response");
    this.name = "DeeplineTransportError";
  }
}

export class PermanentDeeplineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentDeeplineError";
  }
}

export class DeeplineCheckpointError extends PermanentDeeplineError {
  constructor() {
    super("Deepline provider result could not be checkpointed");
    this.name = "DeeplineCheckpointError";
  }
}

export class InvalidDeeplineInputError extends PermanentDeeplineError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDeeplineInputError";
  }
}

export class InvalidDeeplineContractError extends PermanentDeeplineError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDeeplineContractError";
  }
}

export class InvalidDeeplineResultError extends PermanentDeeplineError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDeeplineResultError";
  }
}
