import { auth } from "@clerk/nextjs/server";

export async function GET(request: Request) {
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

  const url = new URL(request.url);
  const response = await fetch(
    `${process.env.HUMANS_API_URL ?? "http://localhost:8787"}/v1/profiles/search?${url.searchParams}`,
    { headers: { authorization: `Bearer ${token}` }, cache: "no-store" },
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
