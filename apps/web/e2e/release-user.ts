import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type ReleaseUser = {
  email: string;
  organizationId?: string;
  userId?: string;
};

const releaseUserFile = resolve("playwright/.clerk/release-user.json");
export const previewStorageStateFile = resolve(
  "playwright/.clerk/preview.json",
);

export const readReleaseUser = (): ReleaseUser | null => {
  if (!existsSync(releaseUserFile)) return null;
  return JSON.parse(readFileSync(releaseUserFile, "utf8")) as ReleaseUser;
};

export const writeReleaseUser = (user: ReleaseUser) => {
  mkdirSync(dirname(releaseUserFile), { recursive: true });
  writeFileSync(releaseUserFile, JSON.stringify(user));
};

export const cleanupReleaseUser = async (secretKey: string) => {
  const tracked = readReleaseUser();
  if (tracked === null) return;

  const userIds = tracked.userId
    ? [tracked.userId]
    : await findClerkUsers(tracked.email, secretKey);
  const candidateOrganizationIds = tracked.organizationId
    ? [tracked.organizationId]
    : (
        await Promise.all(
          userIds.map((userId) =>
            findClerkOrganizationMemberships(userId, secretKey),
          ),
        )
      ).flat();
  for (const organizationId of new Set(candidateOrganizationIds)) {
    if (
      await clerkOrganizationWasCreatedBy(organizationId, userIds, secretKey)
    ) {
      await deleteClerkResource("organizations", organizationId, secretKey);
    }
  }

  for (const userId of userIds) {
    await deleteClerkResource("users", userId, secretKey);
  }
  await unlink(releaseUserFile);
};

const clerkHeaders = (secretKey: string) => ({
  authorization: `Bearer ${secretKey}`,
  "content-type": "application/json",
});

const findClerkUsers = async (email: string, secretKey: string) => {
  const url = new URL("https://api.clerk.com/v1/users");
  url.searchParams.append("email_address", email);
  const response = await fetch(url, { headers: clerkHeaders(secretKey) });
  if (!response.ok) throw new Error("Clerk test identity lookup failed");
  const result = (await response.json()) as Array<{ id: string }>;
  return result.map(({ id }) => id);
};

const findClerkOrganizationMemberships = async (
  userId: string,
  secretKey: string,
) => {
  const url = new URL(
    `https://api.clerk.com/v1/users/${encodeURIComponent(userId)}/organization_memberships`,
  );
  url.searchParams.set("limit", "100");
  const response = await fetch(url, { headers: clerkHeaders(secretKey) });
  if (!response.ok) throw new Error("Clerk test membership lookup failed");
  const result = (await response.json()) as {
    data: Array<{ organization: { id: string } }>;
  };
  return result.data.map(({ organization }) => organization.id);
};

const clerkOrganizationWasCreatedBy = async (
  organizationId: string,
  userIds: string[],
  secretKey: string,
) => {
  const response = await fetch(
    `https://api.clerk.com/v1/organizations/${encodeURIComponent(organizationId)}`,
    { headers: clerkHeaders(secretKey) },
  );
  if (response.status === 404) return false;
  if (!response.ok) throw new Error("Clerk test organization lookup failed");
  const organization = (await response.json()) as {
    created_by?: string | null;
  };
  return (
    organization.created_by !== null &&
    organization.created_by !== undefined &&
    userIds.includes(organization.created_by)
  );
};

export const removePreviewStorageState = () =>
  rm(previewStorageStateFile, { force: true });

const deleteClerkResource = async (
  resource: "organizations" | "users",
  id: string,
  secretKey: string,
) => {
  const response = await fetch(
    `https://api.clerk.com/v1/${resource}/${encodeURIComponent(id)}`,
    { method: "DELETE", headers: clerkHeaders(secretKey) },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Clerk test ${resource} cleanup failed`);
  }
};
