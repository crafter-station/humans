import { withTikHubRuntime } from "../src/runtime.js";

const [profileId, linkedInUrl, runId] = process.argv.slice(2);
if (!profileId || !linkedInUrl || !runId)
  throw new Error("Pass profileId, linkedInUrl, and runId");

const input = { profileId, linkedInUrl, runId };
const run = await withTikHubRuntime(async (stages) => {
  await stages.fetch(input);
  await stages.normalization(input);
  return stages.persistence(input);
});

console.log(
  JSON.stringify(
    {
      runId: run.id,
      status: run.status,
      completedStages: run.completedStages,
    },
    null,
    2,
  ),
);
