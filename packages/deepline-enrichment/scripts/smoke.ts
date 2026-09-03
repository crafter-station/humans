import { createDeeplineProvider } from "../src/provider.js";

if (process.env.RUN_LIVE_PROVIDER_SMOKE !== "1")
  throw new Error("Set RUN_LIVE_PROVIDER_SMOKE=1 to run a live provider smoke");

const apiKey = required("DEEPLINE_API_KEY");
const fullName = required("DEEPLINE_SMOKE_FULL_NAME");
let requestCount = 0;
const provider = createDeeplineProvider({
  apiKey,
  fetch: async (input, init) => {
    requestCount += 1;
    if (requestCount > 3)
      throw new Error("Deepline smoke request cap exceeded");
    return fetch(input, {
      ...init,
      signal: AbortSignal.timeout(15_000),
    });
  },
});

const result = await provider.resolveIdentity({
  fullName,
  ...(process.env.DEEPLINE_SMOKE_COMPANY?.trim()
    ? { companyName: process.env.DEEPLINE_SMOKE_COMPANY.trim() }
    : {}),
});

console.log(
  JSON.stringify({
    provider: "deepline",
    requestCount,
    discoveryDescriptionExecutionCompleted: requestCount === 3,
    contractValidated: result.toolId.length > 0,
    professionalLinkCount: [
      result.value.linkedinUrl,
      result.value.githubUrl,
      result.value.xUrl,
    ].filter((value) => value !== null).length,
  }),
);

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
