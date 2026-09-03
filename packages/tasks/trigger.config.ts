import { syncEnvVars } from "@trigger.dev/build/extensions/core";
import { defineConfig } from "@trigger.dev/sdk";

import { captureTaskException } from "./src/sentry.js";

const project = process.env.TRIGGER_PROJECT_REF;

if (project === undefined || project.length === 0) {
  throw new Error("TRIGGER_PROJECT_REF is required");
}

const sentryRelease = process.env.SENTRY_RELEASE;
if (sentryRelease === undefined || !/^[0-9a-f]{40}$/.test(sentryRelease)) {
  throw new Error("SENTRY_RELEASE must be the deployed Git commit");
}

export default defineConfig({
  project,
  dirs: ["./src/trigger"],
  maxDuration: 3600,
  runtime: "node-24",
  build: {
    extensions: [
      syncEnvVars(() => [{ name: "SENTRY_RELEASE", value: sentryRelease }]),
    ],
  },
  onFailure: async ({ error, ctx }) => {
    await captureTaskException(error, {
      taskId: ctx.task.id,
      runId: ctx.run.id,
    });
  },
});
