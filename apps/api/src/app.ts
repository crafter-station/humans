import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { Database, makeDatabaseLayer } from "@humans/database";
import { Scalar } from "@scalar/hono-api-reference";
import { Effect } from "effect";

export type Bindings = {
  DATABASE_URL: string;
};

type DatabaseLayer = ReturnType<typeof makeDatabaseLayer>;
type DatabaseLayerFactory = (bindings: Bindings) => DatabaseLayer;

const healthResponse = z
  .object({
    checks: z.object({
      database: z.literal("ok"),
      pgvector: z.literal("ok"),
    }),
    status: z.literal("ok"),
  })
  .openapi("Health");

const unavailableResponse = z
  .object({
    message: z.literal("Service unavailable"),
    status: z.literal("error"),
  })
  .openapi("ServiceUnavailable");

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  operationId: "getHealth",
  summary: "Check API health",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: healthResponse,
        },
      },
      description: "The API and database are ready",
    },
    503: {
      content: {
        "application/json": {
          schema: unavailableResponse,
        },
      },
      description: "A required service is unavailable",
    },
  },
});

const checkHealth = Effect.fn("checkHealth")(function* () {
  const database = yield* Database;
  yield* database.check;

  return {
    checks: {
      database: "ok",
      pgvector: "ok",
    },
    status: "ok",
  } as const;
});

export const createApp = (databaseLayer: DatabaseLayerFactory) => {
  const app = new OpenAPIHono<{ Bindings: Bindings }>();

  app.openapi(healthRoute, async (context) => {
    try {
      const health = await Effect.runPromise(
        checkHealth().pipe(Effect.provide(databaseLayer(context.env))),
      );
      return context.json(health, 200);
    } catch {
      return context.json(
        { message: "Service unavailable", status: "error" } as const,
        503,
      );
    }
  });

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Humans API",
      version: "0.1.0",
    },
  });

  app.get(
    "/docs",
    Scalar({
      pageTitle: "Humans API Reference",
      url: "/openapi.json",
    }),
  );

  return app;
};
