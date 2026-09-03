import { TikHubLinkedInProvider } from "../src/provider.js";

if (process.env.RUN_LIVE_PROVIDER_SMOKE !== "1")
  throw new Error("Set RUN_LIVE_PROVIDER_SMOKE=1 to run a live provider smoke");

const apiKey = process.env.TIKHUB_API_KEY?.trim();
const linkedInUrl = process.argv[2]?.trim();

if (!apiKey) throw new Error("TIKHUB_API_KEY is required");
if (!linkedInUrl) throw new Error("Pass a LinkedIn profile URL");

let requestCount = 0;
const profile = await new TikHubLinkedInProvider({
  apiKey,
  fetch: async (input, init) => {
    requestCount += 1;
    if (requestCount > 1) throw new Error("TikHub smoke request cap exceeded");
    return fetch(input, {
      ...init,
      signal: AbortSignal.timeout(15_000),
    });
  },
}).getLinkedInProfile(linkedInUrl);

console.log(
  JSON.stringify(
    {
      provider: "tikhub",
      requestCount,
      contractValidated: profile.sourceRecordId.length > 0,
      headlinePresent: profile.headline !== null,
      currentCompanyPresent: profile.currentCompany !== null,
      experienceCount: profile.experience.length,
      educationCount: profile.education.length,
      skillsCount: profile.skills.length,
      supportedContactCount: profile.contacts.length,
    },
    null,
    2,
  ),
);
