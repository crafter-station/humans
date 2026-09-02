import { describe, expect, it, vi } from "vitest";

import { NaturalSearchInterpreter } from "../src/natural-search";

const fixtures = [
  [
    "senior TypeScript engineers in Colombia",
    "en",
    {
      roles: ["engineer"],
      skills: ["TypeScript"],
      currentResidences: ["Colombia"],
      seniorities: ["senior"],
    },
  ],
  [
    "desarrolladoras backend en México",
    "es",
    { roles: ["backend developer"], currentResidences: ["Mexico"] },
  ],
  [
    "engenheiros em São Paulo abertos a oportunidades",
    "pt",
    {
      roles: ["engineer"],
      currentResidences: ["São Paulo"],
      opportunityStatuses: ["open"],
    },
  ],
] as const;

describe("NaturalSearchInterpreter", () => {
  it.each(fixtures)(
    "validates the multilingual fixture %s",
    async (prompt, language, filters) => {
      const interpreter = new NaturalSearchInterpreter(async () => ({
        language,
        filters,
      }));
      await expect(interpreter.interpret(prompt)).resolves.toEqual({
        language,
        filters,
      });
    },
  );

  it("rejects adversarial broad prompts without calling the decoder", async () => {
    const decode = vi.fn();
    const interpreter = new NaturalSearchInterpreter(decode);
    await expect(interpreter.interpret("all")).rejects.toMatchObject({
      code: "ambiguous_query",
    });
    expect(decode).not.toHaveBeenCalled();
  });

  it("turns schema failures into a recoverable error", async () => {
    const interpreter = new NaturalSearchInterpreter(async () => ({
      language: "fr",
      filters: {},
    }));
    await expect(
      interpreter.interpret("profils à Paris"),
    ).rejects.toMatchObject({
      code: "invalid_interpretation",
    });
  });

  it("normalizes equivalent prompts and expires bounded cache entries", async () => {
    let now = 0;
    const decode = vi.fn(async () => ({
      language: "en",
      filters: { skills: ["Rust"] },
    }));
    const interpreter = new NaturalSearchInterpreter(decode, {
      capacity: 1,
      ttlMs: 10,
      now: () => now,
    });
    await interpreter.interpret("  Rust   developers ");
    await interpreter.interpret("rust developers");
    expect(decode).toHaveBeenCalledTimes(1);
    now = 11;
    await interpreter.interpret("rust developers");
    expect(decode).toHaveBeenCalledTimes(2);
    await interpreter.interpret("Go developers");
    await interpreter.interpret("rust developers");
    expect(decode).toHaveBeenCalledTimes(4);
  });
});
