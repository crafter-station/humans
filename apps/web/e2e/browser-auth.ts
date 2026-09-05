import { setTimeout as delay } from "node:timers/promises";

import type { APIResponse, Page, Route } from "@playwright/test";

const clerkApiOrigin = "https://api.clerk.com";
const retryableClerkStatuses = new Set([429, 502, 503, 504]);

type Fetcher = typeof fetch;

export const setupClerkTestingTokenSafely = async (page: Page) => {
  const frontendApiHost = process.env.CLERK_FAPI?.trim();
  const testingToken = process.env.CLERK_TESTING_TOKEN?.trim();
  if (!frontendApiHost || !testingToken) {
    throw new Error("Clerk testing credentials are unavailable");
  }
  if (!isBareHttpsHost(frontendApiHost)) {
    throw new Error("The Clerk Frontend API host is invalid");
  }

  const context = page.context();
  await context.route(
    (url) =>
      url.protocol === "https:" &&
      url.host === frontendApiHost &&
      url.pathname.startsWith("/v1/"),
    (route) => proxyClerkRequest(route, testingToken),
  );
};

export const authenticateImpersonatedMember = async (
  page: Page,
  deploymentUrl: string,
  impersonationUrl: string,
  expectedMemberId: string,
  expectedOrganizationId?: string,
) => {
  try {
    await page.goto(deploymentUrl);
    await page.evaluate((url) => window.location.assign(url), impersonationUrl);
    await page.waitForFunction(() => Boolean(window.Clerk?.user?.id));
    await page.goto(deploymentUrl);
    await page.waitForFunction(() => Boolean(window.Clerk?.user?.id));
    const matches = await page.evaluate(
      ({ memberId, organizationId }) =>
        window.Clerk?.user?.id === memberId &&
        (organizationId === undefined ||
          window.Clerk?.organization?.id === organizationId),
      {
        memberId: expectedMemberId,
        organizationId: expectedOrganizationId,
      },
    );
    if (!matches) throw new Error("identity mismatch");
  } catch {
    throw new Error("The impersonation did not authenticate the expected Member");
  }
};

export const authenticateMemberWithSignInTicket = async (
  page: Page,
  deploymentUrl: string,
  expectedMemberId: string,
  expectedOrganizationId: string,
  secretKey: string,
  fetcher: Fetcher = fetch,
) => {
  const ticket = await createSignInTicket(
    expectedMemberId,
    secretKey,
    fetcher,
  );
  await setupClerkTestingTokenSafely(page);
  try {
    await page.goto(deploymentUrl);
    await page.waitForFunction(() => Boolean(window.Clerk?.loaded));
    const signedIn = await page.evaluate(async (signInTicket) => {
      try {
        const client = window.Clerk.client;
        if (!client) return false;
        const signIn = await client.signIn.create({
          strategy: "ticket",
          ticket: signInTicket,
        });
        if (signIn.status !== "complete" || !signIn.createdSessionId) {
          return false;
        }
        await window.Clerk.setActive({ session: signIn.createdSessionId });
        return Boolean(window.Clerk.user?.id);
      } catch {
        return false;
      }
    }, ticket);
    if (!signedIn) throw new Error("ticket rejected");
    await page.goto(new URL("/workspace", deploymentUrl).href);
    await page.waitForFunction(() => Boolean(window.Clerk?.organization?.id));
    const matches = await page.evaluate(
      ({ memberId, organizationId }) =>
        window.Clerk?.user?.id === memberId &&
        window.Clerk?.organization?.id === organizationId,
      { memberId: expectedMemberId, organizationId: expectedOrganizationId },
    );
    if (!matches) throw new Error("identity mismatch");
  } catch {
    throw new Error("The balance reader could not authenticate its Member");
  }
};

export const verifyPersonalOrganization = async (
  input: {
    memberId: string;
    organizationId: string;
    secretKey: string;
  },
  fetcher: Fetcher = fetch,
) => {
  const organization = await clerkJson(
    `/v1/organizations/${encodeURIComponent(input.organizationId)}`,
    { headers: clerkHeaders(input.secretKey) },
    fetcher,
  );
  if (
    !isRecord(organization) ||
    organization.id !== input.organizationId ||
    organization.name !== "My Organization" ||
    organization.created_by !== input.memberId ||
    organization.members_count !== 1
  ) {
    throw new Error("The personal Organization identity is invalid");
  }

  const memberIds: string[] = [];
  for (let offset = 0; ; ) {
    const memberships = await clerkJson(
      `/v1/organizations/${encodeURIComponent(input.organizationId)}/memberships?limit=100&offset=${offset}`,
      { headers: clerkHeaders(input.secretKey) },
      fetcher,
    );
    if (!isMembershipPage(memberships, input.organizationId)) {
      throw new Error("The personal Organization membership is invalid");
    }
    memberIds.push(
      ...memberships.data.map(
        (membership) => membership.public_user_data.user_id,
      ),
    );
    offset += memberships.data.length;
    if (offset >= memberships.total_count) break;
    if (memberships.data.length === 0) {
      throw new Error("The personal Organization membership is incomplete");
    }
  }
  if (memberIds.length !== 1 || memberIds[0] !== input.memberId) {
    throw new Error("The personal Organization must have only its creator");
  }
};

