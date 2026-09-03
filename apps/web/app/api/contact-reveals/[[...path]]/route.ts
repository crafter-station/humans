import { auth } from "@clerk/nextjs/server";

import { env } from "@/env";
import {
  protectedLocalResponseHeaders,
  protectedProxyHeaders,
  protectedResponseHeaders,
} from "../../proxy-security";

const proxy = async (
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) => {
  const session = await auth();
  const token = await session.getToken();
  if (token === null)
    return Response.json(
      {
        error: { code: "unauthorized", message: "Authentication is required" },
      },
      { status: 401, headers: protectedLocalResponseHeaders() },
    );
  const { path = [] } = await context.params;
  if (!allowedPath(request.method, path)) {
    return Response.json(
      { error: { code: "not_found", message: "Route was not found" } },
      { status: 404, headers: protectedLocalResponseHeaders() },
    );
  }
  const idempotencyKey = request.headers.get("Idempotency-Key");
  const response = await fetch(
    `${env.HUMANS_API_URL}/v1/${path.map(encodeURIComponent).join("/")}`,
    {
      method: request.method,
      headers: protectedProxyHeaders(request, token, {
        "content-type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      }),
      body: request.method === "GET" ? undefined : await request.text(),
      cache: "no-store",
    },
  );
  return new Response(response.body, {
    status: response.status,
    headers: protectedResponseHeaders(response),
  });
};

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;

const allowedPath = (method: string, path: string[]) => {
  const identifier = path[1] ?? "";
  if (
    (method === "GET" || method === "PATCH") &&
    path.length === 2 &&
    path[0] === "organization" &&
    path[1] === "contact-reveal-policy"
  ) {
    return true;
  }
  if (
    method === "PATCH" &&
    path.length === 3 &&
    path[0] === "profile" &&
    path[1] === "contact-suppressions" &&
    (path[2] === "email" || path[2] === "phone")
  ) {
    return true;
  }
  if (method !== "POST") return false;
  return (
    (path.length === 4 &&
      path[0] === "profiles" &&
      identifier.length > 0 &&
      path[2] === "contact-reveals" &&
      (path[3] === "email" || path[3] === "phone")) ||
    (path.length === 3 &&
      path[0] === "contact-details" &&
      identifier.length > 0 &&
      path[2] === "report")
  );
};
