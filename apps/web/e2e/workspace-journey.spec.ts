import { expect, type Page, test } from "@playwright/test";

import {
  assertWorkspaceRequiresAuthentication,
  authenticateImpersonatedMember,
  setupClerkTestingTokenSafely,
  signOutAndVerify,
  verifyPersonalOrganization,
} from "./browser-auth";
import {
  environmentForProject,
  prepareDeploymentContext,
  type ReleaseEnvironment,
  requiredClerkId,
  requiredEnvironment,
  requiredHttpsUrl,
  requiredUuid,
} from "./deployment";
import {
  releaseUserCredentialsFromEnvironment,
  writeReleaseUser,
} from "./release-user";

test.describe.configure({ mode: "serial" });

const publicProductionUrl = "https://humns.co/";

type WorkspaceIdentity = {
  memberId: string;
  organizationId: string;
};

test("anonymous access remains private and non-indexable", async ({
  page,
}, testInfo) => {
  const environment = environmentForProject(testInfo.project.name);
  const { bypassed, url } = await prepareDeploymentContext(
    page.context(),
    environment,
  );

  const root = await page.goto(url.href);
  expect(root?.status()).toBe(200);
  assertDeploymentHeaders(root?.headers(), environment);
  await assertWorkspaceRequiresAuthentication(page, url);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    "noindex, nofollow",
  );
  if (bypassed) {
    expect(
      await page.evaluate(() =>
        document.cookie
          .split(";")
          .some((cookie) => cookie.trim().startsWith("_vercel_jwt=")),
      ),
    ).toBe(false);
  }

  const robots = await page.request.get(new URL("/robots.txt", url).href);
  expect(robots.status()).toBe(200);
  expect(robots.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(robots.headers()["cache-control"]).toBe(
    "public, max-age=0, must-revalidate",
  );
  expect((await robots.text()).trimEnd()).toBe("User-Agent: *\nDisallow: /");

  const profile = await page.request.get(new URL("/api/profile", url).href, {
    maxRedirects: 0,
  });
  expect(profile.status()).toBe(401);
  expect(profile.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(profile.headers()["cache-control"]).toBe("private, no-store");
  expect(await profile.json()).toEqual({
    error: { code: "unauthorized", message: "Authentication is required" },
  });
});

test("a disposable Member can use the core Organization journey", async ({
  page,
}, testInfo) => {
  const environment = environmentForProject(testInfo.project.name);
  const { url } = await prepareDeploymentContext(page.context(), environment);
  if (environment === "production" && url.href === publicProductionUrl) {
    test.skip(
      true,
      "The public post-promotion pass must not reuse the deleted core fixture",
    );
  }

  let authenticated = false;
  try {
    const identity =
      environment === "preview"
        ? await signUpPreviewMember(page, url)
        : await signInProductionMember(page, url);
    authenticated = true;
    await verifyPersonalOrganization({
      ...identity,
      secretKey: requiredEnvironment("CLERK_SECRET_KEY"),
    });
    await assertWorkspaceProjection(page, identity);

    const operations = await page.goto(new URL("/operations", url).href);
    expect(operations?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: "Directory control room" }),
    ).not.toBeVisible();
    await page.goto(new URL("/workspace", url).href);

    await runCoreWorkspaceJourney(page, environment);
  } finally {
    if (authenticated && !page.isClosed()) {
      await signOutAndVerify(page, url);
    }
  }
});

