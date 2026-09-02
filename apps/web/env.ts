import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  skipValidation: process.env.SKIP_ENV_VALIDATION === "1",
  server: {
    CLERK_SECRET_KEY: z.string().min(1),
    HUMANS_API_URL: z.url().default("http://localhost:8787"),
    HUMANS_PROXY_SECRET: z.string().min(16),
  },
  client: {
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  },
  runtimeEnv: {
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    HUMANS_API_URL: process.env.HUMANS_API_URL,
    HUMANS_PROXY_SECRET: process.env.HUMANS_PROXY_SECRET,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  },
  emptyStringAsUndefined: true,
});
