import { expect, type Page, test } from "@playwright/test";

import {
  authenticateImpersonatedMember,
  authenticateMemberWithSignInTicket,
  signOutAndVerify,
} from "./browser-auth";
import {
  prepareDeploymentContext,
  requiredEnvironment,
  requiredHttpsUrl,
} from "./deployment";
import {
  beginOperatorControl,
  markOperatorControlApplied,
  type OperatorControlContract,
  type OperatorControlState,
  operatorControlContractFromEnvironment,
  readOperatorControlState,
  removeOperatorControlState,
} from "./operator-control-state";
import { readOrganizationCredits } from "./profile-control-helpers";
import {
  readReleaseUser,
  releaseUserCredentialsFromEnvironment,
} from "./release-user";

test("an Operator inspects the control room and compensates a Credit adjustment", async ({
  browser,
  page,
}) => {
  const credentials = releaseUserCredentialsFromEnvironment();
  const releaseMember = readReleaseUser(credentials);
  if (!releaseMember?.organizationId || !releaseMember.userId) {
    throw new Error("The disposable acceptance Organization is unavailable");
  }
  const contract = operatorControlContractFromEnvironment(
    releaseMember.organizationId,
  );
  if (contract.operatorId === releaseMember.userId) {
    throw new Error("The Operator and disposable Member must be distinct");
  }

  const { url } = await prepareDeploymentContext(page.context(), "preview");
  const root = await page.goto(url.href);
  expect(root?.headers()["x-humans-release"]).toBe(
    requiredEnvironment("E2E_RELEASE_SHA"),
  );
  expect(root?.headers()["x-humans-environment"]).toBe("preview");
  await authenticateImpersonatedMember(
    page,
    url.href,
    requiredHttpsUrl("E2E_OPERATOR_IMPERSONATION_URL"),
    contract.operatorId,
  );

  const balanceContext = await browser.newContext();
  const balancePage = await balanceContext.newPage();
  let balanceReaderAuthenticated = false;
  try {
    await prepareDeploymentContext(balanceContext, "preview");
    await authenticateMemberWithSignInTicket(
      balancePage,
      url.href,
      releaseMember.userId,
      releaseMember.organizationId,
      credentials.secretKey,
    );
    balanceReaderAuthenticated = true;

    await page.goto(new URL("/operations", url).href);
    await expect(
      page.getByRole("heading", { name: "Directory control room" }),
    ).toBeVisible();
    await restoreOperatorCredits(page, balancePage, contract);

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

    // Claim, suppression, suspension, and revocation are not reversible. The
    // Credit transition below is persisted before mutation and compensated.
    const originalBalance = await waitForReadableBalance(balancePage);
    const pending = beginOperatorControl(contract, originalBalance);
    let compensation:
      | {
          adjustedBalance: number;
          restoredBalance: number;
          state: OperatorControlState;
        }
      | undefined;
    try {
      await submitAdjustment(
        page,
        contract.organizationId,
        pending.adjustment,
        pending.forwardReason,
        pending.forwardIdempotencyKey,
      );
      const adjustedBalance = await waitForBalance(
        balancePage,
        originalBalance + pending.adjustment,
      );
      const applied = markOperatorControlApplied(contract, adjustedBalance);
      if (adjustedBalance - originalBalance !== applied.adjustment) {
        throw new Error("The Operator Credit increase was not exact");
      }
      await page.reload();
      await assertExactAuditEvent(page, applied.forwardReason, contract);
    } finally {
      compensation = await restoreOperatorCredits(page, balancePage, contract);
    }
    if (
      compensation === undefined ||
      compensation.adjustedBalance - compensation.restoredBalance !== 1 ||
      compensation.restoredBalance !== originalBalance
    ) {
      throw new Error("The Operator Credit compensation was not exact");
    }
    await page.reload();
    await assertExactAuditEvent(
      page,
      compensation.state.rollbackReason,
      contract,
    );
  } finally {
    if (balanceReaderAuthenticated && !balancePage.isClosed()) {
      await signOutAndVerify(balancePage, url);
    }
    await balanceContext.close();
    if (!page.isClosed()) await signOutAndVerify(page, url);
  }
});

