import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanupReleaseUser, writeReleaseUser } from "../e2e/release-user";

describe("release Member cleanup", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm("playwright/.clerk", { force: true, recursive: true });
  });

  it("deletes only Organizations created by the disposable Member", async () => {
    writeReleaseUser({ email: "release@example.com" });
    const requests: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        requests.push({ method, url });
        if (url.includes("/v1/users?"))
          return Response.json([{ id: "user_release" }]);
        if (url.endsWith("/organization_memberships?limit=100"))
          return Response.json({
            data: [
              { organization: { id: "org_personal" } },
              { organization: { id: "org_shared" } },
            ],
          });
        if (url.endsWith("/organizations/org_personal"))
          return Response.json({ created_by: "user_release" });
        if (url.endsWith("/organizations/org_shared"))
          return Response.json({ created_by: "another_member" });
        if (method === "DELETE") return Response.json({ deleted: true });
        throw new Error(`Unexpected Clerk request: ${method} ${url}`);
      }),
    );

    await cleanupReleaseUser("test_secret");

    expect(requests).toContainEqual({
      method: "DELETE",
      url: "https://api.clerk.com/v1/organizations/org_personal",
    });
    expect(requests).toContainEqual({
      method: "DELETE",
      url: "https://api.clerk.com/v1/users/user_release",
    });
    expect(requests).not.toContainEqual({
      method: "DELETE",
      url: "https://api.clerk.com/v1/organizations/org_shared",
    });
  });

  it("does not trust a tracked Organization without creator ownership", async () => {
    writeReleaseUser({
      email: "release@example.com",
      organizationId: "org_shared",
      userId: "user_release",
    });
    const requests: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        requests.push({ method, url });
        if (url.endsWith("/organizations/org_shared"))
          return Response.json({ created_by: "another_member" });
        if (method === "DELETE") return Response.json({ deleted: true });
        throw new Error(`Unexpected Clerk request: ${method} ${url}`);
      }),
    );

    await cleanupReleaseUser("test_secret");

    expect(requests).not.toContainEqual({
      method: "DELETE",
      url: "https://api.clerk.com/v1/organizations/org_shared",
    });
    expect(requests).toContainEqual({
      method: "DELETE",
      url: "https://api.clerk.com/v1/users/user_release",
    });
  });
});
