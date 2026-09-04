import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

const deployedApiHosts = {
  preview: "humans-api-preview.hi-541.workers.dev",
  production: "humans-api-production.hi-541.workers.dev",
} as const;
const releaseEnvironment =
  process.env.HUMANS_RELEASE_ENVIRONMENT ??
  (process.env.VERCEL ? undefined : "local");
const turnstileTestingKeys = new Set([
  "1x00000000000000000000AA",
  "2x00000000000000000000AB",
  "1x00000000000000000000BB",
  "2x00000000000000000000BB",
  "3x00000000000000000000FF",
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);

const apiUrl = z.url().refine((value) => {
  if (releaseEnvironment === "local") return true;
  const expectedHost =
    deployedApiHosts[releaseEnvironment as keyof typeof deployedApiHosts];
  if (!expectedHost) return false;
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash &&
    url.hostname === expectedHost
  );
}, "Deployed HUMANS_API_URL must be an approved HTTPS Worker origin");

const turnstileKey = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) => value.trim() === value && !/\s/.test(value),
    "Turnstile keys cannot contain whitespace",
  )
  .refine(
    (value) =>
      releaseEnvironment === "local" || !turnstileTestingKeys.has(value),
    "Deployed Turnstile credentials cannot use Cloudflare testing keys",
  );

const validatedEnv = createEnv({
  skipValidation:
    process.env.SKIP_ENV_VALIDATION === "1" && releaseEnvironment === "local",
  server: {
    CLERK_SECRET_KEY: z.string().min(1),
    HUMANS_API_URL: apiUrl,
    HUMANS_PROXY_SECRET: z.string().min(16),
    HUMANS_RELEASE_ENVIRONMENT: z.enum(["local", "preview", "production"]),
    TURNSTILE_SECRET_KEY: turnstileKey,
  },
  client: {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: turnstileKey,
  },
  runtimeEnv: {
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    HUMANS_API_URL:
      process.env.HUMANS_API_URL ??
      (releaseEnvironment === "local" ? "http://localhost:8787" : undefined),
    HUMANS_PROXY_SECRET: process.env.HUMANS_PROXY_SECRET,
    HUMANS_RELEASE_ENVIRONMENT: releaseEnvironment,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
    TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY,
  },
  emptyStringAsUndefined: true,
});

if (
  typeof window === "undefined" &&
  releaseEnvironment !== "local" &&
  validatedEnv.NEXT_PUBLIC_TURNSTILE_SITE_KEY ===
    validatedEnv.TURNSTILE_SECRET_KEY
) {
  throw new Error("Deployed Turnstile site and secret keys must be distinct");
}

export const env = validatedEnv;
