import { auth } from "@clerk/nextjs/server";

import { env } from "@/env";

export async function POST(request: Request) {
  const session = await auth();
  const token = await session.getToken();
  if (token === null)
    return Response.json(
      {
        error: { code: "unauthorized", message: "Authentication is required" },
      },
      { status: 401 },
    );

  const response = await fetch(
    `${env.HUMANS_API_URL}/v1/profiles/search/interpret`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: await request.text(),
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
}
