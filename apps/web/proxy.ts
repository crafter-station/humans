import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { env } from "@/env";

const API_HOST = "api.humans.crafter.run";

export default clerkMiddleware((_auth, request) => {
  if (request.headers.get("host")?.split(":", 1)[0] !== API_HOST) return;

  const headers = apiProxyHeaders(request);

  const destination = new URL(
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
    env.HUMANS_API_URL,
  );
  return NextResponse.rewrite(destination, { request: { headers } });
});

export const apiProxyHeaders = (request: Request) => {
  const headers = new Headers(request.headers);
  headers.delete("X-Humans-Internal-MCP");
  headers.delete("X-Humans-Public-Profile-Request");
  headers.set("X-Correlation-ID", crypto.randomUUID());
  headers.set(
    "X-Humans-Client-IP",
    request.headers.get("X-Vercel-Forwarded-For")?.split(",")[0]?.trim() ??
      "unknown",
  );
  headers.set("X-Humans-Web-Proxy", env.HUMANS_PROXY_SECRET);
  return headers;
};

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico)).*)",
    "/(api|trpc)(.*)",
  ],
};
