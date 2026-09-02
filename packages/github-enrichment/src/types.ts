export const PIPELINE_VERSION = "github-v1";
export const GITHUB_CONCURRENCY_LIMIT = 4;
export const INACCESSIBLE_GRACE_PERIOD_DAYS = 30;
export const PROVIDER_SNAPSHOT_RETENTION_DAYS = 30;

export type GitHubEnrichmentInput = {
  profileId: string;
  githubLogin: string;
  runId: string;
};

export type GitHubUser = {
  id: number;
  login: string;
  name: string | null;
  bio: string | null;
  company: string | null;
  location: string | null;
  blog: string | null;
  type: "User";
};

export type Repository = {
  id: number;
  name: string;
  description: string | null;
  fork: boolean;
  stargazersCount: number;
  forksCount: number;
  pushedAt: string;
  languages: Record<string, number>;
  pinned: boolean;
};

export type Contribution = {
  repositoryId: number;
  occurredAt: string;
  kind: "commit" | "pull-request" | "issue" | "review";
};

export type GitHubEvidence = {
  user: GitHubUser;
  repositories: Repository[];
  contributions: Contribution[];
};

export type NormalizedEvidence = {
  roles: string[];
  skills: string[];
  summary: string;
  evidenceRepositoryIds: number[];
};

export type Observation = {
  profileId: string;
  kind:
    | "github-account"
    | "github-repository"
    | "github-contribution"
    | "github-normalization";
  value: unknown;
  source: "github" | "github-ai-normalization";
  collectedAt: string;
  confidence: number;
  pipelineVersion: typeof PIPELINE_VERSION;
};

export type Stage =
  "account" | "repositories" | "normalization" | "persistence";
export type RunStatus =
  "pending" | "running" | "succeeded" | "failed" | "stale";

export type EnrichmentRun = {
  id: string;
  profileId: string;
  status: RunStatus;
  completedStages: Stage[];
  currentStage: Stage | null;
  startedAt: string;
  finishedAt?: string;
  error?: string;
};

export class GitHubProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: Date,
  ) {
    super(message);
    this.name = "GitHubProviderError";
  }
}

export interface GitHubProvider {
  getUser(login: string): Promise<GitHubUser>;
  getPinnedRepositories(login: string): Promise<Repository[]>;
  getRecentlyActiveRepositories(
    login: string,
    cursor?: string,
  ): Promise<{ repositories: Repository[]; nextCursor?: string }>;
  getContributions(
    login: string,
    since: string,
    cursor?: string,
  ): Promise<{ contributions: Contribution[]; nextCursor?: string }>;
}

export interface EvidenceNormalizer {
  normalize(evidence: GitHubEvidence): Promise<NormalizedEvidence>;
}

export interface EnrichmentStore {
  getRun(runId: string): Promise<EnrichmentRun | undefined>;
  getOrCreateRun(
    profileId: string,
    runId: string,
    startedAt: string,
  ): Promise<EnrichmentRun>;
  saveRun(run: EnrichmentRun): Promise<void>;
  loadCheckpoint<T>(runId: string, stage: Stage): Promise<T | undefined>;
  saveCheckpoint<T>(
    runId: string,
    stage: Stage,
    value: T,
    options?: { expiresAt?: string },
  ): Promise<void>;
  getImmutableGitHubUserId(profileId: string): Promise<number | undefined>;
  saveObservations(observations: Observation[]): Promise<void>;
  markGitHubObservationsStale(profileId: string, at: string): Promise<void>;
  markGitHubInaccessibleIfUnset(profileId: string, at: string): Promise<string>;
  clearGitHubInaccessible(profileId: string): Promise<void>;
}
