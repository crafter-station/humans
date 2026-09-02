import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  invalidateContactDetail,
  recordVerifiedContactDetail,
  revealContactDetail,
} from "../src/contact-reveals";
import { applyCreditEntry, getCreditBalance } from "../src/credits";
import * as schema from "../src/schema";

describe("Organization-scoped Contact Reveals", () => {
  const resources: {
    container?: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
    pool?: Pool;
  } = {};
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let profileId: string;

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
      .values([{ clerkId: "member_reveals" }, { clerkId: "member_outsider" }]);
    await database.insert(schema.organizations).values([
      { clerkId: "organization_reveals", name: "Reveals" },
      { clerkId: "organization_other", name: "Other" },
    ]);
    await database.insert(schema.organizationMemberships).values({
      clerkId: "membership_reveals",
      memberId: "member_reveals",
      organizationId: "organization_reveals",
      role: "member",
    });
    const [profile] = await database
      .insert(schema.profiles)
      .values({
        name: "Ada",
        githubAccountId: "github_contact_ada",
        githubLogin: "ada",
        eligibilityBasis: "owned_repository",
        adultAttested: true,
        searchable: true,
        searchabilityReason: "approved_import",
      })
      .returning();
    profileId = profile!.profileId;
    await applyCreditEntry(database, {
      organizationId: "organization_reveals",
      idempotencyKey: "grant:reveals",
      kind: "grant",
      amount: 5,
    });
  });

  afterAll(async () => {
    await resources.pool?.end();
    await resources.container?.stop();
  });

  it("accepts only provider-verified professional Contact Details", async () => {
    await expect(
      recordVerifiedContactDetail(database, {
        profileId,
        kind: "phone",
        value: "+51 555 0100",
        source: "provider",
        sourceRecordId: "switchboard",
        category: "professional",
        verification: "provider-verified",
        direct: false,
        verifiedAt: new Date(),
      }),
    ).rejects.toThrow("contact_detail_not_eligible");
  });

  it("charges once and shares an active reveal only inside its Organization", async () => {
    const detail = await recordVerifiedContactDetail(database, {
      profileId,
      kind: "email",
      value: "ada@example.com",
      source: "provider",
      sourceRecordId: "work-email",
      category: "professional",
      verification: "provider-verified",
      verifiedAt: new Date("2026-09-01T00:00:00Z"),
    });
    const input = {
      memberId: "member_reveals",
      organizationId: "organization_reveals",
      contactDetailId: detail.id,
    };
    const results = await Promise.all([
      revealContactDetail(database, input),
      revealContactDetail(database, input),
    ]);

    expect(results.filter(({ charged }) => charged)).toHaveLength(1);
    expect(results[0]?.detail.value).toBe("ada@example.com");
    expect(await getCreditBalance(database, "organization_reveals")).toBe(4);
    await expect(
      revealContactDetail(database, {
        ...input,
        memberId: "member_outsider",
        organizationId: "organization_other",
      }),
    ).rejects.toThrow("contact_detail_unavailable");

    const invalidated = await invalidateContactDetail(database, detail.id);
    expect(invalidated.refundedReveals).toBe(1);
    expect(await getCreditBalance(database, "organization_reveals")).toBe(5);
    await expect(revealContactDetail(database, input)).rejects.toThrow(
      "contact_detail_unavailable",
    );
    expect(
      await database
        .select()
        .from(schema.creditLedgerEntries)
        .where(
          eq(schema.creditLedgerEntries.referenceId, results[0]!.reveal.id),
        ),
    ).toHaveLength(2);
  });
});
