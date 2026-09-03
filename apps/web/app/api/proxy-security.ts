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

const proxyMetadataHeaders = (request: Request) => {
  const correlationId =
    request.headers.get("X-Correlation-ID")?.slice(0, 200) ??
    crypto.randomUUID();
  const clientIp =
    request.headers.get("X-Vercel-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown";
  return {
    "X-Correlation-ID": correlationId,
    "X-Humans-Web-Proxy": env.HUMANS_PROXY_SECRET,
    "X-Humans-Client-IP": clientIp,
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
