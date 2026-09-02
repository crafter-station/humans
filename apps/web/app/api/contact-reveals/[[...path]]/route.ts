import { auth } from "@clerk/nextjs/server";

import { env } from "@/env";
import {
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
      { status: 401 },
    );
  const { path = [] } = await context.params;
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
