export const TIKHUB_PIPELINE_VERSION = "tikhub-linkedin-v1";
export const TIKHUB_SNAPSHOT_RETENTION_DAYS = 30;
export const TIKHUB_CONCURRENCY_LIMIT = 4;

export type TikHubEnrichmentInput = {
  profileId: string;
  linkedInUrl: string;
  runId: string;
};

export type CareerEntry = {
  sourceRecordId: string;
  organization: string;
  title?: string;
  field?: string;
  startedAt?: string;
  endedAt?: string;
};

export type ProviderContactCandidate = {
  sourceRecordId: string;
  type: "email" | "phone";
  value: string;
  category: "professional" | "personal" | "unknown";
  verification: "provider-verified" | "inferred" | "unverified";
  direct?: boolean;
};

export type TikHubProfile = {
  sourceRecordId: string;
  headline: string | null;
  currentCompany: string | null;
  experience: CareerEntry[];
  education: CareerEntry[];
  skills: string[];
  contacts: ProviderContactCandidate[];
};

export type ContactDetail = {
  type: "professional-email" | "direct-professional-phone";
  value: string;
};

export type TikHubEvidence = Omit<TikHubProfile, "contacts"> & {
  contactDetails: Array<ContactDetail & { sourceRecordId: string }>;
};

export type TikHubObservation = {
  profileId: string;
  sourceRecordId: string;
  kind: "linkedin-career" | "contact-detail";
  value: unknown;
  /** Exact provider identity; never exposed by a public serializer. */
  sourceIdentity: "tikhub";
  /** Stable, non-provider-specific source shown externally. */
  sourceCategory: "professional-network";
  collectedAt: string;
  confidence: number;
  pipelineVersion: typeof TIKHUB_PIPELINE_VERSION;
};

export type TikHubStage = "fetch" | "normalization" | "persistence";
export type TikHubRun = {
  id: string;
  profileId: string;
  status: "pending" | "running" | "succeeded" | "failed";
  completedStages: TikHubStage[];
  currentStage: TikHubStage | null;
  startedAt: string;
  finishedAt?: string;
  error?: string;
};

export class TikHubProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: Date,
  ) {
    super(message);
    this.name = "TikHubProviderError";
  }
}

export class InvalidTikHubPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTikHubPayloadError";
  }
}

export interface TikHubProvider {
  getLinkedInProfile(linkedInUrl: string): Promise<unknown>;
}

export interface TikHubStore {
  getRun(runId: string): Promise<TikHubRun | undefined>;
  getOrCreateRun(
    profileId: string,
    runId: string,
    startedAt: string,
  ): Promise<TikHubRun>;
  saveRun(run: TikHubRun): Promise<void>;
  loadCheckpoint<T>(runId: string, stage: TikHubStage): Promise<T | undefined>;
  saveCheckpoint<T>(
    runId: string,
    stage: TikHubStage,
    value: T,
    options?: { expiresAt?: string },
  ): Promise<void>;
  persistObservations(
    runId: string,
    observations: TikHubObservation[],
  ): Promise<void>;
  markTikHubObservationsStale(profileId: string, at: string): Promise<void>;
}

export type Collected<T> = { value: T; collectedAt: string };
