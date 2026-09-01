import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { makeDatabaseLayer } from "@humans/database";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";

describe("Humans API", () => {
  const resources: {
    container?: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
    pool?: Pool;
  } = {};
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    resources.container = await new PostgreSqlContainer(
      "pgvector/pgvector:pg17",
    ).start();
    resources.pool = new Pool({
      connectionString: resources.container.getConnectionUri(),
    });

    const database = drizzle(resources.pool);
    await migrate(database, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/database/drizzle", import.meta.url),
      ),
    });
    app = createApp(() => makeDatabaseLayer(database));
  });

  afterAll(async () => {
    await resources.pool?.end();
    await resources.container?.stop();
  });

  it("serves health and public API documentation from an initialized database", async () => {
    const healthResponse = await app.request("/health");
    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toEqual({
      checks: {
        database: "ok",
        pgvector: "ok",
      },
      status: "ok",
    });

    const openApiResponse = await app.request("/openapi.json");
    expect(openApiResponse.status).toBe(200);
    const openApi = await openApiResponse.json();
    expect(openApi).toMatchObject({
      info: { title: "Humans API" },
      paths: { "/health": {} },
    });
    expect(JSON.stringify(openApi)).not.toContain("Profile");

    const documentationResponse = await app.request("/docs");
    expect(documentationResponse.status).toBe(200);
    await expect(documentationResponse.text()).resolves.toContain(
      "Humans API Reference",
    );
  });
});
