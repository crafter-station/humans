import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";

import { writeReleaseUser } from "./release-user";

test.describe.configure({ mode: "serial" });

test("a new Member receives a personal Organization and can search and save", async ({
  page,
}) => {
  await setupClerkTestingToken({ page });
  const email = `humans-release-${Date.now()}+clerk_test@example.com`;
  const password = `Humans-release-${Date.now()}!`;
  writeReleaseUser({ email });

  await page.goto("/workspace");
  await expect(page).toHaveURL(/\/sign-in(?:\?|$)/);
  const root = await page.goto("/");
  expect(root?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  const robots = await page.request.get("/robots.txt");
  await expect(robots).toBeOK();
  expect(await robots.text()).toContain("Disallow: /");
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
  writeReleaseUser({ email, userId });

  const homeHeading = page.getByRole("heading", {
    name: "Find the people behind the code.",
  });
  await expect(homeHeading).toBeVisible();

  await page.goto("/workspace");
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
  writeReleaseUser({ email, organizationId, userId });
  await expect(
    page.getByRole("button", { name: "Open organization switcher" }),
  ).toContainText("My Organization");

  const operations = await page.goto("/operations");
  expect(operations?.status()).toBe(404);
  await expect(
    page.getByRole("heading", { name: "Directory control room" }),
  ).not.toBeVisible();
  await page.goto("/workspace");

  const billing = page.getByRole("region", { name: "Organization billing" });
  await expect(billing).toContainText("Free");
  await expect(billing).toContainText("100 Credits");

  await page.getByRole("button", { name: "Search Humans" }).click();
  await page
    .getByLabel("Search", { exact: true })
    .fill(requiredEnvironment("E2E_PROFILE_QUERY"));
  await page.getByRole("button", { name: "Apply filters" }).click();
  const firstResult = page.locator("tbody tr").first();
  await expect(firstResult).toBeVisible();
  await expect(billing).toContainText("99 Credits");

  page.once("dialog", (dialog) => dialog.accept("Release acceptance"));
  await firstResult.getByRole("button", { name: "+ Save" }).click();
  await expect(
    page.getByText("Saved List created and Profile added."),
  ).toBeVisible();
  await expect(
    firstResult.getByRole("button", { name: "Saved" }),
  ).toBeVisible();

  const profileName = await firstResult.locator("td").first().innerText();
  await firstResult.getByRole("button", { name: profileName }).click();
  await page.getByLabel("Team note").fill("Browser acceptance note");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(page.getByText("Team note saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Team note")).toHaveValue(
    "Browser acceptance note",
  );
  await page.getByRole("button", { name: "Close" }).click();

  page.once("dialog", (dialog) => dialog.accept("Release acceptance renamed"));
  await page.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByText("Saved List renamed.")).toBeVisible();
  const reloadedResult = page.locator("tbody tr").first();
  await reloadedResult.getByRole("button", { name: "Saved" }).click();
  await expect(
    reloadedResult.getByRole("button", { name: "+ Save" }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Saved List deleted.")).toBeVisible();
});

const requiredEnvironment = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for browser acceptance`);
  return value;
};