const signUpPreviewMember = async (
  page: Page,
  deployment: URL,
): Promise<WorkspaceIdentity> => {
  await setupClerkTestingTokenSafely(page);
  const nonce = `${Date.now()}-${crypto.randomUUID()}`;
  const email = `humans-release-${nonce}+clerk_test@example.com`;
  const password = `Humans-release-${nonce}!Aa1`;
  const credentials = releaseUserCredentialsFromEnvironment();
  writeReleaseUser({ email }, credentials);

  await page.goto(deployment.href);
  await page.getByRole("button", { name: "Join Humans" }).click();
  await page.locator(".cl-signUp-root").waitFor({ state: "attached" });
  await page.locator('input[name="emailAddress"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Enter verification code" })
    .pressSequentially("424242");

  await page.waitForFunction(() => Boolean(window.Clerk?.user?.id));
  const userId = await page.evaluate(() => window.Clerk?.user?.id);
  if (!userId) throw new Error("Clerk did not expose the signed-up Member ID");
  writeReleaseUser({ email, userId }, credentials);

  await expect(
    page.getByRole("heading", { name: "Find the people behind the code." }),
  ).toBeVisible();
  await page.goto(new URL("/workspace", deployment).href);
  await expect(
    page.getByRole("heading", { name: "What brings you to Humans?" }),
  ).toBeVisible();
  await page.waitForFunction(() => Boolean(window.Clerk?.organization?.id));
  const organizationId = await page.evaluate(
    () => window.Clerk?.organization?.id,
  );
  if (!organizationId) {
    throw new Error("Clerk did not activate the personal Organization");
  }
  writeReleaseUser({ email, organizationId, userId }, credentials);
  return { memberId: userId, organizationId };
};

const signInProductionMember = async (
  page: Page,
  deployment: URL,
): Promise<WorkspaceIdentity> => {
  const expectedMemberId = requiredClerkId("E2E_PRODUCTION_MEMBER_ID", "user");
  const expectedOrganizationId = requiredClerkId(
    "E2E_PRODUCTION_ORGANIZATION_ID",
    "org",
  );
  const impersonationUrl = requiredHttpsUrl(
    "E2E_PRODUCTION_MEMBER_IMPERSONATION_URL",
  );

  await authenticateImpersonatedMember(
    page,
    deployment.href,
    impersonationUrl,
    expectedMemberId,
    expectedOrganizationId,
  );
  await page.goto(new URL("/workspace", deployment).href);
  return {
    memberId: expectedMemberId,
    organizationId: expectedOrganizationId,
  };
};

const runCoreWorkspaceJourney = async (
  page: Page,
  environment: ReleaseEnvironment,
) => {
  await expect(
    page.getByRole("heading", { name: "What brings you to Humans?" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open organization switcher" }),
  ).toBeVisible();

  const billing = page.getByRole("region", { name: "Organization billing" });
  await expect(billing).toContainText("Free");
  if (environment === "preview") {
    await expect(billing).toContainText("100 Credits");
  }
  const creditsBeforeSearch = await readCredits(billing);
  if (creditsBeforeSearch < 1) {
    throw new Error("The disposable Organization has no Credits for search");
  }

  await page.getByRole("button", { name: "Search Humans" }).click();
  await page
    .getByLabel("Search", { exact: true })
    .fill(requiredEnvironment("E2E_PROFILE_QUERY"));
  await expect.poll(() => readSavedLists(page)).toEqual([]);
  const searchResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/v1/profiles/search",
  );
  await page.getByRole("button", { name: "Apply filters" }).click();
  await assertUniqueExpectedSearchResult(
    await searchResponse,
    requiredUuid("HUMANS_ACCEPTANCE_PROFILE_ID"),
  );
  const results = page.locator("tbody tr");
  await expect(results).toHaveCount(1);
  const expectedResult = results.first();
  await expect(expectedResult).toBeVisible();
  await expect.poll(() => readCredits(billing)).toBe(creditsBeforeSearch - 1);

  const listName = `${environment} release ${crypto.randomUUID()}`;
  const renamedListName = `${listName} restored`;
  let listId: string | undefined;
  try {
    const createResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/saved-lists",
    );
    await withPrompt(
      page,
      () => expectedResult.getByRole("button", { name: "+ Save" }).click(),
      listName,
    );
    listId = parseCreatedListId(await (await createResponse).json());
    await expect(
      page.getByText("Saved List created and Profile added."),
    ).toBeVisible();
    await expect(
      expectedResult.getByRole("button", { name: "Saved" }),
    ).toBeVisible();

    await expectedResult.locator("td").first().getByRole("button").click();
    const selectedExpectedProfile = await page.evaluate(
      (profileId) =>
        new URL(window.location.href).searchParams.get("profile") === profileId,
      requiredUuid("HUMANS_ACCEPTANCE_PROFILE_ID"),
    );
    if (!selectedExpectedProfile) {
      throw new Error("The expected Profile detail was not selected");
    }
    await page.getByLabel("Team note").fill("Browser acceptance note");
    await page.getByRole("button", { name: "Save note" }).click();
    await expect(page.getByText("Team note saved.")).toBeVisible();
    const reloadedSearchResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === "/v1/profiles/search",
    );
    await page.reload();
    await assertUniqueExpectedSearchResult(
      await reloadedSearchResponse,
      requiredUuid("HUMANS_ACCEPTANCE_PROFILE_ID"),
    );
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.getByLabel("Team note")).toHaveValue(
      "Browser acceptance note",
    );
    await page.getByRole("button", { name: "Close" }).click();

    await withPrompt(
      page,
      () => page.getByRole("button", { name: "Rename" }).click(),
      renamedListName,
    );
    await expect(page.getByText("Saved List renamed.")).toBeVisible();
    await expect
      .poll(async () =>
        (await readSavedLists(page)).some(
          (list) => list.id === listId && list.name === renamedListName,
        ),
      )
      .toBe(true);

    const reloadedResult = page.locator("tbody tr").first();
    await reloadedResult.getByRole("button", { name: "Saved" }).click();
    await expect(
      reloadedResult.getByRole("button", { name: "+ Save" }),
    ).toBeVisible();
    await withConfirmation(page, () =>
      page.getByRole("button", { name: "Delete" }).click(),
    );
    await expect(page.getByText("Saved List deleted.")).toBeVisible();
    await expect
      .poll(async () =>
        (await readSavedLists(page)).some((list) => list.id === listId),
      )
      .toBe(false);
    listId = undefined;
  } finally {
    if (!page.isClosed()) {
      const runOwnedLists = (await readSavedLists(page)).filter(
        ({ id, name }) =>
          id === listId || name === listName || name === renamedListName,
      );
      for (const list of runOwnedLists) await deleteSavedList(page, list.id);
    }
  }
};

