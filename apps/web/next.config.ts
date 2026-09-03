import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

import "./env";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  authToken: process.env.SENTRY_AUTH_TOKEN,
  org: "cueva",
  project: process.env.VERCEL_ENV === "production" ? "humans" : "humans-preview",
  ...(process.env.VERCEL_GIT_COMMIT_SHA
    ? { release: { name: process.env.VERCEL_GIT_COMMIT_SHA } }
    : {}),
  silent: true,
  sourcemaps: { deleteSourcemapsAfterUpload: true },
  telemetry: false,
  widenClientFileUpload: true,
});
