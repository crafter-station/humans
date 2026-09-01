import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { Database, makeDatabaseLayer } from "@humans/database";
import { Scalar } from "@scalar/hono-api-reference";
import { Effect } from "effect";

import { clerkIdentityBoundary, type IdentityBoundary } from "./clerk";

export type Bindings = {
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_SECRET_KEY: string;
  CLERK_WEBHOOK_SIGNING_SECRET: string;
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

const errorResponse = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

const profileInput = z.object({
  name: z.string().trim().min(1),
  currentCompany: z.string().trim().min(1).nullable(),
  professionalLinks: z.array(z.url()).min(1),
  statements: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  adultAttestation: z.boolean(),
  privateCodeAttestation: z.boolean(),
  searchable: z.boolean(),
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

export const createApp = (
  databaseLayer: DatabaseLayerFactory,
  identity: IdentityBoundary = clerkIdentityBoundary,
) => {
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

  app.post("/webhooks/clerk", async (context) => {
    let event;
    try {
      event = await identity.verifyWebhook(context.req.raw, context.env);
    } catch {
      return context.json(
        {
          error: {
            code: "invalid_webhook_signature",
            message: "The webhook signature is invalid",
          },
        },
        400,
      );
    }

    if (event === null) return context.json({ processed: false }, 200);

    try {
      const processed = await Effect.runPromise(
        Effect.gen(function* () {
          const database = yield* Database;
          return yield* database.projectClerkEvent(event);
        }).pipe(Effect.provide(databaseLayer(context.env))),
      );
      return context.json({ processed }, 200);
    } catch {
      return context.json(
        {
          error: {
            code: "service_unavailable",
            message: "Service unavailable",
          },
        },
        503,
      );
    }
  });

  app.post("/v1/workspace", async (context) => {
    const session = await identity.authenticate(context.req.raw, context.env);
    if (session === null) return unauthorized(context);

    try {
      const workspace = await Effect.runPromise(
        Effect.gen(function* () {
          const database = yield* Database;
          return yield* database.provisionWorkspace(session.memberId, () =>
            identity.provisionPersonalOrganization(
              session.memberId,
              context.env,
              session.organizationId ?? undefined,
            ),
          );
        }).pipe(Effect.provide(databaseLayer(context.env))),
      );
      return context.json(workspace, 200);
    } catch {
      return context.json(
        {
          error: {
            code: "service_unavailable",
            message: "Service unavailable",
          },
        },
        503,
      );
    }
  });

  app.get("/v1/organizations/:organizationId/workspace", async (context) => {
    const session = await identity.authenticate(context.req.raw, context.env);
    if (session === null) return unauthorized(context);

    const organizationId = context.req.param("organizationId");
    if (session.organizationId !== organizationId) return forbidden(context);

    try {
      const workspace = await Effect.runPromise(
        Effect.gen(function* () {
          const database = yield* Database;
          return yield* database.getWorkspace(session.memberId, organizationId);
        }).pipe(Effect.provide(databaseLayer(context.env))),
      );
      return context.json(workspace, 200);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        error._tag === "WorkspaceForbidden"
      ) {
        return forbidden(context);
      }
      return context.json(
        {
          error: {
            code: "service_unavailable",
            message: "Service unavailable",
          },
        },
        503,
      );
    }
  });

  app.get("/v1/profile", async (context) => {
    const session = await identity.authenticate(context.req.raw, context.env);
    if (session === null) return unauthorized(context);

    try {
      const profile = await Effect.runPromise(
        Effect.gen(function* () {
          const database = yield* Database;
          return yield* database.getProfile(session.memberId);
        }).pipe(Effect.provide(databaseLayer(context.env))),
      );
      return context.json({ profile }, 200);
    } catch {
      return serviceUnavailable(context);
    }
  });

  app.put("/v1/profile", async (context) => {
    const session = await identity.authenticate(context.req.raw, context.env);
    if (session === null) return unauthorized(context);
    const parsed = profileInput.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) return invalidProfile(context, "invalid_profile");

    try {
      const github = await identity.verifyGitHub(session.memberId, context.env);
      const profile = await Effect.runPromise(
        Effect.gen(function* () {
          const database = yield* Database;
          return yield* database.saveProfile(
            session.memberId,
            parsed.data,
            github,
          );
        }).pipe(Effect.provide(databaseLayer(context.env))),
      );
      return context.json({ profile }, 200);
    } catch (error) {
      return taggedReason(error) === null
        ? serviceUnavailable(context)
        : invalidProfile(context, taggedReason(error)!);
    }
  });

  app.patch("/v1/profile/searchability", async (context) => {
    const session = await identity.authenticate(context.req.raw, context.env);
    if (session === null) return unauthorized(context);
    const parsed = z
      .object({ searchable: z.literal(false) })
      .safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return invalidProfile(context, "invalid_profile");

    try {
      const profile = await Effect.runPromise(
        Effect.gen(function* () {
          const database = yield* Database;
          return yield* database.disableProfileSearchability(session.memberId);
        }).pipe(Effect.provide(databaseLayer(context.env))),
      );
      return context.json({ profile }, 200);
    } catch (error) {
      return taggedReason(error) === null
        ? serviceUnavailable(context)
        : invalidProfile(context, taggedReason(error)!);
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

const unauthorized = (context: {
  json: (body: z.infer<typeof errorResponse>, status: 401) => Response;
}) =>
  context.json(
    { error: { code: "unauthorized", message: "Authentication is required" } },
    401,
  );

const forbidden = (context: {
  json: (body: z.infer<typeof errorResponse>, status: 403) => Response;
}) =>
  context.json(
    { error: { code: "forbidden", message: "Organization access is denied" } },
    403,
  );

const invalidProfile = (
  context: {
    json: (body: z.infer<typeof errorResponse>, status: 422) => Response;
  },
  reason: string,
) =>
  context.json(
    {
      error: {
        code: reason,
        message: "The Profile does not meet the requirements",
      },
    },
    422,
  );

const serviceUnavailable = (context: {
  json: (body: z.infer<typeof errorResponse>, status: 503) => Response;
}) =>
  context.json(
    { error: { code: "service_unavailable", message: "Service unavailable" } },
    503,
  );

const taggedReason = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "ProfileRejected" &&
  "reason" in error &&
  typeof error.reason === "string"
    ? error.reason
    : null;