const restoreOperatorCredits = async (
  operatorPage: Page,
  balancePage: Page,
  contract: OperatorControlContract,
) => {
  let state = readOperatorControlState(contract);
  if (state === null) return undefined;

  if (state.phase === "pending") {
    await submitAdjustment(
      operatorPage,
      state.organizationId,
      state.adjustment,
      state.forwardReason,
      state.forwardIdempotencyKey,
    );
    const adjustedBalance = await waitForBalance(
      balancePage,
      state.originalBalance + state.adjustment,
    );
    state = markOperatorControlApplied(contract, adjustedBalance);
  }
  if (state.phase !== "applied") {
    throw new Error("Operator Credit rollback phase is invalid");
  }

  await submitAdjustment(
    operatorPage,
    state.organizationId,
    -state.adjustment,
    state.rollbackReason,
    state.rollbackIdempotencyKey,
  );
  const restoredBalance = await waitForBalance(
    balancePage,
    state.originalBalance,
  );
  if (
    state.adjustedBalance !== state.originalBalance + state.adjustment ||
    state.adjustedBalance - restoredBalance !== state.adjustment
  ) {
    throw new Error("Operator Credit rollback balance is invalid");
  }
  removeOperatorControlState(contract);
  return { adjustedBalance: state.adjustedBalance, restoredBalance, state };
};

const submitAdjustment = async (
  page: Page,
  organizationId: string,
  amount: number,
  reason: string,
  idempotencyKey: string,
) => {
  const form = section(page, "Credit reconciliation").locator("form").first();
  const idempotencySet = await form
    .locator('input[name="idempotencyKey"]')
    .evaluate((element, value) => {
      if (!(element instanceof HTMLInputElement)) return false;
      element.value = value;
      return true;
    }, idempotencyKey);
  if (!idempotencySet) {
    throw new Error("Credit adjustment idempotency could not be set");
  }
  await form.getByPlaceholder("Organization ID").fill(organizationId);
  await form.getByPlaceholder("Credit adjustment").fill(String(amount));
  await form.getByPlaceholder("Adjustment reason").fill(reason);
  const actionResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/operations",
  );
  await form.getByRole("button", { name: "Adjust Credits" }).click();
  if (!(await actionResponse).ok()) {
    throw new Error("Operator Credit adjustment request failed");
  }
};

const waitForReadableBalance = async (page: Page) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const balance = await readOrganizationCredits(page);
    if (balance !== null) return balance;
    await page.waitForTimeout(250);
  }
  throw new Error("Organization Credit balance could not be read");
};

const waitForBalance = async (page: Page, expectedBalance: number) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const balance = await readOrganizationCredits(page);
    if (balance === expectedBalance) return balance;
    await page.waitForTimeout(250);
  }
  throw new Error(
    "Organization Credit balance did not reach the expected value",
  );
};

const assertExactAuditEvent = async (
  page: Page,
  reason: string,
  contract: OperatorControlContract,
) => {
  const exact = await operatorAudit(page)
    .locator("tbody tr")
    .evaluateAll(
      (rows, expected) =>
        rows.some((row) => {
          const cells = [...row.querySelectorAll("td")].map(
            (cell) => cell.textContent?.trim() ?? "",
          );
          return (
            cells[1] === expected.operatorId &&
            cells[2] === "credits.adjust" &&
            cells[3] === "organization" &&
            cells[4] === expected.organizationId &&
            cells[5] === expected.reason
          );
        }),
      {
        operatorId: contract.operatorId,
        organizationId: contract.organizationId,
        reason,
      },
    );
  if (!exact) {
    throw new Error("The exact Operator Credit audit event was not recorded");
  }
};

const operatorAudit = (page: Page) => section(page, "Operator audit trail");

const section = (page: Page, name: string) =>
  page
    .getByRole("heading", { name, exact: true })
    .locator("xpath=ancestor::section[1]");
