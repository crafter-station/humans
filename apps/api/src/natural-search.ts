import { z } from "zod";

export const interpretedFiltersSchema = z
  .object({
    query: z.string().trim().min(1).max(120).optional(),
    roles: z.array(z.string().trim().min(1).max(80)).max(5).optional(),
    skills: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
    currentResidences: z
      .array(z.string().trim().min(1).max(80))
      .max(5)
      .optional(),
    companies: z.array(z.string().trim().min(1).max(80)).max(5).optional(),
    seniorities: z
      .array(z.enum(["junior", "mid", "senior", "staff"]))
      .max(4)
      .optional(),
    minimumExperience: z.number().int().min(0).max(60).optional(),
    opportunityStatuses: z
      .array(z.enum(["open", "not_open", "unspecified"]))
      .max(3)
      .optional(),
  })
  .strict()
  .refine((filters) =>
    Object.values(filters).some((value) => value !== undefined),
  );

export type InterpretedFilters = z.infer<typeof interpretedFiltersSchema>;
export type QueryLanguage = "en" | "es" | "pt";
export type NaturalSearchInterpretation = {
  language: QueryLanguage;
  filters: InterpretedFilters;
};

export type NaturalSearchDecoder = (prompt: string) => Promise<unknown>;

type CacheEntry = { expiresAt: number; value: NaturalSearchInterpretation };

export class NaturalSearchError extends Error {
  constructor(
    readonly code: "ambiguous_query" | "invalid_interpretation",
    message: string,
  ) {
    super(message);
  }
}

/** A small process-local cache. Keys are digests: prompts are never retained. */
export class NaturalSearchInterpreter {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly decode: NaturalSearchDecoder,
    private readonly options: {
      capacity?: number;
      ttlMs?: number;
      now?: () => number;
    } = {},
  ) {}

  async interpret(prompt: string): Promise<NaturalSearchInterpretation> {
    const normalized = prompt.normalize("NFKC").trim().replace(/\s+/g, " ");
    if (
      normalized.length < 4 ||
      normalized.length > 500 ||
      /^(all|everyone|anyone|todos?|todas?|qualquer pessoa)$/iu.test(normalized)
    )
      throw new NaturalSearchError(
        "ambiguous_query",
        "Describe at least one specific Profile attribute.",
      );

    const key = await digest(normalized.toLocaleLowerCase());
    const now = (this.options.now ?? Date.now)();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return structuredClone(cached.value);
    if (cached) this.cache.delete(key);

    const decoded = await this.decode(normalized);
    const parsed = z
      .object({
        language: z.enum(["en", "es", "pt"]),
        filters: interpretedFiltersSchema,
      })
      .strict()
      .safeParse(decoded);
    if (!parsed.success)
      throw new NaturalSearchError(
        "invalid_interpretation",
        "The query could not be mapped safely to search filters.",
      );

    const value = parsed.data;
    this.cache.set(key, {
      expiresAt: now + (this.options.ttlMs ?? 5 * 60_000),
      value,
    });
    while (this.cache.size > (this.options.capacity ?? 100))
      this.cache.delete(this.cache.keys().next().value!);
    return structuredClone(value);
  }
}

const digest = async (value: string) => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};
