import { defineConfig } from "@trigger.dev/sdk";

const project = process.env.TRIGGER_PROJECT_REF;

if (project === undefined || project.length === 0) {
  throw new Error("TRIGGER_PROJECT_REF is required");
}

export default defineConfig({
  project,
  dirs: ["./src/trigger"],
  maxDuration: 3600,
  runtime: "node-24",
});
