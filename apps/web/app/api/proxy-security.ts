import { env } from "@/env";

export const protectedProxyHeaders = (
  request: Request,
  token: string,
  extra?: Record<string, string>,
) => {
  const correlationId =
    request.headers.get("X-Correlation-ID")?.slice(0, 200) ??
    crypto.randomUUID();
  const clientIp =
    request.headers.get("X-Vercel-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown";
  return {
    authorization: `Bearer ${token}`,
    "X-Correlation-ID": correlationId,
    "X-Humans-Web-Proxy": env.HUMANS_PROXY_SECRET,
    "X-Humans-Client-IP": clientIp,
    ...extra,
  };
};

export const protectedResponseHeaders = (response: Response) => {
  const headers: Record<string, string> = {
    "content-type": response.headers.get("content-type") ?? "application/json",
    "cache-control": "private, no-store",
    "x-robots-tag": "noindex, nofollow",
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
