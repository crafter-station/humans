import { auth } from "@clerk/nextjs/server";

import { env } from "@/env";
import {
  protectedLocalResponseHeaders,
  protectedProxyHeaders,
  protectedResponseHeaders,
} from "../proxy-security";

export async function POST(request: Request) {
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

  const response = await fetch(`${env.HUMANS_API_URL}/v1/workspace`, {
    method: "POST",
    headers: protectedProxyHeaders(request, token),
  });
  return new Response(response.body, {
    status: response.status,
    headers: protectedResponseHeaders(response),
  });
}
