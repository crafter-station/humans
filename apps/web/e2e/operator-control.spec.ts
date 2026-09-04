import { expect, test } from "@playwright/test";

import {
  prepareDeploymentContext,
  requiredEnvironment,
  requiredHttpsUrl,
} from "./deployment";
import {
  readReleaseUser,
  releaseUserCredentialsFromEnvironment,
} from "./release-user";

test("an Operator can inspect every control-room section and record a reversible transition", async ({
  page,
}) => {
  const releaseMember = readReleaseUser(
    releaseUserCredentialsFromEnvironment(),
  );
  if (!releaseMember?.organizationId) {
    throw new Error("The disposable acceptance Organization is unavailable");
  }
  const { url } = await prepareDeploymentContext(page.context(), "preview");
  const root = await page.goto(url.href);
  expect(root?.headers()["x-humans-release"]).toBe(
    requiredEnvironment("E2E_RELEASE_SHA"),
  );
  expect(root?.headers()["x-humans-environment"]).toBe("preview");

  try {
    await page.evaluate(
      (url) => window.location.assign(url),
      requiredHttpsUrl("E2E_OPERATOR_IMPERSONATION_URL"),
    );
    await page.waitForFunction(() => Boolean(window.Clerk?.user?.id));
    await page.goto(new URL("/operations", url).href);
    await expect(
      page.getByRole("heading", { name: "Directory control room" }),
    ).toBeVisible();

    for (const title of [
      "Import runs",
      "Enrichment",
      "Reviewed claims",
      "Correction and removal",
      "Suppression Records",
      "Abuse signals",
      "Active suspensions",
      "Credit reconciliation",
      "Operator audit trail",
    ]) {
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
    }
    for (const metric of [
      "Pending claims",
      "Profile requests",
      "Active suspensions",
      "Stale Observations",
    ]) {
      await expect(
        page.locator("article").getByText(metric, { exact: true }),
      ).toBeVisible();
    }

    await expect(section(page, "Import runs")).toContainText(
      "Row failures and resumability are retained by run ID.",
    );
    await expect(section(page, "Enrichment")).toContainText(
      "Provider usage excludes provider payloads.",
    );
    await expect(
      section(page, "Suppression Records").getByPlaceholder(
        "GitHub account ID",
      ),
    ).toBeVisible();
    await expect(
      section(page, "Suppression Records").getByRole("button", {
        name: "Suppress Profile",
      }),
    ).toBeVisible();
    await expect(
      section(page, "Abuse signals").getByRole("button", {
        name: "Revoke access",
      }),
    ).toBeVisible();
    await expect(
      section(page, "Abuse signals").getByRole("option", {
        name: "Organization keys",
      }),
    ).toBeAttached();
    await expect(
      section(page, "Active suspensions").getByRole("button", {
        name: "Suspend",
      }),
    ).toBeVisible();
    await expect(
      section(page, "Active suspensions").getByRole("option", {
        name: "API key",
      }),
    ).toBeAttached();
    await expect(
      section(page, "Credit reconciliation").getByRole("button", {
        name: "Adjust Credits",
      }),
    ).toBeVisible();
    await expect(
      section(page, "Credit reconciliation")
        .getByText(/No reconciliation differences\.|Polar/)
        .first(),
    ).toBeVisible();

    // The other controls are intentionally read-only here: claim decisions,
    // suppression, suspension, and access revocation are not safely reversible.
    const reason = `Preview browser acceptance ${crypto.randomUUID()}`;
    const restorationReason = `${reason} restoration`;
    await submitAdjustment(page, releaseMember.organizationId, "1", reason);
    try {
      await expect(operatorAudit(page)).toContainText(reason);
      await expect(operatorAudit(page)).toContainText("credits.adjust");
      await expect(operatorAudit(page)).toContainText(
        releaseMember.organizationId,
      );
    } finally {
      await submitAdjustment(
        page,
        releaseMember.organizationId,
        "-1",
        restorationReason,
      );
    }
    await expect(operatorAudit(page)).toContainText(restorationReason);
  } finally {
    await page.evaluate(() => window.Clerk?.signOut()).catch(() => undefined);
  }
});

const submitAdjustment = async (
  page: import("@playwright/test").Page,
  organizationId: string,
  amount: string,
  reason: string,
) => {
  const form = section(page, "Credit reconciliation").locator("form").first();
  await form.getByPlaceholder("Organization ID").fill(organizationId);
  await form.getByPlaceholder("Credit adjustment").fill(amount);
  await form.getByPlaceholder("Adjustment reason").fill(reason);
  await form.getByRole("button", { name: "Adjust Credits" }).click();
};

const operatorAudit = (page: import("@playwright/test").Page) =>
  section(page, "Operator audit trail");

const section = (page: import("@playwright/test").Page, name: string) =>
  page
    .getByRole("heading", { name, exact: true })
    .locator("xpath=ancestor::section[1]");
