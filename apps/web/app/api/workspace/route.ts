import { auth } from "@clerk/nextjs/server";

export async function POST() {
  const session = await auth();
  const token = await session.getToken();
  if (token === null) {
    return Response.json(
      { error: { code: "unauthorized", message: "Authentication is required" } },
      { status: 401 },
    );
  }

  return fetch(`${process.env.HUMANS_API_URL ?? "http://localhost:8787"}/v1/workspace`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}
