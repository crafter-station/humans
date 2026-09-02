import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addSavedListEntry,
  createSavedList,
  listSavedLists,
  removeSavedListEntry,
  SavedListForbidden,
  updateSavedListEntryNote,
} from "../src/saved-lists";
import * as schema from "../src/schema";

describe("Saved Lists", () => {
  const resources: {
    container?: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
    pool?: Pool;
  } = {};
  let database: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    resources.container = await new PostgreSqlContainer(
      "pgvector/pgvector:pg17",
    ).start();
    resources.pool = new Pool({
      connectionString: resources.container.getConnectionUri(),
    });
    database = drizzle(resources.pool, { schema });
    await migrate(database, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    await database
      .insert(schema.members)
      .values([{ clerkId: "alice" }, { clerkId: "bob" }, { clerkId: "eve" }]);
    await database.insert(schema.organizations).values([
      { clerkId: "acme", name: "Acme" },
      { clerkId: "other", name: "Other" },
    ]);
    await database.insert(schema.organizationMemberships).values([
      {
        clerkId: "m1",
        memberId: "alice",
        organizationId: "acme",
        role: "member",
      },
      {
        clerkId: "m2",
        memberId: "bob",
        organizationId: "acme",
        role: "member",
      },
      {
        clerkId: "m3",
        memberId: "eve",
        organizationId: "other",
        role: "member",
      },
    ]);
    await database.insert(schema.profiles).values({
      profileId: "profile",
      name: "Grace",
      githubAccountId: "1",
      githubLogin: "grace",
      eligibilityBasis: "owned_repository",
      adultAttested: true,
      searchable: true,
      searchabilityReason: "approved_import",
    });
  });
  afterAll(async () => {
    await resources.pool?.end();
    await resources.container?.stop();
  });

  it("shares membership and notes with teammates while isolating organizations", async () => {
    const list = await createSavedList(
      database,
      "alice",
      "acme",
      "Backend builders",
    );
    await addSavedListEntry(database, "alice", "acme", list.id, "profile");
    await addSavedListEntry(database, "alice", "acme", list.id, "profile");
    await updateSavedListEntryNote(
      database,
      "bob",
      "acme",
      list.id,
      "profile",
      "Met at a conference",
    );
    expect(await listSavedLists(database, "alice", "acme")).toMatchObject([
      {
        name: "Backend builders",
        entries: [{ profileId: "profile", note: "Met at a conference" }],
      },
    ]);
    await expect(
      listSavedLists(database, "eve", "acme"),
    ).rejects.toBeInstanceOf(SavedListForbidden);
    await removeSavedListEntry(database, "bob", "acme", list.id, "profile");
    await removeSavedListEntry(database, "bob", "acme", list.id, "profile");
    expect(
      (await listSavedLists(database, "alice", "acme"))[0]?.entries,
    ).toEqual([]);
  });
});
