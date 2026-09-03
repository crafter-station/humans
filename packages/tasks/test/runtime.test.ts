import { describe, expect, it } from "vitest";

import {
  readDatabaseEnvironment,
  readDeeplineEnvironment,
  readGitHubEnvironment,
  readTikHubEnvironment,
} from "../src/runtime.js";

const database = { DATABASE_URL: "postgresql://example.invalid/humans" };

describe("lazy task runtime environment", () => {
  it("validates only when a provider runtime is requested", () => {
    expect(() => readDatabaseEnvironment({})).toThrow("DATABASE_URL");
    expect(() => readGitHubEnvironment(database)).toThrow(
      "GITHUB_ENRICHMENT_TOKEN",
    );
    expect(() =>
      readGitHubEnvironment({
        ...database,
        GITHUB_ENRICHMENT_TOKEN: "github-token",
        OPENAI_API_KEY: "openai-key",
      }),
    ).toThrow("OPENAI_MODEL");
    expect(() => readTikHubEnvironment(database)).toThrow("TIKHUB_API_KEY");
    expect(() => readDeeplineEnvironment(database)).toThrow("DEEPLINE_API_KEY");
  });

  it("returns trimmed, provider-scoped credentials", () => {
    expect(
      readGitHubEnvironment({
        ...database,
        GITHUB_ENRICHMENT_TOKEN: " github-token ",
        OPENAI_API_KEY: " openai-key ",
        OPENAI_MODEL: " gpt-5-mini ",
      }),
    ).toMatchObject({
      githubToken: "github-token",
      openAiApiKey: "openai-key",
      openAiModel: "gpt-5-mini",
    });
  });
});
