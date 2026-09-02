import { sql } from "drizzle-orm";
import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { members, organizations } from "./identity";
import { profiles } from "./profiles";

export const savedLists = pgTable("saved_lists", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()::text`),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.clerkId, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdBy: text("created_by")
    .notNull()
    .references(() => members.clerkId),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const savedListEntries = pgTable(
  "saved_list_entries",
  {
    listId: text("list_id")
      .notNull()
      .references(() => savedLists.id, { onDelete: "cascade" }),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.profileId, { onDelete: "cascade" }),
    note: text("note").notNull().default(""),
    addedBy: text("added_by")
      .notNull()
      .references(() => members.clerkId),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.listId, table.profileId] })],
);
