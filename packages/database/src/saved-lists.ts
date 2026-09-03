import { and, asc, eq } from "drizzle-orm";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  organizationMemberships,
  profiles,
  savedListEntries,
  savedLists,
} from "./schema";

type Database =
  | NeonDatabase<typeof import("./schema")>
  | NodePgDatabase<typeof import("./schema")>;

export class SavedListForbidden extends Error {}
export class SavedListNotFound extends Error {}

export type SavedList = {
  id: string;
  name: string;
  entries: Array<{ profileId: string; profileName: string; note: string }>;
};

const requireMembership = async (
  database: Database,
  memberId: string,
  organizationId: string,
) => {
  const [membership] = await database
    .select({ memberId: organizationMemberships.memberId })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.memberId, memberId),
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.active, true),
      ),
    )
    .limit(1);
  if (membership === undefined) throw new SavedListForbidden();
};

const requireList = async (
  database: Database,
  memberId: string,
  organizationId: string,
  listId: string,
) => {
  await requireMembership(database, memberId, organizationId);
  const [list] = await database
    .select()
    .from(savedLists)
    .where(
      and(
        eq(savedLists.id, listId),
        eq(savedLists.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (list === undefined) throw new SavedListNotFound();
  return list;
};

export const listSavedLists = async (
  database: Database,
  memberId: string,
  organizationId: string,
): Promise<SavedList[]> => {
  await requireMembership(database, memberId, organizationId);
  const lists = await database
    .select()
    .from(savedLists)
    .where(eq(savedLists.organizationId, organizationId))
    .orderBy(asc(savedLists.createdAt));
  if (lists.length === 0) return [];
  const entries = await database
    .select({
      listId: savedListEntries.listId,
      profileId: savedListEntries.profileId,
      profileName: profiles.name,
      note: savedListEntries.note,
    })
    .from(savedListEntries)
    .innerJoin(profiles, eq(profiles.profileId, savedListEntries.profileId));
  return lists.map((list) => ({
    id: list.id,
    name: list.name,
    entries: entries
      .filter((entry) => entry.listId === list.id)
      .map((entry) => ({
        profileId: entry.profileId,
        profileName: entry.profileName,
        note: entry.note,
      })),
  }));
};

export const createSavedList = async (
  database: Database,
  memberId: string,
  organizationId: string,
  name: string,
) => {
  await requireMembership(database, memberId, organizationId);
  const [list] = await database
    .insert(savedLists)
    .values({ organizationId, createdBy: memberId, name: name.trim() })
    .returning();
  if (!list) throw new Error("saved_list_insert_failed");
  return list;
};

export const renameSavedList = async (
  database: Database,
  memberId: string,
  organizationId: string,
  listId: string,
  name: string,
) => {
  await requireList(database, memberId, organizationId, listId);
  const [list] = await database
    .update(savedLists)
    .set({ name: name.trim(), updatedAt: new Date() })
    .where(eq(savedLists.id, listId))
    .returning();
  if (!list) throw new Error("saved_list_update_failed");
  return list;
};

export const deleteSavedList = async (
  database: Database,
  memberId: string,
  organizationId: string,
  listId: string,
) => {
  await requireList(database, memberId, organizationId, listId);
  await database.delete(savedLists).where(eq(savedLists.id, listId));
};

export const addSavedListEntry = async (
  database: Database,
  memberId: string,
  organizationId: string,
  listId: string,
  profileId: string,
) => {
  await requireList(database, memberId, organizationId, listId);
  const [profile] = await database
    .select({ id: profiles.profileId })
    .from(profiles)
    .where(
      and(eq(profiles.profileId, profileId), eq(profiles.searchable, true)),
    )
    .limit(1);
  if (profile === undefined) throw new SavedListNotFound();
  await database
    .insert(savedListEntries)
    .values({ listId, profileId, addedBy: memberId })
    .onConflictDoNothing();
};

export const removeSavedListEntry = async (
  database: Database,
  memberId: string,
  organizationId: string,
  listId: string,
  profileId: string,
) => {
  await requireList(database, memberId, organizationId, listId);
  await database
    .delete(savedListEntries)
    .where(
      and(
        eq(savedListEntries.listId, listId),
        eq(savedListEntries.profileId, profileId),
      ),
    );
};

export const updateSavedListEntryNote = async (
  database: Database,
  memberId: string,
  organizationId: string,
  listId: string,
  profileId: string,
  note: string,
) => {
  await requireList(database, memberId, organizationId, listId);
  const [entry] = await database
    .update(savedListEntries)
    .set({ note, updatedAt: new Date() })
    .where(
      and(
        eq(savedListEntries.listId, listId),
        eq(savedListEntries.profileId, profileId),
      ),
    )
    .returning();
  if (entry === undefined) throw new SavedListNotFound();
};
