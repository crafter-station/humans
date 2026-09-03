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
  const response = await fetch(
    `${env.HUMANS_API_URL}/v1/saved-lists/${path.map(encodeURIComponent).join("/")}`.replace(
      /\/$/,
      "",
    ),
    {
      method: request.method,
      headers: protectedProxyHeaders(request, token, {
        "content-type": "application/json",
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
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;

const allowedPath = (method: string, path: string[]) => {
  if (path.length === 0) return method === "GET" || method === "POST";
  if (path.length === 1 && path[0]?.length) {
    return method === "PATCH" || method === "DELETE";
  }
  if (
    path.length === 3 &&
    path[0]?.length &&
    path[1] === "entries" &&
    path[2]?.length
  ) {
    return method === "PUT" || method === "PATCH" || method === "DELETE";
  }
  return false;
};
