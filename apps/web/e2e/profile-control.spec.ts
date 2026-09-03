import { expect, test, type Page } from "@playwright/test";

test("a represented Member can claim a Profile and control Searchability", async ({
  page,
}) => {
  let originalSearchability: boolean | undefined;
  const impersonationUrl = requiredEnvironment(
    "E2E_PROFILE_OWNER_IMPERSONATION_URL",
  );
  try {
    await page.goto("/");
    await page.evaluate((url) => window.location.assign(url), impersonationUrl);
    await page.waitForFunction(() => Boolean(window.Clerk?.user?.id));
    await page.goto("/workspace?view=profile");

    const profileHeading = page.getByRole("heading", { name: /^Profile for / });
    const claim = page.getByRole("button", {
      name: "Verify and claim this Profile",
    });
    await expect(profileHeading.or(claim)).toBeVisible();
    if (await claim.isVisible()) {
      await claim.click();
      await expect(
        page.getByText(
          "Your claim is verified. Review the Imported Profile before opting in.",
        ),
      ).toBeVisible();
    }
    await expect(profileHeading).toBeVisible();
    originalSearchability = await readSearchability(page);

    const toggleName = originalSearchability
      ? "Stop appearing in searches"
      : "Appear in searches";
    await page.getByRole("button", { name: toggleName }).click();
    await expect(
      page.getByText(
        originalSearchability
          ? "Your Profile was removed from searches immediately."
          : "Your Profile now appears in authenticated Humans searches.",
      ),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: originalSearchability
          ? "Appear in searches"
          : "Stop appearing in searches",
      })
      .click();
    await expect
      .poll(() => readSearchability(page))
      .toBe(originalSearchability);
  } finally {
    if (originalSearchability !== undefined) {
      await restoreSearchability(page, originalSearchability);
    }
    await page.evaluate(() => window.Clerk?.signOut()).catch(() => undefined);
  }
});

const readSearchability = (page: Page) =>
  page.evaluate(async () => {
    const response = await fetch("/api/profile", { cache: "no-store" });
    const result = (await response.json()) as {
      profile?: { searchable?: boolean };
    };
    if (!response.ok || typeof result.profile?.searchable !== "boolean") {
      throw new Error("The represented Profile could not be read");
    }
    return result.profile.searchable;
  });

const restoreSearchability = async (page: Page, searchable: boolean) => {
  if ((await readSearchability(page)) === searchable) return;
  await page.evaluate(async (nextSearchability) => {
    const response = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ searchable: nextSearchability }),
    });
    if (!response.ok)
      throw new Error("Profile Searchability restoration failed");
  }, searchable);
};

const requiredEnvironment = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for browser acceptance`);
  return value;
};
