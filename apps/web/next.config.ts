import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

import "./env";

const release = (
  process.env.HUMANS_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA
)?.trim();
const releaseEnvironment = process.env.HUMANS_RELEASE_ENVIRONMENT?.trim();
if (process.env.VERCEL && !/^[0-9a-f]{40}$/.test(release ?? "")) {
  throw new Error("A Vercel build requires the frozen Humans Git SHA");
}
if (
  process.env.VERCEL &&
  releaseEnvironment !== "preview" &&
  releaseEnvironment !== "production"
) {
  throw new Error("A Vercel build requires the Humans release environment");
}

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          ...(release ? [{ key: "X-Humans-Release", value: release }] : []),
          ...(releaseEnvironment
            ? [{ key: "X-Humans-Environment", value: releaseEnvironment }]
            : []),
        ],
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  authToken: process.env.SENTRY_AUTH_TOKEN,
  org: "cueva",
  project: releaseEnvironment === "production" ? "humans" : "humans-preview",
  ...(release ? { release: { name: release } } : {}),
  silent: true,
  sourcemaps: { deleteSourcemapsAfterUpload: true },
  telemetry: false,
  widenClientFileUpload: true,
});
