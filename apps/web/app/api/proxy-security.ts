import { env } from "@/env";

export const protectedProxyHeaders = (
  request: Request,
  token: string,
  extra?: Record<string, string>,
) => ({
  authorization: `Bearer ${token}`,
  ...proxyMetadataHeaders(request),
  ...extra,
});

export const publicProxyHeaders = (
  request: Request,
  extra?: Record<string, string>,
) => ({
  ...proxyMetadataHeaders(request),
  ...extra,
});

export const protectedLocalResponseHeaders = () => ({
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow",
});

export const trustedClientIp = (request: Request) =>
  request.headers.get("X-Vercel-Forwarded-For")?.split(",")[0]?.trim() ||
  undefined;

const proxyMetadataHeaders = (request: Request) => {
  return {
    "X-Correlation-ID": crypto.randomUUID(),
    "X-Humans-Web-Proxy": env.HUMANS_PROXY_SECRET,
    "X-Humans-Client-IP": trustedClientIp(request) ?? "unknown",
  };
};

export const protectedResponseHeaders = (response: Response) => {
  const headers: Record<string, string> = {
    "content-type": response.headers.get("content-type") ?? "application/json",
    ...protectedLocalResponseHeaders(),
  };
  for (const name of [
    "X-Correlation-ID",
    "RateLimit-Limit",
    "RateLimit-Remaining",
    "RateLimit-Reset",
    "Retry-After",
  ]) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
};
