import { auth } from "@clerk/nextjs/server";

import { env } from "@/env";
import {
  protectedLocalResponseHeaders,
  protectedProxyHeaders,
  protectedResponseHeaders,
} from "../../proxy-security";

const methods: Record<string, string> = {
  "claim-candidates": "GET",
  claims: "POST",
  details: "PATCH",
};

const proxy = async (
  request: Request,
  context: { params: Promise<{ action: string }> },
) => {
  const { action } = await context.params;
  if (methods[action] !== request.method)
    return Response.json(
      { error: { code: "not_found", message: "Route was not found" } },
      { status: 404, headers: protectedLocalResponseHeaders() },
    );

  const session = await auth();
  const token = await session.getToken();
  if (token === null)
    return Response.json(
      {
        error: { code: "unauthorized", message: "Authentication is required" },
      },
      { status: 401, headers: protectedLocalResponseHeaders() },
    );

  const response = await fetch(
    `${env.HUMANS_API_URL}/v1/profile/${encodeURIComponent(action)}`,
    {
      method: request.method,
      headers: protectedProxyHeaders(
        request,
        token,
        request.method === "GET"
          ? undefined
          : { "content-type": "application/json" },
      ),
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
