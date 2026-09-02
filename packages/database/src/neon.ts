import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { Effect, Layer } from "effect";

import { Database, makeDatabaseService } from "./service";
import * as schema from "./schema";

export const makeNeonDatabaseLayer = (
  databaseUrl: string,
  searchCursorSecret?: string,
) =>
  Layer.effect(
    Database,
    Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: databaseUrl })),
      (pool) => Effect.promise(() => pool.end()),
    ).pipe(
      Effect.map((pool) =>
        makeDatabaseService(drizzle(pool, { schema }), searchCursorSecret),
      ),
    ),
  );
