import * as Sentry from "@sentry/nextjs";

import {
  scrubSentryEvent,
  scrubSentryTransaction,
  sentryDataCollection,
} from "./sentry-scrub";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment:
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1,
  tracePropagationTargets: [],
  maxBreadcrumbs: 0,
  maxValueLength: 200,
  enableLogs: false,
  enableMetrics: false,
  sendClientReports: false,
  streamGenAiSpans: false,
  dataCollection: sentryDataCollection,
  beforeSend: scrubSentryEvent,
  beforeSendTransaction: scrubSentryTransaction,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
