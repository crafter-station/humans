import type { ErrorEvent } from "@sentry/nextjs";
import type * as Sentry from "@sentry/nextjs";

type SentryOptions = Parameters<typeof Sentry.init>[0];
type DataCollection = NonNullable<SentryOptions["dataCollection"]>;
type TransactionEvent = Parameters<
  NonNullable<SentryOptions["beforeSendTransaction"]>
>[0];

export const sentryDataCollection: DataCollection = {
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
};

export const scrubSentryEvent = (event: ErrorEvent) => {
  delete event.breadcrumbs;
  delete event.contexts;
  delete event.extra;
  delete event.request;
  delete event.user;
  if (event.message) event.message = "Redacted application error";
  for (const exception of event.exception?.values ?? []) {
    exception.value = "Redacted application exception";
  }
  return event;
};

export const scrubSentryTransaction = (event: TransactionEvent) => {
  delete event.breadcrumbs;
  delete event.extra;
  delete event.request;
  delete event.user;
  if (event.contexts?.trace) event.contexts = { trace: event.contexts.trace };
  else delete event.contexts;
  if (event.transaction) event.transaction = scrubRoute(event.transaction);
  for (const span of event.spans ?? []) {
    span.data = {};
    if (span.description) span.description = scrubRoute(span.description);
  }
  return event;
};

const scrubRoute = (value: string) =>
  value
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
      ":id",
    )
    .replace(/\/(?:[A-Za-z0-9_-]{16,})(?=\/|$|\?)/g, "/:id")
    .replace(/\?.*$/, "");