const assertWorkspaceProjection = async (
  page: Page,
  identity: WorkspaceIdentity,
) => {
  const outcome = await page.evaluate(async (expected) => {
    try {
      const response = await fetch("/api/workspace", { method: "POST" });
      const body = (await response.json()) as unknown;
      if (
        response.status !== 200 ||
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body)
      ) {
        return "invalid";
      }
      return "memberId" in body &&
        body.memberId === expected.memberId &&
        "organizationId" in body &&
        body.organizationId === expected.organizationId &&
        "organizationName" in body &&
        body.organizationName === "My Organization" &&
        "role" in body &&
        body.role === "org:admin"
        ? "exact"
        : "mismatch";
    } catch {
      return "invalid";
    }
  }, identity);
  if (outcome !== "exact") {
    throw new Error(
      "The workspace personal Organization projection is invalid",
    );
  }
};

const assertUniqueExpectedSearchResult = async (
  response: import("@playwright/test").Response,
  expectedProfileId: string,
) => {
  let exact = false;
  try {
    const body = (await response.json()) as unknown;
    exact =
      response.status() === 200 &&
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      "results" in body &&
      Array.isArray(body.results) &&
      body.results.length === 1 &&
      typeof body.results[0] === "object" &&
      body.results[0] !== null &&
      !Array.isArray(body.results[0]) &&
      "profileId" in body.results[0] &&
      body.results[0].profileId === expectedProfileId;
  } catch {
    exact = false;
  }
  if (!exact) {
    throw new Error("Search did not return only the expected Profile");
  }
};

const readCredits = async (billing: ReturnType<Page["getByRole"]>) => {
  const text = await billing
    .locator("strong")
    .filter({ hasText: /^[\d,]+ Credits$/ })
    .innerText();
  const credits = Number(text.replace(/[^\d]/g, ""));
  if (!Number.isSafeInteger(credits)) {
    throw new Error("Organization Credit balance is invalid");
  }
  return credits;
};

const readSavedLists = async (page: Page) => {
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/saved-lists", { cache: "no-store" });
    return {
      body: (await response.json()) as unknown,
      status: response.status,
    };
  });
  if (
    result.status !== 200 ||
    !isRecord(result.body) ||
    !Array.isArray(result.body.lists) ||
    result.body.lists.some(
      (list) =>
        !isRecord(list) ||
        typeof list.id !== "string" ||
        typeof list.name !== "string",
    )
  ) {
    throw new Error("Saved Lists could not be read");
  }
  return result.body.lists as Array<{ id: string; name: string }>;
};

const parseCreatedListId = (value: unknown) => {
  if (
    !isRecord(value) ||
    !isRecord(value.list) ||
    typeof value.list.id !== "string" ||
    !value.list.id
  ) {
    throw new Error("Created Saved List identity is invalid");
  }
  return value.list.id;
};

const deleteSavedList = async (page: Page, listId: string) => {
  const status = await page.evaluate(async (id) => {
    const response = await fetch(`/api/saved-lists/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    return response.status;
  }, listId);
  if (status !== 200 && status !== 204 && status !== 404) {
    throw new Error("Run-owned Saved List cleanup failed");
  }
  await expect
    .poll(async () =>
      (await readSavedLists(page)).some((list) => list.id === listId),
    )
    .toBe(false);
};

const withPrompt = async (
  page: Page,
  action: () => Promise<void>,
  answer: string,
) => {
  const dialogPromise = page.waitForEvent("dialog");
  const actionPromise = action();
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("prompt");
  await dialog.accept(answer);
  await actionPromise;
};

const withConfirmation = async (page: Page, action: () => Promise<void>) => {
  const dialogPromise = page.waitForEvent("dialog");
  const actionPromise = action();
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("confirm");
  await dialog.accept();
  await actionPromise;
};

const assertDeploymentHeaders = (
  headers: Record<string, string> | undefined,
  environment: ReleaseEnvironment,
) => {
  expect(headers?.["x-robots-tag"]).toBe("noindex, nofollow");
  expect(headers?.["x-humans-release"]).toBe(
    requiredEnvironment("E2E_RELEASE_SHA"),
  );
  expect(headers?.["x-humans-environment"]).toBe(environment);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
