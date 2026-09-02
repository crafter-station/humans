import { auth } from "@clerk/nextjs/server";

import { env } from "@/env";

export async function POST() {
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

  return fetch(`${env.HUMANS_API_URL}/v1/workspace`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}
