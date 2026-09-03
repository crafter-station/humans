import { env } from "@/env";
import {
  protectedLocalResponseHeaders,
  protectedResponseHeaders,
  publicProxyHeaders,
} from "../../proxy-security";

const maximumBodyBytes = 4_096;

export const POST = async (request: Request) => {
  const declaredLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBodyBytes)
    return tooLarge();

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maximumBodyBytes)
    return tooLarge();

  const response = await fetch(
    `${env.HUMANS_API_URL}/v1/public/profile-requests`,
    {
      method: "POST",
      headers: publicProxyHeaders(request, {
        "content-type": "application/json",
      }),
      body,
      cache: "no-store",
    },
  );
  return new Response(response.body, {
    status: response.status,
    headers: protectedResponseHeaders(response),
  });
};

const tooLarge = () =>
  Response.json(
    {
      error: {
        code: "request_too_large",
        message: "Request body is too large",
      },
    },
    { status: 413, headers: protectedLocalResponseHeaders() },
  );
