import { makeNeonDatabaseLayer } from "@humans/database/neon";
import * as Sentry from "@sentry/cloudflare";

import { type Bindings, createApp } from "./app";

const app = createApp(
  (bindings) =>
    makeNeonDatabaseLayer(
      bindings.DATABASE_URL,
      bindings.SEARCH_CURSOR_SECRET ?? bindings.CLERK_SECRET_KEY,
    ),
  undefined,
  undefined,
  undefined,
  (error, context) => {
    Sentry.captureException(error, {
      tags: {
        operation: context.operation,
        ...(context.correlationId === undefined
          ? {}
          : { correlation_id: context.correlationId }),
      },
    });
  },
);

export default Sentry.withSentry(
  (bindings: Bindings) => ({
    dsn: bindings.SENTRY_DSN,
    enabled: Boolean(bindings.SENTRY_DSN),
    environment: bindings.SENTRY_ENVIRONMENT ?? "local",
    release: bindings.SENTRY_RELEASE ?? bindings.CF_VERSION_METADATA?.id,
    tracesSampleRate: bindings.SENTRY_ENVIRONMENT === "production" ? 0.1 : 1,
    tracePropagationTargets: [],
    maxBreadcrumbs: 0,
    maxValueLength: 200,
    enableLogs: false,
    enableMetrics: false,
    sendClientReports: false,
    streamGenAiSpans: false,
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
    beforeSend(event) {
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
    },
    beforeSendTransaction(event) {
      delete event.breadcrumbs;
      delete event.contexts;
      delete event.extra;
      delete event.request;
      delete event.user;
      if (event.transaction) event.transaction = scrubRoute(event.transaction);
      for (const span of event.spans ?? []) {
        span.data = {};
        if (span.description) span.description = scrubRoute(span.description);
      }
      return event;
    },
  }),
  app,
);

const scrubRoute = (value: string) =>
  value
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
      ":id",
    )
    .replace(/\/(?:[A-Za-z0-9_-]{16,})(?=\/|$|\?)/g, "/:id")
    .replace(/\?.*$/, "");
