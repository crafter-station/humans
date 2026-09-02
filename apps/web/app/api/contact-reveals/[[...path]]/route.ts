import { auth } from "@clerk/nextjs/server";

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
      { status: 401 },
    );
  const { path = [] } = await context.params;
  const response = await fetch(
    `${process.env.HUMANS_API_URL ?? "http://localhost:8787"}/v1/${path.map(encodeURIComponent).join("/")}`,
    {
      method: request.method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(request.headers.get("Idempotency-Key")
          ? { "Idempotency-Key": request.headers.get("Idempotency-Key")! }
          : {}),
      },
      body: request.method === "GET" ? undefined : await request.text(),
      cache: "no-store",
    },
  );
  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type":
        response.headers.get("content-type") ?? "application/json",
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
};

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
