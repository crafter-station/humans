import { auth } from "@clerk/nextjs/server";

import { env } from "@/env";
import {
  protectedProxyHeaders,
  protectedResponseHeaders,
} from "../proxy-security";

const forward = async (request: Request, path: string) => {
  const session = await auth();
  const token = await session.getToken();
  if (token === null) {
    return Response.json(
      {
        error: { code: "unauthorized", message: "Authentication is required" },
      },
      { status: 401 },
    );
  }

  const response = await fetch(`${env.HUMANS_API_URL}${path}`, {
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
  });
  return new Response(response.body, {
    status: response.status,
    headers: protectedResponseHeaders(response),
  });
};

export const GET = (request: Request) => forward(request, "/v1/profile");
export const PUT = (request: Request) => forward(request, "/v1/profile");
export const PATCH = (request: Request) =>
  forward(request, "/v1/profile/searchability");
