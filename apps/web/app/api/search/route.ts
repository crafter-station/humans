import { auth } from "@clerk/nextjs/server";

import { env } from "@/env";
import {
  protectedLocalResponseHeaders,
  protectedProxyHeaders,
  protectedResponseHeaders,
} from "../proxy-security";

export async function GET(request: Request) {
  const session = await auth();
  const token = await session.getToken();
  if (token === null) {
    return Response.json(
      {
        error: { code: "unauthorized", message: "Authentication is required" },
      },
      { status: 401, headers: protectedLocalResponseHeaders() },
    );
  }

  const url = new URL(request.url);
  const response = await fetch(
    `${env.HUMANS_API_URL}/v1/profiles/search?${url.searchParams}`,
    {
      headers: protectedProxyHeaders(request, token, {
        "Idempotency-Key":
          request.headers.get("Idempotency-Key") ?? crypto.randomUUID(),
      }),
      cache: "no-store",
    },
  );
  return new Response(response.body, {
    status: response.status,
    headers: protectedResponseHeaders(response),
  });
}
