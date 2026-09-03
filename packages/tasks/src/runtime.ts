import {
  createDeeplineEnrichmentStore,
  createGitHubEnrichmentStore,
  createTikHubEnrichmentStore,
  withNeonEnrichmentDatabase,
} from "@humans/database/enrichment";
import {
  type BillingDatabase,
  withNeonBillingDatabase,
} from "@humans/database/billing";
import {
  createDeeplineEnrichmentStages,
  createDeeplineProvider,
} from "@humans/deepline-enrichment";
import {
  createGitHubEnrichmentStages,
  createGitHubProvider,
  createOpenAIEvidenceNormalizer,
} from "@humans/github-enrichment";
import {
  createTikHubEnrichmentStages,
  TikHubLinkedInProvider,
} from "@humans/tikhub-enrichment";
import {
  createPolarBillingClient,
  POLAR_PRODUCTION_BASE_URL,
  POLAR_SANDBOX_BASE_URL,
  type PolarBillingClient,
} from "@humans/polar-billing";

type Environment = Readonly<Record<string, string | undefined>>;

const required = (environment: Environment, name: string) => {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const databaseUrl = (environment: Environment) => {
  const value = required(environment, "DATABASE_URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  return value;
};

export const readDatabaseEnvironment = (
  environment: Environment = process.env,
) => ({ databaseUrl: databaseUrl(environment) });

export const readGitHubEnvironment = (
  environment: Environment = process.env,
) => ({
  ...readDatabaseEnvironment(environment),
  githubToken: required(environment, "GITHUB_ENRICHMENT_TOKEN"),
  openAiApiKey: required(environment, "OPENAI_API_KEY"),
  openAiModel: required(environment, "OPENAI_MODEL"),
});

export const readTikHubEnvironment = (
  environment: Environment = process.env,
) => ({
  ...readDatabaseEnvironment(environment),
  tikHubApiKey: required(environment, "TIKHUB_API_KEY"),
});

export const readDeeplineEnvironment = (
  environment: Environment = process.env,
) => ({
  ...readDatabaseEnvironment(environment),
  deeplineApiKey: required(environment, "DEEPLINE_API_KEY"),
});

export const readPolarBillingEnvironment = (
  environment: Environment = process.env,
) => {
  const baseUrl = required(environment, "POLAR_BASE_URL");
  if (
    baseUrl !== POLAR_PRODUCTION_BASE_URL &&
    baseUrl !== POLAR_SANDBOX_BASE_URL
  )
    throw new Error("POLAR_BASE_URL is invalid");
  const applicationOrigin = required(environment, "BILLING_APP_ORIGIN");
  let url: URL;
  try {
    url = new URL(applicationOrigin);
  } catch {
    throw new Error("BILLING_APP_ORIGIN must be an origin URL");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("BILLING_APP_ORIGIN must be an origin URL");
  return {
    ...readDatabaseEnvironment(environment),
    polarAccessToken: required(environment, "POLAR_ACCESS_TOKEN"),
    baseUrl,
    polarOrganizationId: required(environment, "POLAR_ORGANIZATION_ID"),
    proProductId: required(environment, "POLAR_PRO_PRODUCT_ID"),
    usageMeterId: required(environment, "POLAR_USAGE_METER_ID"),
    usageEventName: required(environment, "POLAR_USAGE_EVENT_NAME"),
    applicationOrigin,
  };
};

const safeWorkflowLog = (event: Record<string, unknown>) => {
  console.info(event);
};

export const withDatabaseRuntime = <Value>(
  operation: Parameters<typeof withNeonEnrichmentDatabase<Value>>[1],
) => {
  const environment = readDatabaseEnvironment();
  return withNeonEnrichmentDatabase(environment.databaseUrl, operation);
};

export const withPolarBillingRuntime = <Value>(
  operation: (
    database: BillingDatabase,
    client: PolarBillingClient,
  ) => Promise<Value>,
) => {
  const environment = readPolarBillingEnvironment();
  return withNeonBillingDatabase(environment.databaseUrl, (database) =>
    operation(
      database,
      createPolarBillingClient({
        accessToken: environment.polarAccessToken,
        baseUrl: environment.baseUrl,
        organizationId: environment.polarOrganizationId,
        proProductId: environment.proProductId,
        usageMeterId: environment.usageMeterId,
        usageEventName: environment.usageEventName,
        successUrlAllowlist: [environment.applicationOrigin],
      }),
    ),
  );
};

export const withGitHubRuntime = <Value>(
  operation: (
    stages: ReturnType<typeof createGitHubEnrichmentStages>,
  ) => Promise<Value>,
) => {
  const environment = readGitHubEnvironment();
  return withNeonEnrichmentDatabase(environment.databaseUrl, (database) =>
    operation(
      createGitHubEnrichmentStages({
        provider: createGitHubProvider({ token: environment.githubToken }),
        normalizer: createOpenAIEvidenceNormalizer({
          apiKey: environment.openAiApiKey,
          model: environment.openAiModel,
        }),
        store: createGitHubEnrichmentStore(database),
        log: safeWorkflowLog,
      }),
    ),
  );
};

export const withTikHubRuntime = <Value>(
  operation: (
    stages: ReturnType<typeof createTikHubEnrichmentStages>,
  ) => Promise<Value>,
) => {
  const environment = readTikHubEnvironment();
  return withNeonEnrichmentDatabase(environment.databaseUrl, (database) =>
    operation(
      createTikHubEnrichmentStages({
        provider: new TikHubLinkedInProvider({
          apiKey: environment.tikHubApiKey,
        }),
        store: createTikHubEnrichmentStore(database),
        log: safeWorkflowLog,
      }),
    ),
  );
};

export const withDeeplineRuntime = <Value>(
  operation: (
    stages: ReturnType<typeof createDeeplineEnrichmentStages>,
  ) => Promise<Value>,
) => {
  const environment = readDeeplineEnvironment();
  return withNeonEnrichmentDatabase(environment.databaseUrl, (database) =>
    operation(
      createDeeplineEnrichmentStages({
        provider: createDeeplineProvider({
          apiKey: environment.deeplineApiKey,
        }),
        store: createDeeplineEnrichmentStore(database),
        log: safeWorkflowLog,
      }),
    ),
  );
};
