import type { ErrorEvent, EventHint } from "@sentry/node";
import * as Sentry from "@sentry/node";

type Environment = Readonly<Record<string, string | undefined>>;
type TaskErrorContext = { taskId: string; runId: string };
type SentryClient = {
  init: typeof Sentry.init;
  captureException: typeof Sentry.captureException;
  flush: typeof Sentry.flush;
};

const taskDetails = (taskId: string) => {
  if (taskId.startsWith("github-enrichment-account"))
    return { provider: "github", stage: "account" };
  if (taskId.startsWith("github-enrichment-repositories"))
    return { provider: "github", stage: "repositories" };
  if (taskId.startsWith("github-enrichment-normalization"))
    return { provider: "github", stage: "normalization" };
  if (taskId.startsWith("github-enrichment-persistence"))
    return { provider: "github", stage: "persistence" };
  if (taskId.startsWith("github-profile-enrichment"))
    return { provider: "github", stage: "orchestration" };
  if (taskId.startsWith("tikhub-linkedin-fetch"))
    return { provider: "tikhub", stage: "fetch" };
  if (taskId.startsWith("tikhub-linkedin-normalization"))
    return { provider: "tikhub", stage: "normalization" };
  if (taskId.startsWith("tikhub-linkedin-persistence"))
    return { provider: "tikhub", stage: "persistence" };
  if (taskId.startsWith("tikhub-linkedin-enrichment"))
    return { provider: "tikhub", stage: "orchestration" };
  if (taskId.startsWith("deepline-identity"))
    return { provider: "deepline", stage: "identity" };
  if (taskId.startsWith("deepline-career"))
    return { provider: "deepline", stage: "career" };
  if (taskId.startsWith("deepline-fallback-persistence"))
    return { provider: "deepline", stage: "persistence" };
  if (taskId.startsWith("deepline-fallback-enrichment"))
    return { provider: "deepline", stage: "orchestration" };
  if (taskId === "enrichment-dispatcher-v1")
    return { provider: "dispatch", stage: "delivery" };
  return { provider: "system", stage: "maintenance" };
};

const optional = (environment: Environment, name: string) => {
  const value = environment[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} must not be empty when set`);
  return trimmed;
};

export const readSentryEnvironment = (
  environment: Environment = process.env,
) => {
  const dsn = optional(environment, "SENTRY_DSN");
  if (dsn !== undefined) {
    let url: URL;
    try {
      url = new URL(dsn);
    } catch {
      throw new Error("SENTRY_DSN must be a valid HTTP URL");
    }
    if (url.protocol !== "https:")
      throw new Error("SENTRY_DSN must be a valid HTTPS URL");
  }
  return {
    dsn,
    environment: optional(environment, "SENTRY_ENVIRONMENT"),
    release: optional(environment, "SENTRY_RELEASE"),
  };
};

export const scrubTaskErrorEvent = (event: ErrorEvent) => {
  delete event.breadcrumbs;
  delete event.contexts;
  delete event.extra;
  delete event.request;
  delete event.user;
  if (event.message) event.message = "Redacted task error";
  for (const exception of event.exception?.values ?? [])
    exception.value = "Redacted task exception";
  const tags = event.tags ?? {};
  event.tags = Object.fromEntries(
    ["task", "provider", "stage", "run_correlation"].flatMap((name) => {
      const value = tags[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  return event;
};

export const createTaskExceptionReporter = (
  client: SentryClient = Sentry,
  environment: Environment = process.env,
) => {
  let initialized = false;
  return async (_error: unknown, context: TaskErrorContext) => {
    let configuration: ReturnType<typeof readSentryEnvironment>;
    try {
      configuration = readSentryEnvironment(environment);
    } catch {
      return;
    }
    if (configuration.dsn === undefined) return;
    if (!initialized) {
      client.init({
        dsn: configuration.dsn,
        enabled: true,
        environment: configuration.environment,
        release: configuration.release,
        defaultIntegrations: false,
        tracesSampleRate: 0,
        maxBreadcrumbs: 0,
        sendDefaultPii: false,
        dataCollection: {
          userInfo: false,
          cookies: false,
          httpHeaders: { request: false, response: false },
          httpBodies: [],
          urlQueryParams: false,
          graphQL: { document: false, variables: false },
          genAI: { inputs: false, outputs: false },
          databaseQueryData: false,
          stackFrameVariables: false,
          frameContextLines: 0,
        },
        beforeSend: (event: ErrorEvent, _hint: EventHint) =>
          scrubTaskErrorEvent(event),
      });
      initialized = true;
    }
    const details = taskDetails(context.taskId);
    const reported = new Error("Redacted task exception");
    if (_error instanceof Error && _error.stack) {
      const [, ...frames] = _error.stack.split("\n");
      reported.stack = ["Error: Redacted task exception", ...frames].join("\n");
    }
    client.captureException(reported, {
      tags: {
        task: context.taskId,
        provider: details.provider,
        stage: details.stage,
        run_correlation: context.runId,
      },
    });
    await client.flush(2_000);
  };
};

export const captureTaskException = createTaskExceptionReporter();
