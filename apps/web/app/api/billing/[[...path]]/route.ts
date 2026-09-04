import { auth } from "@clerk/nextjs/server";

import { env } from "@/env";
import {
  protectedLocalResponseHeaders,
  protectedProxyHeaders,
  protectedResponseHeaders,
} from "../../proxy-security";

const proxy = async (request: Request, path: string) => {
  const session = await auth();
  const token = await session.getToken();
  if (token === null) {
    return Response.json(
      {
        error: {
          code: "unauthorized",
          message: "Authentication is required",
        },
      },
      { status: 401, headers: protectedLocalResponseHeaders() },
    );
  }
  const response = await fetch(`${env.HUMANS_API_URL}/v1/billing${path}`, {
    method: request.method,
    headers: protectedProxyHeaders(request, token),
    cache: "no-store",
    redirect: "error",
  });
  return new Response(response.body, {
    status: response.status,
    headers: protectedResponseHeaders(response),
  });
};

export const GET = async (
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) => {
  const { path = [] } = await context.params;
  if (path.length !== 0) {
    return Response.json(
      { error: { code: "not_found", message: "Route was not found" } },
      { status: 404, headers: protectedLocalResponseHeaders() },
    );
  }
  return proxy(request, "");
};

export const POST = async (
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) => {
  const { path = [] } = await context.params;
  if (path.length !== 1 || (path[0] !== "checkout" && path[0] !== "portal")) {
    return Response.json(
      { error: { code: "not_found", message: "Route was not found" } },
      { status: 404, headers: protectedLocalResponseHeaders() },
    );
  }
  return proxy(request, `/${path[0]}`);
};
