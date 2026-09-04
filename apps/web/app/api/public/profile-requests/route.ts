import { env } from "@/env";
import { profileRequestTurnstileAction } from "../../../profile-request/turnstile";
import {
  protectedLocalResponseHeaders,
  protectedResponseHeaders,
  publicProxyHeaders,
  trustedClientIp,
} from "../../proxy-security";

const maximumBodyBytes = 8_192;
const maximumProxiedBodyBytes = 4_096;
const maximumTurnstileTokenLength = 2_048;
const turnstileTimeoutMilliseconds = 3_000;
const turnstileSiteverifyUrl =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const publicProfileRequestStageHeader = "X-Humans-Public-Profile-Request";
const userTurnstileErrors = new Set([
  "invalid-input-response",
  "missing-input-response",
  "timeout-or-duplicate",
]);

type TurnstileVerification = "failed" | "unavailable" | "verified";

export const POST = async (request: Request) => {
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBodyBytes)
    return tooLarge();

  const body = await request.text().catch(() => null);
  if (body === null) return verificationFailed();
  if (new TextEncoder().encode(body).byteLength > maximumBodyBytes)
    return tooLarge();

  const parsed = parseObject(body);
  if (parsed === null) return verificationFailed();
  const token = parsed.turnstileToken;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > maximumTurnstileTokenLength ||
    token.trim() !== token
  ) {
    return verificationFailed();
  }

  const proxyHeaders = publicProxyHeaders(request);
  const preflight = await fetch(
    `${env.HUMANS_API_URL}/v1/internal/public-profile-request-verifications`,
    {
      method: "POST",
      headers: {
        ...proxyHeaders,
        [publicProfileRequestStageHeader]: "verification",
      },
      cache: "no-store",
      redirect: "error",
    },
  ).catch(() => null);
  if (preflight === null) return proxyUnavailable();
  if (preflight.status === 429) return proxiedResponse(preflight);
  if (preflight.status !== 204) return proxyUnavailable();

  const verification = await verifyTurnstile(
    token,
    new URL(request.url).hostname,
    trustedClientIp(request),
  );
  if (verification === "failed") return verificationFailed();
  if (verification === "unavailable") return verificationUnavailable();

  const { turnstileToken: _turnstileToken, ...profileRequest } = parsed;
  const proxiedBody = JSON.stringify(profileRequest);
  if (
    new TextEncoder().encode(proxiedBody).byteLength > maximumProxiedBodyBytes
  ) {
    return tooLarge();
  }

  const response = await fetch(
    `${env.HUMANS_API_URL}/v1/public/profile-requests`,
    {
      method: "POST",
      headers: {
        ...proxyHeaders,
        "content-type": "application/json",
        [publicProfileRequestStageHeader]: "verified",
      },
      body: proxiedBody,
      cache: "no-store",
      redirect: "error",
    },
  ).catch(() => null);
  if (response === null) return proxyUnavailable();
  return proxiedResponse(response);
};

const parseObject = (body: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(body) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const verifyTurnstile = async (
  token: string,
  expectedHostname: string,
  remoteIp: string | undefined,
): Promise<TurnstileVerification> => {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    turnstileTimeoutMilliseconds,
  );
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token,
  });
  if (remoteIp) body.set("remoteip", remoteIp);

  try {
    const response = await fetch(turnstileSiteverifyUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return "unavailable";
    const result = (await response.json().catch(() => null)) as unknown;
    if (typeof result !== "object" || result === null) return "unavailable";
    const verification = result as Record<string, unknown>;
    if (verification.success === true) {
      return verification.hostname === expectedHostname &&
        verification.action === profileRequestTurnstileAction
        ? "verified"
        : "failed";
    }
    const errorCodes = verification["error-codes"];
    return Array.isArray(errorCodes) &&
      errorCodes.length > 0 &&
      errorCodes.every(
        (error) => typeof error === "string" && userTurnstileErrors.has(error),
      )
      ? "failed"
      : "unavailable";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timeout);
  }
};

const tooLarge = () =>
  Response.json(
    {
      error: {
        code: "request_too_large",
        message: "Request body is too large",
      },
    },
    { status: 413, headers: protectedLocalResponseHeaders() },
  );

const verificationFailed = () =>
  Response.json(
    {
      error: {
        code: "verification_failed",
        message: "Complete the security check and try again",
      },
    },
    { status: 400, headers: protectedLocalResponseHeaders() },
  );

const verificationUnavailable = () =>
  Response.json(
    {
      error: {
        code: "verification_unavailable",
        message: "The security check is temporarily unavailable",
      },
    },
    { status: 503, headers: protectedLocalResponseHeaders() },
  );

const proxyUnavailable = () =>
  Response.json(
    {
      error: {
        code: "service_unavailable",
        message: "Service unavailable",
      },
    },
    { status: 503, headers: protectedLocalResponseHeaders() },
  );

const proxiedResponse = (response: Response) =>
  new Response(response.body, {
    status: response.status,
    headers: protectedResponseHeaders(response),
  });
