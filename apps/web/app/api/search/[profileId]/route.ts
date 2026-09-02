import { auth } from "@clerk/nextjs/server";

import { env } from "@/env";
import {
  protectedProxyHeaders,
  protectedResponseHeaders,
} from "../../proxy-security";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ profileId: string }> },
) {
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
  const { profileId } = await params;
  const response = await fetch(
    `${env.HUMANS_API_URL}/v1/profiles/${encodeURIComponent(profileId)}`,
    { headers: protectedProxyHeaders(request, token), cache: "no-store" },
  );
  return new Response(response.body, {
    status: response.status,
    headers: protectedResponseHeaders(response),
  });
}
