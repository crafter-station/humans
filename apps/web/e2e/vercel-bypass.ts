import type { BrowserContext } from "@playwright/test";

class BypassValidationError extends Error {}

export const establishVercelBypass = async (
  context: BrowserContext,
  deploymentUrl: URL,
  secret: string,
) => {
  try {
    if (
      deploymentUrl.protocol !== "https:" ||
      deploymentUrl.username ||
      deploymentUrl.password ||
      deploymentUrl.port ||
      deploymentUrl.pathname !== "/" ||
      deploymentUrl.search ||
      deploymentUrl.hash ||
      secret.length < 16 ||
      secret.trim() !== secret
    ) {
      throw new BypassValidationError(
        "Vercel deployment bypass input is invalid",
      );
    }

    const priorValues = new Set(
      (await context.cookies(deploymentUrl.href))
        .filter(({ name }) => name === "_vercel_jwt")
        .map(({ value }) => value),
    );
    const response = await context.request.get(deploymentUrl.href, {
      maxRedirects: 0,
      headers: {
        "x-vercel-protection-bypass": secret,
        "x-vercel-set-bypass-cookie": "true",
      },
    });
    try {
      if (response.status() !== 200 && response.status() !== 307) {
        throw new BypassValidationError(
          "Vercel deployment bypass could not be established",
        );
      }
      const cookies = (await context.cookies(deploymentUrl.href)).filter(
        ({ name }) => name === "_vercel_jwt",
      );
      if (cookies.length !== 1) {
        throw new BypassValidationError(
          "Vercel deployment bypass cookie was not returned",
        );
      }
      const cookie = cookies[0];
      if (cookie === undefined || priorValues.has(cookie.value)) {
        throw new BypassValidationError(
          "Vercel deployment bypass cookie was not newly established",
        );
      }
      if (!cookie.httpOnly) {
        throw new BypassValidationError(
          "Vercel deployment bypass cookie must be HttpOnly",
        );
      }
      if (!cookie.secure) {
        throw new BypassValidationError(
          "Vercel deployment bypass cookie must be Secure",
        );
      }
      if (cookie.domain !== deploymentUrl.hostname || cookie.path !== "/") {
        throw new BypassValidationError(
          "Vercel deployment bypass cookie scope is invalid",
        );
      }
      if (!validCookieExpiry(cookie.value, cookie.expires)) {
        throw new BypassValidationError(
          "Vercel deployment bypass cookie expiry is invalid",
        );
      }
    } finally {
      await response.dispose();
    }
  } catch (error) {
    if (error instanceof BypassValidationError) {
      throw new Error(error.message);
    }
    throw new Error("Vercel deployment bypass transport failed");
  }
};

const validCookieExpiry = (value: string, expires: number) => {
  if (!Number.isSafeInteger(expires) || expires <= Date.now() / 1000) {
    return false;
  }
  const segments = value.split(".");
  if (segments.length !== 3 || segments[1] === undefined) return false;
  try {
    const payload = JSON.parse(
      Buffer.from(segments[1], "base64url").toString("utf8"),
    ) as unknown;
    return (
      typeof payload === "object" &&
      payload !== null &&
      "exp" in payload &&
      Number.isSafeInteger(payload.exp) &&
      Math.abs((payload.exp as number) - expires) <= 1
    );
  } catch {
    return false;
  }
};