export const assertWorkspaceRequiresAuthentication = async (
  page: Page,
  deploymentUrl: URL,
) => {
  let response: APIResponse;
  try {
    response = await page.request.get(
      new URL("/workspace", deploymentUrl).href,
      { maxRedirects: 0 },
    );
  } catch {
    throw new Error("Signed-out workspace protection could not be checked");
  }
  const status = response.status();
  const location = response.headers().location;
  await response.dispose();
  if (status < 300 || status >= 400 || !location) {
    throw new Error("Signed-out access did not redirect away from the workspace");
  }
};

export const signOutAndVerify = async (page: Page, deploymentUrl: URL) => {
  if (page.isClosed()) {
    throw new Error("Member sign-out could not be verified");
  }
  try {
    await page.goto(deploymentUrl.href);
    await page.waitForFunction(() => Boolean(window.Clerk?.loaded));
    const signedOut = await page.evaluate(async () => {
      try {
        await window.Clerk.signOut();
        return window.Clerk.user === null && window.Clerk.session === null;
      } catch {
        return false;
      }
    });
    if (!signedOut) throw new Error("session remained active");
    const profileStatus = await page.evaluate(async () => {
      try {
        return (await fetch("/api/profile", { cache: "no-store" })).status;
      } catch {
        return 0;
      }
    });
    if (profileStatus !== 401) throw new Error("profile remained available");
    await assertWorkspaceRequiresAuthentication(page, deploymentUrl);
  } catch {
    throw new Error("Member sign-out could not be verified");
  }
};

const proxyClerkRequest = async (route: Route, testingToken: string) => {
  const tokenizedUrl = new URL(route.request().url());
  tokenizedUrl.searchParams.set("__clerk_testing_token", testingToken);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await route.fetch({
        maxRedirects: 0,
        url: tokenizedUrl.href,
      });
      if (retryableClerkStatuses.has(response.status()) && attempt < 3) {
        await response.dispose();
        await delay(500 * 2 ** attempt);
        continue;
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        await route.fulfill({ response });
        return;
      }
      allowCaptchaBypass(body);
      await route.fulfill({ response, json: body });
      return;
    } catch {
      if (attempt < 3) {
        await delay(500 * 2 ** attempt);
        continue;
      }
      // The browser sees only its original token-free FAPI request failure.
      await route.abort("failed").catch(() => undefined);
      return;
    }
  }
};

const createSignInTicket = async (
  memberId: string,
  secretKey: string,
  fetcher: Fetcher,
) => {
  const result = await clerkJson(
    "/v1/sign_in_tokens",
    {
      method: "POST",
      headers: {
        ...clerkHeaders(secretKey),
        "content-type": "application/json",
      },
      body: JSON.stringify({ expires_in_seconds: 60, user_id: memberId }),
    },
    fetcher,
  );
  if (!isRecord(result) || typeof result.token !== "string" || !result.token) {
    throw new Error("Clerk did not create a valid sign-in ticket");
  }
  return result.token;
};

const clerkJson = async (
  path: string,
  init: RequestInit,
  fetcher: Fetcher,
): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetcher(`${clerkApiOrigin}${path}`, {
      ...init,
      redirect: "error",
    });
  } catch {
    throw new Error("Clerk identity verification failed");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Clerk identity verification failed");
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error("Clerk identity verification returned an invalid response");
  }
};

const clerkHeaders = (secretKey: string) => ({
  accept: "application/json",
  authorization: `Bearer ${secretKey}`,
});

const allowCaptchaBypass = (body: unknown) => {
  if (!isRecord(body)) return;
  if (isRecord(body.response) && body.response.captcha_bypass === false) {
    body.response.captcha_bypass = true;
  }
  if (isRecord(body.client) && body.client.captcha_bypass === false) {
    body.client.captcha_bypass = true;
  }
};

const isBareHttpsHost = (value: string) => {
  try {
    const url = new URL(`https://${value}`);
    return (
      url.host === value &&
      url.hostname === value &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
};

const isMembershipPage = (
  value: unknown,
  organizationId: string,
): value is {
  data: Array<{
    organization: { id: string };
    public_user_data: { user_id: string };
  }>;
  total_count: number;
} =>
  isRecord(value) &&
  Number.isSafeInteger(value.total_count) &&
  (value.total_count as number) >= 0 &&
  Array.isArray(value.data) &&
  value.data.every(
    (membership) =>
      isRecord(membership) &&
      isRecord(membership.organization) &&
      membership.organization.id === organizationId &&
      isRecord(membership.public_user_data) &&
      typeof membership.public_user_data.user_id === "string",
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
